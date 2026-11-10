import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../lib/store.mjs';
import { VectorIndex } from '../lib/vector-index.mjs';
import { FakeEmbedder, hashVector } from '../lib/embedding.mjs';
import { hybridSearch } from '../lib/search.mjs';
import { isWorthKeeping, loadIndex } from '../lib/capture.mjs';
import { recallForPrompt } from '../lib/recall.mjs';
import { remember, forget, prunePreview, pruneApply } from '../lib/ops.mjs';
import { localDate } from '../lib/text.mjs';
import { importFromPath, purgeStoreDir } from '../lib/migrate.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'alice-mem-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCfg(dir, dims = 8) {
  return {
    data_dir: dir,
    scope_id: 'default',
    log_level: 'error',
    embedding: {
      url: 'http://127.0.0.1:9/never',
      model: 'fake',
      dimensions: dims,
      batch: 16,
      timeout_ms: 200,
      max_input_chars: 4000,
      docPrefix: '',
      queryPrefix: '',
      apiKey: '',
    },
    search: {
      min_score: 0.5,
      vector_weight: 1,
      lexical_weight: 0.35,
      rrf_k: 60,
      candidate_multiplier: 4,
      cold_scan_budget_ms: 200,
      cold_scan_cap: 10000,
    },
    memory: {
      hot_in: 0.6, hot_out: 0.4, warm_in: 0.3, warm_out: 0.15,
      hot_max: 3000, warm_max: 12000,
      reinforce_gain: 0.35, heat_cap: 3, sweep_interval_hours: 6, archive_after_days: 0,
    },
    recall: { limit: 3, timeout_ms: 3000, max_chars: 400, labels: { user: 'User', assistant: 'Assistant' } },
    capture: {
      enabled: true, min_prose: 25, daily_cap: 150, embed_retry_minutes: 5,
      max_user_chars: 2000, max_assistant_chars: 4000,
    },
    files: {
      db: join(dir, 'memories.sqlite3'),
    },
  };
}

function openStore(dir, cfg) {
  return new Store({ dataDir: dir, dimensions: cfg.embedding.dimensions, model: 'fake', scopeId: 'default' });
}

test('insert dedupes by content hash and lands in FTS', () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  try {
    const a = store.insertMemory({ content: '用户说周末要去杭州出差三天', kind: 'turn', memoryCfg: cfg.memory });
    assert.equal(a.inserted, true);
    const b = store.insertMemory({ content: '用户说周末要去杭州出差三天', kind: 'turn', memoryCfg: cfg.memory });
    assert.equal(b.inserted, false);
    assert.equal(b.id, a.id);
    assert.equal(store.countAll(), 1);

    const hits = store.searchFts(['杭州出差'], 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, a.id);
  } finally {
    store.close();
    cleanup();
  }
});

test('sweep demotes cold memories and keeps pinned warm', () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  try {
    const old = store.insertMemory({ content: '很老的一条日常对话记录，关于打印机驱动', kind: 'turn', memoryCfg: cfg.memory });
    const pin = store.insertMemory({ content: '手动记的偏好：缩进用两个空格', kind: 'note', pinned: true, memoryCfg: cfg.memory });
    const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.mem.prepare('UPDATE memories SET reinforced_at = ? WHERE id IN (?, ?)').run(longAgo, old.id, pin.id);

    const out = store.sweep({ memoryCfg: cfg.memory });
    assert.ok(out.scanned >= 2);
    assert.equal(store.getMemory(old.id).tier, 'cold');
    assert.notEqual(store.getMemory(pin.id).tier, 'cold');
  } finally {
    store.close();
    cleanup();
  }
});

test('vector index returns nearest neighbour', async () => {
  const index = new VectorIndex(4, { preferWorker: false });
  try {
    index.set('a', new Float32Array([1, 0, 0, 0]));
    index.set('b', new Float32Array([0, 1, 0, 0]));
    index.set('c', new Float32Array([0.6, 0.8, 0, 0]));
    const hits = await index.search(new Float32Array([1, 0, 0, 0]), 2);
    assert.equal(hits[0].id, 'a');
    assert.ok(hits[0].score > 0.99);
    index.delete('a');
    const after = await index.search(new Float32Array([1, 0, 0, 0]), 1);
    assert.equal(after[0].id, 'c');
  } finally {
    index.close();
  }
});

test('capture 粗筛只拦形式噪声，内容价值交给 LLM 裁决', () => {
  const cfg = makeCfg('x');
  assert.equal(isWorthKeeping({ text: '嗯', cfg }).keep, false);
  assert.equal(isWorthKeeping({ text: '/help', cfg }).keep, false);
  assert.equal(
    isWorthKeeping({ text: '帮我把这个视频按照两遍码率压一下，目标 500MB 以内', cfg }).keep,
    true,
  );
  assert.equal(isWorthKeeping({ text: '那这个呢', cfg }).keep, true, '短追问不再被长度闸门误伤');
});

test('手动 remember 绕过粗筛，直接写入并 pinned', async () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  const index = new VectorIndex(cfg.embedding.dimensions, { preferWorker: false });
  const embedder = new FakeEmbedder(cfg.embedding.dimensions);
  try {
    const saved = await remember({ store, index, embedder, cfg, text: '嗯' });
    assert.equal(saved.ok, true);
    assert.equal(store.countAll(), 1);
    assert.equal(store.getMemory(saved.id).pinned, 1);
  } finally {
    index.close();
    store.close();
    cleanup();
  }
});

test('hybrid search finds exact text via FTS and vectors', async () => {
  const { dir, cleanup } = tmp();
  // 维度太低时假向量的余弦会乱撞（8 维下无关文本能到 0.66），这里测的是检索不是运气
  const cfg = makeCfg(dir, 64);
  const store = openStore(dir, cfg);
  const index = new VectorIndex(cfg.embedding.dimensions, { preferWorker: false });
  const embedder = new FakeEmbedder(cfg.embedding.dimensions);
  try {
    const text = '用户的笔记根目录在 D 盘的 notes 文件夹里';
    const { id } = store.insertMemory({ content: text, kind: 'turn', memoryCfg: cfg.memory });
    store.setVector(id, hashVector(text, cfg.embedding.dimensions));
    loadIndex({ store, index, cfg });

    const res = await hybridSearch({ store, index, embedder, cfg, query: text, limit: 3 });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, id);
    assert.match(res.items[0].via, /vector/);

    const lexical = await hybridSearch({ store, index, embedder, cfg, query: 'notes 文件夹', limit: 3 });
    assert.ok(lexical.items.some((i) => i.id === id));

    const miss = await hybridSearch({ store, index, embedder, cfg, query: '完全不相关的一条查询内容', limit: 3 });
    assert.equal(miss.items.length, 0);
  } finally {
    index.close();
    store.close();
    cleanup();
  }
});

test('recall reinforces what it injects', async () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  const index = new VectorIndex(cfg.embedding.dimensions, { preferWorker: false });
  const embedder = new FakeEmbedder(cfg.embedding.dimensions);
  try {
    const text = '用户偏好把结论放到最前面，过程一句带过';
    const { id } = store.insertMemory({ content: text, kind: 'turn', memoryCfg: cfg.memory });
    store.setVector(id, hashVector(text, cfg.embedding.dimensions));
    loadIndex({ store, index, cfg });

    const res = await recallForPrompt({ store, index, embedder, cfg, query: text });
    assert.equal(res.count, 1);
    assert.match(res.context, /结论放到最前面/);
    assert.equal(store.getMemory(id).access_count, 1);
    assert.ok(store.getMemory(id).last_access_at);
  } finally {
    index.close();
    store.close();
    cleanup();
  }
});

test('remember / forget roundtrip', async () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  const index = new VectorIndex(cfg.embedding.dimensions, { preferWorker: false });
  const embedder = new FakeEmbedder(cfg.embedding.dimensions);
  try {
    const saved = await remember({ store, index, embedder, cfg, text: '代理由本地 127.0.0.1:7890' });
    assert.equal(saved.ok, true);
    assert.equal(saved.vector, true);
    assert.equal(store.countVectors(), 1);

    const dup = await remember({ store, index, embedder, cfg, text: '代理由本地 127.0.0.1:7890' });
    assert.equal(dup.deduped, true);

    const gone = forget({ store, index, cfg, query: '7890' });
    assert.equal(gone.removed, 1);
    assert.equal(store.countAll(), 0);
    assert.equal(store.countVectors(), 0);
    assert.equal(store.countTombstones(), 1);
  } finally {
    index.close();
    store.close();
    cleanup();
  }
});

test('prune needs the token unless forced', () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  const store = openStore(dir, cfg);
  const index = new VectorIndex(cfg.embedding.dimensions, { preferWorker: false });
  try {
    const { id } = store.insertMemory({ content: '一条很久以前的冷记忆，关于旧的压缩参数', kind: 'turn', memoryCfg: cfg.memory });
    const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.mem.prepare('UPDATE memories SET tier = ?, reinforced_at = ?, last_access_at = NULL WHERE id = ?').run('cold', longAgo, id);

    const preview = prunePreview({ store, cfg, olderThanDays: 90 });
    assert.equal(preview.total, 1);
    assert.ok(preview.token.length >= 8);

    const bad = pruneApply({ store, index, cfg, olderThanDays: 90, token: 'nope' });
    assert.equal(bad.ok, false);
    assert.equal(store.countAll(), 1);

    const good = pruneApply({ store, index, cfg, olderThanDays: 90, token: preview.token });
    assert.equal(good.ok, true);
    assert.equal(good.removed, 1);
    assert.equal(store.countAll(), 0);
  } finally {
    index.close();
    store.close();
    cleanup();
  }
});

test('orphan vectors are pruned', () => {
  const { dir, cleanup } = tmp();
  const store = new Store({ dataDir: dir, dimensions: 1024, model: 'BAAI/bge-m3', scopeId: 'default' });
  try {
    const { id } = store.insertMemory({
      occurredAt: new Date().toISOString(),
      localDate: localDate(new Date()),
      kind: 'note',
      userText: '孤儿向量测试',
      assistantText: '',
      content: '孤儿向量测试',
      sessionId: null,
      scopeId: 'default',
      source: 'manual',
    });
    assert.equal(store.setVector(id, hashVector('孤儿向量测试', 1024)), true);
    assert.equal(store.countVectors(), 1);

    // 绕过 deleteMemory 直接删记忆行，模拟迁移中断留下的半截数据
    store.mem.prepare('DELETE FROM memories WHERE id = ?').run(id);
    assert.equal(store.countVectors(), 1);
    assert.equal(store.pruneOrphanVectors(), 1);
    assert.equal(store.countVectors(), 0);
  } finally {
    store.close();
    cleanup();
  }
});
test('legacy two-file layout folds into the single database', () => {
  const { dir, cleanup } = tmp();
  const cfg = makeCfg(dir);
  let store = openStore(dir, cfg);
  let a;
  let b;
  try {
    a = store.insertMemory({ content: '第一条记忆：周一要交报告', kind: 'turn', memoryCfg: cfg.memory });
    b = store.insertMemory({ content: '第二条记忆：周四回访客户', kind: 'turn', memoryCfg: cfg.memory });
    store.setVector(a.id, hashVector('第一条记忆', 8));
  } finally {
    store.close();
  }

  // 造一个老版本留下的独立向量库
  const legacy = new DatabaseSync(join(dir, 'vectors.sqlite3'));
  legacy.exec(`
    CREATE TABLE vectors (
      memory_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, updated_at TEXT NOT NULL, vector BLOB NOT NULL
    ) STRICT;
  `);
  const vec = hashVector('第二条记忆', 8);
  legacy
    .prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?)')
    .run(b.id, 'default', 'fake', 8, new Date().toISOString(), new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  legacy.close();

  store = openStore(dir, cfg);
  try {
    assert.equal(existsSync(join(dir, 'vectors.sqlite3')), false, 'legacy file should be moved away');
    assert.ok(existsSync(join(dir, 'legacy')), 'legacy backup folder exists');
    assert.equal(store.countVectors(), 2);
    assert.equal(store.countAll(), 2);
    assert.equal(store.getMemory(b.id).embedding_status, 'ok');
  } finally {
    store.close();
    cleanup();
  }
});

test('scattered store imports into the unified library and purges cleanly', () => {
  const target = tmp();
  const source = tmp();
  const cfg = makeCfg(target.dir);
  const srcStore = openStore(source.dir, cfg);
  try {
    srcStore.insertMemory({ content: '重复的一条：代理走 127.0.0.1:7890', kind: 'turn', memoryCfg: cfg.memory });
    const uniq = srcStore.insertMemory({ content: '只在这个散落库里的一条：打印机驱动路径', kind: 'note', memoryCfg: cfg.memory });
    srcStore.setVector(uniq.id, hashVector('打印机', 8));
  } finally {
    srcStore.close();
  }

  const store = openStore(target.dir, cfg);
  try {
    store.insertMemory({ content: '重复的一条：代理走 127.0.0.1:7890', kind: 'turn', memoryCfg: cfg.memory });

    const dry = importFromPath({ db: store.db, path: source.dir, targetScopeId: 'default', dimensions: 8, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.imported, 1);
    assert.equal(store.countAll(), 1, 'dry run writes nothing');

    const res = importFromPath({ db: store.db, path: source.dir, targetScopeId: 'default', dimensions: 8 });
    assert.equal(res.imported, 1);
    assert.equal(res.duplicates, 1);
    assert.equal(res.vectors, 1);
    assert.equal(store.countAll(), 2);
    assert.equal(store.countVectors(), 1);

    // 目录里还有别的东西时不许整目录删
    writeFileSync(join(source.dir, 'notes.txt'), 'keep me');
    assert.equal(purgeStoreDir(source.dir).ok, false);
    rmSync(join(source.dir, 'notes.txt'));
    assert.equal(purgeStoreDir(source.dir).ok, true);
    assert.equal(existsSync(source.dir), false);
  } finally {
    store.close();
    target.cleanup();
    source.cleanup();
  }
});

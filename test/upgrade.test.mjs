// 升级路径：v2 的双库（正文 + 独立向量文件）要在打开时自动并进单文件，
// 并完把老文件挪进 legacy/，重复启动不产生第二份，维度/模型变了的老向量要能自己重嵌。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../lib/store.mjs';
import { hashVector } from '../lib/embedding.mjs';
import { DB_NAME, LEGACY_DIR } from '../lib/migrate.mjs';

// v2 里向量表的原始形状，照抄当时的 DDL（含自己那份 meta）
const V2_VEC_DDL = `
CREATE TABLE IF NOT EXISTS vectors (
  memory_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  vector BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const MEMORY_CFG = {
  hot_in: 0.6, hot_out: 0.4, warm_in: 0.3, warm_out: 0.15,
  hot_max: 3000, warm_max: 12000,
  half_life_days: 45, half_life: { turn: 45, note: 365 },
  reinforce_base: 1, reinforce_gain: 0.35, reinforce_cap: 3,
  archive_after_days: 0,
};

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'alice-upgrade-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const openStore = (dir, dims = 8, model = 'fake') =>
  new Store({ dataDir: dir, dimensions: dims, model, scopeId: 'default' });

/** 造一个 v2 布局：memories.sqlite3（无 vectors 表）+ vectors.sqlite3 */
function makeV2Store(dir, { dims = 8, model = 'fake', texts = [] } = {}) {
  const seed = openStore(dir, dims, model);
  const ids = [];
  for (const text of texts) {
    const { id } = seed.insertMemory({ content: text, kind: 'turn', memoryCfg: MEMORY_CFG });
    seed.setVector(id, hashVector(text, dims), model);
    ids.push(id);
  }
  seed.close();

  const mem = new DatabaseSync(join(dir, DB_NAME));
  const rows = mem.prepare('SELECT * FROM vectors').all();
  mem.exec('DROP TABLE vectors');
  mem.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  mem.close();

  const vec = new DatabaseSync(join(dir, 'vectors.sqlite3'));
  vec.exec(V2_VEC_DDL);
  const ins = vec.prepare(
    'INSERT INTO vectors (memory_id, scope_id, model, dimensions, updated_at, vector) VALUES (?,?,?,?,?,?)',
  );
  for (const row of rows) {
    ins.run(row.memory_id, row.scope_id, row.model, row.dimensions, row.updated_at, row.vector);
  }
  vec.close();
  return ids;
}

const legacyFiles = (dir) => {
  const at = join(dir, LEGACY_DIR);
  return existsSync(at) ? readdirSync(at) : [];
};

test('v2 双库升级：向量并进单文件，老文件挪进 legacy/', () => {
  const { dir, cleanup } = tmp();
  try {
    makeV2Store(dir, { texts: ['第一条测试记忆，关于打印机驱动', '第二条测试记忆，关于视频压缩参数'] });
    assert.equal(existsSync(join(dir, 'vectors.sqlite3')), true);

    const store = openStore(dir);
    try {
      assert.equal(store.countAll(), 2);
      assert.equal(store.countVectors(), 2);
      for (const row of store.exportAll()) assert.equal(row.embedding_status, 'ok');
      assert.equal(existsSync(join(dir, 'vectors.sqlite3')), false, '老文件该被挪走');
      const files = legacyFiles(dir);
      assert.equal(files.length, 1);
      assert.match(files[0], /^vectors\.sqlite3\.\d{14}$/);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('并库幂等：反复启动不产生第二份，legacy 不会堆积', () => {
  const { dir, cleanup } = tmp();
  try {
    makeV2Store(dir, { texts: ['幂等测试用的记忆内容，关于磁盘配额'] });
    for (let i = 0; i < 4; i += 1) {
      const store = openStore(dir);
      try {
        assert.equal(store.countVectors(), 1);
        assert.equal(store.countAll(), 1);
      } finally {
        store.close();
      }
    }
    assert.equal(legacyFiles(dir).length, 1);
  } finally {
    cleanup();
  }
});

test('维度变了：老向量不算数，打回 pending 等重嵌', () => {
  const { dir, cleanup } = tmp();
  try {
    makeV2Store(dir, { dims: 8, texts: ['维度不匹配的测试记忆，关于备份策略'] });
    const store = openStore(dir, 16);
    try {
      assert.equal(store.countAll(), 1);
      assert.equal(store.countVectors(), 0, '旧维度向量不该并进来');
      assert.equal(store.exportAll()[0].embedding_status, 'pending', '要能被 backfill 重嵌');
      assert.equal(legacyFiles(dir).length, 1);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('模型换了但维度没变：同样按不合格处理', () => {
  const { dir, cleanup } = tmp();
  try {
    makeV2Store(dir, { dims: 8, model: 'old-model', texts: ['换模型的测试记忆，关于索引重建'] });
    const store = openStore(dir, 8, 'new-model');
    try {
      assert.equal(store.countVectors(), 0);
      assert.equal(store.exportAll()[0].embedding_status, 'pending');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('老文件是坏文件：不影响启动，也不悄悄删掉', () => {
  const { dir, cleanup } = tmp();
  try {
    const seed = openStore(dir);
    seed.insertMemory({ content: '正文必须活下来的一条记忆', kind: 'turn', memoryCfg: MEMORY_CFG });
    seed.close();
    writeFileSync(join(dir, 'vectors.sqlite3'), 'this is not a sqlite database');

    const store = openStore(dir);
    try {
      assert.equal(store.countAll(), 1);
      assert.equal(store.countVectors(), 0);
      assert.equal(legacyFiles(dir).length, 1, '坏文件归档而不是删除');
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('全新安装：不建 legacy 目录', () => {
  const { dir, cleanup } = tmp();
  try {
    const store = openStore(dir);
    store.close();
    assert.equal(existsSync(join(dir, LEGACY_DIR)), false);
  } finally {
    cleanup();
  }
});

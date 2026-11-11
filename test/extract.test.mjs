// capture 链路升级的验收测试：全程 mock LLM / 断网，不产生任何真实模型调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../lib/store.mjs';
import { VectorIndex } from '../lib/vector-index.mjs';
import { FakeEmbedder } from '../lib/embedding.mjs';
import { isWorthKeeping, truncateForPool } from '../lib/capture.mjs';
import { localDate } from '../lib/text.mjs';
import {
  readHostProviders, resolveLlmConfig, buildPrompt, parseItems,
} from '../lib/extractor.mjs';
import {
  ensureExtractionSchema, cursor, dailyExtractions, commitExtraction,
} from '../lib/extraction-store.mjs';
import { createCapturePool } from '../lib/pool.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'alice-extract-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCfg(dir, overrides = {}) {
  const base = {
    dshHome: dir,
    dataDir: dir,
    scope_id: 'default',
    embedding: {
      model: 'fake', dimensions: 8, batch: 16, timeout_ms: 200,
      max_input_chars: 4000, docPrefix: '', queryPrefix: '', apiKey: '', url: 'http://127.0.0.1:9/never',
    },
    search: {
      min_score: 0.5, vector_weight: 1, lexical_weight: 0.35, rrf_k: 60,
      candidate_multiplier: 4, cold_wake: false, cold_scan_budget_ms: 200, cold_scan_cap: 10000,
    },
    memory: {
      hot_in: 0.6, hot_out: 0.4, warm_in: 0.3, warm_out: 0.15,
      hot_max: 3000, warm_max: 12000, half_life: { turn: 45 },
      reinforce_base: 1, reinforce_gain: 0.35, reinforce_cap: 3, archive_after_days: 0,
    },
    recall: { limit: 3, timeout_ms: 3000, max_chars: 400, labels: { user: 'User', assistant: 'Assistant' } },
    capture: { enabled: true, idleMs: 15, model: 'inherit', maxDailyExtractions: 50, embed_retry_minutes: 5 },
    files: {
      db: join(dir, 'memories.sqlite3'),
      settings: join(dir, 'settings.yaml'),
      env: join(dir, '.env'),
      credentials: join(dir, '.credentials.yaml'),
    },
  };
  return { ...base, ...overrides, capture: { ...base.capture, ...(overrides.capture ?? {}) } };
}

function openStore(dir) {
  const store = new Store({ dataDir: dir, dimensions: 8, model: 'fake', scopeId: 'default' });
  ensureExtractionSchema(store); // 生产里由 createCapturePool 在启动时做
  return store;
}

function writeSettings(dir) {
  writeFileSync(join(dir, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    magpie:',
    '      displayName : Magpie',
    '      apiKeyEnv : MAGPIE_GATEWAY_KEY',
    '      api : openai-completions',
    '      # local gateway',
    '      baseURL : http://127.0.0.1:3425/v1',
    '      models:',
    '        - id : group/dsv41',
    '        - id : group/glm5.3f',
    '      streamIdleTimeoutMs : 600000',
    '',
  ].join('\n'));
}

/** 只实现 doFetch 用到的那部分 Response */
function mockFetch(items, { fail = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (fail) throw new Error('network down');
    const content = JSON.stringify({ items });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  return { fn, calls };
}

function setup(dir, cfg, fetchImpl, env = {}, embedderOverride = null) {
  const store = openStore(dir);
  const index = new VectorIndex(8, { preferWorker: false });
  const embedder = embedderOverride ?? new FakeEmbedder(8);
  const events = [];
  const ctx = { emit: (name, payload) => events.push({ name, ...payload }) };
  const pool = createCapturePool({
    store, index, embedder, cfg, ctx, env, transport: fetchImpl,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  });
  return {
    store, index, embedder, pool, events,
    cleanup: () => { pool.dispose(); index.close(); store.close(); },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PREF = { content: '用户以后都用 TypeScript，不喜欢 any', type: 'preference', confidence: 0.9, sourceTurnIds: [2] };

// ---------- 验收 9：inherit 复用主对话连接参数 ----------

test('readHostProviders 解析宿主 settings.yaml 的 provider 段', () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const providers = readHostProviders(join(dir, 'settings.yaml'));
    assert.equal(providers.magpie.apiKeyEnv, 'MAGPIE_GATEWAY_KEY');
    assert.equal(providers.magpie.baseURL, 'http://127.0.0.1:3425/v1');
    assert.equal(providers.magpie.api, 'openai-completions');
    assert.deepEqual(providers.magpie.models, ['group/dsv41', 'group/glm5.3f']);
  } finally {
    cleanup();
  }
});

test('capture.model=inherit 时复用主对话 base_url / apiKey / model，无需第三把 key', () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const conn = resolveLlmConfig({
      cfg, selection: { provider: 'magpie', model: 'group/dsv41' }, env: { MAGPIE_GATEWAY_KEY: 'test-key' },
    });
    assert.equal(conn.ok, true);
    assert.equal(conn.url, 'http://127.0.0.1:3425/v1/chat/completions');
    assert.equal(conn.apiKey, 'test-key');
    assert.equal(conn.model, 'group/dsv41');

    // env 缺席时回落到 $DSH_HOME/.env
    writeFileSync(join(dir, '.env'), 'MAGPIE_GATEWAY_KEY=from-env-file\n');
    const conn2 = resolveLlmConfig({ cfg, selection: { provider: 'magpie', model: 'group/dsv41' }, env: {} });
    assert.equal(conn2.apiKey, 'from-env-file');

    // 覆盖成具体模型名
    const conn3 = resolveLlmConfig({
      cfg: makeCfg(dir, { capture: { model: 'workbuddy/hy4free' } }),
      selection: { provider: 'magpie', model: 'group/dsv41' }, env: { MAGPIE_GATEWAY_KEY: 'k' },
    });
    assert.equal(conn3.model, 'workbuddy/hy4free');
  } finally {
    cleanup();
  }
});

test('实时性：换主模型立刻跟随，settings.yaml 改了立刻生效（不缓存）', () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const a = resolveLlmConfig({ cfg, selection: { provider: 'magpie', model: 'group/dsv41' }, env });
    const b = resolveLlmConfig({ cfg, selection: { provider: 'magpie', model: 'group/glm5.3f' }, env });
    assert.equal(a.model, 'group/dsv41');
    assert.equal(b.model, 'group/glm5.3f', '同一份 cfg 换 selection 立刻换模型');

    writeFileSync(join(dir, 'settings.yaml'), readFileSync(join(dir, 'settings.yaml'), 'utf8').replace('/v1', '/v9'));
    const c = resolveLlmConfig({ cfg, selection: { provider: 'magpie', model: 'group/dsv41' }, env });
    assert.equal(c.url, 'http://127.0.0.1:3425/v9/chat/completions', '网关参数每次现读盘');
  } finally {
    cleanup();
  }
});

test('provider 段缩进改成 2 空格也能解析（宿主重排不失效）', () => {
  const { dir, cleanup } = tmp();
  try {
    writeFileSync(join(dir, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    magpie:',
      '      apiKeyEnv : MAGPIE_GATEWAY_KEY',
      '      baseURL : http://127.0.0.1:3425/v1',
      '      headers:',
      '        x-trace : on',
      '      models:',
      '        - id : group/dsv41',
      '',
    ].join('\n').replace(/^ {4}/gm, '  '));
    const providers = readHostProviders(join(dir, 'settings.yaml'));
    assert.deepEqual(Object.keys(providers), ['magpie'], 'headers 子对象不被认成 provider');
    assert.equal(providers.magpie.baseURL, 'http://127.0.0.1:3425/v1');
    assert.deepEqual(providers.magpie.models, ['group/dsv41']);
  } finally {
    cleanup();
  }
});

test('主模型不属于 settings 任何 provider 时明确报错，不静默发到错误网关', () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const res = resolveLlmConfig({
      cfg, selection: { provider: 'deepseek', model: 'deepseek-chat' }, env: { MAGPIE_GATEWAY_KEY: 'k' },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /deepseek/);
    assert.match(res.error, /capture\.model/);
  } finally {
    cleanup();
  }
});

test('capture.model 覆盖成别家 provider 的模型：网关与凭证一起跟着换', () => {
  const { dir, cleanup } = tmp();
  try {
    writeFileSync(join(dir, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    magpie:',
      '      apiKeyEnv : MAGPIE_GATEWAY_KEY',
      '      baseURL : http://127.0.0.1:3425/v1',
      '      models:',
      '        - id : group/dsv41',
      '    other:',
      '      apiKeyEnv : OTHER_KEY',
      '      baseURL : https://api.other.example/v1',
      '      models:',
      '        - id : other/fast-model',
      '',
    ].join('\n'));
    const res = resolveLlmConfig({
      cfg: makeCfg(dir, { capture: { model: 'other/fast-model' } }),
      selection: { provider: 'magpie', model: 'group/dsv41' },
      env: { MAGPIE_GATEWAY_KEY: 'k1', OTHER_KEY: 'k2' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'other');
    assert.equal(res.url, 'https://api.other.example/v1/chat/completions');
    assert.equal(res.apiKey, 'k2', '不拿 magpie 的 key 去敲别家网关');
  } finally {
    cleanup();
  }
});

test('提炼请求真的用当前主模型：两次 flush 之间换模型，第二次请求跟着换', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const mock = mockFetch([]);
    const s = setup(dir, cfg, mock.fn, env);
    try {
      s.pool.setSelection({ provider: 'magpie', model: 'group/dsv41' });
      s.pool.beginTurn();
      s.pool.onMessage('user', '第一轮有内容的对话');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(mock.calls[0].body.model, 'group/dsv41');

      s.pool.setSelection({ provider: 'magpie', model: 'workbuddy/hy4free' });
      s.pool.beginTurn();
      s.pool.onMessage('user', '第二轮有内容的对话');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(mock.calls[1].body.model, 'workbuddy/hy4free', '不缓存模型名');
      assert.equal(mock.calls[1].url, 'http://127.0.0.1:3425/v1/chat/completions');
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 提炼层输出契约 ----------

test('parseItems 兼容数组 / 对象包装 / 空数组，非法输出抛错', () => {
  assert.deepEqual(parseItems('[]'), []);
  assert.deepEqual(parseItems('{"items":[]}'), []);
  assert.equal(parseItems('```json\n[{"content":"用户偏好 TypeScript","type":"preference","confidence":0.8,"source_turn_ids":[3]}]\n```')[0].type, 'preference');
  assert.equal(parseItems('{"items":[{"content":"一句话","type":"随便"}]}')[0].type, 'fact');
  assert.throws(() => parseItems('not json'), /JSON parse failed/);
  assert.throws(() => parseItems('{"foo":1}'), /not an item array/);
});

test('buildPrompt 只含原文与约束，已有记忆参考块不再进提示词', () => {
  const [system, user] = buildPrompt({
    turns: [{ turnId: 11, role: 'user', text: '我以后都用 TypeScript' }],
  });
  assert.match(system.content, /只依据/);
  assert.match(system.content, /向量判重/);
  assert.match(user.content, /【本次待提炼的对话原文】/);
  assert.match(user.content, /【禁止提取清单】/);
  assert.doesNotMatch(user.content, /【已有记忆/);
  assert.match(user.content, /turn 11/);
  assert.match(user.content, /\[\]/);
});

// ---------- 入池截断：助手长回复与长贴日志不再整段进提炼 prompt ----------

test('入池截断：user 500 / assistant 200，超长补省略号，数字配置两角色同限', () => {
  const cfg = makeCfg('x');
  const t = truncateForPool({ text: '用'.repeat(600), role: 'user', cfg });
  assert.equal(t.length, 501);
  assert.ok(t.endsWith('…'));
  const a = truncateForPool({ text: '好'.repeat(300), role: 'assistant', cfg });
  assert.equal(a.length, 201);
  assert.ok(a.endsWith('…'));
  const short = truncateForPool({ text: '短内容原样保留', role: 'user', cfg });
  assert.equal(short, '短内容原样保留');
  const num = makeCfg('x', { capture: { max_turn_chars: 80 } });
  assert.equal(truncateForPool({ text: '长'.repeat(120), role: 'assistant', cfg: num }).length, 81);
});

test('提炼请求里的原文按角色截断：300 字的助手回复不再整段进 prompt', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const mock = mockFetch([]);
    const s = setup(dir, cfg, mock.fn, { MAGPIE_GATEWAY_KEY: 'k' });
    try {
      s.pool.beginTurn();
      s.pool.onMessage('assistant', '好'.repeat(300));
      s.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(mock.calls.length, 1);
      const prompt = mock.calls[0].body.messages[1].content;
      assert.ok(prompt.includes('…'), '截断处补省略号');
      assert.ok(!prompt.includes('好'.repeat(250)), '长回复没有整段进 prompt');
      assert.ok(prompt.includes('我以后都用 TypeScript，不喜欢 any'), '用户原文完整保留');
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 6：WAL + busy_timeout ----------

test('启动即 WAL + busy_timeout=5000', () => {
  const { dir, cleanup } = tmp();
  const store = openStore(dir);
  try {
    assert.equal(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    assert.equal(Number(Object.values(store.db.prepare('PRAGMA busy_timeout').get())[0]), 5000);
  } finally {
    store.close();
    cleanup();
  }
});

// ---------- 粗筛：必留规则 ----------

test('粗筛保留必留规则，移除激进长度闸门', () => {
  const cfg = makeCfg('x');
  const skip = [
    ['', 'empty text'], ['嗯', 'too short'], ['好的！', 'filler'], ['谢谢', 'too short'],
    ['okay', 'filler'],
    ['/help', 'slash command'], ['/记忆撤销', 'revoke command'],
    ['？？？', 'no words'], ['😀😀', 'no words'],
    ['[alice-memory: recall] 内容', 'our own recall block'],
    ['- [2026-11-10] 完成任务', 'our own recall block'],
  ];
  for (const [text, reason] of skip) {
    assert.equal(isWorthKeeping({ text, cfg }).keep, false, `${text} → ${reason}`);
    assert.equal(isWorthKeeping({ text, cfg }).reason, reason);
  }
  assert.equal(isWorthKeeping({ text: '那这个呢', cfg }).keep, true, '短追问交给 LLM 裁决');
  assert.equal(isWorthKeeping({ text: '帮我看一下这个', cfg }).keep, true);
  const off = makeCfg('x', { capture: { enabled: false } });
  assert.equal(isWorthKeeping({ text: '一条很有价值的内容', cfg: off }).reason, 'capture disabled');
});

// ---------- 存储层：单事务 / 去重 / 不存原文 ----------

test('空数组是合法输出：只推进游标与提炼计数，0 条新增', () => {
  const { dir, cleanup } = tmp();
  const store = openStore(dir);
  try {
    const cfg = makeCfg(dir);
    const out = commitExtraction({ store, items: [], maxTurnId: 7, memoryCfg: cfg.memory });
    assert.equal(out.inserted.length, 0);
    assert.equal(cursor(store), 7);
    assert.equal(dailyExtractions(store, localDate()), 1);
    assert.equal(store.countAll(), 0);
  } finally {
    store.close();
    cleanup();
  }
});

test('偏好条目落库：type=preference，只存一句话，user_text/assistant_text 为空', () => {
  const { dir, cleanup } = tmp();
  const store = openStore(dir);
  try {
    const cfg = makeCfg(dir);
    const out = commitExtraction({ store, items: [PREF], maxTurnId: 3, memoryCfg: cfg.memory });
    assert.equal(out.inserted.length, 1);
    assert.equal(cursor(store), 3);
    const row = store.getMemory(out.inserted[0]);
    assert.equal(row.memory_type, 'preference');
    assert.equal(row.content, PREF.content);
    assert.equal(row.user_text, null);
    assert.equal(row.assistant_text, null);
    assert.equal(row.source, 'extracted');
    assert.deepEqual(JSON.parse(row.extract_meta).source_turn_ids, [2]);
  } finally {
    store.close();
    cleanup();
  }
});

test('两次提炼产出完全相同的 content：sha256 命中，不重复插入，只回原 id', () => {
  const { dir, cleanup } = tmp();
  const store = openStore(dir);
  try {
    const cfg = makeCfg(dir);
    const a = commitExtraction({ store, items: [PREF], maxTurnId: 2, memoryCfg: cfg.memory });
    const b = commitExtraction({ store, items: [PREF], maxTurnId: 5, memoryCfg: cfg.memory });
    assert.equal(b.inserted.length, 0);
    assert.deepEqual(b.deduped, [a.inserted[0]]);
    assert.equal(store.countAll(), 1);
    assert.equal(cursor(store), 5);
  } finally {
    store.close();
    cleanup();
  }
});

test('事务中任一条失败：全部回滚，游标与计数都不动', () => {
  const { dir, cleanup } = tmp();
  const store = openStore(dir);
  try {
    const cfg = makeCfg(dir);
    let calls = 0;
    const stub = {
      db: store.db,
      scopeId: 'default',
      meta: (k) => store.meta(k),
      setMeta: (k, v) => store.setMeta(k, v),
      insertMemory: (input) => {
        calls += 1;
        if (calls === 2) throw new Error('db boom');
        return store.insertMemory(input);
      },
    };
    assert.throws(
      () => commitExtraction({
        store: stub,
        items: [PREF, { content: '第二条不同的记忆内容', type: 'fact', confidence: 0.7, sourceTurnIds: [] }],
        maxTurnId: 9,
        memoryCfg: cfg.memory,
      }),
      /db boom/,
    );
    assert.equal(store.countAll(), 0);
    assert.equal(cursor(store), 0);
    assert.equal(dailyExtractions(store, localDate()), 0);
  } finally {
    store.close();
    cleanup();
  }
});

// ---------- 验收 1 / 2：闲聊 0 条，偏好 1 条 ----------

test('连续 10 轮纯闲聊，空闲触发后新增 0 条', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const mock = mockFetch([]);
    const s = setup(dir, cfg, mock.fn, env);
    try {
      const chatter = [
        '早上好呀今天天气不错', '那这个呢', '哈哈哈这也太离谱了', '哎算了不想弄了',
        '你说是不是这个道理', '嗯嗯再说吧', '刚才那个不用管了', '随便吧都行',
        '谢谢啦辛苦了哦', '好吧那就这样',
      ];
      for (const text of chatter) {
        s.pool.beginTurn();
        s.pool.onMessage('user', text);
        s.pool.onMessage('assistant', '哈哈好的，那就先这样吧');
        s.pool.completeTurn();
      }
      await wait(120);
      assert.equal(s.store.countAll(), 0);
      assert.equal(mock.calls.length, 1, '10 轮合批成一次提炼');
      assert.equal(s.events.filter((e) => e.name === 'memory-capture:success').at(-1).count, 0);
      assert.equal(cursor(s.store), 10);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('3 轮含明确偏好，触发后库里 1 条 type=preference', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const mock = mockFetch([PREF]);
    const s = setup(dir, cfg, mock.fn, env);
    try {
      for (const text of ['早上好呀', '我以后都用 TypeScript，不喜欢 any', '那其他文件呢']) {
        s.pool.beginTurn();
        s.pool.onMessage('user', text);
        s.pool.onMessage('assistant', '收到，我记住了');
        s.pool.completeTurn();
      }
      await wait(120);
      assert.equal(s.store.countAll(), 1);
      const row = s.store.getAll?.() ?? s.store.db.prepare('SELECT * FROM memories').all();
      assert.equal(row[0].memory_type, 'preference');
      assert.equal(row[0].content, PREF.content);
      assert.equal(s.events.filter((e) => e.name === 'memory-capture:success').at(-1).count, 1);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 向量判重闸：端到端 ----------

const unitVec = (i) => {
  const v = new Float32Array(8);
  v[i] = 1;
  return v;
};
/** e_i 与 e_j 方向拼出指定余弦的向量（i⊥j 时成立） */
const mixVec = (i, j, cos) => {
  const v = new Float32Array(8);
  v[i] = cos;
  v[j] = Math.sqrt(1 - cos * cos);
  return v;
};

test('端到端判重：库里同类记忆超量，提炼照跑但 0 条入库，游标照常推进', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const CAND = '这个话题又被提了一遍';
    const mock = mockFetch([{ content: CAND, type: 'fact', confidence: 0.8, sourceTurnIds: [1] }]);
    // 库里先有 4 条与候选向量夹角 0.8 的记忆（0.8 ≥ floor 0.75，4 > similar_max 3）
    const bank = mixVec(0, 1, 0.8);
    const embedder = {
      ready: true,
      async embedDocs(texts) {
        return { ok: true, vectors: texts.map((t) => (t === CAND ? unitVec(0) : bank)) };
      },
    };
    const s = setup(dir, cfg, mock.fn, env, embedder);
    try {
      const seeded = commitExtraction({
        store: s.store,
        items: [1, 2, 3, 4].map((i) => ({
          content: `同类记忆第 ${i} 条`, type: 'fact', confidence: 0.8, sourceTurnIds: [],
        })),
        maxTurnId: 0,
        memoryCfg: cfg.memory,
      });
      assert.equal(seeded.inserted.length, 4);
      for (const id of seeded.inserted) s.index.set(id, bank);

      s.pool.beginTurn();
      s.pool.onMessage('user', '又聊到这个话题的一些内容');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(mock.calls.length, 1, '提炼请求照发');
      assert.equal(s.store.countAll(), 4, '候选被饱和规则拦下，没有重复入库');
      assert.equal(cursor(s.store), 1, '游标照常推进，不会反复重提');
      assert.equal(
        s.events.filter((e) => e.name === 'memory-capture:success').at(-1).count,
        0,
      );
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('端到端判重：无关新偏好正常入库，闸不误伤', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const mock = mockFetch([PREF]);
    const embedder = {
      ready: true,
      async embedDocs(texts) {
        return { ok: true, vectors: texts.map((t) => (t === PREF.content ? unitVec(5) : unitVec(0))) };
      },
    };
    const s = setup(dir, cfg, mock.fn, env, embedder);
    try {
      const seeded = commitExtraction({
        store: s.store,
        items: [{ content: '无关的旧记忆', type: 'fact', confidence: 0.8, sourceTurnIds: [] }],
        maxTurnId: 0,
        memoryCfg: cfg.memory,
      });
      s.index.set(seeded.inserted[0], unitVec(0));

      s.pool.beginTurn();
      s.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(s.store.countAll(), 2, '新偏好与库内记忆正交，放行入库');
      assert.equal(cursor(s.store), 1);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 4：断网不推进游标，恢复后重提 ----------

test('提炼中断网 → 游标不前进 → 网络恢复后下次空闲自动重提', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    let offline = true;
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      if (offline) throw new Error('offline');
      return mockFetch([PREF]).fn(url, init);
    };
    const s = setup(dir, cfg, fetchImpl, env);
    try {
      s.pool.beginTurn();
      s.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      s.pool.onMessage('assistant', '收到');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(cursor(s.store), 0);
      assert.equal(s.store.countAll(), 0);
      assert.ok(s.events.some((e) => e.name === 'memory-capture:failed'));

      offline = false;
      await wait(120);
      assert.ok(calls >= 2, '失败后重新 arm 了 debounce');
      assert.equal(s.store.countAll(), 1);
      assert.equal(cursor(s.store), 1);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 7：游标持久化，重启不重提 ----------

test('进程重启后游标从 SQLite 读出，不从头发起重提', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const env = { MAGPIE_GATEWAY_KEY: 'k' };
    const mock1 = mockFetch([PREF]);
    const s1 = setup(dir, cfg, mock1.fn, env);
    try {
      s1.pool.beginTurn();
      s1.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      s1.pool.completeTurn();
      await wait(120);
      assert.equal(cursor(s1.store), 1);
    } finally {
      s1.cleanup();
    }

    const mock2 = mockFetch([PREF]);
    const s2 = setup(dir, cfg, mock2.fn, env);
    try {
      assert.equal(cursor(s2.store), 1);
      assert.equal(s2.pool.state.turnCounter, 1, '轮次号从游标续起');
      await s2.pool.flush();
      assert.equal(mock2.calls.length, 0, '没有待处理轮次就不发请求');
      s2.pool.beginTurn();
      s2.pool.onMessage('user', '新的一轮有实质内容的对话');
      s2.pool.completeTurn();
      await s2.pool.flush();
      assert.equal(mock2.calls.length, 1);
      assert.equal(cursor(s2.store), 2);
    } finally {
      s2.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 8：未完成轮次跳过 ----------

test('assistant 还在生成时到点触发，跳过未完成轮次留待下次', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    const mock = mockFetch([PREF]);
    const s = setup(dir, cfg, mock.fn, { MAGPIE_GATEWAY_KEY: 'k' });
    try {
      s.pool.beginTurn();
      s.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      await wait(120);
      assert.equal(s.store.countAll(), 0);
      assert.equal(mock.calls.length, 0);
      s.pool.onMessage('assistant', '收到，我记住了');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(s.store.countAll(), 1);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 5：无串行队列，主对话不被提炼请求拖住 ----------

test('提炼进行中，另一会话的消息处理不受延迟影响', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      await gate;
      return mockFetch([]).fn(url, init);
    };
    const s = setup(dir, cfg, fetchImpl, { MAGPIE_GATEWAY_KEY: 'k' });
    try {
      s.pool.beginTurn();
      s.pool.onMessage('user', '会话 A 的一轮有内容对话');
      s.pool.completeTurn();
      await wait(40);
      assert.equal(s.pool.state.flushing, true);

      const t0 = Date.now();
      s.pool.beginTurn();
      s.pool.onMessage('user', '会话 B 正常说话，内容足够长');
      s.pool.completeTurn();
      assert.ok(Date.now() - t0 < 10, '消息入池是同步的，没排队等 LLM');
      assert.equal(calls, 1, '重入锁挡住了并发 flush');

      release();
      await wait(120);
      assert.equal(s.pool.state.flushing, false);
      assert.equal(cursor(s.store), 2, '两批最终都处理完');
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 验收 6：多连接并发写不报 SQLITE_BUSY ----------

test('两个库连接交替写条目不报 SQLITE_BUSY', () => {
  const { dir, cleanup } = tmp();
  const a = openStore(dir);
  const b = openStore(dir);
  try {
    const cfg = makeCfg(dir);
    for (let i = 0; i < 20; i += 1) {
      commitExtraction({
        store: i % 2 ? a : b,
        items: [{
          content: `第 ${i} 条并发写入的记忆内容`,
          type: 'fact', confidence: 0.8, sourceTurnIds: [i],
        }],
        maxTurnId: i + 1,
        memoryCfg: cfg.memory,
      });
    }
    assert.equal(a.countAll(), 20);
    assert.equal(b.countAll(), 20);
    assert.equal(cursor(a), 20);
    assert.equal(cursor(b), 20);
  } finally {
    a.close();
    b.close();
    cleanup();
  }
});

test('提炼失败也计入每日上限：解析一直失败不会无限重试烧调用', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir, { capture: { maxDailyExtractions: 2, idleMs: 15 } });
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '这不是 JSON' } }] }) };
    };
    const s = setup(dir, cfg, fetchImpl, { MAGPIE_GATEWAY_KEY: 'k' });
    try {
      s.pool.beginTurn();
      s.pool.onMessage('user', '我以后都用 TypeScript，不喜欢 any');
      s.pool.completeTurn();
      await wait(200);
      assert.equal(calls, 2, '两个上限额度都花在失败重试上');
      assert.equal(dailyExtractions(s.store, localDate()), 2);
      assert.equal(cursor(s.store), 0, '游标仍未推进');
      assert.equal(s.store.countAll(), 0);
      assert.ok(s.events.filter((e) => e.name === 'memory-capture:failed').length >= 2);

      // 额度耗尽后不再发请求
      await wait(150);
      assert.equal(calls, 2);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 每日提炼次数上限 ----------

test('每日 LLM 提炼次数上限：达到后不再发请求，游标不动', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const cfg = makeCfg(dir, { capture: { maxDailyExtractions: 1 } });
    const mock = mockFetch([]);
    const s = setup(dir, cfg, mock.fn, { MAGPIE_GATEWAY_KEY: 'k' });
    try {
      s.pool.beginTurn();
      s.pool.onMessage('user', '第一轮的闲聊内容');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(dailyExtractions(s.store, localDate()), 1);
      assert.equal(cursor(s.store), 1);

      s.pool.beginTurn();
      s.pool.onMessage('user', '第二轮又一段闲聊内容');
      s.pool.completeTurn();
      await wait(120);
      assert.equal(mock.calls.length, 1);
      assert.equal(cursor(s.store), 1);
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

// 提炼指示器两条链路的验收：宿主侧状态广播（SSE）与「池事件 → 状态」的接线。
// 全程 mock：不连真 LLM、不开真端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../lib/store.mjs';
import { VectorIndex } from '../lib/vector-index.mjs';
import { FakeEmbedder } from '../lib/embedding.mjs';
import { ensureExtractionSchema } from '../lib/extraction-store.mjs';
import { createCapturePool } from '../lib/pool.mjs';
import { createCaptureStatus, STATUS_ROUTE } from '../lib/status.mjs';

/** 只实现 status.serve 用到的那部分 ServerResponse。 */
function fakeRes({ address = '127.0.0.1' } = {}) {
  const frames = [];
  const handlers = new Map();
  const res = {
    head: null,
    ended: false,
    writeHead(status, headers) {
      res.head = { status, headers };
      return res;
    },
    write(chunk) {
      frames.push(String(chunk));
      return true;
    },
    end() {
      res.ended = true;
    },
    on(event, fn) {
      handlers.set(event, fn);
      return res;
    },
    emit(event) {
      handlers.get(event)?.();
    },
    frames,
  };
  return {
    res,
    req: { method: 'GET', socket: { remoteAddress: address } },
  };
}

/** 从 SSE 文本里取最后一帧的 payload。 */
function lastFrame(res) {
  const payloads = res.frames
    .filter((chunk) => chunk.startsWith('event: status'))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)));
  return payloads.at(-1);
}

test('状态广播：连上来先收当前快照，之后每次更新都推一帧', async () => {
  const status = createCaptureStatus({});
  try {
    const a = fakeRes();
    status.serve(a.req, a.res);
    assert.equal(a.res.head.status, 200);
    assert.match(a.res.head.headers['content-type'], /text\/event-stream/);
    assert.equal(a.res.head.headers['cache-control'], 'no-store');
    assert.equal(a.res.frames[0], ': connected\n\n');
    assert.deepEqual(lastFrame(a.res), { phase: 'idle', at: 0 });
    assert.equal(status.listeners, 1);

    status.set('working', { turns: 2 });
    assert.deepEqual(lastFrame(a.res), { phase: 'working', at: status.snapshot().at, turns: 2 });

    // 第二个页面也拿得到，互相独立
    const b = fakeRes();
    status.serve(b.req, b.res);
    assert.deepEqual(lastFrame(b.res), status.snapshot());

    status.set('success', { count: 3 });
    assert.equal(lastFrame(a.res).phase, 'success');
    assert.equal(lastFrame(b.res).count, 3);

    a.res.emit('close');
    assert.equal(status.listeners, 1, '关掉一个连接只摘一个');
  } finally {
    status.dispose();
  }
});

test('状态广播：失败只给 phase，不把错误原文丢给 UI', () => {
  const status = createCaptureStatus({});
  try {
    const { req, res } = fakeRes();
    status.serve(req, res);
    status.set('failed');
    const frame = lastFrame(res);
    assert.deepEqual(Object.keys(frame).sort(), ['at', 'phase']);
    assert.equal(frame.phase, 'failed');
  } finally {
    status.dispose();
  }
});

test('状态广播：卡住的 working 不发给新页面（防进程崩溃留下永久转圈）', () => {
  let clock = 1000;
  const status = createCaptureStatus({ now: () => clock });
  try {
    status.set('working', { turns: 1 });
    const fresh = fakeRes();
    status.serve(fresh.req, fresh.res);
    assert.equal(lastFrame(fresh.res).phase, 'working');

    clock += 6 * 60_000;
    const later = fakeRes();
    status.serve(later.req, later.res);
    assert.equal(lastFrame(later.res).phase, 'idle', '超过 5 分钟按 idle');
  } finally {
    status.dispose();
  }
});

test('状态广播：只认 loopback，非 GET/HEAD 一律 405', () => {
  const status = createCaptureStatus({});
  try {
    const remote = fakeRes({ address: '192.168.1.20' });
    status.serve(remote.req, remote.res);
    assert.equal(remote.res.head.status, 403);
    assert.equal(status.listeners, 0);

    const post = fakeRes();
    post.req.method = 'POST';
    status.serve(post.req, post.res);
    assert.equal(post.res.head.status, 405);
    assert.equal(post.res.head.headers.allow, 'GET, HEAD');

    const head = fakeRes();
    head.req.method = 'HEAD';
    status.serve(head.req, head.res);
    assert.equal(head.res.head.status, 200);
    assert.equal(head.res.ended, true);
    assert.equal(status.listeners, 0, 'HEAD 不留长连接');
  } finally {
    status.dispose();
  }
});

test('状态广播：dispose 之后不再广播，也不抛', () => {
  const status = createCaptureStatus({});
  const { req, res } = fakeRes();
  status.serve(req, res);
  const before = res.frames.length;
  status.dispose();
  status.set('working', { turns: 1 });
  assert.equal(res.frames.length, before);
  assert.equal(status.phase, 'idle');
});

test('状态广播：终态广播完自动落回 idle，晚打开的页面不会再看见绿圈', async () => {
  const status = createCaptureStatus({ settleMs: 20 });
  try {
    const { req, res } = fakeRes();
    status.serve(req, res);
    status.set('success', { count: 1 });
    assert.equal(status.phase, 'success');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(status.phase, 'idle');
    assert.equal(lastFrame(res).phase, 'idle');

    // 落回 idle 之前又来一轮 working：旧的收尾定时器必须让路。
    status.set('success', { count: 2 });
    status.set('working', { turns: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(status.phase, 'working');
  } finally {
    status.dispose();
  }
});

test('路由路径与客户端约定一致', () => {
  assert.equal(STATUS_ROUTE, '/alice-memory-llm/status');
});

// ---------- 池事件 → 状态 ----------

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'alice-status-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCfg(dir) {
  return {
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
}

function writeSettings(dir) {
  writeFileSync(join(dir, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    magpie:',
    '      apiKeyEnv : MAGPIE_GATEWAY_KEY',
    '      baseURL : http://127.0.0.1:3425/v1',
    '      models:',
    '        - id : group/dsv41',
    '',
  ].join('\n'));
}

function mockFetch({ fail = false } = {}) {
  return async () => {
    if (fail) throw new Error('network down');
    const content = JSON.stringify({ items: [] });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(dir, fetchImpl) {
  const store = new Store({ dataDir: dir, dimensions: 8, model: 'fake', scopeId: 'default' });
  const index = new VectorIndex(8, { preferWorker: false });
  const embedder = new FakeEmbedder(8);
  const status = createCaptureStatus({});
  const pool = createCapturePool({
    store,
    index,
    embedder,
    cfg: makeCfg(dir),
    env: { MAGPIE_GATEWAY_KEY: 'k' },
    transport: fetchImpl,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    onEvent: (kind, payload) => {
      if (kind === 'start') status.set('working', { turns: payload?.turns ?? 0 });
      else if (kind === 'success') status.set('success', { count: payload?.count ?? 0 });
      else if (kind === 'failed') status.set('failed');
    },
  });
  ensureExtractionSchema(store);
  return {
    pool,
    status,
    cleanup: () => { status.dispose(); pool.dispose(); index.close(); store.close(); },
  };
}

test('池触发提炼时状态先 working 后 success', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const s = setup(dir, mockFetch());
    const { req, res } = fakeRes();
    try {
      s.pool.setSelection({ provider: 'magpie', model: 'group/dsv41' });
      s.status.serve(req, res);
      assert.equal(lastFrame(res).phase, 'idle');

      s.pool.beginTurn();
      s.pool.onMessage('user', '第一轮有内容的对话');
      s.pool.completeTurn();
      await wait(150);
      assert.ok(
        res.frames.some((chunk) => chunk.includes('"phase":"working"')),
        '开始提炼那一刻要推一帧 working，UI 才转得起来',
      );
      assert.equal(lastFrame(res).phase, 'success');
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('提炼失败时状态落到 failed，且不带错误原文', async () => {
  const { dir, cleanup } = tmp();
  try {
    writeSettings(dir);
    const s = setup(dir, mockFetch({ fail: true }));
    const { req, res } = fakeRes();
    try {
      s.pool.setSelection({ provider: 'magpie', model: 'group/dsv41' });
      s.status.serve(req, res);

      s.pool.beginTurn();
      s.pool.onMessage('user', '第一轮有内容的对话');
      s.pool.completeTurn();
      await wait(150);

      const frame = lastFrame(res);
      assert.equal(frame.phase, 'failed');
      assert.equal(frame.reason, undefined, '失败原因不上船，UI 也没地方放它');
    } finally {
      s.cleanup();
    }
  } finally {
    cleanup();
  }
});

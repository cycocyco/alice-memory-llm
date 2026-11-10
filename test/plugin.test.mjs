import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.mjs';
import { Store } from '../lib/store.mjs';

function makeCtx() {
  const hooks = {};
  const tools = {
    register(tool) {
      tools[tool.name] = tool;
    },
  };
  return {
    hooks,
    tools,
    on(event, fn) {
      (hooks[event] ??= []).push(fn);
    },
  };
}

/** 本机假网关：只认 /chat/completions，回一条固定的提炼结果 */
function startFakeGateway(items) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ items }) } }],
        usage: { completion_tokens: 42 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

test('plugin apply wires hooks and tools, extracts a batch on idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alice-plugin-'));
  const prevDir = process.env.ALICE_MEMORY_DATA_DIR;
  const prevHome = process.env.DSH_HOME;
  const prevKey = process.env.ALICE_MEMORY_API_KEY;
  const gateway = await startFakeGateway([{
    content: '决定：给项目 README 补上安装说明和隐私声明',
    type: 'decision',
    confidence: 0.9,
    source_turn_ids: [1],
  }]);

  process.env.ALICE_MEMORY_DATA_DIR = dir;
  // 断网：不给 embedding key，向量留 pending；提炼走本机假网关
  process.env.DSH_HOME = dir;
  process.env.ALICE_MEMORY_API_KEY = '';
  writeFileSync(join(dir, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    local:',
    '      apiKeyEnv : LOCAL_KEY',
    '      api : openai-completions',
    `      baseURL : http://127.0.0.1:${gateway.port}/v1`,
    '      models:',
    '        - id : fake/chat',
    '',
  ].join('\n'));
  writeFileSync(join(dir, '.env'), 'LOCAL_KEY=k\n');

  try {
    const ctx = makeCtx();
    apply(ctx, { log_level: 'error', capture: { idleMs: 30 } });

    assert.ok(ctx.hooks['agent/pre-step']?.length, 'pre-step hook registered');
    assert.ok(ctx.hooks['session/event']?.length, 'session hook registered');
    assert.ok(ctx.hooks.dispose?.length, 'dispose hook registered');
    for (const name of ['alice_memory_save', 'alice_memory_recall', 'alice_memory_forget', 'alice_memory_prune']) {
      assert.ok(ctx.tools[name], `${name} registered`);
    }

    // pre-step: 没命中也要原样放行，同时把主模型选择交给提炼层
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是一句没有记忆命中过的随机问题' }] }],
    };
    const out = await ctx.hooks['agent/pre-step'][0](
      { agent: { session: { id: 's1' } }, modelSelection: { provider: 'local', model: 'fake/chat' } },
      async () => decision,
    );
    assert.equal(out.kind, 'enter');
    assert.equal(out.messages.length, 1);

    // 一轮消息只入池；空闲 debounce 后才由 LLM 提炼落库
    const events = ctx.hooks['session/event'][0];
    events({ id: 's1' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个项目的 README 补上安装说明和隐私声明' }] },
    });
    events({ id: 's1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '好，先写安装再看隐私那节。' }] } },
    });
    events({ id: 's1' }, { type: 'turn/end', data: {} });

    await new Promise((r) => setTimeout(r, 400));

    assert.equal(gateway.calls.length, 1, '提炼请求真的发出了');
    assert.equal(gateway.calls[0].body.model, 'fake/chat');
    assert.equal(gateway.calls[0].url, '/v1/chat/completions');

    const store = new Store({ dataDir: dir, dimensions: 1024, model: 'BAAI/bge-m3', scopeId: 'default' });
    try {
      assert.equal(store.countAll(), 1);
      const row = store.exportAll()[0];
      assert.equal(row.memory_type, 'decision');
      assert.match(row.content, /README/);
      assert.equal(row.user_text, null, '不存原文');
      assert.equal(row.assistant_text, null, '不存原文');
      assert.equal(row.source, 'extracted');
      assert.equal(row.embedding_status, 'pending'); // 没 key，等 backfill
    } finally {
      store.close();
    }

    // 工具：回想 + 忘掉
    const recalled = await ctx.tools.alice_memory_recall.execute({ query: 'README 安装说明' });
    assert.equal(recalled.ok, true);

    const pruned = ctx.tools.alice_memory_prune.execute({ older_than_days: 30 });
    assert.equal(pruned.ok, true);
    assert.equal(pruned.preview, true);
    assert.equal(typeof pruned.token, 'string');

    await ctx.hooks.dispose[0]();
  } finally {
    if (prevDir === undefined) delete process.env.ALICE_MEMORY_DATA_DIR;
    else process.env.ALICE_MEMORY_DATA_DIR = prevDir;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevKey === undefined) delete process.env.ALICE_MEMORY_API_KEY;
    else process.env.ALICE_MEMORY_API_KEY = prevKey;
    gateway.server.close();
    await new Promise((r) => setTimeout(r, 100));
    // Windows 上临时目录偶尔报 EPERM（句柄释放比 unlink 慢一拍），两遍清 + 最终降级为警告
    for (let i = 0; i < 3; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (i === 2) console.warn(`temp dir left behind: ${dir} (${err.code})`);
        else await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
});
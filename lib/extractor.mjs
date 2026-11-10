// 提炼层：复用主对话模型（base_url / apiKey / model），独立请求，输出结构化条目数组。
// 零第三方依赖：宿主 settings.yaml 只用一个极简 YAML 子集解析器读。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvText } from './config.mjs';
import { createHttpTransport } from './http.mjs';

const TYPES = new Set(['preference', 'fact', 'decision', 'correction']);
const TIMEOUT_MS = 30000;
const TEMPERATURE = 0.2;
// 推理型模型会先烧 reasoning token，给够余量，别让正文被截成空串
const MAX_TOKENS = 2048;

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function unquote(value) {
  return String(value ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * 解析 $DSH_HOME/settings.yaml 里 llm-pi-ai.providers.<name> 的
 * apiKeyEnv / baseURL / api / models[].id。
 * 切块解析而不是按固定缩进：宿主重排缩进（2 或 4 空格）也认，块内出现
 * baseURL / apiKeyEnv / models 之一才算 provider，避免把 headers、compat 子对象认成 provider。
 */
export function readHostProviders(settingsPath) {
  const lines = String(readText(settingsPath)).split(/\r?\n/).map((raw) => raw.replace(/\s+#.*$/, ''));
  const start = lines.findIndex((line) => /^\s*providers\s*:/.test(line));
  if (start < 0) return {};

  const blocks = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    // 回到顶层键（缩进 0）就说明 providers 段结束了
    if (/^\S/.test(line) && !/^\s*-\s/.test(line)) break;
    const head = line.match(/^(\s{2,10})([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:\s*$/);
    if (head && (!current || head[1].length <= current.indent)) {
      current = { name: head[2], indent: head[1].length, body: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  const out = {};
  for (const block of blocks) {
    const body = block.body.join('\n');
    if (!/baseURL|apiKeyEnv|models/.test(body)) continue; // 子对象不是 provider
    const entry = { apiKeyEnv: '', baseURL: '', api: '', models: [] };
    for (const line of block.body) {
      const kv = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
      if (kv) {
        const [, key, value] = kv;
        if (key === 'apiKeyEnv') entry.apiKeyEnv = unquote(value);
        else if (key === 'baseURL') entry.baseURL = unquote(value);
        else if (key === 'api') entry.api = unquote(value);
        continue;
      }
      const modelId = line.match(/^\s*-\s*id\s*:\s*(.+?)\s*$/);
      if (modelId) entry.models.push(unquote(modelId[1]));
    }
    out[block.name] = entry;
  }
  return out;
}

function resolveApiKey(name, cfg, env) {
  if (!name) return '';
  if (env[name]) return String(env[name]);
  const envFile = parseEnvText(readText(cfg.files?.env ?? join(cfg.dshHome ?? '', '.env')));
  if (envFile[name]) return envFile[name];
  // 宿主把凭证引用平铺在 .credentials.yaml 的 refs: 段里
  const creds = readText(cfg.files?.credentials ?? join(cfg.dshHome ?? '', '.credentials.yaml'));
  const refsAt = creds.search(/^refs\s*:/m);
  if (refsAt >= 0) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = creds.slice(refsAt).match(new RegExp(`^\\s{2}${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
    if (hit) return unquote(hit[1]);
  }
  return '';
}

/**
 * provider 解析顺序：模型归属优先，其次主对话当前 provider，最后唯一 provider。
 * 每次 flush 都重新解析，settings.yaml 改了立刻生效，不缓存。
 * @param selection 主对话的 {provider, model}，来自 agent/pre-step 的 modelSelection
 */
export function resolveLlmConfig({ cfg, selection = null, env = process.env }) {
  const settings = cfg.files?.settings ?? join(cfg.dshHome ?? '', 'settings.yaml');
  const providers = readHostProviders(settings);
  const inherit = !cfg.capture?.model || cfg.capture.model === 'inherit';
  const names = Object.keys(providers);
  if (!names.length) return { ok: false, error: `宿主 LLM provider 未找到：${settings}` };

  const wantModel = String((inherit ? selection?.model : cfg.capture.model) ?? '');
  // ① 这个模型名属于哪个 provider：覆盖成别家模型时也能找到正确的网关和凭证
  const owner = wantModel
    ? names.find((name) => providers[name].models.includes(wantModel))
    : undefined;
  // ② 主对话当前的 provider
  const declared = selection?.provider && providers[selection.provider] ? selection.provider : undefined;
  // ③ 只有一个 provider 且拿不到主对话选择时，才用它兜底
  const only = !wantModel && !selection?.provider && names.length === 1 ? names[0] : undefined;

  const providerName = owner ?? declared ?? only;
  if (!providerName) {
    const why = selection?.provider
      ? `主对话 provider "${selection.provider}" 不在 ${settings} 的 llm-pi-ai.providers 里（内置账号登录的 provider 由宿主内部 catalog 描述，插件读不到它的 baseURL 和凭证）`
      : `拿不到主对话的 provider/model，也无法从 ${settings} 推断`;
    return { ok: false, error: `${why}；请把 capture.model 设成已配置 provider 下的模型名` };
  }

  const provider = providers[providerName];
  const model = wantModel || provider.models[0] || '';
  if (!provider.baseURL) return { ok: false, error: `provider ${providerName} 缺 baseURL` };
  if (!model) return { ok: false, error: '拿不到主对话 model，也无法从 provider 推断' };

  const apiKey = resolveApiKey(provider.apiKeyEnv, cfg, env);
  if (!apiKey) return { ok: false, error: `缺少凭证 ${provider.apiKeyEnv}` };
  return {
    ok: true,
    url: `${provider.baseURL.replace(/\/+$/, '')}/chat/completions`,
    apiKey,
    model,
    provider: providerName,
    api: provider.api,
  };
}

/** 三段式 prompt，明确分隔原文与已有记忆，避免 LLM 把参考块当新料提取 */
export function buildPrompt({ turns, existing = [] }) {
  const lines = turns.map(
    (t) => `turn ${t.turnId} [${t.role}]: ${String(t.text).replace(/\s+/g, ' ').trim()}`,
  );
  const known = existing.length ? existing.map((x) => `- ${x}`).join('\n') : '（暂无）';
  const user = [
    '【本次待提炼的对话原文】',
    lines.join('\n'),
    '',
    '【已有记忆（仅供参考，已覆盖的内容不要重复提取）】',
    known,
    '',
    '【禁止提取清单】',
    '- 寒暄、应答词（嗯/好的/收到/谢谢…）',
    '- 追问、指代型短句（「那这个呢」「上面那个」）',
    '- 纯问句本身',
    '- 一次性吐槽、情绪表达',
    '- 无独立信息量的内容',
    '- 助手自己的操作汇报与进度说明（「已改好了」「验过了」「跑了一遍测试」「清理了死代码」）',
    '- 助手对当前任务的技术解释、原理说明、方案对比',
    '- 只对本次任务有效的中间结论（「这次先这样」「本轮采用 A 方案」）',
    '',
    '【任务】',
    '从「对话原文」中提炼值得长期记住的内容，只认三类来源：',
    '1. 用户明确表达的偏好、习惯、好恶（「我以后都用 X」「我不喜欢 Y」）；',
    '2. 用户交代的长期事实（环境路径、账号、约定、禁止事项）；',
    '3. 双方明确拍板的决定与用户做出的纠错。',
    '把每条压缩为一句话，主语写成「用户」或「本项目」。',
    '助手说了什么不算记忆，除非用户当场确认采纳。',
    '已有记忆已覆盖的不要重复输出。',
    '没有值得记的内容时，输出空数组 []。禁止硬凑。',
    '',
    '只输出 JSON，不要解释。格式：',
    '{"items":[{"content":"一句话记忆","type":"preference|fact|decision|correction","confidence":0.0,"source_turn_ids":[3,7]}]}',
    '没有内容时输出 {"items":[]} 或直接 []。',
  ].join('\n');
  return [
    {
      role: 'system',
      content:
        '你是长期记忆提炼器。只依据【本次待提炼的对话原文】提取，【已有记忆】与【禁止提取清单】只是参考和约束，不是待提取内容。只输出 JSON。',
    },
    { role: 'user', content: user },
  ];
}

/**
 * 默认传输：原生 socket 直连（见 lib/http.mjs 的说明，不能用 globalThis.fetch）。
 */
async function doPost(connection, payload, transport, timeoutMs) {
  const res = await transport(connection.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (res.ok) return { ok: true, status: res.status, body: await res.text() };
  return { ok: false, status: res.status, detail: (await res.text().catch(() => '')).slice(0, 200) };
}

export async function callExtractor({
  connection, messages, transport = createHttpTransport({ timeoutMs: TIMEOUT_MS }), timeoutMs = TIMEOUT_MS,
}) {
  const payload = {
    model: connection.model,
    messages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
    response_format: { type: 'json_object' },
  };
  let res = await doPost(connection, payload, transport, timeoutMs);
  // 部分网关不认 json_object：去掉该字段再试一次，仍是同一批提炼
  if (!res.ok && res.status === 400 && /response_format|json_object/i.test(res.detail)) {
    const { response_format, ...plain } = payload;
    res = await doPost(connection, plain, transport, timeoutMs);
  }
  if (!res.ok) throw new Error(`extractor HTTP ${res.status}: ${res.detail}`);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`extractor response is not JSON: ${err?.message ?? err}`);
  }
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  // 推理型模型可能把正文写进 reasoning_content，content 留空
  const text = typeof message.content === 'string' && message.content.trim()
    ? message.content
    : typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : '';
  if (!text) {
    const usage = json?.usage ?? {};
    throw new Error(
      `extractor returned no content (finish_reason=${choice?.finish_reason ?? '-'}, `
      + `completion_tokens=${usage.completion_tokens ?? '-'})`,
    );
  }
  return parseItems(text);
}

/** 兼容顶层数组 [] 与对象包装 {"items":[...]}；空数组是合法输出 */
export function parseItems(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (err) {
    throw new Error(`extractor JSON parse failed: ${err?.message ?? err}`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.memories)
        ? parsed.memories
        : null;
  if (!arr) throw new Error('extractor output is not an item array');
  return arr
    .filter((x) => x && typeof x.content === 'string' && x.content.trim())
    .map((x) => ({
      content: x.content.trim(),
      type: TYPES.has(x.type) ? x.type : 'fact',
      confidence: Number.isFinite(Number(x.confidence))
        ? Math.min(1, Math.max(0, Number(x.confidence)))
        : 0,
      sourceTurnIds: Array.isArray(x.source_turn_ids)
        ? x.source_turn_ids.filter((n) => Number.isFinite(Number(n))).map(Number)
        : [],
    }));
}

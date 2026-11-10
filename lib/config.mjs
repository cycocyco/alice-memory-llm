// 配置解析：默认值 ← config.json ← config.local.json ← 插件配置(DSH) ← 环境变量
// 任何机器路径都靠运行时推导，源码里不出现绝对路径。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULTS = {
  data_dir: '', // 留空 → $DSH_HOME/alice-memory
  scope_id: 'default',
  api_key_env: 'SILICONFLOW_API_KEY',
  api_key: '',
  embedding: {
    url: 'https://api.siliconflow.cn/v1/embeddings',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
    timeout_ms: 3500,
    max_input_chars: 2000,
    batch: 16,
  },
  search: {
    query_prefix: 'task: question answering | query: ',
    doc_prefix: 'title: none | text: ',
    min_score: 0.5,
    vector_weight: 1.0,
    lexical_weight: 0.35,
    rrf_k: 60,
    candidate_multiplier: 4,
    cold_wake: true, // hot+warm 命中不足时，让 worker 扫全库补刀
    cold_scan_budget_ms: 900,
    cold_scan_cap: 200000,
  },
  recall: {
    enabled: true,
    limit: 3,
    timeout_ms: 6000,
    max_chars: 400,
    marker: '[memory]',
    instruction: '(请在对话中自然融入这些历史信息，无需刻意声明你在翻看记忆)',
    labels: { user: 'User', assistant: 'Assistant' },
  },
  capture: {
    enabled: true,
    idleMs: 300000,           // 空闲 debounce，默认 5 分钟
    model: 'inherit',         // 复用主对话模型；可填具体模型名覆盖
    maxDailyExtractions: 50, // 每日 LLM 提炼次数上限
    embed_retry_minutes: 5,  // 保留：补向量 backfill 定时器
  },
  memory: {
    // 分层容量是硬约束：热区参与每轮向量扫描，必须有上限
    hot_max: 3000,
    warm_max: 12000,
    // 半衰期（天）。0 表示不衰减
    half_life_days: 45,
    half_life: { task: 3, turn: 45, preference: 365, manual: 0 },
    hot_in: 0.6,
    hot_out: 0.4,
    warm_in: 0.3,
    warm_out: 0.15,
    reinforce_base: 1.0,
    reinforce_gain: 0.35,
    reinforce_cap: 3.0,
    sweep_hours: 6,
    archive_after_days: 0, // 0 = 永不归档
    prefer_worker: true,
  },
  redact: true,
  log_level: 'info',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, ...layers) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 极简 .env 解析，只为拿密钥；不写回环境变量表 */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in out)) out[key] = value;
  }
  return out;
}

export function readEnvFiles(home) {
  const out = {};
  for (const file of [join(home, '.env'), join(PLUGIN_DIR, '.env')]) {
    try {
      if (!existsSync(file)) continue;
      Object.assign(out, { ...parseEnvText(readFileSync(file, 'utf8')), ...out });
    } catch {
      // 读不到就当没有，最后会报缺密钥
    }
  }
  return out;
}

export function resolveDshHome(env = process.env) {
  if (env.DSH_HOME) return env.DSH_HOME;
  if (env.DSH_DATA_DIR) return env.DSH_DATA_DIR;
  const base = env.USERPROFILE || env.HOME || homedir();
  return join(base, '.dsh');
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @param {object} [pluginConfig] 从 cordis.patch.yml 传进来的配置
 * @param {object} [options] { env, now }
 */
export function loadConfig(pluginConfig = {}, options = {}) {
  const env = options.env ?? process.env;
  const home = resolveDshHome(env);
  const envFile = readEnvFiles(home);

  const explicit = env.ALICE_MEMORY_CONFIG ? resolve(env.ALICE_MEMORY_CONFIG) : '';
  const files = explicit
    ? [explicit]
    : [join(PLUGIN_DIR, 'config.json'), join(PLUGIN_DIR, 'config.local.json')];
  const fileLayers = files.map(readJsonIfExists).filter(Boolean);

  const merged = deepMerge(DEFAULTS, ...fileLayers, pluginConfig);

  // 环境变量覆盖（最高优先级）
  if (env.ALICE_MEMORY_DATA_DIR) merged.data_dir = env.ALICE_MEMORY_DATA_DIR;
  if (env.ALICE_MEMORY_SCOPE) merged.scope_id = env.ALICE_MEMORY_SCOPE;
  if (env.ALICE_MEMORY_LOG_LEVEL) merged.log_level = env.ALICE_MEMORY_LOG_LEVEL;
  if (env.ALICE_MEMORY_EMBEDDING_URL) merged.embedding.url = env.ALICE_MEMORY_EMBEDDING_URL;
  if (env.ALICE_MEMORY_MODEL) merged.embedding.model = env.ALICE_MEMORY_MODEL;
  if (env.ALICE_MEMORY_DIMENSIONS) merged.embedding.dimensions = num(env.ALICE_MEMORY_DIMENSIONS, 1024);
  if (env.ALICE_MEMORY_MIN_SCORE) merged.search.min_score = num(env.ALICE_MEMORY_MIN_SCORE, 0.5);
  if (env.ALICE_MEMORY_RECALL_LIMIT) merged.recall.limit = num(env.ALICE_MEMORY_RECALL_LIMIT, 3);

  const dataDir = merged.data_dir
    ? (isAbsolute(merged.data_dir) ? merged.data_dir : resolve(PLUGIN_DIR, merged.data_dir))
    : join(home, 'alice-memory');

  const cfg = {
    ...merged,
    dataDir,
    dshHome: home,
    // 单文件库：正文和向量同库，只有一个 sqlite 文件
    files: {
      db: join(dataDir, 'memories.sqlite3'),
      settings: join(home, 'settings.yaml'),
      env: join(home, '.env'),
      credentials: join(home, '.credentials.yaml'),
    },
    configSource: explicit || fileLayers.length ? files.filter(existsSync) : [],
  };

  // 数值兜底，防止配置文件手滑写出 NaN
  cfg.embedding.dimensions = Math.max(64, Math.round(num(cfg.embedding.dimensions, 1024)));
  cfg.embedding.timeout_ms = Math.max(500, Math.round(num(cfg.embedding.timeout_ms, 3500)));
  cfg.embedding.batch = Math.max(1, Math.round(num(cfg.embedding.batch, 16)));
  cfg.search.min_score = Math.min(1, Math.max(-1, num(cfg.search.min_score, 0.5)));
  cfg.recall.limit = Math.max(1, Math.round(num(cfg.recall.limit, 3)));
  cfg.recall.timeout_ms = Math.max(500, Math.round(num(cfg.recall.timeout_ms, 6000)));
  cfg.memory.hot_max = Math.max(0, Math.round(num(cfg.memory.hot_max, 3000)));
  cfg.memory.warm_max = Math.max(0, Math.round(num(cfg.memory.warm_max, 12000)));
  cfg.capture.idleMs = Math.max(1, Math.round(num(cfg.capture.idleMs, 300000)));
  cfg.capture.maxDailyExtractions = Math.max(1, Math.round(num(cfg.capture.maxDailyExtractions, 50)));

  // 密钥：环境变量 > .env > 配置文件明文（不推荐）
  const keyName = cfg.api_key_env || 'SILICONFLOW_API_KEY';
  cfg.embedding.apiKey = env[keyName] || envFile[keyName] || (cfg.api_key ? String(cfg.api_key) : '');

  return cfg;
}

/** 给 CLI 用：没有密钥时提前说清楚，而不是等 HTTP 401 */
export function describeConfig(cfg) {
  return {
    dataDir: cfg.dataDir,
    scopeId: cfg.scope_id,
    model: `${cfg.embedding.model} (${cfg.embedding.dimensions}d)`,
    apiKey: cfg.embedding.apiKey ? `set (${cfg.embedding.apiKey.length} chars via ${cfg.api_key_env})` : 'MISSING',
    configSource: cfg.configSource,
  };
}

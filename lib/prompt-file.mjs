// 提炼 prompt 的外部文件加载器。
//
// 为什么不在代码里写死：改一个词就要重启后端，实测很痛。现在 prompt 放在
// prompts/extract.md，按 mtime 做缓存——文件一改，下一次提炼立刻生效，不用重启。
//
// 文件格式（分段标记，纯文本，人直接改）：
//   === system ===
//   系统提示词
//   === user ===
//   用户提示词，用 {{turns}} 占位对话原文
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_PROMPT_PATH = join(PLUGIN_ROOT, 'prompts', 'extract.md');

// path -> { mtimeMs, value }
const cache = new Map();

/** 把分段文本解析成 { system, user } */
export function parsePromptText(raw) {
  const sections = {};
  let current = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const m = /^===\s*([a-zA-Z]+)\s*===$/.exec(line.trim());
    if (m) {
      current = m[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const out = {};
  for (const [k, v] of Object.entries(sections)) {
    const text = v.join('\n').trim();
    if (text) out[k] = text;
  }
  return out;
}

/** 解析应用配置里的路径：相对路径按插件根目录算 */
export function resolvePromptPath(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) return DEFAULT_PROMPT_PATH;
  return isAbsolute(value) ? value : join(PLUGIN_ROOT, value);
}

/**
 * 读 prompt 文件，按 mtime 缓存。文件缺失或格式不对时返回 null，由调用方回落到内置默认。
 * 注意：这里只做 stat + 读文件，开销是微秒级，远小于一次模型调用。
 */
export function loadPromptTemplate(path, { logger = null } = {}) {
  if (!path) return null;
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
    const parsed = parsePromptText(readFileSync(path, 'utf8'));
    if (!parsed.system || !parsed.user) {
      logger?.warn?.(`prompt 文件缺少 system 或 user 段：${path}`);
      return null;
    }
    if (!parsed.user.includes('{{turns}}')) {
      logger?.warn?.(`prompt 文件没有 {{turns}} 占位符，原文会被丢掉：${path}`);
    }
    cache.set(path, { mtimeMs: st.mtimeMs, value: parsed });
    logger?.info?.(`提炼 prompt 已从文件加载：${path}`);
    return parsed;
  } catch (err) {
    if (err?.code !== 'ENOENT') logger?.warn?.(`prompt 文件读取失败（${path}）：${err?.message ?? err}`);
    return null;
  }
}

/** 测试用：清缓存 */
export function clearPromptCache() {
  cache.clear();
}

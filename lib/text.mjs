// 文本工具：消息抽取、规范化、截断、查询分词、本地日期
import { createHash } from 'node:crypto';

/** 从 DSH 的消息 content（字符串或 block 数组）里取纯文本 */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

/** 折叠空白：连续空行压成一个，行尾去空格。用于去重与入库 */
export function collapse(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 查询分词：按空白/标点切，保留 >=2 字的片段，最多 8 个。
 * 中文没有空格，整句也作为一个片段保留，供 FTS 短语匹配。
 */
export function queryTerms(query, max = 8) {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\s,，。.;；:：!！?？、/\\|()[\]{}"'`~@#$%^&*+=<>—_-]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const out = [];
  for (const p of parts) {
    if (p.length <= 40 && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD。日配额按本地日期切，不用 UTC */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localDayStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

export function isoNow(date = new Date()) {
  return date.toISOString();
}

/** 两个 ISO 时间之间隔了几天（可带小数） */
export function daysBetween(fromIso, toMs = Date.now()) {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (toMs - from) / 86_400_000);
}

/** 摘要用：把一行压到 n 字以内，不破坏 UTF-16 代理对 */
export function brief(text, n = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${Array.from(s).slice(0, n).join('')}…`;
}

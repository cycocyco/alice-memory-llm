// 提炼结果的落库：只存一句话条目，不存原文；单事务写条目 + 推进游标 + 记一次提炼。
import { collapse, localDate } from './text.mjs';
import { redact } from './redact.mjs';

const CURSOR_KEY = 'last_processed_turn_id';
const countKey = (day) => `extract_count:${day}`;

// 提炼管线的可观测计数：都写 meta 表（重启不清零，CLI 与 tidy stats 直接读）
export const STAT_KEYS = {
  lastMs: 'extract_last_ms',
  lastItems: 'extract_last_items',
  lastDropped: 'dedup_dropped_last',
  totalDropped: 'dedup_dropped_total',
  lastSimilar: 'dedup_similar_last',
  lastSuperseded: 'supersede_last',
  totalSuperseded: 'supersede_total',
  lastFailed: 'extract_failed_last',
  totalFailed: 'extract_failed_total',
  lastAt: 'extract_last_at',
  backlogDropped: 'backlog_dropped_total',
};

export function statOf(store, key) {
  return Math.max(0, Math.round(Number(store.meta(key)) || 0)) || 0;
}

export function bumpStat(store, key, delta = 1, mode = 'add') {
  const base = mode === 'set' ? 0 : statOf(store, key);
  const next = Math.max(0, Math.round(base + Number(delta) || 0));
  store.setMeta(key, String(next));
  return next;
}

/** 幂等加列：老库直接 ALTER，新库建出来已带上（store.mjs 的 DDL 未改） */
export function ensureExtractionSchema(store) {
  const cols = new Set(
    store.db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name),
  );
  if (!cols.has('memory_type')) store.db.exec('ALTER TABLE memories ADD COLUMN memory_type TEXT');
  if (!cols.has('extract_meta')) store.db.exec('ALTER TABLE memories ADD COLUMN extract_meta TEXT');
  // 软覆盖：被取代的条目指向新条目，召回时按它过滤；正文不删，可回滚
  if (!cols.has('superseded_by')) store.db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT');
}

export function cursor(store) {
  return Math.max(0, Math.round(Number(store.meta(CURSOR_KEY)) || 0));
}

export function dailyExtractions(store, day) {
  return Math.max(0, Math.round(Number(store.meta(countKey(day))) || 0));
}

/**
 * 失败路径的计数：LLM 报错/超时/解析失败也算一次提炼尝试。
 * 否则「每日提炼次数上限」只约束成功次数，解析一直失败就会每 5 分钟重试到天亮。
 */
export function bumpExtractionCount({ store, day = localDate() }) {
  const next = dailyExtractions(store, day) + 1;
  store.setMeta(countKey(day), String(next));
  return next;
}

/**
 * 单事务：插入本批全部条目（sha256 完全一致则跳过）+ 软覆盖旧条目 + 推进游标 + 计一次提炼。
 * 任何失败都回滚，游标不动，等下次空闲重提。
 */
export function commitExtraction({
  store, items, maxTurnId, day = localDate(), memoryCfg = {}, scopeId, dropped = 0, elapsedMs = 0,
}) {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = [];
    const deduped = [];
    const superseded = [];
    for (const item of items) {
      const content = redact(collapse(item.content)).text.trim();
      if (!content) continue;
      // 沿用 store.mjs 的 ON CONFLICT(content_sha256) DO NOTHING，重复只回原 id
      const { id, inserted: fresh } = store.insertMemory({
        content,
        kind: 'turn',
        userText: null,
        assistantText: null,
        source: 'extracted',
        scopeId: scopeId ?? store.scopeId,
        memoryCfg,
        embeddingStatus: 'pending',
      });
      if (!fresh) {
        deduped.push(id);
        continue;
      }
      db.prepare('UPDATE memories SET memory_type = ?, extract_meta = ? WHERE id = ?').run(
        item.type,
        JSON.stringify({ confidence: item.confidence, source_turn_ids: item.sourceTurnIds }),
        id,
      );
      // 软覆盖：只在旧条目还没有被覆盖过时生效，避免链式改写把历史搅乱
      if (item.supersedeId && item.supersedeId !== id) {
        const res = db
          .prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL')
          .run(id, item.supersedeId);
        if (Number(res?.changes) > 0) superseded.push(item.supersedeId);
      }
      inserted.push(id);
    }
    store.setMeta(CURSOR_KEY, String(maxTurnId));
    store.setMeta(countKey(day), String(dailyExtractions(store, day) + 1));
    store.setMeta(STAT_KEYS.lastItems, String(inserted.length));
    store.setMeta(STAT_KEYS.lastDropped, String(dropped));
    store.setMeta(STAT_KEYS.lastSuperseded, String(superseded.length));
    store.setMeta(STAT_KEYS.lastMs, String(Math.max(0, Math.round(elapsedMs))));
    store.setMeta(STAT_KEYS.lastAt, new Date().toISOString());
    if (dropped) bumpStat(store, STAT_KEYS.totalDropped, dropped);
    if (superseded.length) bumpStat(store, STAT_KEYS.totalSuperseded, superseded.length);
    db.exec('COMMIT');
    return { inserted, deduped, superseded, cursor: maxTurnId };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

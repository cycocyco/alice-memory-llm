// 提炼结果的落库：只存一句话条目，不存原文；单事务写条目 + 推进游标 + 记一次提炼。
import { collapse, localDate } from './text.mjs';
import { redact } from './redact.mjs';

const CURSOR_KEY = 'last_processed_turn_id';
const countKey = (day) => `extract_count:${day}`;

/** 幂等加列：老库直接 ALTER，新库建出来已带上（store.mjs 的 DDL 未改） */
export function ensureExtractionSchema(store) {
  const cols = new Set(
    store.db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name),
  );
  if (!cols.has('memory_type')) store.db.exec('ALTER TABLE memories ADD COLUMN memory_type TEXT');
  if (!cols.has('extract_meta')) store.db.exec('ALTER TABLE memories ADD COLUMN extract_meta TEXT');
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
 * 单事务：插入本批全部条目（sha256 完全一致则跳过）+ 推进游标 + 计一次提炼。
 * 任何失败都回滚，游标不动，等下次空闲重提。
 */
export function commitExtraction({
  store, items, maxTurnId, day = localDate(), memoryCfg = {}, scopeId,
}) {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = [];
    const deduped = [];
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
      inserted.push(id);
    }
    store.setMeta(CURSOR_KEY, String(maxTurnId));
    store.setMeta(countKey(day), String(dailyExtractions(store, day) + 1));
    db.exec('COMMIT');
    return { inserted, deduped, cursor: maxTurnId };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

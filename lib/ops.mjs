// 显式操作：记一条 / 忘掉 / 清理冷记忆。
import { collapse, sha256, brief } from './text.mjs';
import { redact } from './redact.mjs';
import { embedRows } from './capture.mjs';

/** 用户点名「记一下」 */
export async function remember({ store, index, embedder, cfg, logger, text, title = '' }) {
  const body = collapse(text ?? '');
  if (!body) return { ok: false, error: 'text 不能为空' };

  const safe = redact(title ? `${collapse(title)}\n${body}` : body);
  const content = safe.text;
  const { id, inserted } = store.insertMemory({
    kind: 'note',
    userText: content,
    assistantText: null,
    content,
    scopeId: cfg.scope_id,
    source: 'manual',
    importance: 1.5,
    pinned: true,
    memoryCfg: cfg.memory ?? {},
    embeddingStatus: 'pending',
  });

  if (!inserted) return { ok: true, id, deduped: true, vector: false, summary: brief(content, 40) };

  const out = await embedRows({ store, index, embedder, cfg, logger, rows: [store.getMemory(id)] });
  return { ok: true, id, deduped: false, vector: out.ok > 0, summary: brief(content, 40) };
}

/** 按 id 或关键词删，正文和向量一起清 */
export function forget({ store, index, cfg, id = '', query = '' }) {
  const ids = [];
  if (id) {
    if (store.getMemory(id)) ids.push(id);
  } else if (query) {
    const needle = collapse(query);
    if (needle.length < 2) return { ok: false, error: '关键词至少两个字' };
    for (const row of store.findBySubstring(needle, 50)) {
      if (row.content.includes(needle)) ids.push(row.id);
    }
  }
  if (!ids.length) return { ok: true, removed: 0, events: [] };

  const events = [];
  for (const target of ids) {
    const row = store.getMemory(target);
    if (!row) continue;
    store.deleteMemory(target);
    index.delete(target);
    events.push({ id: target, content: brief(row.content, 60) });
  }
  void cfg;
  return { ok: true, removed: events.length, events };
}

function pruneToken(cutoff, total, bytes, scopeId) {
  return sha256(`${cutoff}|${total}|${bytes}|${scopeId}`).slice(0, 10);
}

/** 预览：默认动作，只列候选不动手 */
export function prunePreview({ store, cfg, olderThanDays = 90, limit = 20 }) {
  const cand = store.pruneCandidates({ olderThanDays, limit, preview: true });
  return {
    ok: true,
    total: cand.total,
    bytes: cand.bytes,
    olderThanDays,
    cutoff: cand.cutoff,
    token: pruneToken(cand.cutoff, cand.total, cand.bytes, cfg.scope_id),
    samples: cand.rows.map((row) => ({
      id: row.id,
      date: row.local_date,
      content: brief(row.content, 80),
      lastAccessAt: row.last_access_at ?? null,
    })),
  };
}

/** 真删：token 对得上才动手，force 才跳过 */
export function pruneApply({ store, index, cfg, olderThanDays = 90, token = '', force = false, limit = 2000 }) {
  const cand = store.pruneCandidates({ olderThanDays, limit: 20, preview: false });
  const expected = pruneToken(cand.cutoff, cand.total, cand.bytes, cfg.scope_id);
  if (!force && token !== expected) {
    return {
      ok: false,
      error: 'token mismatch — 先预览再删，或显式 force',
      expected,
      total: cand.total,
    };
  }
  if (!cand.total) return { ok: true, removed: 0, bytes: 0 };

  const { removed, ids } = store.pruneApply({ olderThanDays, limit });
  for (const id of ids) index.delete(id);
  return { ok: true, removed, bytesFreed: cand.bytes };
}

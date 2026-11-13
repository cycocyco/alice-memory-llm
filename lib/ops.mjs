// 显式操作：记一条 / 翻条目 / 忘掉 / 合并 / 清理冷记忆。
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

/**
 * 翻条目。整理记忆库时用它替代「把全库塞进上下文」——窗口化、可筛。
 */
export function listEntries({
  store, since = '', until = '', tier = '', keyword = '', sessionId = '',
  limit = 50, offset = 0, order = 'asc',
} = {}) {
  const cap = Math.min(Math.max(1, Number(limit) || 50), 200);
  const { rows, total } = store.listRows({
    since, until, tier, keyword, sessionId, limit: cap, offset, order,
  });
  return {
    ok: true,
    total,
    count: rows.length,
    offset: Math.max(0, Number(offset) || 0),
    hasMore: Math.max(0, Number(offset) || 0) + rows.length < total,
    items: rows.map((r) => ({
      id: r.id,
      date: r.local_date,
      kind: r.kind,
      source: r.source,
      tier: r.tier,
      pinned: Number(r.pinned) === 1,
      chars: (r.content ?? '').length,
      session: r.session_id ?? null,
      content: brief(r.content, 120),
    })),
  };
}

/** 按 id 或关键词删，正文和向量一起清 */
export function forget({ store, index, cfg, id = '', query = '', ids = [], confirm = false }) {
  // 批量 id 优先：整理场景下这是唯一精确的删法
  if (Array.isArray(ids) && ids.length) {
    const out = forgetMany({ store, index, ids });
    return { ...out, events: out.events };
  }
  const targets = [];
  if (id) {
    if (store.getMemory(id)) targets.push(id);
  } else if (query) {
    const needle = collapse(query);
    if (needle.length < 2) return { ok: false, error: '关键词至少两个字' };
    for (const row of store.findBySubstring(needle, 50)) {
      if (row.content.includes(needle)) targets.push(row.id);
    }
    // 关键词是模糊匹配，命中即删太危险（整理时最容易带走该留的那条）。
    // 没带 confirm 就先只报清单，让人/模型看清再动手。
    if (!confirm) {
      return {
        ok: true,
        removed: 0,
        pendingConfirm: true,
        events: targets.map((t) => {
          const row = store.getMemory(t);
          return { id: t, content: row ? brief(row.content, 80) : '' };
        }),
        error: targets.length
          ? `关键词命中 ${targets.length} 条，未删除。确认要删请带 confirm`
          : undefined,
      };
    }
  }
  if (!targets.length) return { ok: true, removed: 0, events: [] };

  const out = forgetMany({ store, index, ids: targets });
  void cfg;
  return out;
}

/**
 * 按 id 批量删。一条事务，正文 + 向量 + 墓碑一起走。
 * 与逐条 forget 的差别：中途炸了不留半截状态。
 */
export function forgetMany({ store, index, ids = [], limit = 500 }) {
  const uniq = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))].slice(0, limit);
  if (!uniq.length) return { ok: true, removed: 0, events: [] };

  const events = [];
  for (const target of uniq) {
    const row = store.getMemory(target);
    if (!row) continue;
    // deleteMemory 自带事务边界外的单条语义，这里靠外层 BEGIN 包成一批
    events.push({ id: target, content: brief(row.content, 80), date: row.local_date });
  }
  if (!events.length) return { ok: true, removed: 0, events: [] };

  let removed = 0;
  store.mem.exec('BEGIN');
  try {
    for (const e of events) {
      if (store.deleteMemory(e.id)) {
        index.delete(e.id);
        removed += 1;
      }
    }
    store.mem.exec('COMMIT');
  } catch (err) {
    try { store.mem.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return { ok: true, removed, events };
}

/**
 * 合并：新写一条总结，再删掉全部源条目。
 * 时间戳、向量、sha 全是新的，diff 账目最干净；源条目进墓碑，不会被重新捕捉复活。
 */
export async function mergeMemories({
  store, index, embedder, cfg, logger, ids = [], content = '', title = '', dryRun = false,
}) {
  const uniq = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))];
  if (uniq.length < 2) return { ok: false, error: '合并至少需要两条来源' };

  const body = collapse(content ?? '');
  if (!body && !dryRun) return { ok: false, error: 'content 不能为空' };

  const rows = uniq.map((id) => store.getMemory(id)).filter(Boolean);
  if (rows.length < 2) return { ok: false, error: `只有 ${rows.length} 条真实存在，不足以合并` };

  const sources = rows.map((r) => ({
    id: r.id,
    date: r.local_date,
    content: brief(r.content, 100),
    chars: (r.content ?? '').length,
  }));

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      sources,
      removed: 0,
      summary: brief(body, 60),
      preview: `将合并 ${rows.length} 条 → 新写 1 条，删掉全部源条目`,
    };
  }

  const safe = redact(title ? `${collapse(title)}\n${body}` : body);
  const text = safe.text;

  // 先写新的：写失败就整件事没发生，源条目一条没动
  const { id, inserted } = store.insertMemory({
    kind: 'note',
    userText: text,
    assistantText: null,
    content: text,
    scopeId: cfg.scope_id,
    source: 'merge',
    importance: Math.max(1.5, ...rows.map((r) => Number(r.importance ?? 1))),
    pinned: true,
    memoryCfg: cfg.memory ?? {},
    embeddingStatus: 'pending',
  });

  const { removed, events } = forgetMany({ store, index, ids: uniq });

  let vector = false;
  if (inserted) {
    const out = await embedRows({ store, index, embedder, cfg, logger, rows: [store.getMemory(id)] });
    vector = out.ok > 0;
  }
  return {
    ok: true,
    dryRun: false,
    id,
    deduped: !inserted,
    merged: removed,
    removed,
    vector,
    sources,
    events,
    summary: brief(text, 60),
  };
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

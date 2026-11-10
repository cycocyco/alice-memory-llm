// 混合检索：热区向量（内存/worker）+ FTS5 + 冷层补刀，RRF 融合。
import { queryTerms, brief, daysBetween } from './text.mjs';
import { effectiveHeat } from './heat.mjs';
import { normalizeInPlace } from './store.mjs';

/**
 * @returns {Promise<{items: Array, timings: object, notes: string[]}>}
 */
export async function hybridSearch({
  store,
  index,
  embedder,
  cfg,
  query,
  limit = 3,
  excludeIds = new Set(),
  forceCold = false,
}) {
  const timings = { embed: 0, hot: 0, fts: 0, cold: 0, total: 0 };
  const notes = [];
  const started = Date.now();
  const terms = queryTerms(query);
  const cand = Math.max(limit * (cfg.search.candidate_multiplier ?? 4), 8);

  // 1) 查询向量
  let qvec = null;
  if (embedder?.ready !== false) {
    const t = Date.now();
    const res = await embedder.embedQuery(query);
    timings.embed = Date.now() - t;
    if (res.ok && res.vectors?.[0]) {
      qvec = res.vectors[0];
      normalizeInPlace(qvec);
    } else if (!res.ok) {
      notes.push(`embedding unavailable: ${res.error}`);
    }
  }

  // 2) 热区扫描
  let vecHits = [];
  if (qvec) {
    const t = Date.now();
    vecHits = await index.search(qvec, cand, { minScore: -1 });
    timings.hot = Date.now() - t;
    const minScore = Number(cfg.search.min_score ?? 0.5);
    vecHits = vecHits.filter((h) => h.score >= minScore);
  }

  // 3) 全文（便宜，永远跑）
  const tFts = Date.now();
  const lexHits = [...store.searchFts(terms, cand * 2), ...store.searchLike(terms, cand)];
  timings.fts = Date.now() - tFts;

  // 4) 冷层补刀：热区命中不够、或调用方点名要
  let coldHits = [];
  const coldAllowed = cfg.search.cold_wake !== false;
  const needCold = qvec && coldAllowed && (forceCold || vecHits.length < limit);
  if (needCold) {
    const t = Date.now();
    const hits = await index.scanCold({
      q: qvec,
      k: limit * 2,
      dbPath: cfg.files.db ?? store.dbPath,
      budgetMs: cfg.search.cold_scan_budget_ms ?? 900,
      cap: cfg.search.cold_scan_cap ?? 200000,
    });
    timings.cold = Date.now() - t;
    if (hits) {
      const minScore = Number(cfg.search.min_score ?? 0.5);
      coldHits = hits.filter((h) => h.score >= minScore);
    } else {
      notes.push('cold scan skipped (worker unavailable)');
    }
  }

  // 5) RRF 融合
  const fused = new Map();
  const bump = (id, weight, rank, via, cosine) => {
    const entry = fused.get(id) ?? { id, score: 0, cosine: -1, via: new Set() };
    entry.score += weight / ((cfg.search.rrf_k ?? 60) + rank + 1);
    entry.via.add(via);
    if (cosine !== undefined && cosine > entry.cosine) entry.cosine = cosine;
    fused.set(id, entry);
  };
  vecHits.forEach((h, i) => bump(h.id, cfg.search.vector_weight ?? 1, i, 'vector', h.score));
  coldHits.forEach((h, i) => bump(h.id, (cfg.search.vector_weight ?? 1) * 0.8, i, 'cold', h.score));
  lexHits.forEach((h, i) => bump(h.id, cfg.search.lexical_weight ?? 0.35, i, 'lexical'));

  const ranked = [...fused.values()]
    .filter((e) => !excludeIds.has(e.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const rows = store.rowsByIds(ranked.map((e) => e.id));
  const now = Date.now();
  const items = [];
  for (const entry of ranked) {
    const row = rows.get(entry.id);
    if (!row) continue;
    items.push({
      id: row.id,
      occurredAt: row.occurred_at,
      localDate: row.local_date,
      kind: row.kind,
      userText: row.user_text ?? '',
      assistantText: row.assistant_text ?? '',
      content: row.content,
      tier: row.tier,
      heat: Number(effectiveHeat(row, now).toFixed(3)),
      ageDays: Math.round(daysBetween(row.occurred_at, now)),
      score: Number(entry.score.toFixed(4)),
      cosine: entry.cosine >= 0 ? Number(entry.cosine.toFixed(4)) : null,
      via: [...entry.via].join('+'),
    });
  }

  timings.total = Date.now() - started;
  return { items, timings, notes };
}

/** 把命中结果拼成注入上下文的一段话 */
export function formatContext(items, cfg) {
  const labels = cfg.recall.labels ?? { user: 'User', assistant: 'Assistant' };
  const maxChars = cfg.recall.max_chars ?? 400;
  return items
    .map((item) => {
      const when = item.localDate || item.occurredAt?.slice(0, 10) || '';
      const head = `- [${when}] ${brief(item.userText || item.content, Math.floor(maxChars / 3))}`;
      const tail = item.assistantText
        ? `\n  ${labels.assistant}: ${brief(item.assistantText, Math.floor((maxChars * 2) / 3))}`
        : '';
      return `${head}${tail}`;
    })
    .join('\n');
}

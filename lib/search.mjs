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

  const now = Date.now();
  const candidates = [...fused.values()].filter((e) => !excludeIds.has(e.id));
  const rows = store.rowsByIds(candidates.map((e) => e.id));

  // 6) 热度与置顶微调：RRF 相邻名次差约 1.6%，乘数控制在 1%~2%，只在相关性打平时起作用
  for (const entry of candidates) {
    const row = rows.get(entry.id);
    if (!row) continue;
    const heat = effectiveHeat(row, now);
    const heatBoost = 1 + 0.015 * Math.min(1, heat / 3);
    const pinBoost = row.pinned ? 1.02 : 1;
    entry.score *= heatBoost * pinBoost;
    entry._heat = heat;
  }
  candidates.sort((a, b) => b.score - a.score);

  // 7) MMR 话题去重：避免同一件事占满所有召回坑位
  const mmrThreshold = cfg.search.mmr_threshold ?? 0.85;
  const ranked = [];
  const skipped = [];
  const selectedVecs = [];
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
    return s;
  };

  for (const entry of candidates) {
    if (ranked.length >= limit) break;
    const vec = typeof index?.get === 'function' ? index.get(entry.id) : null;
    if (vec && selectedVecs.some((sv) => dot(vec, sv) > mmrThreshold)) {
      skipped.push(entry);
      continue;
    }
    ranked.push(entry);
    if (vec) selectedVecs.push(vec);
  }
  for (const entry of skipped) {
    if (ranked.length >= limit) break;
    ranked.push(entry);
  }

  const items = [];
  for (const entry of ranked) {
    const row = rows.get(entry.id);
    if (!row) continue;
    const heat = entry._heat ?? effectiveHeat(row, now);
    items.push({
      id: row.id,
      occurredAt: row.occurred_at,
      localDate: row.local_date,
      kind: row.kind,
      userText: row.user_text ?? '',
      assistantText: row.assistant_text ?? '',
      content: row.content,
      tier: row.tier,
      heat: Number(heat.toFixed(3)),
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

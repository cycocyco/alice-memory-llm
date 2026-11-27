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

  // 1) 查询向量：给它一个硬预算。召回是用户正等着的操作，宁可早放手走关键词，
  //    也不让跨境请求干等——实测本地全文检索只要 0~1ms，而嵌入要 400ms~5.5s。
  let qvec = null;
  if (embedder?.ready !== false) {
    const t = Date.now();
    const budget = Number(cfg.search.vector_budget_ms ?? 10000);
    // 跨境 embedding 的耗时基本线性于输入长度：整段用户消息里混着长粘贴和代码块，
    // 全塞进去既慢又糊。骨架化 + 截断，只留指令部分（见 buildQueryText）。
    const queryText = buildQueryText(query, Number(cfg.search.query_max_chars ?? 400));
    const res = await embedder.embedQuery(queryText, { timeoutMs: budget, attempts: 1 });
    timings.embed = Date.now() - t;
    if (res.ok && res.vectors?.[0]) {
      qvec = res.vectors[0];
      normalizeInPlace(qvec);
    } else if (!res.ok) {
      // 超时或失败：直接降级为关键词检索，不发第二次请求
      notes.push(`vector skipped in ${timings.embed}ms: ${res.error}`);
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

  // 3) 全文：实测 0~1ms，比嵌入便宜三个数量级，所以默认始终跑——它兜住向量
  //    漏掉的精确词（路径、GOPATH 这类术语）。想彻底串行化就关掉 lexical_always。
  let lexHits = [];
  if (qvec || cfg.search.lexical_always !== false) {
    const tFts = Date.now();
    lexHits = [...store.searchFts(terms, cand * 2), ...store.searchLike(terms, cand)];
    timings.fts = Date.now() - tFts;
  }

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
  const allCandidates = [...fused.values()].filter((e) => !excludeIds.has(e.id));
  const rows = store.rowsByIds(allCandidates.map((e) => e.id));
  // 被软覆盖的旧条目不再参与召回：它的向量还在索引里，若不过滤，MMR 会拿它的
  // 向量把刚覆盖它的新条目挤掉（话题去重是比向量，不是比正文）
  const candidates = allCandidates.filter((e) => {
    const row = rows.get(e.id);
    return row && !row.superseded_by;
  });

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
  return {
    items,
    timings,
    notes,
    counts: {
      vector: vecHits.length,
      lexical: lexHits.length,
      cold: coldHits.length,
      candidates: candidates.length,
    },
  };
}

/**
 * 查询骨架化：去掉代码块与反引号片段、压平空白，再按字符上限截断。
 * 用户消息通常是「指令 + 长粘贴」，指令在前面，所以从头截最保语义；
 * 只在标点处收刀，避免把一句话腰斩成半截词喂给 embedding。
 */
export function buildQueryText(query, maxChars = 400) {
  const text = String(query ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = Math.max(32, Number(maxChars) || 400);
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const marks = ['。', '？', '！', '；', '. ', '? ', '! ', '\n'];
  let cut = -1;
  for (const m of marks) cut = Math.max(cut, head.lastIndexOf(m));
  return cut > cap * 0.5 ? head.slice(0, cut + 1).trim() : head;
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

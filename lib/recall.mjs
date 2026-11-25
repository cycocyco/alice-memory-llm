// 召回编排：检索 → 超时降级 → 只强化真正注入的条目 → 拼上下文。
import { hybridSearch, formatContext } from './search.mjs';
import { queryTerms } from './text.mjs';

/** 检索失败或超时时的兜底：只走全文，不碰向量 */
export function lexicalFallback({ store, cfg, query, limit }) {
  const terms = queryTerms(query);
  const hits = [...store.searchFts(terms, limit * 2), ...store.searchLike(terms, limit)];
  const ids = [];
  for (const hit of hits) if (!ids.includes(hit.id)) ids.push(hit.id);
  const rows = store.rowsByIds(ids.slice(0, limit));
  return ids
    .slice(0, limit)
    .map((id) => rows.get(id))
    .filter(Boolean)
    .map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      localDate: row.local_date,
      userText: row.user_text ?? '',
      assistantText: row.assistant_text ?? '',
      content: row.content,
      tier: row.tier,
      score: 0,
      cosine: null,
      via: 'lexical',
    }));
}

/**
 * 一次召回。超时（默认 3000ms）就退回全文检索，绝不拖住这一轮。
 */
export async function recallForPrompt({
  store, index, embedder, cfg, logger,
  query, limit = cfg.recall?.limit ?? 3, excludeIds = new Set(), forceCold = false,
  // null = 走配置里的 reinforce_gain；0 = 完全不强化（自动注入路径用这个）
  reinforceGain = null,
}) {
  const budget = Number(cfg.recall?.timeout_ms ?? 3000);
  const started = Date.now();

  let timedOut = false;
  const work = hybridSearch({ store, index, embedder, cfg, query, limit, excludeIds, forceCold });
  const timer = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, budget).unref?.();
  });

  let result = await Promise.race([work, timer]);
  if (result === null) {
    logger?.warn?.(`recall exceeded ${budget}ms, falling back to lexical`);
    result = { items: lexicalFallback({ store, cfg, query, limit }), timings: {}, notes: ['timeout'] };
    // 迟到的结果不要丢，至少让它把日志写出来
    work.then(
      (late) => logger?.debug?.(`late recall returned ${late.items.length} items after ${Date.now() - started}ms`),
      () => {},
    );
  }

  const items = result.items ?? [];
  if (!items.length) {
    return {
      count: 0, context: '', items, timings: result.timings, notes: result.notes,
      counts: result.counts, timedOut,
    };
  }

  const context = formatContext(items, cfg);
  // 只有真正进了上下文才强化；自动注入传 reinforceGain: 0 —— 每轮都「被看到」
  // 不等于被使用，否则热度会被注入自己刷到 cap（详见 heat.mjs 的注释）
  if (reinforceGain !== 0) {
    try {
      store.reinforceMany(items.map((i) => i.id), cfg.memory ?? {}, undefined, reinforceGain);
    } catch (err) {
      logger?.warn?.(`reinforce failed: ${err?.message ?? err}`);
    }
  }

  return {
    count: items.length,
    context,
    items,
    timings: { ...result.timings, total: Date.now() - started },
    notes: result.notes,
    counts: result.counts,
    timedOut,
  };
}

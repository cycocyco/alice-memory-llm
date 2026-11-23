// 记忆热度：衰减是纯函数，不是定时任务。
// 只存 heat0 / reinforced_at / half_life_days，读取时现算，写库只发生在"强化"和"分层迁移"。
import { daysBetween } from './text.mjs';

export const TIERS = ['hot', 'warm', 'cold', 'archive'];

export const DEFAULT_THRESHOLDS = {
  hot_in: 0.6,
  hot_out: 0.4,
  warm_in: 0.3,
  warm_out: 0.15,
};

/** 当前有效热度。pinned 的条目不衰减，也不许沉底 */
export function effectiveHeat(row, nowMs = Date.now(), thresholds = DEFAULT_THRESHOLDS) {
  void thresholds;
  const base = Number(row.heat0 ?? 1);
  if (Number(row.pinned) === 1) return base;
  const halfLife = Number(row.half_life_days ?? 0);
  if (!(halfLife > 0)) return base; // 0 = 不衰减
  const elapsed = daysBetween(row.reinforced_at, nowMs);
  return base * Math.pow(2, -elapsed / halfLife);
}

/**
 * 双阈值滞回：进 hot 的门槛比出 hot 高，避免一条记忆在边界反复横跳。
 * 每次 sweep 都改写 tier 会连带重建热区索引，抖动代价很实在。
 */
export function resolveTier(prev, heat, thresholds = DEFAULT_THRESHOLDS, pinned = false) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const from = TIERS.includes(prev) ? prev : 'hot';
  if (pinned) return from === 'archive' ? 'warm' : from === 'hot' ? 'hot' : 'warm';

  if (from === 'hot') {
    if (heat >= t.hot_out) return 'hot';
    return heat >= t.warm_in ? 'warm' : 'cold';
  }
  if (from === 'warm') {
    if (heat >= t.hot_in) return 'hot';
    return heat >= t.warm_out ? 'warm' : 'cold';
  }
  // cold / archive 想升回去，得跨过进入阈值
  if (heat >= t.hot_in) return 'hot';
  if (heat >= t.warm_in) return 'warm';
  return from === 'archive' ? 'archive' : 'cold';
}

/** 被真正送进上下文后强化。返回要写回库的字段 */
export function reinforce(row, nowMs = Date.now(), memoryCfg = {}) {
  const gain = Number(memoryCfg.reinforce_gain ?? 0.35);
  const cap = Number(memoryCfg.reinforce_cap ?? 3);
  const current = effectiveHeat(row, nowMs);
  const next = Math.min(cap, current + gain);
  return {
    heat0: next,
    reinforced_at: new Date(nowMs).toISOString(),
    access_count: Number(row.access_count ?? 0) + 1,
    last_access_at: new Date(nowMs).toISOString(),
  };
}

/** 新建记忆的初始参数 */
export function initialHeat({ kind, pinned, memoryCfg }) {
  const halves = memoryCfg?.half_life ?? {};
  const halfLife = pinned
    ? 0
    : Number(halves[kind] ?? halves.turn ?? memoryCfg?.half_life_days ?? 45);
  return {
    heat0: Number(memoryCfg?.reinforce_base ?? 1),
    half_life_days: halfLife,
    pinned: pinned ? 1 : 0,
    importance: pinned ? 1.5 : 1.0,
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v)));

/**
 * 自适应分层：**名次定层**，即按热度排名的分位点决定 hot/warm/cold，
 * 所以 100 条有 100 条的冷热，十万条有十万条的冷热，阈值随规模自动缩放。
 *
 * 不做双阈值滞回：热度只随时间是单调衰减的，排名交叉基本只发生一次，
 * 反复横跳的前提不成立；而且高热度区常有并列（都顶到 reinforce_cap），
 * 滞回带会把并列的一整片全粘在 hot 层，分位数就失真了。
 * 并列用原始顺序（调用方按 rowid 传入）做稳定 tie-break。
 *
 * @param {Array<{id:string, heat:number, pinned:boolean, prev:string}>} items
 */
export function assignTiers(items, memoryCfg = {}) {
  const list = (items ?? []).filter((it) => Number.isFinite(it.heat));
  const n = list.length;
  if (!n) return [];
  const hotRatio = clamp01(memoryCfg.hot_ratio ?? 0.2);
  const warmRatio = clamp01(memoryCfg.warm_ratio ?? 0.3);
  const sorted = [...list].sort((a, b) => b.heat - a.heat);
  const hotCount = Math.max(1, Math.round(n * hotRatio));
  const warmCount = Math.max(hotCount + 1, Math.round(n * (hotRatio + warmRatio)));
  // 绝对地板：热度跌到 warm_out 以下就是「死透了」，名次再好也不算热
  const floor = Number(memoryCfg.warm_out ?? DEFAULT_THRESHOLDS.warm_out);
  return sorted.map((it, i) => {
    const byRank = i < hotCount ? 'hot' : i < warmCount ? 'warm' : 'cold';
    return { ...it, tier: it.heat < floor ? 'cold' : byRank };
  });
}

/** 只算分位点门槛（诊断用）：返回 hot/warm 的分界热度 */
export function quantileCuts(heats, memoryCfg = {}) {
  const list = (heats ?? []).filter((h) => Number.isFinite(h));
  const n = list.length;
  if (!n) return { hotCut: 0, warmCut: 0, hotCount: 0, warmCount: 0 };
  const sorted = [...list].sort((a, b) => b - a);
  const hotCount = Math.max(1, Math.round(n * clamp01(memoryCfg.hot_ratio ?? 0.2)));
  const warmCount = Math.max(hotCount + 1, Math.round(n * (clamp01(memoryCfg.hot_ratio ?? 0.2) + clamp01(memoryCfg.warm_ratio ?? 0.3))));
  return {
    hotCut: sorted[Math.min(n - 1, hotCount - 1)],
    warmCut: sorted[Math.min(n - 1, warmCount - 1)],
    hotCount,
    warmCount,
  };
}

/** 是否该归档：只处理冷层、低重要度、久未触碰的条目。默认关闭 */
export function shouldArchive(row, nowMs, memoryCfg) {
  const days = Number(memoryCfg?.archive_after_days ?? 0);
  if (!(days > 0)) return false;
  if (Number(row.pinned) === 1) return false;
  if (row.tier !== 'cold') return false;
  if (Number(row.importance ?? 1) >= 1.5) return false;
  const last = row.last_access_at || row.reinforced_at || row.created_at;
  return daysBetween(last, nowMs) >= days;
}

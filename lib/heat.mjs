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

/**
 * 容量裁剪：hot / warm 都有硬上限，按热度排序取前 N，其余降级。
 * 这是"每轮只扫有限条"的唯一硬保证。
 */
export function applyCaps(entries, { hotMax, warmMax }) {
  if (!entries.length) return [];
  const sorted = entries.slice().sort((a, b) => b.heat - a.heat);
  const hotLimit = Math.max(0, hotMax);
  const warmLimit = Math.max(0, warmMax);
  return sorted.map((e, i) => {
    if (e.pinned) return { ...e, tier: i < hotLimit ? 'hot' : 'warm' };
    if (i < hotLimit) return { ...e, tier: 'hot' };
    if (i < hotLimit + warmLimit) return { ...e, tier: 'warm' };
    return { ...e, tier: e.tier === 'archive' ? 'archive' : 'cold' };
  });
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

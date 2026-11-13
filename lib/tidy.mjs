// 整理记忆库的「候选裁剪」层：代码负责算，模型负责判。
//
// 分工原则：
//  - 这里只产出**候选**，绝不自己下删除结论。真正的语义判断（这俩是不是一件事、
//    这条是不是过时了）留给调用方。
//  - 但候选池必须先收紧：不该让模型去两两比对全库。
//
// 三类候选：
//  1. duplicate  向量相似度 ≥ 阈值 的成对/成簇 —— 可能指向同一件事，可合并
//  2. shell      状态确认、空壳、几乎没有信息量的条目 —— 可直接清
//  3. stale      久未触碰且低热度 —— 只提示，不自动动
import { brief } from './text.mjs';

/** 余弦相似度。向量入库时已归一化，但仍按通用公式算，别依赖那个前提 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------- 空壳识别 ----------

/** 纯状态确认 / 催促 / 客套，没有任何可复用信息 */
const SHELL_PATTERNS = [
  /^(弄好了吗|好了吗|怎么样了|搞定(了)?吗|可以了吗|行了吗|还有吗|在吗|好了没)[\s!！。.~～?？]*$/u,
  /^(好|行|可以|收到|明白|了解|ok|okay|嗯+|哦+|谢谢|多谢|辛苦了|继续|没问题)[\s!！。.~～?？]*$/iu,
  /^(测试一下|test|试试|随便看看)[\s!！。.~～?？]*$/iu,
];

/** 正文里剥掉 User/Assistant 标签后的有效字数 */
function payloadOf(content) {
  return String(content ?? '')
    .replace(/^(User|Assistant|用户|助手)\s*[:：]\s*/gmu, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 判断一条记忆是不是空壳。
 * 只认「确定性高」的形态，判不准就返回 false —— 漏判比误删便宜得多。
 */
export function isShell(row) {
  if (Number(row.pinned) === 1) return false;             // 手记的一律不动
  if (row.source === 'merge' || row.source === 'manual') return false;
  if (Number(row.importance ?? 1) >= 1.5) return false;

  const payload = payloadOf(row.content);
  if (!payload) return true;                               // 剥完什么都不剩
  if (payload.length < 12) return true;                    // 极短，几乎没有信息量

  // 整条都在说这类话：User 一句催促，Assistant 一句「弄好了」
  const bare = String(row.content ?? '')
    .replace(/^(User|Assistant|用户|助手)\s*[:：]\s*/gmu, '')
    .trim();
  const clauses = bare.split(/[\n。！？!?]+/u).map((s) => s.trim()).filter(Boolean);
  if (clauses.length && clauses.every((c) => SHELL_PATTERNS.some((re) => re.test(c)))) return true;

  return false;
}

// ---------- 近似重复 / 语义成簇 ----------

/**
 * 用现成向量做两两比对，把相似度 ≥ threshold 的连成簇。
 * 全库 N 条就是 N²/2 次点积；1024 维下 3000 条约 460 万次乘加，
 * 单线程几百毫秒量级，整理频率（半月一次）完全可接受。
 *
 * 簇内挑「代表」：字数最多的那条留下，其余候选合并进它。
 */
export function clusterBySimilarity({ vecs, threshold = 0.92, maxNeighbors = 8 } = {}) {
  const rows = (vecs ?? []).filter((v) => v && v.vec && v.vec.length);
  const n = rows.length;
  if (n < 2) return { pairs: [], clusters: [] };

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    const a = rows[i];
    let found = 0;
    for (let j = i + 1; j < n; j += 1) {
      const score = cosine(a.vec, rows[j].vec);
      if (score >= threshold) {
        pairs.push({ a: a.id, b: rows[j].id, score: Number(score.toFixed(4)), i, j });
        union(i, j);
        found += 1;
        if (found >= maxNeighbors) break; // 一条不该跟十几条都算重复，多半是阈值太低
      }
    }
  }

  // 按并查集的根分组，全程用下标，不再回头查 id
  const groups = new Map();
  for (const p of pairs) {
    const root = find(p.i);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(p.i).add(p.j);
  }

  const clusters = [...groups.values()]
    .map((set) => {
      const idxs = [...set];
      if (idxs.length < 2) return null;
      const members = idxs.map((k) => rows[k]);
      // 代表 = 字数最多的那条：信息量最大，合并后最不容易丢东西
      const rep = members.slice().sort((x, y) => (y.chars ?? 0) - (x.chars ?? 0))[0];
      const inCluster = pairs
        .filter((p) => set.has(p.i) && set.has(p.j))
        .sort((x, y) => y.score - x.score);
      return {
        rep: rep.id,
        ids: members.map((m) => m.id),
        size: members.length,
        // 簇内最弱的那一对，用来看这一组的把握有多大
        minScore: inCluster.length ? inCluster[inCluster.length - 1].score : 0,
        scores: inCluster.slice(0, 12).map((p) => ({ a: p.a, b: p.b, score: p.score })),
      };
    })
    .filter(Boolean)
    .sort((x, y) => y.size - x.size);

  return {
    pairs: pairs.map((p) => ({ a: p.a, b: p.b, score: p.score })),
    clusters,
  };
}

// ---------- 对外入口 ----------

/** 增量锚点存在 meta 里，不额外造文件 */
export const TIDY_ANCHOR_KEY = 'tidy_anchor_at';

export function readAnchor({ store }) {
  return store.meta(TIDY_ANCHOR_KEY) ?? '';
}

export function writeAnchor({ store, at = new Date().toISOString() }) {
  store.setMeta(TIDY_ANCHOR_KEY, at);
  return at;
}

/**
 * 整理候选：一次调用把「要判断的东西」收拢好，别让调用方自己去翻库。
 *
 * 单一阈值（默认 0.78）：够这个分数就连成簇，摆出来给模型判断。
 * 实测 95 条真实库：0.92 只命中 1 组，0.78 命中 6 组且确为同一件事的重复。
 * 阈值越窄越准但漏得多，所以宁宽勿窄，判断权留在模型手上。
 *
 * @param {object} o
 * @param {object} o.store
 * @param {string} [o.since]      增量窗口起点（ISO）。缺省读锚点，再缺省就不限量
 * @param {number} [o.threshold]  相似度阈值，默认 0.78
 */
export function tidyScan({
  store, since = '', threshold = 0.78,
  staleDays = 180, limit = 3000, maxSample = 40,
} = {}) {
  const anchor = since || readAnchor({ store });
  // 窗口只用于「哪些条目该看」，但相似度比对需要它们的向量；
  // 全库比对会拖远，先按窗口取，窗口空就退回全库。
  const { rows, total } = store.listRows({ since: anchor, limit, offset: 0, order: 'asc' });
  const scannedRows = rows.length ? rows : store.listRows({ limit, offset: 0, order: 'asc' }).rows;

  const ids = scannedRows.map((r) => r.id);
  const vecMap = store.vectorsFor(ids);
  const vecs = [...vecMap.entries()].map(([id, vec]) => ({ id, vec }));

  const report = buildTidyReport({ rows: scannedRows, vecs, threshold, staleDays, maxSample });
  return {
    ...report,
    window: { since: anchor || null, until: null, count: scannedRows.length, total, fullScan: !rows.length },
  };
}

/**
 * 出一份整理候选报告。只读，不改库。
 *
 * @param {object} o
 * @param {Array} o.rows   条目行（含 id/content/local_date/pinned/source/importance/tier）
 * @param {Array} o.vecs   [{id, vec}]
 */
export function buildTidyReport({
  rows = [], vecs = [], threshold = 0.78, staleDays = 180, maxSample = 40,
} = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 1. 空壳：可直接清
  const shells = rows.filter((r) => isShell(r)).map((r) => ({
    id: r.id, date: r.local_date, why: '空壳/状态确认', content: brief(r.content, 90),
  }));

  // 2. 语义成簇：单阈值，全部交给调用方判断
  const usable = vecs
    .filter((v) => byId.has(v.id))
    .map((v) => ({ ...v, chars: payloadOf(byId.get(v.id).content).length }));
  const { clusters } = clusterBySimilarity({ vecs: usable, threshold });
  const groups = clusters.map((c) => ({
    rep: c.rep,
    size: c.size,
    minScore: c.minScore,
    members: c.ids.map((id) => {
      const r = byId.get(id) ?? {};
      return {
        id,
        date: r.local_date ?? '',
        pinned: Number(r.pinned) === 1,
        content: brief(r.content ?? '', 110),
      };
    }),
  }));

  // 3. 久未触碰的低热度条目：只提示
  const now = Date.now();
  const stale = rows
    .filter((r) => Number(r.pinned) !== 1 && Number(r.importance ?? 1) < 1.5)
    .filter((r) => r.tier === 'cold' || r.tier === 'warm')
    .map((r) => {
      const last = Date.parse(r.last_access_at || r.reinforced_at || r.created_at || r.occurred_at || '');
      const days = Number.isFinite(last) ? Math.floor((now - last) / 86_400_000) : null;
      return { id: r.id, date: r.local_date, days, tier: r.tier, content: brief(r.content, 90) };
    })
    .filter((r) => r.days === null || r.days >= staleDays)
    .sort((x, y) => (y.days ?? 0) - (x.days ?? 0));

  return {
    ok: true,
    scanned: rows.length,
    threshold,
    summary: {
      shells: shells.length,
      clusters: groups.length,
      clusterRows: groups.reduce((n, g) => n + g.size, 0),
      stale: stale.length,
    },
    shells: shells.slice(0, maxSample),
    clusters: groups.slice(0, maxSample),
    stale: stale.slice(0, maxSample),
  };
}

// 入库前的向量判重：提炼结果先过这一道，再进 commitExtraction。
//  - top1 相似度 ≥ near_dup → 高相似：再分「真重复」和「旧值被改写」两种
//      · 值标记完全相同（数字/路径/开关词/中文数量词）→ NOOP，丢掉
//      · 值标记不同（Tab→2 空格、7890→7897、开→关）→ REPLACE，软覆盖旧条目
//  - 相似度 ≥ similar_floor 的条数 > similar_max → 这个话题库里已经记了很多条，不再进
// 这样「已有记忆」参考块就不用塞进提炼提示词了：重复与否由向量这一趟顺手裁决，
// 提炼 prompt 不随记忆库变大而变贵。
// 判重只扫热区+温区索引（冷层不常驻内存，凉透的旧条目漏判可接受）。
// fail-open：embedder 没就绪或调用失败时全部放行——判重是省钱优化，不能变成丢记忆的闸门。
// 向量契约与库内一致：同走 embedDocs（带 docPrefix），保证与已存向量可比。
import { queryTerms } from './text.mjs';

/**
 * @param {Array<{content: string}>} items 提炼出的候选条目
 * @returns {Promise<{items: Array, dropped: Array, superseded: Array}>}
 */
export async function dedupItems({ index, store = null, embedder, cfg, items, logger = null }) {
  const dedup = cfg?.capture?.dedup ?? {};
  const empty = { items, dropped: [], superseded: [] };
  if (dedup.enabled === false || !Array.isArray(items) || !items.length) return empty;
  if (!embedder?.ready || !index) return empty;

  const nearDup = Math.min(1, Math.max(0, Number(dedup.near_dup ?? 0.9)));
  const floor = Math.min(1, Math.max(0, Number(dedup.similar_floor ?? 0.75)));
  // 软覆盖的触发线单独可配：命中它（≥0.75）就做「真重复 / 值被改写」的分流，
  // 而不是一律当成重复丢掉。0.70~0.75 与判不明的灰区放行，交 tidy scan 兜底。
  const supersedeFloor = Math.min(
    1,
    Math.max(0.5, Number(dedup.supersede_floor ?? floor)),
  );
  const maxSimilar = Math.max(0, Math.round(Number(dedup.similar_max ?? 3)));

  let vectors;
  try {
    const res = await embedder.embedDocs(items.map((x) => String(x.content)));
    if (!res?.ok) throw new Error(res?.error ?? 'embedding failed');
    vectors = res.vectors;
  } catch (err) {
    logger?.debug?.(`dedup fail-open (embed failed): ${err?.message ?? err}`);
    return empty;
  }
  if (!Array.isArray(vectors) || vectors.length !== items.length) return empty;

  const kept = [];
  const keptVecs = []; // 本批已放行的向量：LLM 换个说法重复吐两条，只留第一条
  const dropped = [];
  const superseded = [];

  /** 库内旧条目正文：只在真的命中高相似时才去取，平时的判重路径零额外查询 */
  const oldText = (id) => {
    if (!id || !store) return '';
    try {
      return store.rowsByIds([id])?.get?.(id)?.content ?? '';
    } catch {
      return '';
    }
  };

  for (let i = 0; i < items.length; i += 1) {
    const vec = vectors[i];
    if (!(vec instanceof Float32Array) || vec.length !== index.dims) {
      kept.push(items[i]);
      keptVecs.push(null);
      continue;
    }
    let top = -1;
    let topId = '';
    let similar = 0;
    if (index.size > 0) {
      try {
        const hits = await index.search(vec, maxSimilar + 5, { minScore: floor });
        top = hits[0]?.score ?? -1;
        topId = hits[0]?.id ?? '';
        similar = hits.length;
      } catch (err) {
        logger?.debug?.(`dedup search failed: ${err?.message ?? err}`);
      }
    }
    let batchTop = -1;
    for (const kv of keptVecs) {
      if (!kv) continue;
      const score = cosine(vec, kv);
      if (score > batchTop) batchTop = score;
    }
    // 同批内重复没有「谁更新」的概念，统一按重复丢掉
    if (batchTop >= nearDup) {
      dropped.push({
        content: items[i].content,
        reason: `batch near-dup ${batchTop.toFixed(2)}`,
      });
      continue;
    }
    if (top >= supersedeFloor) {
      const verdict = classifyNearDup({
        oldText: oldText(topId),
        newText: items[i].content,
        score: top,
        nearDup,
        supersedeFloor,
      });
      if (verdict === 'replace') {
        items[i].supersedeId = topId;
        superseded.push({ oldId: topId, content: items[i].content, score: Number(top.toFixed(2)) });
        kept.push(items[i]);
        keptVecs.push(vec);
        continue;
      }
      if (verdict === 'duplicate') {
        dropped.push({
          content: items[i].content,
          reason: `near-dup ${Number(top.toFixed(2))}`,
        });
        continue;
      }
      // 'unclear'：同一话题但拿不准是重复还是改写 —— 放行，交 tidy scan 兜底
    }
    if (similar > maxSimilar) {
      dropped.push({ content: items[i].content, reason: `similar ${similar} > ${maxSimilar}` });
      continue;
    }
    kept.push(items[i]);
    keptVecs.push(vec);
  }
  return { items: kept, dropped, superseded };
}

/**
 * 命中 supersede_floor 之后的三态裁决，纯确定性、零模型调用：
 *  - `duplicate`  值标记一字不差 → 真重复，丢掉
 *  - `replace`    值标记变了（Tab→2 空格、7890→7897、开→关）→ 软覆盖旧条目
 *  - `unclear`    同一话题但拿不准 → 放行，交给离线 tidy scan 兜底
 * 0.6b 对「同句式、反语义」给不出余弦差距，所以这里比的是「值」，不是语义。
 */
export function classifyNearDup({
  oldText, newText, score = 0, nearDup = 0.9, supersedeFloor = 0.75,
}) {
  if (!oldText) return score >= nearDup ? 'duplicate' : 'unclear';
  if (markersOf(oldText) === markersOf(newText)) return 'duplicate';
  if (score >= 0.9) return 'replace';
  return hasLexicalOverlap(oldText, newText) ? 'replace' : 'unclear';
}

/** 兼容旧调用：只关心「这一次是不是值改写」时用它 */
export function isValueUpdate(args) {
  return classifyNearDup(args) === 'replace';
}

/** 值标记：数字、盘符路径、开/关一类取值词、中文数量词（一次/两条/30 天） */
export function markersOf(text) {
  const t = String(text ?? '');
  const out = new Set();
  for (const m of t.matchAll(/[0-9]+(?:\.[0-9]+)?/g)) out.add(`#${m[0]}`);
  for (const m of t.matchAll(/[A-Za-z]:\\[^\s，。；、）)]+/g)) out.add(`p:${m[0].toLowerCase()}`);
  for (const m of t.matchAll(/(?:开启|关闭|打开|禁用|启用|允许|禁止|不要|不用|不许|必须|不能|可以)/g)) out.add(`s:${m[0]}`);
  for (const m of t.matchAll(/[一二两三四五六七八九十百千]+(?=次|条|空格|个|天|秒|分钟|轮|行|级)/g)) out.add(`c:${m[0]}`);
  return [...out].sort().join('|');
}

function hasLexicalOverlap(a, b) {
  const ta = new Set(queryTerms(a));
  if (!ta.size) return false;
  for (const term of queryTerms(b)) if (ta.has(term)) return true;
  return false;
}

/** 归一化点积，与库内 index.search 的口径一致（线上向量本身就是单位向量） */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : -1;
}
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
    if (Math.max(top, batchTop) >= nearDup) {
      // 同批内重复没有「谁更新」的概念，统一按重复丢掉
      if (batchTop >= nearDup) {
        dropped.push({
          content: items[i].content,
          reason: `batch near-dup ${batchTop.toFixed(2)}`,
        });
        continue;
      }
      const previous = oldText(topId);
      if (isValueUpdate({ oldText: previous, newText: items[i].content, score: top })) {
        items[i].supersedeId = topId;
        superseded.push({ oldId: topId, content: items[i].content, score: Number(top.toFixed(2)) });
        kept.push(items[i]);
        keptVecs.push(vec);
        continue;
      }
      dropped.push({
        content: items[i].content,
        reason: `near-dup ${Number(top.toFixed(2))}`,
      });
      continue;
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
 * 高相似时唯一要比的其实是「值」：同一句话、换了个取值，就是更新；
 * 取值一字不差，就是重复。纯余弦在这里分不开（0.6b 对同句式反语义给不出差距），
 * 而数字/路径/开关词这些「值标记」是确定性的，零额外模型调用。
 */
export function isValueUpdate({ oldText, newText, score = 0 }) {
  if (!oldText) return false; // 拿不到旧正文就不敢覆盖，宁可当重复处理
  const a = markersOf(oldText);
  const b = markersOf(newText);
  if (a === b) return false;
  // 极高相似 + 值不同：几乎同一句换了取值，直接认作更新
  if (score >= 0.9) return true;
  // 0.78~0.9 之间：必须有话题词交集，避免把「同句式不同话题」误判成更新
  return hasLexicalOverlap(oldText, newText);
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
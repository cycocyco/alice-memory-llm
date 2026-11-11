// 入库前的向量判重（主人拍板的规则）：提炼结果先过这一道，再进 commitExtraction。
//  - top1 相似度 ≥ near_dup → 近重复，跳过
//  - 相似度 ≥ similar_floor 的条数 > similar_max → 这个话题库里已经记了很多条，不再进
// 这样「已有记忆」参考块就不用塞进提炼提示词了：重复与否由向量这一趟顺手裁决，
// 提炼 prompt 不随记忆库变大而变贵。
// 判重只扫热区+温区索引（冷层不常驻内存，凉透的旧条目漏判可接受）。
// fail-open：embedder 没就绪或调用失败时全部放行——判重是省钱优化，不能变成丢记忆的闸门。
// 向量契约与库内一致：同走 embedDocs（带 docPrefix），保证与已存向量可比。

/**
 * @param {Array<{content: string}>} items 提炼出的候选条目
 * @returns {Promise<{items: Array, dropped: Array<{content: string, reason: string}>}>}
 */
export async function dedupItems({ index, embedder, cfg, items, logger = null }) {
  const dedup = cfg?.capture?.dedup ?? {};
  const empty = { items, dropped: [] };
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
  for (let i = 0; i < items.length; i += 1) {
    const vec = vectors[i];
    if (!(vec instanceof Float32Array) || vec.length !== index.dims) {
      kept.push(items[i]);
      keptVecs.push(null);
      continue;
    }
    let top = -1;
    let similar = 0;
    if (index.size > 0) {
      try {
        const hits = await index.search(vec, maxSimilar + 5, { minScore: floor });
        top = hits[0]?.score ?? -1;
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
      dropped.push({
        content: items[i].content,
        reason: batchTop >= nearDup ? `batch near-dup ${batchTop.toFixed(2)}` : `near-dup ${top.toFixed(2)}`,
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
  return { items: kept, dropped };
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

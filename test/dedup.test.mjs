// 向量判重闸的单元验收：全程脚本化 embedder + 手工单位向量，不发任何真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VectorIndex } from '../lib/vector-index.mjs';
import { dedupItems } from '../lib/dedup.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'alice-dedup-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const unitVec = (i) => {
  const v = new Float32Array(8);
  v[i] = 1;
  return v;
};
/** e_i 与 e_j 方向拼出指定余弦的向量（i⊥j 时成立） */
const mixVec = (i, j, cos) => {
  const v = new Float32Array(8);
  v[i] = cos;
  v[j] = Math.sqrt(1 - cos * cos);
  return v;
};

function stubEmbedder(byText) {
  return {
    ready: true,
    async embedDocs(texts) {
      return { ok: true, vectors: texts.map((t) => byText[t] ?? unitVec(7)) };
    },
  };
}

function cfgWith(overrides = {}) {
  return {
    capture: {
      dedup: { enabled: true, near_dup: 0.9, similar_floor: 0.75, similar_max: 3, ...overrides },
    },
  };
}

const item = (content) => ({ content, type: 'fact', confidence: 0.8, sourceTurnIds: [] });

test('near-dup：top1 相似度超阈值，条目被拦下', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false });
  try {
    index.set('m1', unitVec(0));
    const res = await dedupItems({
      index,
      embedder: stubEmbedder({ '几乎一样的记忆': unitVec(0) }),
      cfg: cfgWith(),
      items: [item('几乎一样的记忆')],
    });
    assert.equal(res.items.length, 0);
    assert.equal(res.dropped.length, 1);
    assert.match(res.dropped[0].reason, /near-dup/);
  } finally {
    index.close();
    cleanup();
  }
});

test('saturated：同话题相似条数超上限，不再进库', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false });
  try {
    const bank = mixVec(0, 1, 0.8); // 与 e0 夹角 0.8，≥ floor 0.75
    for (let i = 0; i < 4; i += 1) index.set(`m${i}`, bank);
    const res = await dedupItems({
      index,
      embedder: stubEmbedder({ '这个话题又被提了一遍': unitVec(0) }),
      cfg: cfgWith(),
      items: [item('这个话题又被提了一遍')],
    });
    assert.equal(res.items.length, 0);
    assert.match(res.dropped[0].reason, /similar 4 > 3/);
  } finally {
    index.close();
    cleanup();
  }
});

test('介于两条规则之间的（1~3 条相似）照常放行', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false });
  try {
    const bank = mixVec(0, 1, 0.8);
    for (let i = 0; i < 3; i += 1) index.set(`m${i}`, bank);
    const res = await dedupItems({
      index,
      embedder: stubEmbedder({ '相关但没记满的话题': unitVec(0) }),
      cfg: cfgWith(),
      items: [item('相关但没记满的话题')],
    });
    assert.equal(res.items.length, 1);
    assert.equal(res.dropped.length, 0);
  } finally {
    index.close();
    cleanup();
  }
});

test('同批互斥：LLM 换个说法重复吐两条，只留第一条', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false }); // 空库
  try {
    const e = unitVec(2);
    const res = await dedupItems({
      index,
      embedder: stubEmbedder({ '第一条记忆': e, '第一条记忆的另一种说法': e }),
      cfg: cfgWith(),
      items: [item('第一条记忆'), item('第一条记忆的另一种说法')],
    });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].content, '第一条记忆');
    assert.match(res.dropped[0].reason, /batch/);
  } finally {
    index.close();
    cleanup();
  }
});

test('embedding 挂了放行（fail-open），不拦任何条目', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false });
  try {
    index.set('m1', unitVec(0));
    const bad = { ready: true, async embedDocs() { return { ok: false, error: 'boom' }; } };
    const res = await dedupItems({ index, embedder: bad, cfg: cfgWith(), items: [item('任意内容')] });
    assert.equal(res.items.length, 1);
    assert.equal(res.dropped.length, 0);
  } finally {
    index.close();
    cleanup();
  }
});

test('开关关掉或索引为空时整道闸直接跳过', async () => {
  const { dir, cleanup } = tmp();
  const index = new VectorIndex(8, { preferWorker: false });
  try {
    const off = await dedupItems({
      index, embedder: null, cfg: cfgWith({ enabled: false }), items: [item('任意内容')],
    });
    assert.equal(off.items.length, 1);
    const emptyBank = await dedupItems({
      index, embedder: stubEmbedder({}), cfg: cfgWith(), items: [item('任意内容')],
    });
    assert.equal(emptyBank.items.length, 1, '空库没有可比对象');
  } finally {
    index.close();
    cleanup();
  }
});

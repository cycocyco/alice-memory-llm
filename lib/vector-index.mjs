// 热区向量索引：一块连续的 SharedArrayBuffer，配一个常驻 worker 做扫描。
// 设计要点：
//  - 主线程只负责增删，扫描全部在 worker 里跑，事件循环零阻塞
//  - worker 拿不到 id（字符串），只回 slot，主线程自己映射；省掉每次同步 id 表
//  - 结构变更用 version 计数兜底，扫描期间被改过就重试一次
import { Worker } from 'node:worker_threads';

const HOT_TIMEOUT_MS = 1500;

export class VectorIndex {
  #dims;
  #maxRows;
  #ids = [];
  #slots = new Map();
  #data;
  #f32;
  #ctrl;
  #worker = null;
  #workerFailed = false;
  #pending = new Map();
  #seq = 0;
  #logger;
  #preferWorker;

  constructor(dims, { maxRows = 20000, preferWorker = true, logger = null } = {}) {
    this.#dims = dims;
    this.#maxRows = Math.max(1, maxRows);
    this.#preferWorker = preferWorker;
    this.#logger = logger;
    this.#allocate(Math.min(this.#maxRows, 512));
    if (preferWorker) this.#spawn();
  }

  get size() {
    return this.#ids.length;
  }

  get dims() {
    return this.#dims;
  }

  get usingWorker() {
    return Boolean(this.#worker);
  }

  #allocate(capacity) {
    const rows = Math.max(1, capacity);
    this.#data = new SharedArrayBuffer(rows * this.#dims * 4);
    this.#ctrl = new SharedArrayBuffer(8);
    this.#f32 = new Float32Array(this.#data);
    this.#capacity = rows;
    Atomics.store(new Int32Array(this.#ctrl), 1, this.#version ?? 0);
  }

  #capacity = 0;
  #version = 0;

  #spawn() {
    try {
      this.#worker = new Worker(new URL('./vector-worker.mjs', import.meta.url), {
        workerData: { data: this.#data, ctrl: this.#ctrl, dims: this.#dims, capacity: this.#capacity },
      });
      this.#worker.on('message', (msg) => {
        const entry = this.#pending.get(msg.reqId);
        if (!entry) return;
        this.#pending.delete(msg.reqId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      });
      this.#worker.on('error', (err) => {
        this.#logger?.warn(`vector worker error, falling back to sync scan: ${err.message}`);
        this.#workerFailed = true;
        this.#worker = null;
        this.#failAll();
      });
      this.#worker.on('exit', () => {
        this.#worker = null;
        this.#failAll();
      });
      this.#worker.unref?.();
    } catch (err) {
      this.#logger?.warn(`vector worker unavailable, using sync scan: ${err.message}`);
      this.#workerFailed = true;
      this.#worker = null;
    }
  }

  #failAll() {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.#pending.clear();
  }

  #grow(needed) {
    let next = this.#capacity || 512;
    while (next < needed) next *= 2;
    next = Math.min(next, this.#maxRows);
    if (next <= this.#capacity) return false;
    const old = this.#f32;
    const oldCount = this.#ids.length;
    this.#allocate(next);
    this.#f32.set(old.subarray(0, oldCount * this.#dims));
    Atomics.store(new Int32Array(this.#ctrl), 0, oldCount);
    if (this.#worker) {
      this.#worker.postMessage({
        type: 'bind',
        data: this.#data,
        ctrl: this.#ctrl,
        dims: this.#dims,
        capacity: this.#capacity,
      });
    }
    return true;
  }

  set(id, vec) {
    if (!(vec instanceof Float32Array)) vec = Float32Array.from(vec);
    if (vec.length !== this.#dims) return false;
    let slot = this.#slots.get(id);
    if (slot === undefined) {
      if (this.#ids.length >= this.#maxRows) return false;
      this.#grow(this.#ids.length + 1);
      slot = this.#ids.length;
      this.#ids.push(id);
      this.#slots.set(id, slot);
    }
    const base = slot * this.#dims;
    this.#f32.set(vec.subarray(0, this.#dims), base);
    this.#bumpVersion();
    Atomics.store(new Int32Array(this.#ctrl), 0, this.#ids.length);
    return true;
  }

  delete(id) {
    const slot = this.#slots.get(id);
    if (slot === undefined) return false;
    const lastIdx = this.#ids.length - 1;
    const lastId = this.#ids[lastIdx];
    if (slot !== lastIdx) {
      const from = lastIdx * this.#dims;
      const to = slot * this.#dims;
      this.#f32.copyWithin(to, from, from + this.#dims);
      this.#ids[slot] = lastId;
      this.#slots.set(lastId, slot);
    }
    this.#ids.pop();
    this.#slots.delete(id);
    this.#bumpVersion();
    Atomics.store(new Int32Array(this.#ctrl), 0, this.#ids.length);
    return true;
  }

  clear() {
    this.#ids.length = 0;
    this.#slots.clear();
    this.#bumpVersion();
    Atomics.store(new Int32Array(this.#ctrl), 0, 0);
  }

  #bumpVersion() {
    this.#version = (this.#version + 1) | 0;
    Atomics.store(new Int32Array(this.#ctrl), 1, this.#version);
  }

  /** @returns {Promise<Array<{id: string, score: number}>>} */
  async search(query, k = 8, { minScore = -1 } = {}) {
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    if (q.length !== this.#dims || this.#ids.length === 0) return [];
    const limit = Math.max(1, Math.min(k, this.#ids.length));

    if (this.#worker && !this.#workerFailed) {
      const hits = await this.#askWorker(q, limit);
      if (hits) return this.#mapHits(hits, minScore);
    }
    return this.#mapHits(this.#scanSync(q, limit), minScore);
  }

  #mapHits(hits, minScore) {
    const out = [];
    for (const hit of hits) {
      const id = this.#ids[hit.slot];
      if (!id) continue;
      if (hit.score < minScore) continue;
      out.push({ id, score: hit.score });
    }
    return out;
  }

  #askWorker(q, limit) {
    const reqId = ++this.#seq;
    const version = this.#version;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        resolve(null);
      }, HOT_TIMEOUT_MS);
      this.#pending.set(reqId, { resolve: (msg) => resolve(msg?.version === version ? msg.hits : null), timer });
      try {
        this.#worker.postMessage({ type: 'search', reqId, q, k: limit });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(reqId);
        resolve(null);
      }
    });
  }

  #scanSync(q, limit) {
    const count = this.#ids.length;
    const f32 = this.#f32;
    const dims = this.#dims;
    const hits = [];
    for (let s = 0; s < count; s += 1) {
      const base = s * dims;
      let dot = 0;
      for (let i = 0; i < dims; i += 1) dot += q[i] * f32[base + i];
      hits.push({ slot: s, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * 冷层补刀：把整个向量库扫一遍，在 worker 里做，主线程不等。
   * 带时间预算，扫到哪算哪；worker 不可用时返回 null，由调用方决定是否放弃。
   */
  async scanCold({ q, k = 8, dbPath, budgetMs = 900, cap = 200000 }) {
    if (!this.#worker || this.#workerFailed) return null;
    const reqId = ++this.#seq;
    const query = q instanceof Float32Array ? q : Float32Array.from(q);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        resolve(null);
      }, budgetMs + 500);
      this.#pending.set(reqId, {
        resolve: (msg) => resolve(msg?.hits ?? null),
        timer,
      });
      try {
        this.#worker.postMessage({
          type: 'cold',
          reqId,
          q: query,
          k,
          dbPath,
          dims: this.#dims,
          budgetMs,
          cap,
        });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(reqId);
        resolve(null);
      }
    });
  }

  close() {
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return Promise.resolve();
    try {
      return Promise.resolve(worker.terminate()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
}

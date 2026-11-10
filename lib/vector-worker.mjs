// 向量扫描线程。只做两件事：扫热区内存、扫冷层磁盘。不碰业务逻辑、不碰主线程状态。
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

let dims = workerData.dims;
let capacity = workerData.capacity;
let ctrl = new Int32Array(workerData.ctrl);
let data = new Float32Array(workerData.data);

let coldDb = null;
let coldPath = null;

parentPort.on('message', (msg) => {
  if (msg.type === 'bind') {
    dims = msg.dims;
    capacity = msg.capacity;
    ctrl = new Int32Array(msg.ctrl);
    data = new Float32Array(msg.data);
    return;
  }
  if (msg.type === 'search') {
    const version = Atomics.load(ctrl, 1);
    const count = Math.min(Atomics.load(ctrl, 0), Math.floor(data.length / dims));
    const hits = scanHot(msg.q, count, msg.k);
    parentPort.postMessage({ type: 'search', reqId: msg.reqId, hits, version });
    return;
  }
  if (msg.type === 'cold') {
    const hits = scanCold(msg);
    parentPort.postMessage({ type: 'cold', reqId: msg.reqId, hits });
  }
});

function scanHot(q, count, k) {
  if (!count || q.length !== dims) return [];
  const hits = new Array(count);
  for (let s = 0; s < count; s += 1) {
    const base = s * dims;
    let dot = 0;
    for (let i = 0; i < dims; i += 1) dot += q[i] * data[base + i];
    hits[s] = { slot: s, score: dot };
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, Math.min(k, count)));
}

function openCold(path) {
  if (coldDb && coldPath === path) return coldDb;
  try {
    coldDb?.close();
  } catch {}
  coldDb = new DatabaseSync(path, { readOnly: true });
  coldPath = path;
  return coldDb;
}

function scanCold(msg) {
  const started = Date.now();
  const { q, k, budgetMs, cap, dims: dimsWanted } = msg;
  let db;
  try {
    db = openCold(msg.dbPath);
  } catch {
    return [];
  }
  let stmt;
  try {
    stmt = db.prepare('SELECT memory_id, vector FROM vectors WHERE dimensions = ?');
  } catch {
    return [];
  }
  const hits = [];
  let scanned = 0;
  const limit = Math.max(1, k);
  try {
    for (const row of stmt.iterate(dimsWanted)) {
      const u8 = row.vector;
      const vec = new Float32Array(
        u8.buffer,
        u8.byteOffset,
        Math.min(dimsWanted, u8.byteLength / 4),
      );
      let dot = 0;
      for (let i = 0; i < dimsWanted; i += 1) dot += q[i] * vec[i];
      hits.push({ id: row.memory_id, score: dot });
      scanned += 1;
      if (scanned % 256 === 0 && Date.now() - started > budgetMs) break;
      if (scanned >= cap) break;
    }
  } catch {
    // 向量库被别的进程占用或已损坏，就当这轮没有补刀
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

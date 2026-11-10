// 单文件记忆库的收束工具。
//
// 两件事：
//  1) 老版本把正文和向量拆成 memories.sqlite3 + vectors.sqlite3，启动时自动并进单文件；
//  2) 别处散落的库（调试目录、备份目录）按需导入，导完可连目录一起清掉。
//
// 只依赖 node:sqlite，不碰主进程状态；所有函数都接受一个已打开的 DatabaseSync。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const DB_NAME = 'memories.sqlite3';
export const DB_ALIAS = 'memory.sqlite3'; // 手改过库名的老库也认
export const LEGACY_VECTOR_NAME = 'vectors.sqlite3';
export const LEGACY_DIR = 'legacy';

const MEM_COLUMNS = [
  'id', 'occurred_at', 'local_date', 'kind', 'user_text', 'assistant_text', 'content',
  'content_sha256', 'session_id', 'scope_id', 'source', 'importance', 'pinned', 'heat0',
  'reinforced_at', 'half_life_days', 'access_count', 'last_access_at', 'tier',
  'embedding_status', 'embedding_model', 'created_at',
];

const SIDECARS = ['', '-wal', '-shm'];

export function dbPathOf(dataDir) {
  return join(dataDir, DB_NAME);
}

/** 这个目录里有没有记忆库 */
export function isStoreDir(dir) {
  return existsSync(join(dir, DB_NAME)) || existsSync(join(dir, DB_ALIAS));
}

function resolveMemPath(dir) {
  const primary = join(dir, DB_NAME);
  if (existsSync(primary)) return primary;
  const alias = join(dir, DB_ALIAS);
  if (existsSync(alias)) return alias;
  return '';
}

/** 深度优先找散落的库目录；node_modules / .git 一律跳过 */
export function scanStoreDirs(root, { maxDepth = 3 } = {}) {
  const base = resolve(root);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isStoreDir(dir)) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === LEGACY_DIR) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  if (isStoreDir(base)) found.push(base);
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === LEGACY_DIR) continue;
    walk(join(base, entry.name), 1);
  }
  return [...new Set(found)];
}

function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.prepare('PRAGMA busy_timeout = 3000').get();
  return db;
}

function hasTable(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
  } catch {
    return false;
  }
}

const VEC_SELECT = 'SELECT memory_id, scope_id, model, dimensions, updated_at, vector FROM vectors';

function readVectorsFrom(db, out = new Map()) {
  if (!hasTable(db, 'vectors')) return out;
  for (const row of db.prepare(VEC_SELECT).iterate()) out.set(row.memory_id, row);
  return out;
}

function readVectors(path) {
  const out = new Map();
  if (!path || !existsSync(path)) return out;
  let db;
  try {
    db = openReadOnly(path);
    readVectorsFrom(db, out);
  } catch {
    // 打不开就当这个源没有向量，正文照样能导
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return out;
}

/**
 * 严格版：打不开就抛。
 * 并库时不能用宽容版——读不到却当成「没有向量」，会把没搬过的文件归档掉。
 */
function readLegacyVectorsStrict(path) {
  const db = openReadOnly(path);
  try {
    if (!hasTable(db, 'vectors')) return { rows: new Map(), hasTable: false };
    const rows = new Map();
    for (const row of db.prepare(VEC_SELECT).iterate()) rows.set(row.memory_id, row);
    return { rows, hasTable: true };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** 读一个散落库：正文 + 向量 + 墓碑 */
export function readSourceStore(dir) {
  const memPath = resolveMemPath(dir);
  if (!memPath) return null;
  const vecPath = join(dir, LEGACY_VECTOR_NAME);
  const db = openReadOnly(memPath);
  try {
    const rows = hasTable(db, 'memories')
      ? db.prepare('SELECT * FROM memories ORDER BY rowid').all()
      : [];
    const tombstones = hasTable(db, 'tombstones')
      ? db.prepare('SELECT memory_id, revoked_at FROM tombstones').all()
      : [];
    // 新库向量在同文件里，老库在旁边的 vectors.sqlite3；两边都收，同 id 以本库为准
    const vectors = readVectorsFrom(db);
    for (const [id, row] of readVectors(vecPath)) {
      if (!vectors.has(id)) vectors.set(id, row);
    }
    return {
      memPath,
      vecPath: existsSync(vecPath) ? vecPath : '',
      rows,
      tombstones,
      vectors,
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function insertRowStmt(db) {
  const cols = MEM_COLUMNS.join(', ');
  const marks = MEM_COLUMNS.map(() => '?').join(', ');
  return db.prepare(
    "INSERT INTO memories (" + cols + ") VALUES (" + marks + ") ON CONFLICT(content_sha256) DO NOTHING",
  );
}

/**
 * 把一个源的正文/向量/墓碑并进目标库。
 * 幂等：同 content_sha256 跳过，同 id 冲突改 id，向量按 memory_id 只补不覆盖。
 */
export function importSource({ db, source, targetScopeId, dimensions, dryRun = false, logger = null }) {
  const stats = {
    source: source.memPath,
    rows: source.rows.length,
    imported: 0,
    duplicates: 0,
    vectors: 0,
    vectorsSkipped: 0,
    tombstones: 0,
    scopeRemapped: 0,
    errors: [],
  };
  if (!source.rows.length && !source.vectors.size) return stats;

  const byHash = db.prepare('SELECT id FROM memories WHERE content_sha256 = ?');
  const byId = db.prepare('SELECT id FROM memories WHERE id = ?');
  const ins = insertRowStmt(db);
  const insVec = db.prepare(
    'INSERT INTO vectors (memory_id, scope_id, model, dimensions, updated_at, vector) VALUES (?,?,?,?,?,?) ON CONFLICT(memory_id) DO NOTHING',
  );
  const markOk = db.prepare("UPDATE memories SET embedding_status = 'ok', embedding_model = ? WHERE id = ?");
  const insTomb = db.prepare('INSERT OR IGNORE INTO tombstones (memory_id, revoked_at) VALUES (?, ?)');

  const idMap = new Map(); // 源 id → 目标 id
  const nowIso = new Date().toISOString();

  if (!dryRun) db.exec('BEGIN');
  try {
    for (const row of source.rows) {
      const content = String(row.content ?? '').trim();
      if (!content) continue;
      const sha = row.content_sha256 ?? '';
      const hit = sha ? byHash.get(sha) : null;
      if (hit) {
        stats.duplicates += 1;
        idMap.set(row.id, hit.id);
        continue;
      }
      const sourceId = row.id ?? "mem-" + randomUUID().slice(0, 12);
      const taken = byId.get(sourceId);
      const id = taken ? "mem-" + randomUUID().slice(0, 12) : sourceId;
      const scope = targetScopeId ?? row.scope_id ?? 'default';
      if (row.scope_id && row.scope_id !== scope) stats.scopeRemapped += 1;

      const values = [
        id,
        row.occurred_at ?? nowIso,
        row.local_date ?? String(row.occurred_at ?? nowIso).slice(0, 10),
        row.kind ?? 'turn',
        row.user_text ?? null,
        row.assistant_text ?? null,
        content,
        sha || contentShaFallback(content),
        row.session_id ?? null,
        scope,
        row.source ?? 'import',
        Number(row.importance ?? 1),
        Number(row.pinned ?? 0) ? 1 : 0,
        Number(row.heat0 ?? 1),
        row.reinforced_at ?? nowIso,
        Number(row.half_life_days ?? 45),
        Number(row.access_count ?? 0),
        row.last_access_at ?? null,
        row.tier ?? 'hot',
        row.embedding_status ?? 'pending',
        row.embedding_model ?? null,
        row.created_at ?? nowIso,
      ];
      if (!dryRun) {
        const res = ins.run(...values);
        if (Number(res.changes) === 0) {
          stats.duplicates += 1;
          const again = byHash.get(values[7]);
          if (again) idMap.set(sourceId, again.id);
          continue;
        }
      }
      stats.imported += 1;
      idMap.set(sourceId, id);
    }

    for (const [sourceId, vec] of source.vectors) {
      const targetId = idMap.get(sourceId) ?? sourceId;
      const dims = Number(vec.dimensions ?? 0);
      if (dimensions && dims !== dimensions) {
        stats.vectorsSkipped += 1;
        continue;
      }
      if (dryRun) {
        stats.vectors += 1;
        continue;
      }
      const res = insVec.run(targetId, targetScopeId ?? vec.scope_id ?? 'default', vec.model ?? 'unknown', dims, vec.updated_at ?? nowIso, vec.vector);
      if (Number(res.changes) > 0) {
        stats.vectors += 1;
        try {
          markOk.run(vec.model ?? null, targetId);
        } catch {}
      } else {
        stats.vectorsSkipped += 1;
      }
    }

    for (const tomb of source.tombstones) {
      if (dryRun) continue;
      const res = insTomb.run(tomb.memory_id, tomb.revoked_at ?? nowIso);
      if (Number(res.changes) > 0) stats.tombstones += 1;
    }

    if (!dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!dryRun) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    stats.errors.push(err?.message ?? String(err));
    logger?.warn?.("import failed for " + source.memPath + ": " + (err?.message ?? err));
  }
  return stats;
}

function contentShaFallback(content) {
  // 只在源行缺 hash 时兜底，保证唯一索引还能拦住重复
  return 'fallback-' + Buffer.from(content).toString('base64').slice(0, 40);
}

/** 目录 → 导入。dir 或 db 文件路径都认 */
export function importFromPath({ db, path, targetScopeId, dimensions, dryRun = false, logger = null }) {
  const abs = resolve(path);
  const dir = statSync(abs).isDirectory() ? abs : dirname(abs);
  const source = readSourceStore(dir);
  if (!source) return { ok: false, dir, error: 'no memory database here' };
  return { ok: true, dir, ...importSource({ db, source, targetScopeId, dimensions, dryRun, logger }) };
}

/**
 * 老版本的双库并库：把 vectors.sqlite3 的向量搬进单文件，成功后把老文件挪进 legacy/。
 * 老文件被别的进程占着（rename EBUSY）就留着，下次启动再来一次，导入是幂等的。
 */
export function foldLegacyVectors({
  db,
  dataDir,
  logger = null,
  dryRun = false,
  dimensions = 0,
  model = '',
}) {
  const legacyPath = join(dataDir, LEGACY_VECTOR_NAME);
  const out = { found: false, imported: 0, skipped: 0, stale: 0, moved: false, note: '' };
  if (!existsSync(legacyPath)) return out;
  out.found = true;

  // 先把 WAL 落盘，别漏掉还挂在 -wal 里的向量
  try {
    const side = new DatabaseSync(legacyPath);
    try {
      side.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {
      side.close();
    }
  } catch {
    // 被占用也没关系，只读打开照样能读到已提交的数据
  }

  // 读不出来就别动它：宁可留一条 WARN 下次再试，也不能把没读到的文件归档掉
  let vectors;
  let hasTable;
  try {
    ({ rows: vectors, hasTable } = readLegacyVectorsStrict(legacyPath));
  } catch (err) {
    out.note = "kept " + LEGACY_VECTOR_NAME + " (unreadable: " + (err?.message ?? err) + ")";
    logger?.warn?.(out.note);
    return out;
  }
  if (!hasTable) {
    out.note = LEGACY_VECTOR_NAME + " has no vectors table";
    logger?.warn?.(out.note);
  }

  const insVec = db.prepare(
    'INSERT INTO vectors (memory_id, scope_id, model, dimensions, updated_at, vector) VALUES (?,?,?,?,?,?) ON CONFLICT(memory_id) DO NOTHING',
  );
  const markOk = db.prepare("UPDATE memories SET embedding_status = 'ok', embedding_model = ? WHERE id = ?");
  // 维度/模型对不上的老向量不能算数：标记回 pending 让 backfill 用当前模型重嵌。
  // 先看主库里有没有已经合格的那条，否则每次启动都会把刚重嵌好的又打回 pending。
  const curVec = db.prepare('SELECT dimensions, model FROM vectors WHERE memory_id = ?');
  const markStale = db.prepare(
    "UPDATE memories SET embedding_status = 'pending', embedding_model = NULL WHERE id = ?",
  );
  if (!dryRun) db.exec('BEGIN');
  try {
    for (const [memoryId, vec] of vectors) {
      const dims = Number(vec.dimensions ?? 0);
      const vecModel = String(vec.model ?? '');
      const mismatch = (dimensions && dims !== dimensions) || (model && vecModel && vecModel !== model);
      if (mismatch) {
        const cur = dryRun ? null : curVec.get(memoryId);
        const fresh = cur
          && Number(cur.dimensions) === Number(dimensions || dims)
          && (!model || !cur.model || cur.model === model);
        if (fresh) {
          out.skipped += 1;
          continue;
        }
        out.stale += 1;
        if (!dryRun) {
          try {
            markStale.run(memoryId);
          } catch {}
        }
        continue;
      }
      if (dryRun) {
        out.imported += 1;
        continue;
      }
      const res = insVec.run(
        memoryId,
        vec.scope_id ?? 'default',
        vec.model ?? 'unknown',
        Number(vec.dimensions ?? 0),
        vec.updated_at ?? new Date().toISOString(),
        vec.vector,
      );
      if (Number(res.changes) > 0) {
        out.imported += 1;
        try {
          markOk.run(vec.model ?? null, memoryId);
        } catch {}
      } else {
        out.skipped += 1;
      }
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!dryRun) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    out.note = "import failed: " + (err?.message ?? err);
    logger?.warn?.(out.note);
    return out;
  }
  if (dryRun) return out;

  // 搬走老文件（含 -wal/-shm），搬不动就留着下次再试
  try {
    const dest = join(dataDir, LEGACY_DIR);
    mkdirSync(dest, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    for (const suffix of SIDECARS) {
      const from = legacyPath + suffix;
      if (!existsSync(from)) continue;
      renameSync(from, join(dest, LEGACY_VECTOR_NAME + "." + stamp + suffix));
    }
    out.moved = true;
  } catch (err) {
    out.note = "kept " + LEGACY_VECTOR_NAME + " (busy: " + (err?.code ?? err?.message ?? "error") + ")";
    logger?.warn?.("legacy vectors folded but file not moved: " + out.note);
  }
  if (out.imported || out.stale || out.moved) {
    logger?.info?.(
      "folded " + out.imported + " legacy vectors into " + DB_NAME
      + (out.stale ? ", " + out.stale + " stale (queued for re-embed)" : "")
      + (out.moved ? ", old file archived in " + LEGACY_DIR + "/" : ""),
    );
  }
  return out;
}

/** 目录里除了记忆库没别的东西？只有这种目录才允许 --purge 整目录删 */
export function isPureStoreDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (!entries.length) return false;
  const pattern = /^(memories|memory|vectors)\.sqlite3(-wal|-shm)?$/i;
  let hasDb = false;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name !== LEGACY_DIR) return false;
      continue;
    }
    if (!pattern.test(entry.name)) return false;
    if (pattern.test(entry.name) && !/-(wal|shm)$/i.test(entry.name)) hasDb = true;
  }
  return hasDb;
}

export function purgeStoreDir(dir) {
  if (!isPureStoreDir(dir)) return { ok: false, error: 'directory has other files, not purging' };
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { ok: true, removed: dir };
}

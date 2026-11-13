// SQLite 存储层：建表、读写、分层扫描、全文检索、墓碑
// 只用 node:sqlite，零第三方依赖。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { effectiveHeat, resolveTier, shouldArchive, initialHeat, reinforce } from './heat.mjs';
import { localDate, isoNow, collapse, sha256 } from './text.mjs';
import { dbPathOf, foldLegacyVectors } from './migrate.mjs';

export const SCHEMA_VERSION = 3;

const MEM_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_text TEXT,
  assistant_text TEXT,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  session_id TEXT,
  scope_id TEXT NOT NULL,
  source TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,
  heat0 REAL NOT NULL DEFAULT 1.0,
  reinforced_at TEXT NOT NULL,
  half_life_days REAL NOT NULL DEFAULT 45,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT,
  tier TEXT NOT NULL DEFAULT 'hot',
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  embedding_model TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_sha ON memories(content_sha256);
CREATE INDEX IF NOT EXISTS idx_memories_time ON memories(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memories_date ON memories(local_date);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(embedding_status);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS tombstones (
  memory_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

// 向量表和正文同库：一个数据目录只有一个 memories.sqlite3
const VEC_DDL = `
CREATE TABLE IF NOT EXISTS vectors (
  memory_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  vector BLOB NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_vectors_dims ON vectors(dimensions);
`;

const MAX_ROWS_PER_CANDIDATE = 500;

/** 清理阈值按整点对齐，保证预览和真删算出同一个 cutoff（token 才对得上） */
function quantizeCutoff(olderThanDays) {
  const ms = Date.now() - Math.max(1, olderThanDays) * 86_400_000;
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

function toBuffer(f32) {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBuffer(blob, dims) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const out = new Float32Array(dims);
  out.set(new Float32Array(u8.buffer, u8.byteOffset, Math.min(dims, u8.byteLength / 4)));
  return out;
}

export class Store {
  constructor({ dataDir, dimensions, model, scopeId, logger }) {
    this.dataDir = dataDir;
    this.dimensions = dimensions;
    this.model = model;
    this.scopeId = scopeId;
    this.logger = logger;
    mkdirSync(dataDir, { recursive: true });
    // 一个数据目录 = 一个库文件。正文、向量、墓碑、FTS 全在里面，
    // 不再拆成 memories.sqlite3 + vectors.sqlite3 两份。
    this.dbPath = dbPathOf(dataDir);
    this.memPath = this.dbPath;
    this.vecPath = this.dbPath;
    this.db = new DatabaseSync(this.dbPath);
    // 兼容：老代码和测试直接拿 store.mem / store.vec 跑 SQL，指向同一个连接
    this.mem = this.db;
    this.vec = this.db;
    this.#init();
  }

  #init() {
    const db = this.db;
    db.prepare('PRAGMA journal_mode = WAL').get();
    db.prepare('PRAGMA synchronous = NORMAL').get();
    db.prepare('PRAGMA busy_timeout = 5000').get();
    db.exec(MEM_DDL);
    db.exec(VEC_DDL);

    const version = this.meta('schema_version');
    if (version && Number(version) > SCHEMA_VERSION) {
      throw new Error(
        `memory database schema v${version} is newer than this plugin (v${SCHEMA_VERSION}); upgrade the plugin instead of downgrading the data`,
      );
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.setMeta('dimensions', String(this.dimensions));
    this.setMeta('model', this.model);
    this.setMeta('scope_id', this.scopeId);
    if (!this.meta('created_at')) this.setMeta('created_at', isoNow());

    // 老版本把向量单独放一个文件，这里顺手并进来，并完把老文件挪进 legacy/
    try {
      foldLegacyVectors({
        db,
        dataDir: this.dataDir,
        logger: this.logger,
        dimensions: this.dimensions,
        model: this.model,
      });
    } catch (err) {
      this.logger?.warn(`legacy vector fold failed: ${err?.message ?? err}`);
    }

    // 维度对不上的旧向量不会参与检索，得让人看见
    try {
      const stale = db.prepare('SELECT count(*) AS n FROM vectors WHERE dimensions <> ?').get(this.dimensions);
      if (Number(stale?.n)) {
        this.logger?.warn(
          `${stale.n} vectors were built with other dimensions than ${this.dimensions}; they are ignored by search`,
        );
      }
    } catch {}

    this.#prep();
  }

  #prep() {
    this.q = {
      insertMemory: this.mem.prepare(`
        INSERT INTO memories (
          id, occurred_at, local_date, kind, user_text, assistant_text, content, content_sha256,
          session_id, scope_id, source, importance, pinned, heat0, reinforced_at, half_life_days,
          access_count, last_access_at, tier, embedding_status, embedding_model, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(content_sha256) DO NOTHING
      `),
      byHash: this.mem.prepare('SELECT id, created_at FROM memories WHERE content_sha256 = ?'),
      byId: this.mem.prepare('SELECT * FROM memories WHERE id = ?'),
      byIds: {}, // 动态拼，见 rowsByIds
      setVectorStatus: this.mem.prepare(
        'UPDATE memories SET embedding_status = ?, embedding_model = ? WHERE id = ?',
      ),
      pending: this.mem.prepare(`
        SELECT id, content, embedding_status FROM memories
        WHERE embedding_status IN ('pending','failed') AND scope_id = ?
        ORDER BY created_at LIMIT ?
      `),
      tierCounts: this.mem.prepare('SELECT tier, count(*) AS n FROM memories WHERE scope_id = ? GROUP BY tier'),
      dayCount: this.mem.prepare(
        "SELECT count(*) AS n FROM memories WHERE local_date = ? AND source = 'auto' AND scope_id = ?",
      ),
      allHeat: this.mem.prepare(`
        SELECT id, tier, heat0, reinforced_at, half_life_days, pinned, importance, last_access_at, created_at
        FROM memories ORDER BY rowid
      `),
      setTier: this.mem.prepare('UPDATE memories SET tier = ? WHERE id = ?'),
      reinforce: this.mem.prepare(
        'UPDATE memories SET heat0 = ?, reinforced_at = ?, access_count = ?, last_access_at = ? WHERE id = ?',
      ),
      deleteMemory: this.mem.prepare('DELETE FROM memories WHERE id = ?'),
      insertTombstone: this.mem.prepare(
        'INSERT OR REPLACE INTO tombstones(memory_id, revoked_at) VALUES (?, ?)',
      ),
      pruneTombstones: this.mem.prepare('DELETE FROM tombstones WHERE revoked_at < ?'),
      countTombstones: this.mem.prepare('SELECT count(*) AS n FROM tombstones'),
      countMemories: this.mem.prepare('SELECT count(*) AS n FROM memories WHERE scope_id = ?'),
      countAllMemories: this.mem.prepare('SELECT count(*) AS n FROM memories'),
      pruneCandidates: this.mem.prepare(`
        SELECT id, content, last_access_at, reinforced_at, created_at, importance, access_count
        FROM memories
        WHERE tier = 'cold' AND pinned = 0 AND importance < 1.5 AND scope_id = ?
          AND coalesce(last_access_at, reinforced_at, created_at) < ?
        ORDER BY coalesce(last_access_at, reinforced_at, created_at) ASC
        LIMIT ?
      `),
      countPruneCandidates: this.mem.prepare(`
        SELECT count(*) AS n FROM memories
        WHERE tier = 'cold' AND pinned = 0 AND importance < 1.5 AND scope_id = ?
          AND coalesce(last_access_at, reinforced_at, created_at) < ?
      `),
      pruneAllCandidates: this.mem.prepare(`
        SELECT id FROM memories
        WHERE tier = 'cold' AND pinned = 0 AND importance < 1.5 AND scope_id = ?
          AND coalesce(last_access_at, reinforced_at, created_at) < ?
      `),
      sumPruneBytes: this.mem.prepare(`
        SELECT coalesce(sum(length(content)), 0) AS n FROM memories
        WHERE tier = 'cold' AND pinned = 0 AND importance < 1.5 AND scope_id = ?
          AND coalesce(last_access_at, reinforced_at, created_at) < ?
      `),
      fts: this.mem.prepare(`
        SELECT m.id AS id, bm25(memories_fts) AS rank
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.scope_id = ?
        ORDER BY rank LIMIT ?
      `),
      like: this.mem.prepare(`
        SELECT id, 0 AS rank FROM memories
        WHERE scope_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY occurred_at DESC LIMIT ?
      `),
    };

    this.v = {
      upsert: this.vec.prepare(`
        INSERT INTO vectors (memory_id, scope_id, model, dimensions, updated_at, vector)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(memory_id) DO UPDATE SET
          scope_id = excluded.scope_id, model = excluded.model,
          dimensions = excluded.dimensions, updated_at = excluded.updated_at, vector = excluded.vector
      `),
      del: this.vec.prepare('DELETE FROM vectors WHERE memory_id = ?'),
      byIds: {}, // 动态拼
      all: this.vec.prepare('SELECT memory_id, vector, dimensions FROM vectors WHERE dimensions = ?'),
      count: this.vec.prepare('SELECT count(*) AS n FROM vectors'),
      forTierScan: this.vec.prepare('SELECT memory_id, vector, dimensions FROM vectors WHERE dimensions = ?'),
    };
  }

  meta(key, db = this.mem) {
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setMeta(key, value, db = this.mem) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
  }

  // ---------- 写入 ----------

  /**
   * @returns {{id: string, inserted: boolean}}
   */
  insertMemory(input) {
    const now = input.now ?? isoNow();
    const content = collapse(input.content);
    const heat = initialHeat({
      kind: input.kind === 'note' ? 'manual' : 'turn',
      pinned: Boolean(input.pinned),
      memoryCfg: input.memoryCfg ?? {},
    });
    const row = {
      id: input.id ?? `mem-${randomUUID().slice(0, 12)}`,
      occurred_at: input.occurredAt ?? now,
      local_date: input.localDate ?? localDate(new Date(now)),
      kind: input.kind ?? 'turn',
      user_text: input.userText ? collapse(input.userText) : null,
      assistant_text: input.assistantText ? collapse(input.assistantText) : null,
      content,
      content_sha256: input.sha ?? sha256(content),
      session_id: input.sessionId ?? null,
      scope_id: input.scopeId ?? this.scopeId,
      source: input.source ?? 'auto',
      importance: input.importance ?? heat.importance,
      pinned: heat.pinned,
      heat0: heat.heat0,
      reinforced_at: now,
      half_life_days: heat.half_life_days,
      access_count: 0,
      last_access_at: null,
      tier: 'hot',
      embedding_status: input.embeddingStatus ?? 'pending',
      embedding_model: null,
      created_at: now,
    };

    const res = this.q.insertMemory.run(
      row.id, row.occurred_at, row.local_date, row.kind, row.user_text, row.assistant_text,
      row.content, row.content_sha256, row.session_id, row.scope_id, row.source,
      row.importance, row.pinned, row.heat0, row.reinforced_at, row.half_life_days,
      row.access_count, row.last_access_at, row.tier, row.embedding_status,
      row.embedding_model, row.created_at,
    );

    if (Number(res.changes) === 0) {
      const existing = this.q.byHash.get(row.content_sha256);
      return { id: existing?.id ?? row.id, inserted: false };
    }
    return { id: row.id, inserted: true };
  }

  setVector(memoryId, vec, model = this.model) {
    const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    const norm = normalizeInPlace(f32);
    if (norm === 0) return false;
    this.v.upsert.run(memoryId, this.scopeId, model, f32.length, isoNow(), toBuffer(f32));
    this.q.setVectorStatus.run('ok', model, memoryId);
    return true;
  }

  markEmbeddingFailed(id, reason = 'failed') {
    this.q.setVectorStatus.run('failed', null, id);
    void reason;
  }

  setEmbeddingStatus(id, status) {
    this.q.setVectorStatus.run(status, null, id);
  }

  // ---------- 读取 ----------

  getMemory(id) {
    return this.q.byId.get(id) ?? null;
  }

  rowsByIds(ids) {
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.mem
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  pending(limit = 32) {
    return this.q.pending.all(this.scopeId, limit);
  }

  countMemories() {
    return Number(this.q.countMemories.get(this.scopeId)?.n ?? 0);
  }

  countAll() {
    return Number(this.q.countAllMemories.get()?.n ?? 0);
  }

  countVectors() {
    return Number(this.v.count.get()?.n ?? 0);
  }

  countTombstones() {
    return Number(this.q.countTombstones.get()?.n ?? 0);
  }

  dayCount(dateStr) {
    return Number(this.q.dayCount.get(dateStr, this.scopeId)?.n ?? 0);
  }

  tierCounts() {
    const out = { hot: 0, warm: 0, cold: 0, archive: 0 };
    for (const row of this.q.tierCounts.all(this.scopeId)) out[row.tier] = Number(row.n);
    return out;
  }

  /** 热区索引要装的行（hot + warm），按热度降序 */
  hotWarmRows(limit = 1e9) {
    const rows = this.mem
      .prepare(`
        SELECT id, heat0, reinforced_at, half_life_days, pinned, tier
        FROM memories WHERE tier IN ('hot','warm') ORDER BY rowid
      `)
      .all();
    const now = Date.now();
    return rows
      .map((r) => ({ ...r, heat: effectiveHeat(r, now) }))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, limit);
  }

  /** 一次性把指定记忆的向量读出来，给索引灌数据用 */
  vectorsFor(ids) {
    if (!ids.length) return new Map();
    const out = new Map();
    const stmt = this.vec.prepare('SELECT vector, dimensions FROM vectors WHERE memory_id = ?');
    for (const id of ids) {
      const row = stmt.get(id);
      if (row) out.set(id, fromBuffer(row.vector, Number(row.dimensions)));
    }
    return out;
  }

  allVectors() {
    return this.v.all.all(this.dimensions).map((r) => ({
      id: r.memory_id,
      vec: fromBuffer(r.vector, Number(r.dimensions)),
    }));
  }

  // ---------- 检索 ----------

  /** FTS5 短语匹配；返回 [{id, rank}] */
  searchFts(terms, limit) {
    const long = terms.filter((t) => Array.from(t).length >= 3);
    if (!long.length) return [];
    const expr = long
      .slice(0, 8)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    try {
      return this.q.fts.all(expr, this.scopeId, limit).map((r) => ({ id: r.id, rank: Number(r.rank) }));
    } catch (err) {
      this.logger?.warn(`FTS query failed: ${err.message}`);
      return [];
    }
  }

  /** trigram 对 1-2 字查询无能为力，回落 LIKE */
  searchLike(terms, limit) {
    const short = terms.filter((t) => Array.from(t).length >= 1 && Array.from(t).length < 3);
    if (!short.length) return [];
    const out = new Map();
    for (const t of short.slice(0, 4)) {
      const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
      for (const r of this.q.like.all(this.scopeId, `%${escaped}%`, limit)) {
        if (!out.has(r.id)) out.set(r.id, { id: r.id, rank: 0 });
      }
    }
    return [...out.values()];
  }

  /**
   * 分页翻条目，给整理记忆库用（替代一次性 exportAll 把全库塞进内存）。
   * 条件是动态拼的，但每一段都走绑定参数，不拼用户输入。
   */
  listRows({
    since = '', until = '', tier = '', keyword = '', sessionId = '',
    limit = 50, offset = 0, order = 'asc',
  } = {}) {
    const where = ['scope_id = ?'];
    const args = [this.scopeId];
    if (since) { where.push('occurred_at >= ?'); args.push(since); }
    if (until) { where.push('occurred_at <= ?'); args.push(until); }
    if (tier) { where.push('tier = ?'); args.push(tier); }
    if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
    if (keyword) {
      where.push("content LIKE ? ESCAPE '\\'");
      args.push(`%${String(keyword).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const clause = where.join(' AND ');
    const rows = this.mem
      .prepare(
        `SELECT id, occurred_at, local_date, kind, user_text, assistant_text, content,
                session_id, source, importance, pinned, tier, access_count, last_access_at
         FROM memories WHERE ${clause}
         ORDER BY occurred_at ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.max(1, limit), Math.max(0, offset));
    const total = Number(
      this.mem.prepare(`SELECT count(*) AS n FROM memories WHERE ${clause}`).get(...args)?.n ?? 0,
    );
    return { rows, total };
  }

  /** 任意长度的子串匹配，给 forget 用（FTS trigram 查不到 2 字以内的词） */
  findBySubstring(needle, limit = 50) {
    const escaped = String(needle).replace(/[\\%_]/g, (m) => `\\${m}`);
    return this.mem
      .prepare(
        `SELECT id, content FROM memories
         WHERE scope_id = ? AND content LIKE ? ESCAPE '\\'
         ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(this.scopeId, `%${escaped}%`, limit);
  }

  // ---------- 热度维护 ----------

  /**
   * 分层 sweep：算热度 → 双阈值滞回 → 容量裁剪 → 只写变化的行。
   * @returns {{scanned: number, changed: number, tiers: object}}
   */
  sweep({ now = Date.now(), memoryCfg }) {
    const th = {
      hot_in: memoryCfg.hot_in,
      hot_out: memoryCfg.hot_out,
      warm_in: memoryCfg.warm_in,
      warm_out: memoryCfg.warm_out,
    };
    const rows = this.q.allHeat.all();
    const nowMs = typeof now === 'number' ? now : Date.now();
    const entries = rows.map((r) => {
      const heat = effectiveHeat(r, nowMs);
      let tier = resolveTier(r.tier, heat, th, Number(r.pinned) === 1);
      if (shouldArchive({ ...r, tier }, nowMs, memoryCfg)) tier = 'archive';
      return { id: r.id, heat, pinned: Number(r.pinned) === 1, prev: r.tier, tier };
    });

    // 容量硬上限：按热度排名，超出的往下压，绝不往上提
    const ranked = [...entries].sort((a, b) => b.heat - a.heat);
    const hotMax = Number(memoryCfg.hot_max ?? 0);
    const warmMax = Number(memoryCfg.warm_max ?? 0);
    const rankOf = new Map(ranked.map((e, i) => [e.id, i]));
    for (const e of entries) {
      if (e.tier === 'archive') continue;
      const rank = rankOf.get(e.id) ?? 0;
      if (rank >= hotMax + warmMax && !e.pinned) {
        if (e.tier === 'hot' || e.tier === 'warm') e.tier = 'cold';
      } else if (rank >= hotMax && e.tier === 'hot') {
        e.tier = 'warm';
      }
      if (e.pinned && e.tier === 'cold') e.tier = 'warm';
    }

    const changed = entries.filter((e) => e.tier !== e.prev);
    let applied = 0;
    if (changed.length) {
      this.mem.exec('BEGIN');
      try {
        for (const e of changed) {
          this.q.setTier.run(e.tier, e.id);
          applied += 1;
        }
        this.mem.exec('COMMIT');
      } catch (err) {
        try {
          this.mem.exec('ROLLBACK');
        } catch {}
        throw err;
      }
    }
    return { scanned: rows.length, changed: applied, tiers: this.tierCounts(), entries };
  }

  reinforceMany(ids, memoryCfg, now = Date.now()) {
    if (!ids.length) return 0;
    const rows = this.rowsByIds(ids);
    let n = 0;
    this.mem.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = rows.get(id);
        if (!row) continue;
        const next = reinforce(row, now, memoryCfg);
        this.q.reinforce.run(
          next.heat0,
          next.reinforced_at,
          next.access_count,
          next.last_access_at,
          id,
        );
        n += 1;
      }
      this.mem.exec('COMMIT');
    } catch (err) {
      try {
        this.mem.exec('ROLLBACK');
      } catch {}
      throw err;
    }
    return n;
  }

  // ---------- 删除 ----------

  deleteMemory(id) {
    const res = this.q.deleteMemory.run(id);
    this.v.del.run(id);
    this.q.insertTombstone.run(id, isoNow());
    return Number(res.changes) > 0;
  }

  pruneTombstones(days = 90) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = this.q.pruneTombstones.run(cutoff);
    return Number(res.changes);
  }

  /** 清掉没有对应记忆行的向量（迁移失败、半截写入会留下）。同库一条 SQL 就够 */
  pruneOrphanVectors() {
    const res = this.db
      .prepare('DELETE FROM vectors WHERE memory_id NOT IN (SELECT id FROM memories)')
      .run();
    return Number(res?.changes ?? 0);
  }

  /** 冷记忆清理候选。只碰 cold + 非 pinned + 低重要度 */
  pruneCandidates({ olderThanDays = 90, limit = 20, preview = true } = {}) {
    const cutoff = quantizeCutoff(olderThanDays);
    const total = Number(this.q.countPruneCandidates.get(this.scopeId, cutoff)?.n ?? 0);
    const bytes = Number(this.q.sumPruneBytes.get(this.scopeId, cutoff)?.n ?? 0);
    const rows = preview
      ? this.q.pruneCandidates.all(this.scopeId, cutoff, Math.min(limit, MAX_ROWS_PER_CANDIDATE))
      : [];
    return { total, bytes, rows, cutoff, olderThanDays };
  }

  pruneApply({ olderThanDays = 90, limit = MAX_ROWS_PER_CANDIDATE } = {}) {
    const cutoff = quantizeCutoff(olderThanDays);
    const ids = this.q.pruneAllCandidates
      .all(this.scopeId, cutoff)
      .map((r) => r.id)
      .slice(0, Math.max(1, limit));
    let removed = 0;
    this.mem.exec('BEGIN');
    try {
      for (const id of ids) {
        if (this.deleteMemory(id)) removed += 1;
      }
      this.mem.exec('COMMIT');
    } catch (err) {
      try {
        this.mem.exec('ROLLBACK');
      } catch {}
      throw err;
    }
    return { removed, ids };
  }

  /** 全量导出（CLI 用） */
  exportAll() {
    return this.mem
      .prepare('SELECT * FROM memories ORDER BY occurred_at')
      .all();
  }

  close() {
    // 退出前把 WAL 收进主文件，别在目录里留下几 MB 的 -wal 让人误会
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {}
    try {
      this.db.close();
    } catch {}
  }
}

/** 原地归一化，返回原范数；范数为 0 时返回 0 */
export function normalizeInPlace(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i += 1) sum += f32[i] * f32[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 1e-12)) return 0;
  const inv = 1 / norm;
  for (let i = 0; i < f32.length; i += 1) f32[i] *= inv;
  return norm;
}

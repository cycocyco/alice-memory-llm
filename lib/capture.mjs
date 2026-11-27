// 粗筛：只判断「这条消息是否进入待提炼池」，不再决定入库、也不再存原文。
// 是否值得长期记住，交给空闲 debounce 后的 LLM 批量提炼。
import { collapse } from './text.mjs';

// 不维护水词黑名单：水词本身都 ≤4 字，长度闸门已经兜住，两份平行正则只会各自漂移。
// 自产块的标记：两种前缀都排掉，两个版本共存时互不污染
const OURS = /\[alice-memory-llm[:\]]|\[alice-memory[:\]]|- \[20\d\d-\d\d-\d\d\]/;
const REVOKE = /^[/／](?:记忆撤销|记忆撤回|memory-revoke)\s*$/i;
// 状态确认/进度询问：「弄好了吗」「还没好」「改完没」——问的是进度，不带持久信息
const STATUS_CHECK = /^(?:还|快)?(?:弄|搞|做|改|看|试|跑|用|装|建)(?:好|完|到|成)?了?(?:吗|没|么|嘛)?[!！。.~～?？]*$/;
// 单字符重复：「哈哈哈哈哈」「好好好好」——短的是语气词；长的可能是粘贴内容，不算噪声
const REPEAT_CHAR = /^(.)\1{2,11}$/u;

/**
 * 入池判定。规则只能拦形式，内容价值由提炼层裁决。
 * 兼容旧签名 {userText, assistantText, cfg}；assistantText 不再参与判定。
 */
export function isWorthKeeping({ text, userText, cfg }) {
  if (cfg?.capture?.enabled === false) return { keep: false, reason: 'capture disabled' };
  const u = collapse(text ?? userText ?? '');
  if (!u) return { keep: false, reason: 'empty text' };
  // 先判「有没有文字」再判长度：否则「？？？」「😀😀」会被报成长度问题，原因就不对了
  if (!/[\p{L}\p{N}]/u.test(u)) return { keep: false, reason: 'no words' };
  // 命令类先识别再判长度：`/记忆撤销` 去掉标点只剩 4 字，不能被长度闸门吞成「太短」
  if (REVOKE.test(u)) return { keep: false, reason: 'revoke command' };
  if (/^[/／]\S*$/.test(u)) return { keep: false, reason: 'slash command' };
  // 长度闸门按「去标点后的实字」算：≤4 字直接不进池（好的、继续、嗯嗯、再改一次）。
  // 黑名单永远追不上人会说的话，用长度兜住长尾更省事；内容价值仍交给提炼层裁决。
  const core = u.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
  if (core.length <= 4) return { keep: false, reason: 'too short' };
  if (STATUS_CHECK.test(u)) return { keep: false, reason: 'status check' };
  if (REPEAT_CHAR.test(u)) return { keep: false, reason: 'repeated char' };
  if (OURS.test(u)) return { keep: false, reason: 'our own recall block' };
  // 纯问句不再整体排除：问句里常带着事实与偏好（「是不是该用 A 了」），
  // 一律拦掉等于把一半真实决策挡在门外，剩下的噪音交给提炼层裁决。
  return { keep: true, reason: '' };
}

/**
 * 入池截断：提炼目标集中在用户侧的偏好/事实/拍板，助手长回复与贴进来的长日志
 * 尾部全是噪音（提示词自己都规定「助手说了什么不算记忆」）。
 * 数字配置 = 两个角色同一上限；对象配置按角色取；缺省 user 500 / assistant 200。
 */
export function truncateForPool({ text, role, cfg }) {
  const caps = cfg?.capture?.max_turn_chars;
  const raw = typeof caps === 'number' ? caps : Number(role === 'assistant' ? caps?.assistant : caps?.user);
  const cap = Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : (role === 'assistant' ? 200 : 500);
  const flat = collapse(text);
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** 把一批行补成向量，成功则入热区索引 */
export async function embedRows({ store, index, embedder, cfg, logger, rows }) {
  if (!rows.length) return { ok: 0, failed: 0 };
  if (!embedder?.ready) return { ok: 0, failed: rows.length, skipped: 'embedder not ready' };

  let ok = 0;
  let failed = 0;
  const batch = Math.max(1, Number(cfg.embedding?.batch ?? 16));

  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const res = await embedder.embedDocs(chunk.map((r) => r.content));
    if (!res.ok) {
      for (const row of chunk) store.markEmbeddingFailed(row.id, res.error);
      failed += chunk.length;
      logger?.warn?.(`embedding batch failed: ${res.error}`);
      continue;
    }
    chunk.forEach((row, k) => {
      const vec = res.vectors[k];
      if (!vec || !store.setVector(row.id, vec, cfg.embedding.model)) {
        store.markEmbeddingFailed(row.id, 'empty vector');
        failed += 1;
        return;
      }
      if (row.tier !== 'cold' && row.tier !== 'archive') index.set(row.id, vec);
      ok += 1;
    });
  }
  return { ok, failed };
}

/** 待补向量的行：pending，或失败且过了重试窗口 */
export function pendingRows({ store, cfg, limit = 64, now = Date.now() }) {
  const retryMs = Number(cfg.capture?.embed_retry_minutes ?? 5) * 60_000;
  return store.pending(limit).filter((row) => {
    if (row.embedding_status !== 'failed') return true;
    const at = Date.parse(row.created_at ?? '');
    return !Number.isFinite(at) || now - at > retryMs;
  });
}

/** 一轮 backfill，供定时器与 CLI 复用 */
export async function runBackfill({ store, index, embedder, cfg, logger, limit = 64 }) {
  const rows = pendingRows({ store, cfg, limit });
  if (!rows.length) return { ok: 0, failed: 0, tried: 0 };
  const out = await embedRows({ store, index, embedder, cfg, logger, rows });
  return { ...out, tried: rows.length };
}

/** 启动时把向量灌进连续缓冲：按热度取前 N 条，不再按 tier 过滤 */
export function loadIndex({ store, index, cfg, logger }) {
  const capacity = Number(
    cfg.memory?.index_capacity
      ?? (Number(cfg.memory?.hot_max ?? 3000) + Number(cfg.memory?.warm_max ?? 12000)),
  );
  const rows = store.heatTopRows(capacity);
  if (!rows.length) return { loaded: 0 };
  const vecs = store.vectorsFor(rows.map((r) => r.id));
  let loaded = 0;
  for (const row of rows) {
    const vec = vecs.get(row.id);
    if (!vec) continue;
    index.set(row.id, vec);
    loaded += 1;
  }
  logger?.info?.(`hot index loaded: ${loaded}/${rows.length} vectors`);
  return { loaded, rows: rows.length };
}

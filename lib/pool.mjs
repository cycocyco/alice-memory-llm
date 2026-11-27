// 触发层：待提炼池 + 唯一触发（空闲 debounce）+ flush 编排。
// 池内原文只在内存，不持久化、不补提；失败静默重试，绝不与主对话请求排队。
import { isWorthKeeping, truncateForPool } from './capture.mjs';
import { localDate } from './text.mjs';
import { resolveLlmConfig, buildPrompt, callExtractor } from './extractor.mjs';
import { dedupItems } from './dedup.mjs';
import { createHttpTransport } from './http.mjs';
import {
  ensureExtractionSchema, cursor, dailyExtractions, bumpExtractionCount, commitExtraction,
  bumpStat, STAT_KEYS,
} from './extraction-store.mjs';

export function createCapturePool({
  store, index, embedder, cfg, logger, ctx,
  onInserted, env = process.env, now = () => Date.now(),
  transport = null,
}) {
  ensureExtractionSchema(store);
  // 默认走原生 socket：DSH 后端把 globalThis.fetch 换成了 carrierFetch，响应不可靠
  const send = transport ?? createHttpTransport();

  // 轮次号从持久化游标续起：进程重启后新轮次号必然 > 游标，不会从头重提
  let turnCounter = cursor(store);
  let currentTurnId = null;
  const completed = new Set();
  const pending = []; // { turnId, role, text, ts } —— 不落盘
  let timer = null;
  let flushing = false;
  let disposed = false;
  let selection = null;
  const events = []; // 测试与调试可观察，不对外提示

  const emit = (kind, payload = {}) => {
    const name = `memory-capture:${kind}`;
    events.push({ name, ...payload });
    try {
      ctx?.emit?.(name, payload);
    } catch (err) {
      logger?.debug?.(`emit ${name} failed: ${err?.message ?? err}`);
    }
  };

  const arm = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, Math.max(1, Number(cfg.capture?.idleMs ?? 600000)));
    timer.unref?.();
  };

  /** agent/pre-step 的 modelSelection：inherit 时据此复用主对话 provider/model */
  const setSelection = (sel) => {
    if (sel?.provider && sel?.model) selection = { provider: sel.provider, model: sel.model };
  };

  /** 新轮次开始；同一轮里再来 user 消息不另开轮 */
  const beginTurn = () => {
    if (currentTurnId !== null) return currentTurnId;
    turnCounter += 1;
    currentTurnId = turnCounter;
    return currentTurnId;
  };

  const onMessage = (role, text) => {
    if (disposed) return;
    arm(); // 每条消息到达都重置计时器
    const verdict = isWorthKeeping({ text, cfg });
    if (!verdict.keep) return;
    const turnId = currentTurnId ?? turnCounter;
    if (turnId <= 0) return;
    pending.push({ turnId, role, text: truncateForPool({ text, role, cfg }), ts: now() });
  };

  /** 一轮完成（assistant 回复结束）时刻，也是空闲起算点 */
  const completeTurn = () => {
    if (currentTurnId === null) return;
    completed.add(currentTurnId);
    currentTurnId = null;
    arm();
  };

  async function flush() {
    if (disposed || flushing) return; // 重入锁
    // 积压 TTL：池不落盘，排不空的陈旧轮次直接丢弃，但要记账——不记就是数据静默蒸发
    const ttlDays = Number(cfg.capture?.backlog_ttl_days ?? 0);
    if (ttlDays > 0) {
      const cutoff = now() - ttlDays * 86_400_000;
      let aged = 0;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (Number(pending[i].ts ?? 0) < cutoff) {
          completed.delete(pending[i].turnId);
          pending.splice(i, 1);
          aged += 1;
        }
      }
      if (aged) {
        bumpStat(store, STAT_KEYS.backlogDropped, aged);
        logger?.info?.(`backlog: dropped ${aged} turns older than ${ttlDays}d`);
      }
    }
    const from = cursor(store);
    const ready = pending.filter((p) => p.turnId > from && completed.has(p.turnId));
    if (!ready.length) return; // 只处理已完成的轮次

    // 只留下含用户发言的轮次：用户那句已被初筛拦掉时，单独一条助手消息进 prompt
    // 既没有可提炼的源头，还白烧 token（慢机器上一轮能等十几秒）
    const byTurn = new Map();
    for (const p of ready) {
      if (!byTurn.has(p.turnId)) byTurn.set(p.turnId, []);
      byTurn.get(p.turnId).push(p);
    }
    const usable = [...byTurn.values()].filter((g) => g.some((p) => p.role !== 'assistant'));
    if (!usable.length) {
      // 整批都是助手独白：不调模型，游标照常推进，池清干净
      const maxTurnId = Math.max(...ready.map((p) => p.turnId));
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].turnId <= maxTurnId) pending.splice(i, 1);
      }
      for (const id of completed) if (id <= maxTurnId) completed.delete(id);
      return;
    }
    const promptTurns = usable.flat();

    const day = localDate(new Date(now()));
    const cap = Math.max(1, Number(cfg.capture?.maxDailyExtractions ?? 50));
    if (dailyExtractions(store, day) >= cap) return;

    // 每批最多送几轮：慢机器上 prefill 是硬开销，池里攒了几十轮会把它拖死。
    // 超出时取「最新的一批」而不是最老的一批：每日上限只有 50 次，先消化最近的
    // 才有用；被跳过的那几条老轮次随游标推进一起丢掉，并记进 backlog 计数。
    const perBatch = Math.max(0, Math.round(Number(cfg.capture?.max_turns_per_extract ?? 0)));
    const pickTurns = (turns, limitTurns) => {
      if (!(limitTurns > 0)) return turns;
      const ids = [...new Set(turns.map((p) => p.turnId))].sort((a, b) => b - a).slice(0, limitTurns);
      const keep = new Set(ids);
      return turns.filter((p) => keep.has(p.turnId));
    };
    const turnsToSend = pickTurns(promptTurns, perBatch);
    const batchTurns = new Set(turnsToSend.map((p) => p.turnId));
    const skippedTurns = new Set(promptTurns.map((p) => p.turnId)).size - batchTurns.size;
    if (skippedTurns > 0) {
      bumpStat(store, STAT_KEYS.backlogDropped, skippedTurns);
      logger?.info?.(`backlog: skipped ${skippedTurns} older turns (batch keeps latest ${batchTurns.size})`);
    }
    const maxTurnId = Math.max(...turnsToSend.map((p) => p.turnId));
    flushing = true;
    emit('start', { turns: new Set(turnsToSend.map((p) => p.turnId)).size });
    try {
      const connection = resolveLlmConfig({ cfg, selection, env });
      if (!connection.ok) throw new Error(connection.error);
      const startedAt = now();
      const messages = buildPrompt({ turns: turnsToSend, cfg, logger });
      const raw = await callExtractor({ connection, messages, transport: send });
      // 入库前向量判重：近重复丢掉、值被改写则软覆盖旧条目、同话题超量不进库；
      // embedding 挂了整道闸放行（判重是省钱优化，不能变成丢记忆的闸门）
      const gate = await dedupItems({ index, store, embedder, cfg, items: raw, logger });
      if (gate.dropped.length) {
        logger?.info?.(`dedup: -${gate.dropped.length}/${raw.length} (${gate.dropped.map((d) => d.reason).join('; ')})`);
      }
      if (gate.superseded.length) {
        logger?.info?.(`supersede: ${gate.superseded.map((s) => `${s.oldId}<-${s.score}`).join(', ')}`);
      }
      const out = commitExtraction({
        store, items: gate.items, maxTurnId, day,
        memoryCfg: cfg.memory ?? {},
        scopeId: cfg.scope_id,
        dropped: gate.dropped.length,
        elapsedMs: now() - startedAt,
      });

      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].turnId <= maxTurnId) pending.splice(i, 1);
      }
      for (const id of completed) if (id <= maxTurnId) completed.delete(id);

      emit('success', { count: out.inserted.length, superseded: out.superseded.length });
      if (out.inserted.length) onInserted?.();
      logger?.info?.(
        `extraction: +${out.inserted.length} (${out.deduped.length} dup, ${out.superseded.length} superseded), `
        + `cursor ${maxTurnId}, ${now() - startedAt}ms`,
      );
    } catch (err) {
      // 游标不动，池不清，下次空闲自动重提；失败事件不对外提示
      // 失败也算一次提炼尝试，否则解析一直失败会每 5 分钟重试、绕过每日上限
      try {
        bumpExtractionCount({ store, day });
      } catch {}
      try {
        bumpStat(store, STAT_KEYS.totalFailed);
        bumpStat(store, STAT_KEYS.lastFailed, 1, 'set');
        store.setMeta(STAT_KEYS.lastAt, new Date(now()).toISOString());
      } catch {}
      logger?.warn?.(`extraction failed: ${err?.message ?? err}`);
      emit('failed', { reason: String(err?.message ?? err) });
    } finally {
      flushing = false;
      if (!disposed && pending.some((p) => p.turnId > cursor(store))) arm();
    }
  }

  /** 提炼预览：只拼 prompt、不调模型（改 prompt 时用它核对，不烧额度） */
  const previewPrompt = () => {
    const from = cursor(store);
    const ready = pending.filter((p) => p.turnId > from && completed.has(p.turnId));
    const byTurn = new Map();
    for (const p of ready) {
      if (!byTurn.has(p.turnId)) byTurn.set(p.turnId, []);
      byTurn.get(p.turnId).push(p);
    }
    const usable = [...byTurn.values()].filter((g) => g.some((p) => p.role !== 'assistant'));
    const turns = usable.flat();
    const perBatch = Math.max(0, Math.round(Number(cfg.capture?.max_turns_per_extract ?? 0)));
    let picked = turns;
    if (perBatch > 0) {
      const ids = [...new Set(turns.map((p) => p.turnId))].sort((a, b) => b - a).slice(0, perBatch);
      const keep = new Set(ids);
      picked = turns.filter((p) => keep.has(p.turnId));
    }
    if (!picked.length) {
      return {
        turns: 0, pending: pending.length, systemChars: 0, userChars: 0, totalChars: 0, estTokens: 0,
        text: '(池里没有已完成的轮次：下一次空闲还没有可提炼的内容)',
      };
    }
    const messages = buildPrompt({ turns: picked, cfg, logger });
    const systemChars = messages[0]?.content?.length ?? 0;
    const userChars = messages[1]?.content?.length ?? 0;
    return {
      turns: new Set(picked.map((p) => p.turnId)).size,
      pending: pending.length,
      systemChars,
      userChars,
      totalChars: systemChars + userChars,
      estTokens: Math.round((systemChars + userChars) / 1.6),
      text: `${messages[0].content}\n\n---- user ----\n${messages[1].content}`,
    };
  };

  return {
    setSelection,
    beginTurn,
    onMessage,
    completeTurn,
    flush,
    previewPrompt,
    events,
    get state() {
      return {
        turnCounter,
        currentTurnId,
        pending: pending.length,
        completed: completed.size,
        flushing,
        disposed,
      };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending.length = 0;
      completed.clear();
    },
  };
}

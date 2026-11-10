// 触发层：待提炼池 + 唯一触发（空闲 debounce）+ flush 编排。
// 池内原文只在内存，不持久化、不补提；失败静默重试，绝不与主对话请求排队。
import { isWorthKeeping } from './capture.mjs';
import { localDate } from './text.mjs';
import { hybridSearch } from './search.mjs';
import { resolveLlmConfig, buildPrompt, callExtractor } from './extractor.mjs';
import { createHttpTransport } from './http.mjs';
import {
  ensureExtractionSchema, cursor, dailyExtractions, bumpExtractionCount, commitExtraction,
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
    }, Math.max(1, Number(cfg.capture?.idleMs ?? 300000)));
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
    pending.push({ turnId, role, text: String(text), ts: now() });
  };

  /** 一轮完成（assistant 回复结束）时刻，也是空闲起算点 */
  const completeTurn = () => {
    if (currentTurnId === null) return;
    completed.add(currentTurnId);
    currentTurnId = null;
    arm();
  };

  /** 用现有召回机制取回相关已有记忆，只作参考块；失败就给空块 */
  async function recallExisting(turns) {
    const query = turns.map((t) => t.text).join('\n').slice(0, 1500);
    try {
      const res = await hybridSearch({ store, index, embedder, cfg, query, limit: 5 });
      return res.items.map((item) => String(item.content).replace(/\s+/g, ' ').slice(0, 200));
    } catch (err) {
      logger?.debug?.(`recall for extraction skipped: ${err?.message ?? err}`);
      return [];
    }
  }

  async function flush() {
    if (disposed || flushing) return; // 重入锁
    const from = cursor(store);
    const ready = pending.filter((p) => p.turnId > from && completed.has(p.turnId));
    if (!ready.length) return; // 只处理已完成的轮次

    const day = localDate(new Date(now()));
    const cap = Math.max(1, Number(cfg.capture?.maxDailyExtractions ?? 50));
    if (dailyExtractions(store, day) >= cap) return;

    const maxTurnId = Math.max(...ready.map((p) => p.turnId));
    flushing = true;
    emit('start', { turns: new Set(ready.map((p) => p.turnId)).size });
    try {
      const connection = resolveLlmConfig({ cfg, selection, env });
      if (!connection.ok) throw new Error(connection.error);
      const existing = await recallExisting(ready);
      const messages = buildPrompt({ turns: ready, existing });
      const items = await callExtractor({ connection, messages, transport: send });
      const out = commitExtraction({
        store, items, maxTurnId, day,
        memoryCfg: cfg.memory ?? {},
        scopeId: cfg.scope_id,
      });

      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].turnId <= maxTurnId) pending.splice(i, 1);
      }
      for (const id of completed) if (id <= maxTurnId) completed.delete(id);

      emit('success', { count: out.inserted.length });
      if (out.inserted.length) onInserted?.();
      logger?.info?.(`extraction: +${out.inserted.length} (${out.deduped.length} dup), cursor ${maxTurnId}`);
    } catch (err) {
      // 游标不动，池不清，下次空闲自动重提；失败事件不对外提示
      // 失败也算一次提炼尝试，否则解析一直失败会每 5 分钟重试、绕过每日上限
      try {
        bumpExtractionCount({ store, day });
      } catch {}
      logger?.warn?.(`extraction failed: ${err?.message ?? err}`);
      emit('failed', { reason: String(err?.message ?? err) });
    } finally {
      flushing = false;
      if (!disposed && pending.some((p) => p.turnId > cursor(store))) arm();
    }
  }

  return {
    setSelection,
    beginTurn,
    onMessage,
    completeTurn,
    flush,
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

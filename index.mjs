// dsh-alice-memory-llm — DSH 长期记忆插件（LLM 提炼支线，零依赖 Node 实现）
//
// 与主线 dsh-alice-memory（v3.x，逐条规则捕获）的关系：
//  - 同源分支，数据格式与库文件布局兼容，共用 $DSH_HOME/alice-memory
//  - 区别只在「记什么」：这里交给空闲后的 LLM 批量提炼，主线靠规则闸门
//  - 代价是每次提炼一次主模型调用，主线是 0 次
//
// 设计要点：
//  - 零依赖：引擎与插件同进程，用 node:sqlite，不 spawn 外部解释器
//  - 分层热度：hot/warm 常驻内存，cold 留磁盘按需补扫
//  - 检索走 FTS5 + 向量 RRF 融合，冷层由 worker 线程兜底
//  - 空闲批量提炼：粗筛入池 → 独立 LLM 请求 → 单事务写条目 + 推进游标
//  - 只存提炼条目不存原文；仅保留 sha256 完全一致去重；异步补向量、失败自动 backfill
//  - 四个显式工具：记 / 回忆 / 忘 / 清冷记忆
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { Store } from './lib/store.mjs';
import { VectorIndex } from './lib/vector-index.mjs';
import { HttpEmbedder } from './lib/embedding.mjs';
import { loadIndex, runBackfill } from './lib/capture.mjs';
import { recallForPrompt } from './lib/recall.mjs';
import { remember, forget, prunePreview, pruneApply, listEntries, forgetMany, mergeMemories } from './lib/ops.mjs';
import { tidyScan, writeAnchor } from './lib/tidy.mjs';
import { createCapturePool } from './lib/pool.mjs';

export const name = 'alice-memory-llm';
export const inject = ['tools'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = Object.freeze({ kind: 'plugin:alice-memory-llm', form: 'recall' });
const REVOKE_PATTERN = /^[/／](记忆撤销|记忆撤回|memory-revoke)\s*$/i;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export function apply(ctx, config) {
  const logger = createLogger(config?.log_level ?? process.env.ALICE_MEMORY_LOG ?? 'warn');
  const cfg = loadConfig(config ?? {}, { env: process.env });
  const store = new Store({
    dataDir: cfg.dataDir,
    dimensions: cfg.embedding.dimensions,
    model: cfg.embedding.model,
    scopeId: cfg.scope_id,
    logger,
  });
  const index = new VectorIndex(cfg.embedding.dimensions);
  const embedder = new HttpEmbedder(cfg.embedding, { logger });
  const pool = createCapturePool({
    store, index, embedder, cfg, logger, ctx,
    onInserted: () => { void backfillNow(); },
  });

  const injected = new Map();   // sessionId -> Set(ids) 本轮已注入

  let disposed = false;
  let sweeping = false;

  const sweepNow = () => {
    if (disposed || sweeping) return;
    sweeping = true;
    try {
      const out = store.sweep({ memoryCfg: cfg.memory });
      // 自愈：迁移中断/半截写入会留下孤儿向量，条数对不上才去扫，平时零成本
      if (store.countVectors() !== store.countAll()) {
        const orphans = store.pruneOrphanVectors();
        if (orphans) logger.warn(`removed ${orphans} orphan vectors`);
      }
      if (out.changed) {
        // tier 变了就得整体重建，逐条改索引会慢 100 倍
        index.clear();
        loadIndex({ store, index, cfg, logger });
      }
      if (out.changed) logger.info(`sweep: ${out.changed}/${out.scanned} rows moved tier`);
    } catch (err) {
      logger.warn(`sweep failed: ${err?.message ?? err}`);
    } finally {
      sweeping = false;
    }
  };

  const backfillNow = async () => {
    if (disposed) return;
    try {
      const out = await runBackfill({ store, index, embedder, cfg, logger });
      if (out.ok) logger.info(`backfill: +${out.ok} vectors (${out.failed} failed)`);
    } catch (err) {
      logger.warn(`backfill failed: ${err?.message ?? err}`);
    }
  };

  // 启动：先挂库，再灌热区，最后开定时器
  try {
    logger.info(`activated: ${store.countAll()} memories, data ${cfg.dataDir}`);
  } catch (err) {
    logger.error(`store init failed: ${err?.message ?? err}`);
  }

  const loadTimer = setTimeout(() => {
    try {
      loadIndex({ store, index, cfg, logger });
    } catch (err) {
      logger.warn(`hot index load failed: ${err?.message ?? err}`);
    }
    sweepNow();
  }, 0);
  loadTimer.unref?.();

  const sweepTimer = setInterval(sweepNow, Math.max(1, cfg.memory.sweep_hours ?? 6) * 3600_000);
  sweepTimer.unref?.();
  const backfillTimer = setInterval(backfillNow, Math.max(1, cfg.capture.embed_retry_minutes) * 60_000);
  backfillTimer.unref?.();

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', async () => {
      disposed = true;
      clearTimeout(loadTimer);
      clearInterval(sweepTimer);
      clearInterval(backfillTimer);
      try { pool.dispose(); } catch {}
      try { store.close(); } catch {}
      try { await index.close(); } catch {}
    });
  }

  // ---------- 1. 每轮召回 ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (disposed) return decision;
      if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision;
      pool.setSelection(payload?.modelSelection);
      const session = payload.agent?.session;
      const sessionId = session?.header?.id ?? session?.id;
      if (!sessionId) return decision;

      const userMessage = decision.messages?.find(
        (m) => m?.source?.kind === 'user' || m?.role === 'user',
      );
      const prompt = extractText(userMessage?.content).trim();
      if (!prompt || REVOKE_PATTERN.test(prompt)) return decision;

      const seen = injected.get(sessionId) ?? new Set();
      injected.set(sessionId, seen);
      if (injected.size > 64) injected.delete(injected.keys().next().value);

      const res = await recallForPrompt({
        store, index, embedder, cfg, logger,
        query: prompt,
        excludeIds: seen,
      });
      if (!res.count) return decision;
      for (const item of res.items) seen.add(item.id);

      logger.info(`recall: ${res.count} items in ${res.timings?.total ?? 0}ms (${res.items.map((i) => i.via).join(',')})`);

      const block = {
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: `[alice-memory-llm: recall]\n${res.context}\n(reference only — fold in naturally if relevant)`,
        }],
        source: SOURCE,
      };
      return { ...decision, messages: [...decision.messages, block] };
    } catch (err) {
      logger.warn(`recall error: ${err?.stack ?? err}`);
      return decision;
    }
  }, { prepend: true });

  // ---------- 2. 粗筛入池 + 空闲提炼 ----------
  ctx.on('session/event', (_session, event) => {
    if (disposed || !event) return;
    try {
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return;
        const text = extractText(event.data?.content).trim();
        if (REVOKE_PATTERN.test(text)) return; // 撤销命令整轮不进池
        pool.beginTurn();
        pool.onMessage('user', text);
        return;
      }
      if (event.type === 'assistant/message') {
        const text = extractText(event.data?.message?.content).trim();
        if (text) pool.onMessage('assistant', text);
        return;
      }
      if (event.type === 'turn/end') pool.completeTurn();
    } catch (err) {
      logger.warn(`event error: ${err?.message ?? err}`);
    }
  });

  // ---------- 3. 显式工具 ----------
  const textBlock = (text) => [{ type: 'text', text }];

  ctx.tools.register({
    name: 'alice_memory_save',
    description:
      '把用户明确要求记住的事写进长期记忆库。用户说「记一下」「记住」「存进记忆」时调用；普通对话不要自作主张调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要记住的内容，写成完整自足的陈述句；路径、命令、数字、结论都保留。' },
        title: { type: 'string', description: '可选短标题。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          deduped: { type: 'boolean' },
          vector: { type: 'boolean' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, v) {
        if (!v.ok) return textBlock(`写入失败：${v.error ?? '未知错误'}`);
        if (v.deduped) return textBlock(`这条已经在库里了：${v.id ?? ''}`);
        return textBlock(`已记下：${v.summary ?? ''}（${v.id ?? ''}${v.vector ? '，含向量' : '，暂无向量'}）`);
      },
    },
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('text 不能为空');
      return remember({ store, index, embedder, cfg, logger, text, title: args?.title });
    },
  });

  ctx.tools.register({
    name: 'alice_memory_recall',
    description:
      '主动检索长期记忆。用户说「回忆一下」「之前那个」「你还记得吗」「翻一下记忆」时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索用的问题或关键词，写具体一点。' },
        limit: { type: 'integer', description: '最多返回几条，默认 5。' },
        include_cold: { type: 'boolean', description: '是否强制补扫冷层（默认只在热区命中不足时扫）。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          context: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, v) {
        if (!v.ok) return textBlock(`检索失败：${v.error ?? '未知错误'}`);
        if (!v.count) return textBlock('没有命中的记忆。');
        return textBlock(v.context ?? '');
      },
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('query 不能为空');
      const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 20) : 5;
      const res = await recallForPrompt({
        store, index, embedder, cfg, logger,
        query, limit,
        forceCold: args?.include_cold === true,
      });
      return { ok: true, count: res.count, context: res.context };
    },
  });

  ctx.tools.register({
    name: 'alice_memory_forget',
    description:
      '删除记忆条目及其向量。用户说「删掉关于 X 的记忆」「忘掉这条」时调用。给 id 精确删；给 query 按关键词删（默认只列命中，需 confirm 才真删）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        query: { type: 'string', description: '关键词，至少两个字。默认只列命中不删，需再带 confirm。' },
        confirm: { type: 'boolean', description: '配合 query 使用；确认命中项全部要删时才置 true。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'integer' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, v) {
        if (!v.ok) return textBlock(`删除失败：${v.error ?? '未知错误'}`);
        return textBlock(v.summary ?? `已删除 ${v.removed ?? 0} 条`);
      },
    },
    execute(args) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!id && !query) throw new Error('id 和 query 至少给一个');
      const res = forget({ store, index, cfg, id, query, confirm: args?.confirm === true });
      if (!res.ok) return res;
      if (res.pendingConfirm) {
        const detail = res.events.map((e) => `· ${e.content}`).join('\n');
        return {
          ok: false,
          removed: 0,
          summary: `关键词命中 ${res.events.length} 条，还没删。看清楚再决定：\n${detail}\n\n确认要全删就带 confirm=true 再调一次；只想删其中几条，改用 alice_memory_tidy 的 delete。`,
        };
      }
      const detail = res.events.map((e) => `· ${e.content}`).join('\n');
      return {
        ok: true,
        removed: res.removed,
        summary: res.events.length
          ? `删了 ${res.events.length} 条，正文和向量一起清：\n${detail}`
          : '没有匹配到可删的条目。',
      };
    },
  });

  ctx.tools.register({
    name: 'alice_memory_prune',
    description:
      '清理长期没被用到的冷记忆。用户说「清理记忆」「整理记忆」「清一清冷记忆」时，把这个当选项提出来给他选。默认只预览不动手，返回候选数量、占用空间和 confirm_token；用户点头后再带 token 调用才真删。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        older_than_days: { type: 'integer', description: '多久没用算冷，默认 90 天。' },
        confirm_token: { type: 'string', description: '预览时拿到的 token，带上它才会真删。' },
        force: { type: 'boolean', description: '跳过 token 校验直接删，用户明确说「不用看直接删」才用。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          preview: { type: 'boolean' },
          total: { type: 'integer' },
          removed: { type: 'integer' },
          bytes: { type: 'integer' },
          token: { type: 'string' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, v) {
        if (!v.ok) return textBlock(`清理失败：${v.error ?? '未知错误'}`);
        return textBlock(v.summary ?? '');
      },
    },
    execute(args) {
      const days = Number.isInteger(args?.older_than_days) ? Math.max(1, args.older_than_days) : 90;
      if (args?.confirm_token || args?.force === true) {
        const out = pruneApply({
          store, index, cfg,
          olderThanDays: days,
          token: typeof args?.confirm_token === 'string' ? args.confirm_token : '',
          force: args?.force === true,
        });
        if (!out.ok) return { ok: false, error: out.error, preview: false };
        return {
          ok: true,
          preview: false,
          removed: out.removed,
          bytes: out.bytesFreed ?? 0,
          summary: out.removed
            ? `清掉了 ${out.removed} 条冷记忆，释放约 ${(out.bytesFreed / 1024).toFixed(1)} KB。`
            : '没有符合条件的冷记忆，一条没删。',
        };
      }
      const out = prunePreview({ store, cfg, olderThanDays: days });
      const sample = out.samples.slice(0, 5).map((s) => `· [${s.date}] ${s.content}`).join('\n');
      return {
        ok: true,
        preview: true,
        total: out.total,
        bytes: out.bytes,
        token: out.token,
        summary: out.total
          ? `有 ${out.total} 条冷记忆超过 ${days} 天没被用过，合计 ${(out.bytes / 1024).toFixed(1)} KB：\n${sample}\n\n要顺手带走吗？点头我就删（token ${out.token}）。`
          : `没有超过 ${days} 天没被用过的冷记忆，库很干净。`,
      };
    },
  });

  // 整理记忆库：一个入口三个动作。默认全部只出 diff，apply 才落地。
  ctx.tools.register({
    name: 'alice_memory_tidy',
    description:
      '整理长期记忆库。用户说「整理记忆」「清理记忆库」「合并重复的记忆」时用。' +
      'action=scan 出候选（重复簇 / 空壳 / 久未用），action=delete 按 id 批删，action=merge 把多条并成一条新总结。' +
      '默认只出 diff 不动手，确认后带 apply=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['scan', 'list', 'delete', 'merge'], description: '要做的事。' },
        apply: { type: 'boolean', description: '真正落地；不传则只预览。' },
        ids: { type: 'array', items: { type: 'string' }, description: 'delete / merge 的目标 id。' },
        content: { type: 'string', description: 'merge 时新写的总结正文。' },
        since: { type: 'string', description: 'scan 的增量起点（ISO 时间）；缺省读上次整理的锚点。' },
        keyword: { type: 'string', description: 'list 时按关键词过滤。' },
        tier: { type: 'string', enum: ['hot', 'warm', 'cold', 'archive'], description: 'list 时按分层过滤。' },
        limit: { type: 'integer', description: 'list 每页条数，默认 50。' },
        offset: { type: 'integer', description: 'list 翻页偏移。' },
        threshold: { type: 'number', description: 'scan 的自动合并阈值，默认 0.92。' },
        lower: { type: 'number', description: 'scan 的候选阈值，默认 0.78。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          applied: { type: 'boolean' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render(_args, v) {
        if (!v.ok) return textBlock(`整理失败：${v.error ?? '未知错误'}`);
        return textBlock(v.summary ?? '');
      },
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'scan';
      const apply = args?.apply === true;

      if (action === 'list') {
        const out = listEntries({
          store,
          keyword: typeof args?.keyword === 'string' ? args.keyword : '',
          tier: typeof args?.tier === 'string' ? args.tier : '',
          limit: Number.isInteger(args?.limit) ? args.limit : 50,
          offset: Number.isInteger(args?.offset) ? args.offset : 0,
        });
        const body = out.items
          .map((i) => `· ${i.id} [${i.date}]${i.pinned ? ' 📌' : ''} ${i.content}`)
          .join('\n');
        return {
          ok: true,
          action,
          applied: false,
          summary: out.total
            ? `共 ${out.total} 条，这页 ${out.count} 条${out.hasMore ? '（还有下一页）' : ''}：\n${body}`
            : '没有符合条件的条目。',
        };
      }

      if (action === 'scan') {
        const out = tidyScan({
          store,
          since: typeof args?.since === 'string' ? args.since : '',
          threshold: Number.isFinite(args?.threshold) ? Number(args.threshold) : 0.92,
          lower: Number.isFinite(args?.lower) ? Number(args.lower) : 0.78,
        });
        const lines = [];
        const w = out.window;
        lines.push(`窗口 ${w.since ? `自 ${w.since}` : '全库'}，扫 ${w.count}/${w.total} 条`);
        lines.push(
          `空壳 ${out.summary.shells} · 重复候选 ${out.summary.clusters} 组（其中自动档 ${out.summary.autoClusters} 组）· 久未用 ${out.summary.stale}`,
        );
        if (out.shells.length) {
          lines.push('\n【空壳，可直接删】');
          for (const s of out.shells) lines.push(`· ${s.id} [${s.date}] ${s.content}`);
        }
        if (out.clusters.length) {
          lines.push('\n【重复候选，需你判断能否合并】');
          for (const g of out.clusters) {
            lines.push(`${g.auto ? '★自动档' : '候选'} 相似度 ${g.minScore}，${g.size} 条：`);
            for (const m of g.members) lines.push(`   · ${m.id} [${m.date}]${m.pinned ? ' 📌' : ''} ${m.content}`);
          }
        }
        if (out.stale.length) {
          lines.push('\n【久未用】');
          for (const s of out.stale.slice(0, 10)) lines.push(`· ${s.id} ${s.days ?? '?'}天 ${s.content}`);
        }
        return { ok: true, action, applied: false, summary: lines.join('\n') };
      }

      if (action === 'delete') {
        const ids = Array.isArray(args?.ids) ? args.ids.filter((x) => typeof x === 'string') : [];
        if (!ids.length) return { ok: false, error: 'delete 需要 ids' };
        if (!apply) {
          const found = ids.map((id) => store.getMemory(id)).filter(Boolean);
          const body = found.map((r) => `· ${r.id} [${r.local_date}] ${String(r.content).slice(0, 80)}`).join('\n');
          return {
            ok: true,
            action,
            applied: false,
            summary: found.length
              ? `将删除 ${found.length} 条（还没动）：\n${body}\n\n确认后带 apply=true。`
              : '这些 id 在库里都不存在。',
          };
        }
        const out = forgetMany({ store, index, ids });
        writeAnchor({ store });
        return {
          ok: true,
          action,
          applied: true,
          summary: `已删除 ${out.removed} 条，正文和向量一起清。`,
        };
      }

      if (action === 'merge') {
        const ids = Array.isArray(args?.ids) ? args.ids.filter((x) => typeof x === 'string') : [];
        const content = typeof args?.content === 'string' ? args.content : '';
        if (ids.length < 2) return { ok: false, error: 'merge 至少需要两个 ids' };
        const out = await mergeMemories({
          store, index, embedder, cfg, logger,
          ids, content, dryRun: !apply || !content,
        });
        if (!out.ok) return { ok: false, error: out.error };
        if (out.dryRun) {
          const body = out.sources.map((s) => `· ${s.id} [${s.date}] ${s.content}`).join('\n');
          return {
            ok: true,
            action,
            applied: false,
            summary: content
              ? `将合并这 ${out.sources.length} 条并删掉源条目（还没动）：\n${body}\n\n确认后带 apply=true。`
              : `将合并这 ${out.sources.length} 条，但还缺合并后的正文 content：\n${body}`,
          };
        }
        writeAnchor({ store });
        return {
          ok: true,
          action,
          applied: true,
          summary: `合并完成：新条目 ${out.id}，删掉 ${out.removed} 条源条目${out.vector ? '，向量已生成' : '，向量待补'}。`,
        };
      }

      return { ok: false, error: `未知 action: ${action}` };
    },
  });
}

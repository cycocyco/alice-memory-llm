// 提炼状态广播：给浏览器一个「现在到底在不在提炼」的实时信号。
//
// 为什么要有这一层：提炼发生在宿主进程里（池 → LLM），浏览器半侧本来什么都
// 看不到，而内核不转发第三方插件的自定义事件。所以自己开一条 SSE：
// 状态只在内存里，页面连上来先收一份当前快照，之后每次 start/success/failed
// 都推一帧。没有历史、没有重放、没有持久化——UI 只需要「此刻」。
//
// 三条纪律：
//  - 只认 loopback：这条路由不校验 cookie/Origin，和 webServer 的 resource 一样
//    必须由调用方自己准入读者。
//  - 永远不抛：串口写完就扔，浏览器断了只记账不报警。
//  - 失败就是失败：phase 只有 working/success/failed，不带错误原文给 UI，
//    免得有人手贱把「失败原因」弹成红色横幅。
export const STATUS_ROUTE = '/alice-memory-llm/status';

/** 心跳间隔：防止中间有代理把空闲连接掐掉。 */
const KEEPALIVE_MS = 25_000;
/** working 帧超过这么久没被推翻，说明上次提炼随进程死掉了，按 idle 处理。 */
const STALE_WORKING_MS = 5 * 60_000;
/** success / failed 是终点，广播完这么久就落回 idle，免得后来打开的页面再看一遍绿圈。 */
const SETTLE_MS = 6_000;

const IDLE = Object.freeze({ phase: 'idle', at: 0 });

/** 只接受本机回环地址。地址缺失（in-process 读）按放行处理。 */
function isLoopback(address) {
  if (address === undefined || address === '') return true;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/**
 * 建一个进程内状态广播器。
 * @param {object} [options]
 * @param {{debug?:Function,warn?:Function,info?:Function,error?:Function}} [options.logger]
 * @param {() => number} [options.now] 注入时钟，测试用。
 * @param {number} [options.settleMs] 终态落回 idle 的时长，测试用。
 */
export function createCaptureStatus({ logger, now = () => Date.now(), settleMs = SETTLE_MS } = {}) {
  let frame = IDLE;
  /** 活跃的 SSE 响应；断连就摘掉。 */
  const listeners = new Set();
  let settleTimer = null;
  let disposed = false;

  const sse = (payload) => `event: status\ndata: ${JSON.stringify(payload)}\n\n`;

  const write = (res, payload) => {
    if (disposed) return;
    try {
      res.write(sse(payload));
    } catch (err) {
      logger?.debug?.(`status: write failed: ${err?.message ?? err}`);
    }
  };

  /**
   * 当前对外快照。卡在 working 太久的那一帧不发给新页面：
   * 提炼随进程崩溃会留下一个永不结束的转圈，用户会以为一直卡着。
   */
  const snapshot = () => {
    if (frame.phase === 'working' && now() - frame.at > STALE_WORKING_MS) return IDLE;
    return frame;
  };

  /** 更新状态并广播。phase: 'working' | 'success' | 'failed' | 'idle' */
  const set = (phase, extra = {}) => {
    if (disposed) return frame;
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    frame = { phase, at: now(), ...extra };
    // 终态广播完就排好回协调，别让晚到的页面再看见一轮转圈/绿圈。
    if (phase === 'success' || phase === 'failed') {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        set('idle');
      }, settleMs);
      settleTimer.unref?.();
    }
    for (const res of listeners) write(res, frame);
    return frame;
  };

  /** webServer 的 route handler：独占响应生命周期（SSE 会一直挂着）。 */
  const serve = (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('loopback only');
      return;
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }

    res.write(': connected\n\n');
    listeners.add(res);
    write(res, snapshot());

    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // 对端已经没了，close 事件会负责摘。
      }
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearInterval(keepalive);
      listeners.delete(res);
    };
    res.on('close', drop);
    res.on('error', drop);
  };

  return {
    set,
    snapshot,
    serve,
    get phase() {
      return frame.phase;
    },
    get listeners() {
      return listeners.size;
    },
    dispose() {
      disposed = true;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      for (const res of listeners) {
        try {
          res.end();
        } catch {}
      }
      listeners.clear();
      frame = IDLE;
    },
  };
}

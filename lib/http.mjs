// 原生 HTTP 传输：HTTP 请求只走 node:http / node:https 直连。
//
// 为什么不用 globalThis.fetch：DSH 后端把全局 fetch 换成了自己的 carrierFetch
// （见 @deepseek-ai/dsh-llm 里的 `globalThis.fetch = carrierFetch`），它的响应形状
// 和标准 fetch 不同。实测表现是提炼请求能拿到 200，但 choices[0].message.content
// 为空，日志里一直报 "extractor returned no content"。原生 socket 不受宿主劫持影响。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * @param {number} timeoutMs 整条请求（连接 + 读完 body）的超时
 * @returns {(url: string, init: {method?: string, headers?: object, body?: string}) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>}
 */
export function createHttpTransport({ timeoutMs = 30000 } = {}) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch {
        reject(new Error(`invalid url: ${url}`));
        return;
      }
      const secure = target.protocol === 'https:';
      const mod = secure ? httpsRequest : httpRequest;
      const body = init.body ?? '';
      const headers = { ...(init.headers ?? {}) };
      // 必须显式给 content-length。不给的话 Node 走 chunked，而对方网关对分块上传的
      // 处理极慢——同一个 embedding 接口实测：chunked 9.9s、带长度 0.2s，差 50 倍，
      // 慢到会先撞上 embedding 的 3.5s 超时，表现为「向量永远生成不出来」。
      if (body && headers['content-length'] === undefined) {
        headers['content-length'] = Buffer.byteLength(body, 'utf8');
      }
      // 不复用连接：跨境 TLS 链路上一旦拿到被对端静默丢弃的 keep-alive socket，
      // 表现就是等几十秒后 ECONNRESET。新建连接只多一次握手（实测 0.2~0.5s），
      // 比踩到僵连接后重试整批划算得多。
      if (headers.connection === undefined) headers.connection = 'close';
      const req = mod(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'POST',
          headers,
          agent: false,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout ${timeoutMs}ms`)));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
}
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
      const req = mod(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'POST',
          headers: init.headers ?? {},
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
      req.write(init.body ?? '');
      req.end();
    });
}
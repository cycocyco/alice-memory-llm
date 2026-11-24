// 原生 HTTP 传输：HTTP 请求只走 node:http / node:https 直连。
//
// 为什么不用 globalThis.fetch：DSH 后端把全局 fetch 换成了自己的 carrierFetch
// （见 @deepseek-ai/dsh-llm 里的 `globalThis.fetch = carrierFetch`），它的响应形状
// 和标准 fetch 不同。实测表现是提炼请求能拿到 200，但 choices[0].message.content
// 为空，日志里一直报 "extractor returned no content"。原生 socket 不受宿主劫持影响。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// 域名解析结果缓存。跨境链路上 sslip.io 这类通配符域名解析可能要好几秒，
// 而每次请求都是新连接（agent: false），不缓存就等于每次重付一次解析成本。
const DNS_TTL_MS = 10 * 60_000;
const dnsCache = new Map(); // hostname -> { ip, family, at }

async function resolveHost(hostname) {
  if (isIP(hostname)) return { ip: hostname, family: isIP(hostname), at: Date.now() };
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit;
  // 优先 IPv4：双栈环境下解析器可能先给 ::1 / IPv6，而很多服务只监听 IPv4，
  // 直接连会 ECONNREFUSED。没有 A 记录时才退回 IPv6。
  const all = await lookup(hostname, { all: true, verbatim: true });
  const pick = all.find((a) => a.family === 4) ?? all[0];
  if (!pick) throw new Error(`DNS 解析无结果：${hostname}`);
  const entry = { ip: pick.address, family: pick.family, at: Date.now() };
  dnsCache.set(hostname, entry);
  return entry;
}

/** 只给测试用：清掉解析缓存 */
export function clearDnsCache() {
  dnsCache.clear();
}

/**
 * @param {number} timeoutMs 整条请求的**绝对**时限：DNS + 建连 + 握手 + 读完 body
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
      // 慢到会先撞上 embedding 的超时，表现为「向量永远生成不出来」。
      if (body && headers['content-length'] === undefined) {
        headers['content-length'] = Buffer.byteLength(body, 'utf8');
      }
      // 不复用连接：跨境 TLS 链路上一旦拿到被对端静默丢弃的 keep-alive socket，
      // 表现就是等几十秒后 ECONNRESET。新建连接只多一次握手，比踩僵连接划算。
      if (headers.connection === undefined) headers.connection = 'close';

      let settled = false;
      let req = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn(value);
      };
      // 绝对截止时间。req.setTimeout 是**空闲**超时：只要对端还在慢速滴数据，
      // 它就永远不触发，而总耗时早就超了。这里用独立计时器兜死。
      const deadline = setTimeout(() => {
        try { req?.destroy(); } catch {}
        settle(reject, new Error(`request deadline ${timeoutMs}ms`));
      }, timeoutMs);

      resolveHost(target.hostname).then(
        (conn) => {
          if (settled) return;
          const options = {
            protocol: target.protocol,
            hostname: conn.ip, // 连 IP，绕开每次解析
            port: target.port || (secure ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: init.method ?? 'POST',
            headers,
            agent: false,
          };
          // 用 IP 连接时 Host 头会变成 IP，证书校验也会失去域名依据，
          // 所以按原域名补回 Host 与 SNI。
          if (!isIP(target.hostname)) {
            if (headers.host === undefined) options.headers = { ...headers, host: target.host };
            if (secure) options.servername = target.hostname;
          }
          req = mod(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('error', (err) => settle(reject, err));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const status = res.statusCode ?? 0;
              settle(resolve, { ok: status >= 200 && status < 300, status, text: async () => text });
            });
          });
          req.on('error', (err) => {
            // 连接层面的失败多半是解析到的地址不通，下次换个新鲜结果
            dnsCache.delete(target.hostname);
            settle(reject, err);
          });
          req.write(body);
          req.end();
        },
        (err) => settle(reject, err),
      );
    });
}

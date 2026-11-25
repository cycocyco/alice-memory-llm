// Embedding 客户端。只有 http 一种实现，接口留白给以后的本地模型 sidecar。
// 契约：embedDocs(texts) / embedQuery(text) → { ok, vectors?, error? }
//
// 走原生 socket 而不是 globalThis.fetch：后端把全局 fetch 换成了宿主的 carrierFetch，
// 响应不可靠（详见 lib/http.mjs）。
import { createHttpTransport } from './http.mjs';
import { withAiLock } from './ai-lock.mjs';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpEmbedder {
  #queryCache = new Map();
  #queryCacheMax = 100;

  constructor(embeddingCfg, { transport = null, logger = null } = {}) {
    this.cfg = embeddingCfg;
    this.transport = transport ?? createHttpTransport({ timeoutMs: embeddingCfg.timeout_ms ?? 3500 });
    this.logger = logger;
    this.name = `http:${embeddingCfg.model}`;
  }

  get ready() {
    // 三者缺一就不算就绪。没配的时候召回自动退化成纯关键词，不会报错也不会发请求。
    return Boolean(this.cfg.apiKey && this.transport && this.cfg.url && this.cfg.model);
  }

  async embedDocs(texts, opts = {}) {
    return this.#embed(texts.map((t) => `${this.cfg.docPrefix ?? ''}${truncate(t, this.cfg.max_input_chars)}`), opts);
  }

  async embedQuery(text, opts = {}) {
    const key = `${this.cfg.queryPrefix ?? ''}${truncate(text, this.cfg.max_input_chars)}`;
    const cached = this.#queryCache.get(key);
    if (cached) {
      this.#queryCache.delete(key);
      this.#queryCache.set(key, cached);
      // 返回副本：调用方（hybridSearch）拿到后就地做 normalizeInPlace，
      // 直接交引用等于让缓存跟着被改。归一化虽然幂等，但别把正确性赌在幂等上。
      return { ok: true, vectors: [Float32Array.from(cached)] };
    }
    const res = await this.#embed([key], opts);
    if (res.ok && res.vectors?.[0]) {
      if (this.#queryCache.size >= this.#queryCacheMax) {
        const oldest = this.#queryCache.keys().next().value;
        this.#queryCache.delete(oldest);
      }
      // 存原始快照（不走引用），缓存里永远是模型吐出来的原样
      this.#queryCache.set(key, Float32Array.from(res.vectors[0]));
    }
    return res;
  }

  async #embed(inputs, opts = {}) {
    if (!inputs.length) return { ok: true, vectors: [] };
    if (!this.cfg.apiKey) return { ok: false, error: 'missing api key (set it in DSH_HOME/.env)' };
    if (!this.cfg.url) return { ok: false, error: 'missing embedding url' };

    const vectors = [];
    const size = Math.max(1, this.cfg.batch ?? 16);
    for (let i = 0; i < inputs.length; i += size) {
      const chunk = inputs.slice(i, i + size);
      const res = await this.#request(chunk, opts);
      if (!res.ok) return res;
      vectors.push(...res.vectors);
    }
    return { ok: true, vectors };
  }

  async #request(input, opts = {}) {
    const body = JSON.stringify({ model: this.cfg.model, input, encoding_format: 'float' });
    // 自建端点是单机在跑模型，偶发连接重置很正常。请求本身很便宜（实测 0.2~0.5s），
    // 多试几次远好过放弃——放弃了这条就得等 5 分钟后的 backfill，期间只剩词法召回。
    const attempts = Math.max(1, Number(opts.attempts ?? this.cfg.retry_attempts ?? 4));
    const backoff = Number(this.cfg.retry_backoff_ms ?? 800);
    let lastError = 'embedding failed';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        // 线性退避 + 抖动：800ms、1600ms、2400ms……加随机抖动，
        // 避免多个失败请求在同一毫秒又一起扑上去
        const wait = backoff * attempt + Math.floor(Math.random() * 300);
        await new Promise((resolve) => { setTimeout(resolve, wait); });
      }
      try {
        const res = await withAiLock(() => this.transport(this.cfg.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body,
          timeoutMs: opts.timeoutMs,
        }), 'embed');
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          lastError = `embedding HTTP ${res.status}: ${text.slice(0, 200)}`;
          // 4xx 里只有限流值得重试；其余（鉴权、参数错）重试也没用，直接认输
          if (RETRYABLE.has(res.status)) continue;
          return { ok: false, error: lastError };
        }
        const json = JSON.parse(await res.text());
        const rows = Array.isArray(json?.data) ? json.data : [];
        if (rows.length !== input.length) {
          lastError = `embedding returned ${rows.length} vectors for ${input.length} inputs`;
          continue;
        }
        const out = rows.map((row) => {
          const arr = row?.embedding;
          return arr instanceof Float32Array ? arr : Float32Array.from(arr ?? []);
        });
        const wrong = out.find((v) => v.length !== this.cfg.dimensions);
        if (wrong) {
          // 维度不对是配置问题，重试无意义
          return {
            ok: false,
            error: `embedding dimension mismatch: got ${wrong.length}, config says ${this.cfg.dimensions}`,
          };
        }
        return { ok: true, vectors: out };
      } catch (err) {
        lastError = `embedding failed: ${err?.message ?? err}`;
      }
    }
    return { ok: false, error: `${lastError} (after ${attempts} attempts)` };
  }
}

/** 测试用：确定性的假向量，不联网 */
export class FakeEmbedder {
  constructor(dims = 8, { fail = false } = {}) {
    this.cfg = { dimensions: dims, max_input_chars: 4000 };
    this.name = 'fake';
    this.fail = fail;
  }

  get ready() {
    return true;
  }

  async embedDocs(texts) {
    return this.#embed(texts);
  }

  async embedQuery(text) {
    return this.#embed([text]);
  }

  #embed(texts) {
    if (this.fail) return { ok: false, error: 'fake failure' };
    return { ok: true, vectors: texts.map((t) => hashVector(t, this.cfg.dimensions)) };
  }
}

export function hashVector(text, dims) {
  const out = new Float32Array(dims);
  const s = String(text);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < dims; i += 1) {
    h ^= i + 1;
    h = Math.imul(h, 16777619);
    out[i] = ((h >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}

function truncate(text, max) {
  const s = String(text ?? '');
  const limit = Number(max ?? 2000);
  return s.length > limit ? s.slice(0, limit) : s;
}

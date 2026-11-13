// Embedding 客户端。只有 http 一种实现，接口留白给以后的本地模型 sidecar。
// 契约：embedDocs(texts) / embedQuery(text) → { ok, vectors?, error? }
//
// 走原生 socket 而不是 globalThis.fetch：后端把全局 fetch 换成了宿主的 carrierFetch，
// 响应不可靠（详见 lib/http.mjs）。
import { createHttpTransport } from './http.mjs';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpEmbedder {
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

  async embedDocs(texts) {
    return this.#embed(texts.map((t) => `${this.cfg.docPrefix ?? ''}${truncate(t, this.cfg.max_input_chars)}`));
  }

  async embedQuery(text) {
    return this.#embed([`${this.cfg.queryPrefix ?? ''}${truncate(text, this.cfg.max_input_chars)}`]);
  }

  async #embed(inputs) {
    if (!inputs.length) return { ok: true, vectors: [] };
    if (!this.cfg.apiKey) return { ok: false, error: 'missing api key (set it in DSH_HOME/.env)' };
    if (!this.cfg.url) return { ok: false, error: 'missing embedding url' };

    const vectors = [];
    const size = Math.max(1, this.cfg.batch ?? 16);
    for (let i = 0; i < inputs.length; i += size) {
      const chunk = inputs.slice(i, i + size);
      const res = await this.#request(chunk);
      if (!res.ok) return res;
      vectors.push(...res.vectors);
    }
    return { ok: true, vectors };
  }

  async #request(input) {
    const body = JSON.stringify({ model: this.cfg.model, input, encoding_format: 'float' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await this.transport(this.cfg.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (attempt === 0 && RETRYABLE.has(res.status)) continue;
          return { ok: false, error: `embedding HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
        const json = JSON.parse(await res.text());
        const rows = Array.isArray(json?.data) ? json.data : [];
        if (rows.length !== input.length) {
          return { ok: false, error: `embedding returned ${rows.length} vectors for ${input.length} inputs` };
        }
        const out = rows.map((row) => {
          const arr = row?.embedding;
          return arr instanceof Float32Array ? arr : Float32Array.from(arr ?? []);
        });
        const wrong = out.find((v) => v.length !== this.cfg.dimensions);
        if (wrong) {
          return {
            ok: false,
            error: `embedding dimension mismatch: got ${wrong.length}, config says ${this.cfg.dimensions}`,
          };
        }
        return { ok: true, vectors: out };
      } catch (err) {
        if (attempt === 0) continue;
        return { ok: false, error: `embedding failed: ${err?.message ?? err}` };
      }
    }
    return { ok: false, error: 'embedding failed after retry' };
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

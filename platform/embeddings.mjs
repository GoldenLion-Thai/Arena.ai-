/* ============================================================================
   platform/embeddings.mjs — local embeddings only.

   Two providers, same interface:

     OllamaEmbedder   production: nomic-embed-text / bge-m3 on your own host,
                      reached through the same gateway as chat (no third party
                      ever sees document text)
     HashEmbedder     deterministic local fallback used by dev, CI and the
                      offline demo. A signed hashing-trick bag of words with
                      bigrams: not a neural embedding, but cosine similarity
                      tracks lexical overlap, so retrieval, ranking and the
                      tests that cover them are genuinely exercised.

   Both return Float64Array, L2-normalised, so cosine == dot product.
   ========================================================================== */

import { EMBEDDING } from "./config.mjs";

const STOP = new Set(("a an the and or but if of to in for on with at by from as is are was were be been being it its this that these those we you they he she them their our your not no yes can could should would will may might must have has had do does did about into over under between within without regarding".split(" ")));

/**
 * Tokeniser for both lexical search and the local embedder.
 *
 * Identifiers matter more than prose in this domain: "clause 14.2",
 * "FCA-2024-118", "MSA-2024/07" must survive as single tokens, or the exact
 * reference a lawyer searches for is unfindable. So internal . - / are kept and
 * only surrounding punctuation is stripped.
 */
export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9£$€%\s./_-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9£$€%]+|[^a-z0-9£$€%]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** FNV-1a, 32-bit — stable across processes and versions. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are normalised
}

export function l2normalise(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Deterministic signed-hashing embedding. Same text → same vector, forever. */
export function hashEmbed(text, dims = EMBEDDING.dims) {
  const counts = new Map();
  const toks = tokenize(text);
  const bump = (key, w) => counts.set(key, (counts.get(key) || 0) + w);
  for (let i = 0; i < toks.length; i++) {
    bump(toks[i], 1);
    if (i + 1 < toks.length) bump(`${toks[i]}_${toks[i + 1]}`, 0.45); // phrase signal
  }
  const v = new Float64Array(dims);
  for (const [key, count] of counts) {
    const h = fnv1a(key);
    const idx = h % dims;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    v[idx] += sign * (1 + Math.log(count)); // sublinear tf
  }
  return l2normalise(v);
}

export class HashEmbedder {
  constructor(opts = {}) {
    this.model = "hash-embed-local";
    this.dims = opts.dims ?? EMBEDDING.dims;
    this.kind = "local";
    this.calls = 0;
  }
  async embed(text) {
    this.calls++;
    return hashEmbed(text, this.dims);
  }
  async embedBatch(texts) {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  async health() {
    return { ok: true, model: this.model, dims: this.dims, kind: this.kind };
  }
}

/**
 * Real embeddings from your own Ollama (or any OpenAI-compatible) host.
 * `base` is usually the same-origin proxy: http://127.0.0.1:8080/gateway
 */
export class OllamaEmbedder {
  constructor(opts = {}) {
    this.base = String(opts.base || process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = opts.model || process.env.EMBED_MODEL || EMBEDDING.model;
    this.dims = opts.dims || EMBEDDING.dims;
    this.kind = "ollama";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.concurrency = opts.concurrency ?? 4;
    this.cache = new Map(); // content hash → vector
    this.cacheLimit = opts.cacheLimit ?? 5000;
    this.calls = 0;
    this.fallback = opts.fallback ?? new HashEmbedder({ dims: this.dims });
  }

  async #post(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
      return res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async embed(text) {
    const key = String(fnv1a(text)) + ":" + text.length;
    if (this.cache.has(key)) return this.cache.get(key);
    this.calls++;
    let vec;
    try {
      // /api/embed is the batch endpoint on modern Ollama; fall back to /api/embeddings
      const batch = await this.#post("/api/embed", { model: this.model, input: [text] }).catch(() => null);
      if (batch?.embeddings?.[0]) vec = Float64Array.from(batch.embeddings[0]);
      else {
        const single = await this.#post("/api/embeddings", { model: this.model, prompt: text });
        vec = Float64Array.from(single.embedding || []);
      }
      if (!vec.length) throw new Error("empty embedding");
      if (vec.length !== this.dims) this.dims = vec.length; // trust the model, report it
      vec = l2normalise(vec);
    } catch (e) {
      // Never silently pretend a document is embedded: the caller decides.
      throw Object.assign(new Error(`embedding failed (${this.model}@${this.base}): ${e.message}`), {
        code: "EMBED_FAILED",
        fallbackVector: await this.fallback.embed(text),
      });
    }
    if (this.cache.size >= this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, vec);
    return vec;
  }

  async embedBatch(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += this.concurrency) {
      const slice = texts.slice(i, i + this.concurrency);
      out.push(...(await Promise.all(slice.map((t) => this.embed(t)))));
    }
    return out;
  }

  async health() {
    try {
      const probe = await this.#post("/api/embed", { model: this.model, input: ["healthcheck"] });
      const dims = probe?.embeddings?.[0]?.length ?? this.dims;
      return { ok: true, model: this.model, dims, kind: this.kind, base: this.base };
    } catch (e) {
      return { ok: false, model: this.model, kind: this.kind, base: this.base, error: e.message };
    }
  }
}

/** Pick a provider: real Ollama when reachable, deterministic local otherwise. */
export async function createEmbedder(opts = {}) {
  if (opts.force === "local" || process.env.EMBED_LOCAL === "1") return new HashEmbedder(opts);
  const cand = new OllamaEmbedder(opts);
  const h = await cand.health();
  return h.ok ? cand : Object.assign(new HashEmbedder({ dims: opts.dims ?? EMBEDDING.dims }), { degraded: h.error });
}

export default { HashEmbedder, OllamaEmbedder, hashEmbed, createEmbedder, tokenize, cosine, fnv1a, l2normalise };

/* ============================================================================
   platform/retrieve.mjs — hybrid retrieval with a citation contract.

   Vector search alone misses exact identifiers ("clause 14.2", "FCA-2024-118",
   a matter number). Lexical search alone misses paraphrase. So: dense + BM25,
   fused with reciprocal rank fusion, then de-duplicated per document so one
   200-page contract cannot monopolise the context window.

   Two rules this module will not break:

     1. Authorisation is applied in the candidate query, never as a filter on
        the results. Post-filtering leaks existence and makes top-k a lie.
     2. A citation states only what is known. No page number unless the source
        supplied one; cold content is reported as archived, with the path to
        reopen it, rather than being quietly dropped.
   ========================================================================== */

import { TIERS, STORAGE, verticalIds } from "./config.mjs";
import { cosine, tokenize } from "./embeddings.mjs";
import { sha256 } from "./store.mjs";

const BM25 = { k1: 1.4, b: 0.75 };

/** BM25 over a candidate pool. In production this is Postgres FTS (tsvector +
 *  GIN, or pg_search); the arithmetic here is the same shape so rankings and
 *  the tests that assert them are meaningful. */
export function bm25(query, pool) {
  const q = tokenize(query);
  if (!q.length || !pool.length) return [];
  const df = new Map();
  const docs = pool.map((c) => {
    const tf = new Map();
    const toks = tokenize(c.text);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { c, tf, len: toks.length };
  });
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  const N = docs.length;
  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      s += idf * ((f * (BM25.k1 + 1)) / (f + BM25.k1 * (1 - BM25.b + BM25.b * (d.len / avgdl))));
    }
    if (s > 0) scored.push({ chunk: d.c, score: s });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** Reciprocal rank fusion — score-free, so a cosine and a BM25 score can be
 *  combined without normalising two unrelated scales. */
export function rrf(rankings, k = 60) {
  const fused = new Map();
  for (const list of rankings) {
    list.forEach((hit, rank) => {
      const key = hit.chunk.id;
      const entry = fused.get(key) || { chunk: hit.chunk, score: 0, sources: [] };
      entry.score += 1 / (k + rank + 1);
      entry.sources.push({ rank, score: +hit.score.toFixed(4) });
      fused.set(key, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/** Cap chunks per document and spread across documents — a diversity step that
 *  protects the context window and stops one source dominating an answer. */
export function diversify(hits, { perDoc = 3, k = 10 } = {}) {
  const seen = new Map();
  const out = [];
  for (const h of hits) {
    const n = seen.get(h.chunk.docId) || 0;
    if (n >= perDoc) continue;
    seen.set(h.chunk.docId, n + 1);
    out.push(h);
    if (out.length >= k) break;
  }
  // if diversity left us short, top up from the remainder
  if (out.length < k) for (const h of hits) { if (out.length >= k) break; if (!out.includes(h)) out.push(h); }
  return out;
}

export function citation(store, doc, chunk, extra = {}) {
  return {
    docId: doc.id,
    chunkId: chunk?.id ?? null,
    title: doc.title,
    vertical: doc.vertical,
    heading: chunk?.heading ?? null,
    ordinal: chunk?.ordinal ?? null,
    quote: chunk ? chunk.text.slice(0, 420) : doc.summary.slice(0, 420),
    tokens: chunk?.tokens ?? doc.tokens,
    // only claim a page when the source gave us one
    page: chunk?.pageStart != null ? { start: chunk.pageStart, end: chunk.pageEnd ?? chunk.pageStart } : null,
    span: chunk ? { chars: [chunk.charStart, chunk.charEnd] } : null,
    sharePoint: doc.sharePoint
      ? { itemId: doc.sharePoint.itemId, webUrl: doc.sharePoint.webUrl || null, siteId: doc.sharePoint.siteId || null, versionId: doc.sharePoint.versionId || null, path: doc.sharePoint.path || null }
      : null,
    checksum: doc.contentHash ? `sha256:${doc.contentHash.slice(0, 16)}` : null,
    tier: doc.tier,
    sensitivity: doc.sensitivity,
    mirrorState: doc.mirrorState,
    piiFlagged: !!doc.piiFlagged,
    retrievedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Archived-but-relevant: cold stubs are still discoverable, because discovery
 *  is exactly what tells someone the path can be reopened. */
export function findCold(store, queryVec, query, { verticals, readers, appId, k = 5 } = {}) {
  const qTerms = tokenize(query);
  const cold = store.listDocuments({ tier: "cold", verticals });
  const scored = [];
  for (const d of cold) {
    // readers === null means an in-process caller (nightly job, migration):
    // no ACL filter, exactly as scanChunks does.
    if (readers && !store.canRead(d, readers, appId)) continue;
    const hay = `${d.title} ${d.summary} ${(d.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    if (d.summaryEmbedding && queryVec) {
      const sv = d.summaryEmbedding instanceof Float64Array ? d.summaryEmbedding : Float64Array.from(d.summaryEmbedding);
      score += Math.max(0, cosine(queryVec, sv)) * 2; // one summary vector per archived doc
    }
    if (qTerms.length) score += qTerms.filter((t) => hay.includes(t)).length / qTerms.length;
    if (score > 0.02) scored.push({ doc: d, score: +score.toFixed(4) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * Hybrid search. Returns hits with citations, cold discoveries and metrics.
 */
export async function search(store, embedder, params = {}) {
  const t0 = Date.now();
  const {
    query,
    k = 8,
    candidateK = 60,
    verticals = null,
    readers = null,
    appId = null,
    tiers = ["hot", "warm"],
    perDoc = 3,
    rerank = null,
    includeCold = true,
    scope = null,
  } = params;

  if (!query || !String(query).trim()) return { hits: [], citations: [], cold: [], metrics: { error: "empty query" } };

  const queryVec = await embedder.embed(String(query));

  // Principals: who is asking. Authorisation is applied to the candidate pool,
  // never filtered out of the results afterwards. When no principal is given at
  // all this is a trusted in-process call (a nightly job, a migration) and no
  // ACL filtering is applied — the HTTP layer always supplies one.
  const identified = !!(appId || (readers && readers.length));
  const principals = identified
    ? [...new Set([...(readers || []), ...(appId ? [appId, `app:${appId}`] : []), ...(verticals || verticalIds).map((v) => `vertical:${v}`)])]
    : null;
  const poolOpts = { verticals, tiers, appId, readers: principals };
  const pool = store.scanChunks(poolOpts);

  const dense = store.vectorSearch(queryVec, { ...poolOpts, k: candidateK });
  const lexical = bm25(String(query), pool).slice(0, candidateK);
  const fused = rrf([dense, lexical]);
  const diverse = diversify(fused, { perDoc, k });
  const ranked = typeof rerank === "function" ? rerank(diverse, { query, store }) : diverse;
  const top = ranked.slice(0, k);

  const citations = [];
  const hits = [];
  for (const h of top) {
    const doc = store.getDocument(h.chunk.docId);
    if (!doc) continue;
    const inDense = dense.some((d) => d.chunk.id === h.chunk.id);
    const inLexical = lexical.some((l) => l.chunk.id === h.chunk.id);
    const c = citation(store, doc, h.chunk, {
      score: +h.score.toFixed(5),
      fusion: h.sources || [],
      method: inDense && inLexical ? "hybrid" : inDense ? "vector" : "lexical",
    });
    citations.push(c);
    hits.push({ chunk: h.chunk, doc, citation: c });
    // Retrieval is audited, but it does NOT reset the retention clock: only an
    // actual open does. Otherwise RAG traffic would keep everything hot forever
    // and the 60-day rule would never fire.
    store.audit({ action: "search.hit", docId: doc.id, vertical: doc.vertical, appId, actor: readers?.[0] || appId || null, query: scope === "no-query-logging" ? undefined : String(query).slice(0, 200), rank: citations.length });
  }

  const cold = includeCold ? findCold(store, queryVec, String(query), { verticals, readers: principals, appId }).map((c) => ({
    docId: c.doc.id,
    title: c.doc.title,
    vertical: c.doc.vertical,
    summary: c.doc.summary.slice(0, 240),
    archivedAt: c.doc.updatedAt,
    daysArchived: Math.round(store.daysSinceOpened(c.doc)),
    sharePoint: c.doc.sharePoint?.webUrl || null,
    reopen: `/v1/documents/${c.doc.id}/rehydrate`,
    score: c.score,
    reason: `not opened for ${Math.round(store.daysSinceOpened(c.doc))} days — reverted to SharePoint`,
  })) : [];

  const metrics = {
    query: String(query),
    retrievalMs: Date.now() - t0,
    poolSize: pool.length,
    denseHits: dense.length,
    lexicalHits: lexical.length,
    fusedHits: fused.length,
    returned: citations.length,
    coldMatches: cold.length,
    embedder: embedder.model,
    dims: queryVec.length,
    tiers: tiers.join("+"),
    budgetMs: 350,
    withinBudget: Date.now() - t0 <= 350,
  };

  return { hits, citations, cold, metrics };
}

/** Prompt-ready context block: numbered sources the model must cite by number. */
export function contextBlock(result, { maxTokens = 3200 } = {}) {
  const lines = [];
  let tokens = 0;
  result.citations.forEach((c, i) => {
    const piece = `[${i + 1}] ${c.title}${c.heading ? ` — ${c.heading}` : ""}${c.page ? ` (p.${c.page.start}${c.page.end && c.page.end !== c.page.start ? `–${c.page.end}` : ""})` : ""} [${c.vertical}${c.sensitivity === "critical" ? ", restricted" : ""}]\n${c.quote}\n`;
    const t = Math.ceil(piece.length / 4);
    if (tokens + t > maxTokens) return;
    tokens += t;
    lines.push(piece);
  });
  const coldNote = result.cold.length
    ? `\nArchived but possibly relevant (rehydration required, not in context):\n${result.cold.map((c) => `  - ${c.title} (${c.vertical}) — ${c.reason}`).join("\n")}\n`
    : "";
  return {
    text: lines.length
      ? `Use only the following sources. Cite them as [n]. If the answer is not in them, say so.\n\n${lines.join("\n")}${coldNote}`
      : `No approved sources matched. Say that you could not find it in the knowledge base rather than answering from memory.${coldNote}`,
    tokens,
    sources: result.citations.length,
    grounded: lines.length > 0,
  };
}

export default { search, bm25, rrf, diversify, citation, findCold, contextBlock };

/* ============================================================================
   platform/store.mjs — the unified store every app shares.

   One database, many consumers. Not one database per app: permissions,
   citations and the retention clock have to agree, and they cannot if three
   systems each keep their own copy of "who may read this".

   Two backends behind one interface:

     MemoryStore   in-process, with append-only JSONL persistence when a
                   --data-dir is given. This is a real single-node deployment
                   for a pilot: it survives restarts and needs no services.
     Postgres    platform/schema.sql is the production truth — pgvector HNSW
                   for vectors, GIN/tsvector for lexical, RLS for verticals.
                   The adapter is deliberately not bundled: the product's
                   promise is zero runtime dependencies, and a wire-protocol
                   client is not one line of code.

   Everything is scoped by `vertical`, and nothing is deleted without an audit
   record and (for content) a verified SharePoint mirror.
   ========================================================================== */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { STORAGE, TIERS, VERTICALS, bytesPerChunk, vertical, GB } from "./config.mjs";
import { cosine } from "./embeddings.mjs";

export const COLLECTIONS = ["documents", "chunks", "wiki_pages", "wiki_revisions", "usage", "audit", "lifecycle", "keys", "mirrors"];

const nowIso = () => new Date().toISOString();
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export class MemoryStore {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || null;
    this.backend = this.dataDir ? "jsonl" : "memory";
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    this.byid = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    if (this.dataDir) this.#load();
  }

  /* ------------------------------------------------------------ persistence */
  #file(c) {
    return join(this.dataDir, `${c}.jsonl`);
  }
  #load() {
    mkdirSync(this.dataDir, { recursive: true });
    for (const c of COLLECTIONS) {
      const f = this.#file(c);
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.__deleted) {
            this.byid[c].delete(rec.id);
            this.data[c] = this.data[c].filter((r) => r.id !== rec.id);
          } else {
            this.#put(c, rec, false);
          }
        } catch {
          /* a truncated tail line is ignored; the mirror is authoritative */
        }
      }
      // vectors are stored as arrays in JSONL — restore typed arrays lazily
      if (c === "chunks") for (const r of this.data[c]) if (Array.isArray(r.embedding)) r.embedding = Float64Array.from(r.embedding);
    }
  }
  #append(c, rec) {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(this.#file(c), JSON.stringify(rec, (k, v) => (v instanceof Float64Array ? Array.from(v) : v)) + "\n");
  }
  #put(c, rec, persist = true) {
    const i = this.data[c].findIndex((r) => r.id === rec.id);
    if (i >= 0) this.data[c][i] = rec;
    else this.data[c].push(rec);
    this.byid[c].set(rec.id, rec);
    if (persist) this.#append(c, rec);
    return rec;
  }
  compact() {
    if (!this.dataDir) return 0;
    let n = 0;
    for (const c of COLLECTIONS) {
      const tmp = `${this.#file(c)}.tmp`;
      writeFileSync(tmp, this.data[c].map((r) => JSON.stringify(r, (k, v) => (v instanceof Float64Array ? Array.from(v) : v))).join("\n") + (this.data[c].length ? "\n" : ""));
      renameSync(tmp, this.#file(c));
      n += this.data[c].length;
    }
    return n;
  }

  /* ------------------------------------------------------------- documents */
  putDocument(doc) {
    // Normalise the known fields, but start from the record itself: an
    // explicit-only literal silently dropped archiveReason and anything a
    // later module adds, which is how data quietly disappears.
    const rec = {
      ...doc,
      id: doc.id || shortId("doc"),
      vertical: doc.vertical || "shared",
      title: doc.title || "untitled",
      sourceKind: doc.sourceKind || "upload", // upload | sharepoint | wiki | api
      sharePoint: doc.sharePoint || null, // {siteId,itemId,webUrl,etag,versionId,path}
      contentHash: doc.contentHash || null,
      tokens: doc.tokens || 0,
      chunkCount: doc.chunkCount || 0,
      bytes: doc.bytes || 0,
      tier: doc.tier || "hot",
      sensitivity: doc.sensitivity || vertical(doc.vertical)?.sensitivity || "medium",
      tags: doc.tags || [],
      summary: doc.summary || "",
      summaryEmbedding: doc.summaryEmbedding || null,
      /* Access defaults. Content that arrives with explicit grants (SharePoint
         permissions, a wiki page's vertical group) keeps them untouched — they
         are never widened here. Content that arrives with none (an upload, an
         API ingest, a fixture) is scoped to its own vertical and denied to the
         public. Before this, the default was empty readers AND empty groups,
         which made canRead() fall through to "any app-scoped key may read it":
         confidential content was effectively cross-app readable inside the
         platform and unreadable by the very vertical grant that was supposed to
         cover it. Vertical-scoped by default matches what wiki pages already do
         and what a key's grants actually assert. */
      acl: {
        readers: doc.acl?.readers || [],
        groups: doc.acl?.groups || (doc.acl ? [] : [`vertical:${doc.vertical || "shared"}`]),
        denyPublic: doc.acl?.denyPublic !== false,
      },
      mirrorState: doc.mirrorState || "pending", // pending | mirrored | verified | failed
      mirrorVerifiedAt: doc.mirrorVerifiedAt || null,
      appId: doc.appId || null,
      createdAt: doc.createdAt || nowIso(),
      updatedAt: nowIso(),
      lastOpenedAt: doc.lastOpenedAt || doc.createdAt || nowIso(),
      lastOpenedBy: doc.lastOpenedBy || null,
      openCount: doc.openCount || 0,
      deleted: false,
      ...doc.extra,
    };
    delete rec.extra;
    return this.#put("documents", rec);
  }
  getDocument(id) {
    return this.byid.documents.get(id) || null;
  }
  findDocumentByHash(hash, verticalId) {
    return this.data.documents.find((d) => d.contentHash === hash && (!verticalId || d.vertical === verticalId) && !d.deleted) || null;
  }
  listDocuments(filter = {}) {
    return this.data.documents.filter(
      (d) =>
        !d.deleted &&
        (!filter.vertical || d.vertical === filter.vertical) &&
        (!filter.verticals || filter.verticals.includes(d.vertical)) &&
        (!filter.tier || d.tier === filter.tier) &&
        (!filter.mirrorState || d.mirrorState === filter.mirrorState) &&
        (!filter.q || `${d.title} ${d.summary} ${(d.tags || []).join(" ")}`.toLowerCase().includes(String(filter.q).toLowerCase()))
    );
  }
  deleteDocument(id, reason) {
    const d = this.getDocument(id);
    if (!d) return false;
    d.deleted = true;
    d.deletedAt = nowIso();
    d.deleteReason = reason;
    this.#put("documents", d);
    this.#append("documents", { id, __deleted: true });
    this.data.chunks = this.data.chunks.filter((c) => c.docId !== id);
    return true;
  }

  /* ---------------------------------------------------------------- chunks */
  putChunks(chunks) {
    return chunks.map((c) =>
      this.#put("chunks", {
        ...c, // preserve any field a later module adds
        id: c.id || shortId("chk"),
        docId: c.docId,
        vertical: c.vertical || this.getDocument(c.docId)?.vertical || "shared",
        ordinal: c.ordinal ?? 0,
        heading: c.heading || null,
        text: c.text,
        tokens: c.tokens || 0,
        pageStart: c.pageStart ?? null,
        pageEnd: c.pageEnd ?? null,
        charStart: c.charStart ?? 0,
        charEnd: c.charEnd ?? 0,
        tier: c.tier || "hot",
        embedding: c.embedding instanceof Float64Array ? c.embedding : Float64Array.from(c.embedding || []),
        createdAt: nowIso(),
      })
    );
  }
  chunksFor(docId) {
    return this.data.chunks.filter((c) => c.docId === docId);
  }
  dropChunks(docId) {
    const before = this.data.chunks.length;
    const removed = this.data.chunks.filter((c) => c.docId === docId);
    for (const r of removed) this.#append("chunks", { id: r.id, __deleted: true });
    this.data.chunks = this.data.chunks.filter((c) => c.docId !== docId);
    for (const r of removed) this.byid.chunks.delete(r.id);
    return before - this.data.chunks.length;
  }
  /** Candidate pool for retrieval. ACL and vertical scoping happen HERE, in the
   *  query, never as a post-filter on results — a post-filter leaks existence. */
  scanChunks({ verticals = null, tiers = ["hot", "warm"], appId = null, readers = null, limit = null } = {}) {
    let out = this.data.chunks.filter((c) => (!tiers || tiers.includes(c.tier)) && (!verticals || verticals.includes(c.vertical)));
    if (readers) {
      const ids = new Set(out.map((c) => c.docId));
      const allowed = new Set();
      for (const id of ids) {
        const d = this.getDocument(id);
        if (d && this.canRead(d, readers, appId)) allowed.add(id);
      }
      out = out.filter((c) => allowed.has(c.docId));
    }
    return limit ? out.slice(0, limit) : out;
  }
  canRead(doc, readers = [], appId = null) {
    if (!doc || doc.deleted) return false;
    if (!doc.acl?.denyPublic) return true;
    if (!doc.acl.readers.length && !doc.acl.groups.length) return appId != null; // app-scoped key, no explicit list → app may read
    if (appId && doc.acl.readers.includes(`app:${appId}`)) return true;
    return readers.some((r) => doc.acl.readers.includes(r) || doc.acl.groups.includes(r));
  }

  vectorSearch(queryVec, opts = {}) {
    const k = opts.k ?? 20;
    const pool = this.scanChunks(opts);
    const scored = [];
    for (const c of pool) {
      if (!c.embedding?.length) continue;
      scored.push({ chunk: c, score: cosine(queryVec, c.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /* ----------------------------------------------------------- usage/tiers */
  markOpened(docId, actor = null, appId = null, action = "open") {
    const d = this.getDocument(docId);
    if (!d) return null;
    d.lastOpenedAt = nowIso();
    d.lastOpenedBy = actor || appId || d.lastOpenedBy;
    d.openCount = (d.openCount || 0) + 1;
    if (d.tier === "warm") d.tier = "hot";
    this.#put("documents", d);
    this.#put("usage", { id: shortId("use"), docId, at: d.lastOpenedAt, actor, appId, action });
    return d;
  }
  daysSinceOpened(doc, at = Date.now()) {
    const t = Date.parse(doc.lastOpenedAt || doc.createdAt || 0);
    return (at - t) / 86_400_000;
  }

  /* ------------------------------------------------------------------ wiki */
  putWikiPage(page) {
    return this.#put("wiki_pages", {
      id: page.id || shortId("wik"),
      vertical: page.vertical || "shared",
      slug: page.slug,
      title: page.title,
      body: page.body || "",
      frontMatter: page.frontMatter || {},
      revision: page.revision || 1,
      reviewBy: page.reviewBy || null,
      owner: page.owner || null,
      tags: page.tags || [],
      backlinks: page.backlinks || [],
      acl: page.acl || { readers: [], groups: [], denyPublic: false },
      mirrorState: page.mirrorState || "pending",
      sharePoint: page.sharePoint || null, // outbound mirror target
      docId: page.docId || null, // the RAG document this page is indexed as
      createdAt: page.createdAt || nowIso(),
      updatedAt: nowIso(),
      updatedBy: page.updatedBy || "system",
    });
  }
  getWikiPage(slugOrId) {
    return this.data.wiki_pages.find((p) => p.slug === slugOrId || p.id === slugOrId) || null;
  }
  listWikiPages(filter = {}) {
    return this.data.wiki_pages.filter(
      (p) => (!filter.vertical || p.vertical === filter.vertical) && (!filter.q || `${p.title} ${p.body} ${p.tags.join(" ")}`.toLowerCase().includes(String(filter.q).toLowerCase()))
    );
  }
  addWikiRevision(rev) {
    return this.#put("wiki_revisions", { id: shortId("rev"), at: nowIso(), ...rev });
  }
  wikiRevisions(pageId) {
    return this.data.wiki_revisions.filter((r) => r.pageId === pageId).sort((a, b) => a.revision - b.revision);
  }

  /* -------------------------------------------------------------- mirrors */
  putMirror(m) {
    return this.#put("mirrors", { id: m.id || shortId("mir"), at: nowIso(), ...m });
  }
  mirrors(filter = {}) {
    return this.data.mirrors.filter((m) => (!filter.docId || m.docId === filter.docId) && (!filter.kind || m.kind === filter.kind));
  }

  /* ---------------------------------------------------------- keys/audit */
  putKey(k) {
    return this.#put("keys", { id: k.id || shortId("key"), createdAt: nowIso(), revoked: false, lastUsedAt: null, ...k });
  }
  findKeyByHash(hash) {
    return this.data.keys.find((k) => k.hash === hash && !k.revoked) || null;
  }
  audit(entry) {
    return this.#put("audit", { id: shortId("aud"), at: nowIso(), ...entry });
  }
  auditLog(filter = {}) {
    return this.data.audit
      .filter((a) => (!filter.action || a.action === filter.action) && (!filter.vertical || a.vertical === filter.vertical) && (!filter.docId || a.docId === filter.docId))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, filter.limit ?? 200);
  }
  putLifecycle(e) {
    return this.#put("lifecycle", { id: shortId("lc"), at: nowIso(), ...e });
  }
  lifecycleEvents(filter = {}) {
    return this.data.lifecycle.filter((e) => (!filter.docId || e.docId === filter.docId) && (!filter.to || e.to === filter.to)).sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /* ------------------------------------------------------- capacity/quota */
  /** Live bytes attributable to the retrieval tier, using the same arithmetic
   *  the capacity plan uses — so quota and plan cannot disagree. */
  liveBytes() {
    const per = bytesPerChunk();
    const out = { total: 0, byVertical: {}, byTier: { hot: 0, warm: 0, cold: 0 }, chunks: 0, coldStubs: 0 };
    for (const v of VERTICALS) out.byVertical[v.id] = 0;
    for (const c of this.data.chunks) {
      const b = per.total;
      out.total += b;
      out.chunks++;
      out.byVertical[c.vertical] = (out.byVertical[c.vertical] || 0) + b;
      out.byTier[c.tier] = (out.byTier[c.tier] || 0) + b;
    }
    // cold stubs: metadata + one summary vector each
    const stubBytes = 1200 + per.column;
    for (const d of this.data.documents) {
      if (d.deleted) continue;
      if (d.tier === "cold") {
        out.total += stubBytes;
        out.coldStubs++;
        out.byVertical[d.vertical] = (out.byVertical[d.vertical] || 0) + stubBytes;
        out.byTier.cold += stubBytes;
      }
    }
    // Full precision here: rounding to 3 dp turned a small pilot store into
    // 0.000 GB and silently disabled the ceiling check. Reports round for humans.
    out.totalGB = out.total / GB;
    out.ceilingGB = STORAGE.liveCeilingGB;
    out.pctOfCeiling = (out.total / GB / STORAGE.liveCeilingGB) * 100;
    for (const v of VERTICALS) {
      const bytes = out.byVertical[v.id] || 0;
      out.byVertical[v.id] = { bytes, gb: bytes / GB, quotaGB: v.quotaGB, pct: +((bytes / GB / v.quotaGB) * 100).toFixed(2) };
    }
    return out;
  }
}

export default MemoryStore;

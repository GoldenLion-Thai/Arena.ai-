/* ============================================================================
   platform/server.mjs — KiNETiC-Ai: one API, every app, every vertical.

   Zero dependencies, same as the rest of the product:

     node platform/server.mjs --port 8090 --data-dir .data/platform
     node platform/server.mjs --create-key --app grid-os-sovereign   # prints a key

   Authentication is per app, not per person: each consumer gets a key with
   scopes (search/read/ingest/wiki/admin) and a vertical list. A key scoped to
   `finance` cannot read `legal`, and that is enforced in the retrieval query
   rather than filtered out of the response.

   People-level identity comes from your IdP at the edge (see deploy/README.md);
   the platform records the actor it is told about and audits every write.

   Run behind the app origin: server.js proxies /platform/* here, so the
   browser sees one origin and no CORS.
   ========================================================================== */

import http from "node:http";
import { randomBytes } from "node:crypto";
import { MemoryStore, sha256, shortId } from "./store.mjs";
import { HashEmbedder, createEmbedder } from "./embeddings.mjs";
import { ingest } from "./ingest.mjs";
import { search, contextBlock } from "./retrieve.mjs";
import { MockSharePoint, syncInbound } from "./sharepoint.mjs";
import { sweep, rehydrate, quotaReport, capacityReport, capacityTable, enforceCeiling } from "./lifecycle.mjs";
import * as wiki from "./wiki.mjs";
import { PLATFORM, APPS, RATE_LIMIT, SCOPES, VERTICALS, TIERS, STORAGE, verticalIds } from "./config.mjs";
import { seedFixtures } from "./fixtures.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const a = { port: Number(process.env.PLATFORM_PORT || 8090), host: process.env.PLATFORM_HOST || "127.0.0.1", dataDir: process.env.PLATFORM_DATA || null, embed: process.env.PLATFORM_EMBED || "auto", ollama: process.env.OLLAMA_URL || null, createKey: false, app: null, scopes: null, verticalsArg: null, fixtures: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--port") { a.port = Number(v); i++; }
    else if (k === "--host") { a.host = v; i++; }
    else if (k === "--data-dir") { a.dataDir = v; i++; }
    else if (k === "--embed") { a.embed = v; i++; }
    else if (k === "--ollama") { a.ollama = v; i++; }
    else if (k === "--create-key") a.createKey = true;
    else if (k === "--app") { a.app = v; i++; }
    else if (k === "--scopes") { a.scopes = v; i++; }
    else if (k === "--verticals") { a.verticalsArg = v; i++; }
    else if (k === "--fixtures") a.fixtures = true;
    else if (k === "-h" || k === "--help") a.help = true;
  }
  return a;
}

/* ------------------------------------------------------------------- keys */
export function createKey(store, { appId, scopes = null, verticals = ["*"], label = null, actor = "admin" }) {
  const app = APPS.find((a) => a.id === appId) || null;
  // An app's declared scopes are the default: registering an app in APPS is the
  // act that decides what it may do, and a key cannot exceed that silently.
  const effectiveScopes = (scopes || app?.scopes || ["search", "read"]).filter((s) => SCOPES.includes(s));
  const secret = `ka_${randomBytes(24).toString("base64url")}`;
  const rec = store.putKey({
    id: shortId("key"),
    appId,
    label: label || app?.label || appId,
    hash: sha256(secret),
    prefix: secret.slice(0, 8),
    scopes: effectiveScopes,
    verticals: verticals[0] === "*" ? ["*"] : verticals.filter((v) => verticalIds.includes(v)),
    ratePerMin: app?.ratePerMin ?? RATE_LIMIT.defaultPerMin,
    createdAt: new Date().toISOString(),
    actor,
  });
  store.audit({ action: "key.created", appId, actor, scopes: rec.scopes, verticals: rec.verticals, keyId: rec.id });
  return { ...rec, secret }; // the secret is returned once and never stored
}

export function authenticate(store, req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { ok: false, code: 401, error: "missing bearer key" };
  const key = store.findKeyByHash(sha256(m[1].trim()));
  if (!key) return { ok: false, code: 401, error: "unknown or revoked key" };
  // sliding-window rate limit, per key
  const now = Date.now();
  key.hits = (key.hits || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (key.hits.length >= (key.ratePerMin || RATE_LIMIT.defaultPerMin)) {
    return { ok: false, code: 429, error: `rate limit ${key.ratePerMin}/min exceeded for ${key.appId}`, retryAfterMs: RATE_LIMIT.windowMs - (now - key.hits[0]) };
  }
  key.hits.push(now);
  key.lastUsedAt = new Date(now).toISOString();
  store.putKey(key);
  return { ok: true, key };
}

/**
 * Percent-decode a request path for routing.
 *
 * Wiki slugs are `vertical/page`, so a client may send `/v1/wiki/pages/finance/billing-cadence`
 * or the encoded `finance%2Fbilling-cadence` — both must reach the same page.
 * A path that decodes to something containing `..` is refused: this API has no
 * filesystem routes, and a decoded path must never be able to look like one.
 *
 * @returns {string|null} the decoded path, or null if it must be refused
 */
export function decodePath(raw) {
  let p = raw;
  try {
    p = decodeURIComponent(raw);
  } catch {
    /* a malformed escape: route on the raw text and let the 404 do its job */
  }
  return p.includes("..") ? null : p;
}

const canScope = (key, s) => key.scopes.includes(s);
const verticalsFor = (key, requested) => {
  const allowed = key.verticals[0] === "*" ? verticalIds : key.verticals;
  if (!requested || !requested.length) return allowed;
  const want = (Array.isArray(requested) ? requested : [requested]).filter((v) => allowed.includes(v));
  return want; // an out-of-scope vertical is dropped, not an error: no existence leak
};

/* ------------------------------------------------------------------- http */
export function createPlatform(opts = {}) {
  const store = opts.store || new MemoryStore({ dataDir: opts.dataDir || null });
  /* The embedder is swappable because the real one is discovered at boot: main()
     probes Ollama and only then knows whether it gets nomic-embed-text or has to
     fall back. Every route closes over this binding, so swapping it has to go
     through setEmbedder() — assigning a property on the returned object would
     leave the routes embedding with the fallback while the console claimed
     otherwise. */
  let embedder = opts.embedder || new HashEmbedder();
  const setEmbedder = (e) => {
    if (!e || typeof e.embed !== "function") throw new Error("setEmbedder needs an embedder (embed/embedBatch/model/dims)");
    embedder = e;
    return embedder;
  };
  const sp = opts.sharePoint || new MockSharePoint();
  const ingestDoc = (input) => ingest(store, embedder, input);

  const send = (res, code, body, headers = {}) => {
    const json = JSON.stringify(body, (k, v) => (v instanceof Float64Array ? undefined : v));
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json), "cache-control": "no-store", "x-platform": `${PLATFORM.name}/${PLATFORM.apiVersion}`, ...headers });
    res.end(json);
  };
  const err = (res, code, error, detail) => send(res, code, { error, code, detail: detail || undefined, platform: PLATFORM.name });

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return { __parseError: raw.slice(0, 200) }; }
  }

  const routes = [];
  // scope: null = public · true = any authenticated key · "search"|"read"|… = that scope
  const on = (method, pattern, scope, handler) => routes.push({ method, pattern, scope, handler });

  on("GET", /^\/healthz$/, null, async (req, res) => {
    const h = await embedder.health?.();
    const live = store.liveBytes();
    const docs = store.listDocuments({});
    send(res, 200, {
      ok: true, platform: PLATFORM.name, version: PLATFORM.apiVersion, backend: store.backend,
      embedder: h?.model || embedder.model, dims: h?.dims || embedder.dims,
      liveGB: live.totalGB, ceilingGB: live.ceilingGB, documents: docs.length, chunks: live.chunks,
      verticals: verticalIds, sharePoint: sp.kind,
      // Derived from what is actually stored, so it cannot drift from the truth:
      // a platform seeded with --fixtures says so on every health check.
      fixtureContent: docs.some((d) => d.sourceKind === "fixture") || store.listWikiPages({}).some((pg) => (pg.tags || []).includes("fixture")),
    });
  });

  // Any valid key may read /v1/meta — it is how an app discovers what it may do.
  on("GET", /^\/v1\/meta$/, true, async (req, res, ctx) => {
    const report = capacityReport(store);
    send(res, 200, {
      platform: PLATFORM, verticals: VERTICALS, scopes: SCOPES, apps: APPS.map((a) => ({ id: a.id, label: a.label, scopes: a.scopes, verticals: a.verticals })),
      tiers: TIERS, storage: STORAGE,
      key: ctx.key ? { appId: ctx.key.appId, scopes: ctx.key.scopes, verticals: ctx.key.verticals, ratePerMin: ctx.key.ratePerMin } : null,
      capacity: report.headroom, quota: quotaReport(store).total,
    });
  });

  on("POST", /^\/v1\/search$/, "search", async (req, res, ctx) => {
    const b = await body(req);
    if (b.__parseError) return err(res, 400, "invalid JSON", b.__parseError);
    if (!b.query) return err(res, 400, "query is required");
    const verticals = verticalsFor(ctx.key, b.verticals);
    if (!verticals.length) return err(res, 403, "this key has no vertical in scope for that request");
    const result = await search(store, embedder, {
      query: b.query, k: b.k ?? 8, verticals, appId: ctx.key.appId, readers: [...(ctx.readers || []), ...(b.readers || [])], tiers: b.tiers, includeCold: b.includeCold !== false,
    });
    if (b.context !== false) result.context = contextBlock(result, { maxTokens: b.maxContextTokens ?? 3200 });
    send(res, 200, result);
  });

  on("GET", /^\/v1\/documents$/, "read", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    const verticals = verticalsFor(ctx.key, u.searchParams.get("vertical") ? [u.searchParams.get("vertical")] : null);
    const docs = store.listDocuments({ verticals, tier: u.searchParams.get("tier") || undefined, q: u.searchParams.get("q") || undefined });
    send(res, 200, { count: docs.length, documents: docs.map((d) => publicDoc(d)) });
  });

  on("POST", /^\/v1\/documents$/, "ingest", async (req, res, ctx) => {
    const b = await body(req);
    if (b.__parseError) return err(res, 400, "invalid JSON", b.__parseError);
    const verticals = verticalsFor(ctx.key, [b.vertical || "shared"]);
    if (!verticals.includes(b.vertical || "shared")) return err(res, 403, `vertical "${b.vertical}" is outside this key's scope`);
    const res2 = await ingestDoc({ ...b, appId: ctx.key.appId, actor: b.actor || ctx.key.appId });
    if (!res2.accepted) return send(res, 422, { accepted: false, reasons: res2.reasons, warnings: res2.warnings });
    send(res, 201, { accepted: true, deduped: !!res2.deduped, warnings: res2.warnings, document: publicDoc(res2.doc), chunks: res2.chunks.length, quota: quotaReport(store).rows.find((r) => r.vertical === res2.doc.vertical) });
  });

  on("GET", /^\/v1\/documents\/([\w-]+)$/, "read", async (req, res, ctx, m) => {
    const doc = store.getDocument(m[1]);
    if (!doc || doc.deleted) return err(res, 404, "no such document");
    if (!verticalsFor(ctx.key, [doc.vertical]).includes(doc.vertical)) return err(res, 404, "no such document"); // not 403: no existence leak
    if (!store.canRead(doc, ctx.readers || [], ctx.key.appId)) return err(res, 404, "no such document");
    // Reading a document IS opening it: this is what resets the 60-day clock.
    store.markOpened(doc.id, ctx.key.appId, ctx.key.appId, "read");
    const chunks = doc.tier === "cold" ? [] : store.chunksFor(doc.id).map((c) => ({ id: c.id, ordinal: c.ordinal, heading: c.heading, tokens: c.tokens, text: c.text }));
    send(res, 200, { document: publicDoc(doc), chunks, tier: doc.tier, rehydratable: doc.tier === "cold" && !!doc.sharePoint?.itemId });
  });

  on("POST", /^\/v1\/documents\/([\w-]+)\/open$/, "read", async (req, res, ctx, m) => {
    const doc = store.getDocument(m[1]);
    if (!doc) return err(res, 404, "no such document");
    if (!verticalsFor(ctx.key, [doc.vertical]).includes(doc.vertical)) return err(res, 404, "no such document");
    if (!store.canRead(doc, ctx.readers || [], ctx.key.appId)) return err(res, 404, "no such document");
    const b = await body(req);
    store.markOpened(doc.id, b.actor || ctx.key.appId, ctx.key.appId, "open");
    send(res, 200, { ok: true, docId: doc.id, lastOpenedAt: doc.lastOpenedAt, openCount: doc.openCount, tier: doc.tier, retentionClockResetDays: TIERS.coldAfterDaysUnopened });
  });

  on("POST", /^\/v1\/documents\/([\w-]+)\/rehydrate$/, "read", async (req, res, ctx, m) => {
    const doc = store.getDocument(m[1]);
    if (!doc) return err(res, 404, "no such document");
    if (!verticalsFor(ctx.key, [doc.vertical]).includes(doc.vertical)) return err(res, 404, "no such document");
    if (!store.canRead(doc, ctx.readers || [], ctx.key.appId)) return err(res, 404, "no such document");
    const b = await body(req);
    const r = await rehydrate(store, sp, embedder, m[1], { actor: b.actor || ctx.key.appId, appId: ctx.key.appId });
    if (!r.ok) return send(res, 409, r);
    send(res, 200, { ok: true, ...r, note: "path reopened: content pulled from SharePoint and re-indexed" });
  });

  /* ------------------------------------------------------------------ wiki */
  on("GET", /^\/v1\/wiki\/pages$/, "read", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    const want = u.searchParams.get("vertical");
    // Scope the LIST, not just the individual page: a key holding `shared` must
    // not learn that `legal/indemnity-policy` exists. Same rule as /v1/documents.
    const verticals = verticalsFor(ctx.key, want ? [want] : null);
    const pages = store.listWikiPages({ vertical: want || undefined, q: u.searchParams.get("q") || undefined }).filter((p) => verticals.includes(p.vertical));
    send(res, 200, { count: pages.length, pages: pages.map(publicPage), verticals });
  });

  on("POST", /^\/v1\/wiki\/pages$/, "wiki", async (req, res, ctx) => {
    const b = await body(req);
    if (!b.title || b.body == null) return err(res, 400, "title and body are required");
    const vId = b.vertical || "shared";
    if (!verticalsFor(ctx.key, [vId]).includes(vId)) return err(res, 403, `vertical "${vId}" is outside this key's scope`);
    const r = await wiki.createPage(store, embedder, { ...b, vertical: vId, author: b.author || ctx.key.appId });
    if (!r.ok) return send(res, 409, r);
    send(res, 201, { ok: true, page: publicPage(r.page) });
  });

  // Dashboard numbers for the pages this key may see — the wiki UI shows mirror
  // and index coverage without opening a page first.
  on("GET", /^\/v1\/wiki\/stats$/, "read", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    const want = u.searchParams.get("vertical");
    const verticals = verticalsFor(ctx.key, want ? [want] : null);
    const pages = store.listWikiPages({ vertical: want || undefined }).filter((p) => verticals.includes(p.vertical));
    send(res, 200, { ...wiki.statsFor(store, pages), verticals });
  });

  on("GET", /^\/v1\/wiki\/search$/, "search", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    const v = u.searchParams.get("vertical");
    const verticals = verticalsFor(ctx.key, v ? [v] : null);
    const results = wiki.searchPages(store, u.searchParams.get("q") || "", { limit: Number(u.searchParams.get("limit") || 25) }).filter((r) => verticals.includes(r.vertical));
    send(res, 200, { count: results.length, results });
  });

  on("GET", /^\/v1\/wiki\/reviews$/, "read", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    const queue = wiki.reviewQueue(store, { daysAhead: Number(u.searchParams.get("days") || 30) }).filter((r) => verticalsFor(ctx.key, [r.vertical]).includes(r.vertical));
    send(res, 200, { count: queue.length, reviews: queue });
  });

  on("GET", /^\/v1\/wiki\/pages\/([\w\-/]+)\/diff$/, "read", async (req, res, ctx, m) => {
    const u = new URL(req.url, "http://local");
    const page = store.getWikiPage(m[1]);
    if (!page) return err(res, 404, "no such page");
    const revs = store.wikiRevisions(page.id);
    const to = revs.find((r) => r.revision === Number(u.searchParams.get("to") || page.revision));
    const from = revs.find((r) => r.revision === Number(u.searchParams.get("from") || Math.max(1, (to?.revision || 2) - 1)));
    if (!to || !from) return err(res, 404, "revision not found");
    send(res, 200, { slug: page.slug, from: from.revision, to: to.revision, diff: wiki.diff(from.body, to.body) });
  });

  on("GET", /^\/v1\/wiki\/pages\/([\w\-/]+)$/, "read", async (req, res, ctx, m) => {
    const slug = m[1]; // decodePath already decoded the route
    const page = store.getWikiPage(slug);
    if (!page) return err(res, 404, "no such page");
    if (!verticalsFor(ctx.key, [page.vertical]).includes(page.vertical)) return err(res, 404, "no such page");
    send(res, 200, { page: publicPage(page, true), revisions: store.wikiRevisions(page.id).map((r) => ({ revision: r.revision, at: r.at, author: r.author, note: r.note, hash: r.hash?.slice(0, 12) })), stats: wiki.stats(store) });
  });

  on("PUT", /^\/v1\/wiki\/pages\/([\w\-/]+)$/, "wiki", async (req, res, ctx, m) => {
    const slug = m[1];
    const page = store.getWikiPage(slug);
    if (!page) return err(res, 404, "no such page");
    if (!verticalsFor(ctx.key, [page.vertical]).includes(page.vertical)) return err(res, 403, "outside this key's verticals");
    const b = await body(req);
    const r = await wiki.updatePage(store, embedder, slug, { body: b.body ?? page.body, author: b.author || ctx.key.appId, note: b.note || "edit", reviewBy: b.reviewBy, tags: b.tags });
    if (!r.ok) return send(res, 409, r);
    send(res, 200, { ok: true, page: publicPage(r.page, true) });
  });


  /* ----------------------------------------------------------------- admin */
  on("GET", /^\/v1\/admin\/capacity$/, "admin", async (req, res) => {
    const report = capacityReport(store);
    send(res, 200, { ...report, table: capacityTable(report) });
  });

  on("GET", /^\/v1\/admin\/quota$/, "admin", async (req, res) => send(res, 200, quotaReport(store)));

  on("POST", /^\/v1\/admin\/lifecycle\/sweep$/, "admin", async (req, res, ctx) => {
    const b = await body(req);
    const report = await sweep(store, sp, { dryRun: !!b.dryRun, actor: ctx.key.appId, at: b.at ? Date.parse(b.at) : Date.now() });
    send(res, 200, report);
  });

  on("POST", /^\/v1\/admin\/lifecycle\/enforce$/, "admin", async (req, res, ctx) => {
    const r = await enforceCeiling(store, sp, { actor: ctx.key.appId });
    send(res, 200, r);
  });

  on("POST", /^\/v1\/admin\/mirror\/sync$/, "admin", async (req, res, ctx) => {
    const b = await body(req);
    const r = await syncInbound(store, sp, ingestDoc, { siteId: b.siteId || null, token: b.token || null, actor: ctx.key.appId });
    send(res, 200, r);
  });

  on("POST", /^\/v1\/admin\/wiki\/mirror$/, "admin", async (req, res, ctx) => {
    const r = await wiki.mirrorPages(store, sp, { author: ctx.key.appId });
    send(res, 200, r);
  });

  on("GET", /^\/v1\/admin\/audit$/, "admin", async (req, res, ctx) => {
    const u = new URL(req.url, "http://local");
    send(res, 200, { entries: store.auditLog({ action: u.searchParams.get("action") || undefined, vertical: u.searchParams.get("vertical") || undefined, docId: u.searchParams.get("docId") || undefined, limit: Number(u.searchParams.get("limit") || 100) }) });
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://local");
    const path = decodePath(u.pathname.replace(/\/+$/, "") || "/");
    if (path === null) return err(res, 400, "bad path");
    res.setHeader("x-content-type-options", "nosniff");

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "same-origin", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "authorization,content-type" });
      return res.end();
    }

    const route = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!route) return err(res, 404, `no route ${req.method} ${path}`, "see GET /v1/meta");

    let ctx = { key: null, readers: [] };
    if (route.scope !== null) {
      const auth = authenticate(store, req);
      if (!auth.ok) return err(res, auth.code, auth.error, auth.retryAfterMs ? { retryAfterMs: auth.retryAfterMs } : undefined);
      if (route.scope !== true && !canScope(auth.key, route.scope)) {
        store.audit({ action: "api.denied", appId: auth.key.appId, path, scope: route.scope, keyId: auth.key.id });
        return err(res, 403, `key for ${auth.key.appId} lacks the "${route.scope}" scope`);
      }
      // Principals for the store: the app, and the vertical grants its key holds.
      const grants = auth.key.verticals[0] === "*" ? verticalIds : auth.key.verticals;
      ctx = { key: auth.key, readers: [auth.key.appId, `app:${auth.key.appId}`, ...grants.map((v) => `vertical:${v}`)] };
    }

    const m = route.pattern.exec(path);
    try {
      await route.handler(req, res, ctx, m || []);
    } catch (e) {
      store.audit({ action: "api.error", path, error: e.message });
      if (!res.headersSent) err(res, 500, "internal error", e.message);
      else res.end();
    }
  });

  return {
    server, store, sharePoint: sp, ingest: ingestDoc, setEmbedder,
    get embedder() { return embedder; },
    createKey: (o) => createKey(store, o),
  };
}

const publicDoc = (d) => ({
  id: d.id, title: d.title, vertical: d.vertical, tier: d.tier, sensitivity: d.sensitivity, tags: d.tags,
  summary: d.summary?.slice(0, 600), tokens: d.tokens, chunkCount: d.chunkCount, sourceKind: d.sourceKind,
  sharePoint: d.sharePoint ? { itemId: d.sharePoint.itemId, webUrl: d.sharePoint.webUrl, path: d.sharePoint.path, versionId: d.sharePoint.versionId } : null,
  mirrorState: d.mirrorState, checksum: d.contentHash ? `sha256:${d.contentHash.slice(0, 16)}` : null,
  createdAt: d.createdAt, updatedAt: d.updatedAt, lastOpenedAt: d.lastOpenedAt, openCount: d.openCount,
  archivedAt: d.archivedAt || null, archiveReason: d.archiveReason || null,
});
const publicPage = (p, full = false) => ({
  slug: p.slug, title: p.title, vertical: p.vertical, revision: p.revision, owner: p.owner, reviewBy: p.reviewBy,
  tags: p.tags, backlinks: p.backlinks, updatedAt: p.updatedAt, updatedBy: p.updatedBy, mirrorState: p.mirrorState,
  docId: p.docId, sharePoint: p.sharePoint || null, ...(full ? { body: p.body, frontMatter: p.frontMatter } : { snippet: p.body.slice(0, 200) }),
});

/* ------------------------------------------------------------------ boot */
export async function main() {
  const a = parseArgs();
  if (a.help) {
    console.log(`KiNETiC-Ai platform API

  node platform/server.mjs [--port 8090] [--host 127.0.0.1] [--data-dir .data/platform]
                           [--embed auto|local] [--ollama http://127.0.0.1:11434] [--fixtures]
  node platform/server.mjs --create-key --app grid-os-sovereign [--scopes search,read,wiki] [--verticals legal,finance]

Routes: GET /healthz · GET /v1/meta · POST /v1/search · GET|POST /v1/documents
        GET /v1/documents/:id · POST /v1/documents/:id/open · POST /v1/documents/:id/rehydrate
        GET|POST /v1/wiki/pages · GET|PUT /v1/wiki/pages/:slug · GET /v1/wiki/pages/:slug/diff
        GET /v1/wiki/search · GET /v1/wiki/reviews
        GET /v1/admin/capacity · /quota · /audit · POST /v1/admin/lifecycle/sweep · /enforce
        POST /v1/admin/mirror/sync · /wiki/mirror`);
    return;
  }

  const platform = createPlatform({ dataDir: a.dataDir });
  if (a.embed !== "local") {
    const e = await createEmbedder({ base: a.ollama ? `${a.ollama.replace(/\/$/, "")}` : undefined, force: a.embed === "local" ? "local" : undefined });
    if (e.kind === "ollama") {
      platform.setEmbedder(e);
      console.log(`embedder → ${e.model} (${e.dims}d) via ${e.base}`);
    } else {
      console.log(`embedder → hash-embed-local (${e.dims}d)${e.degraded ? ` — Ollama embeddings unavailable: ${e.degraded}` : ""}`);
    }
  }

  if (a.fixtures) {
    const seeded = await seedFixtures(platform);
    console.log(`fixtures → ${seeded.documents.length} documents, ${seeded.pages.length} wiki pages, ${seeded.cold} already past the 60-day rule`);
    if (seeded.rejected.length) console.log(`  admission refused ${seeded.rejected.length}: ${seeded.rejected.map((r) => `${r.title} (${r.reasons.join("; ")})`).join(", ")}`);
    console.log(`  ${seeded.notice}`);
  }

  if (a.createKey) {
    const appId = a.app || APPS[0].id;
    const key = platform.createKey({ appId, scopes: a.scopes ? a.scopes.split(",") : null, verticals: a.verticalsArg ? a.verticalsArg.split(",") : ["*"] });
    console.log(JSON.stringify({ appId, keyId: key.id, secret: key.secret, scopes: key.scopes, verticals: key.verticals }, null, 2));
    console.log("\nStore the secret in your secrets manager. Only its hash is kept here.");
    if (!a.dataDir) console.log("note: no --data-dir, so this key exists only in memory.");
    return;
  }

  platform.server.listen(a.port, a.host, () => {
    console.log(`${PLATFORM.name} platform API → http://${a.host}:${a.port}`);
    console.log(`  store      ${platform.store.backend}${a.dataDir ? ` (${a.dataDir})` : " (in-memory — pass --data-dir to persist)"}`);
    console.log(`  embedder   ${platform.embedder.model} (${platform.embedder.dims}d)`);
    console.log(`  sharepoint ${platform.sharePoint.kind} (mirror + cold tier)`);
    console.log(`  verticals  ${verticalIds.join(", ")}`);
    console.log(`  ceiling    ${STORAGE.liveCeilingGB} GB live · ${STORAGE.nodeVolumeGB} GB per node · cold after ${TIERS.coldAfterDaysUnopened} days unopened`);
    console.log(`\n  create a key:  node platform/server.mjs --create-key --app grid-os-sovereign --data-dir ${a.dataDir || ".data/platform"}`);
  });
  return platform;
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) main().catch((e) => { console.error(e); process.exit(1); });

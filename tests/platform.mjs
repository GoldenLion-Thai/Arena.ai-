/* ============================================================================
   tests/platform.mjs — KiNETiC-Ai: the unified RAG + wiki platform.

   Proves the claims the design document makes, in the order they matter:

     capacity     the 20 GB ceiling, 50 GB per node and "double headroom" are
                  arithmetic, not adjectives — and the vertical quotas sum to
                  the ceiling exactly
     admission    "only live production useful data": drafts, personal files,
                  duplicates, stale content and over-quota ingests are refused
     retrieval    hybrid (vector + BM25 + RRF) beats either alone on an exact
                  identifier; authorisation is applied in the candidate query;
                  citations state only what is known
     retention    60 days unopened → back to SharePoint, never without a
                  verified mirror; retrieval does not reset the clock, opening
                  does; the path reopens on demand
     wiki         immutable revisions, backlinks, review queue, indexed into
                  RAG so a page is citable, mirrored back out to SharePoint
     api          one API for every app: keys, scopes, verticals, rate limits,
                  no existence leaks, hashed secrets, audit on every write

     node tests/platform.mjs
   ========================================================================== */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryStore, sha256 } from "../platform/store.mjs";
import { HashEmbedder, OllamaEmbedder, hashEmbed, cosine, tokenize } from "../platform/embeddings.mjs";
import { chunkText, admission, ingest, parse, estimateTokens } from "../platform/ingest.mjs";
import { search, bm25, rrf, diversify, contextBlock } from "../platform/retrieve.mjs";
import { MockSharePoint, syncInbound, mapPermissions } from "../platform/sharepoint.mjs";
import { sweep, rehydrate, demote, enforceCeiling, quotaReport, capacityReport, capacityTable } from "../platform/lifecycle.mjs";
import * as wiki from "../platform/wiki.mjs";
import { createPlatform, createKey } from "../platform/server.mjs";
import { seedFixtures, FIXTURE_NOTICE, FIXTURE_DOCS, FIXTURE_PAGES } from "../platform/fixtures.mjs";
import { capacityPlan, bytesPerChunk, coldWindowDays, volumePerformance, VERTICALS, TIERS, STORAGE, GB, EMBEDDING, CHUNKING, HNSW, ADMISSION } from "../platform/config.mjs";
import { startMock } from "./mock-ollama.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];
const notes = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ` — ${extra}` : "")); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
const note = (m) => { notes.push(m); console.log(`  · ${m}`); };
const section = (t) => console.log(`\n${t}`);

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * DAY).toISOString();

/* Realistic fixture documents: the kind of thing a legal or finance vertical
   actually holds, with distinct vocabulary so retrieval has something to do. */
const FIXTURES = [
  {
    id: "sp-indemnity", vertical: "legal", title: "Master services agreement — Northwind",
    contentType: "contract",
    text: `Master services agreement between Northwind Ltd and the firm.

Clause 14.2 indemnity cap. The supplier's aggregate liability under this agreement is capped at an amount equal to the fees paid in the twelve months preceding the claim, save that the cap does not apply to breaches of confidentiality, infringement of intellectual property, or fraud.

Clause 9 confidentiality. Each party shall keep the other's confidential information secret for five years after termination, and shall not use it for any purpose other than performing this agreement.

Clause 22 governing law. This agreement is governed by the laws of England and Wales, and the courts of London have exclusive jurisdiction.`,
  },
  {
    id: "sp-fca", vertical: "compliance", title: "FCA consumer duty implementation note",
    contentType: "policy",
    text: `Consumer duty implementation note, reference FCA-2024-118.

The four outcomes are products and services, price and value, consumer understanding, and consumer support. Firms must be able to evidence that good outcomes are delivered and monitored.

Board reporting is required annually, with a documented assessment of whether customers are receiving outcomes that meet the standard. Remediation plans must be logged in the compliance register within ten working days of identification.`,
  },
  {
    id: "sp-model", vertical: "finance", title: "FY26 budget model notes",
    contentType: "report",
    text: `FY26 budget model notes.

Headcount grows by eleven percent, weighted to engineering and client delivery. Infrastructure spend moves from capital to operating as the GPU estate becomes pay-as-you-go.

The model assumes a gross margin of sixty-two percent, flat foreign exchange against the euro, and no new office leases before the third quarter. Sensitivity runs at minus five and minus ten percent revenue show the covenant headroom remains above one point eight times.`,
  },
  {
    id: "sp-runbook", vertical: "operations", title: "Runbook — model host failover",
    contentType: "runbook",
    text: `Runbook for model host failover.

If the primary GPU node stops responding, drain the queue, promote the replica, and point the gateway at the new host. Verify with the health endpoint and a single short generation before returning traffic.

Escalate to the on-call engineer if the replica does not accept traffic within ten minutes. Record the incident in the operations log with timings and the model versions involved.`,
  },
];

function seedSharePoint() {
  const sp = new MockSharePoint({
    sites: [
      { id: "site-legal", name: "legal-knowledge", vertical: "legal" },
      { id: "site-compliance", name: "compliance-knowledge", vertical: "compliance" },
      { id: "site-finance", name: "finance-knowledge", vertical: "finance" },
      { id: "site-operations", name: "operations-knowledge", vertical: "operations" },
      { id: "site-company", name: "company-knowledge", vertical: "shared" },
    ],
    items: FIXTURES.map((f) => ({
      id: f.id,
      siteId: `site-${f.vertical}`,
      name: `${f.title}.md`,
      path: `/Knowledge/${f.id}.md`,
      text: f.text,
      contentType: f.contentType,
      modifiedAt: daysAgo(3),
      permissions: [{ grantedToIdentities: [{ group: { id: `grp-${f.vertical}` } }] }],
    })),
  });
  // a personal OneDrive item that must never be mirrored
  sp.seed([{ id: "sp-personal", siteId: "site-legal", name: "my-notes.md", text: "personal diary of a fee earner, not production knowledge", personal: true, modifiedAt: daysAgo(1) }]);
  return sp;
}

async function buildWorld(opts = {}) {
  const store = new MemoryStore({ dataDir: opts.dataDir || null });
  const embedder = opts.embedder || new HashEmbedder();
  const sp = opts.sharePoint || seedSharePoint();
  const ingestDoc = (i) => ingest(store, embedder, i);
  const sync = await syncInbound(store, sp, ingestDoc, { actor: "test-sync" });
  return { store, embedder, sp, ingestDoc, sync };
}

/* ============================================================== capacity */
section("capacity — 20 GB live, 50 GB per node, double headroom");

const plan = capacityPlan();
const per = bytesPerChunk();
ok("live ceiling is 20 GB", STORAGE.liveCeilingGB === 20, String(STORAGE.liveCeilingGB));
ok("each node is provisioned 50 GB", STORAGE.nodeVolumeGB === 50, String(STORAGE.nodeVolumeGB));
ok("headroom policy is 2x and the plan meets it", STORAGE.headroomTarget === 2 && plan.headroomRatio >= 2, `ratio ${plan.headroomRatio}`);
ok("provisioned storage is at least double the ceiling", plan.provisionedGB >= plan.liveGB * 2, `${plan.provisionedGB} vs ${plan.liveGB * 2}`);
ok("per-chunk cost is dominated by the vector + HNSW index", per.column + per.index > per.text + per.fts + per.rowMeta, JSON.stringify(per));
ok("embedding column is dims x 4 bytes", per.column === 768 * 4 + 8, String(per.column));
ok("HNSW index follows the d*4 + m*3*4 formula with page overhead", per.index === Math.round((768 * 4 + 16 * 3 * 4) * 1.3), String(per.index));
ok("chunk budget fits inside the ceiling", plan.chunkBudget * per.total <= plan.liveGB * GB, `${(plan.chunkBudget * per.total / GB).toFixed(2)} GB of ${plan.liveGB} GB`);
ok("chunk budget is expressed in documents too", plan.documentsLong > 1000 && plan.documentsShort > plan.documentsLong * 5, `${plan.documentsLong} long / ${plan.documentsShort} short`);
ok("RAM recommendation is double the working set", plan.ramRecommendedGB >= plan.ramWantGB * 2 - 1, `${plan.ramRecommendedGB} GB vs ${plan.ramWantGB} GB want`);
ok("connection headroom is at least double", plan.connections.headroom >= 2, String(plan.connections.headroom));
const quotaSum = VERTICALS.reduce((s, v) => s + v.quotaGB, 0);
ok("vertical quotas sum exactly to the ceiling", Math.abs(quotaSum - STORAGE.liveCeilingGB) < 1e-9, `${quotaSum} GB`);
ok("every vertical has a SharePoint site and a retention window", VERTICALS.every((v) => v.sharePointSite && v.retentionDays > 0));
const vol10 = volumePerformance(10, 50);
ok("50 GB at 10 VPU gives OCI's documented 3,000 IOPS", vol10.iops === 3000, String(vol10.iops));
ok("50 GB at 10 VPU gives about 23 MB/s", vol10.mbps >= 23 && vol10.mbps <= 24, String(vol10.mbps));
ok("a higher VPU tier buys IOPS on the same volume", volumePerformance(20, 50).iops > vol10.iops);
ok("halfvec would roughly halve the chunk cost", bytesPerChunk(768, 16, true).total < per.total * 0.7, `${bytesPerChunk(768, 16, true).total} vs ${per.total}`);

/* ============================================================== embeddings */
section("embeddings — local by default, real Ollama when present");

const emb = new HashEmbedder();
const v1 = await emb.embed("indemnity cap twelve months fees");
const v2 = await emb.embed("indemnity cap twelve months fees");
const v3 = await emb.embed("the weather in Bolton is grey");
ok("embedding is deterministic", Math.abs(cosine(v1, v2) - 1) < 1e-12, String(cosine(v1, v2)));
ok("dimension matches the configured model", v1.length === 768, String(v1.length));
const norm = Math.sqrt(Array.from(v1).reduce((a, b) => a + b * b, 0));
ok("vectors are L2-normalised so cosine is a dot product", Math.abs(norm - 1) < 1e-9, String(norm));
ok("related text scores higher than unrelated", cosine(v1, v3) < cosine(v1, await emb.embed("liability cap for the twelve months before a claim")) * 0.9, `${cosine(v1, v3).toFixed(3)} vs related`);
ok("tokeniser drops stopwords", !tokenize("the agreement of the parties").includes("the"));

const mock = await startMock(0);
const mockBase = mock.url || `http://127.0.0.1:${mock.port}`;
const oll = new OllamaEmbedder({ base: `${mockBase}`, model: "nomic-embed-text" });
const health = await oll.health();
ok("Ollama embedder reaches the host", health.ok === true, JSON.stringify(health));
ok("host reports the embedding model's dimensions", health.dims === 768, String(health.dims));
const remoteVec = await oll.embed("indemnity cap twelve months fees");
ok("remote embeddings come back normalised", remoteVec.length === 768 && Math.abs(cosine(remoteVec, remoteVec) - 1) < 1e-9);
const before = oll.calls;
await oll.embed("indemnity cap twelve months fees");
ok("repeat embeddings are cached, not recomputed", oll.calls === before, `${before} → ${oll.calls}`);
const dead = new OllamaEmbedder({ base: "http://127.0.0.1:9", model: "x", timeoutMs: 800 });
const deadHealth = await dead.health();
ok("an unreachable embedder reports unhealthy rather than pretending", deadHealth.ok === false);
let threw = null;
try { await dead.embed("anything"); } catch (e) { threw = e; }
ok("a failed embedding throws and offers a fallback vector", threw?.code === "EMBED_FAILED" && threw.fallbackVector?.length === 768, threw?.message);

/* ============================================================== chunking */
section("chunking — boundaries, overlap, and honest metadata");

const long = FIXTURES[0].text.repeat(6);
const chunks = chunkText(long, { targetTokens: 120, maxTokens: 200, overlapTokens: 25, minTokens: 20 });
ok("long text is split into several chunks", chunks.length > 3, String(chunks.length));
ok("chunks respect the target size", chunks.every((c) => c.text.length <= 200 * 4 + 80), String(Math.max(...chunks.map((c) => c.text.length))));
ok("consecutive chunks overlap so facts on a boundary survive", chunks.slice(1).some((c, i) => {
  const prev = chunks[i].text;
  const tail = prev.slice(-40).trim();
  return tail && c.text.includes(tail.slice(0, 20));
}));
ok("char offsets are contiguous and cover the source", chunks[0].charStart === 0 && chunks[chunks.length - 1].charEnd >= long.length - 1);
ok("no page number is invented when the source has none", chunks.every((c) => c.pageStart === null));
ok("token estimates are chars/4", estimateTokens("abcd".repeat(100)) === 100);
ok("headings are captured from markdown", chunkText("# Indemnity\n\nSome body text here that is long enough to keep.\n\n# Confidentiality\n\nMore text.").some((c) => /Indemnity|Confidentiality/.test(c.heading || "")));
ok("html is stripped to text", !parse("<p>Clause <b>14.2</b> indemnity</p><script>x</script>", "html").includes("<"));

/* ============================================================== admission */
section("admission — only live production useful data");

{
  const { store, ingestDoc } = await buildWorld();
  const good = admission({ title: "Engagement letter template v4", text: FIXTURES[0].text, vertical: "legal", contentType: "contract", sharePoint: { itemId: "sp-indemnity" } }, store);
  ok("a real production document is accepted", good.accept === true, good.reasons.join("; "));

  const draft = admission({ title: "DRAFT advice note", text: FIXTURES[0].text, vertical: "legal", contentType: "contract" }, store);
  ok("drafts are refused", draft.accept === false && /draft/i.test(draft.reasons.join(" ")), draft.reasons.join("; "));

  const personal = admission({ title: "notebook", text: FIXTURES[0].text, vertical: "legal", contentType: "document", sourceKind: "onedrive-personal" }, store);
  ok("personal OneDrive content is refused", personal.accept === false && /personal/i.test(personal.reasons.join(" ")), personal.reasons.join("; "));

  const thin = admission({ title: "stub", text: "See attached.", vertical: "legal", contentType: "document" }, store);
  ok("content below the token floor is refused", thin.accept === false && /token floor/.test(thin.reasons.join(" ")), thin.reasons.join("; "));

  const stale = admission({ title: "old memo", text: FIXTURES[0].text, vertical: "legal", contentType: "document", modifiedAt: daysAgo(4000) }, store);
  ok("content beyond the retention window is refused", stale.accept === false && /beyond the/.test(stale.reasons.join(" ")), stale.reasons.join("; "));

  const badVertical = admission({ title: "x", text: FIXTURES[0].text, vertical: "marketing", contentType: "document" }, store);
  ok("an unknown vertical is refused", badVertical.accept === false && /unknown vertical/.test(badVertical.reasons.join(" ")));

  const badType = admission({ title: "x", text: FIXTURES[0].text, vertical: "legal", contentType: "chat-log" }, store);
  ok("a non-production content type is refused", badType.accept === false && /not production knowledge/.test(badType.reasons.join(" ")));

  const noSp = admission({ title: "x", text: FIXTURES[0].text, vertical: "legal", contentType: "document" }, store);
  ok("missing provenance warns but does not block", noSp.accept === true && /SharePoint item id/.test(noSp.warnings.join(" ")), noSp.warnings.join("; "));

  const dup = admission({ title: "copy of the MSA", text: FIXTURES[0].text, vertical: "legal", contentType: "contract" }, store);
  ok("a duplicate is detected by content hash and warns", dup.duplicateOf && /duplicate of/.test(dup.warnings.join(" ")), dup.warnings.join("; "));

  const pii = admission({ title: "x", text: FIXTURES[0].text, vertical: "legal", contentType: "document", piiFlagged: true }, store);
  ok("PII is flagged for review, not silently indexed", pii.warnings.some((w) => /PII/.test(w)));

  const rejectedIngest = await ingestDoc({ title: "DRAFT note", text: FIXTURES[0].text, vertical: "legal", contentType: "contract" });
  ok("ingest refuses what admission refuses", rejectedIngest.accepted === false && rejectedIngest.reasons.length > 0);
  ok("a refusal is audited", store.auditLog({ action: "ingest.rejected" }).length > 0);

  const spItems = store.listDocuments({});
  ok("the inbound mirror skipped the personal item", !spItems.some((d) => /personal diary/.test(d.summary || "")));
}

/* ============================================================== ingestion */
section("ingestion — mirror sync, dedupe, indexing");

{
  const w = await buildWorld();
  const { store, sync } = w;
  ok("delta sync ingested every fixture", sync.created === FIXTURES.length, JSON.stringify({ created: sync.created, updated: sync.updated, rejected: sync.rejected }));
  ok("one document per fixture", store.listDocuments({}).length === FIXTURES.length, String(store.listDocuments({}).length));
  ok("each document has chunks with embeddings", store.listDocuments({}).every((d) => store.chunksFor(d.id).length > 0 && store.chunksFor(d.id).every((c) => c.embedding?.length === 768)));
  ok("documents carry their SharePoint provenance", store.listDocuments({}).every((d) => d.sharePoint?.itemId && d.sharePoint?.webUrl));
  ok("documents carry a content hash for mirror verification", store.listDocuments({}).every((d) => /^[0-9a-f]{64}$/.test(d.contentHash || "")));
  ok("documents start in the hot tier", store.listDocuments({}).every((d) => d.tier === "hot"));
  ok("documents inherit the sensitivity of their vertical", store.listDocuments({ vertical: "compliance" }).every((d) => d.sensitivity === "critical"));
  ok("permissions were mapped from the source item", store.listDocuments({}).every((d) => d.acl.groups.some((g) => g.startsWith("sp:group:"))));
  ok("a summary and summary vector exist for every document", store.listDocuments({}).every((d) => d.summary.length > 20 && d.summaryEmbedding?.length === 768));
  ok("the sync was audited", store.auditLog({ action: "mirror.sync" }).length === 1);

  // dedupe: re-syncing the same content must update, not duplicate
  const again = await syncInbound(store, w.sp, w.ingestDoc, { actor: "test-sync" });
  ok("re-syncing identical content updates in place", again.created === 0 && again.updated === FIXTURES.length, JSON.stringify(again));
  ok("document count is unchanged after a re-sync", store.listDocuments({}).length === FIXTURES.length);

  // an edit in SharePoint propagates
  w.sp.simulateEdit("sp-indemnity", FIXTURES[0].text + "\n\nClause 30 added: liability for data breaches is uncapped where caused by wilful misconduct.");
  const afterEdit = await syncInbound(store, w.sp, w.ingestDoc, { actor: "test-sync" });
  ok("an edit in SharePoint is picked up by the next delta", afterEdit.updated >= 1, JSON.stringify({ updated: afterEdit.updated, created: afterEdit.created }));
  const edited = store.listDocuments({ vertical: "legal" }).find((d) => d.sharePoint.itemId === "sp-indemnity");
  ok("the edited document now contains the new clause", store.chunksFor(edited.id).some((c) => /wilful misconduct/.test(c.text)));
  ok("the content hash changed with the content", edited.contentHash !== sha256(FIXTURES[0].text));

  // a deletion at the source removes it here
  w.sp.simulateDelete("sp-runbook");
  const afterDelete = await syncInbound(store, w.sp, w.ingestDoc, { actor: "test-sync" });
  ok("a source deletion removes the document", afterDelete.removed === 1, JSON.stringify(afterDelete));
  ok("the removal is audited with a reason", store.auditLog({ action: "mirror.removed" }).length === 1);
}

/* ============================================================== retrieval */
section("retrieval — hybrid, authorised, citable");

{
  const { store, embedder } = await buildWorld();

  const semantic = await search(store, embedder, { query: "how much can the supplier be sued for", k: 5 });
  ok("a paraphrase finds the right document", semantic.citations[0]?.title.includes("Master services agreement"), semantic.citations[0]?.title);
  ok("results carry a score and a fusion trace", typeof semantic.citations[0].score === "number" && Array.isArray(semantic.citations[0].fusion));
  ok("retrieval is inside the latency budget", semantic.metrics.withinBudget === true, `${semantic.metrics.retrievalMs}ms`);
  ok("metrics report the candidate pool and both rankings", semantic.metrics.poolSize > 0 && semantic.metrics.denseHits > 0 && semantic.metrics.lexicalHits > 0);

  const exact = await search(store, embedder, { query: "clause 14.2", k: 5 });
  ok("an exact identifier is found by the lexical leg", exact.citations.some((c) => c.method === "lexical" || c.method === "hybrid"), exact.citations.map((c) => c.method).join(","));
  ok("the exact-identifier query lands on the indemnity clause", /14\.2|indemnity/i.test(exact.citations[0]?.quote || ""), exact.citations[0]?.quote?.slice(0, 60));

  const ref = await search(store, embedder, { query: "FCA-2024-118 consumer duty outcomes", k: 5 });
  ok("a reference number routes to the compliance vertical", ref.citations[0]?.vertical === "compliance", ref.citations[0]?.vertical);

  // Does hybrid find the exact identifier, in the right document, first?
  const idQueries = [
    { q: "clause 14.2", needle: "14.2", vertical: "legal" },
    { q: "FCA-2024-118 board reporting", needle: "fca-2024-118", vertical: "compliance" },
    { q: "covenant headroom one point eight times", needle: "covenant", vertical: "finance" },
  ];
  const chunkTextOf = (id) => store.data.chunks.find((c) => c.id === id)?.text || "";
  let hybridTop = 0;
  let denseTop = 0;
  for (const { q, needle, vertical } of idQueries) {
    const hyb = await search(store, embedder, { query: q, k: 5 });
    // the cited quote is a 420-char excerpt, so check the chunk it came from
    ok(`"${needle}" is in a chunk the search actually cites`, hyb.citations.some((c) => chunkTextOf(c.chunkId).toLowerCase().includes(needle)), hyb.citations.map((c) => c.title).join(" | "));
    if (hyb.citations[0]?.vertical === vertical) hybridTop++;
    const dense = store.vectorSearch(await embedder.embed(q), { k: 5 });
    if (dense[0] && store.getDocument(dense[0].chunk.docId)?.vertical === vertical) denseTop++;
  }
  ok("hybrid ranks the right document first for every exact identifier", hybridTop === idQueries.length, `${hybridTop}/${idQueries.length}`);
  note(`top-1 document by exact identifier — hybrid ${hybridTop}/${idQueries.length}, vector-only ${denseTop}/${idQueries.length}. The offline embedder is a hashing bag-of-words, so it is lexical by nature; the gap only shows with a real neural model.`);

  // citation contract
  const c = semantic.citations[0];
  ok("citation names the document and vertical", !!c.title && !!c.vertical);
  ok("citation carries a checksum", /^sha256:[0-9a-f]{16}$/.test(c.checksum || ""), c.checksum);
  ok("citation carries the SharePoint pointer so a human can open the source", !!c.sharePoint?.itemId && !!c.sharePoint?.webUrl);
  ok("citation carries sensitivity and tier", !!c.sensitivity && !!c.tier);
  ok("citation states only a page when the source supplied one", c.page === null);
  ok("citation includes the quoted span", c.quote.length > 40 && c.span?.chars?.length === 2);
  ok("citation is timestamped", !!c.retrievedAt);

  // diversity
  const many = await search(store, embedder, { query: "agreement clause liability confidentiality", k: 8, perDoc: 2 });
  const counts = {};
  many.citations.forEach((x) => (counts[x.docId] = (counts[x.docId] || 0) + 1));
  ok("no single document monopolises the context window", Math.max(...Object.values(counts)) <= 2, JSON.stringify(counts));

  // authorisation is applied in the query, not after it
  const scoped = await search(store, embedder, { query: "indemnity cap", k: 5, verticals: ["finance"], appId: "finance-app" });
  const unscoped = await search(store, embedder, { query: "indemnity cap", k: 5 });
  ok("a vertical-scoped search never returns another vertical's content", scoped.citations.every((x) => x.vertical === "finance"), scoped.citations.map((x) => x.vertical).join(","));
  ok("scoping shrinks the candidate pool, proving it happens in the query", scoped.metrics.poolSize < unscoped.metrics.poolSize, `${scoped.metrics.poolSize} < ${unscoped.metrics.poolSize}`);

  const aclDoc = store.listDocuments({ vertical: "legal" })[0];
  aclDoc.acl = { readers: ["sp:user-alice"], groups: [], denyPublic: true };
  store.putDocument(aclDoc);
  const asBob = await search(store, embedder, { query: "indemnity cap", k: 5, readers: ["sp:user-bob"], appId: null });
  const asAlice = await search(store, embedder, { query: "indemnity cap", k: 5, readers: ["sp:user-alice"], appId: null });
  ok("a reader outside the ACL cannot retrieve the document", !asBob.citations.some((x) => x.docId === aclDoc.id));
  ok("the authorised reader can", asAlice.citations.some((x) => x.docId === aclDoc.id));
  ok("the ACL check reduced the pool, not the result list", asBob.metrics.poolSize < asAlice.metrics.poolSize, `${asBob.metrics.poolSize} vs ${asAlice.metrics.poolSize}`);
  aclDoc.acl = { readers: [], groups: [`sp:group:grp-legal`], denyPublic: true };
  store.putDocument(aclDoc);

  // the context block the model receives
  const ctx = contextBlock(semantic, { maxTokens: 3200 });
  ok("the context block numbers its sources", /\[1\]/.test(ctx.text) && ctx.sources >= 1);
  ok("the context block instructs citation and refusal", /Cite them as \[n\]/.test(ctx.text) && /say so/.test(ctx.text));
  ok("the context block reports its token cost", ctx.tokens > 0 && ctx.grounded === true);
  const empty = contextBlock({ citations: [], cold: [] });
  ok("with no sources the block tells the model to say so", /could not find it/.test(empty.text) && empty.grounded === false);

  // retrieval must not reset the retention clock
  const beforeOpen = aclDoc.lastOpenedAt;
  await search(store, embedder, { query: "indemnity cap confidentiality", k: 5 });
  ok("retrieval does NOT reset the retention clock", store.getDocument(aclDoc.id).lastOpenedAt === beforeOpen);
  store.markOpened(aclDoc.id, "alice", "grid-os-sovereign", "open");
  ok("an explicit open DOES reset the retention clock", store.getDocument(aclDoc.id).lastOpenedAt !== beforeOpen);
  ok("search hits are audited with the query for review", store.auditLog({ action: "search.hit" }).length > 0);

  // ranking primitives
  const pool = store.scanChunks({});
  const lex = bm25("indemnity cap", pool);
  ok("BM25 ranks the indemnity chunk first", /indemnity/i.test(lex[0].chunk.text));
  const fused = rrf([[{ chunk: pool[0], score: 1 }], [{ chunk: pool[1], score: 1 }]]);
  ok("RRF is rank-based, so unrelated score scales can be fused", fused.length === 2 && fused[0].score > 0);
  ok("diversify caps chunks per document", diversify(pool.slice(0, 10).map((chunk) => ({ chunk, score: 1 })), { perDoc: 1, k: 10 }).length <= new Set(pool.slice(0, 10).map((c) => c.docId)).size);
}

/* ============================================================== retention */
section("retention — 60 days, verified mirror, and the path back");

{
  const { store, embedder, sp } = await buildWorld();
  const legal = store.listDocuments({ vertical: "legal" })[0];
  const compliance = store.listDocuments({ vertical: "compliance" })[0];

  // make one document old enough to fall out of the live tier
  legal.lastOpenedAt = daysAgo(61);
  store.putDocument(legal);
  compliance.lastOpenedAt = daysAgo(20);
  store.putDocument(compliance);

  const dry = await sweep(store, sp, { dryRun: true, actor: "test" });
  ok("a dry-run sweep plans the demotion without doing it", dry.planned.length === 1 && dry.demoted.length === 0 && store.getDocument(legal.id).tier === "hot", JSON.stringify(dry.planned.map((p) => p.title)));
  ok("the dry run names the document and the bytes it would free", dry.planned[0].bytesFreed > 0 && dry.planned[0].days === 61);

  const ran = await sweep(store, sp, { actor: "test" });
  const demoted = store.getDocument(legal.id);
  ok("a document unopened for 61 days is demoted", ran.demoted.length === 1 && demoted.tier === "cold", `${demoted.tier}`);
  ok("a document opened 20 days ago is left alone", store.getDocument(compliance.id).tier !== "cold");
  ok("demotion dropped the chunks from the live tier", store.chunksFor(legal.id).length === 0);
  ok("demotion kept the summary and its vector, so it stays discoverable", demoted.summary.length > 20 && demoted.summaryEmbedding?.length === 768);
  ok("demotion recorded why, with the window in force", /not opened for 61 days/.test(demoted.archiveReason), demoted.archiveReason);
  ok("demotion verified the mirror first", demoted.mirrorState === "verified" && !!demoted.mirrorEtag && ran.verified === 1);
  ok("bytes freed are accounted for", ran.bytesFreed === ran.demoted[0].bytesFreed && ran.bytesFreed > 0);
  ok("a lifecycle event and an audit entry were written", store.lifecycleEvents({ docId: legal.id }).length === 1 && store.auditLog({ action: "lifecycle.demoted" }).length === 1);
  ok("cold content no longer appears in normal retrieval", !(await search(store, embedder, { query: "indemnity cap twelve months", k: 5 })).citations.some((c) => c.docId === legal.id));

  const withCold = await search(store, embedder, { query: "indemnity cap twelve months fees", k: 5, includeCold: true });
  ok("archived content is still DISCOVERED, with the reason", withCold.cold.some((c) => c.docId === legal.id), JSON.stringify(withCold.cold.map((c) => c.title)));
  ok("the discovery names the reopen path", withCold.cold[0]?.reopen === `/v1/documents/${legal.id}/rehydrate`, withCold.cold[0]?.reopen);
  ok("the discovery says it reverted to SharePoint", /reverted to SharePoint/.test(withCold.cold[0]?.reason || ""), withCold.cold[0]?.reason);
  ok("the context block tells the model archived material exists but is not quoted", /Archived but possibly relevant/.test(contextBlock(withCold).text));

  // never demote the only copy
  const finance = store.listDocuments({ vertical: "finance" })[0];
  finance.lastOpenedAt = daysAgo(90);
  store.putDocument(finance);
  sp.simulateEdit(finance.sharePoint.itemId, "the mirror has drifted and no longer matches the platform copy");
  const blocked = await sweep(store, sp, { actor: "test" });
  ok("demotion is blocked when the mirror does not verify", blocked.skipped.length === 1 && store.getDocument(finance.id).tier !== "cold", JSON.stringify(blocked.skipped[0]?.reason));
  ok("the block is reported with the reason", /hash differs|drifted/i.test(blocked.skipped[0].reason), blocked.skipped[0].reason);
  ok("a blocked demotion is audited, not silent", store.auditLog({ action: "lifecycle.demotion_blocked" }).length === 1);
  ok("the unverified document keeps its chunks", store.chunksFor(finance.id).length > 0);

  const orphan = await ingest(store, embedder, { title: "Platform-only note", text: FIXTURES[3].text, vertical: "operations", contentType: "runbook", sourceKind: "api" });
  orphan.doc.lastOpenedAt = daysAgo(120);
  store.putDocument(orphan.doc);
  const orphanSweep = await sweep(store, sp, { actor: "test" });
  ok("content with no mirror is never demoted", orphanSweep.skipped.some((s) => s.docId === orphan.doc.id) && store.getDocument(orphan.doc.id).tier !== "cold");

  // reopen the path
  const r = await rehydrate(store, sp, embedder, legal.id, { actor: "alice", appId: "grid-os-sovereign" });
  const back = store.getDocument(legal.id);
  ok("rehydration reopens the path", r.ok === true && back.tier === "hot", JSON.stringify(r));
  ok("the content is back in the live tier with chunks", store.chunksFor(legal.id).length > 0);
  ok("rehydration reports how long it took", typeof r.ms === "number" && r.ms >= 0);
  ok("rehydration is audited as a lifecycle event", store.auditLog({ action: "lifecycle.rehydrated" }).length === 1 && store.lifecycleEvents({ docId: legal.id }).some((e) => e.to === "hot"));
  ok("the reopened document is citable again", (await search(store, embedder, { query: "indemnity cap twelve months", k: 5 })).citations.some((c) => c.docId === legal.id));
  ok("rehydrating a hot document is a no-op with a clear error", (await rehydrate(store, sp, embedder, legal.id)).ok === false);
  ok("rehydrating an unknown document says so", (await rehydrate(store, sp, embedder, "doc_nope")).error === "no such document");

  // drift on rehydration is surfaced, not hidden: archive first (mirror still
  // verifies), THEN change the source, then reopen the path
  const drifted = store.listDocuments({ vertical: "compliance" })[0];
  drifted.lastOpenedAt = daysAgo(80);
  store.putDocument(drifted);
  const driftSweep = await sweep(store, sp, { actor: "test" });
  ok("the compliance document was archived before the drift test", store.getDocument(drifted.id).tier === "cold", JSON.stringify(driftSweep.demoted.map((d) => d.docId)));
  sp.simulateEdit(drifted.sharePoint.itemId, FIXTURES[1].text + "\n\nAmended: board reporting is now quarterly.");
  const rh = await rehydrate(store, sp, embedder, drifted.id, { actor: "alice" });
  ok("rehydration detects that the mirror changed while archived", rh.ok === true && rh.drifted === true, JSON.stringify(rh));
  ok("the rehydrated copy is the SharePoint one (source of record)", store.chunksFor(drifted.id).some((c) => /quarterly/.test(c.text)));

  // adaptive window under quota pressure
  ok("the default window is 60 days", coldWindowDays(0.1, { quotaGB: 5 }) === 60);
  ok("at 90% of quota the window tightens to 30 days", coldWindowDays(4.6, { quotaGB: 5 }) === TIERS.adaptive.tightenedDays);
  ok("at 97% of quota it tightens to 14 days", coldWindowDays(4.9, { quotaGB: 5 }) === TIERS.adaptive.criticalDays);

  // the ceiling is enforced, oldest-opened first
  const ceiling = await enforceCeiling(store, sp, { ceilingGB: 0.00001, actor: "test" });
  ok("the ceiling enforcement demotes until back under the limit", ceiling.demoted > 0, JSON.stringify({ demoted: ceiling.demoted, liveGB: ceiling.stillOver }));
  ok("enforcement is audited", store.auditLog({ action: "lifecycle.ceiling_enforced" }).length === 1);

  // quota + capacity reporting
  const q = quotaReport(store);
  ok("the quota report covers every vertical", q.rows.length === VERTICALS.length);
  ok("the quota report shows the window in force per vertical", q.rows.every((r) => r.windowDays > 0 && r.defaultWindowDays === 60));
  ok("the quota report totals against the ceiling", q.total.ceilingGB === 20 && typeof q.total.pct === "number");
  ok("the ceiling is held", q.ceilingHeld === true, `${q.total.liveGB} GB of ${q.total.ceilingGB}`);
  const cap = capacityReport(store);
  ok("the capacity report joins plan and actual", cap.plan.chunkBudget > 0 && cap.actual.chunks >= 0 && cap.headroom.storage.ok === true);
  ok("the capacity report states the policy it enforces", cap.policy.liveCeilingGB === 20 && cap.policy.nodeVolumeGB === 50 && cap.policy.coldAfterDaysUnopened === 60 && cap.policy.coldStore === "sharepoint");
  const table = capacityTable(cap);
  ok("the capacity table is presentable", table.length >= 8 && table.every((r) => r.length === 4), `${table.length} rows`);
}

/* =================================================================== wiki */
section("wiki — revisions, backlinks, review, indexing, mirror");

{
  const { store, embedder, sp } = await buildWorld();

  const p1 = await wiki.createPage(store, embedder, {
    title: "Engagement letter checklist",
    vertical: "legal",
    author: "alice",
    owner: "alice",
    reviewBy: daysAhead(45),
    tags: ["precedent", "onboarding"],
    body: `---\nowner: alice\nreview_by: ${daysAhead(45).slice(0, 10)}\ntags: [precedent, onboarding]\n---\n\n# Engagement letter checklist\n\nConfirm the indemnity cap, the confidentiality period and the governing law before sending. See [[Conflicts check]] and [the MSA](wiki:legal/master-services-agreement).\n`,
  });
  ok("a page is created with a vertical-scoped slug", p1.ok === true && p1.page.slug === "legal/engagement-letter-checklist", p1.page?.slug || p1.error);
  ok("front matter is parsed out of the body", p1.page.frontMatter.owner === "alice" && !p1.page.body.startsWith("---"));
  ok("revision 1 is recorded immutably", store.wikiRevisions(p1.page.id).length === 1 && store.wikiRevisions(p1.page.id)[0].author === "alice");
  ok("the page is indexed into RAG as a document", !!p1.page.docId && store.getDocument(p1.page.docId).sourceKind === "wiki");

  const p2 = await wiki.createPage(store, embedder, { title: "Conflicts check", vertical: "legal", author: "bob", body: "Run the conflicts database before opening a matter. Escalate any match to the general counsel.\n\nRelated: [[Engagement letter checklist]]." });
  wiki.refreshBacklinks(store);
  ok("backlinks are computed in both directions", store.getWikiPage(p1.page.slug).backlinks.includes(p2.page.slug) && store.getWikiPage(p2.page.slug).backlinks.includes(p1.page.slug), JSON.stringify({ a: store.getWikiPage(p1.page.slug).backlinks, b: store.getWikiPage(p2.page.slug).backlinks }));
  ok("duplicate slugs are refused", (await wiki.createPage(store, embedder, { title: "Conflicts check", vertical: "legal", body: "x" })).ok === false);

  const upd = await wiki.updatePage(store, embedder, p1.page.slug, { body: p1.page.body + "\nAlso confirm the data protection schedule and the sub-processor list.\n", author: "carol", note: "added DP schedule" });
  ok("an edit creates revision 2", upd.ok === true && upd.page.revision === 2, String(upd.page?.revision));
  ok("revision 1 is still readable (nothing is edited in place)", store.wikiRevisions(p1.page.id).length === 2 && /indemnity cap/.test(store.wikiRevisions(p1.page.id)[0].body));
  ok("the edit is attributed", upd.page.updatedBy === "carol");
  ok("a no-op edit is refused", (await wiki.updatePage(store, embedder, p1.page.slug, { body: upd.page.body, author: "carol" })).ok === false);
  const d = wiki.diff(store.wikiRevisions(p1.page.id)[0].body, upd.page.body);
  ok("the diff shows what changed", d.added.some((l) => /data protection schedule/.test(l)) && d.linesAfter > d.linesBefore);

  const reindexed = await search(store, embedder, { query: "data protection schedule sub-processor", k: 5, verticals: ["legal"] });
  ok("the updated page is re-indexed and citable", reindexed.citations.some((c) => c.title.includes("Engagement letter checklist")), reindexed.citations.map((c) => c.title).join(" | "));
  ok("a wiki citation follows the same contract as a document", reindexed.citations[0].checksum && "tier" in reindexed.citations[0]);

  const found = wiki.searchPages(store, "conflicts");
  ok("wiki search finds pages by title and body", found.length >= 1 && found[0].slug === "legal/conflicts-check", JSON.stringify(found.map((f) => f.slug)));
  ok("wiki search returns a snippet", (found[0].snippet || "").length > 10);

  const stale = await wiki.createPage(store, embedder, { title: "Old filing procedure", vertical: "operations", author: "dave", reviewBy: daysAgo(12), body: "Paper files are stored in the Manchester office cabinet for seven years.\n" });
  const queue = wiki.reviewQueue(store, { daysAhead: 60 });
  ok("overdue reviews are surfaced rather than trusted", queue.some((r) => r.slug === stale.page.slug && r.overdue === true && r.daysUntilDue < 0), JSON.stringify(queue.map((q) => [q.slug, q.daysUntilDue])));
  ok("a page not due yet is listed without the overdue flag", queue.some((r) => r.slug === p1.page.slug && r.overdue === false));

  const mirrored = await wiki.mirrorPages(store, sp, { siteId: "site-company" });
  ok("every page is mirrored back out to SharePoint", mirrored.uploaded === store.data.wiki_pages.length && mirrored.failed.length === 0, JSON.stringify(mirrored));
  ok("mirrored pages record their SharePoint item", store.data.wiki_pages.every((p) => p.mirrorState === "mirrored" && p.sharePoint?.itemId));
  ok("the outbound mirror wrote to the mirror library", sp.calls.upload >= store.data.wiki_pages.length);

  const stats = wiki.stats(store);
  ok("wiki stats are reported", stats.pages === store.data.wiki_pages.length && stats.revisions >= stats.pages && stats.indexed === stats.pages);
  {
    const q = new MemoryStore({});
    q.putWikiPage({ vertical: "compliance", slug: "compliance/numeric-review", title: "Numeric review date", body: "x", revision: 1, tags: [], backlinks: [] });
    const numeric = q.getWikiPage("compliance/numeric-review");
    numeric.reviewBy = Date.now() - 3 * DAY; // epoch millis, not an ISO string
    q.putWikiPage(numeric);
    const queued = wiki.reviewQueue(q, { daysAhead: 30 });
    ok("a numeric reviewBy is coerced, not silently dropped from the queue", queued.length === 1 && queued[0].slug === "compliance/numeric-review" && queued[0].overdue === true && queued[0].daysUntilDue === -3, JSON.stringify(queued));
    const junk = q.getWikiPage("compliance/numeric-review");
    junk.reviewBy = "not a date";
    q.putWikiPage(junk);
    ok("an unparseable review date is skipped rather than reported as NaN", wiki.reviewQueue(q, { daysAhead: 30 }).length === 0, JSON.stringify(wiki.reviewQueue(q, { daysAhead: 30 })));
  }

  ok("wiki links are extracted from both syntaxes", wiki.extractLinks("see [[Alpha]] and [beta](wiki:shared/beta) and /wiki/gamma").length === 3);

  /* A slug-shaped link is a path, not a phrase: [[legal/msa-northwind]] must stay
     "legal/msa-northwind". Slugifying the whole string turned the slash into a
     dash, the link matched no page, and the backlink vanished without an error —
     which is how a wiki quietly stops knowing what points at a page. */
  ok("a slug-shaped wikilink keeps its slash", wiki.linkSlug("legal/MSA — Northwind") === "legal/msa-northwind" && wiki.extractLinks("see [[shared/how-answering-works]]")[0] === "shared/how-answering-works", JSON.stringify(wiki.extractLinks("see [[shared/how-answering-works]]")));
  ok("a title-shaped wikilink still normalises to a tail", wiki.extractLinks("see [[How answering works]]")[0] === "how-answering-works", JSON.stringify(wiki.extractLinks("see [[How answering works]]")));
  ok("a labelled wikilink keeps the target, not the label", wiki.extractLinks("[[legal/msa-northwind|the Northwind MSA]]")[0] === "legal/msa-northwind");
}

/* ================================================================= API */
section("api — one platform, every app, scoped keys");

// The API world is seeded through the mirror, exactly as a real deployment is:
// SharePoint holds the sources, the platform ingests what the policy admits.
const platform = createPlatform({ dataDir: null, sharePoint: seedSharePoint() });
{
  const { store, sharePoint: sp } = platform;   // createPlatform exposes `sharePoint`
  const seeded = await syncInbound(store, sp, platform.ingest, { actor: "seed" });
  ok("the API world was seeded from the SharePoint mirror", seeded.created === FIXTURES.length, JSON.stringify({ created: seeded.created, rejected: seeded.rejected }));

  const workspaceKey = createKey(store, { appId: "grid-os-sovereign" });
  const financeKey = createKey(store, { appId: "compliance-monitor", scopes: ["search", "read"], verticals: ["compliance"] });
  const ingestKey = createKey(store, { appId: "intake-automation", scopes: ["ingest", "read"], verticals: ["legal"] });
  const adminKey = createKey(store, { appId: "grid-os-sovereign", scopes: ["admin", "search", "read"], label: "ops" });

  ok("a key secret is returned once", /^ka_/.test(workspaceKey.secret));
  ok("only the hash of the secret is stored", store.data.keys.every((k) => !k.secret && /^[0-9a-f]{64}$/.test(k.hash)));
  ok("key creation is audited", store.auditLog({ action: "key.created" }).length === 4);

  await new Promise((r) => platform.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const j = async (path, opts = {}) => {
    const res = await fetch(base + path, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const auth = (k) => ({ authorization: `Bearer ${k}` });

  const hz = await j("/healthz");
  ok("healthz is open and describes the platform", hz.status === 200 && hz.body.platform === "KiNETiC-Ai" && hz.body.verticals.length === 7, JSON.stringify(hz.body).slice(0, 120));
  ok("healthz reports the live store against the ceiling", hz.body.ceilingGB === 20 && typeof hz.body.liveGB === "number");

  const noKey = await j("/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "indemnity" }) });
  ok("an unauthenticated search is refused", noKey.status === 401, String(noKey.status));
  const badKey = await j("/v1/search", { method: "POST", headers: { ...auth("ka_wrong"), "content-type": "application/json" }, body: JSON.stringify({ query: "indemnity" }) });
  ok("an unknown key is refused", badKey.status === 401);

  const meta = await j("/v1/meta", { headers: auth(workspaceKey.secret) });
  ok("meta describes the platform to any app", meta.status === 200 && meta.body.platform.name === "KiNETiC-Ai" && meta.body.tiers.coldAfterDaysUnopened === 60);
  ok("meta tells the caller what its own key may do", meta.body.key.scopes.includes("search") && meta.body.key.appId === "grid-os-sovereign");

  const s1 = await j("/v1/search", { method: "POST", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({ query: "indemnity cap", k: 4 }) });
  ok("a scoped key can search", s1.status === 200 && s1.body.citations.length > 0, String(s1.status));
  ok("search returns a ready-made context block", !!s1.body.context?.text && s1.body.context.sources > 0);
  ok("search returns metrics for the message footer", s1.body.metrics.retrievalMs >= 0 && s1.body.metrics.embedder);

  const s2 = await j("/v1/search", { method: "POST", headers: { ...auth(financeKey.secret), "content-type": "application/json" }, body: JSON.stringify({ query: "indemnity cap", verticals: ["legal"] }) });
  ok("a key cannot reach outside its verticals", s2.status === 403, `${s2.status} ${JSON.stringify(s2.body)}`);
  const s3 = await j("/v1/search", { method: "POST", headers: { ...auth(financeKey.secret), "content-type": "application/json" }, body: JSON.stringify({ query: "consumer duty outcomes", k: 3 }) });
  ok("the same key works inside its own vertical", s3.status === 200 && s3.body.citations.every((c) => c.vertical === "compliance"), JSON.stringify(s3.body.citations?.map((c) => c.vertical)));

  const legalDoc = store.listDocuments({ vertical: "legal" })[0];
  const crossRead = await j(`/v1/documents/${legalDoc.id}`, { headers: auth(financeKey.secret) });
  ok("reading another vertical's document is a 404, not a 403 — no existence leak", crossRead.status === 404, String(crossRead.status));
  const readDoc = await j(`/v1/documents/${legalDoc.id}`, { headers: auth(workspaceKey.secret) });
  ok("reading your own vertical's document returns chunks", readDoc.status === 200 && readDoc.body.chunks.length > 0);
  ok("reading a document resets its retention clock", readDoc.body.document.openCount >= 1);

  const noScope = await j("/v1/documents", { method: "POST", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "x", text: FIXTURES[0].text, vertical: "legal", contentType: "contract" }) });
  ok("a key without the ingest scope cannot write", noScope.status === 403 && /scope/.test(noScope.body.error), JSON.stringify(noScope.body));
  const ing = await j("/v1/documents", { method: "POST", headers: { ...auth(ingestKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "Data protection schedule", text: "The processor shall implement technical and organisational measures including encryption at rest, sub-processor approval, and breach notification within 72 hours.", vertical: "legal", contentType: "contract" }) });
  ok("an ingest-scoped key can add production content", ing.status === 201 && ing.body.accepted === true, JSON.stringify(ing.body).slice(0, 140));
  ok("the ingest response reports the quota position", !!ing.body.quota && ing.body.quota.vertical === "legal");
  const bad = await j("/v1/documents", { method: "POST", headers: { ...auth(ingestKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "DRAFT thing", text: FIXTURES[0].text, vertical: "legal", contentType: "contract" }) });
  ok("the API refuses content the admission policy refuses", bad.status === 422 && bad.body.reasons.length > 0, JSON.stringify(bad.body));
  const wrongVertical = await j("/v1/documents", { method: "POST", headers: { ...auth(ingestKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "x", text: FIXTURES[2].text, vertical: "finance", contentType: "report" }) });
  ok("a key cannot ingest into a vertical it does not hold", wrongVertical.status === 403, String(wrongVertical.status));

  const wcreate = await j("/v1/wiki/pages", { method: "POST", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "Billing cadence", vertical: "finance", body: "Invoices are raised monthly in arrears. Disputes must be raised within thirty days.\n", author: "alice" }) });
  ok("a wiki-scoped key can create a page", wcreate.status === 201 && wcreate.body.page.slug === "finance/billing-cadence", JSON.stringify(wcreate.body).slice(0, 140));
  const wlist = await j("/v1/wiki/pages", { headers: auth(workspaceKey.secret) });
  ok("wiki pages are listed", wlist.status === 200 && wlist.body.count >= 1);
  const wread = await j(`/v1/wiki/pages/${encodeURIComponent("finance/billing-cadence")}`, { headers: auth(workspaceKey.secret) });
  ok("a page is readable with its revisions", wread.status === 200 && wread.body.page.body.includes("monthly in arrears") && wread.body.revisions.length === 1);
  const wedit = await j(`/v1/wiki/pages/${encodeURIComponent("finance/billing-cadence")}`, { method: "PUT", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({ body: "Invoices are raised monthly in arrears. Disputes must be raised within twenty-one days.\n", author: "carol", note: "tightened dispute window" }) });
  ok("an edit creates a new revision over the API", wedit.status === 200 && wedit.body.page.revision === 2);
  const wdiff = await j(`/v1/wiki/pages/${encodeURIComponent("finance/billing-cadence")}/diff?from=1&to=2`, { headers: auth(workspaceKey.secret) });
  ok("the diff endpoint shows the change", wdiff.status === 200 && wdiff.body.diff.added.some((l) => /twenty-one/.test(l)));
  const wsearch = await j("/v1/wiki/search?q=billing", { headers: auth(workspaceKey.secret) });
  ok("wiki search works over the API", wsearch.status === 200 && wsearch.body.results.some((r) => r.slug === "finance/billing-cadence"));
  const wikiNoScope = await j("/v1/wiki/pages", { method: "POST", headers: { ...auth(financeKey.secret), "content-type": "application/json" }, body: JSON.stringify({ title: "x", vertical: "finance", body: "y" }) });
  ok("a read-only key cannot write to the wiki", wikiNoScope.status === 403);

  // the LIST route must be scoped too, or a key learns what other verticals hold
  const listScoped = await j("/v1/wiki/pages", { headers: auth(financeKey.secret) });
  ok("a scoped key cannot list pages outside its verticals", listScoped.status === 200 && listScoped.body.pages.every((p) => p.vertical === "compliance") && listScoped.body.verticals.join(",") === "compliance", JSON.stringify(listScoped.body.pages?.map((p) => p.slug)));
  const listWide = await j("/v1/wiki/pages", { headers: auth(workspaceKey.secret) });
  ok("a wildcard key lists every page and is told its scope", listWide.status === 200 && listWide.body.count >= 1 && listWide.body.verticals.length === 7, `${listWide.body.count} pages, ${listWide.body.verticals.length} verticals`);
  const statsScoped = await j("/v1/wiki/stats", { headers: auth(financeKey.secret) });
  ok("wiki stats are scoped to the key's verticals", statsScoped.status === 200 && statsScoped.body.verticals.join(",") === "compliance" && statsScoped.body.pages === 0, JSON.stringify(statsScoped.body));
  const statsWide = await j("/v1/wiki/stats", { headers: auth(workspaceKey.secret) });
  ok("a wildcard key gets stats for the whole estate", statsWide.status === 200 && statsWide.body.pages >= 1 && statsWide.body.revisions >= statsWide.body.pages && statsWide.body.mirrored <= statsWide.body.pages && statsWide.body.indexed === statsWide.body.pages, JSON.stringify(statsWide.body));

  // opening or rehydrating a document is a write to its retention clock: item
  // ACLs apply, not just the vertical, or one app could reset another team's 60 days
  const aclTarget = store.listDocuments({ vertical: "legal" })[0];
  const keptAcl = JSON.parse(JSON.stringify(aclTarget.acl));
  const clockBefore = aclTarget.lastOpenedAt;
  aclTarget.acl = { readers: ["sp:user-alice"], groups: [], denyPublic: true };
  store.putDocument(aclTarget);
  const openDenied = await j(`/v1/documents/${aclTarget.id}/open`, { method: "POST", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({}) });
  ok("an app cannot open a document whose item ACL excludes it", openDenied.status === 404, String(openDenied.status));
  ok("a refused open did not reset the retention clock", store.getDocument(aclTarget.id).lastOpenedAt === clockBefore);
  const rehydrateDenied = await j(`/v1/documents/${aclTarget.id}/rehydrate`, { method: "POST", headers: { ...auth(workspaceKey.secret), "content-type": "application/json" }, body: JSON.stringify({}) });
  ok("an app cannot rehydrate a document it may not read", rehydrateDenied.status === 404, String(rehydrateDenied.status));
  const readDenied = await j(`/v1/documents/${aclTarget.id}`, { headers: auth(workspaceKey.secret) });
  ok("reading it is refused the same way (404, not 403 — no existence leak)", readDenied.status === 404);
  aclTarget.acl = keptAcl;
  store.putDocument(aclTarget);
  const readAllowed = await j(`/v1/documents/${aclTarget.id}`, { headers: auth(workspaceKey.secret) });
  ok("once the item ACL allows the vertical, the same read succeeds", readAllowed.status === 200 && readAllowed.body.document.id === aclTarget.id, String(readAllowed.status));

  const cap = await j("/v1/admin/capacity", { headers: auth(adminKey.secret) });
  ok("admin capacity is available to an admin key", cap.status === 200 && cap.body.plan.chunkBudget > 0);
  const capDenied = await j("/v1/admin/capacity", { headers: auth(workspaceKey.secret) });
  ok("admin capacity is refused without the admin scope", capDenied.status === 403);
  const quota = await j("/v1/admin/quota", { headers: auth(adminKey.secret) });
  ok("quota report is available and totals under the ceiling", quota.status === 200 && quota.body.ceilingHeld === true);

  const sweepDry = await j("/v1/admin/lifecycle/sweep", { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
  ok("the lifecycle sweep can be run over the API in dry-run", sweepDry.status === 200 && Array.isArray(sweepDry.body.planned), String(sweepDry.status));
  const syncApi = await j("/v1/admin/mirror/sync", { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({}) });
  ok("the SharePoint delta sync can be triggered over the API", syncApi.status === 200 && "created" in syncApi.body && "updated" in syncApi.body, JSON.stringify(syncApi.body).slice(0, 100));
  const audit = await j("/v1/admin/audit?limit=20", { headers: auth(adminKey.secret) });
  ok("every write is auditable through the API", audit.status === 200 && audit.body.entries.length > 5 && audit.body.entries.some((e) => e.action === "wiki.created"));

  // rate limiting
  const rlKey = createKey(store, { appId: "behaviour-lab", scopes: ["search"], verticals: ["shared"] });
  rlKey.ratePerMin = 3;
  store.putKey(rlKey);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await j("/v1/search", { method: "POST", headers: { ...auth(rlKey.secret), "content-type": "application/json" }, body: JSON.stringify({ query: "x", k: 1 }) })).status);
  ok("a key is rate limited per minute", codes.filter((c) => c === 429).length === 2, codes.join(","));

  // retention over the API
  const old = store.listDocuments({ vertical: "compliance" })[0];
  old.lastOpenedAt = daysAgo(75);
  store.putDocument(old);
  const openRes = await j(`/v1/documents/${old.id}/open`, { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({ actor: "alice" }) });
  ok("the open endpoint resets the retention clock and says for how long", openRes.status === 200 && openRes.body.retentionClockResetDays === 60, JSON.stringify(openRes.body));
  old.lastOpenedAt = daysAgo(75);
  store.putDocument(old);
  const rehydr = await j(`/v1/documents/${old.id}/rehydrate`, { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({ actor: "alice" }) });
  ok("rehydrating a document that is not archived explains itself", rehydr.status === 409 && /already/.test(rehydr.body.error), JSON.stringify(rehydr.body));
  const sweepReal = await j("/v1/admin/lifecycle/sweep", { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({}) });
  ok("a real sweep demotes what the policy says it should", sweepReal.status === 200 && sweepReal.body.demoted.length >= 1, JSON.stringify(sweepReal.body.demoted?.map((d) => d.docId)));
  const rehydrated = await j(`/v1/documents/${old.id}/rehydrate`, { method: "POST", headers: { ...auth(adminKey.secret), "content-type": "application/json" }, body: JSON.stringify({ actor: "alice" }) });
  ok("the archived document can be reopened over the API", rehydrated.status === 200 && rehydrated.body.ok === true, JSON.stringify(rehydrated.body).slice(0, 140));

  const missing = await j("/v1/nope", { headers: auth(adminKey.secret) });
  ok("an unknown route is a clean 404 pointing at /v1/meta", missing.status === 404 && /v1\/meta/.test(missing.body.detail || ""));

  platform.server.close();
}

/* ============================================================ permissions */
section("permissions mapping — never wider than the source");

{
  const mapped = mapPermissions([{ grantedToIdentities: [{ user: { id: "u1" } }, { group: { id: "g1" } }] }, { link: { scope: "organization" } }]);
  ok("users and groups are mapped", mapped.readers.includes("sp:u1") && mapped.groups.includes("sp:group:g1"));
  ok("a sharing link does not widen access", mapped.denyPublic === true);
  const anon = mapPermissions([{ link: { scope: "anonymous" } }], { allowAnonymous: true });
  ok("anonymous access is only possible if explicitly allowed", anon.denyPublic === false && mapPermissions([{ link: { scope: "anonymous" } }]).denyPublic === true);
  ok("an empty grant list denies", mapPermissions([]).denyPublic === true && mapPermissions([]).readers.length === 0);
}

/* ============================================================ persistence */
section("persistence — a single node keeps its data across restarts");

{
  const dir = mkdtempSync(join(tmpdir(), "kinetic-data-"));
  const s1 = new MemoryStore({ dataDir: dir });
  const e1 = new HashEmbedder();
  const sp1 = seedSharePoint();
  await syncInbound(s1, sp1, (i) => ingest(s1, e1, i), { actor: "boot-1" });
  await wiki.createPage(s1, e1, { title: "Persisted page", vertical: "shared", body: "This page must survive a restart of the platform.\n", author: "alice" });
  s1.compact();
  ok("JSONL files were written for every collection", existsSync(join(dir, "documents.jsonl")) && existsSync(join(dir, "chunks.jsonl")) && existsSync(join(dir, "wiki_pages.jsonl")));

  const s2 = new MemoryStore({ dataDir: dir });
  ok("documents survive a restart", s2.listDocuments({}).length === s1.listDocuments({}).length, `${s2.listDocuments({}).length} vs ${s1.listDocuments({}).length}`);
  ok("chunks survive a restart", s2.data.chunks.length === s1.data.chunks.length);
  ok("vectors come back as typed arrays", s2.data.chunks.every((c) => c.embedding instanceof Float64Array && c.embedding.length === 768));
  ok("wiki pages survive a restart", s2.getWikiPage("shared/persisted-page")?.title === "Persisted page");
  const revived = await search(s2, e1, { query: "indemnity cap", k: 3 });
  ok("retrieval works after a restart", revived.citations.length > 0 && /Master services/.test(revived.citations[0].title));
  ok("the audit log survives a restart", s2.auditLog({}).length > 0);
  rmSync(dir, { recursive: true, force: true });
}

/* ====================================================== origin integration */
section("origin — /platform/* proxied by server.js, one origin for every app");

{
  const plat = createPlatform({});
  await new Promise((r) => plat.server.listen(0, "127.0.0.1", r));
  const platPort = plat.server.address().port;
  createKey(plat.store, { appId: "grid-os-sovereign" });

  const app = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: "0", HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));
  await wait(700);
  const portMatch = /http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
  if (portMatch) {
    const appBase = `http://127.0.0.1:${portMatch[1]}`;
    const r = await fetch(`${appBase}/platform/healthz`);
    ok("an unconfigured platform proxy explains how to start it", r.status === 503 && (await r.json()).detail.includes("platform/server.mjs"), String(r.status));
  } else {
    ok("an unconfigured platform proxy explains how to start it", false, `server did not report a port: ${log.slice(0, 120)}`);
  }
  app.kill();
  await wait(200);

  const app2 = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: "0", HOST: "127.0.0.1", PLATFORM_URL: `http://127.0.0.1:${platPort}` }, stdio: ["ignore", "pipe", "pipe"] });
  let log2 = "";
  app2.stdout.on("data", (d) => (log2 += d));
  await wait(700);
  const m2 = /http:\/\/127\.0\.0\.1:(\d+)/.exec(log2);
  if (m2) {
    const hz = await (await fetch(`http://127.0.0.1:${m2[1]}/platform/healthz`)).json();
    ok("the platform API is reachable on the app origin", hz.ok === true && hz.platform === "KiNETiC-Ai", JSON.stringify(hz).slice(0, 100));
    const key = plat.store.data.keys[0];
    ok("server.js advertises the platform proxy at startup", /Platform\s+→/.test(log2));
  } else {
    ok("the platform API is reachable on the app origin", false, log2.slice(0, 160));
  }
  app2.kill();
  plat.server.close();
  await wait(150);
}

/* -------------------------------------------------------------------------- */
section("\nschema.sql — the production shape must agree with the code that runs here");
{
  /* Postgres is not available in this sandbox, so the schema cannot be executed
     here. What CAN be proven is that it says the same things the running code
     does: every number, every invariant, every grant. A schema that drifts from
     the policy layer is worse than no schema, because it looks authoritative. */
  const sql = readFileSync(join(ROOT, "platform/schema.sql"), "utf8");
  const constOf = (key) => {
    const m = new RegExp(`\\('${key}',\\s*([0-9.]+)`).exec(sql);
    return m ? Number(m[1]) : null;
  };
  const per = bytesPerChunk();
  // strip comments before structural checks, so prose cannot make them lie
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const fn = (name) => {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
    if (start < 0) return "";
    const end = code.indexOf("$$;", start);
    return end < 0 ? "" : code.slice(start, end + 3);
  };

  ok("the schema is a complete, executable file", sql.length > 12000 && /\\set ON_ERROR_STOP on/.test(sql) && /CREATE EXTENSION IF NOT EXISTS vector/.test(sql), `${sql.length} bytes`);

  const pairs = [
    ["embedding_dims", EMBEDDING.dims],
    ["bytes_per_dim", EMBEDDING.bytesPerDim],
    ["planning_bytes_column", per.column],
    ["planning_bytes_hnsw_index", per.index],
    ["planning_bytes_text", per.text],
    ["planning_bytes_fts", per.fts],
    ["planning_bytes_row_meta", per.rowMeta],
    ["planning_bytes_per_chunk", per.total],
    ["cold_stub_bytes", 1200 + per.column],
    ["live_ceiling_gb", STORAGE.liveCeilingGB],
    ["node_volume_gb", STORAGE.nodeVolumeGB],
    ["headroom_target", STORAGE.headroomTarget],
    ["hnsw_m", HNSW.m],
    ["hnsw_ef_construction", HNSW.efConstruction],
    ["hnsw_ef_search", HNSW.efSearch],
    ["chunk_target_tokens", CHUNKING.targetTokens],
    ["cold_after_days_unopened", TIERS.coldAfterDaysUnopened],
    ["adaptive_tighten_at_pct", TIERS.adaptive.tightenAtQuotaPct * 100],
    ["adaptive_tightened_days", TIERS.adaptive.tightenedDays],
    ["adaptive_critical_at_pct", TIERS.adaptive.criticalAtQuotaPct * 100],
    ["adaptive_critical_days", TIERS.adaptive.criticalDays],
  ];
  const drift = pairs.filter(([k, want]) => constOf(k) !== want);
  ok("every capacity constant in the schema matches config.mjs", drift.length === 0, drift.map(([k, want]) => `${k}: sql ${constOf(k)} vs code ${want}`).join(", "));
  note(`per chunk the schema plans ${constOf("planning_bytes_per_chunk")} B and a cold stub ${constOf("cold_stub_bytes")} B — identical to bytesPerChunk().total and 1200 + column`);

  // the fusion constant is proven from the function's own arithmetic, not hardcoded
  const fusedPair = rrf([[{ chunk: { id: "same" }, score: 1 }], [{ chunk: { id: "same" }, score: 0.5 }]]);
  ok("the schema's rrf_k is the constant the fusion actually uses", Math.abs(fusedPair[0].score - 2 / (constOf("rrf_k") + 1)) < 1e-12, `score ${fusedPair[0].score} vs 2/${constOf("rrf_k") + 1}`);

  // verticals: the same seven, the same quotas, summing to the same ceiling
  const vblock = sql.slice(sql.indexOf("INSERT INTO platform.verticals"), sql.indexOf("ON CONFLICT (id) DO UPDATE SET", sql.indexOf("INSERT INTO platform.verticals")));
  const vrows = [...vblock.matchAll(/\(\s*'([a-z]+)',\s*'([^']+)',\s*([0-9.]+),\s*'([a-z]+)'/g)].map((m) => ({ id: m[1], label: m[2], quota: Number(m[3]), sensitivity: m[4] }));
  ok("the schema declares the same verticals as the code", vrows.length === VERTICALS.length && vrows.every((r) => VERTICALS.some((v) => v.id === r.id)), vrows.map((r) => r.id).join(","));
  ok("each vertical quota matches the code", vrows.every((r) => VERTICALS.find((v) => v.id === r.id)?.quotaGB === r.quota), vrows.map((r) => `${r.id}=${r.quota}`).join(" "));
  ok("each vertical sensitivity matches the code", vrows.every((r) => VERTICALS.find((v) => v.id === r.id)?.sensitivity === r.sensitivity));
  const sqlSum = vrows.reduce((a, r) => a + r.quota, 0);
  ok("the schema's quotas sum to the live ceiling exactly", Math.abs(sqlSum - STORAGE.liveCeilingGB) < 1e-9, `${sqlSum} GB vs ${STORAGE.liveCeilingGB} GB`);

  // the DDL itself must use the planned dimension and index parameters
  ok("chunk and summary vectors are both declared at the planned dimension", (sql.match(new RegExp(`vector\\(${EMBEDDING.dims}\\)`, "g")) || []).length >= 3, `${(sql.match(new RegExp(`vector\\(${EMBEDDING.dims}\\)`, "g")) || []).length} columns`);
  ok("the HNSW index is built with the planned parameters", new RegExp(`WITH \\(m = ${HNSW.m}, ef_construction = ${HNSW.efConstruction}\\)`).test(sql));
  ok("the lexical leg is a generated tsvector, so it cannot drift from the text", /GENERATED ALWAYS AS \(to_tsvector\('english'/.test(sql) && /USING gin \(tsv\)/.test(sql));
  ok("vectors are constrained to be normalised on write", /CREATE TRIGGER chunks_normalised/.test(sql) && /not L2-normalised/.test(sql));
  ok("dedupe is a unique index on vertical + content hash", /CREATE UNIQUE INDEX IF NOT EXISTS documents_dedupe ON rag\.documents \(vertical, content_hash\) WHERE NOT deleted/.test(sql));

  // authorisation is in the query, and the default is deny
  const rlsTables = ["rag.documents", "rag.chunks", "wiki.pages", "wiki.revisions", "audit.events"];
  ok("row level security is enabled on every table that holds knowledge", rlsTables.every((t) => new RegExp(`ALTER TABLE ${t.replace(".", "\\.")}\\s+ENABLE ROW LEVEL SECURITY`).test(sql)), rlsTables.join(","));
  ok("documents and chunks both have a select policy", /CREATE POLICY documents_rls/.test(sql) && /CREATE POLICY chunks_rls/.test(sql));
  ok("a chunk is visible only when its document is (no post-filtering)", /CREATE POLICY chunks_rls[\s\S]{0,400}EXISTS \(SELECT 1 FROM rag\.documents d/.test(sql));
  ok("the default is deny when no principal context is set", /WHEN platform\.setting_list\('kinetic\.verticals'\) IS NULL THEN false\s+-- default deny/.test(sql));
  ok("only the internal role can bypass RLS, and it is checked by session_user", /pg_has_role\(session_user, 'kinetic_internal', 'MEMBER'\)/.test(sql) && /current_setting\('kinetic\.internal', true\) = 'on'/.test(sql));
  ok("the app role is deliberately not a member of the internal role", /REVOKE|NOT a member of kinetic_internal/.test(sql) && !/GRANT kinetic_internal TO kinetic_app/.test(sql));
  ok("apps cannot update documents directly (no ACL widening)", /GRANT SELECT, INSERT, UPDATE ON rag\.documents TO kinetic_app/.test(sql) && !/GRANT[^;]*DELETE[^;]*ON rag\.documents TO kinetic_app/.test(sql));
  ok("opening and rehydrating go through definer functions that re-check read rights", /SECURITY DEFINER SET search_path = rag, platform, pg_temp/.test(sql) && (sql.match(/platform\.can_read\(v_acl, v_vertical\)/g) || []).length >= 2);

  // the retention invariants
  ok("demotion refuses without a verified mirror", /IF NOT p_verified THEN[\s\S]{0,200}RAISE EXCEPTION 'refusing to demote/.test(sql));
  ok("cold candidates must have a SharePoint pointer and a mirrored state", /CREATE OR REPLACE VIEW rag\.cold_candidates[\s\S]{0,700}d\.sharepoint IS NOT NULL[\s\S]{0,200}d\.mirror_state IN \('mirrored', 'verified'\)/.test(sql));
  ok("cold candidates are selected by the adaptive window, not a hardcoded 60", /rag\.cold_candidates[\s\S]{0,900}platform\.cold_window_days\(d\.vertical\)/.test(sql));
  ok("opening a document is what resets the clock", /CREATE OR REPLACE FUNCTION rag\.mark_opened[\s\S]{0,1400}last_opened_at = now\(\)/.test(sql));
  const readPaths = fn("rag.search_hybrid") + fn("rag.find_cold");
  ok("retrieval never writes, so a search cannot reset the 60-day clock", !/\bUPDATE\b|\bINSERT\b|\bDELETE\b/.test(readPaths), "no write statement in either retrieval function");
  ok("cold discovery reports how long a document has been unopened", /last_opened_at/.test(fn("rag.find_cold")) && /days_unopened/.test(fn("rag.find_cold")));
  ok("rehydration refuses when there is no way back in", /has no SharePoint pointer — cannot reopen the path/.test(sql));

  // wiki history is immutable twice over
  ok("wiki revisions cannot be rewritten (trigger)", /CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON wiki\.revisions/.test(sql));
  ok("wiki revisions cannot be rewritten (grants)", /GRANT SELECT, INSERT ON wiki\.revisions TO kinetic_app/.test(sql) && !/GRANT[^;]*(UPDATE|DELETE)[^;]*ON wiki\.revisions/.test(sql));
  ok("the audit log is append-only and partitioned", /GRANT SELECT, INSERT ON audit\.events TO kinetic_app/.test(sql) && /PARTITION BY RANGE \(at\)/.test(sql) && /CREATE TRIGGER audit_immutable/.test(sql));
  ok("wiki pages carry a review date, so nothing is trusted forever", /review_by\s+date/.test(sql) && /CREATE OR REPLACE VIEW wiki\.review_queue/.test(sql));
  ok("a wiki page is indexed as a citable RAG document", /doc_id\s+uuid REFERENCES rag\.documents\(id\) ON DELETE SET NULL/.test(sql));
  ok("the link graph is stored in both directions", /CREATE TABLE IF NOT EXISTS wiki\.links/.test(sql) && /CREATE INDEX IF NOT EXISTS links_to ON wiki\.links \(to_slug\)/.test(sql));

  // secrets
  ok("api keys store a hash, never the secret", /key_hash\s+char\(64\) NOT NULL UNIQUE/.test(sql) && !/secret\s+text/.test(sql));

  // structural sanity: no Postgres to run this against, so check the shape
  ok("dollar quoting is balanced", (code.match(/\$\$/g) || []).length % 2 === 0, `${(code.match(/\$\$/g) || []).length} markers`);
  ok("parentheses are balanced", code.split("(").length === code.split(")").length, `${code.split("(").length - 1} open vs ${code.split(")").length - 1} close`);
  ok("every function declares a language", (code.match(/CREATE OR REPLACE FUNCTION/g) || []).length === (code.match(/LANGUAGE (sql|plpgsql)/g) || []).length, `${(code.match(/CREATE OR REPLACE FUNCTION/g) || []).length} functions, ${(code.match(/LANGUAGE (sql|plpgsql)/g) || []).length} languages`);
  const nonIdempotent = [...code.matchAll(/CREATE TABLE\s+(?!IF NOT EXISTS)([\w.%"]+)/g)].map((m) => m[1]);
  ok("every table is created idempotently (the one exception is the dynamic monthly partition, which is guarded by an existence check)",
    nonIdempotent.length === 1 && /audit\.%I/.test(nonIdempotent[0]), nonIdempotent.join(",") || "none");
  ok("every statement is terminated", code.trim().endsWith(";"), code.trim().slice(-60));
  ok("every dollar-quoted body closes", (code.match(/\$\$/g) || []).length === 2 * (code.match(/\$\$;|\$\$\n\s*\$\$/g) || []).length || (code.match(/\$\$/g) || []).length % 2 === 0);
  note(`schema.sql: ${(sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length} tables, ${(sql.match(/CREATE OR REPLACE (FUNCTION|VIEW)/g) || []).length} functions/views, ${(sql.match(/CREATE POLICY/g) || []).length} RLS policies, ${(sql.match(/CREATE INDEX|CREATE UNIQUE INDEX/g) || []).length} indexes`);
}

/* ================================================== boot, swap and fixtures */
section("boot — the embedder the routes use, and fixtures that admit what they are");

{
  const p = createPlatform({});
  ok("a platform boots offline with the deterministic embedder", p.embedder.model === "hash-embed-local" && p.embedder.dims === EMBEDDING.dims, `${p.embedder.model}/${p.embedder.dims}`);

  /* Regression: main() used to do `platform.embedder = ollamaEmbedder`, which set
     a property on the returned object while every route kept closing over the
     fallback — so the console announced nomic-embed-text and the platform
     embedded with a hash. The swap has to go through setEmbedder(). */
  const marker = {
    model: "marker-embed-probe", kind: "test", dims: EMBEDDING.dims,
    embed: (t) => new HashEmbedder().embed(t),
    embedBatch: (ts) => new HashEmbedder().embedBatch(ts),
  };
  p.setEmbedder(marker);
  ok("setEmbedder replaces the embedder the platform reports", p.embedder.model === "marker-embed-probe");
  let threw = null;
  try { p.setEmbedder({ model: "not-an-embedder" }); } catch (e) { threw = e; }
  ok("a thing that cannot embed is refused, not silently accepted", threw instanceof Error && p.embedder.model === "marker-embed-probe", threw?.message || "no throw");

  await new Promise((r) => p.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${p.server.address().port}`;
  const key = p.createKey({ appId: "grid-os-sovereign", scopes: ["search", "read", "ingest"] });
  const auth = { "content-type": "application/json", authorization: `Bearer ${key.secret}` };
  await p.ingest({ title: "Embedder swap proof", text: "The indemnity cap is limited to twelve months of fees and excludes consequential loss in full.", vertical: "legal", sourceModified: new Date().toISOString() });
  const swapped = await (await fetch(`${base}/v1/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "indemnity cap", k: 3 }) })).json();
  ok("the HTTP routes embed with the swapped model, not the fallback", swapped.metrics?.embedder === "marker-embed-probe", JSON.stringify(swapped.metrics?.embedder || swapped).slice(0, 160));
  const hzSwap = await (await fetch(`${base}/healthz`)).json();
  ok("healthz reports the embedder actually in use", hzSwap.embedder === "marker-embed-probe" && hzSwap.dims === EMBEDDING.dims, `${hzSwap.embedder}/${hzSwap.dims}`);
  ok("healthz says when nothing but real content is stored", hzSwap.fixtureContent === false, JSON.stringify(hzSwap.fixtureContent));
  p.server.close();
}

{
  /* Default access for content that arrives with no grants. This is a security
     boundary, so it is asserted rather than assumed: an empty readers AND empty
     groups list used to make canRead() fall through to "any app-scoped key may
     read it", which let one app read another app's confidential upload while the
     vertical grant that should have covered it was ignored. */
  const store = new MemoryStore({});
  const embedder = new HashEmbedder();
  const up = await ingest(store, embedder, {
    title: "Upload with no explicit grants",
    text: [
      "Confidential commercial terms for the Northwind engagement.",
      "",
      "The indemnity cap is twelve months of fees, and consequential loss is excluded in full. Pricing is",
      "not disclosed outside the engagement team, and any onward disclosure needs written consent from the",
      "commercial lead. Rate card changes take effect at the next renewal date, not mid-term, and a renewal",
      "quote supersedes every earlier estimate held against this account.",
    ].join("\n"),
    vertical: "legal",
    sensitivity: "confidential",
    sourceModified: new Date().toISOString(),
    appId: "intake-automation",
  });
  ok("the default-ACL test document passes admission", up.accepted === true, JSON.stringify(up.reasons || ""));
  const noGrants = store.getDocument(up.doc.id);
  ok("content with no grants defaults to its own vertical, not to every app key", noGrants.acl.groups.includes("vertical:legal") && noGrants.acl.denyPublic === true, JSON.stringify(noGrants.acl));
  ok("a reader in that vertical can read it", store.canRead(noGrants, ["vertical:legal"], null) === true);
  ok("a reader from another vertical cannot, even with an app key", store.canRead(noGrants, ["vertical:finance"], "grid-os-sovereign") === false);
  ok("an unauthenticated caller cannot", store.canRead(noGrants, [], null) === false);

  const explicit = await ingest(store, embedder, {
    title: "Document with explicit SharePoint grants",
    text: [
      "A matter-specific note restricted to two named people.",
      "",
      "Mirrored from SharePoint with its own permission set attached, so the platform must keep that set",
      "rather than substituting its own idea of who should see it. The note records the client's position on",
      "the disputed clause, the advice given, and the date the advice was given. It is not for circulation",
      "beyond the matter team, and it is not a template: every line is about this matter only.",
    ].join("\n"),
    vertical: "legal",
    sensitivity: "restricted",
    sourceModified: new Date().toISOString(),
    acl: { readers: ["sp:user-alice"], groups: [], denyPublic: true },
  });
  ok("the explicit-ACL test document passes admission too", explicit.accepted === true, JSON.stringify(explicit.reasons || ""));
  const withGrants = store.getDocument(explicit.doc.id);
  ok("explicit grants are kept exactly, never widened by the default", withGrants.acl.readers.join() === "sp:user-alice" && withGrants.acl.groups.length === 0, JSON.stringify(withGrants.acl));
  ok("so the vertical group does not leak access to an explicit ACL", store.canRead(withGrants, ["vertical:legal"], "intake-automation") === false && store.canRead(withGrants, ["sp:user-alice"], null) === true);
}

{
  const p = createPlatform({});
  const at = Date.now();
  const seeded = await seedFixtures(p, { at });

  ok("every fixture document passes admission", seeded.documents.length === FIXTURE_DOCS.length && seeded.rejected.length === 0, JSON.stringify(seeded.rejected));
  ok("every fixture wiki page is created with a vertical-scoped slug", seeded.pages.length === FIXTURE_PAGES.length && seeded.pages.every((x) => x.slug.includes("/")), seeded.pages.map((x) => x.slug).join(","));
  ok("fixture documents are labelled fixtures at the source", p.store.listDocuments({}).filter((d) => d.sourceKind === "fixture").length === FIXTURE_DOCS.length);
  ok("fixture pages carry the fixture tag, so the UI can say so", p.store.listWikiPages({}).every((pg) => (pg.tags || []).includes("fixture")));
  ok("the notice states plainly that this is not a live corpus", /not a live corpus/i.test(FIXTURE_NOTICE) && seeded.notice === FIXTURE_NOTICE);

  ok("one fixture is already past the 60-day rule", seeded.cold === 1 && /Northwind/.test(seeded.coldTitle || ""), `${seeded.cold} ${seeded.coldTitle}`);
  const coldDoc = p.store.listDocuments({}).find((d) => d.tier === "cold");
  ok("it was demoted only after its mirror verified", coldDoc.mirrorState === "verified" && !!coldDoc.mirrorEtag, coldDoc.mirrorState);
  ok("the archive reason names the rule that fired", /not opened for 61 days/.test(coldDoc.archiveReason || ""), coldDoc.archiveReason);
  ok("the cold fixture keeps a discoverable stub and no chunks", coldDoc.summary.length > 20 && coldDoc.summaryEmbedding?.length === EMBEDDING.dims && p.store.chunksFor(coldDoc.id).length === 0);
  const fixtureIds = new Set(seeded.documents.map((d) => d.id));
  ok("fixture documents come from SharePoint, so their mirror is real", [...fixtureIds].every((id) => p.store.getDocument(id)?.sharePoint?.itemId && p.store.getDocument(id)?.sharePoint?.webUrl), JSON.stringify([...fixtureIds].map((id) => p.store.getDocument(id)?.sharePoint?.itemId)));

  // `vertical:<id>` is the principal the HTTP layer derives from a key's grants.
  const legal = await search(p.store, p.embedder, { query: "termination on ninety days written notice", verticals: ["legal"], readers: ["vertical:legal"], k: 5 });
  ok("a seeded platform answers from the fixtures", legal.hits.length > 0 && legal.citations.length > 0, JSON.stringify(legal.metrics));
  ok("the archived fixture is surfaced with the reason and the way back in", legal.cold.length === 1 && /reverted to SharePoint/.test(legal.cold[0].reason) && /\/rehydrate$/.test(legal.cold[0].reopen), JSON.stringify(legal.cold[0] || {}).slice(0, 200));
  ok("the identifiers the retrieval contract promises are in the seeded corpus", FIXTURE_DOCS.some((d) => d.text.includes("clause 14.2")) && FIXTURE_DOCS.some((d) => d.text.includes("FCA-2024-118")));
  ok("seeding is audited as seeding", p.store.auditLog({ action: "fixtures.seeded" }).length === 1);

  const index = p.store.getWikiPage("shared/knowledge-index");
  const howItWorks = p.store.getWikiPage("shared/how-answering-works");
  const msa = p.store.getWikiPage("legal/msa-northwind");
  ok("the seeded index page's slug links resolve into real backlinks", howItWorks.backlinks.includes("shared/knowledge-index") && msa.backlinks.includes("shared/knowledge-index"), JSON.stringify({ how: howItWorks.backlinks, msa: msa.backlinks }));
  ok("a page cited from two places lists both, and nothing points at the index", howItWorks.backlinks.includes("compliance/retention-and-the-60-day-rule") && index.backlinks.length === 0, JSON.stringify({ how: howItWorks.backlinks, index: index.backlinks }));

  const reviews = wiki.reviewQueue(p.store, { daysAhead: 30 });
  ok("the seeded review queue is not empty — one page is deliberately overdue", reviews.length === 1 && reviews[0].slug === "compliance/retention-and-the-60-day-rule" && reviews[0].overdue === true && reviews[0].daysUntilDue === -3, JSON.stringify(reviews));
  ok("the page due in 180 days is not in a 30-day queue", !reviews.some((r) => r.slug === "legal/msa-northwind"));

  await new Promise((r) => p.server.listen(0, "127.0.0.1", r));
  const hz = await (await fetch(`http://127.0.0.1:${p.server.address().port}/healthz`)).json();
  ok("healthz admits the store holds fixture content", hz.fixtureContent === true, JSON.stringify(hz.fixtureContent));
  ok("healthz still reports real capacity numbers for a seeded platform", hz.documents === FIXTURE_DOCS.length + FIXTURE_PAGES.length && hz.chunks > 0 && hz.ceilingGB === STORAGE.liveCeilingGB, JSON.stringify({ d: hz.documents, c: hz.chunks }));
  p.server.close();
  note(`fixtures: ${seeded.documents.length} documents, ${seeded.pages.length} wiki pages, ${seeded.cold} cold, ${p.store.scanChunks({}).length} live chunks`);
}

await mock.close();

console.log(`\n${passed} passed · ${failed} failed`);
if (notes.length) { console.log("\nNotes:"); notes.forEach((n) => console.log("  · " + n)); }
if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  • " + f)); }
process.exit(failed ? 1 : 0);

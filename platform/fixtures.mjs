/* ------------------------------------------------------------------ *
 * KiNETiC-Ai — fixture content
 * ------------------------------------------------------------------ *
 * Sample data for demos, previews and manual testing. Every item it
 * creates is labelled: `sourceKind: "fixture"`, a SharePoint path under
 * /fixtures/, and the notice below is written into the store so the API
 * and the wiki can say so out loud. Fixture content is never presented
 * as a customer corpus — if the platform reports fixtures, it reports
 * that they are fixtures.
 *
 * It seeds through the real code paths only: ingest() for admission,
 * chunking and embedding; createPage() for the wiki; and sweep() for
 * the cold tier, so a seeded platform behaves exactly like a used one.
 * ------------------------------------------------------------------ */

import { ingest } from "./ingest.mjs";
import { createPage } from "./wiki.mjs";
import { sweep } from "./lifecycle.mjs";

export const FIXTURE_NOTICE =
  "Fixture content — sample documents for demos and tests, not a live corpus. Seeded with --fixtures.";

const DAY = 86400000;
const now = Date.now();

/* Each fixture is short on purpose: long enough to survive admission
   (≥ MIN_DOCUMENT_TOKENS), short enough that a demo ingest is instant.
   The identifiers in them are the ones the retrieval tests look for, so
   a seeded platform can be searched for "clause 14.2" or "FCA-2024-118"
   from the wiki UI and get a real citation back. */
export const FIXTURE_DOCS = [
  {
    title: "Master services agreement — Northwind Logistics Ltd",
    vertical: "legal",
    tags: ["contract", "msa", "fixture"],
    sensitivity: "confidential",
    text: [
      "# Master services agreement",
      "",
      "Between Northwind Logistics Ltd (the Client) and the Supplier, dated 14 March 2025.",
      "",
      "## 14 · Term and termination",
      "",
      "clause 14.2 Either party may terminate this agreement on ninety (90) days' written notice.",
      "Termination does not affect accrued rights, and clauses 9 (confidentiality), 14 (term) and",
      "17 (data protection) survive termination for three years.",
      "",
      "## 17 · Data protection",
      "",
      "The Supplier processes personal data only on documented instructions. Sub-processors require",
      "prior written authorisation. All processing is in the UK or the EEA; any transfer relies on the",
      "UK International Data Transfer Addendum to the EU standard contractual clauses.",
      "",
      "## 9 · Confidentiality",
      "",
      "Confidential information includes pricing, architecture and customer lists. It may be disclosed",
      "to advisers under equivalent obligations, and must be returned or destroyed on request.",
    ].join("\n"),
    sp: { itemId: "sp-fix-msa", path: "/sites/legal/fixtures/msa-northwind.md" },
  },
  {
    title: "Client money reconciliation procedure — Q3 2025",
    vertical: "finance",
    tags: ["procedure", "client-money", "fixture"],
    sensitivity: "restricted",
    text: [
      "# Client money reconciliation",
      "",
      "Reference FCA-2024-118. Owner: financial control. Reviewed quarterly.",
      "",
      "Client money is held in designated accounts and reconciled every business day. A three-way",
      "reconciliation compares the client bank statement, the client ledger and the aggregate client",
      "liability. Differences over £500 are escalated the same day and reported in the monthly pack.",
      "",
      "FCA-2024-118 requires the reconciliation to be signed off by a person independent of the",
      "preparer, and the sign-off record to be kept for six years.",
    ].join("\n"),
    sp: { itemId: "sp-fix-cmr", path: "/sites/finance/fixtures/client-money-reconciliation.md" },
  },
  {
    title: "Proposal — data residency assessment for Halden Retail",
    vertical: "consulting",
    tags: ["proposal", "residency", "fixture"],
    sensitivity: "confidential",
    text: [
      "# Proposal: data residency assessment",
      "",
      "Prepared for Halden Retail Group. Engagement code HR-2025-014.",
      "",
      "We will map every system that holds Halden customer personal data, record where it is stored and",
      "processed, identify transfers outside the UK, and produce a remediation plan with owners and dates.",
      "The assessment covers inference and embeddings separately, because a model hosted in-region with an",
      "embedding service outside it is still a transfer.",
      "",
      "Deliverables: data map, transfer risk assessments, remediation plan, and a board summary.",
      "Six weeks, two consultants, fixed fee.",
    ].join("\n"),
    sp: { itemId: "sp-fix-hrp", path: "/sites/consulting/fixtures/halden-residency-proposal.md" },
  },
  {
    title: "Retention schedule — records and disposition",
    vertical: "compliance",
    tags: ["retention", "schedule", "fixture"],
    sensitivity: "internal",
    text: [
      "# Retention schedule",
      "",
      "Contracts: life of the agreement plus seven years. Financial records: six years. Employee records:",
      "duration of employment plus six years. Client deliverables: seven years after engagement close.",
      "",
      "The schedule is enforced, not advisory: a record past its retention date is either destroyed or has",
      "a documented legal hold. Deletion must remove derived copies too — summaries, indexes and vector",
      "chunks — otherwise the record survives in a form nobody is looking at.",
    ].join("\n"),
    sp: { itemId: "sp-fix-ret", path: "/sites/compliance/fixtures/retention-schedule.md" },
  },
  {
    title: "On-call runbook — model host and inference gateway",
    vertical: "operations",
    tags: ["runbook", "on-call", "fixture"],
    sensitivity: "internal",
    text: [
      "# On-call runbook: model host",
      "",
      "Symptom: the workspace reports a gateway error. Check, in order: is the model host process alive;",
      "is it bound to loopback; is the model resident or cold (first request pays the load); does the app",
      "tier's OLLAMA_URL match; and is the firewall still blocking 11434 from outside.",
      "",
      "A cold model is not an outage. Load times are measured in seconds per gigabyte of weights, and the",
      "first request after idle pays it. Keep-alive is set to 30 minutes for that reason.",
    ].join("\n"),
    sp: { itemId: "sp-fix-run", path: "/sites/operations/fixtures/runbook-model-host.md" },
  },
  {
    title: "Offer pack template — senior associate, 2025 band",
    vertical: "people",
    tags: ["template", "offers", "fixture"],
    sensitivity: "restricted",
    text: [
      "# Offer pack — senior associate",
      "",
      "Salary band, bonus structure, pension contribution, holiday entitlement and the standard offer",
      "letter. Personal details are filled in at offer stage and are never stored in the knowledge index:",
      "an offer pack is a template, and a completed offer is an employee record with its own retention rule.",
    ].join("\n"),
    sp: { itemId: "sp-fix-offer", path: "/sites/people/fixtures/offer-pack-template.md" },
  },
];

export const FIXTURE_PAGES = [
  {
    title: "Knowledge index",
    vertical: "shared",
    tags: ["index", "fixture"],
    body: [
      "# Knowledge index",
      "",
      "This wiki is part of the KiNETiC-Ai data platform: one store shared by every app and every",
      "business vertical, with retrieval that cites where an answer came from.",
      "",
      "Start here:",
      "",
      "- [[shared/how-answering-works]] — retrieval, citations and what the system refuses to claim",
      "- [[legal/msa-northwind]] — worked example of a contract page with backlinks",
      "- [[compliance/retention-and-the-60-day-rule]] — the retention policy in force",
      "- [[operations/data-platform-runbook]] — operating the platform",
      "",
      "Pages are revised, never overwritten: every change keeps its revision, its author, its note and",
      "its hash, and any two of them can be compared.",
    ].join("\n"),
  },
  {
    title: "How answering works",
    vertical: "shared",
    slug: "shared/how-answering-works",
    tags: ["rag", "citations", "fixture"],
    body: [
      "# How answering works",
      "",
      "A question becomes a 768-dimensional vector, which is compared against every indexed chunk with an",
      "HNSW index, and fused with a keyword search so that exact identifiers still win. The top candidates",
      "are diversified so one long document cannot fill the whole context.",
      "",
      "Each answer carries citations. A citation states a page number only when the source supplied one.",
      "Restricted sources are marked. Cold sources are marked and can be brought back — see",
      "[[compliance/retention-and-the-60-day-rule]].",
      "",
      "What it does not do: it does not invent a source, it does not cite a document you cannot read, and",
      "it does not widen a SharePoint permission on the way in.",
    ].join("\n"),
  },
  {
    title: "MSA — Northwind Logistics",
    vertical: "legal",
    slug: "legal/msa-northwind",
    tags: ["contract", "fixture"],
    reviewDays: 180,
    body: [
      "# MSA — Northwind Logistics Ltd",
      "",
      "Effective 14 March 2025. Owner: commercial legal.",
      "",
      "**Termination.** clause 14.2 — ninety days' written notice by either party. Clauses 9, 14 and 17",
      "survive for three years.",
      "",
      "**Data protection.** UK/EEA processing only; transfers rely on the UK IDTA. Sub-processors need",
      "prior written authorisation.",
      "",
      "Source document: *Master services agreement — Northwind Logistics Ltd* in the legal vertical.",
      "Retention and cold-tier behaviour: [[compliance/retention-and-the-60-day-rule]].",
    ].join("\n"),
  },
  {
    title: "Retention and the 60-day rule",
    vertical: "compliance",
    slug: "compliance/retention-and-the-60-day-rule",
    tags: ["retention", "lifecycle", "fixture"],
    reviewDays: -3, // deliberately overdue, so the review queue is not empty in a demo
    body: [
      "# Retention and the 60-day rule",
      "",
      "The live store holds production-useful content only. Anything nobody has **opened** for 60 days is",
      "mirrored back to SharePoint, verified, and demoted: chunks and vectors are dropped, a 4.3 KB stub",
      "remains, and the content stays discoverable.",
      "",
      "Retrieval does not reset the clock — reading a citation is not use. Opening does.",
      "",
      "Under quota pressure the window adapts to 30 days at 90% of quota and 14 days at 97%, and the quota",
      "report says so. Demotion never happens before the mirror is verified, because the platform must not",
      "delete the only copy of anything.",
      "",
      "See also [[shared/how-answering-works]] and [[operations/data-platform-runbook]].",
    ].join("\n"),
  },
  {
    title: "Data platform runbook",
    vertical: "operations",
    slug: "operations/data-platform-runbook",
    tags: ["runbook", "operations", "fixture"],
    body: [
      "# Data platform runbook",
      "",
      "**Start it.** `node platform/server.mjs --port 8090 --host 127.0.0.1 --data-dir .data/platform`",
      "",
      "**Issue a key.** `node platform/server.mjs --create-key --app kinetic-wiki --data-dir .data/platform`",
      "— the secret is printed once and only its hash is stored.",
      "",
      "**Reach it.** The app origin proxies `/platform/*`; the platform itself binds loopback only and is",
      "never published. From outside, port 8090 must fail to connect.",
      "",
      "**Watch it.** `/healthz` reports live GB against the 20 GB ceiling, documents, chunks, tier counts,",
      "the embedding model and the SharePoint mode. `/v1/admin/quota` reports the window in force per",
      "vertical.",
      "",
      "**Sweep.** `POST /v1/admin/lifecycle/sweep` with `{\"dryRun\":true}` first, then without it.",
      "",
      "Policy detail: [[compliance/retention-and-the-60-day-rule]].",
    ].join("\n"),
  },
];

/* Seed through the real paths, then report exactly what happened — including
   anything admission refused, because a fixture that silently failed to seed
   would make the demo lie about what the platform holds. */
export async function seedFixtures(platform, { at = now, coldAfterDays = 61 } = {}) {
  const { store, embedder, sharePoint } = platform;
  const out = { notice: FIXTURE_NOTICE, documents: [], pages: [], rejected: [], cold: 0, swept: null };

  /* Fixtures are seeded the way production content arrives: the item exists in
     SharePoint first, then it is ingested from there. That matters because
     demotion refuses to run unless verifyMirror() can prove the mirror holds
     this exact content — a fixture that skipped the source would never reach the
     cold tier, and the archived-match path in the UI would stay unreachable. */
  const siteId = sharePoint.sites?.[0]?.id || "site-legal";
  if (typeof sharePoint.seed === "function") {
    sharePoint.seed(
      FIXTURE_DOCS.map((d) => ({
        id: d.sp.itemId,
        siteId,
        path: d.sp.path,
        name: d.sp.path.split("/").pop(),
        text: d.text,
        contentType: "document",
        modifiedAt: new Date(at - 10 * DAY).toISOString(),
        sensitivity: d.sensitivity,
      }))
    );
  }

  for (const d of FIXTURE_DOCS) {
    const item = (await sharePoint.getItem?.(d.sp.itemId)) || null;
    const res = await ingest(store, embedder, {
      title: d.title,
      text: d.text,
      vertical: d.vertical,
      tags: d.tags,
      sensitivity: d.sensitivity,
      format: "markdown",
      sourceKind: "fixture",
      sourceModified: at - 10 * DAY,
      appId: "fixtures",
      actor: "fixtures",
      sharePoint: item
        ? { itemId: item.id, siteId: item.siteId, path: item.path, webUrl: item.webUrl, versionId: item.versionId, permissionMode: "mapped" }
        : null,
    });
    if (res.accepted) out.documents.push({ id: res.doc?.id ?? null, title: d.title, vertical: d.vertical, chunks: res.chunks?.length ?? 0 });
    else out.rejected.push({ title: d.title, reasons: res.reasons });
  }

  for (const p of FIXTURE_PAGES) {
    const reviewBy = p.reviewDays == null ? null : new Date(at + p.reviewDays * DAY).toISOString();
    const res = await createPage(store, embedder, {
      title: p.title,
      body: p.body,
      vertical: p.vertical,
      slug: p.slug || null,
      tags: p.tags,
      author: "fixtures",
      reviewBy,
      // No acl here on purpose: createPage's default (`groups: ["vertical:<id>"]`,
      // denyPublic false) is the production shape, and a hand-rolled one would
      // either widen access or make the page private to everybody.
    });
    if (res.ok) out.pages.push({ slug: res.page.slug, title: res.page.title, vertical: res.page.vertical, revision: res.page.revision, reviewBy });
    else out.rejected.push({ title: p.title, reasons: [res.error] });
  }

  /* Put one document in the cold tier the way production does: age its
     last-opened timestamp past the window and let the sweep mirror, verify
     and demote it. That makes the archived-match path in the UI reachable. */
  const victim = store.listDocuments().find((d) => d.title.includes("Northwind"));
  if (victim) {
    // The store has no "pretend this was opened 61 days ago" method and should
    // not: ageing is a test/demo concern, so it is set on the record directly and
    // the real sweep does the mirroring, verification and demotion.
    victim.lastOpenedAt = new Date(at - coldAfterDays * DAY).toISOString(); // ISO, like every other timestamp in the store
    store.putDocument(victim);
    out.swept = await sweep(store, sharePoint, { at, actor: "fixtures" });
    out.cold = store.listDocuments().filter((d) => d.tier === "cold").length;
    out.coldTitle = store.listDocuments().find((d) => d.tier === "cold")?.title || null;
  }

  store.audit({ action: "fixtures.seeded", actor: "fixtures", documents: out.documents.length, pages: out.pages.length, cold: out.cold, rejected: out.rejected.length });
  return out;
}

export default { FIXTURE_NOTICE, FIXTURE_DOCS, FIXTURE_PAGES, seedFixtures };

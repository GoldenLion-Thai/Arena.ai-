/* ============================================================================
   platform/lifecycle.mjs — the retention clock, and the path back.

   The rule from the brief: anything not opened for 60 days defaults back to
   SharePoint. If it is needed again, the path is reopened.

   Three details make that safe rather than merely tidy:

     1. Retrieval does not count as opening. Only a real open (a human reading
        the document, or a citation being followed) resets the clock. Otherwise
        background RAG traffic would keep every document hot forever and the
        ceiling would be fiction.
     2. Nothing is demoted until the mirror is verified — hash and version
        compared against SharePoint. An unverified mirror means the platform
        holds the only copy, and the sweep skips it and says so.
     3. Demotion keeps a discoverable stub: title, summary, one summary vector,
        permissions and the SharePoint pointer. Archived content can still be
        *found*; it just cannot be cited until it is rehydrated.

   Under quota pressure the window tightens (60 → 30 → 14 days) instead of the
   ceiling breaking. The ceiling is a policy, and policies need enforcement.
   ========================================================================== */

import { TIERS, STORAGE, HNSW, capacityPlan, bytesPerChunk, coldWindowDays, vertical, GB } from "./config.mjs";
import { chunkText, parse, estimateTokens } from "./ingest.mjs";

/** Free a document from the live tier. Caller must have verified the mirror. */
export function demote(store, doc, verification, { actor = "lifecycle", reason = null, at = Date.now() } = {}) {
  const per = bytesPerChunk();
  const chunks = store.chunksFor(doc.id);
  const bytesFreed = chunks.length * per.total;
  const days = Math.round(store.daysSinceOpened(doc, at));
  const window = coldWindowDays((store.liveBytes().byVertical[doc.vertical]?.gb ?? 0) - bytesFreed / GB, vertical(doc.vertical));

  store.dropChunks(doc.id);
  const from = doc.tier;
  doc.tier = "cold";
  doc.mirrorState = verification?.ok ? "verified" : doc.mirrorState;
  doc.mirrorVerifiedAt = verification?.verifiedAt || null;
  doc.mirrorEtag = verification?.etag || doc.mirrorEtag || null;
  doc.mirrorVersionId = verification?.versionId || doc.mirrorVersionId || null;
  doc.archivedAt = new Date(at).toISOString();
  doc.archiveReason = reason || `not opened for ${days} days (window ${window}d) — reverted to SharePoint`;
  doc.daysUnopenedAtArchive = days;
  // keep the summary vector: one vector per archived document, ~3 KB, which is
  // what makes it findable again without paying for its 150 chunks
  store.putDocument(doc);

  store.putLifecycle({ docId: doc.id, vertical: doc.vertical, from, to: "cold", reason: doc.archiveReason, bytesFreed, chunksDropped: chunks.length, verified: !!verification?.ok, etag: verification?.etag || null, actor });
  store.audit({ action: "lifecycle.demoted", docId: doc.id, vertical: doc.vertical, title: doc.title, actor, days, window, bytesFreed, mirror: verification?.ok ? "verified" : "assumed", sharePoint: doc.sharePoint?.webUrl || null });
  return { docId: doc.id, bytesFreed, chunksDropped: chunks.length, from, days, window };
}

/** Reopen the path: pull the content back from SharePoint and re-index it. */
export async function rehydrate(store, sp, embedder, docId, { actor = "api", appId = null, force = false } = {}) {
  const t0 = Date.now();
  const doc = store.getDocument(docId);
  if (!doc) return { ok: false, error: "no such document" };
  if (doc.tier !== "cold" && !force) return { ok: false, error: `document is already ${doc.tier}`, docId };
  const itemId = doc.sharePoint?.itemId;
  if (!itemId) return { ok: false, error: "no SharePoint item id — the path back does not exist for platform-only content" };

  const remote = await sp.download(itemId);
  if (!remote) return { ok: false, error: "source item is gone from SharePoint — cannot reopen; restore it there first" };

  const drifted = doc.contentHash && doc.contentHash !== remote.hash;
  const text = parse(remote.text, "text");
  const chunks = chunkText(text);
  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

  doc.tier = "hot";
  doc.chunkCount = chunks.length;
  doc.tokens = estimateTokens(text);
  doc.contentHash = remote.hash;
  doc.mirrorState = "verified";
  doc.mirrorEtag = remote.etag;
  doc.mirrorVersionId = remote.versionId;
  doc.archivedAt = null;
  doc.archiveReason = null;
  doc.lastOpenedAt = new Date().toISOString();
  doc.lastOpenedBy = actor;
  doc.openCount = (doc.openCount || 0) + 1;
  store.putDocument(doc);

  store.dropChunks(doc.id);
  store.putChunks(chunks.map((c, i) => ({ docId: doc.id, vertical: doc.vertical, ordinal: c.ordinal, heading: c.heading, text: c.text, tokens: c.tokens, charStart: c.charStart, charEnd: c.charEnd, tier: "hot", embedding: embeddings[i] })));

  const ms = Date.now() - t0;
  store.putLifecycle({ docId: doc.id, vertical: doc.vertical, from: "cold", to: "hot", reason: "rehydrated on demand", bytesAdded: chunks.length * bytesPerChunk().total, actor, ms, drifted });
  store.audit({ action: "lifecycle.rehydrated", docId: doc.id, vertical: doc.vertical, title: doc.title, actor, appId, ms, chunks: chunks.length, drifted, source: doc.sharePoint?.webUrl });
  return { ok: true, docId: doc.id, chunks: chunks.length, ms, drifted, archivedForDays: doc.daysUnopenedAtArchive ?? null };
}

/** Nightly sweep: apply the retention window to every live document. */
export async function sweep(store, sp, { at = Date.now(), dryRun = false, actor = "lifecycle", limit = null } = {}) {
  const report = { at: new Date(at).toISOString(), dryRun, scanned: 0, cold: 0, demoted: [], planned: [], skipped: [], promoted: [], bytesFreed: 0, verified: 0, unverified: 0 };
  const per = bytesPerChunk();

  for (const doc of store.listDocuments({})) {
    report.scanned++;
    if (doc.tier === "cold") {
      report.cold++;
      continue;
    }
    const days = store.daysSinceOpened(doc, at);
    const usedGB = store.liveBytes().byVertical[doc.vertical]?.gb ?? 0;
    const window = coldWindowDays(usedGB, vertical(doc.vertical));

    if (days > window) {
      const verification = await sp.verifyMirror(doc);
      if (!verification.ok) {
        report.unverified++;
        report.skipped.push({ docId: doc.id, title: doc.title, vertical: doc.vertical, days: Math.round(days), window, reason: verification.reason });
        store.audit({ action: "lifecycle.demotion_blocked", docId: doc.id, vertical: doc.vertical, actor, reason: verification.reason, days: Math.round(days) });
        continue;
      }
      report.verified++;
      if (dryRun) {
        report.planned.push({ docId: doc.id, title: doc.title, vertical: doc.vertical, days: Math.round(days), window, chunks: store.chunksFor(doc.id).length, bytesFreed: store.chunksFor(doc.id).length * per.total });
        continue;
      }
      const r = demote(store, doc, verification, { actor, at });
      report.demoted.push(r);
      report.bytesFreed += r.bytesFreed;
    } else if (doc.tier === "warm" && days <= TIERS.hot.maxAgeDaysOpened) {
      doc.tier = "hot";
      store.putDocument(doc);
      report.promoted.push({ docId: doc.id, days: Math.round(days) });
    } else if (doc.tier === "hot" && days > TIERS.hot.maxAgeDaysOpened) {
      doc.tier = "warm";
      store.putDocument(doc);
    }
    if (limit && report.demoted.length >= limit) break;
  }

  store.audit({ action: "lifecycle.sweep", actor, dryRun, scanned: report.scanned, demoted: report.demoted.length, planned: report.planned.length, skipped: report.skipped.length, bytesFreed: report.bytesFreed, unverified: report.unverified });
  report.bytesFreedGB = +(report.bytesFreed / GB).toFixed(4);
  return report;
}

/** Safety valve: if the ceiling is breached, demote least-recently-opened
 *  documents (verified mirrors first) until the platform is back under it. */
export async function enforceCeiling(store, sp, { actor = "lifecycle", ceilingGB = STORAGE.liveCeilingGB } = {}) {
  const actions = [];
  let guard = 0;
  while (store.liveBytes().totalGB > ceilingGB && guard++ < 500) {
    const candidates = store
      .listDocuments({})
      .filter((d) => d.tier !== "cold")
      .sort((a, b) => Date.parse(a.lastOpenedAt) - Date.parse(b.lastOpenedAt));
    let acted = false;
    for (const doc of candidates) {
      const v = await sp.verifyMirror(doc);
      if (!v.ok) continue; // never break the "one copy" rule to hit a number
      actions.push(demote(store, doc, v, { actor, reason: `live ceiling ${ceilingGB} GB breached` }));
      acted = true;
      break;
    }
    if (!acted) break; // everything left is unverified — report instead of destroying
  }
  if (actions.length) store.audit({ action: "lifecycle.ceiling_enforced", actor, demoted: actions.length, ceilingGB });
  return { demoted: actions.length, actions, stillOver: store.liveBytes().totalGB > ceilingGB, liveGB: store.liveBytes().totalGB };
}

/** What each vertical is using, against its quota, with the window in force. */
export function quotaReport(store) {
  const live = store.liveBytes();
  const rows = [];
  for (const v of Object.keys(live.byVertical)) {
    const meta = vertical(v);
    const used = live.byVertical[v];
    const docs = store.listDocuments({ vertical: v });
    rows.push({
      vertical: v,
      label: meta?.label ?? v,
      quotaGB: used.quotaGB,
      usedGB: +used.gb.toFixed(4),
      pct: used.pct,
      documents: docs.filter((d) => d.tier !== "cold").length,
      coldStubs: docs.filter((d) => d.tier === "cold").length,
      chunks: store.scanChunks({ verticals: [v] }).length,
      windowDays: coldWindowDays(used.gb, meta),
      defaultWindowDays: TIERS.coldAfterDaysUnopened,
      pressure: used.pct >= TIERS.adaptive.criticalAtQuotaPct * 100 ? "critical" : used.pct >= TIERS.adaptive.tightenAtQuotaPct * 100 ? "tight" : "ok",
      sensitivity: meta?.sensitivity ?? null,
      retentionDays: meta?.retentionDays ?? null,
    });
  }
  return {
    rows,
    total: { liveGB: +live.totalGB.toFixed(4), ceilingGB: live.ceilingGB, pct: +live.pctOfCeiling.toFixed(3), chunks: live.chunks, coldStubs: live.coldStubs },
    headroomGB: +(live.ceilingGB - live.totalGB).toFixed(4),
    ceilingHeld: live.totalGB <= live.ceilingGB,
  };
}

/** Storage/RAM/IOPS headroom, planned vs actual, in one object. */
export function capacityReport(store, opts = {}) {
  const plan = capacityPlan(opts);
  const live = store.liveBytes();
  return {
    plan,
    actual: { liveGB: +live.totalGB.toFixed(4), liveBytes: live.total, chunks: live.chunks, coldStubs: live.coldStubs, byTier: live.byTier },
    headroom: {
      storage: { provisionedGB: plan.provisionedGB, liveGB: +live.totalGB.toFixed(4), ceilingGB: plan.liveGB, ratioVsCeiling: +(plan.nodeVolumeGB / plan.liveGB).toFixed(2), ratioVsActual: live.totalGB ? +(plan.provisionedGB / live.totalGB).toFixed(2) : null, policy: `${STORAGE.headroomTarget}x minimum`, ok: plan.nodeVolumeGB / plan.liveGB >= STORAGE.headroomTarget },
      chunkBudget: { budget: plan.chunkBudget, used: live.chunks, pct: +((live.chunks / plan.chunkBudget) * 100).toFixed(3), ok: live.chunks <= plan.chunkBudget },
      ram: { recommendedGB: plan.ramRecommendedGB, workingSetGB: plan.ramWantGB, policy: "2x the HNSW index + hot heap" },
      connections: plan.connections,
      volume: plan.volume,
    },
    policy: {
      liveCeilingGB: STORAGE.liveCeilingGB,
      nodeVolumeGB: STORAGE.nodeVolumeGB,
      coldAfterDaysUnopened: TIERS.coldAfterDaysUnopened,
      adaptiveWindows: TIERS.adaptive,
      coldStore: STORAGE.coldStore,
      verifyBeforeDelete: true,
    },
  };
}

/** The human-readable version of the above, for an admin screen or a report. */
export function capacityTable(report) {
  const p = report.plan;
  const a = report.actual;
  const rows = [
    ["live ceiling (all verticals)", `${p.liveGB} GB`, `${a.liveGB} GB`, `${((a.liveGB / p.liveGB) * 100).toFixed(3)}% of ceiling`],
    ["volume per node", `${p.nodeVolumeGB} GB × ${p.nodes} nodes`, `${p.provisionedGB} GB`, `${p.headroomRatio}x headroom (policy: ≥${STORAGE.headroomTarget}x)`],
    ["chunks", p.chunkBudget.toLocaleString(), a.chunks.toLocaleString(), `${((a.chunks / p.chunkBudget) * 100).toFixed(2)}% of budget`],
    ["equivalent documents", `${p.documentsLong.toLocaleString()} long / ${p.documentsShort.toLocaleString()} short`, `${a.coldStubs.toLocaleString()} archived stubs`, `${p.bytesPerChunk.total.toLocaleString()} B per chunk`],
    ["HNSW index", `${p.indexGB} GB`, `m=${HNSW.m}, ef_construction=${HNSW.efConstruction}, ef_search=${HNSW.efSearch}`, `RAM ${p.ramRecommendedGB} GB recommended (2x working set)`],
    ["heap (text + FTS + metadata)", `${p.heapGB} GB`, "TOAST-compressed", "shared_buffers 25% of RAM"],
    ["block volume I/O", `${p.volume.iops.toLocaleString()} IOPS`, `${p.volume.mbps} MB/s`, `${p.volume.level} (${p.volume.vpu} VPU/GB)`],
    ["connections", `${p.connections.maxConnections} max`, `${p.connections.want} wanted`, `${p.connections.headroom}x headroom + PgBouncer`],
    ["cold tier", "SharePoint", "no platform GB", "1 summary vector per archived document"],
  ];
  return rows;
}

export default { demote, rehydrate, sweep, enforceCeiling, quotaReport, capacityReport, capacityTable };

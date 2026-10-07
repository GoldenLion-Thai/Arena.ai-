/* ============================================================================
   platform/config.mjs — KiNETiC-Ai unified data platform: the policy file.

   Every number the design document quotes is computed here, so the docs, the
   API and the tests cannot drift apart. Change a quota or a tier threshold in
   one place and the capacity report, the admission policy and the lifecycle
   job all follow.

   Brand: KiNETiC-Ai is the platform that all business verticals share.
   GRiD-OS-SOVEREIGN is one app that consumes it (see assets/js/brand.js).
   ========================================================================== */

export const PLATFORM = {
  name: "KiNETiC-Ai",
  slug: "kinetic-ai",
  tagline: "One knowledge substrate, shared by every app and every vertical.",
  apiVersion: "v1",
};

/* --------------------------------------------------------------------------
   Storage policy — the brief: 20 GB of live data overall, 50 GB provisioned
   per VPS node, and double headroom everywhere.

   "Live" means opened within the retention window. The ceiling is enforced by
   the lifecycle policy, not by hope: when a vertical approaches its quota the
   cold threshold tightens automatically (see TIERS.adaptive).
   -------------------------------------------------------------------------- */
export const STORAGE = {
  liveCeilingGB: 20, // enforced across all verticals, hot + warm
  nodeVolumeGB: 50, // provisioned per VPS node (OCI block volume)
  headroomTarget: 2.0, // "double headroom": provisioned >= 2x live ceiling
  coldStore: "sharepoint", // demoted content lives in M365, not in the platform
  objectCacheGB: 10, // optional local cache of originals (SharePoint is the record)
  backup: { mode: "pg_dump + volume snapshot", rpo: "15m (SharePoint delta sync)", rto: "1h" },
};

/* OCI block volume elastic performance (VPU/GB):
     IOPS/GB = 1.5 × VPU + 45     KBPS/GB = 12 × VPU + 360
   A 50 GB volume is throughput-limited, which is exactly why the live ceiling
   is small enough to sit in RAM. */
export const VOLUME_PERFORMANCE = {
  0: { label: "Lower Cost", vpu: 0 },
  10: { label: "Balanced", vpu: 10 },
  20: { label: "Higher Performance", vpu: 20 },
  30: { label: "Ultra High Performance", vpu: 30 },
};

export function volumePerformance(vpu = 10, sizeGB = STORAGE.nodeVolumeGB) {
  const iopsPerGB = 1.5 * vpu + 45;
  const kbpsPerGB = 12 * vpu + 360;
  const maxIopsVolume = 2500 * vpu;
  const maxMbpsVolume = 20 * vpu + 280;
  return {
    vpu,
    level: VOLUME_PERFORMANCE[vpu]?.label ?? `${vpu} VPU`,
    sizeGB,
    iops: Math.min(Math.round(iopsPerGB * sizeGB), maxIopsVolume),
    mbps: Math.min(Math.round((kbpsPerGB * sizeGB) / 1024), maxMbpsVolume),
  };
}

/* --------------------------------------------------------------------------
   Chunking and embeddings. Embeddings are produced locally (Ollama) — sending
   document text to a third-party embedding API would defeat the product.
   -------------------------------------------------------------------------- */
export const CHUNKING = {
  targetTokens: 400,
  maxTokens: 600,
  overlapTokens: 60,
  minTokens: 40,
  charsPerToken: 4,
  boundaries: ["\n\n", "\n", ". ", "; ", ", ", " "], // prefer paragraph > sentence > word
};

export const EMBEDDING = {
  model: "nomic-embed-text", // 768d, Apache-2.0, runs on CPU
  dims: 768,
  alternatives: [
    { model: "bge-m3", dims: 1024, note: "multilingual, dense+sparse in one pass" },
    { model: "mxbai-embed-large", dims: 1024, note: "strong English retrieval" },
    { model: "snowflake-arctic-embed", dims: 768, note: "small, fast, good for CPU" },
  ],
  halfvec: false, // true halves storage at a small recall cost (pgvector halfvec)
  bytesPerDim: 4, // float32; halfvec would be 2
};

export const HNSW = { m: 16, efConstruction: 128, efSearch: 100 };

/* --------------------------------------------------------------------------
   Capacity arithmetic. These are the numbers the design document quotes.

   Per chunk (768d, float32, HNSW m=16):
     embedding column   dims × 4            =  3,072 B
     HNSW index         dims×4 + m×3×4      =  3,264 B  → ×1.3 page overhead ≈ 4,243 B
     chunk text         ~400 tokens × 4 ch  =  1,600 B  → TOAST-compressed ≈ 1,100 B
     tsvector + GIN                         ≈    800 B
     row + metadata jsonb                   ≈  1,000 B
                                            ----------
                                             ≈ 10.2 KB  → planning figure 11 KB
   -------------------------------------------------------------------------- */
export function bytesPerChunk(dims = EMBEDDING.dims, m = HNSW.m, halfvec = EMBEDDING.halfvec) {
  const bpd = halfvec ? 2 : 4;
  const column = dims * bpd + 8;
  const index = Math.round((dims * bpd + m * 3 * bpd) * 1.3); // page overhead
  const text = Math.round((CHUNKING.targetTokens * CHUNKING.charsPerToken) / 1.45); // TOAST
  const fts = 800;
  const rowMeta = 1000;
  return { column, index, text, fts, rowMeta, total: column + index + text + fts + rowMeta };
}

export const GB = 1024 ** 3;

export function capacityPlan(opts = {}) {
  const liveGB = opts.liveGB ?? STORAGE.liveCeilingGB;
  const nodeGB = opts.nodeVolumeGB ?? STORAGE.nodeVolumeGB;
  const dims = opts.dims ?? EMBEDDING.dims;
  const perChunk = bytesPerChunk(dims);
  // reserve room for wiki, audit, cold stubs and growth inside the ceiling
  const retrievalBudget = liveGB * 0.85;
  const chunks = Math.floor((retrievalBudget * GB) / perChunk.total);
  const indexBytes = chunks * perChunk.index;
  const heapBytes = chunks * (perChunk.column + perChunk.text + perChunk.fts + perChunk.rowMeta);
  const ramWant = indexBytes + heapBytes * 0.35; // index cached, hot heap cached
  const nodes = opts.nodes ?? 2; // primary + read replica
  return {
    liveGB,
    nodeVolumeGB: nodeGB,
    nodes,
    provisionedGB: nodeGB * nodes,
    headroomRatio: +(nodeGB / liveGB).toFixed(2),
    headroomOk: nodeGB / liveGB >= STORAGE.headroomTarget,
    bytesPerChunk: perChunk,
    chunkBudget: chunks,
    tokens: chunks * CHUNKING.targetTokens,
    documentsLong: Math.round(chunks / 150), // ~150-page contract
    documentsShort: Math.round(chunks / 10), // ~10-page memo
    indexGB: +(indexBytes / GB).toFixed(2),
    heapGB: +(heapBytes / GB).toFixed(2),
    ramRecommendedGB: Math.max(16, Math.ceil((ramWant * 2) / GB)), // double headroom on RAM too
    ramWantGB: +(ramWant / GB).toFixed(2),
    maintenanceWorkMemGB: Math.max(2, Math.ceil((chunks * dims * 4 * 2) / GB / 4)), // build in 4 passes
    connections: { apps: 6, poolPerApp: 8, want: 48, maxConnections: 100, headroom: +(100 / 48).toFixed(2) },
    volume: volumePerformance(opts.vpu ?? 10, nodeGB),
  };
}

/* --------------------------------------------------------------------------
   Business verticals. Every document, chunk, wiki page and API key belongs to
   exactly one vertical plus the shared namespace. Quotas sum to the ceiling.
   -------------------------------------------------------------------------- */
export const VERTICALS = [
  { id: "legal", label: "Legal", quotaGB: 5.0, sensitivity: "high", retentionDays: 2555, sharePointSite: "legal-knowledge", note: "contracts, precedent, engagement terms" },
  { id: "finance", label: "Finance", quotaGB: 4.0, sensitivity: "high", retentionDays: 2555, sharePointSite: "finance-knowledge", note: "models, reporting packs, policies" },
  { id: "consulting", label: "Consulting", quotaGB: 4.0, sensitivity: "high", retentionDays: 1825, sharePointSite: "client-knowledge", note: "client deliverables, research" },
  { id: "compliance", label: "Compliance", quotaGB: 3.0, sensitivity: "critical", retentionDays: 3650, sharePointSite: "compliance-knowledge", note: "registers, audit evidence, policies" },
  { id: "operations", label: "Operations", quotaGB: 2.0, sensitivity: "medium", retentionDays: 1095, sharePointSite: "operations-knowledge", note: "runbooks, SOPs, vendor docs" },
  { id: "people", label: "People / HR", quotaGB: 1.5, sensitivity: "critical", retentionDays: 2190, sharePointSite: "people-knowledge", note: "handbook, policies — never personal files" },
  { id: "shared", label: "Shared / Wiki", quotaGB: 0.5, sensitivity: "medium", retentionDays: 1825, sharePointSite: "company-knowledge", note: "cross-vertical wiki and glossary" },
];

export const verticalIds = VERTICALS.map((v) => v.id);
export function vertical(id) {
  return VERTICALS.find((v) => v.id === id) || null;
}

/* --------------------------------------------------------------------------
   Tiering. The 60-day rule: anything not opened for 60 days leaves the live
   tier and defaults back to SharePoint, keeping a discoverable stub. If it is
   needed again the path is reopened by rehydrating from the mirror.
   -------------------------------------------------------------------------- */
export const TIERS = {
  hot: {
    id: "hot",
    label: "Hot",
    description: "chunks + embeddings resident; answers cite these directly",
    maxAgeDaysOpened: 14,
    shareOfBudget: 0.6,
  },
  warm: {
    id: "warm",
    label: "Warm",
    description: "chunks resident, embeddings quantised (halfvec) or unprioritised",
    maxAgeDaysOpened: 60,
    shareOfBudget: 0.25,
  },
  cold: {
    id: "cold",
    label: "Cold (SharePoint)",
    description: "stub + summary vector only; content lives in SharePoint",
    maxAgeDaysOpened: Infinity,
    shareOfBudget: 0.15,
  },
  // the default in the brief
  coldAfterDaysUnopened: 60,
  // under quota pressure the window tightens rather than the ceiling breaking
  adaptive: { tightenAtQuotaPct: 0.9, tightenedDays: 30, criticalAtQuotaPct: 0.97, criticalDays: 14 },
  rehydrate: { maxConcurrent: 3, timeoutMs: 120_000, announceInAnswer: true },
};

/* Effective cold window for a vertical, given how full its quota is. */
export function coldWindowDays(usedGB, v) {
  const quota = v?.quotaGB ?? STORAGE.liveCeilingGB;
  const pct = quota ? usedGB / quota : 0;
  if (pct >= TIERS.adaptive.criticalAtQuotaPct) return TIERS.adaptive.criticalDays;
  if (pct >= TIERS.adaptive.tightenAtQuotaPct) return TIERS.adaptive.tightenedDays;
  return TIERS.coldAfterDaysUnopened;
}

/* --------------------------------------------------------------------------
   Admission policy — "only live production useful data".
   -------------------------------------------------------------------------- */
export const ADMISSION = {
  contentTypes: ["document", "wiki", "runbook", "policy", "contract", "report", "email-thread"],
  exclude: {
    personalSites: true, // OneDrive personal, "Documents" libraries of individuals
    drafts: true, // content type / label says draft
    training: true, // L&D material, sandbox corpora
    templates: true, // unless explicitly promoted to precedent
    olderThanDays: 2555, // 7 years; compliance can override per vertical
    duplicateContentHash: true,
    minTextTokens: 40,
    // A wiki definition can be a dozen tokens and still be exactly what an
    // answer needs. The floor is about documents, not prose.
    minTextTokensWiki: 8,
    languages: null, // null = any; set ["en","cy"] to restrict
  },
  requireSharePointId: true, // every document must be traceable to a source item
  pii: { action: "flag-for-review", blockUntilReviewed: false },
};

/* --------------------------------------------------------------------------
   API access — one platform, many apps. Keys are scoped, not global.
   -------------------------------------------------------------------------- */
export const SCOPES = ["search", "read", "ingest", "wiki", "admin"];

export const APPS = [
  { id: "grid-os-sovereign", label: "GRiD-OS-SOVEREIGN workspace", scopes: ["search", "read", "wiki"], verticals: ["*"], ratePerMin: 240 },
  { id: "kinetic-wiki", label: "KiNETiC-Ai Wiki", scopes: ["search", "read", "wiki", "ingest"], verticals: ["*"], ratePerMin: 240 },
  { id: "behaviour-lab", label: "Behaviour Lab", scopes: ["search", "read"], verticals: ["shared"], ratePerMin: 60 },
  { id: "intake-automation", label: "Intake automation", scopes: ["ingest", "read"], verticals: ["legal", "consulting"], ratePerMin: 120 },
  { id: "compliance-monitor", label: "Compliance monitor", scopes: ["search", "read"], verticals: ["compliance", "legal"], ratePerMin: 60 },
];

export const RATE_LIMIT = { windowMs: 60_000, defaultPerMin: 120, burst: 20 };
export const QUOTA = { rejectOnExceed: true, warnAtPct: 0.8 };

/* --------------------------------------------------------------------------
   SharePoint mirror — the system of record for documents, and the cold tier.
   Graph endpoints the connector maps onto (see platform/sharepoint.mjs).
   -------------------------------------------------------------------------- */
export const SHAREPOINT = {
  graphBase: "https://graph.microsoft.com/v1.0",
  deltaIntervalMs: 15 * 60 * 1000, // 15 minutes
  direction: { inbound: "SharePoint → platform (documents)", outbound: "platform → SharePoint (wiki pages, summaries, annotations)" },
  sitePattern: "{root}/sites/{site}",
  libraries: { source: "Knowledge", mirror: "KiNETiC-Ai Mirror" },
  permissions: { mode: "inherit-from-item", wideningAllowed: false, defaultAction: "deny" },
  verifyBeforeDelete: true, // never demote a document whose mirror is unverified
  metadata: { contentTypes: true, labels: true, sensitivityLabels: true },
};

export const OBSERVABILITY = {
  auditEveryWrite: true,
  metrics: ["ttft_ms", "retrieval_ms", "recall_at_k", "chunks_live", "gb_live", "cold_demotions", "rehydrations", "quota_pct"],
  targets: { retrievalP95Ms: 350, ttftP95Ms: 400, recallAt10: 0.9 },
};

export default { PLATFORM, STORAGE, CHUNKING, EMBEDDING, HNSW, TIERS, VERTICALS, ADMISSION, APPS, SCOPES, RATE_LIMIT, QUOTA, SHAREPOINT, OBSERVABILITY, capacityPlan, bytesPerChunk, volumePerformance, coldWindowDays, vertical, verticalIds, GB };

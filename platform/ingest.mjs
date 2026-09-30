/* ============================================================================
   platform/ingest.mjs — parse → admit → chunk → embed → index.

   The admission gate exists because the brief is "only live production useful
   data". A vector store that accepts everything becomes a liability: stale
   drafts get cited, duplicates double the storage bill, and personal files
   turn a knowledge base into a data-protection incident.

   Citations are honest about what they know: page numbers are only present
   when the source supplied them. An estimated page is worse than no page.
   ========================================================================== */

import { ADMISSION, CHUNKING, TIERS, STORAGE, vertical, GB } from "./config.mjs";
import { sha256, shortId } from "./store.mjs";
import { tokenize } from "./embeddings.mjs";

export const estimateTokens = (text) => Math.ceil(String(text || "").length / CHUNKING.charsPerToken);

/** Normalise whatever arrived into plain text. Real parsers (pdf/docx/xlsx)
 *  plug in here; the reference build handles text, markdown and HTML. */
export function parse(input, kind = "text") {
  let text = String(input ?? "");
  if (kind === "html") {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
  }
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Boundary-aware chunking: paragraphs beat sentences beat words, with overlap
 *  so a fact spanning a boundary is still retrievable from one chunk. */
export function chunkText(text, opts = {}) {
  const target = (opts.targetTokens ?? CHUNKING.targetTokens) * CHUNKING.charsPerToken;
  const max = (opts.maxTokens ?? CHUNKING.maxTokens) * CHUNKING.charsPerToken;
  const overlap = (opts.overlapTokens ?? CHUNKING.overlapTokens) * CHUNKING.charsPerToken;
  const min = (opts.minTokens ?? CHUNKING.minTokens) * CHUNKING.charsPerToken;

  const chunks = [];
  let cursor = 0;
  let heading = null;

  const headingAt = (from) => {
    const m = /^#{1,6}\s+(.+)$/m.exec(text.slice(from, from + 400));
    return m ? m[1].trim().slice(0, 120) : null;
  };

  while (cursor < text.length) {
    let end = Math.min(cursor + target, text.length);
    if (end < text.length) {
      // walk back to the best boundary inside the window
      const window = text.slice(cursor, Math.min(cursor + max, text.length));
      let cut = -1;
      for (const b of CHUNKING.boundaries) {
        const at = window.lastIndexOf(b, target - cursor + (b.length * 4));
        if (at > target * 0.35) {
          cut = cursor + at + b.length;
          break;
        }
      }
      if (cut > cursor) end = Math.min(cut, cursor + max);
    }
    const slice = text.slice(cursor, end).trim();
    if (slice.length >= min || chunks.length === 0) {
      chunks.push({
        ordinal: chunks.length,
        text: slice,
        heading: heading || headingAt(cursor),
        tokens: estimateTokens(slice),
        charStart: cursor,
        charEnd: end,
        pageStart: null, // only set when the source supplies a page map
        pageEnd: null,
      });
      heading = null;
    }
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

/** The gate. Returns {accept, reasons[], warnings[]}. */
export function admission(decisionInput, store) {
  const { title = "", text = "", vertical: vId = "shared", contentType = "document", tags = [], sharePoint = null, sourceKind = "upload", modifiedAt = null, language = null, piiFlagged = false } = decisionInput;
  const reasons = [];
  const warnings = [];
  const v = vertical(vId);
  const tokens = estimateTokens(text);

  if (!v) reasons.push(`unknown vertical "${vId}"`);
  if (!ADMISSION.contentTypes.includes(contentType)) reasons.push(`content type "${contentType}" is not production knowledge`);
  const floor = contentType === "wiki" ? ADMISSION.exclude.minTextTokensWiki : ADMISSION.exclude.minTextTokens;
  if (tokens < floor) reasons.push(`only ${tokens} tokens — below the ${floor} token floor for ${contentType} content (not useful data)`);

  const lower = `${title} ${tags.join(" ")}`.toLowerCase();
  if (ADMISSION.exclude.drafts && /\bdraft\b|wip\b/.test(lower)) reasons.push("marked draft — drafts are not citable knowledge");
  if (ADMISSION.exclude.templates && /\btemplate\b/.test(lower) && !tags.includes("precedent")) warnings.push("looks like a template; promote it with the `precedent` tag if it is really precedent");
  if (ADMISSION.exclude.training && /\btraining material\b|\bsandbox\b/.test(lower)) reasons.push("training/sandbox content is excluded");
  if (ADMISSION.exclude.personalSites && (sourceKind === "onedrive-personal" || sharePoint?.personal)) reasons.push("personal OneDrive content is never mirrored");

  if (modifiedAt && ADMISSION.exclude.olderThanDays) {
    const ageDays = (Date.now() - Date.parse(modifiedAt)) / 86_400_000;
    const limit = v?.retentionDays ? Math.min(ADMISSION.exclude.olderThanDays, v.retentionDays) : ADMISSION.exclude.olderThanDays;
    if (ageDays > limit) reasons.push(`last modified ${Math.round(ageDays)}d ago — beyond the ${limit}d window for ${vId}`);
  }
  if (ADMISSION.requireSharePointId && !sharePoint?.itemId && sourceKind !== "wiki") {
    warnings.push("no SharePoint item id — provenance and the cold tier depend on it");
  }
  if (ADMISSION.exclude.languages && language && !ADMISSION.exclude.languages.includes(language)) {
    reasons.push(`language "${language}" outside the accepted set`);
  }
  if (piiFlagged) {
    if (ADMISSION.pii.blockUntilReviewed) reasons.push("PII flagged and review is blocking");
    else warnings.push("PII flagged for review — indexed, but marked in every citation");
  }

  const hash = sha256(text);
  const dup = store?.findDocumentByHash?.(hash, vId);
  if (dup && ADMISSION.exclude.duplicateContentHash) {
    warnings.push(`duplicate of ${dup.id} ("${dup.title}") — will update in place, not add a copy`);
  }

  // quota: refuse rather than silently break the ceiling
  if (store && v) {
    const live = store.liveBytes();
    const usedGB = live.byVertical[vId]?.gb ?? 0;
    const incomingGB = (tokens * CHUNKING.charsPerToken + estimateTokens(text) * 0) / GB;
    if (usedGB + Math.max(incomingGB, 0.001) > v.quotaGB && usedGB >= v.quotaGB * 0.999) {
      reasons.push(`vertical "${vId}" is at its ${v.quotaGB} GB quota — demote cold content first (the lifecycle job runs nightly)`);
    }
    if (live.totalGB > STORAGE.liveCeilingGB) reasons.push(`platform is at the ${STORAGE.liveCeilingGB} GB live ceiling`);
  }

  return { accept: reasons.length === 0, reasons, warnings, tokens, contentHash: hash, duplicateOf: dup?.id || null };
}

/**
 * Ingest one document end to end.
 * @returns {{accepted:boolean, doc?:object, chunks?:Array, reasons?:string[], warnings?:string[], deduped?:boolean}}
 */
export async function ingest(store, embedder, input) {
  const gate = admission(input, store);
  const actor = input.actor || input.appId || "system";

  if (!gate.accept) {
    store.audit({ action: "ingest.rejected", vertical: input.vertical, title: input.title, actor, appId: input.appId, reasons: gate.reasons });
    return { accepted: false, reasons: gate.reasons, warnings: gate.warnings };
  }

  const text = parse(input.text, input.format || "text");
  const chunks = chunkText(text, input.chunking);
  if (!chunks.length) {
    return { accepted: false, reasons: ["nothing survived parsing"], warnings: gate.warnings };
  }

  // Update the document we were given (mirror sync passes its id), otherwise
  // fall back to content-hash dedupe within the same vertical. Without this an
  // edited source would create a twin and the stale copy would keep being cited.
  const existing = (input.id && store.getDocument(input.id)) || (gate.duplicateOf ? store.getDocument(gate.duplicateOf) : null);
  const docId = existing?.id || shortId("doc");

  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));
  const summary = input.summary || buildSummary(input.title, text);
  const summaryEmbedding = await embedder.embed(summary);

  if (existing) store.dropChunks(existing.id);

  const doc = store.putDocument({
    id: docId,
    vertical: input.vertical || "shared",
    title: input.title || "untitled",
    sourceKind: input.sourceKind || "upload",
    sharePoint: input.sharePoint || null,
    contentHash: gate.contentHash,
    tokens: gate.tokens,
    chunkCount: chunks.length,
    bytes: text.length,
    tier: existing?.tier === "cold" ? "cold" : "hot",
    sensitivity: input.sensitivity || vertical(input.vertical)?.sensitivity,
    tags: input.tags || [],
    summary,
    summaryEmbedding,
    acl: input.acl,
    mirrorState: input.sharePoint?.etag || input.sharePoint?.versionId ? "mirrored" : existing?.mirrorState || "pending",
    mirrorVerifiedAt: existing?.mirrorVerifiedAt || null,
    appId: input.appId || null,
    createdAt: existing?.createdAt,
    lastOpenedAt: existing?.lastOpenedAt,
    openCount: existing?.openCount || 0,
  });

  const stored = store.putChunks(
    chunks.map((c, i) => ({
      docId: doc.id,
      vertical: doc.vertical,
      ordinal: c.ordinal,
      heading: c.heading,
      text: c.text,
      tokens: c.tokens,
      charStart: c.charStart,
      charEnd: c.charEnd,
      pageStart: input.pageMap?.[i]?.start ?? c.pageStart,
      pageEnd: input.pageMap?.[i]?.end ?? c.pageEnd,
      tier: doc.tier === "cold" ? "cold" : "hot",
      embedding: embeddings[i],
    }))
  );

  store.audit({
    action: existing ? "ingest.updated" : "ingest.accepted",
    docId: doc.id,
    vertical: doc.vertical,
    title: doc.title,
    actor,
    appId: input.appId,
    chunks: stored.length,
    tokens: doc.tokens,
    warnings: gate.warnings,
    embedder: embedder.model,
    dims: embeddings[0]?.length ?? 0,
  });

  return { accepted: true, doc, chunks: stored, warnings: gate.warnings, deduped: !!existing };
}

/** Extractive summary: title + first substantive sentences. Cheap, local, and
 *  honest — it never claims to be a model-generated abstract. */
export function buildSummary(title, text, maxChars = 600) {
  const sentences = String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && tokenize(s).length > 6);
  const picked = [];
  let len = 0;
  for (const s of sentences) {
    if (len + s.length > maxChars) break;
    picked.push(s);
    len += s.length;
  }
  return `${title}. ${picked.join(" ")}`.trim();
}

export default { parse, chunkText, admission, ingest, estimateTokens, buildSummary };

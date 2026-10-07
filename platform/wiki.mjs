/* ============================================================================
   platform/wiki.mjs — the shared wiki, indexed like everything else.

   A wiki that is not in the retrieval index is a graveyard. So every save:
     1. appends an immutable revision (nothing is edited in place),
     2. recomputes backlinks from [[wiki-links]] and markdown links,
     3. re-indexes the page into RAG as a first-class document, so an answer can
        cite a wiki page with the same contract it cites a contract,
     4. mirrors the page back to SharePoint, so the wiki survives the platform.

   Pages carry a review date. Overdue reviews are surfaced rather than silently
   trusted — "only live production useful data" applies to prose too.
   ========================================================================== */

import { TIERS, vertical } from "./config.mjs";
import { shortId, sha256 } from "./store.mjs";
import { ingest } from "./ingest.mjs";

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
export const wikiSlug = (verticalId, title) => `${verticalId}/${slugify(title)}`;

/** [[like this]] or [text](wiki:slug) or a bare /wiki/slug path. */
/* A link target is normalised per path segment, never as one string: the UI
   treats [[legal/msa-northwind]] as a slug verbatim, and slugifying the whole
   thing turned the slash into a dash, so the link matched no page and the
   backlink quietly disappeared. Title-shaped links ([[How answering works]])
   still normalise to a tail and are matched against every page's slug tail. */
export const linkSlug = (s) =>
  String(s ?? "").trim().toLowerCase().split("/").map((part) => slugify(part)).filter(Boolean).join("/");

export function extractLinks(body) {
  const out = new Set();
  for (const m of String(body).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) out.add(linkSlug(m[1]));
  for (const m of String(body).matchAll(/\[[^\]]*\]\((?:wiki:|\/wiki\/)([^)\s]+)\)/g)) out.add(linkSlug(m[1]));
  for (const m of String(body).matchAll(/(?<![\w)\]])\/wiki\/([\w\-/]+)/g)) out.add(linkSlug(m[1])); // bare paths in prose
  return [...out].filter(Boolean);
}

export function frontMatter(body) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(body));
  if (!m) return { data: {}, body: String(body) };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const raw = kv[2].trim();
    data[kv[1]] = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : raw.replace(/^["']|["']$/g, "");
  }
  return { data, body: String(body).slice(m[0].length) };
}

export async function createPage(store, embedder, { title, body, vertical: vId = "shared", author = "system", tags = [], reviewBy = null, owner = null, slug = null, acl = null }) {
  const { data, body: clean } = frontMatter(body);
  const pageSlug = slug || wikiSlug(vId, title);
  if (store.getWikiPage(pageSlug)) return { ok: false, error: `page already exists: ${pageSlug}` };
  const page = store.putWikiPage({
    vertical: vId,
    slug: pageSlug,
    title: data.title || title,
    body: clean,
    frontMatter: data,
    revision: 1,
    reviewBy: data.review_by || reviewBy,
    owner: data.owner || owner,
    tags: [...new Set([...(data.tags || []), ...tags])],
    backlinks: [],
    acl: acl || { readers: [], groups: [`vertical:${vId}`], denyPublic: false },
  });
  store.addWikiRevision({ pageId: page.id, revision: 1, body: clean, author, note: "created", hash: sha256(clean) });
  await reindex(store, embedder, page, { author });
  refreshBacklinks(store);
  store.audit({ action: "wiki.created", vertical: vId, slug: pageSlug, actor: author, revision: 1 });
  return { ok: true, page };
}

export async function updatePage(store, embedder, slugOrId, { body, author = "system", note = "edit", reviewBy = null, tags = null }) {
  const page = store.getWikiPage(slugOrId);
  if (!page) return { ok: false, error: `no such page: ${slugOrId}` };
  const { data, body: clean } = frontMatter(body);
  if (clean === page.body && !reviewBy && !tags) return { ok: false, error: "no change", page };
  store.addWikiRevision({ pageId: page.id, revision: page.revision + 1, body: clean, author, note, hash: sha256(clean), previous: page.revision });
  page.body = clean;
  page.title = data.title || page.title;
  page.revision += 1;
  page.updatedBy = author;
  if (reviewBy || data.review_by) page.reviewBy = reviewBy || data.review_by;
  if (tags) page.tags = [...new Set([...page.tags, ...tags])];
  Object.assign(page.frontMatter, data);
  store.putWikiPage(page);
  await reindex(store, embedder, page, { author });
  refreshBacklinks(store);
  store.audit({ action: "wiki.updated", vertical: page.vertical, slug: page.slug, actor: author, revision: page.revision, note });
  return { ok: true, page };
}

/** A page is a document: indexed, quotable, citable, and subject to retention. */
async function reindex(store, embedder, page, { author = "system" } = {}) {
  const res = await ingest(store, embedder, {
    id: page.docId || undefined,
    title: `${page.title} (wiki)`,
    text: `# ${page.title}\n\n${page.body}`,
    vertical: page.vertical,
    contentType: "wiki",
    sourceKind: "wiki",
    format: "markdown",
    tags: [...page.tags, "wiki", page.slug],
    actor: author,
    acl: page.acl,
    summary: `${page.title} — ${page.vertical} wiki, revision ${page.revision}. ${page.body.slice(0, 400)}`,
  });
  if (res.accepted && res.doc) {
    page.docId = res.doc.id;
    store.putWikiPage(page);
  }
  return res;
}

export function refreshBacklinks(store) {
  const pages = store.data.wiki_pages;
  const byTail = new Map(pages.map((p) => [p.slug.split("/").pop(), p]));
  for (const p of pages) {
    const links = extractLinks(p.body);
    for (const l of links) {
      const target = pages.find((t) => t.slug === l || t.slug.endsWith("/" + l)) || byTail.get(l);
      if (!target || target.id === p.id) continue;
      if (!target.backlinks.includes(p.slug)) target.backlinks.push(p.slug);
    }
  }
  for (const p of pages) {
    const inbound = pages.filter((other) => other.id !== p.id && extractLinks(other.body).some((l) => p.slug === l || p.slug.endsWith("/" + l))).map((o) => o.slug);
    p.backlinks = [...new Set(inbound)].sort();
  }
  return pages.map((p) => ({ slug: p.slug, backlinks: p.backlinks.length }));
}

export function reviewQueue(store, { at = Date.now(), daysAhead = 30 } = {}) {
  const out = [];
  for (const p of store.data.wiki_pages) {
    if (!p.reviewBy) continue;
    // reviewBy is an ISO string everywhere the platform writes it, but a caller
    // (or an import) can hand over epoch millis. Coerce both: a queue that drops
    // a page because of the timestamp's shape hides overdue reviews, which is
    // exactly what this queue exists to prevent.
    const due = typeof p.reviewBy === "number" ? p.reviewBy : Date.parse(p.reviewBy);
    if (!Number.isFinite(due)) continue;
    const days = Math.round((due - at) / 86_400_000);
    if (days <= daysAhead) out.push({ slug: p.slug, title: p.title, vertical: p.vertical, owner: p.owner, reviewBy: p.reviewBy, daysUntilDue: days, overdue: days < 0, revision: p.revision, updatedBy: p.updatedBy });
  }
  return out.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

/** Very small line diff — enough for a review UI, honest about being small. */
export function diff(a, b) {
  const A = String(a).split("\n");
  const B = String(b).split("\n");
  const setA = new Set(A);
  const setB = new Set(B);
  return {
    added: B.filter((l) => !setA.has(l)),
    removed: A.filter((l) => !setB.has(l)),
    unchanged: A.filter((l) => setB.has(l)).length,
    linesBefore: A.length,
    linesAfter: B.length,
  };
}

export function searchPages(store, q, { vertical: vId = null, limit = 25 } = {}) {
  const needle = String(q || "").toLowerCase();
  return store
    .listWikiPages({ vertical: vId })
    .map((p) => {
      const title = p.title.toLowerCase().includes(needle) ? 3 : 0;
      const slug = p.slug.toLowerCase().includes(needle) ? 2 : 0;
      const tags = p.tags.some((t) => t.toLowerCase().includes(needle)) ? 2 : 0;
      const body = p.body.toLowerCase().includes(needle) ? 1 : 0;
      const occurrences = body ? p.body.toLowerCase().split(needle).length - 1 : 0;
      return { page: p, score: title + slug + tags + body + Math.min(occurrences, 5) * 0.2 };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((r) => ({ slug: r.page.slug, title: r.page.title, vertical: r.page.vertical, revision: r.page.revision, updatedAt: r.page.updatedAt, score: +r.score.toFixed(2), snippet: snippetAround(r.page.body, needle) }));
}

function snippetAround(body, needle, width = 180) {
  const at = String(body).toLowerCase().indexOf(needle);
  if (at < 0) return String(body).slice(0, width);
  return `${at > width / 2 ? "…" : ""}${String(body).slice(Math.max(0, at - width / 2), at + width / 2)}…`;
}

/** Outbound mirror: the wiki exists in SharePoint too, or it does not survive. */
export async function mirrorPages(store, sp, { siteId = "company-knowledge", author = "wiki-mirror" } = {}) {
  const out = { uploaded: 0, failed: [] };
  for (const p of store.data.wiki_pages) {
    const text = `---\ntitle: ${p.title}\nvertical: ${p.vertical}\nrevision: ${p.revision}\nowner: ${p.owner || ""}\nreview_by: ${p.reviewBy || ""}\ntags: [${p.tags.join(", ")}]\nupdated_by: ${p.updatedBy}\n---\n\n# ${p.title}\n\n${p.body}\n`;
    try {
      const res = await sp.upload({ siteId, path: `${p.slug}.md`, name: `${p.slug}.md`, text, contentType: "wiki" });
      p.mirrorState = "mirrored";
      p.sharePoint = { itemId: res.itemId, webUrl: res.webUrl, versionId: res.versionId };
      store.putWikiPage(p);
      out.uploaded++;
    } catch (e) {
      p.mirrorState = "failed";
      store.putWikiPage(p);
      out.failed.push({ slug: p.slug, error: e.message });
    }
  }
  store.audit({ action: "wiki.mirrored", actor: author, uploaded: out.uploaded, failed: out.failed.length });
  return out;
}

/** Stats over any page list — so a scoped key gets numbers for what it may see,
 *  not for the whole estate. */
export function statsFor(store, pages) {
  const list = pages || store.data.wiki_pages;
  const byVertical = {};
  for (const p of list) byVertical[p.vertical] = (byVertical[p.vertical] || 0) + 1;
  return {
    pages: list.length,
    revisions: list.reduce((n, p) => n + store.wikiRevisions(p.id).length, 0),
    byVertical,
    indexed: list.filter((p) => p.docId).length,
    mirrored: list.filter((p) => p.mirrorState === "mirrored").length,
    overdueReviews: list.filter((p) => p.reviewBy && Date.parse(p.reviewBy) < Date.now()).length,
    backlinks: list.reduce((s, p) => s + (p.backlinks || []).length, 0),
  };
}

export function stats(store) {
  const pages = store.data.wiki_pages;
  const byVertical = {};
  for (const p of pages) byVertical[p.vertical] = (byVertical[p.vertical] || 0) + 1;
  return {
    pages: pages.length,
    revisions: store.data.wiki_revisions.length,
    byVertical,
    indexed: pages.filter((p) => p.docId).length,
    mirrored: pages.filter((p) => p.mirrorState === "mirrored").length,
    overdueReviews: reviewQueue(store, { daysAhead: 0 }).filter((r) => r.overdue).length,
    backlinks: pages.reduce((s, p) => s + p.backlinks.length, 0),
  };
}

export default { createPage, updatePage, reindex, refreshBacklinks, reviewQueue, diff, searchPages, mirrorPages, stats, statsFor, extractLinks, frontMatter, wikiSlug, linkSlug };

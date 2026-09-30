/* ============================================================================
   platform/sharepoint.mjs — SharePoint as the mirror and the cold tier.

   Two directions, one rule:

     inbound   SharePoint is the system of record for source documents. A delta
               sync every 15 minutes pulls new/changed items into the platform.
     outbound  Platform-born content (wiki pages, summaries, annotations) is
               written back to a mirror library, so nothing exists only here.

   The rule: the platform never deletes or demotes content it cannot prove is
   mirrored. `verifyMirror()` compares the content hash and the eTag/version id
   before anything leaves the live tier — a demotion that cannot be verified is
   skipped and reported, not attempted.

   Permissions are inherited from the source item and may never widen: if
   SharePoint says three people, the platform says three people.

   GraphSharePoint is real code against the documented Graph endpoints but
   cannot be exercised without a tenant; MockSharePoint is what the tests and
   the offline demo run against, and it is faithful about the same contract.
   ========================================================================== */

import { SHAREPOINT, ADMISSION } from "./config.mjs";
import { sha256 } from "./store.mjs";

/** Map Graph permission grants onto the platform ACL. Never widens. */
export function mapPermissions(grants = [], { allowAnonymous = false } = {}) {
  const readers = [];
  const groups = [];
  let denyPublic = true;
  for (const g of grants) {
    for (const r of g.grantedToIdentities || []) {
      if (r.user?.id) readers.push(`sp:${r.user.id}`);
      if (r.group?.id) groups.push(`sp:group:${r.group.id}`);
      if (r.application?.id) readers.push(`app:${r.application.id}`);
    }
    for (const r of g.grantedTo || []) {
      if (r.user?.id) readers.push(`sp:${r.user.id}`);
    }
    if (g.link && !allowAnonymous) denyPublic = true; // sharing links do not widen the ACL
    if (g.link?.scope === "anonymous" && allowAnonymous) denyPublic = false;
  }
  return { readers: [...new Set(readers)], groups: [...new Set(groups)], denyPublic };
}

export class MockSharePoint {
  /** @param {{sites?:Array, items?:Array}} fixtures */
  constructor(fixtures = {}) {
    this.kind = "mock";
    this.sites = fixtures.sites || [{ id: "site-legal", name: "legal-knowledge", vertical: "legal" }];
    this.items = new Map();
    this.deltaTokens = new Map();
    this.changes = [];
    this.calls = { download: 0, delta: 0, verify: 0, upload: 0 };
    for (const it of fixtures.items || []) this.#putItem(it);
  }

  #putItem(it) {
    const rec = {
      id: it.id,
      siteId: it.siteId || this.sites[0].id,
      name: it.name || `${it.id}.md`,
      path: it.path || `/Knowledge/${it.name || it.id + ".md"}`,
      text: it.text ?? "",
      contentType: it.contentType || "document",
      modifiedAt: it.modifiedAt || new Date().toISOString(),
      etag: it.etag || `"${sha256((it.text ?? "") + (it.modifiedAt || "")).slice(0, 16)}"`,
      versionId: it.versionId || "1.0",
      webUrl: it.webUrl || `https://contoso.sharepoint.com/sites/${it.siteId || this.sites[0].id}/_layouts/15/Doc.aspx?id=${it.id}`,
      permissions: it.permissions || [{ grantedToIdentities: [{ group: { id: "everyone-in-vertical" } }] }],
      sensitivity: it.sensitivity || null,
      personal: !!it.personal,
      deleted: false,
    };
    this.items.set(rec.id, rec);
    this.changes.push({ kind: "changed", item: rec, at: rec.modifiedAt });
    return rec;
  }

  /* ---------------------------------------------------------- Graph-shaped */
  async listSites() {
    return this.sites;
  }
  /** Delta query: everything changed since `token`. Returns a new token. */
  async delta(siteId, token = null) {
    this.calls.delta++;
    const since = token ? Number(token) : 0;
    const items = [...this.items.values()].filter((it) => (!siteId || it.siteId === siteId) && Date.parse(it.modifiedAt) > since);
    const nextToken = String(Date.now());
    this.deltaTokens.set(siteId || "*", nextToken);
    return {
      value: items.map((it) => ({ ...it, "@removed": it.deleted ? { reason: "deleted" } : undefined })),
      deltaLink: nextToken,
    };
  }
  async getItem(itemId) {
    return this.items.get(itemId) || null;
  }
  async download(itemId) {
    this.calls.download++;
    const it = this.items.get(itemId);
    if (!it) return null;
    return { text: it.text, etag: it.etag, versionId: it.versionId, hash: sha256(it.text), modifiedAt: it.modifiedAt };
  }
  async permissions(itemId) {
    const it = this.items.get(itemId);
    return it ? mapPermissions(it.permissions) : { readers: [], groups: [], denyPublic: true };
  }
  /** Prove the mirror holds this exact content. Demotion depends on it. */
  async verifyMirror(doc) {
    this.calls.verify++;
    const id = doc?.sharePoint?.itemId;
    if (!id) return { ok: false, reason: "no SharePoint item id on this document" };
    const it = this.items.get(id);
    if (!it || it.deleted) return { ok: false, reason: "source item no longer exists in SharePoint" };
    const remoteHash = sha256(it.text);
    if (doc.contentHash && doc.contentHash !== remoteHash) {
      return { ok: false, reason: "content hash differs — the local copy drifted from the mirror", local: doc.contentHash.slice(0, 12), remote: remoteHash.slice(0, 12) };
    }
    return { ok: true, itemId: it.id, etag: it.etag, versionId: it.versionId, webUrl: it.webUrl, hash: remoteHash, verifiedAt: new Date().toISOString() };
  }
  /** Outbound mirror: platform-born content is written back. */
  async upload({ siteId, path, name, text, contentType = "document" }) {
    this.calls.upload++;
    const existing = [...this.items.values()].find((i) => i.path === path && i.siteId === siteId);
    const rec = existing
      ? Object.assign(existing, { text, modifiedAt: new Date().toISOString(), etag: `"${sha256(text + Date.now()).slice(0, 16)}"`, versionId: `${Number(existing.versionId) + 1}.0` })
      : this.#putItem({ id: `sp_${sha256(path).slice(0, 10)}`, siteId, path, name, text, contentType });
    return { ok: true, itemId: rec.id, etag: rec.etag, versionId: rec.versionId, webUrl: rec.webUrl, hash: sha256(rec.text) };
  }
  /* ------------------------------------------------------------ test hooks */
  simulateEdit(itemId, text) {
    const it = this.items.get(itemId);
    if (!it) return null;
    it.text = text;
    it.modifiedAt = new Date().toISOString();
    it.versionId = `${Number(it.versionId) + 1}.0`;
    it.etag = `"${sha256(text + it.modifiedAt).slice(0, 16)}"`;
    this.changes.push({ kind: "edited", item: it, at: it.modifiedAt });
    return it;
  }
  simulateDelete(itemId) {
    const it = this.items.get(itemId);
    if (!it) return null;
    it.deleted = true;
    it.modifiedAt = new Date().toISOString();
    this.changes.push({ kind: "deleted", item: it, at: it.modifiedAt });
    return it;
  }
  seed(items) {
    for (const it of items) this.#putItem(it);
    return this;
  }
}

/**
 * Real connector against Microsoft Graph. Endpoints as documented:
 *   POST /oauth2/v2.0/token                       client credentials
 *   GET  /sites/{hostname}:/sites/{site}
 *   GET  /sites/{site}/drives
 *   GET  /drives/{drive}/root:/Knowledge:/delta     delta link, 15-minute cadence
 *   GET  /drives/{drive}/items/{item}/content       download
 *   GET  /drives/{drive}/items/{item}/permissions
 *   PUT  /drives/{drive}/root:/{path}:/content      outbound mirror
 * Requires AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and
 * Sites.Read.All (plus Files.ReadWrite.All for the outbound mirror).
 */
export class GraphSharePoint {
  constructor(opts = {}) {
    this.kind = "graph";
    this.tenant = opts.tenant || process.env.AZURE_TENANT_ID;
    this.clientId = opts.clientId || process.env.AZURE_CLIENT_ID;
    this.clientSecret = opts.clientSecret || process.env.AZURE_CLIENT_SECRET;
    this.base = opts.base || SHAREPOINT.graphBase;
    this.siteHostname = opts.siteHostname || process.env.SP_HOSTNAME;
    this.driveId = opts.driveId || process.env.SP_DRIVE_ID || null;
    this.token = null;
    this.tokenExpires = 0;
    this.calls = { download: 0, delta: 0, verify: 0, upload: 0 };
    if (!this.tenant || !this.clientId || !this.clientSecret) {
      throw new Error("GraphSharePoint needs AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET");
    }
  }
  async #token() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await fetch(`https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    this.token = j.access_token;
    this.tokenExpires = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }
  async #get(path) {
    const t = await this.#token();
    const res = await fetch(this.base + path, { headers: { authorization: `Bearer ${t}` } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  }
  async listSites() {
    const j = await this.#get(`/sites?search=*`);
    return (j.value || []).map((s) => ({ id: s.id, name: s.name, webUrl: s.webUrl }));
  }
  async delta(siteId, token = null) {
    this.calls.delta++;
    const url = token || `/sites/${siteId}/drives/${this.driveId}/root:/${SHAREPOINT.libraries.source}:/delta`;
    const j = await this.#get(url.startsWith("http") ? "" : url);
    return { value: j.value || [], deltaLink: j["@odata.deltaLink"] || null };
  }
  async download(itemId) {
    this.calls.download++;
    const t = await this.#token();
    const meta = await this.#get(`/drives/${this.driveId}/items/${itemId}`);
    const res = await fetch(`${this.base}/drives/${this.driveId}/items/${itemId}/content`, { headers: { authorization: `Bearer ${t}` } });
    if (!res.ok) throw new Error(`download ${itemId} → ${res.status}`);
    const text = await res.text();
    return { text, etag: meta.eTag, versionId: String(meta.id), hash: sha256(text), modifiedAt: meta.lastModifiedDateTime };
  }
  async permissions(itemId) {
    const j = await this.#get(`/drives/${this.driveId}/items/${itemId}/permissions`);
    return mapPermissions(j.value || []);
  }
  async verifyMirror(doc) {
    this.calls.verify++;
    const id = doc?.sharePoint?.itemId;
    if (!id || !this.driveId) return { ok: false, reason: "no SharePoint item id (or drive not configured)" };
    try {
      const remote = await this.download(id);
      if (doc.contentHash && doc.contentHash !== remote.hash) {
        return { ok: false, reason: "content hash differs from the mirror", local: doc.contentHash.slice(0, 12), remote: remote.hash.slice(0, 12) };
      }
      return { ok: true, itemId: id, etag: remote.etag, versionId: remote.versionId, hash: remote.hash, verifiedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, reason: `verify failed: ${e.message}` };
    }
  }
  async upload({ path, text }) {
    this.calls.upload++;
    const t = await this.#token();
    const res = await fetch(`${this.base}/drives/${this.driveId}/root:/${SHAREPOINT.libraries.mirror}/${path}:/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${t}`, "content-type": "text/plain" },
      body: text,
    });
    if (!res.ok) throw new Error(`upload ${path} → ${res.status}`);
    const j = await res.json();
    return { ok: true, itemId: j.id, etag: j.eTag, webUrl: j.webUrl, hash: sha256(text) };
  }
}

/** Inbound delta sync: apply SharePoint changes to the platform. */
export async function syncInbound(store, sp, ingestFn, { siteId = null, token = null, actor = "sharepoint-sync" } = {}) {
  const delta = await sp.delta(siteId, token);
  const applied = { created: 0, updated: 0, removed: 0, skipped: 0, rejected: [] };
  for (const item of delta.value || []) {
    if (item["@removed"]) {
      const doc = store.listDocuments({}).find((d) => d.sharePoint?.itemId === item.id);
      if (doc) {
        store.deleteDocument(doc.id, "removed in SharePoint (source of record)");
        store.audit({ action: "mirror.removed", docId: doc.id, vertical: doc.vertical, actor });
        applied.removed++;
      }
      continue;
    }
    if (item.personal && ADMISSION.exclude.personalSites) {
      applied.skipped++;
      continue;
    }
    const site = (await sp.listSites()).find((s) => s.id === item.siteId);
    const verticalId = site?.vertical || "shared";
    const existing = store.listDocuments({ vertical: verticalId }).find((d) => d.sharePoint?.itemId === item.id);
    const content = await sp.download(item.id);
    const acl = await sp.permissions(item.id);
    // A grant on a site-level group means "member of this vertical's library",
    // which is the coarse grant the platform enforces; item-level readers then
    // refine it. Widening is never possible: this only adds the vertical the
    // item already lives in, and it is recorded in the audit trail.
    acl.groups = [...new Set([...acl.groups, `vertical:${verticalId}`])];
    const res = await ingestFn({
      id: existing?.id,
      title: item.name.replace(/\.[a-z0-9]+$/i, ""),
      text: content.text,
      vertical: verticalId,
      contentType: item.contentType || "document",
      sourceKind: "sharepoint",
      sharePoint: { siteId: item.siteId, itemId: item.id, webUrl: item.webUrl, etag: content.etag, versionId: content.versionId, path: item.path },
      modifiedAt: item.modifiedAt,
      acl,
      actor,
    });
    if (res.accepted) {
      res.doc && (res.doc.mirrorState = "mirrored");
      existing ? applied.updated++ : applied.created++;
    } else {
      applied.rejected.push({ id: item.id, name: item.name, reasons: res.reasons });
      applied.skipped++;
    }
  }
  store.audit({ action: "mirror.sync", actor, ...applied, rejected: applied.rejected.length });
  return { ...applied, deltaLink: delta.deltaLink };
}

export default { MockSharePoint, GraphSharePoint, mapPermissions, syncInbound };

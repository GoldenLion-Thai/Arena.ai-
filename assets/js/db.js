/* ============================================================================
   db.js — local-first conversation store (IndexedDB).

   Chosen over SQLite/WASM here because it needs no bundler, no OPFS permission
   prompt and works in every modern browser. Records are small, append-heavy
   and read per-conversation — a key/value store with an index fits well.
   Message bodies are encrypted via vault.js when a passphrase is set.

   Schema
     conversations : { id, title, modelId, mode, createdAt, updatedAt, pinned, encrypted }
     messages      : { id, convId, role, createdAt, body(ciphertext|json), meta }
     files         : { id, name, size, kind, indexedAt, chunks }   (metadata only)
   ========================================================================== */

(function () {
  const DB_NAME = "grid-workspace";
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("conversations")) {
          const c = db.createObjectStore("conversations", { keyPath: "id" });
          c.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("messages")) {
          const m = db.createObjectStore("messages", { keyPath: "id" });
          m.createIndex("convId", "convId");
        }
        if (!db.objectStoreNames.contains("files")) {
          db.createObjectStore("files", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  /** Run `fn` against an object store inside one transaction.
   *  The request must be created synchronously (that keeps the transaction
   *  alive), and resolution waits for BOTH the request result and the
   *  transaction's `complete` event — resolving on `complete` alone races the
   *  result microtask and can hand back `undefined`. */
  function tx(store, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, mode);
          const s = t.objectStore(store);
          const work = Promise.resolve(fn(s));
          t.oncomplete = () => work.then(resolve, reject);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const DB = {
    uid,

    /* ---- conversations ---- */

    async listConversations() {
      const rows = await tx("conversations", "readonly", (s) => promisify(s.getAll()));
      return (rows || []).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);
    },

    async getConversation(id) {
      return tx("conversations", "readonly", (s) => promisify(s.get(id)));
    },

    async putConversation(conv) {
      conv.updatedAt = Date.now();
      await tx("conversations", "readwrite", (s) => promisify(s.put(conv)));
      return conv;
    },

    async deleteConversation(id) {
      const msgs = await DB.listMessages(id);
      await tx("messages", "readwrite", (s) =>
        Promise.all(msgs.map((m) => promisify(s.delete(m.id))))
      );
      await tx("conversations", "readwrite", (s) => promisify(s.delete(id)));
    },

    async clearAll() {
      await tx("conversations", "readwrite", (s) => promisify(s.clear()));
      await tx("messages", "readwrite", (s) => promisify(s.clear()));
      await tx("files", "readwrite", (s) => promisify(s.clear()));
    },

    /* ---- messages ---- */

    async listMessages(convId) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction("messages", "readonly");
        const idx = t.objectStore("messages").index("convId");
        const r = idx.getAll(convId);
        r.onsuccess = () => resolve((r.result || []).sort((a, b) => a.createdAt - b.createdAt));
        r.onerror = () => reject(r.error);
      });
    },

    /** Encrypts `content` before write. `meta` (tokens, latency, sources) stays
     *  plaintext so lists and metrics can render without unlocking. */
    async addMessage({ convId, role, content, meta }) {
      const body = await window.GRID_VAULT.encrypt(content);
      const rec = {
        id: uid(),
        convId,
        role,
        createdAt: Date.now(),
        body,
        meta: meta || {},
      };
      await tx("messages", "readwrite", (s) => promisify(s.put(rec)));
      const conv = await DB.getConversation(convId);
      if (conv) await DB.putConversation(conv);
      return rec;
    },

    async readMessage(rec) {
      try {
        return await window.GRID_VAULT.decrypt(rec.body);
      } catch (e) {
        return String(e && e.message === "LOCKED" ? "🔒 encrypted — unlock the vault to read" : "");
      }
    },

    async updateMessage(id, content, meta) {
      const rec = await tx("messages", "readonly", (s) => promisify(s.get(id)));
      if (!rec) return null;
      rec.body = await window.GRID_VAULT.encrypt(content);
      if (meta) rec.meta = Object.assign({}, rec.meta, meta);
      await tx("messages", "readwrite", (s) => promisify(s.put(rec)));
      return rec;
    },

    /* ---- files (metadata only; blobs stay out of the DB) ---- */

    async listFiles() {
      const rows = await tx("files", "readonly", (s) => promisify(s.getAll()));
      return (rows || []).sort((a, b) => b.indexedAt - a.indexedAt);
    },

    async putFile(f) {
      await tx("files", "readwrite", (s) => promisify(s.put(f)));
      return f;
    },

    async deleteFile(id) {
      await tx("files", "readwrite", (s) => promisify(s.delete(id)));
    },

    /* ---- stats ---- */

    async stats() {
      const [convs, files] = await Promise.all([DB.listConversations(), DB.listFiles()]);
      let messages = 0;
      let bytes = 0;
      const db = await open();
      const all = await new Promise((resolve, reject) => {
        const r = db.transaction("messages", "readonly").objectStore("messages").getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      messages = all.length;
      bytes = all.reduce((n, m) => n + (m.body && m.body.data ? m.body.data.length : 0), 0);
      return { conversations: convs.length, messages, files: files.length, bytes };
    },
  };

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  window.GRID_DB = DB;
})();

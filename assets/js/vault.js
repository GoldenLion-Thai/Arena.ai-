/* ============================================================================
   vault.js — client-side encryption for local chat history.

   Honest threat model (stated in the UI, not hidden in a policy):
   • Protects conversation bodies at rest in IndexedDB from anyone who reads
     the browser profile / disk without the passphrase.
   • Does NOT protect against a compromised page while unlocked: JS holding a
     key in memory can be read by other JS on the same origin.
   • Key = PBKDF2-SHA256(passphrase, per-device salt, 210k iterations) → AES-GCM
     256-bit. The passphrase is never stored; the derived key lives in memory
     for the session only.

   Without a passphrase set, records are stored as plaintext and the UI says
   so plainly ("Encrypted: off") rather than pretending otherwise.
   ========================================================================== */

(function () {
  const DB_NAME = "sov-vault";
  const META_STORE = "meta";
  const PBKDF2_ITERATIONS = 210000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let sessionKey = null; // CryptoKey, memory only

  const b64 = {
    to(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)));
    },
    from(str) {
      return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
    },
  };

  function metaDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function metaGet(key) {
    const db = await metaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const r = tx.objectStore(META_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function metaSet(key, value) {
    const db = await metaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deriveKey(passphrase, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptJSON(value) {
    if (!sessionKey) return { v: 0, data: JSON.stringify(value) };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, enc.encode(JSON.stringify(value)));
    return { v: 1, iv: b64.to(iv), data: b64.to(ct) };
  }

  async function decryptJSON(record) {
    if (!record) return null;
    if (record.v === 0) {
      // stored plaintext — only readable when no key is required
      try {
        return JSON.parse(record.data);
      } catch {
        return null;
      }
    }
    if (!sessionKey) throw new Error("LOCKED");
    const iv = b64.from(record.iv);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sessionKey, b64.from(record.data));
    return JSON.parse(dec.decode(pt));
  }

  const Vault = {
    get iterations() {
      return PBKDF2_ITERATIONS;
    },

    async isInitialised() {
      return Boolean(await metaGet("kdf"));
    },

    get unlocked() {
      return Boolean(sessionKey);
    },

    /** Create or re-key the vault. Re-keying re-encrypts nothing here; callers
     *  should export/rewrite records if the cipher version changes. */
    async init(passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(passphrase, salt);
      // Verification token proves the passphrase later without storing it.
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode("sov-vault-ok"));
      await metaSet("kdf", {
        algo: "PBKDF2-SHA256",
        iterations: PBKDF2_ITERATIONS,
        salt: b64.to(salt),
        verifyIv: b64.to(iv),
        verify: b64.to(ct),
        createdAt: Date.now(),
      });
      sessionKey = key;
      return true;
    },

    async unlock(passphrase) {
      const kdf = await metaGet("kdf");
      if (!kdf) throw new Error("NO_VAULT");
      const key = await deriveKey(passphrase, b64.from(kdf.salt));
      try {
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64.from(kdf.verifyIv) },
          key,
          b64.from(kdf.verify)
        );
      } catch {
        throw new Error("BAD_PASSPHRASE");
      }
      sessionKey = key;
      return true;
    },

    lock() {
      sessionKey = null;
    },

    /** Rotate the passphrase: derive new key, keep old key available for rewrites. */
    async rekey(newPassphrase) {
      const old = sessionKey;
      await this.init(newPassphrase);
      return old;
    },

    encrypt: encryptJSON,
    decrypt: decryptJSON,

    /** Fingerprint for display: never the key, never the passphrase. */
    async fingerprint() {
      if (!sessionKey) return null;
      const buf = await crypto.subtle.exportKey("raw", sessionKey).catch(() => null);
      if (!buf) return "in-memory";
      const h = await crypto.subtle.digest("SHA-256", buf);
      return b64.to(h).slice(0, 8).toUpperCase();
    },
  };

  window.SOV_VAULT = Vault;
})();

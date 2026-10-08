// HearHere — local audio cache (IndexedDB). Re-reading the same text is free and instant.
(() => {
  'use strict';
  const DB_NAME = 'hearhere-audio';
  const STORE = 'clips';
  const MAX_ENTRIES = 600;
  const MAX_BYTES = 150 * 1024 * 1024;

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('at', 'at');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  async function key(parts) {
    const data = new TextEncoder().encode(JSON.stringify(parts));
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function get(k) {
    try {
      const d = await db();
      return await new Promise((resolve) => {
        const tx = d.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.get(k);
        req.onsuccess = () => {
          const v = req.result;
          if (!v) return resolve(null);
          v.at = Date.now();
          store.put(v);
          resolve(v.blob);
        };
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function put(k, blob) {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: k, blob, size: blob.size, at: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
      prune();
    } catch (_) {}
  }

  async function entries() {
    const d = await db();
    return new Promise((resolve) => {
      const out = [];
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('at').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push({ key: c.value.key, size: c.value.size || 0, at: c.value.at });
        c.continue();
      };
      req.onerror = () => resolve(out);
    });
  }

  async function prune() {
    try {
      const list = await entries(); // oldest first
      let count = list.length;
      let bytes = list.reduce((a, e) => a + e.size, 0);
      const doomed = [];
      for (const e of list) {
        if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
        doomed.push(e.key);
        count--;
        bytes -= e.size;
      }
      if (!doomed.length) return;
      const d = await db();
      const tx = d.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      doomed.forEach(k => store.delete(k));
    } catch (_) {}
  }

  async function stats() {
    try {
      const list = await entries();
      return { count: list.length, bytes: list.reduce((a, e) => a + e.size, 0) };
    } catch (_) {
      return { count: 0, bytes: 0 };
    }
  }

  async function clear() {
    const d = await db();
    await new Promise((resolve) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  globalThis.HHCache = { key, get, put, stats, clear };
})();

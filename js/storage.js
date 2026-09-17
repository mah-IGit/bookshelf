// IndexedDB cache for book files, plus local reading progress.
// Progress is written here instantly and pushed to GitHub in the background,
// so closing a book never blocks on the network.

const DB_NAME = 'bookshelf';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_META = 'meta';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      t.oncomplete = () => resolve();
    }
  }));
}

export const files = {
  get: (id) => tx(STORE_FILES, 'readonly', (s) => s.get(id)),
  put: (id, buf) => tx(STORE_FILES, 'readwrite', (s) => s.put(buf, id)),
  del: (id) => tx(STORE_FILES, 'readwrite', (s) => s.delete(id)),
  keys: () => tx(STORE_FILES, 'readonly', (s) => s.getAllKeys()),
  clear: () => tx(STORE_FILES, 'readwrite', (s) => s.clear()),
};

export const meta = {
  get: (k) => tx(STORE_META, 'readonly', (s) => s.get(k)),
  put: (k, v) => tx(STORE_META, 'readwrite', (s) => s.put(v, k)),
};

/** Rough size of everything cached, in bytes. */
export async function cacheSize() {
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    if (usage) return usage;
  }
  const db = await open();
  return new Promise((resolve) => {
    let total = 0;
    const t = db.transaction(STORE_FILES, 'readonly');
    const cursor = t.objectStore(STORE_FILES).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve(total);
      total += c.value?.byteLength || 0;
      c.continue();
    };
    cursor.onerror = () => resolve(total);
  });
}

export function formatBytes(n) {
  if (!n) return '0 MB';
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

// ---------- progress ----------
// Shape: { [bookId]: { pos, pct, page, pages, updated } }

const PROGRESS_KEY = 'progress';

export async function allProgress() {
  return (await meta.get(PROGRESS_KEY)) || {};
}

export async function getProgress(id) {
  const all = await allProgress();
  return all[id] || null;
}

export async function setProgress(id, entry) {
  const all = await allProgress();
  all[id] = { ...entry, updated: Date.now() };
  await meta.put(PROGRESS_KEY, all);
  return all;
}

export async function replaceProgress(all) {
  await meta.put(PROGRESS_KEY, all || {});
}

/**
 * Last write wins per book, compared on the `updated` timestamp.
 * Good enough: you are one person and cannot read on two devices at once.
 */
export function mergeProgress(local, remote) {
  const out = { ...remote };
  for (const [id, entry] of Object.entries(local)) {
    if (!out[id] || (entry.updated || 0) > (out[id].updated || 0)) out[id] = entry;
  }
  return out;
}

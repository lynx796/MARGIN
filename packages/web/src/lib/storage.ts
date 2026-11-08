// Local persistence (spec §7.6, §11): documents and annotations live in the browser's Origin Private
// File System, keyed by the PDF's sha256; a small IndexedDB index lists them for the start screen.
// Where OPFS is unavailable (some private modes) blobs go to IndexedDB instead. Nothing leaves the device.

export interface DocRecord {
  sha: string;
  name: string;
  pageCount: number;
  /** ISO timestamp of the last change. */
  modified: string;
}

type Kind = 'pdf' | 'annot';
const FILE: Record<Kind, string> = { pdf: 'document.pdf', annot: 'annotations.json' };

interface Backend {
  put(sha: string, kind: Kind, data: Uint8Array): Promise<void>;
  get(sha: string, kind: Kind): Promise<Uint8Array | null>;
  remove(sha: string): Promise<void>;
  clear(): Promise<void>;
}

// ── IndexedDB ────────────────────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('margin', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('docs', { keyPath: 'sha' });
      d.createObjectStore('kv');
      d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbBackend: Backend = {
  put: (sha, kind, data) => tx('blobs', 'readwrite', (s) => s.put(data, `${sha}/${FILE[kind]}`)).then(() => undefined),
  get: async (sha, kind) => ((await tx<Uint8Array | undefined>('blobs', 'readonly', (s) => s.get(`${sha}/${FILE[kind]}`))) ?? null),
  remove: async (sha) => {
    for (const kind of Object.keys(FILE) as Kind[]) await tx('blobs', 'readwrite', (s) => s.delete(`${sha}/${FILE[kind]}`));
  },
  clear: () => tx('blobs', 'readwrite', (s) => s.clear()).then(() => undefined),
};

// ── OPFS ─────────────────────────────────────────────────────────────────────────────────────

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('margin', { create: true });
}

const opfsBackend: Backend = {
  async put(sha, kind, data) {
    const dir = await (await opfsRoot()).getDirectoryHandle(sha, { create: true });
    const handle = await dir.getFileHandle(FILE[kind], { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as unknown as FileSystemWriteChunkType);
    await writable.close();
  },
  async get(sha, kind) {
    try {
      const dir = await (await opfsRoot()).getDirectoryHandle(sha);
      const file = await (await dir.getFileHandle(FILE[kind])).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return null;
      throw e;
    }
  },
  async remove(sha) {
    try {
      await (await opfsRoot()).removeEntry(sha, { recursive: true });
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  },
  async clear() {
    await navigator.storage.getDirectory().then((r) => r.removeEntry('margin', { recursive: true })).catch(() => undefined);
  },
};

let backend: Promise<Backend> | undefined;

/** OPFS if it works (probed once with a real write), else IndexedDB. */
function pick(): Promise<Backend> {
  backend ??= (async () => {
    try {
      const probe = new Uint8Array([1]);
      await opfsBackend.put('.probe', 'annot', probe);
      await opfsBackend.remove('.probe');
      return opfsBackend;
    } catch {
      return idbBackend;
    }
  })();
  return backend;
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const storage = {
  /** Which backend is in use, for diagnostics. */
  async kind(): Promise<'opfs' | 'indexeddb'> {
    return (await pick()) === opfsBackend ? 'opfs' : 'indexeddb';
  },

  async savePdf(rec: Omit<DocRecord, 'modified'>, bytes: Uint8Array): Promise<void> {
    await (await pick()).put(rec.sha, 'pdf', bytes);
    await tx('docs', 'readwrite', (s) => s.put({ ...rec, modified: new Date().toISOString() }));
  },

  async loadPdf(sha: string): Promise<Uint8Array | null> {
    return (await pick()).get(sha, 'pdf');
  },

  async saveAnnotations(sha: string, text: string): Promise<void> {
    await (await pick()).put(sha, 'annot', encoder.encode(text));
    const rec = await tx<DocRecord | undefined>('docs', 'readonly', (s) => s.get(sha));
    if (rec) await tx('docs', 'readwrite', (s) => s.put({ ...rec, modified: new Date().toISOString() }));
  },

  async loadAnnotations(sha: string): Promise<string | null> {
    const bytes = await (await pick()).get(sha, 'annot');
    return bytes ? decoder.decode(bytes) : null;
  },

  async list(): Promise<DocRecord[]> {
    const all = await tx<DocRecord[]>('docs', 'readonly', (s) => s.getAll());
    return all.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  },

  async find(sha: string): Promise<DocRecord | undefined> {
    return tx<DocRecord | undefined>('docs', 'readonly', (s) => s.get(sha));
  },

  /** "Forget this document": deletes its PDF and annotations from browser storage. */
  async forget(sha: string): Promise<void> {
    await (await pick()).remove(sha);
    await tx('docs', 'readwrite', (s) => s.delete(sha));
  },

  /** "Clear all data": wipes everything the app stored in this origin. */
  async clearAll(): Promise<void> {
    await (await pick()).clear();
    await idbBackend.clear();
    await tx('docs', 'readwrite', (s) => s.clear());
    await tx('kv', 'readwrite', (s) => s.clear());
  },

  /** Small key-value settings, e.g. the default category set (spec §4). */
  async getSetting<T>(key: string): Promise<T | undefined> {
    return tx<T | undefined>('kv', 'readonly', (s) => s.get(key));
  },

  async setSetting(key: string, value: unknown): Promise<void> {
    await tx('kv', 'readwrite', (s) => s.put(value, key));
  },
};

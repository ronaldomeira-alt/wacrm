"use client";

/**
 * IndexedDB-backed store for voice notes that have been recorded but not
 * yet confirmed delivered by the server.
 *
 * Why this exists: on iOS Safari/WKWebView (PWA), a fetch that's in
 * flight when the app is backgrounded (screen lock, app switch) can be
 * suspended and never settle — neither resolving nor rejecting. Before
 * this, a recorded voice note only ever lived in a JS closure
 * (message-composer.tsx's old `finalizeRecording`), so if the upload
 * hung or the PWA was killed, the recording was gone for good and the
 * only way to unstick the UI was a full force-quit. Every recording is
 * now written here BEFORE any network call starts, and is only deleted
 * once the server has actually confirmed the WhatsApp send succeeded —
 * see pending-audio-sync.ts for the upload/send pipeline that reads and
 * updates these records.
 */

const DB_NAME = "wacrm-pending-audio";
const DB_VERSION = 1;
const STORE = "recordings";

export type PendingAudioStatus =
  | "uploading"
  | "uploaded"
  | "sending"
  | "failed-upload"
  | "failed-send";

export interface PendingAudioRecord {
  id: string;
  conversationId: string;
  replyToId?: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  status: PendingAudioStatus;
  /** Set once the storage upload succeeds. */
  mediaUrl?: string;
  path?: string;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("conversationId", "conversationId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function putPendingAudio(record: PendingAudioRecord): Promise<void> {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(record));
}

/** Merges `patch` into the stored record (if it still exists) and returns the result. */
export async function patchPendingAudio(
  id: string,
  patch: Partial<Omit<PendingAudioRecord, "id">>,
): Promise<PendingAudioRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as PendingAudioRecord | undefined;
      if (!existing) {
        resolve(null);
        return;
      }
      const updated: PendingAudioRecord = { ...existing, ...patch, updatedAt: Date.now() };
      store.put(updated);
      resolve(updated);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingAudio(id: string): Promise<PendingAudioRecord | null> {
  const result = await withStore<PendingAudioRecord | undefined>("readonly", (store) => store.get(id));
  return result ?? null;
}

export async function deletePendingAudio(id: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(id));
}

export async function listPendingAudioByConversation(
  conversationId: string,
): Promise<PendingAudioRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("conversationId").getAll(conversationId);
    req.onsuccess = () => resolve(req.result as PendingAudioRecord[]);
    req.onerror = () => reject(req.error);
  });
}

export async function listAllPendingAudio(): Promise<PendingAudioRecord[]> {
  return withStore<PendingAudioRecord[]>("readonly", (store) => store.getAll());
}

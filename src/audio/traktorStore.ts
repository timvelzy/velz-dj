/**
 * Persists the imported Traktor collection in IndexedDB so Tim only
 * imports collection.nml once — it survives page reloads.
 *
 * We store the plain track array (+ file name + timestamp); the
 * byFileName lookup map is rebuilt on load. Everything is JSON-safe,
 * no Blobs involved.
 */

import type { TraktorCollection, TraktorTrack } from './traktor';

const DB_NAME = 'velz-dj';
const STORE = 'traktor';
const KEY = 'collection';

interface StoredCollection {
  fileName: string;
  savedAt: string; // ISO
  tracks: TraktorTrack[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    } catch (e) {
      reject(e);
    }
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        let result: T;
        try {
          const req = fn(store);
          req.onsuccess = () => {
            result = req.result;
          };
          req.onerror = () => reject(req.error);
        } catch (e) {
          reject(e);
          return;
        }
        transaction.oncomplete = () => {
          db.close();
          resolve(result!);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      }),
  );
}

export async function saveTraktorCollection(
  collection: TraktorCollection,
  fileName: string,
): Promise<void> {
  const stored: StoredCollection = {
    fileName,
    savedAt: new Date().toISOString(),
    tracks: collection.tracks,
  };
  await tx('readwrite', (store) => store.put(stored, KEY));
}

export interface LoadedCollection {
  collection: TraktorCollection;
  fileName: string;
  savedAt: string;
}

export async function loadTraktorCollection(): Promise<LoadedCollection | null> {
  const stored = await tx<StoredCollection | undefined>('readonly', (store) => store.get(KEY));
  if (!stored || !Array.isArray(stored.tracks)) return null;
  const byFileName = new Map<string, TraktorTrack>();
  for (const t of stored.tracks) {
    if (t.fileName) byFileName.set(t.fileName.toLowerCase(), t);
  }
  return {
    collection: { tracks: stored.tracks, byFileName },
    fileName: stored.fileName,
    savedAt: stored.savedAt,
  };
}

export async function clearTraktorCollection(): Promise<void> {
  await tx('readwrite', (store) => store.delete(KEY));
}

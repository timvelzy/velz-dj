/**
 * IndexedDB cache for computed BandPeaks (Phase 4).
 *
 * Separate database from the Traktor collection store on purpose: peaks
 * are large typed arrays and version independently. A track's peaks are
 * computed once and reused on every later load of the same file.
 */

import type { BandPeaks } from '../types';

const DB_NAME = 'velz-dj-peaks';
const STORE = 'peaks';

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
          req.onsuccess = () => { result = req.result; };
          req.onerror = () => reject(req.error);
        } catch (e) {
          reject(e);
          return;
        }
        transaction.oncomplete = () => { db.close(); resolve(result!); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      }),
  );
}

export async function loadPeaks(key: string): Promise<BandPeaks | null> {
  try {
    const stored = await tx<BandPeaks | undefined>('readonly', (store) => store.get(key));
    if (!stored || !(stored.min instanceof Float32Array)) return null;
    return stored;
  } catch {
    return null;
  }
}

export async function savePeaks(key: string, peaks: BandPeaks): Promise<void> {
  try {
    await tx('readwrite', (store) => store.put(peaks, key));
  } catch (e) {
    console.warn('Could not cache peaks', e);
  }
}

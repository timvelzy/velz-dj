/**
 * Persistent track library (IndexedDB).
 *
 * Tim's ask: closing and reopening the site should bring his tracks back,
 * ready to load onto a deck, without re-picking files. localStorage is far
 * too small for audio and File System Access handles would re-prompt for
 * permission on every visit, so the audio itself is stored as a Blob here.
 *
 * One record per file, keyed by file identity (name + size + last
 * modified). The expensive analysis travels with the audio — beat grid,
 * spectral data, and band peaks when computed — so a restored track never
 * needs re-analysis: decode the blob and it plays with its grid intact.
 *
 * Separate database from the Traktor store and the peaks cache on purpose:
 * the library versions independently, and clearing it never touches the
 * Traktor collection. The peaks cache is left alone (a re-added file still
 * hits it); only this store is cleared by "Clear library".
 */

import type { BandPeaks, BeatGrid, SpectralData, TrackInfo } from '../types';

const DB_NAME = 'velz-dj-library';
const STORE = 'tracks';
const DB_VERSION = 1;

/** Stable identity for a file: same file re-added maps to the same record. */
export function fileKeyFor(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export interface StoredLibraryTrack {
  /** fileKeyFor(file) — the store's keyPath, so put() upserts per file. */
  fileKey: string;
  fileName: string;
  fileType: string;
  fileLastModified: number;
  title: string;
  artist: string;
  duration: number;
  bpm: number;
  key?: string;
  beatGrid: BeatGrid;
  spectralData?: SpectralData;
  peaks?: BandPeaks;
  savedAt: string; // ISO
  /** The audio itself. Stored as the picked File; read back as a Blob. */
  file: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'fileKey' });
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

/**
 * Build a storable record from an in-memory track. Returns null when the
 * track carries no file (nothing to persist — e.g. a generated AI loop,
 * which never enters the library).
 */
export function trackToRecord(track: TrackInfo): StoredLibraryTrack | null {
  if (!track.file || !track.fileKey) return null;
  return {
    fileKey: track.fileKey,
    fileName: track.file.name,
    fileType: track.file.type,
    fileLastModified: track.file.lastModified,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    bpm: track.bpm,
    key: track.key,
    beatGrid: track.beatGrid,
    spectralData: track.spectralData,
    peaks: track.peaks,
    savedAt: new Date().toISOString(),
    file: track.file,
  };
}

/**
 * Rebuild an in-memory track from a stored record. The audio Blob is
 * wrapped back into a File with its original name/type/timestamp so the
 * rest of the app (peaks cache keys, deck loading, file extension badges)
 * sees exactly what a freshly picked file looks like. Returns null for
 * records too damaged to use — the caller skips those instead of failing
 * the whole restore.
 */
export function recordToTrack(record: StoredLibraryTrack): TrackInfo | null {
  if (
    !record ||
    typeof record.fileKey !== 'string' ||
    !(record.file instanceof Blob) ||
    typeof record.title !== 'string' ||
    typeof record.duration !== 'number' ||
    !record.beatGrid ||
    typeof record.beatGrid.bpm !== 'number'
  ) {
    return null;
  }
  const file = new File([record.file], record.fileName || 'track', {
    type: record.fileType || record.file.type,
    lastModified: record.fileLastModified || Date.now(),
  });
  return {
    id: `lib-${record.fileKey}`,
    title: record.title,
    artist: record.artist || '',
    duration: record.duration,
    bpm: record.bpm,
    key: record.key,
    beatGrid: record.beatGrid,
    spectralData: record.spectralData,
    peaks: record.peaks,
    file,
    fileKey: record.fileKey,
    restored: true,
  };
}

/** Upsert one track. Throws on failure (quota etc.) — callers decide how to surface it. */
export async function saveLibraryRecord(track: TrackInfo): Promise<void> {
  const record = trackToRecord(track);
  if (!record) return;
  await tx('readwrite', (store) => store.put(record));
}

/** All saved tracks, oldest first. Skips damaged records instead of failing. */
export async function loadLibraryRecords(): Promise<TrackInfo[]> {
  const records = await tx<StoredLibraryTrack[]>('readonly', (store) => store.getAll());
  const tracks: TrackInfo[] = [];
  for (const record of records ?? []) {
    const track = recordToTrack(record);
    if (track) tracks.push(track);
    else console.warn('Skipping damaged saved library record', record?.fileKey);
  }
  tracks.sort((a, b) => a.title.localeCompare(b.title));
  return tracks;
}

export async function deleteLibraryRecord(fileKey: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(fileKey));
}

export async function clearLibraryRecords(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}

/**
 * Ask the browser to keep this origin's storage (library audio included)
 * instead of evicting it under pressure. Best-effort: unsupported browsers
 * just skip it, and a denial is not an error — the library still works.
 */
export async function requestLibraryPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch (e) {
    console.warn('Persistent storage request failed', e);
  }
  return false;
}

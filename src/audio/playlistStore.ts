/**
 * Saved autopilot playlists (IndexedDB).
 *
 * Tim's ask: set a playlist once, hit autopilot, and have it mix while he
 * works — across reloads, not just within one session. The queue itself
 * stays session-only; playlists are the durable object.
 *
 * Stored references are fileKeys (name|size|lastModified), NOT session
 * track ids: fresh tracks get `t<N>` ids that change every session, while
 * fileKeys are stable across reloads. At load time the playlist resolves
 * its fileKeys against the current library; missing tracks are skipped
 * gracefully (see resolvePlaylistTracks in autopilot.ts) and reported in
 * the UI — a missing track never breaks the queue.
 *
 * Separate database from the track library on purpose, mirroring the
 * library store's own pattern: clearing tracks never touches playlists.
 * No audio is duplicated here — only ordered references.
 */

const DB_NAME = 'velz-dj-playlists';
const STORE = 'playlists';
const DB_VERSION = 1;

export interface PlaylistRecord {
  /** Stable id (random UUID, or a timestamp fallback). */
  id: string;
  name: string;
  /** Ordered library fileKeys. */
  fileKeys: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export function newPlaylistId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    // Fall through to the timestamp id.
  }
  return `pl-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
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
 * Save a playlist. Upserts by name (case-insensitive): saving under an
 * existing name replaces that playlist's contents instead of piling up
 * duplicates. Returns the saved record.
 */
export async function savePlaylist(name: string, fileKeys: string[]): Promise<PlaylistRecord> {
  const clean = name.trim();
  if (!clean) throw new Error('Playlist name is empty');
  const existing = await loadPlaylists();
  const same = existing.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  const now = new Date().toISOString();
  const record: PlaylistRecord = same
    ? { ...same, fileKeys: [...fileKeys], updatedAt: now }
    : { id: newPlaylistId(), name: clean, fileKeys: [...fileKeys], createdAt: now, updatedAt: now };
  await tx('readwrite', (store) => store.put(record));
  return record;
}

/** All saved playlists, alphabetical by name. Skips damaged records. */
export async function loadPlaylists(): Promise<PlaylistRecord[]> {
  const records = await tx<PlaylistRecord[]>('readonly', (store) => store.getAll());
  const out: PlaylistRecord[] = [];
  for (const r of records ?? []) {
    if (r && typeof r.id === 'string' && typeof r.name === 'string' && Array.isArray(r.fileKeys)) {
      out.push(r);
    } else {
      console.warn('Skipping damaged saved playlist record', (r as { id?: unknown } | null)?.id);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Rename a playlist (name kept as typed; duplicates are allowed but the save upsert keeps the common case clean). */
export async function renamePlaylist(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error('Playlist name is empty');
  const all = await loadPlaylists();
  const rec = all.find((p) => p.id === id);
  if (!rec) return;
  await tx('readwrite', (store) => store.put({ ...rec, name: clean, updatedAt: new Date().toISOString() }));
}

/** Delete a playlist. Loading a deleted playlist later is impossible — the queue it fed keeps playing what it already holds. */
export async function deletePlaylist(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id));
}

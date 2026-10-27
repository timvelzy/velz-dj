/**
 * Persistent sampler pads (IndexedDB).
 *
 * Pads used to live only in memory: reload the page and every loaded
 * sample — and its trim, volume, and loop-arm state — was gone. That
 * also blocked the preloaded sampler pack (Tim's ask, 2026-10-27): seeds
 * need somewhere to live that survives a reload.
 *
 * One record per pad, keyed by pad index, in its OWN database separate
 * from the track library: clearing the track library never wipes the
 * pads, and vice versa. The encoded audio bytes are stored (an
 * AudioBuffer is not structured-cloneable, so it can never go into
 * IndexedDB directly); restore decodes the bytes in an
 * OfflineAudioContext and stages the buffer onto the pad before the
 * first user gesture creates the live AudioContext. Trim offsets,
 * volume, and the loop-arm flag travel with the sample record, so a
 * trimmed, loop-armed pad comes back exactly as it was left.
 *
 * Sampler seed provisioning is version-gated independently of the
 * track-library seeds: bumping one manifest never re-seeds the other.
 * Seeding only fills pads with NO saved record, so a pad the user
 * loaded, cleared, or replaced is never clobbered by a later seed run.
 */

const DB_NAME = 'velz-dj-sampler';
const STORE = 'pads';
const DB_VERSION = 1;

export interface StoredSamplerPad {
  /** Pad index 0..7 — the store's keyPath, so put() upserts per pad. */
  padIndex: number;
  name: string;
  /** Encoded audio bytes (uploaded file, WAV-encoded deck recording,
      or fetched seed bytes). Decoded on restore. */
  blob: Blob;
  volume: number; // 0..1
  trimStart: number; // seconds, absolute within the decoded buffer
  trimEnd: number; // seconds, absolute (full duration = untrimmed)
  /** Loop mode armed (repeats in sync when triggered). Armed only —
      nothing plays until the user taps the pad, a key, or MIDI. */
  loop: boolean;
  savedAt: string; // ISO
}

/** Bump when the sampler seed set or a seed file changes. */
export const SAMPLER_SEED_VERSION = 1;

const SAMPLER_SEED_VERSION_KEY = 'velz-dj:samplerSeedVersion';

export function getSamplerSeededVersion(): number {
  try {
    const raw = window.localStorage.getItem(SAMPLER_SEED_VERSION_KEY);
    return raw == null ? 0 : Number(raw) || 0;
  } catch {
    return 0;
  }
}

export function setSamplerSeededVersion(version: number): void {
  try {
    window.localStorage.setItem(SAMPLER_SEED_VERSION_KEY, String(version));
  } catch {
    /* private mode etc. — seeding just retries next visit */
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'padIndex' });
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

/** Upsert one pad. Throws on failure (quota etc.) — callers decide how to surface it. */
export async function saveSamplerPad(record: StoredSamplerPad): Promise<void> {
  if (record.padIndex < 0 || record.padIndex > 7) return;
  await tx('readwrite', (store) => store.put(record));
}

/** All saved pads, lowest index first. Skips damaged records instead of failing. */
export async function loadSamplerPads(): Promise<StoredSamplerPad[]> {
  const records = await tx<StoredSamplerPad[]>('readonly', (store) => store.getAll());
  const pads: StoredSamplerPad[] = [];
  for (const record of records ?? []) {
    if (
      record &&
      typeof record.padIndex === 'number' &&
      record.padIndex >= 0 &&
      record.padIndex <= 7 &&
      record.blob instanceof Blob &&
      typeof record.name === 'string'
    ) {
      pads.push(record);
    } else {
      console.warn('Skipping damaged saved sampler pad', record?.padIndex);
    }
  }
  pads.sort((a, b) => a.padIndex - b.padIndex);
  return pads;
}

export async function deleteSamplerPad(padIndex: number): Promise<void> {
  await tx('readwrite', (store) => store.delete(padIndex));
}

/**
 * Encode a decoded buffer as 16-bit PCM WAV bytes, for persisting deck
 * recordings (which have no original file). Interleaved stereo, 44.1kHz
 * or the buffer's own rate preserved — the WAV header carries the rate,
 * so decode reproduces the same buffer.
 */
export function encodeBufferToWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  const ch0 = buffer.getChannelData(0);
  const ch1 = channels > 1 ? buffer.getChannelData(1) : ch0;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, (c === 0 ? ch0 : ch1)[i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

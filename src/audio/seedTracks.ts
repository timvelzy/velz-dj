/**
 * Bundled Velz seed tracks for the library.
 *
 * Tim's ask (2026-10-27): the mixer should start with some of his own
 * tracks in the library, so a first-time visitor can load a Velz track
 * onto a deck without uploading anything. Library-only: decks stay
 * empty on startup and nothing auto-plays.
 *
 * Mechanism: three MP3s ship with the app under public/tracks/. On the
 * first visit (or the first visit after the manifest version bumps), each
 * missing seed is fetched once, decoded and analyzed with the exact same
 * analyzeTrack + detectKey path a fresh file upload takes — nothing is
 * hardcoded except the manifest's display metadata (title/artist, and
 * the ffprobe-verified durations used for the placeholder rows). The
 * analyzed result is saved as a normal library record, so later visits
 * restore it from IndexedDB like any uploaded track: no re-download,
 * no re-analysis, and load-to-deck goes through the existing
 * loadRestoredTrack path (decode only, stored grid).
 *
 * Versioning: the seed filenames carry the manifest version (v1), and
 * provisioning is gated on a localStorage marker. The service worker is
 * cache-first for same-origin GETs and matches with ignoreSearch, so a
 * query string would NOT bust it — a changed seed must ship under a new
 * versioned filename AND a bumped SEED_MANIFEST_VERSION, or existing
 * installs will keep fetching the stale cached bytes. The `group`
 * field exists so a future set (e.g. clearly-labeled example beats)
 * can follow this same mechanism under its own group without touching
 * the Velz release entries.
 *
 * Seed policy (deliberate, version-gated): seeds are ordinary library
 * records once saved — deletable per track, cleared by "Clear saved"
 * like uploads. A deleted seed does NOT come back on its own: it only
 * returns when SEED_MANIFEST_VERSION bumps. Clearing the library does
 * not restore seeds either, for the same reason — the marker, not the
 * record set, decides provisioning, so provisioning never surprises a
 * visitor who deliberately emptied their library.
 */

import { analyzeTrack } from './analysis';
import { detectKey } from './keydetect';
import { saveLibraryRecord } from './libraryStore';
import type { BeatGrid, TrackInfo } from '../types';

/** Bump when the seed set or a seed file changes. Resets provisioning. */
export const SEED_MANIFEST_VERSION = 1;

const SEED_VERSION_KEY = 'velz-dj:seedVersion';

export interface SeedTrackDef {
  /** Namespaced library identity — never collides with an upload's
      name|size|lastModified key. */
  fileKey: string;
  /** Bundled filename (also the File name inside the stored record). */
  fileName: string;
  title: string;
  artist: string;
  /** Relative URL under the app base (base './' keeps this working at
      a domain root or under a subpath). */
  url: string;
  /** ffprobe-verified duration in seconds — placeholder display only;
      the saved record carries the decoded buffer's duration. */
  duration: number;
  /** Verified from dj-games tracks.ts. Absent = unknown: analysis
      detects it, and nothing is hardcoded (Battery in the Red). */
  bpm?: number;
  /** Verified from dj-games tracks.ts. Absent = analysis detects it. */
  key?: string;
  /** 'velz' = Tim's own releases. A future example-beats set would use
      its own group and be labeled as examples in the UI. */
  group: 'velz';
}

const base = import.meta.env.BASE_URL;

export const SEED_TRACKS: SeedTrackDef[] = [
  {
    fileKey: 'seed|chlorine-v1',
    fileName: 'chlorine-v1.mp3',
    title: 'Chlorine and Dashboard Light',
    artist: 'Velz',
    url: `${base}tracks/chlorine-v1.mp3`,
    duration: 329.84,
    bpm: 123.0,
    key: '6B',
    group: 'velz',
  },
  {
    fileKey: 'seed|every-day-we-get-v1',
    fileName: 'every-day-we-get-v1.mp3',
    title: 'Every Day We Get',
    artist: 'Velz',
    url: `${base}tracks/every-day-we-get-v1.mp3`,
    duration: 329.6,
    bpm: 131.3,
    key: '2B',
    group: 'velz',
  },
  {
    fileKey: 'seed|battery-in-the-red-v1',
    fileName: 'battery-in-the-red-v1.mp3',
    title: 'Battery in the Red',
    artist: 'Velz',
    url: `${base}tracks/battery-in-the-red-v1.mp3`,
    duration: 222.0,
    group: 'velz',
  },
];

export function getSeededVersion(): number {
  try {
    const raw = window.localStorage.getItem(SEED_VERSION_KEY);
    return raw == null ? 0 : Number(raw) || 0;
  } catch {
    return 0;
  }
}

export function setSeededVersion(version: number): void {
  try {
    window.localStorage.setItem(SEED_VERSION_KEY, String(version));
  } catch {
    /* private mode etc. — seeding just retries next visit */
  }
}

/**
 * Metadata-only placeholder shown in the library while a seed is being
 * fetched and analyzed. It carries no file, so the library's load path
 * (which requires a file) safely no-ops if tapped early, and the BPM
 * cell shows the analysis progress via the existing `analyzing` UI.
 * The placeholder grid is never used for playback: the finished record
 * replaces this row wholesale.
 */
export function seedPlaceholder(def: SeedTrackDef): TrackInfo {
  const grid: BeatGrid = {
    bpm: def.bpm ?? 0,
    confidence: 0,
    downbeatOffset: -1,
    firstBeat: 0,
    tempoStability: 0,
    method: 'electronic',
    beats: [],
    bpmCurve: [],
  };
  return {
    id: `lib-${def.fileKey}`,
    title: def.title,
    artist: def.artist,
    duration: def.duration,
    bpm: def.bpm ?? 0,
    key: def.key,
    beatGrid: grid,
    fileKey: def.fileKey,
    restored: true,
    analyzing: true,
    analysisProgress: 0,
  };
}

export interface SeedCallbacks {
  onProgress: (fileKey: string, progress: number) => void;
  onReady: (track: TrackInfo) => void;
  onError: (fileKey: string, fileName: string, error: unknown) => void;
}

/**
 * Fetch, decode, analyze and save every seed whose fileKey is not in
 * `existingFileKeys`, one at a time (sequential: a full decode plus
 * several offline renders per track is the heaviest work this app does,
 * and parallel runs spike memory on small machines). Returns true when
 * every seed is present or was saved — the caller then records the
 * manifest version. Any failure returns false so provisioning retries
 * next visit; one bad seed never aborts the rest.
 *
 * Decoding uses an isolated OfflineAudioContext, never the live
 * playback context: no AudioContext is started, nothing is audible,
 * and no user gesture is needed.
 */
export async function runSeeding(
  existingFileKeys: Set<string>,
  callbacks: SeedCallbacks,
): Promise<boolean> {
  const decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  let allOk = true;
  for (const def of SEED_TRACKS) {
    if (existingFileKeys.has(def.fileKey)) continue;
    try {
      const res = await fetch(def.url);
      if (!res.ok) throw new Error(`fetch ${def.url} failed: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      // decodeAudioData detaches its input, so decode a copy and keep
      // the original bytes for the stored File.
      const buffer = await decodeCtx.decodeAudioData(bytes.slice(0));
      const { grid, spectralData } = await analyzeTrack(buffer, (p) => callbacks.onProgress(def.fileKey, p));
      const keyRes = detectKey(buffer);
      const file = new File([bytes], def.fileName, { type: 'audio/mpeg', lastModified: Date.now() });
      const track: TrackInfo = {
        id: `lib-${def.fileKey}`,
        title: def.title,
        artist: def.artist,
        duration: buffer.duration,
        bpm: grid.bpm,
        key: keyRes.key,
        beatGrid: grid,
        spectralData,
        file,
        fileKey: def.fileKey,
        restored: true,
      };
      await saveLibraryRecord(track);
      callbacks.onReady(track);
    } catch (e) {
      console.warn('Seed track failed', def.title, e);
      allOk = false;
      callbacks.onError(def.fileKey, def.fileName, e);
    }
  }
  return allOk;
}

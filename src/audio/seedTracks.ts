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
 * versioned filename AND a bumped manifest version, or existing
 * installs will keep fetching the stale cached bytes.
 *
 * Two independent seed groups share this mechanism, each with its own
 * manifest version and marker, so bumping one never re-seeds the other:
 * 'velz' (Tim's own releases, SEED_MANIFEST_VERSION) and 'loops'
 * (clearly-labeled Gemini-generated example loops from the Midnight
 * Concrete file, LOOP_SEED_MANIFEST_VERSION). The `group` field on each
 * def is what the library badge reads.
 *
 * Seed policy (deliberate, version-gated): seeds are ordinary library
 * records once saved — deletable per track, cleared by "Clear saved"
 * like uploads. A deleted seed does NOT come back on its own: it only
 * returns when its group's manifest version bumps. Clearing the library
 * does not restore seeds either, for the same reason — the marker, not
 * the record set, decides provisioning, so provisioning never surprises
 * a visitor who deliberately emptied their library.
 */

import { analyzeTrack } from './analysis';
import { detectKey } from './keydetect';
import { saveLibraryRecord } from './libraryStore';
import type { BeatGrid, TrackInfo } from '../types';

/** Bump when the seed set or a seed file changes. Resets provisioning. */
export const SEED_MANIFEST_VERSION = 1;

/** Bump when the loop seed set or a loop file changes. Independent of
    SEED_MANIFEST_VERSION: bumping one never re-seeds the other. */
export const LOOP_SEED_MANIFEST_VERSION = 1;

const SEED_VERSION_KEY = 'velz-dj:seedVersion';
const LOOP_SEED_VERSION_KEY = 'velz-dj:loopSeedVersion';

function getVersion(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? 0 : Number(raw) || 0;
  } catch {
    return 0;
  }
}

function setVersion(key: string, version: number): void {
  try {
    window.localStorage.setItem(key, String(version));
  } catch {
    /* private mode etc. — seeding just retries next visit */
  }
}

export function getSeededVersion(): number {
  return getVersion(SEED_VERSION_KEY);
}

export function setSeededVersion(version: number): void {
  setVersion(SEED_VERSION_KEY, version);
}

export function getLoopSeededVersion(): number {
  return getVersion(LOOP_SEED_VERSION_KEY);
}

export function setLoopSeededVersion(version: number): void {
  setVersion(LOOP_SEED_VERSION_KEY, version);
}

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
  /** Display-only BPM for placeholder rows. Velz seeds: verified from
      dj-games tracks.ts. Loop seeds: measured 123.0 grid (see the split
      README). Absent = unknown: analysis detects it, and nothing is
      hardcoded (Battery in the Red). */
  bpm?: number;
  /** Verified from dj-games tracks.ts. Absent = analysis detects it. */
  key?: string;
  /** 'velz' = Tim's own releases. 'loops' = Gemini-generated example
      loops (Midnight Concrete file) — labeled as examples in the UI,
      never as Velz releases. */
  group: 'velz' | 'loops';
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

/**
 * Example loops from the Gemini-generated "Midnight Concrete" file,
 * split into 8 loops (see ~/workspace/mixer-loops/midnight-concrete/).
 * These are NOT Velz releases: the artist credit says so, the library
 * shows an EXAMPLE LOOP badge, and the same 8 files seed the sampler
 * pads (loop mode armed). Durations are the exact split-file durations
 * (ffprobe-verified); BPM 123.0 is the measured grid for all 8 segments
 * (onset-autocorrelation, high confidence — see the split README),
 * placeholder display only; saved records carry the analyzed grid.
 */
export const LOOP_SEEDS: SeedTrackDef[] = [
  {
    fileKey: 'seed|mc-01-tech-house-groove-v1',
    fileName: 'mc-01-tech-house-groove-v1.mp3',
    title: 'Midnight Concrete: Tech House Groove',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-01-tech-house-groove-v1.mp3`,
    duration: 15.7,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-02-underground-techno-v1',
    fileName: 'mc-02-underground-techno-v1.mp3',
    title: 'Midnight Concrete: Underground Techno',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-02-underground-techno-v1.mp3`,
    duration: 15.64,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-03-dnb-halftime-v1',
    fileName: 'mc-03-dnb-halftime-v1.mp3',
    title: 'Midnight Concrete: DnB / Halftime',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-03-dnb-halftime-v1.mp3`,
    duration: 15.74,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-04-energetic-breakbeat-v1',
    fileName: 'mc-04-energetic-breakbeat-v1.mp3',
    title: 'Midnight Concrete: Energetic Breakbeat',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-04-energetic-breakbeat-v1.mp3`,
    duration: 13.92,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-05-deep-house-v1',
    fileName: 'mc-05-deep-house-v1.mp3',
    title: 'Midnight Concrete: Deep House',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-05-deep-house-v1.mp3`,
    duration: 15.78,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-06-peak-time-techno-v1',
    fileName: 'mc-06-peak-time-techno-v1.mp3',
    title: 'Midnight Concrete: Peak-Time Techno',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-06-peak-time-techno-v1.mp3`,
    duration: 15.72,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-07-rolling-tech-house-v1',
    fileName: 'mc-07-rolling-tech-house-v1.mp3',
    title: 'Midnight Concrete: Rolling Tech House',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-07-rolling-tech-house-v1.mp3`,
    duration: 15.5,
    bpm: 123.0,
    group: 'loops',
  },
  {
    fileKey: 'seed|mc-08-gritty-breakbeat-v1',
    fileName: 'mc-08-gritty-breakbeat-v1.mp3',
    title: 'Midnight Concrete: Gritty Breakbeat',
    artist: 'Example loop (Gemini)',
    url: `${base}tracks/mc-08-gritty-breakbeat-v1.mp3`,
    duration: 31.22,
    bpm: 123.0,
    group: 'loops',
  },
];

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
    seedGroup: def.group,
  };
}

export interface SeedCallbacks {
  onProgress: (fileKey: string, progress: number) => void;
  onReady: (track: TrackInfo) => void;
  onError: (fileKey: string, fileName: string, error: unknown) => void;
}

/**
 * Fetch, decode, analyze and save every seed in `defs` whose fileKey is
 * not in `existingFileKeys`, one at a time (sequential: a full decode
 * plus several offline renders per track is the heaviest work this app
 * does, and parallel runs spike memory on small machines). Returns true
 * when every seed is present or was saved — the caller then records
 * the group's manifest version. Any failure returns false so
 * provisioning retries next visit; one bad seed never aborts the rest.
 *
 * Decoding uses an isolated OfflineAudioContext, never the live
 * playback context: no AudioContext is started, nothing is audible,
 * and no user gesture is needed.
 */
export async function runSeeding(
  existingFileKeys: Set<string>,
  callbacks: SeedCallbacks,
  defs: SeedTrackDef[] = SEED_TRACKS,
): Promise<boolean> {
  const decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  let allOk = true;
  for (const def of defs) {
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
        seedGroup: def.group,
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

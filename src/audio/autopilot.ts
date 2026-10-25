// ─── AI DJ autopilot helpers (pure, no audio I/O) ─────────────────────────
// Transition selection + timing math for the autopilot driver in App.tsx.
// Kept pure so the state machine can be reasoned about (and tested) without
// an AudioContext.

import type { BeatGrid, TrackInfo } from '../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Seconds per bar for a grid (flat-BPM fallback when no beat map). */
export function barSeconds(grid: BeatGrid): number {
  return grid.bpm > 0 ? (4 * 60) / grid.bpm : 2;
}

/**
 * Where the outro blend should start: the beat-map time `bars` bars before
 * the last mapped beat, or `bars` bars before the track end on the flat
 * grid when no usable map exists. Clamped so a very short track still
 * leaves room for a blend.
 */
export function outroStartSeconds(grid: BeatGrid, duration: number, bars: number): number {
  const barSec = barSeconds(grid);
  if (grid.beats.length >= 2) {
    const idx = grid.beats.length - 1 - 4 * bars;
    if (idx >= 0) return grid.beats[idx];
  }
  return clamp(duration - bars * barSec, 0, Math.max(0, duration - barSec));
}

/** Whole bars remaining until the outro starts (for the status display). */
export function barsToOutro(grid: BeatGrid, duration: number, posSec: number, bars: number): number {
  const start = outroStartSeconds(grid, duration, bars);
  return Math.max(0, Math.ceil((start - posSec) / barSeconds(grid)));
}

/**
 * Audio time when a deck at (posBase, posBaseTime) advancing at posRate
 * reaches targetPos. Pure math behind engine.audioTimeAtTrackPos — the
 * driver schedules blends against audio time, never wall-clock time.
 */
export function audioTimeAtPos(
  posBase: number,
  posBaseTime: number,
  posRate: number,
  targetPos: number,
): number {
  return posBaseTime + (targetPos - posBase) / posRate;
}

/** Equal-power crossfader gain curves from fromV to toV (mirrors the engine's scheduled curve). */
export function equalPowerCurve(
  fromV: number,
  toV: number,
  points = 128,
): { a: Float32Array; b: Float32Array } {
  const gains = (v: number): [number, number] => {
    const angle = ((clamp(v, -1, 1) + 1) / 2) * (Math.PI / 2);
    return [Math.cos(angle), Math.sin(angle)];
  };
  const a = new Float32Array(points);
  const b = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const v = fromV + (toV - fromV) * (i / (points - 1));
    const [ga, gb] = gains(v);
    a[i] = ga;
    b[i] = gb;
  }
  return { a, b };
}

/** Linear dB ramp curve (mirrors the engine's scheduled EQ curve). */
export function dbRampCurve(fromDb: number, toDb: number, points = 64): Float32Array {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) c[i] = fromDb + (toDb - fromDb) * (i / (points - 1));
  return c;
}

/** EQ knob value → dB, same mapping as the engine (knob −1 = −26 dB cut). */
export const knobToDb = (knob: number): number => clamp(knob, -1, 1) * 26;

/**
 * Resolve a saved playlist's fileKeys against the current library.
 * fileKeys are stable across reloads (session track ids are not), so this
 * is what makes a playlist survive close/reopen. Tracks no longer in the
 * library are skipped gracefully — the caller reports the missing count
 * in the UI, never breaks the queue.
 */
export function resolvePlaylistTracks(
  fileKeys: string[],
  tracks: TrackInfo[],
): { found: TrackInfo[]; missing: number } {
  const byKey = new Map<string, TrackInfo>();
  for (const t of tracks) if (t.fileKey) byKey.set(t.fileKey, t);
  const found: TrackInfo[] = [];
  let missing = 0;
  for (const k of fileKeys) {
    const t = byKey.get(k);
    if (t && t.file) found.push(t);
    else missing++;
  }
  return { found, missing };
}

// ─── Camelot key compatibility ────────────────────────────────────────────

interface Camelot {
  num: number;
  letter: 'A' | 'B';
}

function parseCamelot(key?: string): Camelot | null {
  if (!key) return null;
  const m = /^(\d{1,2})([AB])$/i.exec(key.trim());
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1 || num > 12) return null;
  return { num, letter: m[2].toUpperCase() as 'A' | 'B' };
}

/** 2 = same key, 1 = harmonically compatible, 0 = clash or unknown. */
export function camelotScore(a?: string, b?: string): number {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 0;
  if (ka.num === kb.num && ka.letter === kb.letter) return 2;
  if (ka.num === kb.num) return 1; // relative major/minor
  const up = ka.num === 12 ? 1 : ka.num + 1;
  const down = ka.num === 1 ? 12 : ka.num - 1;
  if (ka.letter === kb.letter && (kb.num === up || kb.num === down)) return 1;
  return 0;
}

// ─── Next-track selection ─────────────────────────────────────────────────

export interface PickArgs {
  tracks: TrackInfo[];
  playing: TrackInfo | null;
  queueIds: string[];
  recentIds: string[];
  onDeckIds: string[];
  failedIds: string[];
}

export interface PickResult {
  track: TrackInfo;
  fromQueue: boolean;
}

/**
 * Queue first, then auto-pick. Queue entries are explicit — they win even
 * over recently played tracks — but never the track already playing or
 * loaded on a deck. Auto-pick scores Camelot compatibility first, then
 * tempo closeness, within a ±10% tempo window, skipping recently played
 * tracks and anything already on a deck. Returns null when nothing fits.
 */
export function pickNextTrack(a: PickArgs): PickResult | null {
  const onDeck = new Set(a.onDeckIds);
  const failed = new Set(a.failedIds);
  for (const id of a.queueIds) {
    const t = a.tracks.find((x) => x.id === id);
    if (!t || !t.file) continue;
    if (failed.has(t.id) || onDeck.has(t.id)) continue;
    if (a.playing && t.id === a.playing.id) continue;
    return { track: t, fromQueue: true };
  }
  const recent = new Set(a.recentIds);
  const playingBpm = a.playing?.bpm ?? 0;
  let best: TrackInfo | null = null;
  let bestKey = -1;
  let bestTempo = -1;
  for (const t of a.tracks) {
    if (!t.file || t.duration < 45) continue;
    if (failed.has(t.id) || onDeck.has(t.id) || recent.has(t.id)) continue;
    if (a.playing && t.id === a.playing.id) continue;
    let tempoScore = 0.5; // no playing BPM to compare against — key decides
    if (playingBpm > 0 && t.bpm > 0) {
      const ratio = t.bpm / playingBpm;
      if (ratio < 0.9 || ratio > 1.1) continue; // outside the sane window
      tempoScore = 1 - Math.min(1, Math.abs(ratio - 1) / 0.1);
    }
    const keyScore = camelotScore(a.playing?.key, t.key);
    if (keyScore > bestKey || (keyScore === bestKey && tempoScore > bestTempo)) {
      best = t;
      bestKey = keyScore;
      bestTempo = tempoScore;
    }
  }
  return best ? { track: best, fromQueue: false } : null;
}

// ─── Bass envelope ("read the track") ─────────────────────────────────────

/** Low-band energy envelope at 100 values/sec (peaks or spectral data). */
export interface BassEnvelope {
  data: Float32Array;
  rate: number;
}

export function trackBassEnvelope(t: TrackInfo | null | undefined): BassEnvelope | null {
  if (!t) return null;
  if (t.peaks) return { data: t.peaks.low, rate: t.peaks.rate };
  if (t.spectralData) return { data: t.spectralData.low, rate: 100 };
  return null;
}

function envAt(env: BassEnvelope, timeSec: number): number {
  const i = clamp(Math.floor(timeSec * env.rate), 0, env.data.length - 1);
  return env.data[i] ?? 0;
}

/** Mean low energy over a ±0.25s window (smooths single-beat spikes). */
function envWindow(env: BassEnvelope, timeSec: number): number {
  let sum = 0;
  let n = 0;
  for (let t = timeSec - 0.25; t <= timeSec + 0.25; t += 0.1) {
    sum += envAt(env, t);
    n++;
  }
  return n ? sum / n : 0;
}

function p90(data: Float32Array): number {
  if (!data.length) return 0;
  const step = Math.max(1, Math.floor(data.length / 2000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) sample.push(data[i]);
  sample.sort((x, y) => x - y);
  return sample[Math.floor(sample.length * 0.9)] ?? 0;
}

/**
 * Is the bass "present" at this track position (sustained low energy above
 * 40% of the track's own 90th-percentile low) or "absent" (below 25%)?
 * Per-track normalization is what makes this work across quiet masters and
 * loud ones alike.
 */
export function bassState(
  env: BassEnvelope | null,
  timeSec: number,
): 'present' | 'absent' | 'unknown' {
  if (!env) return 'unknown';
  const ref = p90(env.data);
  if (ref <= 0) return 'unknown';
  const v = envWindow(env, timeSec);
  if (v >= 0.4 * ref) return 'present';
  if (v <= 0.25 * ref) return 'absent';
  return 'unknown';
}

/**
 * The bass-swap moment inside a blend: the outgoing track's bass has
 * dropped out AND the incoming track's bass is present. Unknown envelopes
 * never fire the swap — the driver then falls back to swapping at blend
 * end (same one-bass rule, just not track-read).
 */
export function swapReady(
  outEnv: BassEnvelope | null,
  outPos: number,
  inEnv: BassEnvelope | null,
  inPos: number,
): boolean {
  return (
    bassState(outEnv, outPos) === 'absent' && bassState(inEnv, inPos) === 'present'
  );
}

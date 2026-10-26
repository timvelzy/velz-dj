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
  /**
   * Round 9 — true when this pick came from least-recently-played
   * cycling (tempo window ignored): the set must keep progressing
   * past an exhausted library instead of stalling in a hold loop.
   */
  cycled?: boolean;
}

/**
 * Queue first, then auto-pick. Queue entries are explicit — they win even
 * over recently played tracks — but never the track already playing or
 * loaded on a deck. Auto-pick scores Camelot compatibility first, then
 * tempo closeness, within a ±10% tempo window, skipping recently played
 * tracks and anything already on a deck. Returns null when nothing fits.
 *
 * Round 9 — least-recently-played cycling (Tim's bar: set it and forget
 * it, continual music, never stall). When queue and auto-pick both find
 * nothing — the 3-track case where the only unplayed track sits outside
 * the tempo window, or every track has already played — repeat the
 * library least-recent first instead of falling to a hold loop: the
 * track whose last play is oldest (never-played first), skipping only
 * the playing track, on-deck tracks, and failed loads. The tempo window
 * is deliberately ignored here — sync carries the tempo jump, and a
 * tempo-distant next track beats an endless outro loop. Ties among
 * never-played tracks break on Camelot, then tempo closeness. A null
 * return now means the library is genuinely empty of playable tracks
 * (one track, all failed, or all on decks) — the only case where the
 * hold loop is the correct steady state.
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
  if (best) return { track: best, fromQueue: false };
  // Cycling: last occurrence in recentIds wins the rank (recents are
  // appended in play order, so a higher index played more recently);
  // never-played (or evicted from the window) ranks -1, i.e. first.
  const lastPlayed = new Map<string, number>();
  a.recentIds.forEach((id, i) => lastPlayed.set(id, i));
  let cycled: TrackInfo | null = null;
  let cycledRank = Infinity;
  let cycledKey = -1;
  let cycledTempo = -1;
  for (const t of a.tracks) {
    if (!t.file || t.duration < 45) continue;
    if (failed.has(t.id) || onDeck.has(t.id)) continue;
    if (a.playing && t.id === a.playing.id) continue;
    const rank = lastPlayed.has(t.id) ? lastPlayed.get(t.id)! : -1;
    let tempoScore = 0.5;
    if (playingBpm > 0 && t.bpm > 0) {
      tempoScore = 1 - Math.min(1, Math.abs(t.bpm / playingBpm - 1));
    }
    const keyScore = camelotScore(a.playing?.key, t.key);
    if (
      rank < cycledRank ||
      (rank === cycledRank &&
        (keyScore > cycledKey || (keyScore === cycledKey && tempoScore > cycledTempo)))
    ) {
      cycled = t;
      cycledRank = rank;
      cycledKey = keyScore;
      cycledTempo = tempoScore;
    }
  }
  return cycled ? { track: cycled, fromQueue: false, cycled: true } : null;
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

// ─── Smart mix-in planning (round 6) ─────────────────────────────────────
// Tim's DJ technique, done by measurement instead of hearing: look at the
// incoming track's waveform/beat grid, find where its kick drums come in,
// start it so its intro plays over the outgoing track's outro, and switch
// the basslines at the phrase where the incoming drop arrives and the
// outgoing energy dips. Everything below is pure planning over the two
// tracks' existing analysis — no new detection, no guessing.
//
// The mix-in cue is the incoming track's first sustained kick bar: the
// analysis auto-1.1 anchor (auto hotcue slot 1), or a manual hotcue-1 edit
// when the DJ set one. The driver resolves manual-over-auto before it
// calls planTransition (deck-state hotcues), so the plan just reads slot 1.
//
// Four modes, picked per transition in this order:
//   1. fallback — either grid is below the codebase's own confidence line
//      (round 5's LOCKED threshold, 0.4) or the cue data is missing: the
//      driver runs today's outro-bars + bass-threshold behavior exactly.
//   2. extend — the incoming intro (bars from track start to the first
//      sustained kick) is SHORTER than the desired blend window: loop a
//      4-bar phrase at the mix-in cue region to manufacture room, then
//      loop-out into the drop. Complement of sustain, not the same thing.
//   3. sustain — the incoming intro is LONG and the outgoing ending would
//      otherwise lose energy during it (thin outro, or the outgoing track
//      simply ends first): loop the outgoing track's last high-energy
//      phrase (the 4 bars before its outro point) while the full incoming
//      intro plays over it, then release as the drop arrives.
//   4. tease — room is plentiful: loop the incoming track's 4 bars before
//      its first kick during the outgoing track's second-drop area (after
//      its breakdown), then loop-out exactly into the drop while the
//      outgoing fades. Fun/tension, only when it fits.
//   5. straight — the default: phrase-aligned launch (the first-kick bar
//      lands on a bar boundary of the outgoing track) with a whole-phrase
//      blend, and the bass switched structurally at the drop.
// The bass switch point is the first kick (slot 1, where the incoming kick
// and bass fully arrive), NOT the analyzer's later "first drop" rise
// (slot 2) — slot 2 usually falls after the blend, so switching there
// would never fire inside the window. The outgoing side of the switch is
// its outro point (slot 4) or its bass dropping out, whichever the driver
// can read first.

import { barPhaseOf } from './loop';

/** Round 5's own confidence line for "this grid can be trusted". */
export const SMART_MIN_CONFIDENCE = 0.4;
/** Whole-phrase blend lengths (bars); the Outro control overrides when set to one of these. */
export const SMART_BLEND_PHRASES = [8, 16, 32];
export const SMART_DEFAULT_BLEND_BARS = 16;
/** Tease loop length + how long the tease runs before the blend begins (bars). */
export const TEASE_LOOP_BARS = 4;
export const TEASE_BARS = 16;
/** Extend loop length (bars) and the release fade after a tease (bars). */
export const EXTEND_LOOP_BARS = 4;
export const TEASE_RELEASE_FADE_BARS = 4;
/** Straight blends run the phrase length plus this tail, so the drop lands over the fading outgoing. */
export const STRAIGHT_TAIL_BARS = 2;
/** Sustain only bridges intros up to this many bars — longer than that, slice it like straight. */
export const SUSTAIN_MAX_INTRO_BARS = 32;
/** Outro counts as "thin" when its mean low energy is below this fraction of the track's own p90. */
export const OUTRO_THIN_RATIO = 0.35;

export type SmartMode = 'fallback' | 'straight' | 'tease' | 'extend' | 'sustain';

export interface SmartPlan {
  mode: SmartMode;
  /** Incoming first sustained kick bar (mix-in cue / drop point), seconds. */
  firstKick: number | null;
  /** Outgoing outro point (hotcue slot 4), seconds. */
  outOutro: number | null;
  /** Blend length in whole phrases (bars). */
  blendBars: number;
  /** Incoming start offset for the blend launch (straight/extend/sustain; tease uses teaseLoopStart). */
  launchPos: number;
  /** Outgoing position where the blend begins (straight/extend). */
  blendStartOut: number | null;
  /** Crossfader length in bars (straight: phrases + tail; extend: phrases; tease: release fade; sustain: intro). */
  blendSecBars: number;
  /** Tease: outgoing position where the incoming loop launches. */
  teaseStart: number | null;
  teaseLoopStart: number | null;
  teaseLoopEnd: number | null;
  /** Tease: outgoing position where the loop releases into the drop. */
  outBlendStart: number | null;
  extendLoopStart: number | null;
  extendLoopEnd: number | null;
  sustainStart: number | null;
  sustainEnd: number | null;
  /** Outgoing position the waiting tick watches for this plan's trigger. */
  triggerPos: number;
  /** Status-strip text (null for fallback — today's display is unchanged there). */
  note: string | null;
}

export interface SmartPlanInput {
  out: TrackInfo;
  in: TrackInfo;
  /** Deck-state hotcues (manual wins per slot, else auto) for both tracks. */
  outHotcues: (number | null)[];
  inHotcues: (number | null)[];
  /** Outgoing position at plan time (seconds). */
  outPos: number;
  /** The Outro-bars control value. */
  outroBars: number;
}

/** Last beat-map index at or before `t` whose residue marks a downbeat, or -1. */
function downbeatIndexAtOrBefore(grid: BeatGrid, t: number): number {
  const beats = grid.beats;
  if (beats.length === 0) return -1;
  const phase = barPhaseOf(grid);
  let lo = 0;
  let hi = beats.length - 1;
  let j = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) { j = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  while (j >= 0 && (((j - phase) % 4) + 4) % 4 !== 0) j--;
  return j;
}

/** Last downbeat time at or before `t`, or null when the grid has no downbeat there. */
export function downbeatAtOrBefore(grid: BeatGrid, t: number): number | null {
  const j = downbeatIndexAtOrBefore(grid, t);
  return j >= 0 ? grid.beats[j] : null;
}

/** First downbeat time at or after `t`, or null. */
export function downbeatAtOrAfter(grid: BeatGrid, t: number): number | null {
  const beats = grid.beats;
  if (beats.length === 0) return null;
  const phase = barPhaseOf(grid);
  let lo = 0;
  let hi = beats.length - 1;
  let j = beats.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else { j = mid; hi = mid - 1; }
  }
  while (j < beats.length && (((j - phase) % 4) + 4) % 4 !== 0) j++;
  return j < beats.length ? beats[j] : null;
}

/** First downbeat at or after track start, or null. */
export function firstDownbeat(grid: BeatGrid): number | null {
  return downbeatAtOrAfter(grid, 0);
}

/** Downbeat `bars` bars before time `t` (t itself should be a downbeat), or null if it does not fit. */
export function downbeatBarsBefore(grid: BeatGrid, t: number, bars: number): number | null {
  const j = downbeatIndexAtOrBefore(grid, t);
  if (j < 0) return null;
  const k = j - bars * 4;
  return k >= 0 ? grid.beats[k] : null;
}

/** Downbeat `bars` bars after time `t` (t itself should be a downbeat), or null if the map runs out. */
export function downbeatBarsAfter(grid: BeatGrid, t: number, bars: number): number | null {
  const j = downbeatIndexAtOrBefore(grid, t);
  if (j < 0) return null;
  const k = j + bars * 4;
  return k < grid.beats.length ? grid.beats[k] : null;
}

/** Mean low energy over [t0, t1] as a fraction of the track's own p90, or null with no envelope. */
function outroLowRatio(out: TrackInfo, t0: number, t1: number): number | null {
  const env = trackBassEnvelope(out);
  if (!env || env.data.length === 0) return null;
  const ref = p90(env.data);
  if (ref <= 0) return null;
  let sum = 0;
  let n = 0;
  for (let t = t0; t <= t1; t += 0.25) {
    sum += envAt(env, t);
    n++;
  }
  if (!n) return null;
  return sum / n / ref;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ─── Fallback hold loop (round 7) ─────────────────────────────────────
// The no-candidate safety net. NEVER a span from a detected outro point
// to track end: that is how a 62-second loop to a dead tail happened —
// the loop played through the track's own fade-out, then wrapped.
// A hold loop is a short, musical, bar-snapped phrase: 8 bars by
// default, hard-capped at 16, ending at least one bar short of track
// end, and placed so the playhead reaches it naturally when possible.
export const HOLD_LOOP_BARS = 8;
export const HOLD_LOOP_MAX_BARS = 16;

export interface HoldLoop {
  start: number;
  end: number;
  /** True when the playhead is already past the loop end and must jump back into it. */
  jump: boolean;
}

/**
 * Pick the hold loop for a track with no next candidate. Prefers the
 * outro-anchored phrase when it still lies ahead of the playhead, else
 * the final phrase before the end cap. Only when the playhead is already
 * past every candidate end (last bar of the track) does the caller need
 * to jump back into it (jump: true). Length is capped by construction:
 * exactly HOLD_LOOP_BARS from the snap, never over HOLD_LOOP_MAX_BARS.
 */
export function holdLoopFor(
  track: TrackInfo,
  hotcues: (number | null)[],
  posSec: number,
): HoldLoop | null {
  const grid = track.beatGrid;
  const dur = track.duration;
  if (!grid || grid.bpm <= 0 || dur <= 0) return null;
  const barSec = barSeconds(grid);
  if (dur < 2 * barSec) return null;
  // Loop end must sit at least one bar short of track end (the boundary
  // hazard: a loop ending at file end plays the dead tail, then wraps).
  const endCap = downbeatAtOrBefore(grid, dur - barSec) ?? Math.max(0, dur - barSec);
  if (endCap <= 0) return null;
  const outro = hotcues[3];
  const outroEnd = outro != null ? (downbeatAtOrBefore(grid, outro) ?? outro) : null;
  const end =
    outroEnd != null && outroEnd > posSec + barSec && outroEnd <= endCap ? outroEnd : endCap;
  const jump = posSec >= end;
  let start = downbeatBarsBefore(grid, end, HOLD_LOOP_BARS) ?? (end - HOLD_LOOP_BARS * barSec);
  // Hard cap, whatever the snap did.
  if (end - start > HOLD_LOOP_MAX_BARS * barSec) start = end - HOLD_LOOP_MAX_BARS * barSec;
  if (start < 0) start = firstDownbeat(grid) ?? 0;
  if (end <= start) return null;
  return { start, end, jump };
}

const FALLBACK_PLAN: SmartPlan = {
  mode: 'fallback',
  firstKick: null,
  outOutro: null,
  blendBars: SMART_DEFAULT_BLEND_BARS,
  launchPos: 0,
  blendStartOut: null,
  blendSecBars: 0,
  teaseStart: null,
  teaseLoopStart: null,
  teaseLoopEnd: null,
  outBlendStart: null,
  extendLoopStart: null,
  extendLoopEnd: null,
  sustainStart: null,
  sustainEnd: null,
  triggerPos: 0,
  note: null,
};

/**
 * Pick the mix-in mode + all launch/blend geometry for one transition.
 * Pure: the driver calls it once per cycle when the next track arms, and
 * the plan then drives the waiting tick's triggers. Never throws — any
 * missing data degrades to the fallback plan (today's behavior).
 */
export function planTransition(a: SmartPlanInput): SmartPlan {
  const outGrid = a.out.beatGrid;
  const inGrid = a.in.beatGrid;
  const conf = (g: BeatGrid | null | undefined): number =>
    g && typeof g.confidence === 'number' ? g.confidence : 0;
  if (
    !outGrid || !inGrid || outGrid.bpm <= 0 || inGrid.bpm <= 0 ||
    a.out.duration <= 0 || a.in.duration <= 0 ||
    conf(outGrid) < SMART_MIN_CONFIDENCE || conf(inGrid) < SMART_MIN_CONFIDENCE
  ) {
    return { ...FALLBACK_PLAN };
  }
  // Mix-in cue: manual hotcue 1 wins (deck-state resolution), else the
  // analysis anchor/downbeat, else the first mapped beat. Without it
  // there is nothing smart to aim at — fall back, no guessing.
  // Both cue points snap to their bar's downbeat: a manual cue can sit
  // mid-bar, and every loop boundary, launch offset, and switch point
  // below must sit on a barline or the phrase math drifts.
  const firstKickRaw =
    a.inHotcues[0] ?? firstDownbeat(inGrid) ?? inGrid.beats[0] ?? null;
  if (firstKickRaw == null || firstKickRaw < 0 || firstKickRaw >= a.in.duration) {
    return { ...FALLBACK_PLAN };
  }
  const firstKick =
    downbeatAtOrBefore(inGrid, firstKickRaw) ??
    downbeatAtOrAfter(inGrid, firstKickRaw) ??
    firstKickRaw;
  const outOutroRaw = a.outHotcues[3] ?? null;
  const outOutro =
    outOutroRaw == null
      ? null
      : (downbeatAtOrBefore(outGrid, outOutroRaw) ??
        downbeatAtOrAfter(outGrid, outOutroRaw) ??
        outOutroRaw);
  const outBarSec = barSeconds(outGrid);
  const inBarSec = barSeconds(inGrid);
  const P = SMART_BLEND_PHRASES.includes(a.outroBars) ? a.outroBars : SMART_DEFAULT_BLEND_BARS;
  const firstDb = firstDownbeat(inGrid) ?? 0;
  const introBars = Math.max(0, Math.round((firstKick - firstDb) / inBarSec));
  // Blend start for straight/extend/tease-release: the outro point when
  // it leaves room for the full phrase blend, else exactly P bars before
  // the end — snapped back to an outgoing downbeat so the blend always
  // starts on the 1 and always fits before the track ends.
  const outStartP = outroStartSeconds(outGrid, a.out.duration, P);
  let blendStart = outOutro != null ? Math.min(outOutro, outStartP) : outStartP;
  blendStart = downbeatAtOrBefore(outGrid, blendStart) ?? blendStart;
  blendStart = Math.max(0, blendStart);

  // 2. EXTEND — short intro: manufacture room with a 4-bar loop at the
  // mix-in cue region. The loop starts AT the first kick (it teases the
  // drop itself, which the spec allows) and the release lands on a phrase
  // boundary into the main part (driver exits at a downbeat).
  if (introBars < P) {
    const extEnd = downbeatBarsAfter(inGrid, firstKick, EXTEND_LOOP_BARS);
    if (extEnd != null && extEnd > firstKick && extEnd <= a.in.duration) {
      return {
        mode: 'extend',
        firstKick,
        outOutro,
        blendBars: P,
        launchPos: firstDb,
        blendStartOut: blendStart,
        blendSecBars: P,
        teaseStart: null,
        teaseLoopStart: null,
        teaseLoopEnd: null,
        outBlendStart: null,
        extendLoopStart: firstKick,
        extendLoopEnd: extEnd,
        sustainStart: null,
        sustainEnd: null,
        triggerPos: blendStart,
        note: `Smart mix-in · extend: 4-bar loop fills a ${introBars}-bar intro (blend ${P} bars)`,
      };
    }
    // Loop does not fit (kick too close to track end) — fall through to
    // tease/straight with a short intro instead of forcing a bad loop.
  }

  // 3. SUSTAIN — long intro + an outgoing ending that would sag: loop the
  // outgoing track's last high-energy phrase (4 bars before its outro
  // point) while the FULL incoming intro plays over it. Triggers on a
  // thin outro (measured low energy) or on the outgoing track simply
  // ending before the intro completes (late autopilot engagement).
  if (introBars > P && introBars <= SUSTAIN_MAX_INTRO_BARS && outOutro != null) {
    const susStart = downbeatBarsBefore(outGrid, outOutro, 4);
    const remainingBars = (a.out.duration - a.outPos) / outBarSec;
    const ratio = outroLowRatio(a.out, outOutro, a.out.duration);
    const thin = ratio != null && ratio < OUTRO_THIN_RATIO;
    if (susStart != null && susStart > a.outPos + outBarSec && (thin || remainingBars < introBars)) {
      return {
        mode: 'sustain',
        firstKick,
        outOutro,
        blendBars: introBars,
        launchPos: firstDb,
        blendStartOut: susStart,
        blendSecBars: introBars,
        teaseStart: null,
        teaseLoopStart: null,
        teaseLoopEnd: null,
        outBlendStart: null,
        extendLoopStart: null,
        extendLoopEnd: null,
        sustainStart: susStart,
        sustainEnd: outOutro,
        triggerPos: susStart,
        note: `Smart mix-in · outro-sustain: looping the last high-energy phrase under a ${introBars}-bar intro`,
      };
    }
  }

  // 4. TEASE — room plentiful: loop the incoming track's 4 bars before its
  // first kick during the outgoing track's second-drop area (after its
  // breakdown, when one exists), then release into the drop as the blend
  // begins. Room must hold the tease plus the phrase blend, end to end.
  const teaseLoopStart = downbeatBarsBefore(inGrid, firstKick, TEASE_LOOP_BARS);
  const teaseStart = teaseLoopStart != null ? downbeatBarsBefore(outGrid, blendStart, TEASE_BARS) : null;
  const outHC3 = a.outHotcues[2] ?? null;
  const roomBars = teaseStart != null ? (a.out.duration - teaseStart) / outBarSec : 0;
  if (
    teaseLoopStart != null && teaseStart != null &&
    teaseStart > a.outPos + outBarSec &&
    (outHC3 == null || teaseStart >= outHC3) &&
    roomBars >= TEASE_BARS + P
  ) {
    return {
      mode: 'tease',
      firstKick,
      outOutro,
      blendBars: P,
      launchPos: teaseLoopStart,
      blendStartOut: blendStart,
      blendSecBars: TEASE_RELEASE_FADE_BARS,
      teaseStart,
      teaseLoopStart,
      teaseLoopEnd: firstKick,
      outBlendStart: blendStart,
      extendLoopStart: null,
      extendLoopEnd: null,
      sustainStart: null,
      sustainEnd: null,
      triggerPos: teaseStart,
      note: `Smart mix-in · teasing a 4-bar loop until the drop at ${fmtTime(firstKick)}`,
    };
  }

  // 5. STRAIGHT — phrase-aligned launch: start P bars before the first
  // kick (snapped to an incoming downbeat) so the kick lands exactly on
  // an outgoing bar boundary P bars into the blend; the crossfader runs
  // P + tail bars so the drop lands over the fading outgoing, and the
  // bass switches structurally at the kick (driver).
  const launchPos = downbeatBarsBefore(inGrid, firstKick, P) ?? firstDb;
  return {
    mode: 'straight',
    firstKick,
    outOutro,
    blendBars: P,
    launchPos,
    blendStartOut: blendStart,
    blendSecBars: P + STRAIGHT_TAIL_BARS,
    teaseStart: null,
    teaseLoopStart: null,
    teaseLoopEnd: null,
    outBlendStart: null,
    extendLoopStart: null,
    extendLoopEnd: null,
    sustainStart: null,
    sustainEnd: null,
    triggerPos: blendStart,
    note: `Smart mix-in · ${P}-bar phrase blend · first kick ${fmtTime(firstKick)}`,
  };
}

// ─── Auto-DJ smoothness: ranked fixes (research 2026-10-26) ─────────────
// Pure planning for the transition engine. Status of each fix against
// what already existed in this codebase:
//   Fix 3 equal-power — ALREADY PRESENT (engine crossfader is cos/sin
//     equal-power, scheduled and immediate). What was missing, and is
//     added here, is auto-gain: per-track loudness matching on load.
//   Fix 2 bass-swap — the one-bass hold + structural/fallback swap
//     already existed. Added here: the outgoing mid/high ease-out
//     around the swap (driver schedules it; the curves live in the
//     engine), and the swap-delay contingency below.
//   Fix 1 phrase-aligned — already present for smart plans (downbeat
//     snapped blend starts, whole-phrase lengths). Added here: whole-
//     bar fallback blends + silence trim, so the legacy path cannot
//     land mid-phrase or play into silence either.
//   Fix 4 overlap/silence/vocal — overlap already present via plans.
//     Added here: explicit silence trim + a mid-band vocal-density
//     proxy (no stems) that feeds type selection.
//   Fix 5 guardrails — Camelot + tempo window already existed in
//     pickNextTrack. Added here: energy-slope sanity + a severity
//     verdict that can DOWNGRADE a blend instead of blending blindly.
//   Fix 6 type selection — NEW: blend / breakdown / cut / filter /
//     echo chosen per pair, not one crossfader for everything.
//   Fix 8 contingencies — NEW (live branches only): delay-swap,
//     shorten-cut, echo-finish. Extend-loop stays plan-time only
//     (extend/sustain modes already loop phrases); re-scheduling a
//     running crossfader curve mid-blend was judged too risky.
//   Fix 7 stems — DEFERRED, deliberately: no in-browser Demucs exists
//     in this codebase, the browser model is ~126–170 MB with CPU
//     times of ~1–3 min per minute of audio and a reported WASM-heap
//     load failure, and djay's real-time claim is Apple-silicon Core
//     ML, not a browser result. The vocal-clash fallback is the EQ
//     mid-dip + breakdown/cut selection below — never block a
//     transition on separation.

/** Integrated loudness proxy + true peak from cached band peaks. */
export interface TrackLoudness {
  /** 10*log10(mean square) over all RMS buckets — dBFS-ish, comparable across tracks. */
  integratedDb: number;
  /** Max bucket peak (linear amplitude). */
  truePeak: number;
}

export function trackLoudness(t: TrackInfo | null | undefined): TrackLoudness | null {
  const p = t?.peaks;
  if (!p || p.rms.length === 0) return null;
  let ms = 0;
  for (let i = 0; i < p.rms.length; i++) ms += p.rms[i] * p.rms[i];
  ms /= p.rms.length;
  let peak = 0;
  for (let i = 0; i < p.max.length; i++) if (p.max[i] > peak) peak = p.max[i];
  return { integratedDb: 10 * Math.log10(Math.max(ms, 1e-12)), truePeak: peak };
}

/** Gain (dB) that matches the incoming track to the outgoing track's loudness. */
export function autoGainDb(
  out: TrackInfo,
  incoming: TrackInfo,
): { gainDb: number; limited: boolean } | null {
  const o = trackLoudness(out);
  const i = trackLoudness(incoming);
  if (!o || !i) return null;
  let gainDb = clamp(o.integratedDb - i.integratedDb, -6, 6);
  let limited = false;
  if (i.truePeak > 0) {
    const peakAfter = i.truePeak * Math.pow(10, gainDb / 20);
    if (peakAfter > 0.99) {
      gainDb = 20 * Math.log10(0.99 / Math.max(i.truePeak, 1e-6));
      limited = true;
    }
  }
  return { gainDb, limited };
}

/** First/last bucket above the noise floor, in track seconds (null without peaks). */
function soundBounds(t: TrackInfo): { first: number; last: number } | null {
  const p = t.peaks;
  if (!p || p.rms.length === 0 || p.rate <= 0) return null;
  const ref = p90(p.rms);
  const thr = Math.max(0.002, 0.02 * ref);
  let first = -1;
  let last = -1;
  for (let i = 0; i < p.rms.length; i++) {
    if (p.rms[i] > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  return { first: first / p.rate, last: last / p.rate };
}

/** First audible sound (leading-silence trim) or null. */
export function firstSoundSec(t: TrackInfo): number | null {
  return soundBounds(t)?.first ?? null;
}

/** Last audible sound (trailing-silence trim) or null. */
export function lastSoundSec(t: TrackInfo): number | null {
  return soundBounds(t)?.last ?? null;
}

/** Mean mid-band energy over [t0, t1] as a fraction of the track's own mid p90 (0..1). */
export function vocalDensity(t: TrackInfo, t0: number, t1: number): number | null {
  const p = t.peaks;
  if (!p || p.mid.length === 0 || p.rate <= 0 || t1 <= t0) return null;
  const ref = p90(p.mid);
  if (ref <= 0) return null;
  const i0 = clamp(Math.floor(t0 * p.rate), 0, p.mid.length - 1);
  const i1 = clamp(Math.ceil(t1 * p.rate), 0, p.mid.length - 1);
  if (i1 < i0) return null;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += p.mid[i];
  return clamp(sum / (i1 - i0 + 1) / ref, 0, 1);
}

/** A bar is "vocal-dense" when its mid-band mean clears the bass-state-style line. */
export const VOCAL_DENSE_RATIO = 0.4;

/** Energy direction across a window: second half vs first half of low-band energy. */
export function energySlope(t: TrackInfo, t0: number, t1: number): 'rising' | 'falling' | 'flat' | null {
  const env = trackBassEnvelope(t);
  if (!env || t1 <= t0) return null;
  const mid = (t0 + t1) / 2;
  const mean = (a: number, b: number): number => {
    let s = 0;
    let n = 0;
    for (let x = a; x <= b; x += 0.25) {
      s += envAt(env, x);
      n++;
    }
    return n ? s / n : 0;
  };
  const first = mean(t0, mid);
  const second = mean(mid, t1);
  if (first <= 0) return null;
  const r = second / first;
  if (r > 1.25) return 'rising';
  if (r < 0.8) return 'falling';
  return 'flat';
}

// ─── Guardrails (fix 5) ─────────────────────────────────────────────────

export interface Guardrail {
  bpmGapPct: number;
  halfDouble: boolean;
  keyScore: number;
  keysKnown: boolean;
  outSlope: 'rising' | 'falling' | 'flat' | null;
  inSlope: 'rising' | 'falling' | 'flat' | null;
  severity: 'ok' | 'warn' | 'downgrade';
  reasons: string[];
}

const CAMELOT_RE = /^(\d{1,2})([AB])$/i;

/**
 * Pairing verdict. Downgrade (never a plain blend) when the BPM gap
 * exceeds ~8% without a half/double relationship, or when both keys are
 * known and clash. Warn on bad energy direction (outgoing rising while
 * incoming falls), unknown keys, or a 6–8% gap. Queue picks are never
 * skipped by this — the driver only changes the transition TYPE.
 */
export function evaluateGuardrails(out: TrackInfo, incoming: TrackInfo): Guardrail {
  const reasons: string[] = [];
  let bpmGapPct = 0;
  let halfDouble = false;
  if (out.bpm > 0 && incoming.bpm > 0) {
    const ratio = incoming.bpm / out.bpm;
    bpmGapPct = Math.abs(ratio - 1) * 100;
    halfDouble = Math.abs(ratio - 0.5) < 0.03 || Math.abs(ratio - 2) < 0.03;
  }
  const keysKnown =
    !!out.key && !!incoming.key && CAMELOT_RE.test(out.key) && CAMELOT_RE.test(incoming.key);
  const keyScore = camelotScore(out.key, incoming.key);
  let outSlope: Guardrail['outSlope'] = null;
  let inSlope: Guardrail['inSlope'] = null;
  if (out.beatGrid && out.beatGrid.bpm > 0 && out.duration > 0) {
    const b = barSeconds(out.beatGrid);
    outSlope = energySlope(out, Math.max(0, out.duration - 16 * b), out.duration);
  }
  if (incoming.beatGrid && incoming.beatGrid.bpm > 0 && incoming.duration > 0) {
    const b = barSeconds(incoming.beatGrid);
    inSlope = energySlope(incoming, 0, Math.min(incoming.duration, 16 * b));
  }
  const energyBad = outSlope === 'rising' && inSlope === 'falling';
  let severity: Guardrail['severity'] = 'ok';
  if ((bpmGapPct > 8 && !halfDouble) || (keysKnown && keyScore === 0)) {
    severity = 'downgrade';
    if (bpmGapPct > 8 && !halfDouble) reasons.push(`BPM gap ${bpmGapPct.toFixed(0)}%`);
    if (keysKnown && keyScore === 0) reasons.push(`key clash ${out.key} vs ${incoming.key}`);
  } else {
    if (energyBad) reasons.push('energy falls the wrong way (out rising, in falling)');
    if (!keysKnown) reasons.push('key unknown on one side');
    if (bpmGapPct > 6) reasons.push(`BPM gap ${bpmGapPct.toFixed(0)}%`);
    if (reasons.length > 0) severity = 'warn';
  }
  return { bpmGapPct, halfDouble, keyScore, keysKnown, outSlope, inSlope, severity, reasons };
}

// ─── Transition-type selection (fix 6) ──────────────────────────────────

export type TransitionType = 'blend' | 'breakdown' | 'cut' | 'filter' | 'echo';

export function transitionLabel(t: TransitionType): string {
  switch (t) {
    case 'blend': return 'Bass-swap blend';
    case 'breakdown': return 'Breakdown swap';
    case 'cut': return 'Downbeat cut';
    case 'filter': return 'Filter fade';
    case 'echo': return 'Echo-out';
  }
}

/**
 * Pick the transition for a pair. A downgraded pairing never gets a
 * plain blend: a big gap or clash gets a deliberate echo-out moment,
 * a moderate gap gets a filter fade (a cut would be harsher than the
 * mismatch needs). A breakdown at the join beats a cut (the incoming
 * drops into a hole instead of over a vocal), and a vocal clash with
 * no hole gets a downbeat cut. Everything else is the default
 * phrase fade + bass swap.
 */
export function selectTransitionType(a: {
  severity: Guardrail['severity'];
  bpmGapPct: number;
  breakdownAtJoin: boolean;
  vocalClash: boolean;
}): TransitionType {
  if (a.severity === 'downgrade') return a.bpmGapPct > 15 ? 'echo' : 'filter';
  if (a.breakdownAtJoin) return 'breakdown';
  if (a.vocalClash) return 'cut';
  return 'blend';
}

// ─── Live contingency branches (fix 8) ──────────────────────────────────

export type ContingencyAction = 'none' | 'delay-swap' | 'shorten-cut' | 'echo-finish';

/**
 * Decide a live branch during a blend. Only three branches: the swap
 * can wait one phrase (kick long past, outgoing still full, room left),
 * the blend must end now (almost over, swap never fired, outgoing
 * still full — a late muddy swap is worse than a cut), or the grids
 * have diverged badly (PLL unlocked 3+ ticks — finish with an echo
 * tail instead of a misaligned blend). Extend-loop stays plan-time
 * only (extend/sustain modes); a fired branch runs once per transition.
 */
export function decideContingency(a: {
  bassSwapped: boolean;
  blendRemainingBars: number;
  pllBadTicks: number;
  kickOverdueBars: number;
  outBass: 'present' | 'absent' | 'unknown';
}): ContingencyAction {
  if (a.bassSwapped) return 'none';
  if (a.pllBadTicks >= 3) return 'echo-finish';
  if (a.kickOverdueBars >= 4 && a.blendRemainingBars >= 4 && a.outBass === 'present') {
    return 'delay-swap';
  }
  if (a.blendRemainingBars < 2 && a.outBass === 'present') return 'shorten-cut';
  return 'none';
}

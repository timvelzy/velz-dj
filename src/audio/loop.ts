/**
 * Traktor-style bar loops, computed from the deck's beat grid.
 *
 * Pure functions (no audio, no DOM) so the math can be checked without
 * playing anything. The one hard rule, from Tim: a loop must only ever
 * sit where the audio will not "skip" — so EVERY loop boundary lands on
 * a beat of the grid, and a loop's length is an exact number of bars
 * whenever the grid allows it:
 *  - With a beat map, the loop starts at the barline NEAREST the current
 *    position (Traktor quantize snap: never more than half a bar away
 *    from where the DJ pressed, never a full bar backwards the way the
 *    old floor-to-barline did), and ends exactly N bars later on the map.
 *  - If the map runs out before the full length fits, the start shifts
 *    back whole bars so the full length still fits on the map; only if
 *    even that cannot fit does the loop shorten, and it shortens to the
 *    last whole-bar boundary on the map — never to an extrapolated time
 *    and never to the track end (both are off-beat and skip every cycle,
 *    which is what the old code did).
 *  - Without a beat map, boundaries are extrapolated from BPM +
 *    downbeatOffset/firstBeat (flat grid) — same nearest/shift/shorten
 *    rules, so the result is still on that grid.
 *  - Halving/doubling keep the loop on the grid too: a halved end snaps
 *    down to the nearest beat, a doubled end clamps to the last beat on
 *    the grid instead of the track end.
 */

import type { BeatGrid } from '../types';

/** Traktor loop sizes, in bars. 1/2 bar = 2 beats. */
export const LOOP_SIZES: number[] = [0.5, 1, 2, 4, 8, 16, 32];

/**
 * Bar-phase residue (0..3) of a grid: beat-map indices i with
 * (i - barPhase) % 4 === 0 are downbeats. Explicit barPhase wins (set by
 * auto-1.1 analysis or manual Set 1.1); otherwise derived from
 * downbeatOffset (nearest mapped beat) so legacy grids keep the downbeat
 * the detector and the loop code already used; otherwise 0 (the
 * historical beats[0]-is-downbeat convention). Every bar-phase consumer
 * (engine launch/quantize, waveform and top-view markers, loop barlines
 * via downbeatOffset) reads through this so the whole app agrees on 1.1.
 */
export function barPhaseOf(grid: BeatGrid): number {
  if (typeof grid.barPhase === 'number' && grid.barPhase >= 0 && grid.barPhase <= 3) {
    return Math.floor(grid.barPhase);
  }
  if (grid.beats.length > 0 && grid.downbeatOffset >= 0) {
    const j = lastIndexAtOrBefore(grid.beats, grid.downbeatOffset);
    let best = j >= 0 ? j : 0;
    if (j + 1 < grid.beats.length) {
      const d0 = j >= 0 ? Math.abs(grid.beats[j] - grid.downbeatOffset) : Infinity;
      const d1 = Math.abs(grid.beats[j + 1] - grid.downbeatOffset);
      if (d1 < d0) best = j + 1;
    }
    return ((best % 4) + 4) % 4;
  }
  return 0;
}

export interface BarLoop {
  start: number;
  end: number;
}

/**
 * Backward grid extension ("grid the other way"): step the beat map
 * backward from beats[0] to the start of the track so a quiet intro
 * leads in on the same grid as the first kick, instead of the launch
 * paths snapping forward to the first mapped beat (the audible jerk).
 * Existing beat times are never changed; only new beats are prepended,
 * spaced by the first section's tempo (bpmCurve[0] ?? bpm). This is the
 * same constant-tempo-in-the-intro assumption beatsAtPosition already
 * makes when it extrapolates before beats[0]; it is exact for steady
 * grids and approximate where the intro genuinely drifts.
 *
 * bpmCurve: the incoming length relationship is preserved. When the
 * curve holds one entry per interval (beats.length - 1, the usual
 * buildBeatMap/GridEditor shape) it grows by prependCount so it still
 * holds one entry per interval; when it holds one entry per beat it
 * grows by the same amount. An empty curve stays empty (flat fallback).
 */
export function extendBeatsBackward(
  beats: readonly number[],
  bpmCurve: readonly number[],
  bpm: number,
): { beats: number[]; bpmCurve: number[]; prependCount: number } {
  const unchanged = { beats: [...beats], bpmCurve: [...bpmCurve], prependCount: 0 };
  if (beats.length === 0 || !(bpm > 0)) return unchanged;
  const first = beats[0];
  if (!(first > 0)) return unchanged;
  const firstCurve = bpmCurve.length > 0 ? bpmCurve[0] : undefined;
  const sectionBpm =
    firstCurve !== undefined && Number.isFinite(firstCurve) && firstCurve > 0 ? firstCurve : bpm;
  const spb = 60 / sectionBpm;
  if (!(spb > 0) || !Number.isFinite(spb)) return unchanged;
  // Whole steps back that land at >= 0. The 1e-6 slack absorbs float
  // dust when firstBeat is an exact multiple of spb; a step that lands
  // a hair below 0 is clamped to 0 below.
  const count = Math.min(100000, Math.floor(first / spb + 1e-6));
  if (count <= 0) return unchanged;
  const prepended: number[] = [];
  for (let k = count; k >= 1; k--) {
    let t = first - k * spb;
    if (t < 0) t = 0;
    if (prepended.length > 0 && t <= prepended[prepended.length - 1] + 1e-9) continue;
    if (t >= first - 1e-9) continue; // never duplicate beats[0]
    prepended.push(t);
  }
  if (prepended.length === 0) return unchanged;
  const prependCount = prepended.length;
  const newCurve =
    bpmCurve.length === 0
      ? []
      : [...new Array(prependCount).fill(sectionBpm), ...bpmCurve];
  return { beats: [...prepended, ...beats], bpmCurve: newCurve, prependCount };
}

/**
 * Bar-phase residue after beats were prepended: the downbeat beat keeps
 * its TIME, so its index shifts by prependCount and the residue must
 * shift by the same amount, or barPhaseOf() would move the downbeat.
 * Uses barPhaseOf() so grids with no explicit barPhase (phase derived
 * from downbeatOffset) are handled the same way. Use this only when
 * the downbeat anchor itself is unchanged; Set 1.1 re-anchors to a
 * different beat and computes its residue from the new index directly.
 */
export function barPhaseAfterPrepend(grid: BeatGrid, prependCount: number): number {
  return (((barPhaseOf(grid) + prependCount) % 4) + 4) % 4;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Last index whose value is <= `t` (-1 when all values are > t). */
function lastIndexAtOrBefore(values: number[], t: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let j = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= t) { j = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return j;
}

/**
 * Barline beat-indices of a beat map: the anchor bar (downbeat when known,
 * else the first beat) and every 4th beat after it.
 */
function mapBarlineIndices(beats: number[], anchor: number): number[] {
  let a0 = 0;
  while (a0 < beats.length && beats[a0] < anchor) a0++;
  if (a0 >= beats.length) a0 = 0;
  const out: number[] = [];
  for (let i = a0; i < beats.length; i += 4) out.push(i);
  return out;
}

/** Flat-grid barline times from an offset, stepping one bar, within [0, duration]. */
function flatBarlines(off: number, barDur: number, duration: number): number[] {
  const out: number[] = [];
  // First barline at or after 0 (barlines before the offset count too).
  const k0 = Math.ceil((0 - off) / barDur);
  for (let k = k0; ; k++) {
    const t = off + k * barDur;
    if (t > duration) break;
    if (t >= 0) out.push(t);
    if (out.length > 100000) break; // degenerate grid guard
  }
  return out;
}

/**
 * Bar-aligned loop of `bars` bars snapped to the grid near `posSec`.
 * Returns null when there is no usable grid or no on-grid loop fits
 * (e.g. pressing Loop inside the final partial bar with no earlier
 * barline to shift back to).
 */
export function computeBarLoop(
  grid: BeatGrid | null,
  duration: number,
  posSec: number,
  bars: number,
): BarLoop | null {
  if (!grid || grid.bpm <= 0 || duration <= 0 || bars <= 0) return null;
  const spb = 60 / grid.bpm;
  const barDur = spb * 4;
  if (duration < spb) return null;
  const pos = clamp(posSec, 0, duration);
  const needBeats = Math.round(bars * 4);

  if (grid.beats.length >= 8) {
    const beats = grid.beats;
    const anchor = grid.downbeatOffset >= 0 ? grid.downbeatOffset : beats[0];
    const barIdx = mapBarlineIndices(beats, anchor);
    if (barIdx.length === 0) return null;

    // Nearest barline to pos (ties go to the earlier barline).
    let si = lastIndexAtOrBefore(barIdx.map((i) => beats[i]), pos);
    if (si < 0) si = 0;
    else if (si + 1 < barIdx.length) {
      const prev = beats[barIdx[si]];
      const next = beats[barIdx[si + 1]];
      if (next - pos < pos - prev) si = si + 1;
    }

    let startIdx = barIdx[si];
    let endIdx = startIdx + needBeats;
    if (endIdx >= beats.length) {
      // Map runs out: shift the start back whole bars so the full
      // length still fits on the map.
      const maxStart = beats.length - 1 - needBeats;
      let shifted = -1;
      for (let k = barIdx.length - 1; k >= 0; k--) {
        if (barIdx[k] <= maxStart) { shifted = barIdx[k]; break; }
      }
      if (shifted >= 0) {
        startIdx = shifted;
        endIdx = startIdx + needBeats;
      } else {
        // Cannot fit the full length: shorten to the last whole-bar
        // boundary on the map after the start.
        const lastBar = barIdx[barIdx.length - 1];
        if (lastBar > startIdx) {
          endIdx = lastBar;
        } else {
          return null;
        }
      }
    }
    const start = beats[startIdx];
    const end = beats[endIdx];
    if (end <= start || end - start < spb || end > duration) return null;
    return { start, end };
  }

  // Flat fallback: no usable map, extrapolate barlines from BPM + offset.
  const off = grid.downbeatOffset >= 0
    ? grid.downbeatOffset
    : grid.firstBeat >= 0 ? grid.firstBeat : 0;
  const lines = flatBarlines(off, barDur, duration);
  if (lines.length < 2) return null;

  // Nearest barline to pos (ties go to the earlier barline).
  let si = lastIndexAtOrBefore(lines, pos);
  if (si < 0) si = 0;
  else if (si + 1 < lines.length && lines[si + 1] - pos < pos - lines[si]) si = si + 1;

  let start = lines[si];
  let end = start + bars * barDur;
  const lastLine = lines[lines.length - 1];
  if (end > lastLine + 1e-9) {
    // Shift back whole bars so the full length fits on the grid.
    while (end > lastLine + 1e-9 && start - barDur >= 0) {
      start -= barDur;
      end -= barDur;
    }
    if (end > lastLine + 1e-9) {
      // Still does not fit: shorten to the last barline after the start.
      if (lastLine > start) end = lastLine;
      else return null;
    }
  }
  if (end <= start || end - start < spb || end > duration) return null;
  return { start, end };
}

/** Nearest beat at or before `t` on the grid (map beats, else flat beats). */
function beatAtOrBefore(grid: BeatGrid | null, t: number): number | null {
  if (!grid || grid.bpm <= 0) return null;
  const spb = 60 / grid.bpm;
  if (grid.beats.length >= 8) {
    const j = lastIndexAtOrBefore(grid.beats, t);
    return j >= 0 ? grid.beats[j] : null;
  }
  const off = grid.downbeatOffset >= 0
    ? grid.downbeatOffset
    : grid.firstBeat >= 0 ? grid.firstBeat : 0;
  const k = Math.floor((t - off) / spb);
  const beat = off + k * spb;
  return beat >= 0 ? beat : null;
}

/**
 * Halve an active loop, keeping its start (Traktor loop-size −).
 * The new end snaps down to the nearest beat on the grid so a halved
 * (possibly shortened) loop can never end mid-beat. With no grid the
 * old exact-halve behavior is kept. Returns the loop unchanged when
 * no on-grid halved end exists.
 */
export function halveLoop(loop: BarLoop, grid?: BeatGrid | null): BarLoop {
  const half = loop.start + (loop.end - loop.start) / 2;
  if (!grid) return { start: loop.start, end: half };
  const snapped = beatAtOrBefore(grid, half);
  if (snapped === null || snapped <= loop.start) return loop;
  return { start: loop.start, end: snapped };
}

/**
 * Double an active loop, keeping its start (Traktor loop-size +).
 * The new end clamps to the last beat on the grid at or before the
 * doubled point (and never past the track end), so a doubled loop can
 * never end mid-beat or at an off-beat track end. With no grid the old
 * clamp-to-duration behavior is kept. Returns the loop unchanged when
 * no on-grid doubled end exists.
 */
export function doubleLoop(loop: BarLoop, duration: number, grid?: BeatGrid | null): BarLoop {
  const doubled = loop.start + (loop.end - loop.start) * 2;
  if (!grid) return { start: loop.start, end: Math.min(duration, doubled) };
  const target = Math.min(doubled, duration);
  const snapped = beatAtOrBefore(grid, target);
  if (snapped === null || snapped <= loop.start) return loop;
  return { start: loop.start, end: snapped };
}

/** Format a loop size the Traktor way: 1/2, 1, 2, 4, 8, 16, 32. */
export function formatLoopSize(bars: number): string {
  return bars === 0.5 ? '1/2' : `${bars}`;
}

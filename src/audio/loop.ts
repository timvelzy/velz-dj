/**
 * Traktor-style bar loops, computed from the deck's beat grid.
 *
 * Pure functions (no audio, no DOM) so the math can be checked without
 * playing anything. Loop boundaries always land on bars/beats:
 *  - With a beat map, the loop starts at the downbeat-phase barline at or
 *    before the current position, and ends exactly N bars later on the map.
 *  - Without a beat map, boundaries are extrapolated from BPM +
 *    downbeatOffset/firstBeat.
 *  - Near the end of a track the loop shortens to the track end rather
 *    than jumping the start backwards (a DJ hitting 32 bars near the end
 *    still gets a usable loop from where they are).
 */

import type { BeatGrid } from '../types';

/** Traktor loop sizes, in bars. 1/2 bar = 2 beats. */
export const LOOP_SIZES: number[] = [0.5, 1, 2, 4, 8, 16, 32];

export interface BarLoop {
  start: number;
  end: number;
}

function barDuration(grid: BeatGrid): number {
  return (60 / grid.bpm) * 4;
}

/**
 * Bar-aligned loop of `bars` bars starting at the barline at or before
 * `posSec`. Returns null when there is no usable grid or the track is too
 * short for even one beat of loop.
 */
export function computeBarLoop(
  grid: BeatGrid | null,
  duration: number,
  posSec: number,
  bars: number,
): BarLoop | null {
  if (!grid || grid.bpm <= 0 || duration <= 0 || bars <= 0) return null;
  const spb = 60 / grid.bpm;
  const barDur = barDuration(grid);
  if (duration < spb) return null;
  const pos = Math.min(Math.max(0, posSec), duration);

  let start: number;
  let end: number;

  if (grid.beats.length >= 8) {
    // Bar phase anchors on the first downbeat when known, else beat 0.
    const anchor = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.beats[0];
    let a0 = 0;
    while (a0 < grid.beats.length && grid.beats[a0] < anchor) a0++;
    if (a0 >= grid.beats.length) a0 = 0;
    // Last beat at or before pos.
    let j = -1;
    let lo = 0;
    let hi = grid.beats.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (grid.beats[mid] <= pos) { j = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const rel = Math.max(0, j - a0);
    const barStartIdx = a0 + Math.floor(rel / 4) * 4;
    start = grid.beats[Math.min(barStartIdx, grid.beats.length - 1)];
    const endIdx = barStartIdx + Math.round(bars * 4);
    end = endIdx < grid.beats.length ? grid.beats[endIdx] : start + bars * barDur;
  } else {
    const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat >= 0 ? grid.firstBeat : 0;
    start = off + Math.floor(Math.max(0, pos - off) / barDur) * barDur;
    end = start + bars * barDur;
  }

  start = Math.max(0, start);
  if (end > duration) {
    // Prefer a shortened loop from the barline over moving the start.
    if (duration - start >= spb) {
      end = duration;
    } else {
      end = duration;
      start = Math.max(0, end - bars * barDur);
    }
  }
  if (end - start < spb) {
    // Degenerate (tiny track tail): fall back to one beat from the start.
    start = Math.max(0, duration - spb);
    end = duration;
  }
  if (end <= start) return null;
  return { start, end };
}

/** Halve an active loop, keeping its start (Traktor loop-size −). */
export function halveLoop(loop: BarLoop): BarLoop {
  return { start: loop.start, end: loop.start + (loop.end - loop.start) / 2 };
}

/** Double an active loop, keeping its start (Traktor loop-size +). */
export function doubleLoop(loop: BarLoop, duration: number): BarLoop {
  return { start: loop.start, end: Math.min(duration, loop.start + (loop.end - loop.start) * 2) };
}

/** Format a loop size the Traktor way: 1/2, 1, 2, 4, 8, 16, 32. */
export function formatLoopSize(bars: number): string {
  return bars === 0.5 ? '1/2' : `${bars}`;
}

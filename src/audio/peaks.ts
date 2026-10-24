/**
 * Band peaks for waveform rendering (Phase 4).
 *
 * One pass per track produces, at 100 buckets/second:
 *  - min/max + RMS of the mono-summed signal (the classic envelope), and
 *  - low/mid/high band peak energies (reusing the analysis 3-band offline
 *    render) for Rekordbox-style band-colored waveforms.
 *
 * Results are cached in IndexedDB (peaksStore) keyed by file identity, so
 * a track's waveform is computed exactly once, ever.
 */

import type { BandPeaks, SpectralData } from '../types';
import { analyzeSpectrum } from './analysis';

export const PEAKS_RATE = 100;

/** Stable cache key for a track file. */
export function peaksKey(file: File): string {
  return `${file.name}|${file.size}`;
}

function yieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build BandPeaks from a decoded buffer. Pass the SpectralData from
 * analyzeTrack when you already have it (analysis path); otherwise the
 * band render runs here (Traktor-matched tracks skip analysis entirely).
 */
export async function computeBandPeaks(
  buffer: AudioBuffer,
  spectral?: SpectralData,
): Promise<BandPeaks> {
  const rate = PEAKS_RATE;
  const n = Math.max(1, Math.ceil(buffer.duration * rate));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const rms = new Float32Array(n);

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const sr = buffer.sampleRate;
  const perBucket = sr / rate;

  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * perBucket);
    const end = Math.min(ch0.length, Math.floor((b + 1) * perBucket));
    let mn = 0;
    let mx = 0;
    let sumSq = 0;
    let count = 0;
    // Stride 2: display peaks don't need every sample, halves the cost.
    for (let i = start; i < end; i += 2) {
      const v = (ch0[i] + ch1[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sumSq += v * v;
      count++;
    }
    min[b] = mn;
    max[b] = mx;
    rms[b] = count > 0 ? Math.sqrt((sumSq / count) * 2) : 0; // ×2 ≈ stride compensation
    if ((b & 1023) === 0) await yieldControl();
  }

  const bands = spectral ?? (await analyzeSpectrum(buffer));
  const pick = (arr: Float32Array | undefined) => {
    const out = new Float32Array(n);
    if (arr) {
      const m = Math.min(n, arr.length);
      out.set(arr.subarray(0, m));
    }
    return out;
  };

  return {
    rate,
    duration: buffer.duration,
    min,
    max,
    rms,
    low: pick(bands?.low),
    mid: pick(bands?.mid),
    high: pick(bands?.high),
  };
}

/** Aggregate fine peaks into fewer buckets (for the full-track overview). */
export function resamplePeaks(peaks: BandPeaks, target: number): BandPeaks {
  const n = peaks.min.length;
  const out: BandPeaks = {
    rate: target / peaks.duration,
    duration: peaks.duration,
    min: new Float32Array(target),
    max: new Float32Array(target),
    rms: new Float32Array(target),
    low: new Float32Array(target),
    mid: new Float32Array(target),
    high: new Float32Array(target),
  };
  for (let b = 0; b < target; b++) {
    const s = Math.floor((b / target) * n);
    const e = Math.max(s + 1, Math.floor(((b + 1) / target) * n));
    let mn = 0;
    let mx = 0;
    let sumSq = 0;
    let lo = 0;
    let md = 0;
    let hi = 0;
    for (let i = s; i < e && i < n; i++) {
      if (peaks.min[i] < mn) mn = peaks.min[i];
      if (peaks.max[i] > mx) mx = peaks.max[i];
      sumSq += peaks.rms[i] * peaks.rms[i];
      if (peaks.low[i] > lo) lo = peaks.low[i];
      if (peaks.mid[i] > md) md = peaks.mid[i];
      if (peaks.high[i] > hi) hi = peaks.high[i];
    }
    out.min[b] = mn;
    out.max[b] = mx;
    out.rms[b] = Math.sqrt(sumSq / Math.max(1, e - s));
    out.low[b] = lo;
    out.mid[b] = md;
    out.high[b] = hi;
  }
  return out;
}

/** Dominant-band color for a bucket (Rekordbox-style full-color waveform). */
export function bandColor(peaks: BandPeaks, i: number): string {
  const lo = peaks.low[i] ?? 0;
  const md = peaks.mid[i] ?? 0;
  const hi = peaks.high[i] ?? 0;
  if (lo >= md && lo >= hi) return '#fb923c'; // low — warm orange
  if (hi >= md) return '#e0f2fe'; // high — pale sky/white
  return '#4ade80'; // mid — green
}

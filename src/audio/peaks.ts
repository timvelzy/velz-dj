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

/** Dominant-band color for a bucket (Rekordbox-style full-color waveform).
 * NOTE: superseded for rendering by amplitudeRGB below. Dominant-band
 * coloring reads green-dominated on real tracks with the current
 * analysis: the "mid" render in analyzeSpectrum is a peaking filter at
 * 1kHz with default gain 0dB, i.e. a flat response — the mid array is
 * effectively the FULL unfiltered signal, so it wins the max-band pick
 * on nearly every bucket and the waveform renders almost entirely
 * mid-green. Kept for reference; renderers use amplitudeRGB. */
export function bandColor(peaks: BandPeaks, i: number): string {
  const lo = peaks.low[i] ?? 0;
  const md = peaks.mid[i] ?? 0;
  const hi = peaks.high[i] ?? 0;
  // Vivid band palette adopted exactly from groove-web-mixer's
  // DetailedScrollingWaveform (dominant-band coloring, same approach as
  // here): bass #ff2d55, mid #32d74b, high #007aff. The previous velz-dj
  // palette (low #fb923c, mid #4ade80, high #e0f2fe) read muted next to
  // groove's render, notably the near-white pale high band. Beatgrid
  // contrast: grid lines stay deck-colored (A #38bdf8, B #fb923c, AI
  // #c084fc — all distinct hues from the three band colors), downbeats
  // are 2px solid with a white first-beat marker, and the unplayed dim
  // is drawn under the grid so lines stay full-strength over dimmed
  // upcoming audio.
  if (lo >= md && lo >= hi) return '#ff2d55'; // low — vivid pink-red
  if (hi >= md) return '#007aff'; // high — vivid blue
  return '#32d74b'; // mid — vivid green
}

/**
 * Per-bucket playback amplitude, groove ScrollingWaveformRenderer style:
 * max of the envelope peak and the RMS × 1.8 boost. This is the input to
 * the amplitude-banded coloring below (and to the sqrt bar heights in
 * the top view), matching the renderer behind groove's DualOverviewWaveform
 * top view — the example Tim showed. That renderer does NOT color by
 * frequency band at all.
 */
export function bucketAmplitude(peaks: BandPeaks, i: number): number {
  const peak = Math.max(Math.abs(peaks.min[i] ?? 0), Math.abs(peaks.max[i] ?? 0));
  return Math.max(peak, (peaks.rms[i] ?? 0) * 1.8);
}

/**
 * Amplitude-banded color, ported exactly from groove-web-mixer's
 * ScrollingWaveformRenderer.getAmplitudeBasedColor (the renderer behind
 * DualOverviewWaveform's top view). Color varies with loudness along the
 * track, which is why groove's example reads multicolored instead of
 * one flat band color: quiet passages render deep blue, then cyan, then
 * green/yellow at mid level, then orange/red at high level. Returns
 * [r, g, b] so callers can build groove's vertical per-bar gradient
 * (lighter top, base middle, darker bottom) and played/unplayed alpha.
 */
export function amplitudeRGB(peaks: BandPeaks, i: number): [number, number, number] {
  const normalizedAmp = Math.min(1, bucketAmplitude(peaks, i) * 2.5);
  if (normalizedAmp < 0.2) {
    // Very low amplitude — deep blue
    const intensity = Math.floor(normalizedAmp * 255 * 5);
    return [Math.floor(intensity * 0.3), Math.floor(intensity * 0.6), intensity];
  } else if (normalizedAmp < 0.4) {
    // Low amplitude — cyan
    const intensity = Math.floor((normalizedAmp - 0.2) * 255 * 5);
    return [Math.floor(intensity * 0.4), Math.floor(intensity * 0.9), intensity];
  } else if (normalizedAmp < 0.7) {
    // Mid amplitude — green/yellow
    const intensity = Math.floor((normalizedAmp - 0.4) * 255 * 3.33);
    return [intensity, Math.min(255, Math.floor(intensity * 1.3)), Math.floor(intensity * 0.3)];
  }
  // High amplitude — orange/red
  const intensity = Math.floor((normalizedAmp - 0.7) * 255 * 3.33);
  return [Math.min(255, intensity + 80), Math.floor(intensity * 0.6), Math.floor(intensity * 0.2)];
}

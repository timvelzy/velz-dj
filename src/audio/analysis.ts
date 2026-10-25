/**
 * Track analysis: BPM detection + beat grid + downbeat + spectral data.
 *
 * Grafted from groove-web-mixer's SmartBPMDetector / ElectronicBPMDetector /
 * BPMDetector, with fixes:
 *  - BPM clamp widened 120–180 → 60–200 with octave disambiguation
 *    (the old clamp destroyed hip-hop, halftime DnB feels, dubstep)
 *  - Downbeat detection added (energy-based, first 4 beats)
 *  - No hardcoded fallbacks: low-confidence results are REPORTED as
 *    low-confidence instead of silently stamping 120/128 BPM
 */

import type { BeatGrid, SpectralData } from '../types';
import { debugLog } from './debugLog';

const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Median-interval BPM from an onset list in seconds. Returns the folded BPM,
 * the fraction of intervals that agreed with the median (consistency), and
 * a stability score (1 - std/mean over all intervals, as before).
 * Exported for tests / grid-editor diagnostics.
 */
export function medianBpmFromOnsets(onsets: number[]): { bpm: number; consistency: number; count: number; stability: number } {
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const bpm = 60 / (onsets[i] - onsets[i - 1]);
    if (bpm >= MIN_BPM / 2 && bpm <= MAX_BPM * 2) intervals.push(onsets[i] - onsets[i - 1]);
  }
  if (intervals.length < 2) return { bpm: 0, consistency: 0, count: 0, stability: 0 };
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const tol = median * 0.05;
  const consistent = intervals.filter((v) => Math.abs(v - median) <= tol);
  const avg = consistent.reduce((s, v) => s + v, 0) / consistent.length;
  const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length;
  return {
    bpm: foldBpm(60 / avg),
    consistency: consistent.length / intervals.length,
    count: intervals.length,
    stability: Math.max(0.1, 1 - Math.sqrt(variance) / avg),
  };
}

/**
 * Onset picker shared by the full-band and kick-band streams: adaptive
 * threshold + local-maximum check + refractory window, all in dsRate units.
 * Exported for tests / grid-editor diagnostics.
 */
export function pickOnsets(sig: Float32Array, dsRate: number, mult: number): number[] {
  let sum = 0;
  for (let i = 0; i < sig.length; i++) sum += sig[i];
  const threshold = (sum / sig.length) * mult;
  const minInterval = Math.floor(dsRate * 60 / MAX_BPM);
  const win = Math.floor(dsRate * 0.05);
  const onsets: number[] = [];
  let last = -minInterval;
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] > threshold && i - last >= minInterval) {
      let isMax = true;
      for (let j = Math.max(0, i - win); j < Math.min(sig.length, i + win); j++) {
        if (sig[j] > sig[i]) { isMax = false; break; }
      }
      if (isMax) {
        onsets.push(i / dsRate);
        last = i;
      }
    }
  }
  return onsets;
}

export interface AnalysisResult {
  grid: BeatGrid;
  spectralData?: SpectralData;
}

/** Fold a raw BPM into [MIN_BPM, MAX_BPM] by octaves. */
function foldBpm(raw: number): number {
  let bpm = raw;
  let guard = 0;
  while (bpm < MIN_BPM && guard++ < 8) bpm *= 2;
  guard = 0;
  while (bpm > MAX_BPM && guard++ < 8) bpm /= 2;
  return bpm;
}

function generateBeats(bpm: number, duration: number, firstBeat: number): number[] {
  const beats: number[] = [];
  const interval = 60 / bpm;
  for (let t = firstBeat; t < duration; t += interval) beats.push(t);
  return beats;
}

/**
 * Build a full-track beat map by detecting tempo in overlapping sections.
 * Returns beat timestamps + per-beat BPM curve, following tempo drift.
 * Falls back to single-BPM extrapolation if sections disagree too much.
 */
async function buildBeatMap(
  channelData: Float32Array,
  sampleRate: number,
  duration: number,
  baseBpm: number,
  firstBeat: number,
  onProgress?: (p: number) => void,
): Promise<{ beats: number[]; bpmCurve: number[]; stability: number }> {
  const SECTION_SEC = 8;
  const HOP_SEC = 4;
  const TARGET_RATE = 8000;
  const ratio = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  // The true downsampled rate is sampleRate/ratio, NOT 8000, unless the
  // sample rate is an exact multiple of 8000. The old code divided sample
  // indices by 8000 unconditionally, which stretched all times by
  // sampleRate/ratio/8000 (×1.1025 at 44.1 kHz) and read every 44.1 kHz
  // track ~9% slow. All time conversions below use dsRate.
  const dsRate = sampleRate / ratio;

  // Full-track onset detection (downsampled)
  const totalLen = Math.floor((channelData.length / ratio));
  const ds = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i++) ds[i] = channelData[i * ratio];

  // Transient emphasis
  const tr = new Float32Array(totalLen);
  let prev = 0;
  const alpha = 0.8;
  for (let i = 0; i < totalLen; i++) {
    const hp = ds[i] - prev;
    prev = ds[i] * (1 - alpha) + prev * alpha;
    tr[i] = Math.abs(hp);
  }

  // Per-section BPM via onset interval histogram
  const sections: { start: number; bpm: number; weight: number }[] = [];
  const secLen = Math.floor(SECTION_SEC * dsRate);
  const hopLen = Math.floor(HOP_SEC * dsRate);
  let sIdx = 0;
  for (let s = 0; s + secLen <= totalLen; s += hopLen, sIdx++) {
    const onsets: number[] = [];
    let sum = 0;
    for (let i = s; i < s + secLen; i++) sum += tr[i];
    const thr = (sum / secLen) * 3.5;
    const minInt = Math.floor(dsRate * 60 / MAX_BPM);
    let last = -minInt;
    for (let i = s; i < s + secLen; i++) {
      if (tr[i] > thr && i - last >= minInt) {
        onsets.push((i - s) / dsRate);
        last = i;
      }
    }
    if (onsets.length >= 4) {
      const ivals: number[] = [];
      for (let i = 1; i < onsets.length; i++) {
        const iv = onsets[i] - onsets[i - 1];
        if (iv > 0.15 && iv < 1.5) ivals.push(iv);
      }
      if (ivals.length >= 2) {
        ivals.sort((a, b) => a - b);
        const med = ivals[Math.floor(ivals.length / 2)];
        const tol = med * 0.08;
        const ok = ivals.filter((v) => Math.abs(v - med) <= tol);
        if (ok.length >= 2) {
          const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
          const localBpm = foldBpm(60 / avg);
          // Snap to nearest musically-sensible multiple of base BPM
          // (avoids half/double-time flips between sections)
          let snapped = localBpm;
          for (const mult of [0.5, 1, 2]) {
            const cand = baseBpm * mult;
            if (Math.abs(localBpm - cand) / cand < 0.06) { snapped = cand; break; }
          }
          sections.push({ start: s / dsRate, bpm: snapped, weight: ok.length / ivals.length });
        }
      }
    }
    if ((sIdx & 7) === 0) {
      onProgress?.(0.5 + 0.3 * (s / totalLen));
      await yieldControl();
    }
  }

  if (sections.length === 0) {
    // No usable sections — fall back to flat extrapolation
    const beats = generateBeats(baseBpm, duration, firstBeat);
    return { beats, bpmCurve: new Array(Math.max(0, beats.length - 1)).fill(baseBpm), stability: 0.3 };
  }

  // Walk the track, emitting beats using each section's local BPM,
  // snapping each beat to the nearest transient for tight phase.
  const beats: number[] = [];
  const bpmCurve: number[] = [];
  let t = firstBeat;
  let secIdx = 0;
  const snapWindow = Math.floor(dsRate * 0.06); // ±60ms snap

  const snapToTransient = (time: number): number => {
    const center = Math.floor(time * dsRate);
    let best = center;
    let bestV = -1;
    for (let i = Math.max(0, center - snapWindow); i < Math.min(totalLen, center + snapWindow); i++) {
      if (tr[i] > bestV) { bestV = tr[i]; best = i; }
    }
    return bestV > 0.01 ? best / dsRate : time;
  };

  let guard = 0;
  const maxBeats = Math.ceil(duration / (60 / MAX_BPM)) + 16;
  while (t < duration && guard++ < maxBeats) {
    while (secIdx + 1 < sections.length && sections[secIdx + 1].start <= t) secIdx++;
    const bpm = sections[secIdx]?.bpm ?? baseBpm;
    const snappedT = t === firstBeat ? t : snapToTransient(t);
    beats.push(snappedT);
    const spb = 60 / bpm;
    bpmCurve.push(bpm);
    t = snappedT + spb;
  }
  if (bpmCurve.length > 0) bpmCurve.pop(); // one fewer intervals than beats

  // Stability = agreement between sections
  const bpms = sections.map((s) => s.bpm);
  const mean = bpms.reduce((a, b) => a + b, 0) / bpms.length;
  const variance = bpms.reduce((a, b) => a + (b - mean) ** 2, 0) / bpms.length;
  const stability = Math.max(0.1, 1 - Math.sqrt(variance) / mean);

  onProgress?.(0.85);
  return { beats, bpmCurve, stability };
}

/**
 * Downbeat detection: of the first 4 beats, the one with the most energy in
 * the 120ms after the onset is most likely the bar start ("one").
 * Returns the time of the downbeat, or -1 if it can't be determined.
 */
function detectDownbeat(
  channelData: Float32Array,
  sampleRate: number,
  beats: number[],
): number {
  if (beats.length < 4) return -1;
  const window = Math.floor(sampleRate * 0.12);
  let best = -1;
  let bestEnergy = -1;
  for (let b = 0; b < Math.min(4, beats.length); b++) {
    const start = Math.floor(beats[b] * sampleRate);
    let e = 0;
    const end = Math.min(start + window, channelData.length);
    for (let i = start; i < end; i++) e += channelData[i] * channelData[i];
    if (e > bestEnergy) {
      bestEnergy = e;
      best = b;
    }
  }
  if (best < 0 || bestEnergy <= 1e-9) return -1;
  return beats[best];
}

// ─── Electronic (kick-onset) detector ─────────────────────────────────────────

async function detectElectronic(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<Omit<BeatGrid, 'method' | 'beats' | 'bpmCurve'>> {
  const TARGET_RATE = 8000;
  const ANALYZE_SEC = 15;
  const WINDOW_HOP_SEC = 5;
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const ratio = Math.max(1, Math.floor(sr / TARGET_RATE));
  const dsRate = sr / ratio; // true downsampled rate (see buildBeatMap note)

  // Window selection: the old code always analyzed the FIRST 15 s. For a
  // track with a quiet build intro (Chlorine and Dashboard Light: 0:00–
  // 0:45 quiet, first drop 1:30), that window contains no kick at all, so
  // the kick gate (>= 4 onsets, consistency >= 0.5) fails and detection
  // falls back to the full-band stream — which locks onto the dotted-
  // eighth arp grid (122 x 4/3 ~= 163) instead of the kick grid. Fix:
  // analyze the LOUDEST 15 s window instead (15 s windows hopped every
  // 5 s over the full track, scored by mean square on the downsampled
  // signal). The onset machinery below is unchanged; only the window
  // moves to where the kick actually lives. Onset times are window-local,
  // so firstBeat is shifted back by the window start below. Short tracks
  // (< 15 s) still analyze from 0, exactly as before.
  const totalDsLen = Math.floor(ch.length / ratio);
  const winLen = Math.floor(ANALYZE_SEC * dsRate);
  const hopLen = Math.max(1, Math.floor(WINDOW_HOP_SEC * dsRate));
  let winStart = 0;
  let bestEnergy = -1;
  for (let s = 0; s < totalDsLen; s += hopLen) {
    const end = Math.min(s + winLen, totalDsLen);
    let e = 0;
    for (let i = s; i < end; i++) { const v = ch[i * ratio]; e += v * v; }
    const mean = e / Math.max(1, end - s);
    if (mean > bestEnergy) { bestEnergy = mean; winStart = s; }
  }
  if (winStart + winLen > totalDsLen) winStart = Math.max(0, totalDsLen - winLen);
  const dsLen = Math.min(winLen, totalDsLen - winStart);
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) ds[i] = ch[(winStart + i) * ratio];

  // Broadband transient extraction (high-pass-ish, as before)
  const transient = new Float32Array(dsLen);
  let prev = 0;
  const alpha = 0.8;
  for (let i = 0; i < dsLen; i++) {
    const hp = ds[i] - prev;
    prev = ds[i] * (1 - alpha) + prev * alpha;
    transient[i] = Math.abs(hp) * 2;
    if ((i & 4095) === 0) {
      onProgress?.(0.1 + 0.3 * (i / dsLen));
      await yieldControl();
    }
  }

  // Full-band onsets
  const onsets = pickOnsets(transient, dsRate, 4);

  // Kick-band onsets: a one-pole lowpass (fc ~160 Hz) isolates kick energy,
  // then the ENERGY ENVELOPE of that band is tracked (squared + smoothed)
  // and its positive flux marks kick onsets. The kick defines the beat in
  // dance music; the full-band stream is easily hijacked by a dominant
  // dotted-eighth arp or syncopated layer. That hijack is the reported
  // 120 -> 160 error: the median interval locks onto the 0.375 s dotted
  // grid (120 x 4/3) instead of the 0.5 s kick grid.
  // NOTE: a high-pass transient filter does NOT work on the lowpassed
  // signal — it kills the kick fundamental itself (55 Hz passes straight
  // through the tracker), leaving only high-frequency bleed. The envelope
  // flux is what actually sees the kick.
  const lp = new Float32Array(dsLen);
  const la = 1 - Math.exp(-2 * Math.PI * 160 / dsRate);
  let lpPrev = 0;
  for (let i = 0; i < dsLen; i++) {
    lpPrev += la * (ds[i] - lpPrev);
    lp[i] = lpPrev;
  }
  const env = new Float32Array(dsLen);
  const ea = 1 - Math.exp(-2 * Math.PI * 50 / dsRate);
  let ePrev = 0;
  for (let i = 0; i < dsLen; i++) {
    const sq = lp[i] * lp[i];
    ePrev += ea * (sq - ePrev);
    env[i] = ePrev;
  }
  const flux = new Float32Array(dsLen);
  for (let i = 1; i < dsLen; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
  const kickOnsets = pickOnsets(flux, dsRate, 4);

  const full = medianBpmFromOnsets(onsets);
  const kickRes = medianBpmFromOnsets(kickOnsets);
  // Prefer the kick stream when it is well-defined; otherwise full-band.
  const useKick = kickOnsets.length >= 4 && kickRes.bpm > 0 && kickRes.consistency >= 0.5;
  const chosen = useKick ? kickRes : full;
  const anchorOnsets = useKick ? kickOnsets : onsets;

  if (chosen.bpm <= 0 || anchorOnsets.length < 4) {
    return { bpm: 0, confidence: 0, downbeatOffset: -1, firstBeat: winStart / dsRate + (anchorOnsets[0] ?? onsets[0] ?? 0), tempoStability: 0 };
  }

  const bpm = chosen.bpm;
  const confidence = Math.min(0.95, chosen.consistency * 0.9);

  // Onset times are window-local; shift back into track time.
  const firstBeat = winStart / dsRate + anchorOnsets[0];
  const beats = generateBeats(bpm, buffer.duration, firstBeat);
  const downbeatOffset = detectDownbeat(ch, sr, beats);
  onProgress?.(0.9);
  return { bpm: Math.round(bpm * 10) / 10, confidence, downbeatOffset, firstBeat, tempoStability: chosen.stability };
}

// ─── General (lowpass peak) detector — fallback path ─────────────────────────

async function detectGeneral(buffer: AudioBuffer): Promise<Omit<BeatGrid, 'method' | 'beats' | 'bpmCurve'>> {
  const seconds = Math.min(30, buffer.duration);
  const offline = new OfflineAudioContext(1, Math.floor(buffer.sampleRate * seconds), buffer.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  const lp = offline.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 150;
  src.connect(lp);
  lp.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);

  const peaks: number[] = [];
  const threshold = 0.3;
  const debounce = Math.floor(buffer.sampleRate * 0.25);
  for (let i = 0; i < data.length; i++) {
    if (data[i] > threshold) {
      peaks.push(i);
      i += debounce;
    }
  }
  if (peaks.length < 10) {
    return { bpm: 0, confidence: 0, downbeatOffset: -1, firstBeat: 0, tempoStability: 0.3 };
  }

  const hist = new Map<number, number>();
  for (let i = 1; i < peaks.length; i++) {
    const bin = Math.round((peaks[i] - peaks[i - 1]) / 100) * 100;
    hist.set(bin, (hist.get(bin) ?? 0) + 1);
  }
  let bestBin = 0;
  let bestCount = 0;
  hist.forEach((count, bin) => {
    if (count > bestCount) { bestCount = count; bestBin = bin; }
  });
  if (!bestBin) return { bpm: 0, confidence: 0, downbeatOffset: -1, firstBeat: 0, tempoStability: 0.3 };

  const bpm = foldBpm((60 * buffer.sampleRate) / bestBin);
  const firstBeat = peaks[0] / buffer.sampleRate;
  const beats = generateBeats(bpm, buffer.duration, firstBeat);
  const downbeatOffset = detectDownbeat(buffer.getChannelData(0), buffer.sampleRate, beats);
  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence: Math.min(0.7, bestCount / peaks.length),
    downbeatOffset,
    firstBeat,
    tempoStability: 0.6,
  };
}

// ─── Spectral data (real 3-band, via OfflineAudioContext) ────────────────────

export async function analyzeSpectrum(buffer: AudioBuffer): Promise<SpectralData | undefined> {
  try {
    const targetRate = 100;
    const renderRate = 8000;
    const length = Math.max(1, Math.ceil(buffer.duration * renderRate));
    const ctx = new OfflineAudioContext(3, length, renderRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const low = ctx.createBiquadFilter();
    low.type = 'lowpass'; low.frequency.value = 200;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass'; high.frequency.value = 2000;

    const merger = ctx.createChannelMerger(3);
    source.connect(low); low.connect(merger, 0, 0);
    source.connect(mid); mid.connect(merger, 0, 1);
    source.connect(high); high.connect(merger, 0, 2);
    merger.connect(ctx.destination);
    source.start(0);
    const rendered = await ctx.startRendering();

    const ratio = Math.ceil(renderRate / targetRate);
    const outLen = Math.ceil(buffer.duration * targetRate);
    const process = (c: number) => {
      const inData = rendered.getChannelData(c);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        let max = 0;
        const start = i * ratio;
        const end = Math.min(start + ratio, inData.length);
        for (let j = start; j < end; j++) {
          const v = Math.abs(inData[j]);
          if (v > max) max = v;
        }
        out[i] = max;
      }
      return out;
    };
    return { low: process(0), mid: process(1), high: process(2) };
  } catch {
    return undefined;
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────

function yieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Analyze a track. Always returns a grid — but check `confidence`:
 * low confidence (< 0.4) means the grid is a guess and the UI should say so
 * (and the user should fix it in the grid editor). Never silently stamps 120.
 */
export async function analyzeTrack(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<AnalysisResult> {
  const electronic = await detectElectronic(buffer, onProgress);
  const general = electronic.confidence < 0.4 ? await detectGeneral(buffer) : null;
  const best = !general || general.confidence <= electronic.confidence ? electronic : general;
  const method = best === electronic ? 'electronic' as const : 'general' as const;
  const partial: Omit<BeatGrid, 'beats' | 'bpmCurve'> = { ...best, method };

  // Build the full beat map (tempo curve + snapped beat timestamps).
  // This is what the sync engine phase-locks against.
  let beats: number[] = [];
  let bpmCurve: number[] = [];
  let mapStability = partial.tempoStability;
  if (partial.bpm > 0) {
    try {
      const map = await buildBeatMap(
        buffer.getChannelData(0),
        buffer.sampleRate,
        buffer.duration,
        partial.bpm,
        partial.firstBeat,
        onProgress,
      );
      beats = map.beats;
      bpmCurve = map.bpmCurve;
      // Blend section-agreement into the reported stability
      mapStability = Math.min(partial.tempoStability, map.stability);
    } catch {
      // Beat map failed — engine falls back to bpm + firstBeat extrapolation
    }
  }

  const grid: BeatGrid = {
    ...partial,
    tempoStability: mapStability,
    beats,
    bpmCurve,
  };
  onProgress?.(0.95);
  debugLog('analysis', 'track analyzed', undefined, {
    bpm: grid.bpm,
    confidence: grid.confidence,
    method: grid.method,
    beats: beats.length,
    stability: grid.tempoStability,
  });
  const spectralData = await analyzeSpectrum(buffer);
  onProgress?.(1);
  return { grid, spectralData };
}

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
import { extendBeatsBackward } from './loop';

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
          // Dotted-eighth hijack: a section reading ~4/3 of base is
          // locking onto the dotted grid (the reported 122 -> 163 error),
          // not a real tempo change — the section tempo is base. A
          // genuine 33% tempo jump inside one 8 s section of a
          // steady-tempo track is not credible, so map it back to base
          // instead of letting the beat map run at the dotted rate.
          if (Math.abs(localBpm / baseBpm - 4 / 3) < 0.06) snapped = baseBpm;
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
    // No usable sections — fall back to flat extrapolation, extended
    // backward to 0 so the intro is gridded like the walked map below.
    const forward = generateBeats(baseBpm, duration, firstBeat);
    const ext = extendBeatsBackward(
      forward,
      new Array(Math.max(0, forward.length - 1)).fill(baseBpm),
      baseBpm,
    );
    return { beats: ext.beats, bpmCurve: ext.bpmCurve, stability: 0.3 };
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

  // Backward extension: the walk starts at firstBeat, so a quiet intro
  // before it had no mapped beats and launches snapped forward to it.
  // Extend at the first section's tempo so the intro is on the grid.
  // analyzeStructure runs against this map, so its anchor index/phase
  // are computed in the extended indexing and stay consistent.
  const ext = extendBeatsBackward(beats, bpmCurve, baseBpm);

  // Stability = agreement between sections
  const bpms = sections.map((s) => s.bpm);
  const mean = bpms.reduce((a, b) => a + b, 0) / bpms.length;
  const variance = bpms.reduce((a, b) => a + (b - mean) ** 2, 0) / bpms.length;
  const stability = Math.max(0.1, 1 - Math.sqrt(variance) / mean);

  onProgress?.(0.85);
  return { beats: ext.beats, bpmCurve: ext.bpmCurve, stability };
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

// ─── Track structure: auto 1.1 anchor + auto hotcues ────────────────────────

export interface StructureAnalysis {
  /** Downbeat time (seconds) of the auto-1.1 anchor bar, or null when no clear drop transition was found. */
  anchorTime: number | null;
  /** Beat-map index of the anchor downbeat (may be negative when the anchor predates the map); -1 when none. */
  anchorBeatIndex: number;
  /** Bar-phase residue (0..3) implied by the anchor, or null when no anchor. */
  barPhase: number | null;
  /** 4 auto hotcue times in seconds (null where undetectable), already snapped to downbeats. */
  autoHotcues: (number | null)[];
}

/**
 * Find the track's structure from its energy, reusing the already-decoded
 * audio (one linear downsample pass, no new decode, no per-frame work):
 *
 * - Per-beat kick-band (160 Hz lowpass, same one-pole as detectElectronic)
 *   and full-band mean-square energies, in 1-beat windows from t=0.
 * - AUTO 1.1: the first beat where kick energy sustains loud for 4+ bars
 *   after a quieter intro (sustained mean >= 0.6x the robust peak, every
 *   bar >= 0.4x peak, and the 8 beats before it under half the 16 beats
 *   after it). That beat becomes the grid's bar-phase origin. No such
 *   transition (loud from the start, no clear drop) => null anchor and
 *   the caller keeps the detector's existing downbeat behavior.
 * - AUTO HOTCUES, all snapped to downbeats of the anchor grid:
 *   HC1 = anchor (or the detector downbeat when no anchor),
 *   HC2 = first drop = first large sustained rise (>= 1.5x the previous
 *   16 beats and >= 0.5x peak) at least 32 beats after HC1, else the
 *   loudest bar after HC1,
 *   HC3 = breakdown = largest sustained fall (next 16 beats under 0.6x
 *   the previous 16, staying low) in the middle of the track, else a
 *   second rise after HC2, else the mid-track downbeat,
 *   HC4 = outro = last sustained fall in the final 40% after which
 *   energy stays under 0.6x peak to the end, else the last downbeat
 *   before the final 16 bars.
 *   Slots are kept >= 8 bars apart; a slot that cannot be placed cleanly
 *   stays null rather than duplicating another slot.
 * Exported for tests / harness diagnostics.
 */
export function analyzeStructure(
  channelData: Float32Array,
  sampleRate: number,
  bpm: number,
  beats: number[],
  downbeatOffset: number,
  firstBeat: number,
  duration: number,
): StructureAnalysis | null {
  if (!(bpm > 0) || !(duration > 0) || channelData.length === 0) return null;
  const spb = 60 / bpm;
  const barDur = 4 * spb;
  const TARGET_RATE = 8000;
  const ratio = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const dsRate = sampleRate / ratio;
  const nBeats = Math.max(1, Math.ceil(duration / spb));
  const kickSum = new Float64Array(nBeats);
  const fullSum = new Float64Array(nBeats);
  const cnt = new Float64Array(nBeats);
  const la = 1 - Math.exp(-2 * Math.PI * 160 / dsRate);
  let lpPrev = 0;
  const totalDs = Math.floor(channelData.length / ratio);
  for (let i = 0; i < totalDs; i++) {
    const v = channelData[i * ratio];
    lpPrev += la * (v - lpPrev);
    const b = Math.floor((i / dsRate) / spb);
    if (b < nBeats) {
      kickSum[b] += lpPrev * lpPrev;
      fullSum[b] += v * v;
      cnt[b] += 1;
    }
  }
  const kick = new Float64Array(nBeats);
  for (let b = 0; b < nBeats; b++) kick[b] = cnt[b] > 0 ? kickSum[b] / cnt[b] : 0;
  const mean = (arr: Float64Array, a: number, c: number): number => {
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(arr.length, c); i++) { s += arr[i]; n++; }
    return n > 0 ? s / n : 0;
  };
  // 4-beat (bar) kick means, one per beat offset.
  const barKick = new Float64Array(nBeats);
  for (let b = 0; b < nBeats; b++) barKick[b] = mean(kick, b, b + 4);
  // Robust peak: 95th percentile of bar kick means.
  const sorted = [...barKick].sort((a, c) => a - c);
  const peak = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  if (!(peak > 0)) return null;

  // AUTO 1.1: first sustained-loud bar after a quieter intro.
  let anchorBeat = -1;
  for (let i = 8; i + 16 < nBeats; i++) {
    const nextMean = mean(barKick, i, i + 4);
    let nextMin = Infinity;
    for (let k = 0; k < 4; k++) nextMin = Math.min(nextMin, barKick[i + k] ?? 0);
    const prevMean = mean(kick, i - 8, i);
    const next16 = mean(kick, i, i + 16);
    if (nextMean >= 0.6 * peak && nextMin >= 0.4 * peak && prevMean < 0.5 * next16) {
      anchorBeat = i;
      break;
    }
  }
  // Refine to the beat with the biggest kick jump within +-2 beats of the
  // sustained start, so the anchor lands on the drop's first kick.
  if (anchorBeat >= 0) {
    let bestB = anchorBeat;
    let bestJump = -Infinity;
    for (let b = Math.max(1, anchorBeat - 2); b <= Math.min(nBeats - 1, anchorBeat + 2); b++) {
      const jump = kick[b] - kick[b - 1];
      if (jump > bestJump) { bestJump = jump; bestB = b; }
    }
    if (bestJump > 0) anchorBeat = bestB;
  }

  // Convert the anchor beat to a beat-map index + time. Beat windows start
  // at t=0, so the anchor time is anchorBeat * spb; the map beat nearest
  // that time (or the flat extrapolation when the anchor predates the
  // map, which starts at the loudest window) becomes the downbeat.
  const beats0 = beats.length > 0 ? beats[0]
    : downbeatOffset >= 0 ? downbeatOffset
    : firstBeat >= 0 ? firstBeat : 0;
  let anchorTime: number | null = null;
  let anchorIndex = -1;
  let anchorPhase: number | null = null;
  if (anchorBeat >= 0) {
    const t = anchorBeat * spb;
    const j = Math.round((t - beats0) / spb);
    anchorIndex = j;
    anchorPhase = ((j % 4) + 4) % 4;
    anchorTime = j >= 0 && j < beats.length ? beats[j] : beats0 + j * spb;
  }

  // Downbeat grid the hotcues snap to: the anchor when found, else the
  // detector's downbeat (or first beat) — same origin the derived
  // bar-phase default uses, so hotcues agree with the grid.
  const origin = anchorTime ?? (downbeatOffset >= 0 ? downbeatOffset : firstBeat >= 0 ? firstBeat : 0);
  const snapDown = (t: number): number => {
    const k = Math.round((t - origin) / barDur);
    return origin + k * barDur;
  };

  const riseAfter = (fromBeat: number): number | null => {
    for (let i = fromBeat; i + 16 < nBeats; i++) {
      const prev = mean(kick, i - 16, i);
      const next = mean(kick, i, i + 16);
      if (prev > 0 && next >= 1.5 * prev && next >= 0.5 * peak) return i;
    }
    return null;
  };
  const originBeat = Math.round(origin / spb);
  const hc1 = origin;
  let hc2: number | null = null;
  const r2 = riseAfter(originBeat + 32);
  if (r2 !== null) hc2 = r2 * spb;
  else {
    let best = -1;
    let bestV = -1;
    for (let i = originBeat + 32; i < nBeats; i++) {
      if (barKick[i] > bestV) { bestV = barKick[i]; best = i; }
    }
    if (best >= 0 && bestV >= 0.5 * peak) hc2 = best * spb;
  }
  let hc3: number | null = null;
  {
    const hc2Beat = hc2 !== null ? Math.round(hc2 / spb) : originBeat;
    let bestRatio = Infinity;
    for (let i = hc2Beat + 32; i + 16 < Math.floor(nBeats * 0.85); i++) {
      const prev = mean(kick, i - 16, i);
      const next = mean(kick, i, i + 16);
      if (prev > 0 && next < 0.6 * prev && mean(barKick, i, i + 4) < 0.7 * prev) {
        const ratio = next / prev;
        if (ratio < bestRatio) { bestRatio = ratio; hc3 = i * spb; }
      }
    }
    if (hc3 === null) {
      const r3 = riseAfter(hc2Beat + 32);
      if (r3 !== null) hc3 = r3 * spb;
      else hc3 = (Math.round((duration * 0.5) / spb)) * spb;
    }
  }
  let hc4: number | null = null;
  {
    const fromB = Math.floor(nBeats * 0.6);
    for (let i = nBeats - 16; i >= fromB; i--) {
      const prev = mean(kick, i - 16, i);
      const next = mean(kick, i, i + 16);
      const tail = mean(kick, i, nBeats);
      if (prev > 0 && next < 0.5 * prev && tail < 0.6 * peak) { hc4 = i * spb; break; }
    }
    if (hc4 === null) hc4 = duration - 16 * barDur;
  }

  // Snap to downbeats, enforce ordering + >= 8 bars separation.
  const snapped: (number | null)[] = [hc1, hc2, hc3, hc4].map((t) => {
    if (t === null || !(t >= 0)) return null;
    let s = snapDown(t);
    if (s >= duration - 1) s -= barDur;
    if (s < 0) return null;
    return s;
  });
  for (let i = 1; i < snapped.length; i++) {
    if (snapped[i] === null || snapped[i - 1] === null) continue;
    if (snapped[i]! < snapped[i - 1]! + 8 * barDur) {
      let s = snapped[i - 1]! + 8 * barDur;
      if (s >= duration - 1) snapped[i] = null;
      else snapped[i] = s;
    }
  }
  return { anchorTime, anchorBeatIndex: anchorIndex, barPhase: anchorPhase, autoHotcues: snapped };
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
// ─── Multi-window consensus BPM (round 4) ────────────────────────────────
// Why: one window anywhere can be fooled. The round-2 loudest-window fix
// only helps QUIET intros. A MELODIC intro (dotted-eighth arp, weak or no
// kick) still yields a full-band stream that locks onto the dotted
// subdivision (120 -> 160), and any single window can also be fooled by a
// breakdown, a fill, or a half-time section. So: sample MANY windows
// across the whole track, let each window vote from its BEST stream
// (kick vs broadband transient — the lowpass kick stream is
// bass-polluted in real mastered drops, the transient stream stays
// clean there), weight votes by window energy (drops ARE the track),
// and decide by energy-weighted consensus with explicit 4/3 rival
// elimination. The global comb score is reported as drop-restricted
// diagnostic evidence only: on dense real mixes the all-onset comb
// ranks the dotted tempo ABOVE the true one, so it must not decide.

export interface ConsensusVote {
  start: number;
  bpm: number;
  weight: number;
  kind: 'kick' | 'fallback' | 'both';
  consistency: number;
  energyFactor: number;
}

export interface ConsensusResult {
  bpm: number;
  confidence: number;
  agreement: number;
  /**
   * Drop-restricted transient comb score (high-energy windows only).
   * Diagnostic evidence, NOT a decision input: on dense real mixes the
   * all-onset comb ranks the dotted tempo above the true one.
   */
  gridScore: number;
  /** Mean consistency of the winning cluster's votes. */
  meanConsistency: number;
  /** Weight share of surviving non-rival losing clusters (unexplained disagreement). */
  loserShare: number;
  windowsSelected: number;
  windowsVoted: number;
  steady: boolean;
  firstBeat: number;
  downbeatOffset: number;
  tempoStability: number;
  votes: ConsensusVote[];
  kickOnsets: number[];
}

const CONSENSUS_WIN_SEC = 12;
const CONSENSUS_HOP_SEC = 6;
const CONSENSUS_TARGET_WINDOWS = 12;
const CONSENSUS_RIVAL_RATIOS = [4 / 3, 3 / 4, 3 / 2, 2 / 3, 1 / 2, 2];

interface ConsensusStreams {
  ds: Float32Array;
  dsRate: number;
  flux: Float32Array;
  transient: Float32Array;
  kickOnsets: number[];
}

export function buildConsensusStreams(channelData: Float32Array, sampleRate: number): ConsensusStreams {
  const TARGET_RATE = 8000;
  const ratio = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const dsRate = sampleRate / ratio;
  const totalDs = Math.floor(channelData.length / ratio);
  const ds = new Float32Array(totalDs);
  for (let i = 0; i < totalDs; i++) ds[i] = channelData[i * ratio];
  const transient = new Float32Array(totalDs);
  let prev = 0;
  const alpha = 0.8;
  for (let i = 0; i < totalDs; i++) {
    const hp = ds[i] - prev;
    prev = ds[i] * (1 - alpha) + prev * alpha;
    transient[i] = Math.abs(hp) * 2;
  }
  const flux = new Float32Array(totalDs);
  const la = 1 - Math.exp(-2 * Math.PI * 160 / dsRate);
  const ea = 1 - Math.exp(-2 * Math.PI * 50 / dsRate);
  let lpPrev = 0;
  let ePrev = 0;
  for (let i = 0; i < totalDs; i++) {
    lpPrev += la * (ds[i] - lpPrev);
    const sq = lpPrev * lpPrev;
    const eNew = ePrev + ea * (sq - ePrev);
    flux[i] = Math.max(0, eNew - ePrev);
    ePrev = eNew;
  }
  const kickOnsets = pickOnsets(flux, dsRate, 4);
  return { ds, dsRate, flux, transient, kickOnsets };
}

export function selectConsensusWindows(
  duration: number,
  ds: Float32Array,
  dsRate: number,
): { start: number; end: number }[] {
  const cands: { start: number; energy: number }[] = [];
  for (let s = 0; s < duration; s += CONSENSUS_HOP_SEC) {
    const e = Math.min(duration, s + CONSENSUS_WIN_SEC);
    if (e - s < 3 && cands.length > 0) break;
    const i0 = Math.floor(s * dsRate);
    const i1 = Math.min(ds.length, Math.floor(e * dsRate));
    let sum = 0;
    for (let i = 0; i < i1; i++) sum += ds[i] * ds[i];
    cands.push({ start: s, energy: i1 > i0 ? sum / (i1 - i0) : 0 });
  }
  if (cands.length === 0) return [{ start: 0, end: duration }];
  if (cands.length === 1) return [{ start: 0, end: duration }];
  const byEnergy = [...cands].sort((a, b) => b.energy - a.energy);
  const picked: { start: number }[] = [];
  const add = (c: { start: number }): void => {
    if (!picked.some((p) => Math.abs(p.start - c.start) < 3)) picked.push(c);
  };
  for (let i = 0; i < Math.min(6, byEnergy.length); i++) add(byEnergy[i]);
  for (let i = 0; i < 6; i++) add(cands[Math.floor((i / 5) * (cands.length - 1))]);
  for (const c of byEnergy) {
    if (picked.length >= CONSENSUS_TARGET_WINDOWS) break;
    add(c);
  }
  picked.sort((a, b) => a.start - b.start);
  return picked
    .slice(0, CONSENSUS_TARGET_WINDOWS)
    .map((p) => ({ start: p.start, end: Math.min(duration, p.start + CONSENSUS_WIN_SEC) }));
}

// One window's vote: the BEST stream wins, not "kick first".
// Round-4 finding on real masters: the 160 Hz lowpass "kick" stream is
// bass-polluted in drops (extra bass-note flux breaks interval
// consistency), while the broadband transient stream stays clean there
// (sharp attacks on the grid). Conversely the intro arp pollutes BOTH
// streams at the dotted rate. So: compute both, merge when they agree
// within 1.5%, else take the higher-consistency one. Weight follows
// window energy (drops ARE the track; quiet intros/outros count less):
// w = base * (0.25 + 0.75 * E/Emax), base 1.0 merged, 0.75 single-stream.
function analyzeConsensusWindow(
  flux: Float32Array,
  transient: Float32Array,
  dsRate: number,
  start: number,
  end: number,
  energyFactor: number,
): ConsensusVote | null {
  const i0 = Math.floor(start * dsRate);
  const i1 = Math.min(flux.length, Math.floor(end * dsRate));
  if (i1 - i0 < dsRate * 3) return null;
  let kick: { bpm: number; consistency: number } | null = null;
  const kOn = pickOnsets(flux.subarray(i0, i1), dsRate, 4);
  if (kOn.length >= 4) {
    const r = medianBpmFromOnsets(kOn);
    if (r.bpm > 0 && r.consistency >= 0.5) kick = { bpm: r.bpm, consistency: r.consistency };
  }
  let fb: { bpm: number; consistency: number } | null = null;
  const fOn = pickOnsets(transient.subarray(i0, i1), dsRate, 4);
  if (fOn.length >= 8) {
    const r = medianBpmFromOnsets(fOn);
    if (r.bpm > 0 && r.consistency >= 0.6) fb = { bpm: r.bpm, consistency: r.consistency };
  }
  if (!kick && !fb) return null;
  if (kick && fb && Math.abs(kick.bpm - fb.bpm) / kick.bpm <= 0.015) {
    const bpm = (kick.bpm * kick.consistency + fb.bpm * fb.consistency) / (kick.consistency + fb.consistency);
    return { start, bpm, weight: 1 * energyFactor, kind: 'both', consistency: (kick.consistency + fb.consistency) / 2, energyFactor };
  }
  const kind = !kick ? 'fallback' : !fb ? 'kick' : kick.consistency >= fb.consistency ? 'kick' : 'fallback';
  const pick = kind === 'kick' ? kick! : fb!;
  return { start, bpm: pick.bpm, weight: 0.75 * energyFactor, kind, consistency: pick.consistency, energyFactor };
}

/** Fraction of onsets explained by a beat comb at `bpm` (best phase). */
export function kickGridScore(bpm: number, kickOnsets: number[]): number {
  if (kickOnsets.length === 0 || !(bpm > 0)) return 0;
  const p = 60 / bpm;
  const sigma = 0.035;
  const phases = 32;
  let best = 0;
  for (let k = 0; k < phases; k++) {
    const phi = (k / phases) * p;
    let s = 0;
    for (const t of kickOnsets) {
      let rel = (t - phi) % p;
      if (rel < 0) rel += p;
      const d = Math.min(rel, p - rel);
      s += Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    if (s > best) best = s;
  }
  return best / kickOnsets.length;
}

export async function detectConsensusBpm(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<ConsensusResult | null> {
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const duration = buffer.duration;
  if (!(duration > 0) || ch.length === 0) return null;
  const { ds, dsRate, flux, transient, kickOnsets } = buildConsensusStreams(ch, sr);
  const windows = selectConsensusWindows(duration, ds, dsRate);
  // Window energies (mean square) + peak, for energy-weighted votes.
  const winEnergy = windows.map((w) => {
    const i0 = Math.floor(w.start * dsRate);
    const i1 = Math.min(ds.length, Math.floor(w.end * dsRate));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += ds[i] * ds[i];
    return i1 > i0 ? sum / (i1 - i0) : 0;
  });
  const maxEnergy = winEnergy.reduce((m, e) => Math.max(m, e), 0);
  const votes: ConsensusVote[] = [];
  for (let w = 0; w < windows.length; w++) {
    const ef = maxEnergy > 0 ? 0.25 + 0.75 * (winEnergy[w] / maxEnergy) : 1;
    const v = analyzeConsensusWindow(flux, transient, dsRate, windows[w].start, windows[w].end, ef);
    if (v) votes.push(v);
    if ((w & 3) === 3) {
      onProgress?.(0.1 + 0.3 * ((w + 1) / windows.length));
      await yieldControl();
    }
  }
  if (votes.length === 0) return null;
  // Cluster votes within 1.5% (energy-weighted mean center).
  const clusters: { center: number; weight: number; votes: ConsensusVote[] }[] = [];
  for (const v of votes) {
    const c = clusters.find((cc) => Math.abs(v.bpm - cc.center) / cc.center <= 0.015);
    if (c) {
      c.center = (c.center * c.weight + v.bpm * v.weight) / (c.weight + v.weight);
      c.weight += v.weight;
      c.votes.push(v);
    } else {
      clusters.push({ center: v.bpm, weight: v.weight, votes: [v] });
    }
  }
  // Explicit rival elimination: clusters related by a simple ratio
  // (dotted 4/3, triplet 3/2, half-time 1/2, ...) cannot both be right.
  // The survivor is the HEAVIER cluster (energy-weighted votes): drops
  // outweigh intros, so the track's real tempo beats its intro arp.
  // (An earlier version picked the rival by global comb score; on real
  // dense mixes the comb ranks the dotted tempo ABOVE the true one —
  // the onset sets are too polluted — so the comb must not decide.)
  // Ties fall back to the slower tempo (in house/techno the kick IS
  // the beat; dotted subdivisions are ornament).
  const eliminated = new Set<number>();
  for (let i = 0; i < clusters.length; i++) {
    if (eliminated.has(i)) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      if (eliminated.has(j)) continue;
      const ratio = clusters[j].center / clusters[i].center;
      const isRival = CONSENSUS_RIVAL_RATIOS.some((r) => Math.abs(ratio - r) / r < 0.03);
      if (!isRival) continue;
      const a = clusters[i];
      const b = clusters[j];
      let loser: number;
      if (a.weight !== b.weight) loser = a.weight > b.weight ? j : i;
      else loser = a.center <= b.center ? j : i;
      eliminated.add(loser);
    }
  }
  const alive = clusters.filter((_, i) => !eliminated.has(i));
  let winner = alive[0];
  for (const c of alive) {
    if (c.weight > winner.weight) winner = c;
    else if (c.weight === winner.weight && c.center < winner.center) winner = c;
  }
  const totalWeight = votes.reduce((s, v) => s + v.weight, 0);
  const agreement = totalWeight > 0 ? winner.weight / totalWeight : 0;
  // Unexplained disagreement: weight of surviving clusters that are NOT
  // the winner and NOT explained away as rivals. A rival (dotted 4/3,
  // half-time, ...) is an artifact of the winner, not a competing
  // tempo, so it does not count here. A large unexplained loser means
  // the track may not have one steady tempo at all (tempo change).
  const loserWeight = alive.reduce((s, c) => (c === winner ? s : s + c.weight), 0);
  const loserShare = totalWeight > 0 ? loserWeight / totalWeight : 0;
  const winVotes = winner.votes;
  const meanConsistency = winVotes.reduce((s, v) => s + v.consistency, 0) / Math.max(1, winVotes.length);
  // Coverage: a tempo claim backed by 1-2 windows is weak evidence no
  // matter how well those windows agree (fl-track1: a single intro
  // vote must not yield a confident steady grid). Scale confidence by
  // coverage (full weight at 4+ voting windows) and require 3+ votes
  // for the steady grid.
  const coverageFactor = Math.min(1, votes.length / 4);
  const confidence = Math.min(0.95, agreement * meanConsistency * (1 - loserShare) * coverageFactor);
  // Drop-restricted transient comb: global grid evidence, reported for
  // diagnosis (NOT used to decide — the all-onset comb ranks dotted
  // above true on dense mixes). High-energy windows only, so intro
  // arp onsets cannot dominate it.
  const tOn = pickOnsets(transient, dsRate, 4);
  const dropOn: number[] = [];
  for (let w = 0; w < windows.length; w++) {
    if (maxEnergy > 0 && winEnergy[w] / maxEnergy >= 0.6) {
      for (const t of tOn) if (t >= windows[w].start && t < windows[w].end) dropOn.push(t);
    }
  }
  const bpm = Math.round(winner.center * 10) / 10;
  const gridScore = kickGridScore(bpm, dropOn);
  const firstBeat = kickOnsets.length > 0 ? kickOnsets[0] : 0;
  const provBeats = generateBeats(bpm, duration, firstBeat);
  const downbeatOffset = provBeats.length > 0 ? detectDownbeat(ch, sr, provBeats) : -1;
  onProgress?.(0.45);
  return {
    bpm,
    confidence,
    agreement,
    gridScore,
    meanConsistency,
    loserShare,
    windowsSelected: windows.length,
    windowsVoted: votes.length,
    steady: agreement >= 0.6 && loserShare < 0.3 && meanConsistency >= 0.5 && votes.length >= 3,
    firstBeat,
    downbeatOffset,
    tempoStability: agreement,
    votes,
    kickOnsets,
  };
}

function steadyBeatsFrom(origin: number, spb: number, duration: number): number[] {
  if (!(spb > 0) || !(origin >= 0)) return [];
  const nBack = Math.floor(origin / spb + 1e-9);
  const beats: number[] = [];
  for (let i = -nBack; ; i++) {
    const t = origin + i * spb;
    if (t >= duration) break;
    if (t >= 0) beats.push(t);
    if (i > 100000) break;
  }
  return beats;
}

export async function analyzeTrack(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<AnalysisResult> {
  // Round 4: multi-window consensus first. It votes only where kicks
  // exist, so melodic/dotted intros cannot hijack the base tempo the
  // way a single window could. Only when NO window votes do we fall
  // back to the legacy single-window detectors.
  const consensus = await detectConsensusBpm(buffer, onProgress);
  let partial: Omit<BeatGrid, 'beats' | 'bpmCurve'>;
  if (consensus && consensus.bpm > 0) {
    partial = {
      bpm: consensus.bpm,
      confidence: consensus.confidence,
      downbeatOffset: consensus.downbeatOffset,
      firstBeat: consensus.firstBeat,
      tempoStability: consensus.agreement,
      method: 'electronic',
    };
  } else {
    const electronic = await detectElectronic(buffer, onProgress);
    const general = electronic.confidence < 0.4 ? await detectGeneral(buffer) : null;
    const best = !general || general.confidence <= electronic.confidence ? electronic : general;
    const method = best === electronic ? 'electronic' as const : 'general' as const;
    partial = { ...best, method };
  }

  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const duration = buffer.duration;

  let beats: number[] = [];
  let bpmCurve: number[] = [];
  let mapStability = partial.tempoStability;
  let structure: StructureAnalysis | null = null;
  let steadyOrigin: number | null = null;

  if (partial.bpm > 0) {
    if (consensus && consensus.steady) {
      // Steady-tempo house/techno: ONE steady grid for the whole track.
      // Mapped/transient-snapped beats would reintroduce drift and
      // jitter into quantize, loops, and sync phase, so the steady grid
      // replaces them here. The mapped beat map is still built below
      // for non-steady tracks (tempo drift / tempo change), where the
      // steady assumption does not hold.
      const spb = 60 / partial.bpm;
      try {
        const provBeats = generateBeats(partial.bpm, duration, partial.firstBeat);
        structure = analyzeStructure(ch, sr, partial.bpm, provBeats, partial.downbeatOffset, partial.firstBeat, duration);
      } catch {
        structure = null;
      }
      const origin = structure?.anchorTime ?? (partial.downbeatOffset >= 0 ? partial.downbeatOffset : partial.firstBeat);
      beats = steadyBeatsFrom(origin >= 0 ? origin : 0, spb, duration);
      bpmCurve = new Array(Math.max(0, beats.length - 1)).fill(partial.bpm);
      steadyOrigin = beats.length > 0 ? origin : null;
      // Snap the anchor to the nearest real kick onset (±60 ms) so grid
      // phase is sample-tight, not just beat-quantized. Auto hotcues
      // shift by the same delta so they stay on the snapped grid.
      if (structure && structure.anchorTime !== null && consensus) {
        const a = structure.anchorTime;
        let best: number | null = null;
        let bestD = 0.06;
        for (const k of consensus.kickOnsets) {
          const d = Math.abs(k - a);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best !== null) {
          const delta = best - a;
          beats = steadyBeatsFrom(best, spb, duration);
          bpmCurve = new Array(Math.max(0, beats.length - 1)).fill(partial.bpm);
          steadyOrigin = best;
          structure = {
            ...structure,
            anchorTime: best,
            autoHotcues: structure.autoHotcues.map((t) => (t === null ? null : t + delta)),
          };
        }
      }
    } else {
      // Non-steady (or legacy fallback): the walked, transient-snapped
      // beat map, as before. This is what the sync engine phase-locks
      // against when the tempo is not steady.
      try {
        const map = await buildBeatMap(ch, sr, duration, partial.bpm, partial.firstBeat, onProgress);
        beats = map.beats;
        bpmCurve = map.bpmCurve;
        // Blend section-agreement into the reported stability
        mapStability = Math.min(partial.tempoStability, map.stability);
      } catch {
        // Beat map failed — engine falls back to bpm + firstBeat extrapolation
      }
    }
  }

  const grid: BeatGrid = {
    ...partial,
    tempoStability: mapStability,
    beats,
    bpmCurve,
  };
  if (consensus) {
    grid.agreement = consensus.agreement;
    grid.gridScore = consensus.gridScore;
  }
  // Smart grid: auto 1.1 anchor + auto hotcues from the track's energy.
  // Best-effort — a structure failure must never break the grid itself.
  // Reuses the decoded buffer (no new decode). For the steady path the
  // structure was already computed above against provisional beats; for
  // the mapped path it runs here against the walked map, as before.
  if (!structure) {
    try {
      structure = analyzeStructure(ch, sr, partial.bpm, beats, partial.downbeatOffset, partial.firstBeat, duration);
    } catch {
      structure = null;
    }
  }
  if (structure) {
    grid.autoHotcues = structure.autoHotcues;
    if (consensus && consensus.steady && steadyOrigin !== null) {
      // Steady grid: the origin IS a beat by construction; its index
      // residue is the bar phase, and it is the downbeat origin.
      const spb = 60 / partial.bpm;
      const idx = beats.length > 0 ? Math.round((steadyOrigin - beats[0]) / spb) : 0;
      grid.barPhase = ((idx % 4) + 4) % 4;
      grid.downbeatOffset = steadyOrigin;
      grid.firstBeat = beats.length > 0 ? beats[0] : partial.firstBeat;
    } else if (structure.anchorTime !== null && structure.barPhase !== null) {
      grid.barPhase = structure.barPhase;
      grid.downbeatOffset = structure.anchorTime;
    }
  }
  onProgress?.(0.95);
  debugLog('analysis', 'track analyzed', undefined, {
    bpm: grid.bpm,
    confidence: grid.confidence,
    method: grid.method,
    beats: beats.length,
    stability: grid.tempoStability,
    anchor: structure?.anchorTime ?? null,
    autoHotcues: structure?.autoHotcues ?? null,
    agreement: consensus?.agreement ?? null,
    gridScore: consensus?.gridScore ?? null,
    loserShare: consensus?.loserShare ?? null,
    meanConsistency: consensus?.meanConsistency ?? null,
    windows: consensus ? `${consensus.windowsVoted}/${consensus.windowsSelected}` : null,
    steady: consensus?.steady ?? null,
  });
  const spectralData = await analyzeSpectrum(buffer);
  onProgress?.(1);
  return { grid, spectralData };
}

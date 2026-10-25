// ─── Velz DJ core types ──────────────────────────────────────────────────────

export interface SpectralData {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export interface BeatGrid {
  /** Beats per minute (analyzed, at rate 1.0) — dominant/average tempo for display */
  bpm: number;
  /** Confidence 0..1 — below 0.4 the UI flags it for manual fixing */
  confidence: number;
  /** Time in seconds of the first DOWNBEAT (bar start). -1 if unknown. */
  downbeatOffset: number;
  /** Time in seconds of the first detected beat (any beat). */
  firstBeat: number;
  /** Tempo stability 0..1 */
  tempoStability: number;
  /** How the grid was derived */
  method: 'electronic' | 'general' | 'manual' | 'traktor';
  /**
   * Full beat timestamp map in seconds, from track start.
   * When present, sync phase-locks against these real positions instead of
   * extrapolating from bpm + firstBeat. Empty = fall back to extrapolation.
   */
  beats: number[];
  /**
   * Per-beat BPM curve, same length as beats (BPM between beats[i] and beats[i+1]).
   * Captures tempo drift within the track. Empty = constant bpm.
   */
  bpmCurve: number[];
}

/**
 * Precomputed waveform peaks (Phase 4): per-bucket envelope + band energy,
 * computed once at analysis time and cached in IndexedDB so waveforms are
 * instant (and identical) on every subsequent load.
 */
export interface BandPeaks {
  /** Buckets per second (100). */
  rate: number;
  duration: number;
  /** Per-bucket min/max of the mono-summed signal. */
  min: Float32Array;
  max: Float32Array;
  /** Per-bucket RMS of the mono-summed signal. */
  rms: Float32Array;
  /** Per-bucket peak energy per band (low <200Hz, mid ~1kHz, high >2kHz). */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds
  /** Detected BPM (convenience copy of beatGrid.bpm) */
  bpm: number;
  key?: string; // Camelot, e.g. "8A"
  beatGrid: BeatGrid;
  spectralData?: SpectralData;
  /** Precomputed band peaks for waveform rendering (Phase 4, IDB-cached). */
  peaks?: BandPeaks;
  /** Original file — kept so tracks can be (re)loaded to decks */
  file?: File;
  /** Stable library identity (name + size + last modified) — the
      IndexedDB key for this track's saved record, when it has one. */
  fileKey?: string;
  /** True for tracks restored from the saved library (stored beat grid +
      peaks, so loading one to a deck skips re-analysis). */
  restored?: boolean;
  /** True while background analysis is still running */
  analyzing?: boolean;
  /** 0..1 analysis progress (meaningful while analyzing) */
  analysisProgress?: number;
}

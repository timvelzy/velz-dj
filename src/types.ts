// ─── Velz DJ core types ──────────────────────────────────────────────────────

export interface SpectralData {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export interface BeatGrid {
  /** Beats per minute (analyzed, at rate 1.0) */
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
  method: 'electronic' | 'general' | 'manual';
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
  /** Original file — kept so tracks can be (re)loaded to decks */
  file?: File;
  /** True while background analysis is still running */
  analyzing?: boolean;
  /** 0..1 analysis progress (meaningful while analyzing) */
  analysisProgress?: number;
}

/**
 * AI channel: pre-generated loop instrument.
 *
 * Design (the honest version):
 *  - A "backend" generates 4/8-bar loops at a target BPM + key. Generation
 *    happens AHEAD of time; 2–3 loops stay queued; drop-ins are quantized to
 *    the master bar boundary with a 1-beat crossfade (see engine.playAiLoop).
 *  - If no backend is configured, the UI says so. There is NO fake path that
 *    pretends to generate with a setTimeout. The included DemoSynthBackend is
 *    a real (if simple) synthesized loop generator, clearly labeled DEMO.
 *
 * Plugging in a real backend (e.g. Vertex Lyria via a server endpoint, or
 * Stable Audio's API): implement the AIGenerationBackend interface — the queue
 * calls generate() with the target BPM, key, bars and a prompt/style, and
 * expects an AudioBuffer back. See README for the full walkthrough.
 */

import type { BeatGrid } from '../types';

export interface LoopSpec {
  bpm: number; // target master BPM
  key: string; // Camelot, e.g. "8A" — "" = don't care
  bars: 4 | 8;
  style: string; // free text hint for the backend ("deep house drums", ...)
}

export interface GeneratedLoop {
  buffer: AudioBuffer;
  grid: BeatGrid; // measured, not assumed
  key: string;
  spec: LoopSpec;
  backendName: string;
  generatedAt: number;
}

export interface AIGenerationBackend {
  readonly name: string;
  readonly isConfigured: boolean;
  readonly statusHint: string; // shown in the UI when not configured
  /**
   * True when the backend renders at a mathematically exact BPM (like the
   * demo synth). External model backends should leave this false so the
   * loop is MEASURED with the beat detector instead of trusted.
   */
  readonly knownExactBpm?: boolean;
  generate(spec: LoopSpec, ctx: BaseAudioContext): Promise<AudioBuffer>;
}

// ─── Demo synth backend (honest, labeled DEMO in the UI) ────────────────────
// A real synthesized loop: kick/hats/snare/clap pattern + sub bass following
// the key's root note, rendered offline at exactly the target BPM.

const NOTE_PC: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

function camelotToRootFreq(camelot: string): number {
  // Parse "8A" → A minor → root A. Default to A1 (55 Hz) when unknown.
  const m = /^(\d{1,2})([AB])$/i.exec(camelot.trim());
  if (!m) return 55;
  const minor = m[2].toUpperCase() === 'A';
  const num = parseInt(m[1], 10);
  const minorRoots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const majorRoots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Camelot number → root name
  const minorNumToName: Record<number, string> = { 5: 'C', 12: 'C#', 7: 'D', 2: 'D#', 9: 'E', 4: 'F', 11: 'F#', 6: 'G', 1: 'G#', 8: 'A', 3: 'A#', 10: 'B' };
  const majorNumToName: Record<number, string> = { 8: 'C', 3: 'C#', 10: 'D', 5: 'D#', 12: 'E', 7: 'F', 2: 'F#', 9: 'G', 4: 'G#', 11: 'A', 6: 'A#', 1: 'B' };
  const name = minor ? minorNumToName[num] : majorNumToName[num];
  if (!name) return 55;
  const pc = NOTE_PC[name];
  // A1 = 55 Hz is pc 9 → midi 33
  const midi = 33 + (((pc - 9) % 12) + 12) % 12;
  void minorRoots; void majorRoots;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class DemoSynthBackend implements AIGenerationBackend {
  readonly name = 'Demo Synth (built-in)';
  readonly isConfigured = true;
  readonly knownExactBpm = true;
  readonly statusHint = 'Synthesized demo loops — real audio, simple patterns.';

  async generate(spec: LoopSpec, ctx: BaseAudioContext): Promise<AudioBuffer> {
    const spb = 60 / spec.bpm;
    const beats = spec.bars * 4;
    const dur = beats * spb;
    const sr = 44100;
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);

    const master = off.createGain();
    master.gain.value = 0.9;
    master.connect(off.destination);

    const noiseBuf = off.createBuffer(1, sr * 1, sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const kick = (t: number) => {
      const o = off.createOscillator();
      const g = off.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.3);
    };
    const hat = (t: number, open: boolean) => {
      const s = off.createBufferSource();
      s.buffer = noiseBuf;
      const f = off.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 7500;
      const g = off.createGain();
      const d = open ? 0.28 : 0.06;
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t); s.stop(t + d + 0.02);
    };
    const snare = (t: number) => {
      const s = off.createBufferSource();
      s.buffer = noiseBuf;
      const f = off.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
      const g = off.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t); s.stop(t + 0.2);
    };
    const bass = (t: number, durBeats: number, freq: number) => {
      const o = off.createOscillator();
      const g = off.createGain();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const f = off.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 220;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.setValueAtTime(0.4, t + durBeats * spb * 0.8);
      g.gain.exponentialRampToValueAtTime(0.001, t + durBeats * spb);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); o.stop(t + durBeats * spb + 0.05);
    };

    const root = camelotToRootFreq(spec.key);
    // Pattern: 4-on-the-floor kick, offbeat hats, snare on 2&4, sub bass on root
    const stepsPerBeat = 2; // 8th notes
    const totalSteps = beats * stepsPerBeat;
    for (let s = 0; s < totalSteps; s++) {
      const t = s * (spb / stepsPerBeat);
      const beatInBar = (s / stepsPerBeat) % 4;
      if (s % stepsPerBeat === 0) kick(t);
      if (s % stepsPerBeat === stepsPerBeat / 2) hat(t, false);
      if (beatInBar === 1 || beatInBar === 3) snare(t);
      if (s % (stepsPerBeat * 4) === stepsPerBeat * 8) hat(t, true); // open hat each 2 bars
    }
    // Bassline: root, root, fifth, root pattern per bar
    for (let bar = 0; bar < spec.bars; bar++) {
      const bt = bar * 4 * spb;
      bass(bt, 1, root);
      bass(bt + spb, 1, root);
      bass(bt + 2 * spb, 1, root * 1.5);
      bass(bt + 3 * spb, 1, root);
    }

    const rendered = await off.startRendering();
    // Exact-length trim (offline render is already exact, but be safe)
    const targetLen = Math.round(dur * rendered.sampleRate);
    if (Math.abs(rendered.length - targetLen) > 2) {
      const trimmed = new AudioBuffer({ length: targetLen, sampleRate: rendered.sampleRate, numberOfChannels: 2 });
      for (let c = 0; c < 2; c++) trimmed.copyToChannel(rendered.getChannelData(c).subarray(0, targetLen), c);
      return trimmed;
    }
    return rendered;
  }
}

// ─── Loop queue ─────────────────────────────────────────────────────────────
// Keeps 2–3 loops generated ahead of time at the CURRENT master BPM/key.
// When the master BPM changes materially, the queue is invalidated and
// regenerated — a loop is only ever "in key/tempo" for the BPM it was made at.

import { detectKey } from './keydetect';
import { analyzeTrack } from './analysis';

export interface QueueState {
  loops: GeneratedLoop[];
  generating: boolean;
  backendName: string;
  error: string | null;
}

export class LoopQueue {
  private loops: GeneratedLoop[] = [];
  private generating = false;
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private genToken = 0;
  backend: AIGenerationBackend;

  constructor(backend: AIGenerationBackend) {
    this.backend = backend;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  get state(): QueueState {
    return {
      loops: [...this.loops],
      generating: this.generating,
      backendName: this.backend.name,
      error: this.error,
    };
  }

  /** Measure a generated buffer: real BPM grid + key. Never assumed (unless the backend is exact). */
  private async measure(buffer: AudioBuffer, spec: LoopSpec): Promise<GeneratedLoop> {
    let grid: BeatGrid;
    if (this.backend.knownExactBpm) {
      const spb = 60 / spec.bpm;
      grid = {
        bpm: spec.bpm,
        confidence: 1, // synthesized at an exact tempo — known, not detected
        downbeatOffset: 0,
        firstBeat: 0,
        tempoStability: 1,
        method: 'manual',
      };
      void spb;
    } else {
      // External model output: run the real detector, don't trust the request.
      const { grid: detected } = await analyzeTrack(buffer);
      grid = detected;
    }
    const key = detectKey(buffer);
    return {
      buffer,
      grid,
      key: key.key,
      spec,
      backendName: this.backend.name,
      generatedAt: Date.now(),
    };
  }

  /**
   * Ensure `count` loops exist for the given master BPM/key. Invalidates the
   * queue if the target changed by more than 0.5 BPM.
   */
  async ensure(bpm: number, key: string, bars: 4 | 8, style: string, ctx: BaseAudioContext, count = 3): Promise<void> {
    if (!this.backend.isConfigured) {
      this.error = this.backend.statusHint;
      this.emit();
      return;
    }
    const stale = this.loops.some((l) => Math.abs(l.spec.bpm - bpm) > 0.5 || l.spec.bars !== bars);
    if (stale) this.loops = [];
    if (this.loops.length >= count || this.generating) return;

    const token = ++this.genToken;
    this.generating = true;
    this.error = null;
    this.emit();
    try {
      while (this.loops.length < count) {
        if (token !== this.genToken) return; // superseded
        const buf = await this.backend.generate({ bpm, key, bars, style }, ctx);
        if (token !== this.genToken) return;
        // Sanity: reject loops that are materially off-length
        const expected = bars * 4 * (60 / bpm);
        if (Math.abs(buf.duration - expected) > 0.05) {
          throw new Error(`Backend returned a ${buf.duration.toFixed(2)}s loop, expected ${expected.toFixed(2)}s`);
        }
        this.loops.push(await this.measure(buf, { bpm, key, bars, style }));
        this.emit();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Generation failed';
      this.emit();
    } finally {
      if (token === this.genToken) {
        this.generating = false;
        this.emit();
      }
    }
  }

  /** Take the oldest queued loop (for drop-in). */
  take(): GeneratedLoop | null {
    const loop = this.loops.shift() ?? null;
    this.emit();
    return loop;
  }

  invalidate(): void {
    this.genToken++;
    this.loops = [];
    this.emit();
  }
}

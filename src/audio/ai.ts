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
 * Real backend (2026-10-24): LyriaLoopBackend implements the
 * AIGenerationBackend interface against the Gemini API Interactions API
 * (ai.google.dev/gemini-api/docs/music-generation) with model
 * 'lyria-3-clip-preview' — real AI-generated 30 s MP3 clips, sliced to the
 * requested bar length. The queue calls generate() with the target BPM,
 * key, bars and a prompt/style, and expects an AudioBuffer back.
 * Lyria RealTime (models/lyria-realtime-exp, steerable live session) is
 * NOT built here — a future steering option only.
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
  /** 'demo-synth' = procedural in-engine synth (honest DEMO label);
   *  'lyria' = real Gemini AI generation. The UI badges on this, never on prose. */
  readonly kind: 'demo-synth' | 'lyria';
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
  readonly name = 'Built-in Synth (procedural)';
  readonly kind = 'demo-synth' as const;
  readonly isConfigured = true;
  readonly knownExactBpm = true;
  readonly statusHint = 'Procedurally synthesized loops — real audio generated in-engine, no network needed.';
  private callCount = 0;

  async generate(spec: LoopSpec, ctx: BaseAudioContext): Promise<AudioBuffer> {
    // Variation seed: each call varies the bass rhythm, progression
    // rotation and hat placement so queued loops aren't identical.
    const seed = ++this.callCount;
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
    const openHatEvery = seed % 2 === 0 ? 8 : 16; // steps between open hats (variation)
    for (let s = 0; s < totalSteps; s++) {
      const t = s * (spb / stepsPerBeat);
      const beatInBar = (s / stepsPerBeat) % 4;
      if (s % stepsPerBeat === 0) kick(t);
      if (s % stepsPerBeat === stepsPerBeat / 2) hat(t, false);
      if (beatInBar === 1 || beatInBar === 3) snare(t);
      if (s % openHatEvery === openHatEvery - 1) hat(t, true);
    }
    // Bassline: per-seed rhythm variant around root / fifth movement
    const bassPatterns: number[][] = [
      [0, 1, 1.5, 1], // beats within the bar, ×root (1.5 = fifth)
      [0, 0.5, 1, 1.5],
      [0, 1, 1, 1.189], // fifth, fifth, minor third-ish color
    ];
    const bassPat = bassPatterns[seed % bassPatterns.length];
    for (let bar = 0; bar < spec.bars; bar++) {
      const bt = bar * 4 * spb;
      bass(bt, 1, root);
      bass(bt + spb, 1, root * bassPat[1]);
      bass(bt + 2 * spb, 1, root * bassPat[2]);
      bass(bt + 3 * spb, 1, root * bassPat[3]);
    }

    // Pad: detuned saw triad per 2 bars, slow swell, lowpassed, quiet —
    // gives the loop a harmonic bed in the target key.
    const keyMatch = /^(\d{1,2})([AB])$/i.exec(spec.key.trim());
    const isMinor = !keyMatch || keyMatch[2].toUpperCase() === 'A';
    const prog: { semi: number; minor: boolean }[] = isMinor
      ? [{ semi: 0, minor: true }, { semi: 3, minor: false }, { semi: 8, minor: false }, { semi: 10, minor: false }]
      : [{ semi: 0, minor: false }, { semi: 7, minor: false }, { semi: 9, minor: true }, { semi: 5, minor: false }];
    const pad = (t: number, durBeats: number, chordRoot: number, chordMinor: boolean) => {
      const third = Math.pow(2, (chordMinor ? 3 : 4) / 12);
      for (const f of [chordRoot, chordRoot * third, chordRoot * 1.5]) {
        for (const det of [0.998, 1.002]) {
          const o = off.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = f * det;
          const flt = off.createBiquadFilter();
          flt.type = 'lowpass';
          flt.frequency.value = 850;
          const g = off.createGain();
          const d = durBeats * spb;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.045, t + Math.min(0.5, d * 0.3));
          g.gain.setValueAtTime(0.045, t + d * 0.7);
          g.gain.exponentialRampToValueAtTime(0.001, t + d);
          o.connect(flt); flt.connect(g); g.connect(master);
          o.start(t); o.stop(t + d + 0.05);
        }
      }
    };
    const padBase = root * 4; // two octaves above the sub root
    const rot = seed % prog.length;
    for (let slot = 0; slot * 2 < spec.bars; slot++) {
      const chord = prog[(slot + rot) % prog.length];
      pad(slot * 8 * spb, 8, padBase * Math.pow(2, chord.semi / 12), chord.minor);
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

// ─── Gemini Lyria backend (real AI generation) ──────────────────────────────
// Verified against Google's own docs (ai.google.dev/gemini-api/docs/music-generation):
//   import { GoogleGenAI } from '@google/genai';
//   const client = new GoogleGenAI({ apiKey });
//   const interaction = await client.interactions.create({
//     model: 'lyria-3-clip-preview', input: prompt,
//   });
//   interaction.output_audio.data  → base64 MP3, 44.1 kHz stereo, 30 s fixed.
// REST equivalent: POST https://generativelanguage.googleapis.com/v1beta/interactions
// with header x-goog-api-key and body { model, input }.
//
// The API key is NEVER hardcoded or committed. Resolution order:
//   1. localStorage 'velz-dj:gemini-api-key' — set in the AI deck's key field.
//      This works on the deployed Azure site with no rebuild: it is the
//      recommended route for Tim.
//   2. VITE_GEMINI_API_KEY at build time (dev builds / .env).
// Get a key at Google AI Studio. Without a key, App.tsx selects the
// clearly-labeled DemoSynthBackend — nothing ever pretends to be AI audio.
// knownExactBpm stays false, so Lyria output is re-measured by the beat
// detector before it can be dropped.

export const GEMINI_KEY_STORAGE = 'velz-dj:gemini-api-key';

export function resolveGeminiApiKey(): string {
  try {
    const stored = window.localStorage.getItem(GEMINI_KEY_STORAGE);
    if (stored && stored.trim()) return stored.trim();
  } catch { /* private mode etc. — fall through to build-time env */ }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_GEMINI_API_KEY?.trim() ?? '';
}

/** Camelot ("8A") → musical key name ("A minor") for the Lyria prompt. */
export function camelotToKeyName(camelot: string): string {
  const m = /^(\d{1,2})([AB])$/i.exec(camelot.trim());
  if (!m) return '';
  const minor = m[2].toUpperCase() === 'A';
  const num = parseInt(m[1], 10);
  const minorNumToName: Record<number, string> = { 5: 'C', 12: 'C#', 7: 'D', 2: 'D#', 9: 'E', 4: 'F', 11: 'F#', 6: 'G', 1: 'G#', 8: 'A', 3: 'A#', 10: 'B' };
  const majorNumToName: Record<number, string> = { 8: 'C', 3: 'C#', 10: 'D', 5: 'D#', 12: 'E', 7: 'F', 2: 'F#', 9: 'G', 4: 'G#', 11: 'A', 6: 'A#', 1: 'B' };
  const name = minor ? minorNumToName[num] : majorNumToName[num];
  if (!name) return '';
  return `${name} ${minor ? 'minor' : 'major'}`;
}

/** Map a loop spec to the Lyria text prompt. Exported for testing. */
export function buildLyriaPrompt(spec: LoopSpec): string {
  const style = spec.style.trim() || 'house';
  const keyName = camelotToKeyName(spec.key);
  const keyPart = keyName ? ` in ${keyName}` : '';
  return `An instrumental ${style} DJ loop at ${spec.bpm.toFixed(1)} BPM${keyPart}, ${spec.bars} bars, loopable, steady dance groove, no vocals.`;
}

export interface LyriaInteraction {
  output_audio?: { data?: string } | null;
  output_text?: string | null;
}

export type LyriaClient = {
  interactions: {
    create: (params: { model: string; input: string }) => Promise<LyriaInteraction>;
  };
};

export interface LyriaLoopConfig {
  apiKey: string;
  model?: 'lyria-3-clip-preview' | 'lyria-3.5';
  /** Injectable client factory — the plumbing test passes a stub. */
  clientFactory?: (apiKey: string) => Promise<LyriaClient>;
}

/** Lyria 3 Clip always returns a fixed 30-second clip (per Google's docs). */
const LYRIA_CLIP_SECONDS = 30;

export class LyriaLoopBackend implements AIGenerationBackend {
  readonly kind = 'lyria' as const;
  readonly name = 'Gemini Lyria (lyria-3-clip-preview)';
  readonly knownExactBpm = false;
  readonly statusHint =
    'Real AI generation via the Gemini API (Lyria 3 Clip). Needs a Gemini API key — paste one in the AI deck key field.';
  readonly model: string;

  constructor(private config: LyriaLoopConfig) {
    this.model = config.model ?? 'lyria-3-clip-preview';
  }

  get isConfigured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  private async defaultClient(apiKey: string): Promise<LyriaClient> {
    // Dynamic import: the @google/genai SDK only loads when Lyria is
    // actually used, keeping it out of the initial bundle for live DJing.
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey });
    return {
      interactions: {
        create: async (params) =>
          (await client.interactions.create(params)) as unknown as LyriaInteraction,
      },
    };
  }

  async generate(spec: LoopSpec, ctx: BaseAudioContext): Promise<AudioBuffer> {
    if (!this.isConfigured) {
      throw new Error(
        'No Gemini API key configured. Paste a Gemini API key in the AI deck key field ' +
        '(stored only in this browser) or set VITE_GEMINI_API_KEY at build time.',
      );
    }
    const prompt = buildLyriaPrompt(spec);
    const factory = this.config.clientFactory ?? ((key: string) => this.defaultClient(key));
    const client = await factory(this.config.apiKey);
    const interaction = await client.interactions.create({ model: this.model, input: prompt });
    const b64 = interaction.output_audio?.data;
    if (!b64) {
      throw new Error(
        'Lyria returned no audio. The request may have been filtered or the model returned text only — try a different style prompt.',
      );
    }
    // base64 → bytes (browser-safe, no Node Buffer).
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const clip = await ctx.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    // Slice the fixed-length clip to the requested bar length at target BPM.
    const targetDur = spec.bars * 4 * (60 / spec.bpm);
    if (targetDur > clip.duration + 0.05) {
      throw new Error(
        `Requested loop (${spec.bars} bars at ${spec.bpm.toFixed(1)} BPM = ${targetDur.toFixed(1)}s) ` +
        `is longer than Lyria's fixed ${LYRIA_CLIP_SECONDS}s clip. Use fewer bars or a faster tempo.`,
      );
    }
    const targetLen = Math.round(targetDur * clip.sampleRate);
    if (Math.abs(clip.length - targetLen) <= 2) return clip;
    const sliced = new AudioBuffer({
      length: targetLen,
      sampleRate: clip.sampleRate,
      numberOfChannels: clip.numberOfChannels,
    });
    for (let c = 0; c < clip.numberOfChannels; c++) {
      sliced.copyToChannel(clip.getChannelData(c).subarray(0, targetLen), c);
    }
    return sliced;
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
        beats: [],
        bpmCurve: [],
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

  /** Swap the generation backend (e.g. when a Gemini key is saved/cleared
   *  in the AI deck). Drops the queued loops: they belong to the old backend. */
  setBackend(backend: AIGenerationBackend): void {
    this.backend = backend;
    this.invalidate();
    this.error = null;
    this.emit();
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

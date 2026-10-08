/**
 * Velz DJ — AudioEngine v2.
 *
 * What this fixes vs the predecessors (see /tmp/repo-eval/evaluation-report.md):
 *  - REAL time-stretching: tempo goes through a WSOLA AudioWorklet
 *    (src/audio/wsola-processor.ts), not raw playbackRate. Pitch is preserved
 *    when keyLock is on; keyLock off = vinyl-style pitch shift.
 *  - Sample-accurate position tracking: track position integrates tempo over
 *    audio-clock time (fixes waveform playhead drift when tempo/nudge change).
 *  - Continuous sync: a phase-locked loop corrects slave tempo toward the
 *    master every 100ms (not one-shot), plus one-shot bar alignment on play.
 *  - Momentary nudge (fixes the latching nudge bug).
 *  - Equal-power crossfader (fixes the center dip).
 *  - Real cue isolation (cue bus only carries cued decks).
 *  - Master clock lives in the engine (audio time), not React state.
 */

import type { BeatGrid } from '../types';
import wsolaWorkletUrl from './wsola-processor.ts?worker&url';

export interface DeckNodes {
  id: string;
  source: AudioBufferSourceNode | null;
  stretch: AudioWorkletNode;
  trim: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  filter: BiquadFilterNode;
  analyser: AnalyserNode;
  fader: GainNode;
  xfade: GainNode;
  cueGain: GainNode;
  buffer: AudioBuffer | null;
  grid: BeatGrid | null;
  // Position integration (track seconds; advances at posRate)
  posBase: number;
  posBaseTime: number;
  posRate: number;
  // Tempo model
  userTempo: number; // from the tempo fader
  syncBaseTempo: number; // tempo-follow value while synced
  syncCorr: number; // continuous phase correction multiplier (~1.0)
  nudge: number; // momentary pitch bend, e.g. ±0.05
  keyLock: boolean;
  syncOn: boolean;
  loopStart: number | null;
  loopEnd: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Wrap value into [-range/2, range/2). */
const wrapCentered = (v: number, range: number) => {
  const r = ((v % range) + range) % range;
  return r >= range / 2 ? r - range : r;
};

export class DJEngine {
  ctx!: AudioContext;
  private workletReady = false;

  // Buses
  private masterBus!: GainNode;
  private cueBus!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private masterGain!: GainNode;
  private phonesGain!: GainNode;
  private cueToPhones!: GainNode;
  private masterToPhones!: GainNode;
  private masterAnalyser!: AnalyserNode;
  private phonesAnalyser!: AnalyserNode;

  // Device routing (master + headphones on separate devices via setSinkId)
  private masterDest!: MediaStreamAudioDestinationNode;
  private phonesDest!: MediaStreamAudioDestinationNode;
  private masterEl!: HTMLAudioElement;
  private phonesEl!: HTMLAudioElement;

  decks = new Map<string, DeckNodes>();
  masterDeckId: string | null = null;

  private syncTimer: number | null = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Must be called from a user gesture. */
  async init(): Promise<void> {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });

    await this.ctx.audioWorklet.addModule(wsolaWorkletUrl);
    this.workletReady = true;

    this.masterBus = this.ctx.createGain();
    this.cueBus = this.ctx.createGain();

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.ratio.value = 12;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.phonesGain = this.ctx.createGain();
    this.phonesGain.gain.value = 0.8;
    this.cueToPhones = this.ctx.createGain();
    this.masterToPhones = this.ctx.createGain();

    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.phonesAnalyser = this.ctx.createAnalyser();
    this.phonesAnalyser.fftSize = 256;

    // Master chain: bus → compressor → master gain → analyser → device element
    this.masterBus.connect(this.compressor);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);

    // Headphone chain: cue bus + master tap → phones gain → analyser → device element
    this.cueBus.connect(this.cueToPhones);
    this.cueToPhones.connect(this.phonesGain);
    this.masterGain.connect(this.masterToPhones);
    this.masterToPhones.connect(this.phonesGain);
    this.phonesGain.connect(this.phonesAnalyser);

    // Device routing via MediaStreamDestination + <audio> (setSinkId)
    this.masterDest = this.ctx.createMediaStreamDestination();
    this.phonesDest = this.ctx.createMediaStreamDestination();
    this.masterAnalyser.connect(this.masterDest);
    this.phonesAnalyser.connect(this.phonesDest);
    this.masterEl = new Audio();
    this.phonesEl = new Audio();
    this.masterEl.srcObject = this.masterDest.stream;
    this.phonesEl.srcObject = this.phonesDest.stream;

    // Default cue/master phones mix: 50/50 equal power
    this.setCueMix(0.5);

    this.initDeck('deckA');
    this.initDeck('deckB');
    this.initDeck('deckC');

    // Continuous sync PLL
    this.syncTimer = window.setInterval(() => this.syncTick(), 100);
  }

  async resume(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    try {
      await this.masterEl.play();
      await this.phonesEl.play();
    } catch {
      /* autoplay policy — will start on next gesture */
    }
  }

  destroy(): void {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  // ─── Deck graph ───────────────────────────────────────────────────────────

  initDeck(id: string): void {
    if (this.decks.has(id)) return;
    const ctx = this.ctx;

    const stretch = new AudioWorkletNode(ctx, 'velz-wsola', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const trim = ctx.createGain();
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 200;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3000;
    const filter = ctx.createBiquadFilter();
    filter.type = 'allpass'; filter.frequency.value = 20000;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const fader = ctx.createGain();
    fader.gain.value = 0.8;
    const xfade = ctx.createGain();
    xfade.gain.value = 1;
    const cueGain = ctx.createGain();
    cueGain.gain.value = 0; // cue OFF by default — real isolation

    // Chain: source → stretch → trim → EQ → filter → analyser → fader → xfade → masterBus
    //                                                              ↳ cueGain → cueBus
    stretch.connect(trim);
    trim.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(filter);
    filter.connect(analyser);
    analyser.connect(fader);
    fader.connect(xfade);
    xfade.connect(this.masterBus);
    analyser.connect(cueGain);
    cueGain.connect(this.cueBus);

    this.decks.set(id, {
      id,
      source: null,
      stretch,
      trim, eqLow, eqMid, eqHigh, filter, analyser, fader, xfade, cueGain,
      buffer: null,
      grid: null,
      posBase: 0, posBaseTime: ctx.currentTime, posRate: 1,
      userTempo: 1, syncBaseTempo: 1, syncCorr: 1, nudge: 0,
      keyLock: true,
      syncOn: false,
      loopStart: null, loopEnd: null,
    });
  }

  // ─── Tempo model ──────────────────────────────────────────────────────────
  // effectiveTempo = (syncOn && !isMaster ? syncBaseTempo : userTempo)
  //                  × (1 + nudge) × syncCorr
  // keyLock ON : source.playbackRate = 1, worklet tempo = effectiveTempo (pitch preserved)
  // keyLock OFF: source.playbackRate = effectiveTempo, worklet bypassed (vinyl pitch shift)

  private effectiveTempo(d: DeckNodes): number {
    const base = d.syncOn && d.id !== this.masterDeckId ? d.syncBaseTempo : d.userTempo;
    return base * (1 + d.nudge) * d.syncCorr;
  }

  private applyTempo(d: DeckNodes): void {
    const t = this.ctx.currentTime;
    const eff = this.effectiveTempo(d);
    if (d.keyLock) {
      if (d.source) d.source.playbackRate.setTargetAtTime(1, t, 0.02);
      d.stretch.port.postMessage({ type: 'setTempo', tempo: eff });
    } else {
      d.stretch.port.postMessage({ type: 'setTempo', tempo: 1 });
      if (d.source) d.source.playbackRate.setTargetAtTime(eff, t, 0.02);
    }
  }

  /** Rebase position integration before a rate change. */
  private rebase(d: DeckNodes): void {
    d.posBase = this.position(d.id);
    d.posBaseTime = this.ctx.currentTime;
    d.posRate = this.effectiveTempo(d);
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /** Current track position in seconds (tempo-aware — fixes playhead drift). */
  position(id: string): number {
    const d = this.decks.get(id);
    if (!d || !d.buffer) return 0;
    if (!d.source) return d.posBase;
    let pos = d.posBase + d.posRate * (this.ctx.currentTime - d.posBaseTime);
    // Loop wrap (source loops the buffer region; our integrator must follow)
    if (d.loopStart !== null && d.loopEnd !== null && d.loopEnd > d.loopStart) {
      if (pos >= d.loopEnd) {
        const span = d.loopEnd - d.loopStart;
        pos = d.loopStart + ((pos - d.loopStart) % span);
      }
    } else if (pos >= d.buffer.duration) {
      pos = d.buffer.duration;
    }
    return Math.max(0, pos);
  }

  play(id: string, opts?: { offset?: number; alignToMaster?: boolean }): void {
    const d = this.decks.get(id);
    if (!d || !d.buffer) return;
    this.rebase(d);

    if (d.source) {
      try { d.source.stop(); } catch { /* already stopped */ }
      d.source.disconnect();
    }

    const src = this.ctx.createBufferSource();
    src.buffer = d.buffer;
    if (d.loopStart !== null && d.loopEnd !== null && d.loopEnd > d.loopStart) {
      src.loop = true;
      src.loopStart = d.loopStart;
      src.loopEnd = d.loopEnd;
    }
    src.connect(d.stretch);

    let offset = opts?.offset ?? d.posBase;
    if (opts?.alignToMaster) offset = this.barAlignedOffset(id, offset);

    const t = this.ctx.currentTime + 0.02;
    d.source = src;
    d.posBase = offset;
    d.posBaseTime = t;
    d.posRate = this.effectiveTempo(d);
    this.applyTempo(d);
    // Start slightly in the future for clean scheduling
    src.start(t, offset % d.buffer.duration);
  }

  pause(id: string): void {
    const d = this.decks.get(id);
    if (!d || !d.source) return;
    d.posBase = this.position(id);
    try { d.source.stop(); } catch { /* noop */ }
    d.source.disconnect();
    d.source = null;
    d.posBaseTime = this.ctx.currentTime;
    d.nudge = 0; // momentary bend never survives a pause
  }

  seek(id: string, time: number): void {
    const d = this.decks.get(id);
    if (!d || !d.buffer) return;
    const wasPlaying = !!d.source;
    if (wasPlaying) this.pause(id);
    d.posBase = clamp(time, 0, d.buffer.duration);
    d.posBaseTime = this.ctx.currentTime;
    if (wasPlaying) this.play(id, { offset: d.posBase });
  }

  isPlaying(id: string): boolean {
    return !!this.decks.get(id)?.source;
  }

  // ─── Tempo / sync / nudge ─────────────────────────────────────────────────

  setTempo(id: string, tempo: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    this.rebase(d);
    d.userTempo = clamp(tempo, 0.5, 2);
    this.applyTempo(d);
  }

  /** Momentary pitch bend. MUST be paired with clearNudge on release. */
  setNudge(id: string, amount: number): void {
    const d = this.decks.get(id);
    if (!d || !d.source) return;
    this.rebase(d);
    d.nudge = amount;
    this.applyTempo(d);
  }

  clearNudge(id: string): void {
    const d = this.decks.get(id);
    if (!d) return;
    if (d.nudge === 0) return;
    this.rebase(d);
    d.nudge = 0;
    this.applyTempo(d);
  }

  setKeyLock(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    this.rebase(d);
    d.keyLock = on;
    this.applyTempo(d);
  }

  setSync(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.syncOn = on;
    if (on) {
      // Immediate tempo match against the slave's local BPM
      const mBpm = this.masterEffectiveBpm();
      if (mBpm && d.grid && d.grid.bpm > 0) {
        const slaveBpm = this.bpmAtPosition(d, this.position(d.id));
        d.syncBaseTempo = clamp(mBpm / slaveBpm, 0.5, 2);
      }
      d.syncCorr = 1;
      this.applyTempo(d);
    } else {
      // Release: keep current effective tempo as the user tempo
      d.userTempo = clamp(this.effectiveTempo(d), 0.5, 2);
      d.syncCorr = 1;
      this.applyTempo(d);
    }
  }

  setMaster(id: string | null): void {
    this.masterDeckId = id;
  }

  /** Master BPM including the master deck's tempo. 0 if no master. */
  masterEffectiveBpm(): number {
    if (!this.masterDeckId) return 0;
    const d = this.decks.get(this.masterDeckId);
    if (!d || !d.grid || d.grid.bpm <= 0) return 0;
    return d.grid.bpm * this.effectiveTempo(d);
  }

  /** Master phase in beats (fractional) at the current audio time. */
  private masterBeats(): number | null {
    if (!this.masterDeckId) return null;
    const d = this.decks.get(this.masterDeckId);
    if (!d || !d.grid || d.grid.bpm <= 0 || !d.source) return null;
    return this.beatsAtPosition(d, this.position(d.id));
  }

  /**
   * Fractional beat position at a track time, using the beat map when
   * available (Traktor import or analyzed beat map) and falling back to
   * straight extrapolation from bpm + firstBeat.
   */
  private beatsAtPosition(d: DeckNodes, posSec: number): number {
    const g = d.grid!;
    if (g.beats.length >= 2) {
      // Binary search the beat map
      let lo = 0;
      let hi = g.beats.length - 1;
      if (posSec <= g.beats[0]) {
        // Before the first mapped beat: extrapolate backward
        const spb = 60 / g.bpm;
        return (posSec - g.beats[0]) / spb;
      }
      if (posSec >= g.beats[hi]) {
        const spb = 60 / (g.bpmCurve[hi - 1] ?? g.bpm);
        return hi + (posSec - g.beats[hi]) / spb;
      }
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (g.beats[mid] <= posSec) lo = mid; else hi = mid;
      }
      const spb = 60 / (g.bpmCurve[lo] ?? g.bpm);
      return lo + (posSec - g.beats[lo]) / spb;
    }
    const off = g.downbeatOffset >= 0 ? g.downbeatOffset : g.firstBeat;
    return (posSec - off) / (60 / g.bpm);
  }

  /**
   * Instantaneous BPM at a track time from the beat map / curve.
   * Falls back to the flat grid BPM.
   */
  private bpmAtPosition(d: DeckNodes, posSec: number): number {
    const g = d.grid!;
    if (g.beats.length >= 2 && g.bpmCurve.length > 0) {
      let lo = 0;
      let hi = g.beats.length - 1;
      if (posSec <= g.beats[0] || posSec >= g.beats[hi]) return g.bpmCurve[0] ?? g.bpm;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (g.beats[mid] <= posSec) lo = mid; else hi = mid;
      }
      return g.bpmCurve[lo] ?? g.bpm;
    }
    return g.bpm;
  }

  /**
   * One-shot bar alignment: given a desired cue offset on `id`, return the
   * nearest offset at/after it whose bar phase matches the master's.
   */
  barAlignedOffset(id: string, cuePoint: number): number {
    const d = this.decks.get(id);
    const mBeats = this.masterBeats();
    if (!d || !d.grid || d.grid.bpm <= 0 || mBeats === null) return cuePoint;
    const sOff = d.grid.downbeatOffset >= 0 ? d.grid.downbeatOffset : d.grid.firstBeat;
    const sSpb = 60 / d.grid.bpm;
    const masterBarPhase = ((mBeats % 4) + 4) % 4;
    const k = Math.ceil(((cuePoint - sOff) / sSpb - masterBarPhase) / 4);
    const target = sOff + (k * 4 + masterBarPhase) * sSpb;
    if (d.buffer && target >= d.buffer.duration) {
      // wrap into the track
      const span = d.buffer.duration;
      return ((target % span) + span) % span;
    }
    return Math.max(0, target);
  }

  /**
   * Continuous sync: phase-locked loop. Every 100ms, for each synced slave,
   * tempo-follow the master and apply a small proportional correction toward
   * zero bar-phase error. This is what keeps decks from drifting apart.
   */
  private syncTick(): void {
    const mBpm = this.masterEffectiveBpm();
    const mBeats = this.masterBeats();
    if (!mBpm || mBeats === null) return;
    const masterBarPhase = ((mBeats % 4) + 4) % 4;

    for (const d of this.decks.values()) {
      if (!d.syncOn || d.id === this.masterDeckId || !d.source || !d.grid || d.grid.bpm <= 0) continue;
      // Tempo follow — against the slave's LOCAL bpm from its beat map,
      // so drifting tracks stay matched instead of fighting a flat average.
      const slaveBpm = this.bpmAtPosition(d, this.position(d.id));
      const want = clamp(mBpm / slaveBpm, 0.5, 2);
      if (Math.abs(want - d.syncBaseTempo) > 0.0005) {
        this.rebase(d);
        d.syncBaseTempo = want;
      }
      // Phase correction (in beats, wrapped to ±2 = half a bar)
      // Uses the slave's beat map when available, so drift inside the
      // track doesn't fight the correction.
      const sBeats = this.beatsAtPosition(d, this.position(d.id));
      const sBarPhase = ((sBeats % 4) + 4) % 4;
      const err = wrapCentered(sBarPhase - masterBarPhase, 4); // + = slave ahead
      const corr = clamp(1 - err * 0.15, 0.985, 1.015); // ±1.5% max correction
      if (Math.abs(corr - d.syncCorr) > 0.0002) {
        this.rebase(d);
        d.syncCorr = corr;
        this.applyTempo(d);
      }
    }
  }

  /** Audio time (ctx.currentTime) of the next master bar boundary ≥ `minAheadSec` out. */
  nextBarTime(minAheadSec = 0.25): number | null {
    const mBeats = this.masterBeats();
    const mBpm = this.masterEffectiveBpm();
    if (mBeats === null || !mBpm) return null;
    const beatsUntil = (4 - (((mBeats % 4) + 4) % 4)) % 4;
    const spb = 60 / mBpm;
    const waitBeats = beatsUntil * spb < minAheadSec ? beatsUntil + 4 : beatsUntil;
    return this.ctx.currentTime + waitBeats * spb;
  }

  // ─── Mixer params ─────────────────────────────────────────────────────────

  setEq(id: string, band: 'low' | 'mid' | 'high', db: number, kill: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    const t = this.ctx.currentTime;
    const node = band === 'low' ? d.eqLow : band === 'mid' ? d.eqMid : d.eqHigh;
    node.gain.setTargetAtTime(kill ? -60 : db * 1.5, t, 0.05);
    if (band === 'mid') node.Q.setTargetAtTime(kill ? 2 : 1, t, 0.05);
  }

  setFilter(id: string, v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    const t = this.ctx.currentTime;
    if (Math.abs(v) < 0.05) {
      d.filter.type = 'allpass';
      d.filter.frequency.setTargetAtTime(20000, t, 0.05);
    } else if (v < 0) {
      d.filter.type = 'lowpass';
      const f = 100 * Math.pow(200, 1 - Math.abs(v));
      d.filter.frequency.setTargetAtTime(f, t, 0.05);
      d.filter.Q.value = 1 + Math.abs(v) * 2;
    } else {
      d.filter.type = 'highpass';
      const f = 20 * Math.pow(250, v);
      d.filter.frequency.setTargetAtTime(f, t, 0.05);
      d.filter.Q.value = 1 + v * 2;
    }
  }

  setFader(id: string, v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.fader.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.03);
  }

  setTrim(id: string, v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.trim.gain.setTargetAtTime(clamp(v, 0, 2), this.ctx.currentTime, 0.03);
  }

  setCue(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.cueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Equal-power crossfader: v in [-1, 1], -1 = full A, +1 = full B. AI deck bypasses it. */
  setCrossfader(v: number): void {
    const t = this.ctx.currentTime;
    const angle = ((clamp(v, -1, 1) + 1) / 2) * (Math.PI / 2);
    const gA = Math.cos(angle);
    const gB = Math.sin(angle);
    this.decks.get('deckA')?.xfade.gain.setTargetAtTime(gA, t, 0.03);
    this.decks.get('deckB')?.xfade.gain.setTargetAtTime(gB, t, 0.03);
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ctx.currentTime, 0.05);
  }

  /** 0 = cue only … 1 = master only (equal power). */
  setCueMix(v: number): void {
    const t = this.ctx.currentTime;
    const x = clamp(v, 0, 1) * (Math.PI / 2);
    this.cueToPhones.gain.setTargetAtTime(Math.cos(x), t, 0.05);
    this.masterToPhones.gain.setTargetAtTime(Math.sin(x), t, 0.05);
  }

  setPhonesLevel(v: number): void {
    this.phonesGain.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ctx.currentTime, 0.05);
  }

  // ─── Loops & hotcues ─────────────────────────────────────────────────────

  setLoop(id: string, start: number | null, end: number | null): void {
    const d = this.decks.get(id);
    if (!d) return;
    const wasPlaying = !!d.source;
    const pos = this.position(id);
    if (wasPlaying) this.pause(id);
    d.loopStart = start;
    d.loopEnd = end;
    if (wasPlaying) this.play(id, { offset: pos });
  }

  // ─── AI loop drop-in ──────────────────────────────────────────────────────
  // Schedules a generated loop to start exactly on the next master bar
  // boundary with a 1-beat fade-in.

  playAiLoop(id: string, buffer: AudioBuffer, grid: BeatGrid, tempo: number): number | null {
    const d = this.decks.get(id);
    if (!d) return null;
    if (d.source) {
      try { d.source.stop(); } catch { /* noop */ }
      d.source.disconnect();
      d.source = null;
    }
    const barTime = this.nextBarTime(0.3);
    if (barTime === null) {
      // No master playing: start immediately
      d.buffer = buffer;
      d.grid = grid;
      d.userTempo = tempo;
      d.syncBaseTempo = tempo;
      d.syncCorr = 1;
      d.nudge = 0;
      d.loopStart = 0;
      d.loopEnd = buffer.duration;
      this.play(id, { offset: 0 });
      return this.ctx.currentTime;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    src.connect(d.stretch);

    d.buffer = buffer;
    d.grid = grid;
    d.source = src;
    d.userTempo = tempo;
    d.syncBaseTempo = tempo;
    d.syncCorr = 1;
    d.nudge = 0;
    d.loopStart = 0;
    d.loopEnd = buffer.duration;
    d.posBase = 0;
    d.posBaseTime = barTime;
    d.posRate = tempo;
    this.applyTempo(d);

    // 1-beat fade-in (crossfade feel), ramping back to the deck's fader level
    const mBpm = this.masterEffectiveBpm() || grid.bpm * tempo;
    const beatSec = 60 / mBpm;
    const targetLevel = Math.max(0.001, d.fader.gain.value || 0.8);
    d.fader.gain.cancelScheduledValues(barTime);
    d.fader.gain.setValueAtTime(0.0001, barTime);
    d.fader.gain.exponentialRampToValueAtTime(targetLevel, barTime + beatSec);

    src.start(barTime, 0);
    return barTime;
  }

  // ─── Metering ─────────────────────────────────────────────────────────────

  private meter(node: AnalyserNode): number {
    const data = new Uint8Array(node.frequencyBinCount);
    node.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const f = (data[i] - 128) / 128;
      sum += f * f;
    }
    return Math.sqrt(sum / data.length) * 3;
  }

  deckLevel(id: string): number {
    const d = this.decks.get(id);
    return d ? this.meter(d.analyser) : 0;
  }

  masterLevel(): number {
    return this.meter(this.masterAnalyser);
  }

  phonesLevel(): number {
    return this.meter(this.phonesAnalyser);
  }

  // ─── Devices ──────────────────────────────────────────────────────────────

  async listOutputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch {
      return [];
    }
  }

  async unlockDeviceLabels(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  async setMasterDevice(deviceId: string): Promise<void> {
    try {
      await (this.masterEl as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
    } catch { /* not supported */ }
  }

  async setPhonesDevice(deviceId: string): Promise<void> {
    try {
      await (this.phonesEl as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
    } catch { /* not supported */ }
  }
}

export const engine = new DJEngine();

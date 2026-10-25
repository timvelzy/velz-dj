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
import recorderWorkletUrl from './recorder-processor.ts?worker&url';
import { debugLog } from './debugLog';

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
  fxSend: GainNode;
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
  syncInt: number; // PLL integral term (Phase 5), clamped ±0.003
  nudge: number; // momentary pitch bend, e.g. ±0.05
  nudgeDeadline: number; // ctx time after which a nudge auto-expires (anti-latch)
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

/**
 * Signed phase error in beats between master and slave beat counters,
 * wrapped to ±range/2 (range 4 = bar alignment). Positive = slave ahead.
 * Pure — extracted for reasoning/tests (Phase 5).
 */
export function phaseErrorBeats(masterBeats: number, slaveBeats: number, range = 4): number {
  return wrapCentered(slaveBeats - masterBeats, range);
}

/**
 * PLL correction multiplier from a phase error + integral term.
 * Proportional gain 0.05/beat gives a true proportional band (a 0.3-beat
 * error → 1.5% pull, not a bang-bang clamp); hard clamp ±2%. Pure.
 */
export function pllCorrection(errBeats: number, integral: number): number {
  return clamp(1 - errBeats * 0.05 - integral, 0.98, 1.02);
}

export type FxType = 'delay' | 'reverb' | 'bitcrush' | 'flanger';
export type FxBeatDivision = '1/4' | '3/8' | '1/2' | '3/4' | '1';
/** Beat length of each division (a 1/4 note = 1 beat). */
export const FX_DIVISION_BEATS: Record<FxBeatDivision, number> = {
  '1/4': 1, '3/8': 1.5, '1/2': 2, '3/4': 3, '1': 4,
};

export interface SamplerPad {
  buffer: AudioBuffer | null;
  name: string;
  volume: number; // 0..1
  source: AudioBufferSourceNode | null; // currently playing voice (for retrigger)
}

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

  // FX unit (Phase 6, specs/sampler-and-fx.md §2) — send/return
  private fxBus!: GainNode;
  private fxReturn!: GainNode;
  private fxInDelay!: GainNode;
  private fxInReverb!: GainNode;
  private fxInCrush!: GainNode;
  private fxInFlanger!: GainNode;
  private fxDelay!: DelayNode;
  private fxDelay2!: DelayNode;
  private fxDelayFb!: GainNode;
  private fxDelayTone!: BiquadFilterNode;
  private fxDelay2Gain!: GainNode;
  private fxConvolver!: ConvolverNode;
  private fxReverbDamp!: BiquadFilterNode;
  private fxReverbPre!: DelayNode;
  private fxShaper!: WaveShaperNode;
  private fxCrushTone!: BiquadFilterNode;
  private fxCrushOut!: GainNode;
  private fxFlangeDelay!: DelayNode;
  private fxFlangeFb!: GainNode;
  private fxFlangeLfo!: OscillatorNode;
  private fxFlangeLfoGain!: GainNode;
  fx = {
    type: 'delay' as FxType,
    wet: 0.5,
    enabled: true,
    division: '1/2' as FxBeatDivision,
    params: [0.45, 0.5, 0] as [number, number, number],
    bpm: 124, // last known tempo for FX timing
  };
  private fxIrTimer: number | null = null;

  // Sampler — 8 one-shot pads
  private samplerBus!: GainNode;
  private samplerMaster!: GainNode;
  pads: SamplerPad[] = Array.from({ length: 8 }, () => ({
    buffer: null, name: '', volume: 0.8, source: null,
  }));
  samplerQuantize = false;

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
    this.ctx.onstatechange = () => {
      debugLog('audio', `AudioContext state -> ${this.ctx.state}`);
    };
    debugLog('audio', 'engine init', undefined, { state: this.ctx.state });

    await this.ctx.audioWorklet.addModule(wsolaWorkletUrl);
    await this.ctx.audioWorklet.addModule(recorderWorkletUrl);
    this.workletReady = true;

    this.masterBus = this.ctx.createGain();
    this.cueBus = this.ctx.createGain();
    this.buildFxUnit();

    // Sampler bus → master (post-compressor, pre-master-gain for independent level)
    this.samplerBus = this.ctx.createGain();
    this.samplerMaster = this.ctx.createGain();
    this.samplerMaster.gain.value = 0.9;
    this.samplerBus.connect(this.samplerMaster);
    this.samplerMaster.connect(this.masterBus);

    // Master limiter (Phase 3): the old −18 dB / 12:1 settings were a gentle
    // bus compressor that still let summed decks clip the output (and any
    // recording). Tuned as a transparent ceiling instead: −3 dB threshold,
    // 20:1, hard knee, fast attack, musical release. Everything downstream
    // (device out + recorder tap) is post-limiter by construction.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -3;
    this.compressor.knee.value = 0;
    this.compressor.ratio.value = 20;
    this.compressor.attack.value = 0.002;
    this.compressor.release.value = 0.24;

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
    const before = this.ctx.state;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    try {
      await this.masterEl.play();
      await this.phonesEl.play();
    } catch {
      /* autoplay policy — will start on next gesture */
    }
    debugLog('audio', 'resume', undefined, { before, after: this.ctx.state });
  }

  destroy(): void {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  // ─── FX unit ────────────────────────────────────────────────────────────
  // Send/return: [channel fader] → fxSend[N] → fxBus → [active effect] →
  // fxReturn → masterBus (pre-limiter, so FX are recorded + limited too).

  private buildFxUnit(): void {
    const ctx = this.ctx;
    this.fxBus = ctx.createGain();
    this.fxReturn = ctx.createGain();
    this.fxReturn.gain.value = this.fx.enabled ? this.fx.wet : 0;
    this.fxReturn.connect(this.masterBus);

    const mkIn = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      this.fxBus.connect(g);
      return g;
    };
    this.fxInDelay = mkIn();
    this.fxInReverb = mkIn();
    this.fxInCrush = mkIn();
    this.fxInFlanger = mkIn();

    // Delay: two taps (main + 0.75× echo) with filtered feedback
    this.fxDelay = ctx.createDelay(4);
    this.fxDelay2 = ctx.createDelay(4);
    this.fxDelayFb = ctx.createGain();
    this.fxDelayTone = ctx.createBiquadFilter();
    this.fxDelayTone.type = 'lowpass';
    this.fxDelay2Gain = ctx.createGain();
    this.fxDelay2Gain.gain.value = 0;
    this.fxInDelay.connect(this.fxDelay);
    this.fxInDelay.connect(this.fxDelay2);
    this.fxDelay.connect(this.fxDelayTone);
    this.fxDelayTone.connect(this.fxDelayFb);
    this.fxDelayFb.connect(this.fxDelay);
    this.fxDelay.connect(this.fxReturn);
    this.fxDelay2.connect(this.fxDelay2Gain);
    this.fxDelay2Gain.connect(this.fxReturn);

    // Reverb: predelay → damping lowpass → convolver (synthetic IR)
    this.fxReverbPre = ctx.createDelay(0.25);
    this.fxReverbPre.delayTime.value = 0;
    this.fxReverbDamp = ctx.createBiquadFilter();
    this.fxReverbDamp.type = 'lowpass';
    this.fxReverbDamp.frequency.value = 9000;
    this.fxConvolver = ctx.createConvolver();
    this.fxConvolver.buffer = this.makeImpulse(2.8);
    this.fxInReverb.connect(this.fxReverbPre);
    this.fxReverbPre.connect(this.fxReverbDamp);
    this.fxReverbDamp.connect(this.fxConvolver);
    this.fxConvolver.connect(this.fxReturn);

    // Bitcrush: waveshaper quantization → tone → out trim
    this.fxShaper = ctx.createWaveShaper();
    this.fxShaper.oversample = 'none';
    this.fxCrushTone = ctx.createBiquadFilter();
    this.fxCrushTone.type = 'lowpass';
    this.fxCrushTone.frequency.value = 16000;
    this.fxCrushOut = ctx.createGain();
    this.fxInCrush.connect(this.fxShaper);
    this.fxShaper.connect(this.fxCrushTone);
    this.fxCrushTone.connect(this.fxCrushOut);
    this.fxCrushOut.connect(this.fxReturn);

    // Flanger: short modulated delay + feedback (wet-only; it combs
    // against the dry channel path, classic send-flange)
    this.fxFlangeDelay = ctx.createDelay(0.05);
    this.fxFlangeDelay.delayTime.value = 0.003;
    this.fxFlangeFb = ctx.createGain();
    this.fxFlangeFb.gain.value = 0.35;
    this.fxFlangeLfo = ctx.createOscillator();
    this.fxFlangeLfo.type = 'sine';
    this.fxFlangeLfoGain = ctx.createGain();
    this.fxFlangeLfoGain.gain.value = 0.0012;
    this.fxFlangeLfo.connect(this.fxFlangeLfoGain);
    this.fxFlangeLfoGain.connect(this.fxFlangeDelay.delayTime);
    this.fxInFlanger.connect(this.fxFlangeDelay);
    this.fxFlangeDelay.connect(this.fxFlangeFb);
    this.fxFlangeFb.connect(this.fxFlangeDelay);
    this.fxFlangeDelay.connect(this.fxReturn);
    this.fxFlangeLfo.start();

    this.selectFx(this.fx.type);
    this.applyFxParams();
    this.updateFxTiming();
  }

  /** Synthetic exponentially-decaying noise impulse (no IR files to ship). */
  private makeImpulse(decaySec: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * decaySec));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
      }
    }
    return buf;
  }

  private crushCurve(bits: number): Float32Array {
    const n = 1024;
    const curve = new Float32Array(n);
    const steps = Math.pow(2, bits - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  selectFx(type: FxType): void {
    this.fx.type = type;
    if (!this.fxInDelay) return;
    const t = this.ctx.currentTime;
    const on = (g: GainNode, isOn: boolean) => g.gain.setTargetAtTime(isOn ? 1 : 0, t, 0.03);
    on(this.fxInDelay, type === 'delay');
    on(this.fxInReverb, type === 'reverb');
    on(this.fxInCrush, type === 'bitcrush');
    on(this.fxInFlanger, type === 'flanger');
    this.applyFxParams();
  }

  setFxEnabled(on: boolean): void {
    this.fx.enabled = on;
    if (!this.fxReturn) return;
    this.fxReturn.gain.setTargetAtTime(on ? this.fx.wet : 0, this.ctx.currentTime, 0.03);
  }

  setFxWet(v: number): void {
    this.fx.wet = clamp(v, 0, 1);
    if (!this.fxReturn) return;
    if (this.fx.enabled) {
      this.fxReturn.gain.setTargetAtTime(this.fx.wet, this.ctx.currentTime, 0.03);
    }
  }

  setFxSend(channelId: string, v: number): void {
    const d = this.decks.get(channelId);
    if (!d) return;
    d.fxSend.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.03);
  }

  setFxBeatDivision(div: FxBeatDivision): void {
    this.fx.division = div;
    this.updateFxTiming();
  }

  /**
   * Generic param slots; meaning depends on the selected effect:
   *  delay:    [feedback 0–0.85, loop tone, echo-2 level]
   *  reverb:   [decay 0.4–6 s, damping, predelay 0–120 ms]
   *  bitcrush: [bits 16→4, tone, out trim 0–1.5]
   *  flanger:  [depth, feedback 0–0.7, rate × 0.25–2]
   */
  setFxParam(index: 0 | 1 | 2, v: number): void {
    this.fx.params[index] = clamp(v, 0, 1);
    this.applyFxParams();
  }

  private applyFxParams(): void {
    if (!this.fxDelay) return;
    const [p1, p2, p3] = this.fx.params;
    const t = this.ctx.currentTime;
    switch (this.fx.type) {
      case 'delay':
        this.fxDelayFb.gain.setTargetAtTime(p1 * 0.85, t, 0.03);
        this.fxDelayTone.frequency.setTargetAtTime(800 * Math.pow(15, p2), t, 0.03);
        this.fxDelay2Gain.gain.setTargetAtTime(p3 * 0.8, t, 0.03);
        break;
      case 'reverb': {
        this.fxReverbDamp.frequency.setTargetAtTime(1500 * Math.pow(12, p2), t, 0.03);
        this.fxReverbPre.delayTime.setTargetAtTime(p3 * 0.12, t, 0.03);
        // Regenerate the IR at the new decay (debounced — knobs stream)
        if (this.fxIrTimer !== null) window.clearTimeout(this.fxIrTimer);
        const decay = 0.4 + p1 * 5.6;
        this.fxIrTimer = window.setTimeout(() => {
          this.fxConvolver.buffer = this.makeImpulse(decay);
          this.fxIrTimer = null;
        }, 150);
        break;
      }
      case 'bitcrush': {
        const bits = 16 - Math.round(p1 * 12);
        this.fxShaper.curve = this.crushCurve(bits);
        this.fxCrushTone.frequency.setTargetAtTime(1000 * Math.pow(18, p2), t, 0.03);
        this.fxCrushOut.gain.setTargetAtTime(0.25 + p3 * 1.25, t, 0.03);
        break;
      }
      case 'flanger':
        this.fxFlangeLfoGain.gain.setTargetAtTime(p1 * 0.0025, t, 0.03);
        this.fxFlangeFb.gain.setTargetAtTime(p2 * 0.7, t, 0.03);
        this.updateFxTiming(); // p3 = rate multiplier
        break;
    }
  }

  /** Keep delay times + flanger rate locked to the master tempo. */
  private updateFxTiming(): void {
    if (!this.fxDelay) return;
    const bpm = this.masterEffectiveBpm() || this.fx.bpm || 124;
    this.fx.bpm = bpm;
    const spb = 60 / bpm;
    const beats = FX_DIVISION_BEATS[this.fx.division];
    const t = this.ctx.currentTime;
    this.fxDelay.delayTime.setTargetAtTime(Math.min(3.9, spb * beats), t, 0.05);
    this.fxDelay2.delayTime.setTargetAtTime(Math.min(3.9, spb * beats * 0.75), t, 0.05);
    const rateMult = 0.25 + this.fx.params[2] * 1.75;
    const cycleSec = spb * beats * 2; // one full LFO sweep per 2 divisions
    this.fxFlangeLfo.frequency.setTargetAtTime(rateMult / cycleSec, t, 0.05);
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
    // Worklet health reports (resyncs / processor errors) come back over the
    // port — log them so a dropout leaves a trail (item 6). Throttled: the
    // first report and every 100th, so a flapping worklet can't flood the ring.
    let workletLogCount = 0;
    stretch.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; count?: number; message?: string };
      if (!d || (d.type !== 'wsola-resync' && d.type !== 'wsola-error')) return;
      workletLogCount++;
      if (workletLogCount === 1 || workletLogCount % 100 === 0) {
        debugLog('error', `worklet ${d.type} (report ${workletLogCount})`, id, {
          count: d.count ?? workletLogCount,
          message: d.message ?? '',
        });
      }
    };

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
    const fxSend = ctx.createGain();
    fxSend.gain.value = 0; // FX sends start closed (Phase 6)
    const xfade = ctx.createGain();
    xfade.gain.value = 1;
    const cueGain = ctx.createGain();
    cueGain.gain.value = 0; // cue OFF by default — real isolation

    // Chain: source → stretch → trim → EQ → filter → analyser → fader → xfade → masterBus
    //                                                              ↳ cueGain → cueBus
    //                                                              ↳ fxSend → fxBus (post-fader send)
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
    fader.connect(fxSend);
    fxSend.connect(this.fxBus);

    this.decks.set(id, {
      id,
      source: null,
      stretch,
      trim, eqLow, eqMid, eqHigh, filter, analyser, fader, fxSend, xfade, cueGain,
      buffer: null,
      grid: null,
      posBase: 0, posBaseTime: ctx.currentTime, posRate: 1,
      userTempo: 1, syncBaseTempo: 1, syncCorr: 1, syncInt: 0, nudge: 0, nudgeDeadline: 0,
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
    // Phase 5 fix: freeze the position integrator and adopt the NEW rate.
    // Previously every caller rebased BEFORE mutating tempo values and
    // posRate was never updated here, so after any tempo/nudge/sync change
    // the playhead (and the PLL's phase readings) integrated at the stale
    // rate until the next incidental rebase — the classic drift bug.
    // Decks with a scheduled future start (AI drop-ins) keep their base;
    // only their rate is updated.
    if (d.posBaseTime <= t) {
      d.posBase = this.position(d.id);
      d.posBaseTime = t;
    }
    d.posRate = eff;
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
    // Natural-end reporting (dropout hardening): a BufferSource that runs
    // out used to leave d.source set, so the deck kept reporting "playing"
    // while outputting silence. Now the end clears the transport + logs.
    // pause()/play() replace d.source synchronously, so a stopped source's
    // late onended is ignored by the identity check.
    src.onended = () => {
      if (d.source === src) {
        d.source = null;
        const dur = d.buffer?.duration ?? 0;
        d.posBase = dur;
        d.posBaseTime = this.ctx.currentTime;
        debugLog('transport', 'track ended (source exhausted)', id, { at: dur });
      }
    };
    debugLog('transport', 'play', id, { offset, rate: d.posRate });
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
    d.nudgeDeadline = 0;
    debugLog('transport', 'pause', id, { at: d.posBase });
  }

  seek(id: string, time: number): void {
    const d = this.decks.get(id);
    if (!d || !d.buffer) return;
    const wasPlaying = !!d.source;
    if (wasPlaying) this.pause(id);
    d.posBase = clamp(time, 0, d.buffer.duration);
    d.posBaseTime = this.ctx.currentTime;
    debugLog('transport', 'seek', id, { to: d.posBase, wasPlaying });
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
    debugLog('param', 'tempo', id, { tempo: d.userTempo });
  }

  /**
   * Momentary pitch bend. Pair with clearNudge on release — and as a
   * safety net every nudge carries a deadline (3 s for held bends, or an
   * explicit hold time via setNudgeFor) that the sync tick enforces, so a
   * lost pointer-up / MIDI note-off can never leave a bend latched.
   */
  setNudge(id: string, amount: number): void {
    this.setNudgeFor(id, amount, 3000);
  }

  setNudgeFor(id: string, amount: number, holdMs: number): void {
    const d = this.decks.get(id);
    if (!d || !d.source) return;
    this.rebase(d);
    d.nudge = amount;
    d.nudgeDeadline = this.ctx.currentTime + holdMs / 1000;
    this.applyTempo(d);
  }

  clearNudge(id: string): void {
    const d = this.decks.get(id);
    if (!d) return;
    if (d.nudge === 0) return;
    this.rebase(d);
    d.nudge = 0;
    d.nudgeDeadline = 0;
    this.applyTempo(d);
  }

  setKeyLock(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    this.rebase(d);
    d.keyLock = on;
    this.applyTempo(d);
    debugLog('param', 'keyLock', id, { on });
  }

  setSync(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.syncOn = on;
    debugLog('transport', `sync ${on ? 'on' : 'off'}`, id);
    if (on) {
      // Immediate tempo match against the slave's local BPM
      const mBpm = this.masterEffectiveBpm();
      if (mBpm && d.grid && d.grid.bpm > 0) {
        const slaveBpm = this.bpmAtPosition(d, this.position(d.id));
        d.syncBaseTempo = clamp(mBpm / slaveBpm, 0.5, 2);
      }
      d.syncCorr = 1;
      d.syncInt = 0;
      this.applyTempo(d);
    } else {
      // Release: keep current effective tempo as the user tempo
      d.userTempo = clamp(this.effectiveTempo(d), 0.5, 2);
      d.syncCorr = 1;
      d.syncInt = 0;
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
   * Uses the deck's beat map when available so drifting/flexible grids
   * (Traktor, beat-mapped analysis) align on real beats, not flat math.
   */
  barAlignedOffset(id: string, cuePoint: number): number {
    const d = this.decks.get(id);
    const mBeats = this.masterBeats();
    if (!d || !d.grid || d.grid.bpm <= 0 || mBeats === null) return cuePoint;
    const masterBarPhase = Math.round((((mBeats % 4) + 4) % 4)) % 4;

    const beats = d.grid.beats;
    if (beats.length > 0) {
      // Binary search: first beat at/after cuePoint
      let lo = 0, hi = beats.length - 1, first = beats.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] >= cuePoint) { first = mid; hi = mid - 1; }
        else lo = mid + 1;
      }
      if (first < beats.length) {
        // Nearest beat at/after `first` whose bar phase matches the master
        const phase = ((first % 4) + 4) % 4;
        const delta = (masterBarPhase - phase + 4) % 4;
        const j = first + delta;
        if (j < beats.length) return beats[j];
        // Ran off the end — fall through to flat math
      }
    }

    const sOff = d.grid.downbeatOffset >= 0 ? d.grid.downbeatOffset : d.grid.firstBeat;
    const sSpb = 60 / d.grid.bpm;
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
   * tempo-follow the master and apply a proportional + integral correction
   * toward zero bar-phase error. This is what keeps decks from drifting
   * apart. Phase 5: applyTempo is now called whenever EITHER the follow
   * tempo or the correction changed (previously a follow-only change never
   * reached the audio rate), and the P-gain is a true proportional band.
   */
  private syncTick(): void {
    // Nudge anti-latch enforcement (runs even without a master)
    const now = this.ctx.currentTime;
    for (const d of this.decks.values()) {
      if (d.nudge !== 0 && d.nudgeDeadline > 0 && now > d.nudgeDeadline) {
        this.clearNudge(d.id);
      }
    }
    // Beat-synced FX follow the master tempo live (Phase 6)
    this.updateFxTiming();

    const mBpm = this.masterEffectiveBpm();
    const mBeats = this.masterBeats();
    if (!mBpm || mBeats === null) return;

    for (const d of this.decks.values()) {
      if (!d.syncOn || d.id === this.masterDeckId || !d.source || !d.grid || d.grid.bpm <= 0) continue;
      // Tempo follow — against the slave's LOCAL bpm from its beat map,
      // so drifting tracks stay matched instead of fighting a flat average.
      const slaveBpm = this.bpmAtPosition(d, this.position(d.id));
      const want = clamp(mBpm / slaveBpm, 0.5, 2);
      let changed = false;
      if (Math.abs(want - d.syncBaseTempo) > 0.0005) {
        d.syncBaseTempo = want;
        changed = true;
      }
      // Phase correction from the beat counters (map-aware on both sides).
      // Bar-range wrap: being a whole bar ahead is alignment, not error.
      const sBeats = this.beatsAtPosition(d, this.position(d.id));
      const err = phaseErrorBeats(mBeats, sBeats, 4); // + = slave ahead
      // Integral term: slow accumulation kills steady-state offset.
      d.syncInt = clamp(d.syncInt + err * 0.0015, -0.003, 0.003);
      const corr = pllCorrection(err, d.syncInt);
      if (Math.abs(corr - d.syncCorr) > 0.0002) {
        d.syncCorr = corr;
        changed = true;
      }
      if (changed) this.applyTempo(d);
    }
  }

  /**
   * Snap a track time to the nearest beat on this deck's grid (Phase 5
   * quantize). Uses the beat map when present; falls back to
   * bpm + firstBeat math. No grid → returns the time unchanged.
   */
  quantizeToBeat(id: string, time: number): number {
    const d = this.decks.get(id);
    if (!d || !d.grid || d.grid.bpm <= 0) return time;
    const g = d.grid;
    const dur = d.buffer?.duration ?? time;
    let snapped = time;
    if (g.beats.length > 0) {
      // Binary search for the insertion point, then pick the nearer neighbor
      let lo = 0;
      let hi = g.beats.length - 1;
      if (time <= g.beats[0]) snapped = g.beats[0];
      else if (time >= g.beats[hi]) snapped = g.beats[hi];
      else {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (g.beats[mid] <= time) lo = mid; else hi = mid;
        }
        snapped = time - g.beats[lo] <= g.beats[hi] - time ? g.beats[lo] : g.beats[hi];
      }
    } else {
      const off = g.downbeatOffset >= 0 ? g.downbeatOffset : g.firstBeat;
      const spb = 60 / g.bpm;
      snapped = off + Math.round((time - off) / spb) * spb;
    }
    return clamp(snapped, 0, dur);
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

  /**
   * DJ-style 3-band EQ. Knob value v in [-1, 1] maps to ±26 dB (isolator
   * feel, center detent = flat) — the old ×1.5 mapping capped the knobs at
   * ±1.5 dB, which is why they felt dead. Kill still drops the band to -60 dB.
   */
  setEq(id: string, band: 'low' | 'mid' | 'high', v: number, kill: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    const t = this.ctx.currentTime;
    const node = band === 'low' ? d.eqLow : band === 'mid' ? d.eqMid : d.eqHigh;
    const db = kill ? -60 : clamp(v, -1, 1) * 26;
    node.gain.setTargetAtTime(db, t, 0.05);
    if (band === 'mid') node.Q.setTargetAtTime(kill ? 2 : 1, t, 0.05);
    debugLog('param', `eq ${band}`, id, { knob: v, db, kill });
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
    debugLog('param', 'filter', id, { v });
  }

  setFader(id: string, v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.fader.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.03);
    debugLog('param', 'fader', id, { v });
  }

  setTrim(id: string, v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.trim.gain.setTargetAtTime(clamp(v, 0, 2), this.ctx.currentTime, 0.03);
    debugLog('param', 'trim', id, { v });
  }

  setCue(id: string, on: boolean): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.cueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    debugLog('param', 'cue', id, { on });
  }

  /** Equal-power crossfader: v in [-1, 1], -1 = full A, +1 = full B. AI deck bypasses it. */
  setCrossfader(v: number): void {
    const t = this.ctx.currentTime;
    const angle = ((clamp(v, -1, 1) + 1) / 2) * (Math.PI / 2);
    const gA = Math.cos(angle);
    const gB = Math.sin(angle);
    this.decks.get('deckA')?.xfade.gain.setTargetAtTime(gA, t, 0.03);
    this.decks.get('deckB')?.xfade.gain.setTargetAtTime(gB, t, 0.03);
    debugLog('param', 'crossfader', undefined, { v, gA, gB });
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ctx.currentTime, 0.05);
    debugLog('param', 'masterVol', undefined, { v });
  }

  /** 0 = cue only … 1 = master only (equal power). */
  setCueMix(v: number): void {
    const t = this.ctx.currentTime;
    const x = clamp(v, 0, 1) * (Math.PI / 2);
    this.cueToPhones.gain.setTargetAtTime(Math.cos(x), t, 0.05);
    this.masterToPhones.gain.setTargetAtTime(Math.sin(x), t, 0.05);
    debugLog('param', 'cueMix', undefined, { v });
  }

  setPhonesLevel(v: number): void {
    this.phonesGain.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ctx.currentTime, 0.05);
    debugLog('param', 'phonesLevel', undefined, { v });
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
    debugLog('transport', 'loop set', id, { start, end });
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
      d.syncInt = 0;
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
    d.syncInt = 0;
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
    debugLog('transport', 'ai loop dropped', id, { tempo, barTime });
    return barTime;
  }

  // ─── Recorder tap ─────────────────────────────────────────────────────────
  // The recorder worklet taps masterGain (post-limiter, post-master-volume:
  // exactly what the master output carries) and outputs silence into the
  // master stream destination so the graph keeps pulling it.

  private recorderNode: AudioWorkletNode | null = null;

  createRecorderTap(): AudioWorkletNode {
    if (this.recorderNode) return this.recorderNode;
    const node = new AudioWorkletNode(this.ctx, 'velz-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.masterGain.connect(node);
    node.connect(this.masterDest);
    this.recorderNode = node;
    return node;
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

  // ─── Sampler ────────────────────────────────────────────────────────────

  /** Load an AudioBuffer into a pad. Returns false if index out of range. */
  loadSample(padIndex: number, buffer: AudioBuffer, name: string): boolean {
    if (padIndex < 0 || padIndex > 7 || !this.ctx) return false;
    const pad = this.pads[padIndex];
    pad.buffer = buffer;
    pad.name = name;
    return true;
  }

  /** Decode and load from a File/Blob. */
  async loadSampleFromFile(padIndex: number, file: File): Promise<boolean> {
    if (!this.ctx) return false;
    try {
      const ab = await file.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(ab);
      return this.loadSample(padIndex, buffer, file.name.replace(/\.[^.]+$/, ''));
    } catch {
      return false;
    }
  }

  clearSample(padIndex: number): void {
    if (padIndex < 0 || padIndex > 7) return;
    const pad = this.pads[padIndex];
    try { pad.source?.stop(); } catch { /* already stopped */ }
    pad.source = null;
    pad.buffer = null;
    pad.name = '';
  }

  setPadVolume(padIndex: number, v: number): void {
    if (padIndex < 0 || padIndex > 7) return;
    this.pads[padIndex].volume = Math.min(1, Math.max(0, v));
  }

  setSamplerMaster(v: number): void {
    if (!this.ctx) return;
    this.samplerMaster.gain.setTargetAtTime(Math.min(1, Math.max(0, v)), this.ctx.currentTime, 0.02);
  }

  setSamplerQuantize(on: boolean): void {
    this.samplerQuantize = on;
  }

  /** Find seconds until the next beat on the reference deck (master or first playing deck with a grid). */
  private secondsToNextBeat(): number | null {
    const refId = (this.masterDeckId && this.isPlaying(this.masterDeckId))
      ? this.masterDeckId
      : [...this.decks.keys()].find((id) => this.isPlaying(id) && this.decks.get(id)?.grid);
    if (!refId) return null;
    const deck = this.decks.get(refId);
    const grid = deck?.grid;
    if (!deck || !grid?.beats?.length) return null;
    const pos = this.position(refId); // track seconds
    // Find first beat timestamp after current position
    const next = grid.beats.find((b) => b > pos);
    if (next == null) return null;
    // Convert track-time delta to real-time delta (account for tempo rate)
    const rate = deck.posRate || 1;
    return Math.max(0, (next - pos) / rate);
  }

  /** Trigger a pad. Retriggers if already playing. Quantize snaps to next beat. */
  triggerSample(padIndex: number): boolean {
    if (!this.ctx || padIndex < 0 || padIndex > 7) return false;
    const pad = this.pads[padIndex];
    if (!pad.buffer) return false;

    // Retrigger: stop current voice
    try { pad.source?.stop(); } catch { /* already stopped */ }

    let when = this.ctx.currentTime;
    if (this.samplerQuantize) {
      const delay = this.secondsToNextBeat();
      if (delay != null) when += delay;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = pad.buffer;
    const g = this.ctx.createGain();
    g.gain.value = pad.volume;
    src.connect(g);
    g.connect(this.samplerBus);
    src.onended = () => { if (pad.source === src) pad.source = null; };
    pad.source = src;
    try {
      src.start(when);
      return true;
    } catch {
      pad.source = null;
      return false;
    }
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

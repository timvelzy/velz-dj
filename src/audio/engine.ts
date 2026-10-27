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
import { barPhaseOf } from './loop';

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
  /** Audio time of a queued quantized launch (null = not queued). */
  pendingStartAt: number | null;
  // Tempo model
  userTempo: number; // from the tempo fader
  syncBaseTempo: number; // tempo-follow value while synced
  syncCorr: number; // continuous phase correction multiplier (~1.0)
  syncInt: number; // PLL integral term (Phase 5), clamped ±0.01 (round 5)
  /** Round-5 smoothed tempo-follow ratio: 2s one-pole glide toward the
   *  master/slave BPM ratio, so per-section BPM steps on walked grids
   *  don't yank the playback rate (see syncTick). */
  syncFollowSm: number;
  /** Round-5 consecutive 50ms sync ticks with |phase| ≤ 30ms; LOCKED
   *  requires a sustained streak, not one lucky poll (see syncStatus). */
  syncLockStreak: number;
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
 * Proportional gain 0.25/beat with hard clamp ±3% (round 5: was 0.12).
 * What this does and doesn't do, measured on the loop equations (see
 * the round-5 report): large offsets are slew-limited by the ±3%
 * clamp in both versions (~13s from 0.8 beats either way), so the
 * retune is NOT a faster big-offset fix. What it improves is the
 * small-signal endgame: from a 49ms offset the loop settles inside
 * ±30ms in ~0.9s instead of ~1.4s, with comparable ~10ms overshoot.
 * The ±3% clamp is unchanged (audio-safe: no rate jumps), and
 * per-tick correction slew stays ≤ ~0.001, so setTargetAtTime/WSOLA
 * smoothing never sees a step. Pure.
 */
export function pllCorrection(errBeats: number, integral: number): number {
  return clamp(1 - errBeats * 0.25 - integral, 0.97, 1.03);
}

/**
 * Beats until the next `cycleBeats` boundary at/after `mBeats`, never less
 * than `minAheadBeats` out (a boundary right now waits a full cycle, so a
 * scheduled start is never in the past). Pure — extracted for tests.
 */
export function nextBoundaryWaitBeats(mBeats: number, cycleBeats: number, minAheadBeats: number): number {
  const frac = ((mBeats % cycleBeats) + cycleBeats) % cycleBeats;
  let wait = (cycleBeats - frac) % cycleBeats;
  while (wait < minAheadBeats) wait += cycleBeats;
  return wait;
}

/**
 * First downbeat-phase beat at/after `cuePoint` on this grid (the engine's
 * phase convention: beat indices i with (i - barPhase) % 4 === 0 are
 * downbeats, where barPhase comes from barPhaseOf() — explicit anchor or
 * derived from downbeatOffset — so a manual Set 1.1 or auto-1.1 anchor
 * moves every downbeat computation together). For cue points in the
 * intro (before the first mapped beat) downbeats are extrapolated
 * backward from the first downbeat-phase mapped beat, so a cue there
 * lands on a downbeat-phase time instead of jumping forward past the
 * intro. Falls back to flat downbeatOffset/firstBeat math when the map
 * is thin. Pure.
 */
export function downbeatOffsetFor(grid: BeatGrid, cuePoint: number, duration: number): number {
  const spb = grid.bpm > 0 ? 60 / grid.bpm : 0;
  const barDur = 4 * spb;
  if (grid.beats.length > 0) {
    const phase = barPhaseOf(grid);
    if (cuePoint < grid.beats[0]) {
      // Intro region: first downbeat-phase mapped beat, then step
      // backward by whole bars to the first downbeat at/after the cue.
      let j0 = 0;
      while (j0 < grid.beats.length && (((j0 - phase) % 4) + 4) % 4 !== 0) j0++;
      if (j0 < grid.beats.length) {
        const curveBpm =
          grid.bpmCurve[Math.min(j0, Math.max(0, grid.bpmCurve.length - 1))] ?? grid.bpm;
        const localSpb = curveBpm > 0 ? 60 / curveBpm : spb;
        const localBarDur = 4 * localSpb;
        if (localBarDur > 0 && Number.isFinite(localBarDur)) {
          const k = Math.ceil((cuePoint - grid.beats[j0]) / localBarDur - 1e-9);
          let target = grid.beats[j0] + k * localBarDur;
          let guard = 0;
          while (target < 0 && guard++ < 100000) target += localBarDur;
          if (duration > 0 && target >= duration) return Math.max(0, target % duration);
          return Math.max(0, target);
        }
      }
      // No downbeat-phase beat in the map: fall through to flat math.
    }
    let lo = 0, hi = grid.beats.length - 1, first = grid.beats.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (grid.beats[mid] >= cuePoint) { first = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (first < grid.beats.length) {
      const j = first + (((phase - first) % 4) + 4) % 4;
      if (j < grid.beats.length) return grid.beats[j];
    }
  }
  const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat >= 0 ? grid.firstBeat : 0;
  if (!(barDur > 0) || !Number.isFinite(barDur)) return Math.max(0, off);
  // Flat math, extrapolated both ways: a cue before the offset lands on
  // the downbeat-phase time at/after it (stepping backward), not on the
  // offset itself, so intros lead in instead of jumping forward.
  const k = Math.ceil((cuePoint - off) / barDur - 1e-9);
  let target = off + k * barDur;
  let guard = 0;
  while (target < 0 && guard++ < 100000) target += barDur;
  if (duration > 0 && target >= duration) return Math.max(0, target % duration);
  return Math.max(0, target);
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
  loop: boolean; // loop MODE armed: triggering starts a repeating loop
  looping: boolean; // a loop is currently playing (UI-readable)
}

/**
 * Runtime state for one pad's loop. The mode flag lives on SamplerPad
 * (above); this holds only the scheduler's working state, so clearing a
 * pad or loading a new sample can cancel scheduling without touching
 * the armed mode.
 */
interface PadLoopState {
  timer: number | null; // lookahead scheduler interval
  nextAt: number | null; // audio time of the next iteration start
  beats: number; // loop period, in master beats
  spb: number; // last reference seconds-per-beat (fallback when no grid)
  pending: { src: AudioBufferSourceNode; at: number }[]; // scheduled voices
}

/** Pads are one-shots: deck→sampler recordings cap at 30s with auto-stop. */
const SAMPLER_RECORD_MAX_SECONDS = 30;

/** One in-flight deck→sampler recording (single session at a time). */
interface DeckRecordSession {
  deckId: string;
  left: Float32Array[];
  right: Float32Array[];
  timer: number | null;
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

  // Sampler — 8 pads (one-shot by default, per-pad loop mode)
  private samplerBus!: GainNode;
  private samplerMaster!: GainNode;
  private samplerTrim!: GainNode;
  private samplerEqLow!: BiquadFilterNode;
  private samplerEqMid!: BiquadFilterNode;
  private samplerEqHigh!: BiquadFilterNode;
  private samplerFilter!: BiquadFilterNode;
  private samplerFxSend!: GainNode;
  private samplerCueGain!: GainNode;
  private samplerAnalyser!: AnalyserNode;
  pads: SamplerPad[] = Array.from({ length: 8 }, () => ({
    buffer: null, name: '', volume: 0.8, source: null, loop: false, looping: false,
  }));
  samplerQuantize = true; // default ON: pads launch quantized (checkbox defeats it)

  /** Per-pad loop scheduler state (parallel to `pads`). */
  private padLoops: PadLoopState[] = Array.from({ length: 8 }, () => ({
    timer: null, nextAt: null, beats: 4, spb: 60 / 124, pending: [],
  }));

  // Quantized launch (EDM sync feature): decks wait for the master grid.
  // 'bar' = drop on the next master bar with the slave on a downbeat (the
  // EDM default); 'beat' = next master beat; 'off' = immediate play.
  launchQuantize: 'bar' | 'beat' | 'off' = 'bar';

  // Sampler channel mute (level kept so unmute restores it)
  private samplerMuted = false;
  private samplerLevel = 0.9;

  // Deck → sampler recording (one session at a time)
  private deckRecordNode: AudioWorkletNode | null = null;
  private deckRecordSession: DeckRecordSession | null = null;
  private deckRecordPending: AudioBuffer | null = null;

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
    // Full deck-style channel chain: trim → 3-band EQ → filter → fader/mute,
    // plus a post-fader FX send into fxBus and a pre-fader cue tap into
    // cueBus — the same positions as the deck channel chain (source →
    // stretch → trim → EQ → filter → analyser → fader → xfade → master,
    // cue tapped post-filter/pre-fader, FX sent post-fader). Filter uses
    // the SAME allpass/lowpass/highpass behavior as the deck setFilter.
    // Defaults are neutral (trim unity, EQ flat, filter allpass at
    // 20 kHz, FX send closed, cue off) so the sampler sounds exactly
    // as before until a knob moves.
    this.samplerBus = this.ctx.createGain();
    this.samplerTrim = this.ctx.createGain();
    this.samplerTrim.gain.value = 1;
    this.samplerEqLow = this.ctx.createBiquadFilter();
    this.samplerEqLow.type = 'lowshelf'; this.samplerEqLow.frequency.value = 200;
    this.samplerEqMid = this.ctx.createBiquadFilter();
    this.samplerEqMid.type = 'peaking'; this.samplerEqMid.frequency.value = 1000; this.samplerEqMid.Q.value = 1;
    this.samplerEqHigh = this.ctx.createBiquadFilter();
    this.samplerEqHigh.type = 'highshelf'; this.samplerEqHigh.frequency.value = 3000;
    this.samplerFilter = this.ctx.createBiquadFilter();
    this.samplerFilter.type = 'allpass'; this.samplerFilter.frequency.value = 20000;
    this.samplerFxSend = this.ctx.createGain();
    this.samplerFxSend.gain.value = 0; // FX sends start closed (Phase 6)
    this.samplerCueGain = this.ctx.createGain();
    this.samplerCueGain.gain.value = 0; // cue OFF by default — real isolation
    this.samplerMaster = this.ctx.createGain();
    this.samplerMaster.gain.value = 0.9;
    this.samplerBus.connect(this.samplerTrim);
    this.samplerTrim.connect(this.samplerEqLow);
    this.samplerEqLow.connect(this.samplerEqMid);
    this.samplerEqMid.connect(this.samplerEqHigh);
    this.samplerEqHigh.connect(this.samplerFilter);
    this.samplerFilter.connect(this.samplerMaster);
    this.samplerMaster.connect(this.masterBus);
    this.samplerMaster.connect(this.samplerFxSend);
    this.samplerFxSend.connect(this.fxBus);
    this.samplerFilter.connect(this.samplerCueGain);
    this.samplerCueGain.connect(this.cueBus);
    // Passive meter tap for the sampler channel strip (analyser does not
    // alter the audio passing through samplerMaster).
    this.samplerAnalyser = this.ctx.createAnalyser();
    this.samplerAnalyser.fftSize = 256;
    this.samplerMaster.connect(this.samplerAnalyser);

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

    // Continuous sync PLL (50ms tick — tight enough to hold phase on
    // steady 4/4 grids without churning the tempo every frame)
    this.syncTimer = window.setInterval(() => this.syncTick(), 50);
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
      posBase: 0, posBaseTime: ctx.currentTime, posRate: 1, pendingStartAt: null,
      userTempo: 1, syncBaseTempo: 1, syncCorr: 1, syncInt: 0, syncFollowSm: 1, syncLockStreak: 0, nudge: 0, nudgeDeadline: 0,
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
    // A queued quantized launch reports its queued offset until the
    // scheduled start time passes (never a negative/integrated value).
    if (d.pendingStartAt !== null) {
      if (this.ctx.currentTime < d.pendingStartAt) return d.posBase;
      d.pendingStartAt = null;
    }
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

  play(id: string, opts?: { offset?: number; alignToMaster?: boolean; startAt?: number }): void {
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

    // A future startAt is a queued quantized launch (see playQuantized):
    // the source is created now but starts on the grid, and the deck
    // reports the queued offset until then.
    const now = this.ctx.currentTime;
    const t = opts?.startAt !== undefined ? Math.max(opts.startAt, now + 0.02) : now + 0.02;
    d.source = src;
    d.posBase = offset;
    d.posBaseTime = t;
    d.pendingStartAt = opts?.startAt !== undefined && t > now + 0.03 ? t : null;
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
    d.pendingStartAt = null; // also cancels a queued quantized launch
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
      // Round 5: snap the smoothed follow to the same starting ratio so
      // the first ticks don't glide from a stale value, and reset the
      // lock streak — a fresh sync-on has not earned LOCKED yet.
      d.syncFollowSm = d.syncBaseTempo;
      d.syncLockStreak = 0;
      d.syncCorr = 1;
      d.syncInt = 0;
      this.applyTempo(d);
    } else {
      // Release: keep current effective tempo as the user tempo
      d.userTempo = clamp(this.effectiveTempo(d), 0.5, 2);
      d.syncCorr = 1;
      d.syncInt = 0;
      d.syncLockStreak = 0;
      this.applyTempo(d);
    }
  }

  setMaster(id: string | null): void {
    this.masterDeckId = id;
  }

  /** Current user-tempo value for a deck (audio truth after a sync
   *  release, where setSync(false) keeps the effective tempo as the
   *  user tempo). Read-only: the UI mirrors it into the fader so the
   *  fader never jumps when sync disengages. */
  userTempoFor(id: string): number {
    return this.decks.get(id)?.userTempo ?? 1;
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
    // Within-bar positions, each in its own grid's phase frame: the
    // master's fractional position relative to ITS downbeats, and the
    // slave beat's position relative to ITS downbeats. Matching those
    // (not raw index residues) is what keeps drops phrase-aligned when
    // either grid has been re-anchored by Set 1.1 / auto-1.1.
    const mGrid = this.masterDeckId ? this.decks.get(this.masterDeckId)?.grid : null;
    const mPhase = mGrid ? barPhaseOf(mGrid) : 0;
    const masterBarPhase = ((((Math.round(mBeats - mPhase)) % 4) + 4) % 4);
    const sPhase = barPhaseOf(d.grid);

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
        const phase = (((first - sPhase) % 4) + 4) % 4;
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
   * Continuous sync: phase-locked loop. Every 50ms, for each synced slave,
   * tempo-follow the master and apply a proportional + integral correction
   * toward zero bar-phase error. This is what keeps decks from drifting
   * apart. Phase 5: applyTempo is now called whenever EITHER the follow
   * tempo or the correction changed (previously a follow-only change never
   * reached the audio rate), and the P-gain is a true proportional band.
   * EDM retune: 50ms tick (was 100ms), deadband so sub-2.5ms error never
   * churns the tempo, and a faster integral so steady-state offset dies
   * instead of lingering. Launch quantization (playQuantized) does the
   * big phase jumps at start time; this PLL only has to HOLD the lock.
   * Round 5: the tempo-follow ratio is smoothed with a 2s glide (raw
   * per-section BPM steps on walked grids used to yank the rate by
   * tens of percent and the PLL could never hold phase against that),
   * the integral clamp is 1% with a 2%/s slew limit, and the LOCKED
   * claim moved to syncStatus as a sustained + grid-trusted criterion.
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
      let changed = false;
      // Tempo follow — SMOOTHED (round 5). bpmAtPosition on a walked
      // (non-steady) grid returns the current SECTION's BPM, which steps
      // between section estimates as the track plays: the Oct 25 live
      // retest follower showed a 0.661 launch rate, consistent with a
      // ~186-BPM section estimate (123/186). Feeding such steps straight
      // into the rate lurches the follower's TRUE tempo by tens of
      // percent per section — the ear hears pumping even while the
      // counter (which is built from the same grid) reads locked. A 2s
      // one-pole glide turns steps into ramps: short blips wash out
      // and real drift (slow) is still tracked. Stated limits: the
      // glide does NOT cure a persistently misestimated section — the
      // true tempo still ends up wrong there, just gradually instead
      // of instantly — and during a glide the counter transiently
      // deviates (PLL authority < glide lag on big steps), so LOCKED
      // will correctly drop at section boundaries on bad grids. That
      // is the label telling the truth, not a regression: a lasting
      // audible lock on a bad grid needs grid repair, not loop tuning.
      const target = clamp(mBpm / slaveBpm, 0.5, 2);
      const alpha = 1 - Math.exp(-0.05 / 2); // 50ms tick, 2s time constant
      d.syncFollowSm += (target - d.syncFollowSm) * alpha;
      if (Math.abs(d.syncFollowSm - d.syncBaseTempo) > 0.0002) {
        d.syncBaseTempo = d.syncFollowSm;
        changed = true;
      }
      // Phase correction from the beat counters (map-aware on both sides).
      // Bar-range wrap: being a whole bar ahead is alignment, not error.
      const sBeats = this.beatsAtPosition(d, this.position(d.id));
      const err = phaseErrorBeats(mBeats, sBeats, 4); // + = slave ahead
      const errMs = (err * 60) / mBpm * 1000;
      // Deadband: sub-2.5ms error counts as locked, never churns tempo.
      const errCtl = Math.abs(err) < 0.005 ? 0 : err;
      // Integral term: absorbs steady-state rate mismatch so it dies
      // instead of lingering. Round 5: clamp widened 0.5% → 1% (with the
      // old 0.5% clamp and P = 0.25, a 1% residual mismatch still left
      // ~10ms standing error — (1% − 0.5%) / 0.25 = 0.02 beats ≈ 10ms
      // at 123 BPM — and 1.5% left ~20ms; mismatches up to 1% are now
      // fully absorbed), with the per-tick step clamped so the
      // integral can only slew 2%/s — no audible rate jumps from the
      // integrator itself.
      const dInt = clamp(errCtl * 0.004, -0.001, 0.001);
      d.syncInt = clamp(d.syncInt + dInt, -0.01, 0.01);
      const corr = pllCorrection(errCtl, d.syncInt);
      if (Math.abs(corr - d.syncCorr) > 0.0002) {
        d.syncCorr = corr;
        changed = true;
      }
      // Lock streak (round 5): LOCKED is a sustained claim, not one
      // lucky poll. 10 consecutive ticks (500ms) inside ±30ms — the
      // flam-fusion window: inside it two beats sound like ONE beat,
      // outside it the ear hears a flam/double-hit.
      if (Math.abs(errMs) <= 30) d.syncLockStreak += 1; else d.syncLockStreak = 0;
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
      // Binary search for the insertion point, then pick the nearer neighbor.
      // Before the first mapped beat, extrapolate beats backward at the
      // first section's tempo (the intro grid) instead of snapping
      // forward to beats[0] — that forward snap is the play-from-0 jerk.
      let lo = 0;
      let hi = g.beats.length - 1;
      if (time <= g.beats[0]) {
        const curveBpm = g.bpmCurve[0] ?? g.bpm;
        const localSpb = curveBpm > 0 ? 60 / curveBpm : 60 / g.bpm;
        const k = Math.round((g.beats[0] - time) / localSpb);
        snapped = g.beats[0] - k * localSpb;
      } else if (time >= g.beats[hi]) snapped = g.beats[hi];
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

  /** Audio time of the next master boundary of `cycleBeats` beats, ≥ minAheadSec out. */
  private nextMasterBoundaryTime(cycleBeats: number, minAheadSec: number): number | null {
    const mBeats = this.masterBeats();
    const mBpm = this.masterEffectiveBpm();
    if (mBeats === null || !mBpm) return null;
    const spb = 60 / mBpm;
    // Bar boundaries live on the master grid's phase: downbeats are at
    // mBeats === barPhase (mod 4), not at 0, once the grid is re-anchored.
    // Beat boundaries (cycle 1) are phase-free by definition.
    const mGrid = cycleBeats === 4 && this.masterDeckId
      ? this.decks.get(this.masterDeckId)?.grid ?? null
      : null;
    const phase = mGrid ? barPhaseOf(mGrid) : 0;
    const wait = nextBoundaryWaitBeats(mBeats - phase, cycleBeats, minAheadSec / spb);
    return this.ctx.currentTime + wait * spb;
  }

  /** Audio time (ctx.currentTime) of the next master bar boundary ≥ `minAheadSec` out. */
  nextBarTime(minAheadSec = 0.25): number | null {
    return this.nextMasterBoundaryTime(4, minAheadSec);
  }

  /** Audio time of the next master beat boundary ≥ `minAheadSec` out. */
  nextBeatTime(minAheadSec = 0.1): number | null {
    return this.nextMasterBoundaryTime(1, minAheadSec);
  }

  /** First downbeat-phase offset at/after `cuePoint` on this deck's grid. */
  downbeatOffset(id: string, cuePoint: number): number {
    const d = this.decks.get(id);
    if (!d || !d.grid || d.grid.bpm <= 0) return cuePoint;
    return downbeatOffsetFor(d.grid, cuePoint, d.buffer?.duration ?? 0);
  }

  /** Set the deck-launch quantization mode ('bar' default, 'beat', or 'off'). */
  setLaunchQuantize(mode: 'bar' | 'beat' | 'off'): void {
    this.launchQuantize = mode;
  }

  /**
   * EDM quantized launch — the single hook for deck Play and CUE starts.
   * When launchQuantize is on and a master deck is playing, the deck does
   * NOT start mid-beat: it waits for the master's next bar boundary
   * ('bar' mode) or next beat ('beat' mode) and starts there at its own
   * downbeat (bar mode) or nearest beat (beat mode), so drops land
   * together in phase. No master playing, or quantize off → immediate
   * play, exactly like play(). A queued launch is a scheduled source:
   * pause()/seek() cancel it, and position() reports the queued offset
   * until the start time passes. Returns the scheduled audio time, or
   * null when the deck has no buffer. The caller (App) gates this on the
   * deck's Q toggle, so Q off always means manual, immediate control.
   */
  playQuantized(id: string, opts?: { offset?: number }): number | null {
    const d = this.decks.get(id);
    if (!d || !d.buffer) return null;
    const offset = opts?.offset ?? d.posBase;
    const masterPlaying = this.masterDeckId !== null && this.masterDeckId !== id
      && this.isPlaying(this.masterDeckId) && this.masterBeats() !== null;
    if (this.launchQuantize === 'off' || !masterPlaying) {
      this.play(id, { offset });
      return this.ctx.currentTime;
    }
    const mode = this.launchQuantize;
    const startAt = mode === 'bar' ? this.nextBarTime(0.25) : this.nextBeatTime(0.1);
    if (startAt === null) {
      this.play(id, { offset });
      return this.ctx.currentTime;
    }
    // Intro lead-in rule (bar mode): when the requested offset sits
    // before the first downbeat-phase beat, starting at that downbeat
    // would skip the intro (the jerk). Start at the offset exactly at
    // the next master bar boundary instead: the backward-extended grid
    // defines the offset's phase, and the PLL locks during the lead-in,
    // so the drop lands in phase. At/after the first downbeat, keep
    // the existing downbeat jump so drops stay phrase-aligned.
    let startOffset: number;
    if (mode === 'bar') {
      const firstDownbeat = this.downbeatOffset(id, 0);
      startOffset = offset < firstDownbeat ? offset : this.downbeatOffset(id, offset);
    } else {
      startOffset = this.quantizeToBeat(id, offset);
    }
    this.play(id, { offset: startOffset, startAt });
    debugLog('transport', 'quantized launch queued', id, { mode, at: startAt, offset: startOffset });
    return startAt;
  }

  /**
   * Sync lock readout for the UI: null when not a playing synced slave.
   * Round 5 — LOCKED is honest. It requires ALL of: (a) a sustained
   * tight lock — 10 consecutive 50ms ticks inside ±30ms AND currently
   * inside ±30ms, so one lucky poll can't claim it; (b) trustworthy
   * grids on BOTH sides (confidence ≥ 0.4, the codebase's own "flag
   * for manual fixing" line). On a low-confidence follower grid the
   * counter phase itself is unreliable — mapped beats deviate from
   * true beats — so no confident lock is ever claimed there; the ±ms
   * readout still shows the measured error. Threshold basis: ±30ms
   * is the flam-fusion window — inside it two beats sound like ONE,
   * outside it the ear hears a flam/double-hit.
   */
  syncStatus(id: string): { errBeats: number; errMs: number; locked: boolean } | null {
    const d = this.decks.get(id);
    if (!d || !d.syncOn || d.id === this.masterDeckId || !d.source || !d.grid || d.grid.bpm <= 0) return null;
    // Round 5: during a queued quantized launch the position integrator
    // is frozen at the queued offset while the master advances, so the
    // phase error would climb toward a full bar and then snap at the
    // drop. That number is meaningless — the QUEUED badge already
    // covers this state — so report no lock readout until the drop.
    if (d.pendingStartAt !== null && this.ctx.currentTime < d.pendingStartAt) return null;
    const mBeats = this.masterBeats();
    const mBpm = this.masterEffectiveBpm();
    if (mBeats === null || !mBpm) return null;
    const mGrid = this.masterDeckId ? this.decks.get(this.masterDeckId)?.grid : undefined;
    const gridsTrusted = d.grid.confidence >= 0.4 && (mGrid?.confidence ?? 0) >= 0.4;
    const sBeats = this.beatsAtPosition(d, this.position(d.id));
    const err = phaseErrorBeats(mBeats, sBeats, 4);
    const errMs = (err * 60) / mBpm * 1000;
    const locked = gridsTrusted && d.syncLockStreak >= 10 && Math.abs(errMs) <= 30;
    return { errBeats: err, errMs, locked };
  }

  /** Audio time of a queued quantized launch, or null when none is queued. */
  pendingLaunchAt(id: string): number | null {
    return this.decks.get(id)?.pendingStartAt ?? null;
  }

  /**
   * Absolute audio time of the next quantized boundary, or null when no
   * reference is playing. Master reference first (tempo-aware); falls
   * back to the first playing deck with a beat map. Shared by pad
   * triggers (beat mode) so samples launch on the same grid as decks.
   */
  nextQuantizedAudioTime(mode: 'bar' | 'beat'): number | null {
    const fromMaster = mode === 'bar' ? this.nextBarTime(0.1) : this.nextBeatTime(0.05);
    if (fromMaster !== null) return fromMaster;
    const refId = [...this.decks.keys()].find((id) => this.isPlaying(id) && this.decks.get(id)?.grid?.beats?.length);
    if (!refId) return null;
    const deck = this.decks.get(refId)!;
    const grid = deck.grid!;
    const pos = this.position(refId);
    let next: number | undefined;
    if (mode === 'bar') {
      // Next downbeat-phase beat (index ≡ barPhase mod 4 on that grid)
      const phase = barPhaseOf(grid);
      next = grid.beats.find((b, i) => b > pos && (((i - phase) % 4) + 4) % 4 === 0);
    }
    if (next === undefined) next = grid.beats.find((b) => b > pos);
    if (next === undefined) return null;
    const rate = deck.posRate || 1;
    return this.ctx.currentTime + Math.max(0, (next - pos) / rate);
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

  /**
   * Same EQ move as setEq but without the debug-log line — for autopilot
   * automation ticks, which would otherwise flood the log several times a
   * second for the whole blend. The parameter smoothing (tau 0.05) is what
   * keeps automated moves click-free.
   */
  setEqAuto(id: string, band: 'low' | 'mid' | 'high', v: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    const t = this.ctx.currentTime;
    const node = band === 'low' ? d.eqLow : band === 'mid' ? d.eqMid : d.eqHigh;
    node.gain.setTargetAtTime(clamp(v, -1, 1) * 26, t, 0.05);
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

  // ─── Audio-clock automation (autopilot background scheduling) ────────
  // The autopilot driver programs transitions on the audio clock so the
  // AUDIBLE blend executes even when the browser throttles JS timers in
  // a hidden tab. These are AudioParam automation events: once scheduled,
  // the audio thread renders them with no further JS involvement. A later
  // JS wakeup only does bookkeeping (role swap, status) and catch-up.
  // NOTE: these touch deck crossfader/EQ params only — never the sampler
  // chain (a separate branch owns sampler strip parity).

  /**
   * Audio time (ctx.currentTime) when a deck reaches a track position, or
   * null when it cannot be computed: no buffer, no positive rate, or the
   * deck is looping (position wraps, so the linear map does not hold).
   * position() itself is this same linear map, so this is the audio-clock
   * truth the driver schedules against — not wall-clock time.
   */
  audioTimeAtTrackPos(id: string, trackPos: number): number | null {
    const d = this.decks.get(id);
    if (!d || !d.buffer || d.posRate <= 0) return null;
    if (d.loopStart !== null && d.loopEnd !== null) return null;
    return d.posBaseTime + (trackPos - d.posBase) / d.posRate;
  }

  private crossfaderGains(v: number): [number, number] {
    const angle = ((clamp(v, -1, 1) + 1) / 2) * (Math.PI / 2);
    return [Math.cos(angle), Math.sin(angle)];
  }

  /**
   * Schedule a full crossfader move on the audio clock (sampled
   * equal-power curve). After the curve ends the gains hold at the target
   * values, so the blend completes even if JS never wakes again.
   */
  scheduleCrossfaderCurve(fromV: number, toV: number, startAt: number, durSec: number): void {
    const a = this.decks.get('deckA');
    const b = this.decks.get('deckB');
    if (!a || !b) return;
    if (durSec <= 0) { this.setCrossfader(toV); return; }
    const start = Math.max(startAt, this.ctx.currentTime);
    const pts = 128;
    const curveA = new Float32Array(pts);
    const curveB = new Float32Array(pts);
    for (let i = 0; i < pts; i++) {
      const v = fromV + (toV - fromV) * (i / (pts - 1));
      const [ga, gb] = this.crossfaderGains(v);
      curveA[i] = ga;
      curveB[i] = gb;
    }
    const [gA0, gB0] = this.crossfaderGains(fromV);
    for (const [node, g0, curve] of [
      [a.xfade, gA0, curveA],
      [b.xfade, gB0, curveB],
    ] as const) {
      node.gain.cancelScheduledValues(start);
      node.gain.setValueAtTime(g0, start);
      node.gain.setValueCurveAtTime(curve, start, durSec);
    }
  }

  /**
   * Schedule an EQ move on one band (knob values, dB = knob × 26, same
   * mapping as setEqAuto) on the audio clock. durSec <= 0 steps the
   * value at startAt. Mid Q is left alone — only the gain is automated.
   */
  scheduleEqCurve(
    id: string,
    band: 'low' | 'mid' | 'high',
    fromKnob: number,
    toKnob: number,
    startAt: number,
    durSec: number,
  ): void {
    const d = this.decks.get(id);
    if (!d) return;
    const node = band === 'low' ? d.eqLow : band === 'mid' ? d.eqMid : d.eqHigh;
    const start = Math.max(startAt, this.ctx.currentTime);
    const fromDb = clamp(fromKnob, -1, 1) * 26;
    const toDb = clamp(toKnob, -1, 1) * 26;
    if (durSec <= 0) {
      node.gain.cancelScheduledValues(start);
      node.gain.setValueAtTime(toDb, start);
      return;
    }
    const pts = 64;
    const curve = new Float32Array(pts);
    for (let i = 0; i < pts; i++) curve[i] = fromDb + (toDb - fromDb) * (i / (pts - 1));
    node.gain.cancelScheduledValues(start);
    node.gain.setValueAtTime(fromDb, start);
    node.gain.setValueCurveAtTime(curve, start, durSec);
  }

  /** Low-band shorthand for the original bass-swap call sites. */
  scheduleEqLowCurve(id: string, fromKnob: number, toKnob: number, startAt: number, durSec: number): void {
    this.scheduleEqCurve(id, 'low', fromKnob, toKnob, startAt, durSec);
  }

  /**
   * Schedule a lowpass filter sweep (v in [-1, 0], same frequency
   * mapping as setFilter: 0 = 20kHz open, -1 = 100Hz closed) on the
   * audio clock. The type switch to lowpass happens immediately: at
   * 20kHz it is inaudible on the outgoing side, and the incoming side
   * is quiet under the crossfader until the blend opens it. The driver
   * restores allpass with setFilter(id, 0) at the finish.
   */
  scheduleFilterCurve(id: string, fromV: number, toV: number, startAt: number, durSec: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    const start = Math.max(startAt, this.ctx.currentTime);
    const freq = (v: number): number => 100 * Math.pow(200, 1 - Math.abs(clamp(v, -1, 0)));
    d.filter.type = 'lowpass';
    d.filter.Q.value = 2;
    if (durSec <= 0) {
      d.filter.frequency.cancelScheduledValues(start);
      d.filter.frequency.setValueAtTime(freq(toV), start);
      return;
    }
    const pts = 64;
    const curve = new Float32Array(pts);
    for (let i = 0; i < pts; i++) curve[i] = freq(fromV + (toV - fromV) * (i / (pts - 1)));
    d.filter.frequency.cancelScheduledValues(start);
    d.filter.frequency.setValueAtTime(freq(fromV), start);
    d.filter.frequency.setValueCurveAtTime(curve, start, durSec);
  }

  /** Hold a low-EQ value from an audio time (step — used for the blend-start bass cut). */
  scheduleEqLowHold(id: string, knob: number, at: number): void {
    const d = this.decks.get(id);
    if (!d) return;
    d.eqLow.gain.cancelScheduledValues(at);
    d.eqLow.gain.setValueAtTime(clamp(knob, -1, 1) * 26, at);
  }

  /** Cancel outstanding scheduled automation on a deck's low EQ only (live bass-swap: the crossfader curve keeps running). */
  cancelEqAutomation(id: string): void {
    this.decks.get(id)?.eqLow.gain.cancelScheduledValues(this.ctx.currentTime);
  }

  /** Cancel outstanding scheduled automation on one EQ band of a deck. */
  cancelEqBandAutomation(id: string, band: 'low' | 'mid' | 'high'): void {
    const d = this.decks.get(id);
    if (!d) return;
    const node = band === 'low' ? d.eqLow : band === 'mid' ? d.eqMid : d.eqHigh;
    node.gain.cancelScheduledValues(this.ctx.currentTime);
  }

  /** Cancel outstanding scheduled automation on all three EQ bands of a deck (crossfader untouched). */
  cancelEqAllBands(id: string): void {
    this.cancelEqBandAutomation(id, 'low');
    this.cancelEqBandAutomation(id, 'mid');
    this.cancelEqBandAutomation(id, 'high');
  }

  /**
   * Cancel outstanding scheduled automation on a deck's crossfader (both
   * sides — the crossfader is shared) and all EQ bands. Call before any
   * immediate move (takeover, blend finish) so a scheduled curve cannot
   * override it afterwards. Manual moves use setTargetAtTime, not
   * scheduled values, so they are unaffected.
   */
  cancelDeckAutomation(id: string): void {
    const t = this.ctx.currentTime;
    const d = this.decks.get(id);
    d?.eqLow.gain.cancelScheduledValues(t);
    d?.eqMid.gain.cancelScheduledValues(t);
    d?.eqHigh.gain.cancelScheduledValues(t);
    this.decks.get('deckA')?.xfade.gain.cancelScheduledValues(t);
    this.decks.get('deckB')?.xfade.gain.cancelScheduledValues(t);
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

  setLoop(id: string, start: number | null, end: number | null, opts?: { allowEndAtDuration?: boolean }): void {
    const d = this.decks.get(id);
    if (!d) return;
    let s = start;
    let e = end;
    if (s != null && e != null && d.buffer) {
      const dur = d.buffer.duration;
      if (!opts?.allowEndAtDuration && e >= dur) {
        // Boundary hazard: a loop ending exactly at file end can play
        // through the dead tail and hit source end before the wrap
        // fires. Pull back one beat (grid) so the wrap always fires
        // first. Generated bridge buffers opt out (their loop IS the
        // whole buffer, by construction).
        const beat = d.grid && d.grid.bpm > 0 ? 60 / d.grid.bpm : 0.5;
        debugLog('transport', 'loop end clamped', id, { from: e, to: dur - beat });
        e = dur - beat;
      }
      if (e <= s) {
        debugLog('transport', 'loop refused', id, { start: s, end: e });
        return;
      }
    }
    const wasPlaying = !!d.source;
    const pos = this.position(id);
    if (wasPlaying) this.pause(id);
    d.loopStart = s;
    d.loopEnd = e;
    debugLog('transport', 'loop set', id, { start: s, end: e, length: s != null && e != null ? e - s : null });
    if (wasPlaying) this.play(id, { offset: pos });
  }

  /**
   * Loop-out (Traktor loop exit): release the loop and keep playing
   * forward from the current position. It never jumps back to the track
   * start or to the loop end — pause() captures the exact wrapped
   * position, the loop state is cleared, and play() restarts from that
   * same position with no loop region.
   */
  exitLoop(id: string): void {
    const d = this.decks.get(id);
    if (!d) return;
    const wasPlaying = !!d.source;
    const pos = this.position(id);
    if (wasPlaying) this.pause(id);
    d.loopStart = null;
    d.loopEnd = null;
    debugLog('transport', 'loop exit', id, { at: pos, wasPlaying });
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
    d.pendingStartAt = null;
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

  samplerOutputLevel(): number {
    return this.samplerAnalyser ? this.meter(this.samplerAnalyser) : 0;
  }

  phonesLevel(): number {
    return this.meter(this.phonesAnalyser);
  }

  // ─── Sampler ────────────────────────────────────────────────────────────

  /** Load an AudioBuffer into a pad. Returns false if index out of range.
   * A running loop is stopped (no further iterations scheduled) but a
   * voice already sounding finishes its pass, matching one-shot loads. */
  loadSample(padIndex: number, buffer: AudioBuffer, name: string): boolean {
    if (padIndex < 0 || padIndex > 7 || !this.ctx) return false;
    this.stopPadLoop(padIndex);
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
    this.stopPadLoop(padIndex);
    try { pad.source?.stop(); } catch { /* already stopped */ }
    pad.source = null;
    pad.buffer = null;
    pad.name = '';
    pad.loop = false;
  }

  setPadVolume(padIndex: number, v: number): void {
    if (padIndex < 0 || padIndex > 7) return;
    this.pads[padIndex].volume = Math.min(1, Math.max(0, v));
  }

  setSamplerMaster(v: number): void {
    if (!this.ctx) return;
    this.samplerLevel = Math.min(1, Math.max(0, v));
    this.samplerMaster.gain.setTargetAtTime(
      this.samplerMuted ? 0 : this.samplerLevel, this.ctx.currentTime, 0.02);
  }

  setSamplerMuted(muted: boolean): void {
    if (!this.ctx) return;
    this.samplerMuted = muted;
    this.samplerMaster.gain.setTargetAtTime(
      muted ? 0 : this.samplerLevel, this.ctx.currentTime, 0.02);
  }

  /** Sampler trim — same range/smoothing as the deck trim (gain 0–2). */
  setSamplerTrim(v: number): void {
    if (!this.ctx) return;
    this.samplerTrim.gain.setTargetAtTime(clamp(v, 0, 2), this.ctx.currentTime, 0.03);
    debugLog('param', 'trim', 'sampler', { v });
  }

  /**
   * Sampler 3-band EQ — mirrors the deck setEq exactly: knob v in [-1, 1]
   * maps to ±26 dB (center detent = flat), kill drops the band to -60 dB
   * (mid Q goes to 2 on kill, else 1). Same 0.05 smoothing tau.
   */
  setSamplerEq(band: 'low' | 'mid' | 'high', v: number, kill: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const node = band === 'low' ? this.samplerEqLow : band === 'mid' ? this.samplerEqMid : this.samplerEqHigh;
    const db = kill ? -60 : clamp(v, -1, 1) * 26;
    node.gain.setTargetAtTime(db, t, 0.05);
    if (band === 'mid') node.Q.setTargetAtTime(kill ? 2 : 1, t, 0.05);
    debugLog('param', `eq ${band}`, 'sampler', { knob: v, db, kill });
  }

  /**
   * Sampler filter — mirrors the deck setFilter exactly: |v| < 0.05 →
   * allpass at 20 kHz (neutral); v < 0 → lowpass 100 * 200^(1-|v|);
   * v > 0 → highpass 20 * 250^v; Q = 1 + |v| * 2. Same 0.05 tau.
   */
  setSamplerFilter(v: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (Math.abs(v) < 0.05) {
      this.samplerFilter.type = 'allpass';
      this.samplerFilter.frequency.setTargetAtTime(20000, t, 0.05);
    } else if (v < 0) {
      this.samplerFilter.type = 'lowpass';
      const f = 100 * Math.pow(200, 1 - Math.abs(v));
      this.samplerFilter.frequency.setTargetAtTime(f, t, 0.05);
      this.samplerFilter.Q.value = 1 + Math.abs(v) * 2;
    } else {
      this.samplerFilter.type = 'highpass';
      const f = 20 * Math.pow(250, v);
      this.samplerFilter.frequency.setTargetAtTime(f, t, 0.05);
      this.samplerFilter.Q.value = 1 + v * 2;
    }
    debugLog('param', 'filter', 'sampler', { v });
  }

  /** Sampler FX send — post-fader send into fxBus, mirroring setFxSend
   * (gain 0–1, 0.03 tau, closed by default). The sampler is then
   * processable by the existing FX unit exactly like a deck channel. */
  setSamplerFxSend(v: number): void {
    if (!this.ctx) return;
    this.samplerFxSend.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.03);
  }

  /** Sampler cue — mirrors the deck setCue: pre-fader tap (post-filter)
   * into the cue bus, 1/0 with 0.02 tau. Reaches only the phones mix,
   * never masterBus directly. */
  setSamplerCue(on: boolean): void {
    if (!this.ctx) return;
    this.samplerCueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    debugLog('param', 'cue', 'sampler', { on });
  }

  isSamplerMuted(): boolean {
    return this.samplerMuted;
  }

  setSamplerQuantize(on: boolean): void {
    this.samplerQuantize = on;
  }

// ─── Deck → sampler recording ─────────────────────────────────────
  // Tap: the deck's `fader` output — post-trim/EQ/filter, post-channel
  // fader, pre-crossfader. That is the deck's own channel sound (what
  // the DJ hears from that deck, EQ + fader applied) regardless of
  // crossfader position, so a cued deck can be sampled while it is
  // crossfaded out. FX return is NOT included (it feeds masterBus
  // separately). The tap is parallel — fader → record node in addition
  // to fader → xfade — so recording never interrupts the playing deck
  // or the master output. The recorder worklet outputs silence; its
  // output feeds masterDest (zeros, inaudible), the same pattern as the
  // master recorder tap, so the node stays pulled. Pads are one-shots,
  // so recordings cap at 30s with an auto-stop.

  startDeckRecord(deckId: string): boolean {
    if (!this.ctx || !this.workletReady || !this.masterDest) return false;
    if (this.deckRecordSession) return false;
    const d = this.decks.get(deckId);
    if (!d || !d.buffer || !this.isPlaying(deckId)) return false;
    if (!this.deckRecordNode) {
      const node = new AudioWorkletNode(this.ctx, 'velz-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { type?: string; left?: Float32Array; right?: Float32Array };
        if (m?.type === 'data' && this.deckRecordSession) {
          if (m.left) this.deckRecordSession.left.push(m.left);
          if (m.right) this.deckRecordSession.right.push(m.right);
        }
      };
      node.connect(this.masterDest);
      this.deckRecordNode = node;
    }
    try {
      d.fader.connect(this.deckRecordNode);
    } catch {
      return false;
    }
    const session: DeckRecordSession = { deckId, left: [], right: [], timer: null };
    session.timer = window.setTimeout(() => {
      void this.finishDeckRecord(true);
    }, SAMPLER_RECORD_MAX_SECONDS * 1000);
    this.deckRecordSession = session;
    this.deckRecordNode.port.postMessage({ type: 'start' });
    debugLog('audio', 'record start', deckId, {});
    return true;
  }

  isDeckRecording(): boolean {
    return !!this.deckRecordSession;
  }

  /** Manual stop: returns the captured buffer (null if nothing captured). */
  async stopDeckRecord(): Promise<AudioBuffer | null> {
    return this.finishDeckRecord(false);
  }

  /** Buffer assembled by an auto-stop (cap reached); the UI takes it once. */
  takePendingRecord(): AudioBuffer | null {
    const b = this.deckRecordPending;
    this.deckRecordPending = null;
    return b;
  }

  private async finishDeckRecord(auto: boolean): Promise<AudioBuffer | null> {
    const session = this.deckRecordSession;
    if (!session) return null;
    this.deckRecordSession = null;
    if (session.timer !== null) window.clearTimeout(session.timer);
    const d = this.decks.get(session.deckId);
    try {
      d?.fader.disconnect(this.deckRecordNode as AudioWorkletNode);
    } catch {
      // Tap was already disconnected.
    }
    this.deckRecordNode?.port.postMessage({ type: 'stop' });
    // The worklet flushes its partial block asynchronously; give the port
    // message a moment to land before assembling.
    await new Promise((r) => setTimeout(r, 120));
    const buffer = this.assembleRecordBuffer(session.left, session.right);
    if (auto) this.deckRecordPending = buffer;
    debugLog('audio', auto ? 'record auto-stop' : 'record stop', session.deckId, {
      seconds: buffer?.duration ?? 0,
    });
    return buffer;
  }

  private assembleRecordBuffer(left: Float32Array[], right: Float32Array[]): AudioBuffer | null {
    const total = left.reduce((n, c) => n + c.length, 0);
    if (total === 0) return null;
    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(2, total, sr);
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(1);
    let o = 0;
    for (let i = 0; i < left.length; i++) {
      l.set(left[i], o);
      r.set(right[i] ?? left[i], o);
      o += left[i].length;
    }
    // Short fades at both ends so the cut never clicks.
    const fade = Math.min(Math.floor(sr * 0.005), Math.floor(total / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      l[i] *= g;
      r[i] *= g;
      l[total - 1 - i] *= g;
      r[total - 1 - i] *= g;
    }
    return buffer;
  }

/** Trigger a pad. Retriggers if already playing. Quantize snaps to the
   * next master beat through the shared quantization hook (pads use beats
   * so one-shots stay snappy; decks use bars). Default ON.
   *
   * Loop mode: when the pad's loop flag is armed, triggering STARTS a
   * repeating loop (first hit quantized like a one-shot); triggering
   * again STOPS it — the voice already sounding finishes its pass and
   * no further iterations are scheduled. Loop mode off = one-shot,
   * exactly as before. */
  triggerSample(padIndex: number): boolean {
    if (!this.ctx || padIndex < 0 || padIndex > 7) return false;
    const pad = this.pads[padIndex];
    if (!pad.buffer) return false;

    if (pad.loop) {
      if (pad.looping) {
        this.stopPadLoop(padIndex);
        return true;
      }
      return this.startPadLoop(padIndex);
    }

    // Retrigger: stop current voice
    try { pad.source?.stop(); } catch { /* already stopped */ }

    let when = this.ctx.currentTime;
    if (this.samplerQuantize) {
      const q = this.nextQuantizedAudioTime('beat');
      if (q !== null) when = q;
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

  /**
   * Arm/disarm a pad's loop mode. Disarming a running loop stops it the
   * same way as triggering the pad again: the current pass finishes,
   * nothing new is scheduled. Arming never starts playback on its own
   * (loops start only from a pad press, key, or MIDI — a user gesture).
   */
  setPadLoop(padIndex: number, on: boolean): void {
    if (padIndex < 0 || padIndex > 7) return;
    const pad = this.pads[padIndex];
    pad.loop = on;
    if (!on && pad.looping) this.stopPadLoop(padIndex);
  }

  /**
   * Loop sync semantics (the honest version — no pitch change, no
   * time-stretch; samples are plain BufferSources, not the WSOLA deck
   * path, so the sample always plays at its natural pitch and speed):
   *
   * - The loop period is the sample's duration rounded to the nearest
   *   whole number of master beats (1..32, Traktor loop sizes), measured
   *   at the master tempo when the loop starts. A sample longer than
   *   its period is cut at the period boundary; a shorter one leaves a
   *   gap of silence until the next boundary. The raw sample is never
   *   trimmed, padded, or re-pitched — only its restart points move.
   * - Iteration starts are scheduled on master beat boundaries: the
   *   first hit uses the same next-beat quantize as one-shots, and each
   *   following start is re-anchored to the live master grid (the anchor
   *   beat is rounded to the nearest whole master beat, so tempo moves
   *   shift the next boundary instead of accumulating drift).
   * - With no master deck playing, there is no grid to sync to: the
   *   loop free-runs at the last-known tempo (fx.bpm, default 124) with
   *   the same whole-beat period. Starting a deck and making it master
   *   re-anchors the loop to that grid on the next boundary.
   * - Stopping (pad tap, LOOP off, new sample, clear) finishes the
   *   current pass: scheduled-but-unstarted iterations are cancelled,
   *   the sounding voice plays to its end.
   */
  private startPadLoop(padIndex: number): boolean {
    const pad = this.pads[padIndex];
    if (!pad.buffer || pad.looping) return false;
    const state = this.padLoops[padIndex];

    const bpm = this.masterEffectiveBpm() || this.fx.bpm || 124;
    state.spb = 60 / bpm;
    state.beats = Math.min(32, Math.max(1, Math.round(pad.buffer.duration / state.spb)));

    let when = this.ctx.currentTime;
    if (this.samplerQuantize) {
      const q = this.nextQuantizedAudioTime('beat');
      if (q !== null) when = q;
    }
    when = Math.max(when, this.ctx.currentTime + 0.02);

    pad.looping = true;
    this.scheduleLoopVoice(padIndex, when);
    state.nextAt = this.loopNextStart(when, state.beats, state.spb);
    state.timer = window.setInterval(() => this.loopTick(padIndex), 50);
    return true;
  }

  /** Schedule one loop iteration at an absolute audio time. */
  private scheduleLoopVoice(padIndex: number, at: number): void {
    const pad = this.pads[padIndex];
    const state = this.padLoops[padIndex];
    if (!pad.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = pad.buffer;
    const g = this.ctx.createGain();
    g.gain.value = pad.volume;
    src.connect(g);
    g.connect(this.samplerBus);
    const entry = { src, at };
    src.onended = () => {
      const i = state.pending.indexOf(entry);
      if (i >= 0) state.pending.splice(i, 1);
      if (pad.source === src) pad.source = null;
    };
    state.pending.push(entry);
    pad.source = src;
    try {
      src.start(at);
    } catch {
      const i = state.pending.indexOf(entry);
      if (i >= 0) state.pending.splice(i, 1);
    }
  }

  /** Lookahead tick: keep the next iteration scheduled ~0.3s ahead so
   * a timer hiccup never leaves a gap, and so each boundary is computed
   * from the freshest master-grid reading. */
  private loopTick(padIndex: number): void {
    const pad = this.pads[padIndex];
    const state = this.padLoops[padIndex];
    if (!pad.looping || !pad.buffer || state.nextAt === null) {
      this.stopPadLoop(padIndex);
      return;
    }
    const now = this.ctx.currentTime;
    let guard = 0;
    while (state.nextAt !== null && state.nextAt < now + 0.3 && guard++ < 4) {
      const at: number = state.nextAt;
      this.scheduleLoopVoice(padIndex, at);
      const next = this.loopNextStart(at, state.beats, state.spb);
      state.nextAt = next <= at ? at + state.beats * state.spb : next;
    }
  }

  /**
   * Audio time of the loop iteration `beats` master beats after the
   * iteration that started at `prevStart`. With a master grid, the
   * previous start is snapped to the nearest whole master beat first,
   * which re-anchors the loop to the grid every period instead of
   * letting tempo drift accumulate. Without a master, free-runs at
   * the reference tempo.
   */
  private loopNextStart(prevStart: number, beats: number, spbFallback: number): number {
    const now = this.ctx.currentTime;
    const bpm = this.masterEffectiveBpm();
    const mBeats = bpm > 0 ? this.masterBeats() : null;
    if (mBeats === null) return prevStart + beats * spbFallback;
    const spb = 60 / bpm;
    const prevBeats = mBeats + (prevStart - now) / spb;
    const anchorBeats = Math.round(prevBeats);
    let next = now + (anchorBeats + beats - mBeats) * spb;
    // A tempo move can push the computed start into the past; step
    // forward whole periods until it is ahead of now.
    while (next < now + 0.05) next += beats * spb;
    return next;
  }

  /**
   * Stop a pad's loop. The sounding voice finishes its pass; voices
   * scheduled for the future are cancelled and the scheduler stops.
   * Safe to call when the pad is not looping.
   */
  private stopPadLoop(padIndex: number): void {
    const pad = this.pads[padIndex];
    const state = this.padLoops[padIndex];
    if (state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    state.nextAt = null;
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const entry of state.pending) {
      if (entry.at > now + 0.005) {
        try { entry.src.stop(); } catch { /* already stopped */ }
      }
    }
    pad.looping = false;
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

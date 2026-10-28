/**
 * WSOLA time-stretch AudioWorkletProcessor.
 *
 * Real time-stretching (pitch-preserving tempo change) via Waveform
 * Similarity Overlap-Add — the same family of algorithm SoundTouch uses.
 * This is what makes tempo changes NOT pitch-shift, i.e. Master Tempo.
 *
 * tempo > 1  → faster  (shorter output,  e.g. 1.1 = +10%)
 * tempo < 1  → slower  (longer output,   e.g. 0.9 = -10%)
 * tempo = 1  → bypass (bit-transparent copy)
 *
 * Design: AudioBufferSourceNode always runs at playbackRate 1.0. This
 * processor consumes the realtime input stream and re-times grains:
 * per synthesis step we advance the OUTPUT by Hs samples and the INPUT by
 * Ha = tempo * Hs samples, with a correlation search (±TOL) that keeps
 * transients and phase coherent.
 *
 * Track position advances at `tempo` track-seconds per real second — the
 * engine integrates this for the waveform playhead.
 */

// Grain / hop sizes (tuned for DJ tempo ranges at 44.1–48 kHz)
const N = 1024; // grain (window) size, ~23ms @44.1k
const HS = 256; // synthesis hop → 75% overlap
const TOL = 192; // correlation search tolerance (samples)
const SEARCH_STEP = 8;
const RING_SIZE = 32768; // input ring buffer (plenty for TOL + N + jitter)
// Bypass hysteresis (see processInner): engaging/disengaging the
// bit-transparent bypass is a discontinuity — WSOLA output lags the
// input by ~N+TOL samples, so a hard switch jumps time and clicks.
// The exit band is 4x the enter band and entry needs a sustained stay,
// so PLL dither around 1.0 cannot flap the switch; transitions
// crossfade over BLEND_SAMPLES instead of cutting.
const BYPASS_ENTER_EPS = 0.0005;
const BYPASS_EXIT_EPS = 0.002;
const BYPASS_DWELL_QUANTA = 12; // ~35ms inside the band before engaging
const BLEND_SAMPLES = 128; // ~3ms crossfade across a bypass transition

function hann(n: number, i: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = hann(N, i);

class WsolaProcessor extends AudioWorkletProcessor {
  private tempoTarget = 1;
  private tempoSmooth = 1;

  // Grain-rate latch (Mixxx-mapped idea, original code): the tempo
  // used for grain advance is held constant across 512-sample
  // windows and may move at most 2% per window. Rate changes take
  // effect at window boundaries instead of re-centering the
  // correlation search on every 128-sample quantum, which smeared
  // transients while the rate glided. Bypass hysteresis still reads
  // the smooth value, so engage/disengage timing is unchanged.
  private tempoStep = 1;
  private latchSamples = 0;

  // Bypass hysteresis + transition blends (see processInner). The
  // bypass band is a discontinuity: stretched output lags the input
  // by ~N+TOL samples, so a hard switch jumps time and clicks, and
  // every switch resets the stretch state. Hysteresis keeps tempo
  // dither around 1.0 from flapping the switch; the blends crossfade
  // across it instead of cutting.
  private bypass = true; // tempo starts at 1: direct until proven otherwise
  private bypassDwell = 0; // consecutive quanta inside the enter band
  private enterBlend = 0; // samples left of stretched -> direct crossfade
  private exitBlend = 0; // samples left of direct -> stretched crossfade

  // Input ring buffers (stereo)
  private inBuf: Float32Array[] = [new Float32Array(RING_SIZE), new Float32Array(RING_SIZE)];
  private inWrite = 0; // absolute sample index of next write position

  // Overlap-add accumulator (stereo), length N
  private ola: Float32Array[] = [new Float32Array(N), new Float32Array(N)];

  // Output FIFO (stereo)
  private outFifo: Float32Array[] = [new Float32Array(4096), new Float32Array(4096)];
  private outCount = 0; // valid samples in fifo (from index 0)

  private lastA = -1; // absolute input index of last grain start (-1 = uninitialized)
  private channels = 2;

  private resyncCount = 0;
  private errorCount = 0;

  /** Report a worklet-side event to the main thread (engine logs it, throttled). */
  private report(type: string, extra?: Record<string, unknown>): void {
    try {
      this.port.postMessage({ type, ...(extra ?? {}) });
    } catch {
      /* port closed — nothing to do */
    }
  }

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; tempo?: number };
      if (d && d.type === 'setTempo' && typeof d.tempo === 'number' && isFinite(d.tempo)) {
        this.tempoTarget = Math.min(4, Math.max(0.25, d.tempo));
      }
    };
  }

  private readRing(ch: number, absIdx: number): number {
    // absIdx must be within [inWrite - RING_SIZE, inWrite)
    return this.inBuf[ch][absIdx & (RING_SIZE - 1)];
  }

  /** Normalized cross-correlation of candidate grain vs current overlap tail (mono). */
  private correlate(aStart: number): number {
    const len = N - HS;
    let xy = 0;
    let xx = 0;
    let yy = 0;
    // stride 2 for speed; adequate for similarity ranking
    for (let i = 0; i < len; i += 2) {
      const x = (this.readRing(0, aStart + i) + this.readRing(1, aStart + i)) * 0.5;
      const y = (this.ola[0][i] + this.ola[1][i]) * 0.5;
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    if (xx < 1e-9 || yy < 1e-9) return -1;
    return xy / Math.sqrt(xx * yy);
  }

  /** Run one WSOLA step: consumes ~Ha input samples, appends HS samples to outFifo. */
  private step(r: number): boolean {
    const Ha = r * HS;
    let aStar: number;

    if (this.lastA < 0) {
      // First grain: use the oldest input that still leaves a full grain + search room
      aStar = this.inWrite - N - TOL;
      if (aStar < 0) return false; // not enough input buffered yet
    } else {
      const aNom = this.lastA + Ha;
      // Availability: a full grain must fit in the buffered input, but
      // the search window does NOT need to fit in full. The old check
      // (aNom + TOL + N > inWrite -> fail) demanded the entire forward
      // search room be buffered; at tempo ~= 1 the read pointer
      // advances exactly as fast as the write pointer, so the check
      // lands on a knife's edge and fails for a quantum at a time —
      // the emit path then zero-fills a whole quantum (silence) and
      // the next quantum resumes with a jump. That is the dropout
      // heard 1-2 quanta after every bypass re-engage. Clamp the
      // search to the input actually available instead: only fail
      // when not even the earliest candidate leaves a full grain.
      const maxD = Math.min(TOL, this.inWrite - N - aNom);
      if (maxD < -TOL) return false; // no full grain fits yet (cold start)
      if (aNom - TOL < this.inWrite - RING_SIZE) {
        // OVERRUN (dropout hardening): the read pointer fell more than a
        // full ring behind the write pointer — sustained tempo < 1, or a
        // long stall, can get here. The old code returned false forever,
        // which meant permanent silence with the transport still running.
        // Resync instead: drop the stale input and restart grains from the
        // freshest full grain on the next step. Costs one brief click;
        // audio comes back instead of dying.
        this.lastA = -1;
        this.ola[0].fill(0);
        this.ola[1].fill(0);
        this.resyncCount++;
        this.report('wsola-resync', { count: this.resyncCount });
        return false;
      }

      // Skip search on near-silence (saves CPU, avoids garbage matches)
      let tailEnergy = 0;
      for (let i = 0; i < N - HS; i += 4) {
        const s = (this.ola[0][i] + this.ola[1][i]) * 0.5;
        tailEnergy += s * s;
      }
      if (tailEnergy < 1e-7) {
        // No search: still clamp to the available input (see above).
        aStar = Math.min(Math.round(aNom), this.inWrite - N);
      } else {
        let best = -2;
        let bestD = 0;
        for (let d = -TOL; d <= maxD; d += SEARCH_STEP) {
          const s = this.correlate(Math.round(aNom + d));
          if (s > best) {
            best = s;
            bestD = d;
          }
        }
        // refine around best (staying inside the available window)
        for (let d = bestD - SEARCH_STEP; d <= bestD + SEARCH_STEP; d += 2) {
          if (Math.abs(d) > TOL || d > maxD) continue;
          const s = this.correlate(Math.round(aNom + d));
          if (s > best) {
            best = s;
            bestD = d;
          }
        }
        aStar = Math.round(aNom + bestD);
      }
    }

    // Overlap-add the windowed grain
    for (let ch = 0; ch < this.channels; ch++) {
      const ola = this.ola[ch];
      for (let i = 0; i < N; i++) {
        ola[i] += this.readRing(ch, aStar + i) * WIN[i];
      }
    }
    this.lastA = aStar;

    // Emit HS samples into the output FIFO
    const need = this.outCount + HS;
    if (need > this.outFifo[0].length) {
      // grow fifo (shouldn't happen in steady state)
      for (let ch = 0; ch < this.channels; ch++) {
        const nb = new Float32Array(this.outFifo[ch].length * 2);
        nb.set(this.outFifo[ch].subarray(0, this.outCount));
        this.outFifo[ch] = nb;
      }
    }
    for (let ch = 0; ch < this.channels; ch++) {
      this.outFifo[ch].set(this.ola[ch].subarray(0, HS), this.outCount);
    }
    this.outCount += HS;

    // Shift ola left by Hs, zero the tail
    for (let ch = 0; ch < this.channels; ch++) {
      const ola = this.ola[ch];
      ola.copyWithin(0, HS);
      ola.fill(0, N - HS, N);
    }
    return true;
  }

  /**
   * Guarded entry point: a processor exception used to risk killing this
   * deck's audio while the engine's transport kept running. Now any throw
   * resets the stretch state, reports once over the port, and outputs
   * silence for just this quantum — the next quantum plays again.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      return this.processInner(inputs, outputs);
    } catch (err) {
      this.lastA = -1;
      this.ola[0].fill(0);
      this.ola[1].fill(0);
      this.outCount = 0;
      this.errorCount++;
      this.report('wsola-error', { count: this.errorCount, message: String(err) });
      // Zero this quantum's output if the output block is well-formed.
      // (Guarded: a malformed block must not turn the guard itself into
      // a second throw.)
      try {
        const output = outputs[0];
        if (output) {
          for (let i = 0; i < output.length; i++) {
            const ch = output[i] as unknown;
            if (ch && typeof (ch as Float32Array).fill === 'function') (ch as Float32Array).fill(0);
          }
        }
      } catch {
        /* give up on this quantum */
      }
      return true;
    }
  }

  private processInner(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    this.channels = Math.min(2, input.length, output.length);
    const frames = input[0].length;

    // Smooth tempo toward target (fast enough for fader moves, smooth for PLL)
    const k = 1 - Math.exp(-frames / sampleRate / 0.03);
    this.tempoSmooth += (this.tempoTarget - this.tempoSmooth) * k;
    const r = this.tempoSmooth;

    // Latch the grain rate (see tempoStep): at most one bounded move
    // per 512-sample window; step() runs on the latched value.
    this.latchSamples += frames;
    if (this.latchSamples >= 512) {
      this.latchSamples -= 512;
      const lo = -0.02;
      const hi = 0.02;
      this.tempoStep += Math.min(hi, Math.max(lo, this.tempoSmooth - this.tempoStep));
    }
    const rStep = this.tempoStep;

    // 1. Push input into the ring on every path (bypass keeps it fresh
    // so re-engage has history to grain from).
    for (let i = 0; i < frames; i++) {
      const w = this.inWrite & (RING_SIZE - 1);
      for (let ch = 0; ch < this.channels; ch++) {
        this.inBuf[ch][w] = input[ch][i];
      }
      this.inWrite++;
    }

    // 2. Bypass hysteresis: enter only after a sustained stay inside
    // the narrow band; leave as soon as clearly outside it. Without
    // this, tempo dither around 1.0 flips the switch every few quanta,
    // and every flip resets the stretch state — the click/stutter
    // heard through every sync convergence once the catch-up slew
    // started driving tempo through 1.0 and back.
    if (this.bypass) {
      if (Math.abs(r - 1) > BYPASS_EXIT_EPS) {
        this.bypass = false;
        this.bypassDwell = 0;
        this.exitBlend = BLEND_SAMPLES;
      }
    } else if (Math.abs(r - 1) < BYPASS_ENTER_EPS) {
      if (++this.bypassDwell >= BYPASS_DWELL_QUANTA) {
        this.bypass = true;
        this.bypassDwell = 0;
        this.enterBlend = BLEND_SAMPLES;
      }
    } else {
      this.bypassDwell = 0;
    }

    // 3. Steady bypass: bit-transparent direct copy, stretch state
    // parked (resetting it every quantum is harmless — it is already
    // zero — and protects against stale state). Track the latched
    // grain rate to the bypass tempo so re-entry starts clean.
    if (this.bypass && this.enterBlend === 0) {
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch].set(input[ch].subarray(0, frames));
      }
      for (let ch = this.channels; ch < output.length; ch++) output[ch].fill(0);
      this.lastA = -1;
      this.ola[0].fill(0);
      this.ola[1].fill(0);
      this.outCount = 0;
      this.tempoStep = r;
      this.latchSamples = 0;
      return true;
    }

    // 4. Run WSOLA steps until we can fill this quantum (on the exit
    // quantum this primes the FIFO from the fresh ring before the
    // blend below; on the enter quantum it tops up the FIFO we are
    // blending out of). Steps run on the latched grain rate.
    let guard = 0;
    while (this.outCount < frames && guard++ < 16) {
      if (!this.step(rStep)) break;
    }

    // 5a. Entering bypass: crossfade the remaining stretched FIFO into
    // the direct signal, then park the stretch state. The blend absorbs
    // the WSOLA lookahead time jump instead of cutting across it.
    if (this.enterBlend > 0) {
      const n = Math.min(frames, this.outCount);
      const blend = Math.min(this.enterBlend, n);
      const done = BLEND_SAMPLES - this.enterBlend;
      for (let ch = 0; ch < this.channels; ch++) {
        const out = output[ch];
        const fifo = this.outFifo[ch];
        const inp = input[ch];
        for (let i = 0; i < blend; i++) {
          const t = (done + i + 1) / BLEND_SAMPLES; // 0 -> 1: stretched weight falls
          out[i] = fifo[i] * (1 - t) + inp[i] * t;
        }
        for (let i = blend; i < n; i++) out[i] = fifo[i];
        for (let i = n; i < frames; i++) out[i] = inp[i];
      }
      for (let ch = this.channels; ch < output.length; ch++) output[ch].fill(0);
      this.enterBlend = 0;
      this.lastA = -1;
      this.ola[0].fill(0);
      this.ola[1].fill(0);
      this.outCount = 0;
      this.tempoStep = r;
      this.latchSamples = 0;
      return true;
    }

    // 5b. Leaving bypass: crossfade the direct signal into the primed
    // FIFO. If the FIFO could not prime yet (cold start — not enough
    // input buffered), fall back to the direct signal for the shortfall
    // and stay armed: the next quantum re-primes and blends then.
    // Direct fallback, never silence, while a transition is pending.
    if (this.exitBlend > 0) {
      const n = Math.min(frames, this.outCount);
      const blend = Math.min(this.exitBlend, n);
      const done = BLEND_SAMPLES - this.exitBlend;
      for (let ch = 0; ch < this.channels; ch++) {
        const out = output[ch];
        const fifo = this.outFifo[ch];
        const inp = input[ch];
        for (let i = 0; i < blend; i++) {
          const t = (done + i + 1) / BLEND_SAMPLES; // 0 -> 1: stretched weight rises
          out[i] = inp[i] * (1 - t) + fifo[i] * t;
        }
        for (let i = blend; i < n; i++) out[i] = fifo[i];
        for (let i = n; i < frames; i++) out[i] = inp[i];
      }
      for (let ch = this.channels; ch < output.length; ch++) output[ch].fill(0);
      if (n > 0) {
        for (let ch = 0; ch < this.channels; ch++) {
          this.outFifo[ch].copyWithin(0, n, this.outCount);
        }
        this.outCount -= n;
      }
      this.exitBlend -= blend;
      return true;
    }

    // 6. Steady stretched emit (unchanged).
    const n = Math.min(frames, this.outCount);
    for (let ch = 0; ch < this.channels; ch++) {
      output[ch].set(this.outFifo[ch].subarray(0, n));
      if (n < frames) output[ch].fill(0, n, frames);
    }
    for (let ch = this.channels; ch < output.length; ch++) output[ch].fill(0);
    // compact fifo
    if (n > 0) {
      for (let ch = 0; ch < this.channels; ch++) {
        this.outFifo[ch].copyWithin(0, n, this.outCount);
      }
      this.outCount -= n;
    }
    return true;
  }
}

registerProcessor('velz-wsola', WsolaProcessor);

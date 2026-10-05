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
const BYPASS_EPS = 0.0005;

function hann(n: number, i: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = hann(N, i);

class WsolaProcessor extends AudioWorkletProcessor {
  private tempoTarget = 1;
  private tempoSmooth = 1;

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
      // Do we have enough input? need [aNom - TOL, aNom + TOL + N)
      if (aNom + TOL + N > this.inWrite) return false;
      if (aNom - TOL < this.inWrite - RING_SIZE) return false; // overrun; resync

      // Skip search on near-silence (saves CPU, avoids garbage matches)
      let tailEnergy = 0;
      for (let i = 0; i < N - HS; i += 4) {
        const s = (this.ola[0][i] + this.ola[1][i]) * 0.5;
        tailEnergy += s * s;
      }
      if (tailEnergy < 1e-7) {
        aStar = Math.round(aNom);
      } else {
        let best = -2;
        let bestD = 0;
        for (let d = -TOL; d <= TOL; d += SEARCH_STEP) {
          const s = this.correlate(Math.round(aNom + d));
          if (s > best) {
            best = s;
            bestD = d;
          }
        }
        // refine around best
        for (let d = bestD - SEARCH_STEP; d <= bestD + SEARCH_STEP; d += 2) {
          if (Math.abs(d) > TOL) continue;
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

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    this.channels = Math.min(2, input.length, output.length);
    const frames = input[0].length;

    // Smooth tempo toward target (fast enough for fader moves, smooth for PLL)
    const k = 1 - Math.exp(-frames / sampleRate / 0.03);
    this.tempoSmooth += (this.tempoTarget - this.tempoSmooth) * k;
    const r = this.tempoSmooth;

    if (Math.abs(r - 1) < BYPASS_EPS) {
      // Bit-transparent bypass; reset stretch state so re-engage is clean
      for (let ch = 0; ch < this.channels; ch++) {
        output[ch].set(input[ch].subarray(0, frames));
      }
      for (let ch = this.channels; ch < output.length; ch++) output[ch].fill(0);
      this.lastA = -1;
      this.ola[0].fill(0);
      this.ola[1].fill(0);
      this.outCount = 0;
      // keep ring fresh anyway (cheap) so engage has history
      for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < this.channels; ch++) {
          this.inBuf[ch][this.inWrite & (RING_SIZE - 1)] = input[ch][i];
        }
        this.inWrite++;
      }
      return true;
    }

    // 1. Push input into ring
    for (let i = 0; i < frames; i++) {
      const w = this.inWrite & (RING_SIZE - 1);
      for (let ch = 0; ch < this.channels; ch++) {
        this.inBuf[ch][w] = input[ch][i];
      }
      this.inWrite++;
    }

    // 2. Run WSOLA steps until we can fill this quantum
    let guard = 0;
    while (this.outCount < frames && guard++ < 16) {
      if (!this.step(r)) break;
    }

    // 3. Emit
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

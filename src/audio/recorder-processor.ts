/**
 * Recorder AudioWorkletProcessor ('velz-recorder').
 *
 * Taps the master chain (post-limiter, post-master-gain — exactly what the
 * master output carries) and forwards the audio to the main thread in
 * 4096-frame stereo blocks for WAV encoding / disk streaming.
 *
 * The processor outputs SILENCE: it is a tap, not a pass-through. The node
 * is wired masterGain → recorder → masterDest so the graph pulls it; the
 * zeros it adds to the master stream are inaudible by construction.
 *
 * Control messages (main → worklet):
 *   { type: 'start' }  — begin forwarding blocks
 *   { type: 'stop' }   — flush the partial block and stop forwarding
 * Data messages (worklet → main):
 *   { type: 'data', left: Float32Array, right: Float32Array } (transferred)
 */

const BLOCK = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  private active = false;
  private left = new Float32Array(BLOCK);
  private right = new Float32Array(BLOCK);
  private fill = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string };
      if (!d) return;
      if (d.type === 'start') {
        this.fill = 0;
        this.active = true;
      } else if (d.type === 'stop') {
        if (this.active && this.fill > 0) this.flush(this.fill);
        this.fill = 0;
        this.active = false;
      }
    };
  }

  private flush(n: number): void {
    const left = this.left.slice(0, n);
    const right = this.right.slice(0, n);
    this.port.postMessage({ type: 'data', left, right }, [left.buffer, right.buffer]);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    // Always emit silence on our output (see header comment).
    if (output) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
    }
    if (!this.active || !input || input.length === 0) return true;

    const l = input[0];
    const r = input.length > 1 ? input[1] : input[0];
    let i = 0;
    while (i < l.length) {
      const n = Math.min(BLOCK - this.fill, l.length - i);
      this.left.set(l.subarray(i, i + n), this.fill);
      this.right.set(r.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === BLOCK) {
        this.flush(BLOCK);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('velz-recorder', RecorderProcessor);

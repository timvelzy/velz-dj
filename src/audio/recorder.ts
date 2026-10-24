/**
 * SetRecorder — records the master output to a 16-bit / stereo WAV.
 *
 * Two output modes:
 *  - STREAM (preferred): a File System Access writable stream chosen by
 *    the user at record-start. Audio is converted to int16 and written in
 *    ~93 ms chunks, so an hour-long set never sits in RAM. The WAV header
 *    is written up front with zero sizes and patched at stop via seek().
 *  - BLOB (fallback): chunks accumulate as Int16Arrays in memory and are
 *    assembled into one WAV Blob at stop (Blob parts = the chunk buffers,
 *    no giant concat). UI flags when this mode is active.
 *
 * Tracklist: noteTrack() appends {elapsed, deck, title, artist, bpm, key}
 * for every deck load while recording. Sampler hits are not tracks.
 * Sidecars (txt + json) are produced at stop.
 */

export interface TracklistEntry {
  elapsed: number; // seconds from record start
  deck: string; // 'A' | 'B' | 'AI'
  title: string;
  artist: string;
  bpm: number;
  key: string;
}

export type RecorderMode = 'stream' | 'blob';

const clamp16 = (v: number) => {
  const s = Math.max(-1, Math.min(1, v));
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
};

function wavHeader(sampleRate: number, dataBytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true); // byte rate (16-bit stereo)
  v.setUint16(32, 4, true); // block align
  v.setUint16(34, 16, true); // bits
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);
  return buf;
}

function interleaveToInt16(left: Float32Array, right: Float32Array): Int16Array {
  const n = Math.min(left.length, right.length);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = clamp16(left[i]);
    out[i * 2 + 1] = clamp16(right[i]);
  }
  return out;
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class SetRecorder {
  private node: AudioWorkletNode | null = null;
  private ctx: AudioContext | null = null;
  private startTime = 0;
  private writable: FileSystemWritableFileStream | null = null;
  private chunks: Int16Array[] = [];
  private dataBytes = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private startedAt = new Date();

  mode: RecorderMode = 'blob';
  recording = false;
  tracklist: TracklistEntry[] = [];
  /** Set when the stream writer failed mid-set (we fall back to memory). */
  streamError: string | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  elapsed(): number {
    if (!this.recording || !this.ctx) return 0;
    return this.ctx.currentTime - this.startTime;
  }

  noteTrack(e: Omit<TracklistEntry, 'elapsed'>): void {
    if (!this.recording) return;
    // Avoid back-to-back duplicates of the same track on the same deck
    const last = this.tracklist[this.tracklist.length - 1];
    if (last && last.deck === e.deck && last.title === e.title && last.artist === e.artist) return;
    this.tracklist.push({ ...e, elapsed: this.elapsed() });
  }

  /**
   * Begin recording. `handle` = a FileSystemFileHandle from
   * showSaveFilePicker (already obtained inside the user's click), or
   * null for the in-memory fallback.
   */
  async start(
    ctx: AudioContext,
    node: AudioWorkletNode,
    handle: FileSystemFileHandle | null,
    seed: Omit<TracklistEntry, 'elapsed'>[],
  ): Promise<void> {
    this.ctx = ctx;
    this.node = node;
    this.tracklist = [];
    this.chunks = [];
    this.dataBytes = 0;
    this.streamError = null;
    this.startedAt = new Date();

    this.mode = 'blob';
    this.writable = null;
    if (handle) {
      try {
        this.writable = await handle.createWritable();
        await this.writable.write(wavHeader(ctx.sampleRate, 0));
        this.mode = 'stream';
      } catch (e) {
        console.warn('Recorder: stream open failed, using memory fallback', e);
        this.streamError = 'Could not open the chosen file — recording to memory instead.';
        this.writable = null;
      }
    }

    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; left?: Float32Array; right?: Float32Array };
      if (d?.type === 'data' && d.left && d.right) this.onBlock(d.left, d.right);
    };
    node.port.postMessage({ type: 'start' });
    this.startTime = ctx.currentTime;
    this.recording = true;
    for (const s of seed) this.tracklist.push({ ...s, elapsed: 0 });
  }

  private onBlock(left: Float32Array, right: Float32Array): void {
    const pcm = interleaveToInt16(left, right);
    if (this.writable && !this.streamError) {
      const writable = this.writable;
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      // Serialize writes. The byte count is added in chain order (not
      // callback order) so dataBytes always matches the file layout.
      this.writeChain = this.writeChain
        .then(() => writable.write(bytes))
        .then(() => { this.dataBytes += pcm.byteLength; })
        .catch((e) => {
          // Keep the writable: at stop we append the memory-held tail to
          // the same file, so one complete WAV survives a transient error.
          console.warn('Recorder: stream write failed, holding chunks in memory', e);
          this.streamError = 'A disk write failed mid-set — the rest is being held in memory and merged into the file at stop.';
          this.chunks.push(pcm);
          this.dataBytes += pcm.byteLength;
        });
    } else {
      this.chunks.push(pcm);
      this.dataBytes += pcm.byteLength;
    }
  }

  /**
   * Stop recording. Returns the WAV as a Blob in blob mode; in stream mode
   * the file is already on disk and the return is null.
   */
  async stop(): Promise<{ wavBlob: Blob | null; fileName: string }> {
    if (!this.ctx || !this.node) return { wavBlob: null, fileName: '' };
    this.node.port.postMessage({ type: 'stop' });
    this.recording = false;
    // Give the worklet's final flushed block time to arrive and queue.
    await new Promise((r) => setTimeout(r, 200));
    const fileName = this.suggestedFileName();

    if (this.mode === 'stream' && this.writable) {
      const writable = this.writable;
      this.writable = null;
      try {
        await this.writeChain.catch(() => { /* tail held in memory */ });
        // Append any memory-held tail (post-failure chunks), then patch
        // the header sizes and close — one complete file.
        for (const c of this.chunks) {
          await writable.write(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
        }
        this.chunks = [];
        const header = new DataView(wavHeader(this.sampleRate, this.dataBytes));
        const u32 = (off: number) => new Uint8Array([
          header.getUint8(off), header.getUint8(off + 1), header.getUint8(off + 2), header.getUint8(off + 3),
        ]);
        await writable.seek(4);
        await writable.write(u32(4));
        await writable.seek(40);
        await writable.write(u32(40));
        await writable.close();
        return { wavBlob: null, fileName };
      } catch (e) {
        console.warn('Recorder: could not finalize streamed file', e);
        try { await writable.abort(); } catch { /* noop */ }
        // Fall through: whatever we hold in memory still downloads.
      }
    }

    const head = new Blob([wavHeader(this.sampleRate, this.dataBytes)], { type: 'audio/wav' });
    const parts: BlobPart[] = [head, ...this.chunks.map((c) => c.buffer as ArrayBuffer)];
    const blob = new Blob(parts, { type: 'audio/wav' });
    this.chunks = [];
    return { wavBlob: blob, fileName };
  }

  suggestedFileName(): string {
    const d = this.startedAt;
    const p = (n: number) => n.toString().padStart(2, '0');
    return `velzdj-set-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.wav`;
  }

  tracklistText(): string {
    const lines = [
      `Velz DJ — recorded set`,
      `Started: ${this.startedAt.toLocaleString()}`,
      ``,
    ];
    for (const e of this.tracklist) {
      const who = e.artist ? `${e.artist} — ${e.title}` : e.title;
      const meta = [e.bpm > 0 ? `${e.bpm.toFixed(1)} BPM` : '', e.key].filter(Boolean).join(' · ');
      lines.push(`${formatElapsed(e.elapsed)}  ${who}${meta ? `  (${meta})` : ''}  [Deck ${e.deck}]`);
    }
    return lines.join('\n');
  }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

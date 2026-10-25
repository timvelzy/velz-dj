import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import type { BandPeaks, BeatGrid } from '../types';
import { amplitudeRGB, resamplePeaks } from '../audio/peaks';
import { barPhaseOf } from '../audio/loop';

interface WaveformProps {
  deckId: 'deckA' | 'deckB' | 'deckC';
  buffer: AudioBuffer | null;
  grid: BeatGrid | null;
  color: string;
  height?: number;
  loop: { start: number; end: number } | null;
  hotcues: (number | null)[];
  /** Per-slot: true when that hotcue is an auto (analysis) value, shown with an AUTO tag. */
  hotcueAuto?: boolean[];
  onSeek: (t: number) => void;
  /** Precomputed band peaks (Phase 4) — band-colored rendering when present. */
  peaks?: BandPeaks | null;
}

/** Downsample peaks for fast canvas drawing. */
function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const ch = buffer.getChannelData(0);
  const peaks = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(ch.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * per;
    const end = Math.min(start + per, ch.length);
    for (let i = start; i < end; i += 4) {
      const v = Math.abs(ch[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

export default function Waveform({
  deckId, buffer, grid, color, height = 96, loop, hotcues, hotcueAuto, onSeek, peaks: bandPeaks,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(60); // px per second
  const [follow, setFollow] = useState(true);
  const viewRef = useRef({ start: 0 });
  const dragRef = useRef<{ x: number; start: number } | null>(null);

  const peaks = useMemo(
    () => (buffer ? computePeaks(buffer, Math.max(512, Math.floor(buffer.duration * 40))) : null),
    [buffer],
  );

  // Keep the playhead roughly centered while playing
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap || !buffer || !peaks) return;
      const w = wrap.clientWidth;
      const h = height;
      if (canvas.width !== w * 2) {
        canvas.width = w * 2;
        canvas.height = h * 2;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);

      const pos = engine.position(deckId); // tempo-aware — no drift
      const dur = buffer.duration;
      const pxPerSec = zoom;

      let viewStart: number;
      if (follow && engine.isPlaying(deckId)) {
        viewStart = Math.max(0, pos - w / pxPerSec / 2);
        viewRef.current.start = viewStart;
      } else {
        viewStart = viewRef.current.start;
      }
      const viewEnd = viewStart + w / pxPerSec;

      // Background
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      const t2x = (t: number) => (t - viewStart) * pxPerSec;

      // Loop region
      if (loop && loop.end > loop.start) {
        ctx.fillStyle = 'rgba(56,189,248,0.12)';
        ctx.fillRect(t2x(loop.start), 0, (loop.end - loop.start) * pxPerSec, h);
        ctx.strokeStyle = 'rgba(56,189,248,0.6)';
        ctx.strokeRect(t2x(loop.start) + 0.5, 0.5, (loop.end - loop.start) * pxPerSec - 1, h - 1);
      }

      // Waveform — groove amplitude-banded colors when precomputed peaks
      // are available (quiet deep blue → cyan → green/yellow → loud
      // orange/red, with a vertical gradient per bar), otherwise the
      // classic single-color mono peaks. The previous dominant-band
      // coloring read almost entirely green: the analysis "mid" band
      // is effectively the full unfiltered signal, so it won the
      // max-band pick on nearly every bucket.
      const midY = h / 2;
      const halfH = h / 2 - 4;
      if (bandPeaks) {
        const rate = bandPeaks.rate;
        const b0 = Math.max(0, Math.floor(viewStart * rate));
        const b1 = Math.min(bandPeaks.min.length - 1, Math.ceil(viewEnd * rate));
        const bw = Math.max(1, pxPerSec / rate);
        for (let b = b0; b <= b1; b++) {
          const x = t2x(b / rate);
          const top = Math.min(1, bandPeaks.max[b]) * halfH;
          const bot = Math.min(1, -bandPeaks.min[b]) * halfH;
          const [r, g, bl] = amplitudeRGB(bandPeaks, b);
          const grad = ctx.createLinearGradient(0, midY - top, 0, midY + bot);
          grad.addColorStop(0, `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, bl + 40)}, 1)`);
          grad.addColorStop(0.3, `rgba(${r}, ${g}, ${bl}, 1)`);
          grad.addColorStop(0.7, `rgba(${r}, ${g}, ${bl}, 1)`);
          grad.addColorStop(1, `rgba(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, bl - 30)}, 1)`);
          ctx.fillStyle = grad;
          ctx.globalAlpha = 0.95;
          ctx.fillRect(x, midY - top, bw, Math.max(1, top + bot));
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = color;
        const bucketDur = dur / peaks.length;
        const x0 = Math.max(0, Math.floor(viewStart / bucketDur));
        const x1 = Math.min(peaks.length - 1, Math.ceil(viewEnd / bucketDur));
        for (let b = x0; b <= x1; b++) {
          const t = b * bucketDur;
          const x = t2x(t);
          const bw = Math.max(1, bucketDur * pxPerSec);
          const amp = peaks[b] * halfH;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x, midY - amp, bw, amp * 2);
        }
        ctx.globalAlpha = 1;
      }

      // Beat grid — draw real mapped beats when we have them (Traktor grids,
      // beat-mapped analysis), so the lines match what sync phase-locks to.
      if (grid && grid.bpm > 0) {
        const beats = grid.beats;
        ctx.font = '9px monospace';
        if (beats.length > 0) {
          // Binary search for the first beat in view
          let lo = 0, hi = beats.length - 1, first = beats.length;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid] >= viewStart) { first = mid; hi = mid - 1; }
            else lo = mid + 1;
          }
          for (let i = first; i < beats.length && beats[i] <= viewEnd; i++) {
            const x = t2x(beats[i]);
            const phase = barPhaseOf(grid);
            const isDown = (((i - phase) % 4) + 4) % 4 === 0;
            ctx.strokeStyle = isDown ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = isDown ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            if (isDown && zoom > 40) {
              ctx.fillStyle = 'rgba(255,255,255,0.5)';
              ctx.fillText(`${Math.max(1, Math.floor((i - phase) / 4) + 1)}`, x + 3, 10);
            }
          }
        } else {
          const spb = 60 / grid.bpm;
          const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat;
          const firstIdx = Math.max(0, Math.ceil((viewStart - off) / spb));
          const lastIdx = Math.floor((viewEnd - off) / spb);
          for (let i = firstIdx; i <= lastIdx; i++) {
            const t = off + i * spb;
            const x = t2x(t);
            const isDown = i % 4 === 0;
            ctx.strokeStyle = isDown ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = isDown ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            if (isDown && zoom > 40) {
              ctx.fillStyle = 'rgba(255,255,255,0.5)';
              ctx.fillText(`${Math.floor(i / 4) + 1}`, x + 3, 10);
            }
          }
        }
        ctx.lineWidth = 1;
      }

      // Hotcues
      hotcues.forEach((hc, i) => {
        if (hc === null) return;
        const x = t2x(hc);
        if (x < 0 || x > w) return;
        ctx.fillStyle = ['#f472b6', '#fbbf24', '#a3e635', '#22d3ee'][i % 4];
        ctx.fillRect(x - 1, 0, 2, h);
        ctx.fillText(`${i + 1}`, x + 3, h - 4);
        if (hotcueAuto?.[i]) ctx.fillText('A', x + 3, h - 15);
      });

      // Playhead — driven by the engine's tempo-integrated position
      const px = t2x(pos);
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 1, 0, 2, h);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffer, peaks, bandPeaks, grid, zoom, follow, deckId, color, height, loop, hotcues, hotcueAuto]);

  const seekFromEvent = (e: React.MouseEvent) => {
    if (!buffer || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = viewRef.current.start + x / zoom;
    onSeek(Math.max(0, Math.min(buffer.duration, t)));
  };

  return (
    <div className="select-none">
      <div
        ref={wrapRef}
        className="relative cursor-pointer rounded border border-zinc-800"
        style={{ height }}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, start: viewRef.current.start };
          setFollow(false);
          seekFromEvent(e);
        }}
        onMouseMove={(e) => {
          if (dragRef.current && buffer) {
            const dx = e.clientX - dragRef.current.x;
            const dur = buffer.duration;
            const w = wrapRef.current?.clientWidth ?? 1;
            viewRef.current.start = Math.max(
              0,
              Math.min(dur - w / zoom, dragRef.current.start - dx / zoom),
            );
          }
        }}
        onMouseUp={() => { dragRef.current = null; }}
        onMouseLeave={() => { dragRef.current = null; }}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
        <button
          className={`rounded px-2 py-0.5 ${follow ? 'bg-sky-700 text-white' : 'bg-zinc-800 text-zinc-300'}`}
          onClick={() => setFollow((f) => !f)}
          title="Follow playhead"
        >
          Follow
        </button>
        <span>Zoom</span>
        <input
          type="range" min={15} max={240} value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="h-1 w-28 accent-sky-500"
        />
        {grid && (
          <span className={grid.confidence < 0.4 ? 'text-amber-400' : 'text-zinc-500'}>
            {grid.bpm.toFixed(1)} BPM
            {grid.confidence < 0.4 ? ' (low confidence — check grid)' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Full-track overview strip ─────────────────────────────────────────────
// Whole track at a glance: band-colored peaks (or mono fallback), downbeat
// ticks, loop region, hotcues, played/unplayed shading and the playhead.
// Click seeks. Drawn from the same cached BandPeaks as the main waveform.

interface OverviewProps {
  deckId: 'deckA' | 'deckB' | 'deckC';
  buffer: AudioBuffer | null;
  peaks: BandPeaks | null;
  grid: BeatGrid | null;
  color: string;
  loop: { start: number; end: number } | null;
  hotcues: (number | null)[];
  /** Per-slot: true when that hotcue is an auto (analysis) value. */
  hotcueAuto?: boolean[];
  onSeek: (t: number) => void;
}

export function OverviewWaveform({ deckId, buffer, peaks, grid, color, loop, hotcues, hotcueAuto, onSeek }: OverviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const height = 30;

  const small = useMemo(() => (peaks ? resamplePeaks(peaks, 720) : null), [peaks]);
  const mono = useMemo(
    () => (buffer && !peaks ? computePeaks(buffer, 720) : null),
    [buffer, peaks],
  );

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap || !buffer) return;
      const w = wrap.clientWidth;
      if (canvas.width !== w * 2) {
        canvas.width = w * 2;
        canvas.height = height * 2;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      const dur = buffer.duration;
      const pos = engine.position(deckId);
      const t2x = (t: number) => (t / dur) * w;
      const midY = height / 2;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, height);

      if (loop && loop.end > loop.start) {
        ctx.fillStyle = 'rgba(56,189,248,0.15)';
        ctx.fillRect(t2x(loop.start), 0, t2x(loop.end) - t2x(loop.start), height);
      }

      if (small) {
        const n = small.min.length;
        const bw = Math.max(1, w / n);
        for (let b = 0; b < n; b++) {
          const x = (b / n) * w;
          const top = Math.min(1, small.max[b]) * (midY - 2);
          const bot = Math.min(1, -small.min[b]) * (midY - 2);
          const [r, g, bl] = amplitudeRGB(small, b);
          const grad = ctx.createLinearGradient(0, midY - top, 0, midY + bot);
          grad.addColorStop(0, `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, bl + 40)}, 1)`);
          grad.addColorStop(0.3, `rgba(${r}, ${g}, ${bl}, 1)`);
          grad.addColorStop(0.7, `rgba(${r}, ${g}, ${bl}, 1)`);
          grad.addColorStop(1, `rgba(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, bl - 30)}, 1)`);
          ctx.fillStyle = grad;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x, midY - top, bw, Math.max(1, top + bot));
        }
        ctx.globalAlpha = 1;
      } else if (mono) {
        ctx.fillStyle = color;
        const n = mono.length;
        const bw = Math.max(1, w / n);
        for (let b = 0; b < n; b++) {
          const amp = mono[b] * (midY - 2);
          ctx.globalAlpha = 0.85;
          ctx.fillRect((b / n) * w, midY - amp, bw, Math.max(1, amp * 2));
        }
        ctx.globalAlpha = 1;
      }

      // Downbeat ticks (every 4th mapped beat, from the grid's phase anchor)
      if (grid && grid.beats.length > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        const phase = barPhaseOf(grid);
        for (let i = phase; i < grid.beats.length; i += 4) {
          ctx.fillRect(t2x(grid.beats[i]), 0, 1, 4);
        }
      }

      // Unplayed region dimmed
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(t2x(pos), 0, w - t2x(pos), height);

      // Hotcues
      hotcues.forEach((hc, i) => {
        if (hc === null) return;
        ctx.fillStyle = ['#f472b6', '#fbbf24', '#a3e635', '#22d3ee'][i % 4];
        ctx.fillRect(t2x(hc) - 1, 0, 2, height);
        if (hotcueAuto?.[i]) ctx.fillText('A', t2x(hc) + 2, 10);
      });

      // Playhead
      ctx.fillStyle = '#fff';
      ctx.fillRect(t2x(pos) - 0.5, 0, 1.5, height);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffer, small, mono, grid, deckId, color, loop, hotcues, hotcueAuto]);

  if (!buffer) return null;
  return (
    <div
      ref={wrapRef}
      className="relative cursor-pointer rounded border border-zinc-800"
      style={{ height }}
      title="Overview — click to seek"
      onClick={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect || !buffer) return;
        const t = ((e.clientX - rect.left) / rect.width) * buffer.duration;
        onSeek(Math.max(0, Math.min(buffer.duration, t)));
      }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

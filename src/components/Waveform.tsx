import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import type { BeatGrid } from '../types';

interface WaveformProps {
  deckId: 'deckA' | 'deckB' | 'deckC';
  buffer: AudioBuffer | null;
  grid: BeatGrid | null;
  color: string;
  height?: number;
  loop: { start: number; end: number } | null;
  hotcues: (number | null)[];
  onSeek: (t: number) => void;
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
  deckId, buffer, grid, color, height = 96, loop, hotcues, onSeek,
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

      // Waveform
      const midY = h / 2;
      ctx.fillStyle = color;
      const bucketDur = dur / peaks.length;
      const x0 = Math.max(0, Math.floor(viewStart / bucketDur));
      const x1 = Math.min(peaks.length - 1, Math.ceil(viewEnd / bucketDur));
      for (let b = x0; b <= x1; b++) {
        const t = b * bucketDur;
        const x = t2x(t);
        const bw = Math.max(1, bucketDur * pxPerSec);
        const amp = peaks[b] * (h / 2 - 4);
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x, midY - amp, bw, amp * 2);
      }
      ctx.globalAlpha = 1;

      // Beat grid
      if (grid && grid.bpm > 0) {
        const spb = 60 / grid.bpm;
        const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat;
        const firstIdx = Math.max(0, Math.ceil((viewStart - off) / spb));
        const lastIdx = Math.floor((viewEnd - off) / spb);
        ctx.font = '9px monospace';
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
  }, [buffer, peaks, grid, zoom, follow, deckId, color, height, loop, hotcues]);

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

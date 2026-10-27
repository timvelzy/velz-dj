import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { midi } from '../midi';
import { Knob } from './Mixer';
import {
  SAMPLER_SEED_VERSION,
  deleteSamplerPad,
  encodeBufferToWav,
  getSamplerSeededVersion,
  loadSamplerPads,
  saveSamplerPad,
  setSamplerSeededVersion,
} from '../audio/samplerStore';
import { LOOP_SEEDS } from '../audio/seedTracks';

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

interface PadUIState {
  name: string;
  loaded: boolean;
  volume: number;
  flashing: boolean;
  loop: boolean; // loop mode armed
  looping: boolean; // loop currently playing
  trimStart: number; // seconds
  trimEnd: number; // seconds (full duration when untrimmed)
  eqLow: number; // dB, ±12, flat 0
  eqMid: number; // dB, ±12, flat 0
  eqHigh: number; // dB, ±12, flat 0
  live: boolean; // LIVE trigger: first hit starts at once
}

function renderMiniWaveform(buffer: AudioBuffer, canvas: HTMLCanvasElement, trimStart = 0, trimEnd?: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const data = buffer.getChannelData(0);
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#22d3ee';
  const step = Math.max(1, Math.floor(data.length / w));
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i += 8) {
      const v = data[x * step + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = ((1 + min) / 2) * h;
    const y2 = ((1 + max) / 2) * h;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  // Trim shading: dim the regions outside [trimStart, trimEnd] so the
  // kept region reads at a glance, with ticks at the trim points.
  const end = trimEnd ?? buffer.duration;
  if (end < buffer.duration || trimStart > 0) {
    const x0 = (trimStart / buffer.duration) * w;
    const x1 = (end / buffer.duration) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    if (x0 > 0) ctx.fillRect(0, 0, x0, h);
    if (x1 < w) ctx.fillRect(x1, 0, w - x1, h);
    ctx.fillStyle = '#e4e4e7';
    ctx.fillRect(Math.max(0, x0), 0, 1, h);
    ctx.fillRect(Math.min(w - 1, x1), 0, 1, h);
  }
}

/** Large trim editor: full-width waveform with draggable start/end
 * handles plus numeric start/end fields for fine adjustment. The pad's
 * 72px mini waveform is too small for usable drag handles, so the drag
 * interaction lives here; the mini waveform only shows the trim shading. */
function drawEditorWaveform(buffer: AudioBuffer, canvas: HTMLCanvasElement, trimStart: number, trimEnd: number, viewStart: number, viewDur: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const data = buffer.getChannelData(0);
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#22d3ee';
  // Only the visible window is drawn, so zooming reveals fine detail.
  const viewStartIdx = Math.floor((viewStart / buffer.duration) * data.length);
  const viewCount = Math.max(1, Math.floor((viewDur / buffer.duration) * data.length));
  const step = Math.max(1, Math.floor(viewCount / w));
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i += 4) {
      const v = data[viewStartIdx + x * step + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = ((1 + min) / 2) * (h - 16);
    const y2 = ((1 + max) / 2) * (h - 16);
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  const x0 = ((trimStart - viewStart) / viewDur) * w;
  const x1 = ((trimEnd - viewStart) / viewDur) * w;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  if (x0 > 0) ctx.fillRect(0, 0, x0, h - 16);
  if (x1 < w) ctx.fillRect(x1, 0, w - x1, h - 16);
  // Handles: full-height bars with a grab cap on top.
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(Math.max(0, x0 - 1), 0, 3, h - 16);
  ctx.fillRect(Math.min(w - 3, x1 - 1), 0, 3, h - 16);
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(Math.max(0, x0 - 4), 0, 9, 5);
  ctx.fillRect(Math.min(w - 9, x1 - 4), 0, 9, 5);
  // Time labels: visible window edges, plus trim-handle times when
  // the handle is in view.
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '10px monospace';
  ctx.fillText(`${viewStart.toFixed(2)}s`, 2, h - 4);
  const viewEndLabel = `${(viewStart + viewDur).toFixed(2)}s`;
  ctx.fillText(viewEndLabel, w - 40, h - 4);
  if (x0 >= -10 && x0 <= w + 10) ctx.fillText(`${trimStart.toFixed(2)}s`, Math.max(0, Math.min(w - 40, x0 - 2)), 12);
  if (x1 >= -10 && x1 <= w + 10) ctx.fillText(`${trimEnd.toFixed(2)}s`, Math.max(0, Math.min(w - 40, x1 - 32)), 12);
}

function TrimEditor({ index, state, onTrim, onReset, onClose, onAudition, onStop }: {
  index: number;
  state: PadUIState;
  onTrim: (start: number, end: number) => void;
  onReset: () => void;
  onClose: () => void;
  onAudition: () => void;
  onStop: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const dragWhich = useRef<'start' | 'end' | null>(null);
  const panRef = useRef<{ startX: number; startView: number } | null>(null);
  // Audition state: true from the AUDITION press until the voice ends
  // naturally or STOP is pressed. Mirrored in a ref for the rAF loop.
  const [auditioning, setAuditioning] = useState(false);
  const auditioningRef = useRef(false);
  auditioningRef.current = auditioning;
  // Sounding state: true while any voice of this pad is audible (or
  // the loop is between iterations) — drives the AUDITION/STOP label
  // whether playback started from the editor or from a pad tap. The
  // playhead loop below keeps it fresh without re-rendering per
  // frame (it only sets state when the value flips).
  const [sounding, setSounding] = useState(false);
  const soundingRef = useRef(false);
  // True once the auditioned voice has actually been heard; guards the
  // natural-end detection so a quantize wait doesn't clear AUDITION
  // before the first hit lands.
  const heardRef = useRef(false);
  const buffer = engine.pads[index].buffer;
  const duration = buffer?.duration ?? 0;
  const { trimStart, trimEnd } = state;

  // Zoom is view-only state (per editor view, not persisted): zoom 1
  // shows the whole sample; up to 32x for sub-second fine-tuning.
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const viewDur = duration > 0 ? duration / zoom : 0;
  const clampView = (z: number, s: number) => {
    const vd = duration / z;
    return Math.min(Math.max(0, duration - vd), Math.max(0, s));
  };
  // Zoom around an anchor time (trim midpoint for the buttons, pointer
  // time for the wheel) so the view follows the trim region instead
  // of jumping away.
  const zoomAround = (newZoom: number, anchor: number) => {
    const z = Math.min(32, Math.max(1, newZoom));
    const newViewDur = duration / z;
    const s = anchor - (anchor - viewStart) * (newViewDur / viewDur);
    setZoom(z);
    setViewStart(clampView(z, s));
  };

  // The playhead reads the live view through this ref (updated every
  // render) so the rAF loop below never goes stale on zoom/pan/trim.
  const viewRef = useRef({ viewStart, viewDur, trimStart, trimEnd });
  viewRef.current = { viewStart, viewDur, trimStart, trimEnd };

  // Playhead: a DOM line over the waveform, driven by
  // requestAnimationFrame reading the audio clock through
  // engine.padPlaybackPosition — never React state per frame, so it
  // can't stall the pads. rAF runs only while a voice is sounding;
  // when idle the check backs off to a 250ms timer (the same cadence
  // as the loop-state poll) so a later pad tap wakes the playhead.
  // Everything is cancelled on close/unmount. The line maps through
  // the SAME zoomed/panned time scale as the waveform; a position
  // outside the visible window pins the line to the near edge with a
  // ◀/▶ arrow instead of vanishing. With nothing sounding the line
  // parks at the trim start, dimmed.
  useEffect(() => {
    let raf = 0;
    let idleTimer = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      const line = playheadRef.current;
      const edge = edgeRef.current;
      const wrap = wrapRef.current;
      const pos = engine.padPlaybackPosition(index);
      if (pos !== null) heardRef.current = true;
      else if (auditioningRef.current && heardRef.current && !engine.pads[index].looping) {
        heardRef.current = false;
        setAuditioning(false);
      }
      // The AUDITION/STOP label follows real sounding state, not just
      // editor presses: a loop is "sounding" even in the silent gap
      // between iterations, so the button still offers STOP there.
      const isSounding = pos !== null || engine.pads[index].looping;
      if (isSounding !== soundingRef.current) {
        soundingRef.current = isSounding;
        setSounding(isSounding);
      }
      if (line && wrap) {
        const { viewStart: vs, viewDur: vd, trimStart: ts } = viewRef.current;
        const target = pos ?? ts;
        const frac = vd > 0 ? (target - vs) / vd : 0;
        const clamped = Math.min(1, Math.max(0, frac));
        const w = wrap.getBoundingClientRect().width;
        line.style.transform = `translateX(${(clamped * w).toFixed(1)}px)`;
        line.style.opacity = pos !== null ? '1' : '0.35';
        if (edge) {
          if (frac < 0) {
            edge.style.display = 'block';
            edge.style.left = '2px';
            edge.style.right = 'auto';
            edge.textContent = '◀';
          } else if (frac > 1) {
            edge.style.display = 'block';
            edge.style.left = 'auto';
            edge.style.right = '2px';
            edge.textContent = '▶';
          } else {
            edge.style.display = 'none';
          }
        }
      }
      if (pos !== null) {
        raf = requestAnimationFrame(step);
      } else {
        idleTimer = window.setTimeout(step, 250);
      }
    };
    step();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(idleTimer);
    };
  }, [index]);

  // Audition: hear the current trim region from the editor, through
  // the existing pad trigger path (same gain/EQ/trim semantics — loop
  // when the pad is loop-armed, one-shot otherwise). While anything
  // is sounding the same button is STOP: it cuts the voice
  // immediately via engine.stopPadVoice, whether playback started
  // here or from a pad tap. Closing the editor leaves playback
  // running, exactly like tapping a pad and closing.
  const handleAudition = () => {
    if (sounding) {
      onStop();
      heardRef.current = false;
      setAuditioning(false);
    } else {
      heardRef.current = false;
      onAudition();
      setAuditioning(true);
    }
  };

  // Numeric drafts: local text while focused (so typing "1." isn't
  // fought by live clamping), synced from engine state otherwise —
  // including live drag updates.
  const [startDraft, setStartDraft] = useState(trimStart.toFixed(2));
  const [endDraft, setEndDraft] = useState(trimEnd.toFixed(2));
  const [focused, setFocused] = useState<'start' | 'end' | null>(null);
  useEffect(() => { if (focused !== 'start') setStartDraft(trimStart.toFixed(2)); }, [trimStart, focused]);
  useEffect(() => { if (focused !== 'end') setEndDraft(trimEnd.toFixed(2)); }, [trimEnd, focused]);

  useEffect(() => {
    if (buffer && canvasRef.current) drawEditorWaveform(buffer, canvasRef.current, trimStart, trimEnd, viewStart, viewDur);
  }, [buffer, trimStart, trimEnd, viewStart, viewDur]);

  // Mouse-wheel zoom around the pointer (native non-passive listener
  // so the page doesn't scroll while zooming the waveform).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = viewStart + ((e.clientX - rect.left) / rect.width) * viewDur;
      zoomAround(zoom * Math.exp(-e.deltaY * 0.0015), anchor);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // zoomAround/clampView are re-created each render; re-registering
    // on zoom/view change keeps the handler reading fresh values.
  }, [zoom, viewStart, viewDur, duration]);

  const timeFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.min(
      viewStart + viewDur,
      Math.max(viewStart, viewStart + ((e.clientX - rect.left) / rect.width) * viewDur),
    );
  };
  const applyAt = (which: 'start' | 'end', t: number) => {
    if (which === 'start') onTrim(t, trimEnd);
    else onTrim(trimStart, t);
  };

  const commitStart = () => {
    const v = parseFloat(startDraft);
    if (Number.isFinite(v)) onTrim(v, trimEnd);
  };
  const commitEnd = () => {
    const v = parseFloat(endDraft);
    if (Number.isFinite(v)) onTrim(trimStart, v);
  };

  if (!buffer) return null;
  return (
    <div className="mt-2 rounded-lg border border-amber-500/50 bg-black/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-amber-200">
          PAD {index + 1} TRIM — {state.name} · kept {(trimEnd - trimStart).toFixed(2)}s of {duration.toFixed(2)}s
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-zinc-500">ZOOM</span>
          <button
            onClick={() => zoomAround(zoom / 2, (trimStart + trimEnd) / 2)}
            className="text-[11px] font-mono text-zinc-300 hover:text-amber-200 border border-zinc-700 rounded px-1.5 py-0.5"
            title="Zoom out (centers on the trim region)"
          >
            −
          </button>
          <span className="text-[11px] font-mono text-zinc-200 w-10 text-center">
            {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
          </span>
          <button
            onClick={() => zoomAround(zoom * 2, (trimStart + trimEnd) / 2)}
            className="text-[11px] font-mono text-zinc-300 hover:text-amber-200 border border-zinc-700 rounded px-1.5 py-0.5"
            title="Zoom in (centers on the trim region)"
          >
            +
          </button>
          <button
            onClick={() => { setZoom(1); setViewStart(0); }}
            className="text-[11px] font-mono text-zinc-300 hover:text-amber-200 border border-zinc-700 rounded px-1.5 py-0.5"
            title="Reset zoom to the full sample"
          >
            FIT
          </button>
        </span>
        <button onClick={onClose} className="text-[11px] font-mono text-zinc-400 hover:text-zinc-100 px-1" title="Close trim editor">✕</button>
      </div>
      <div ref={wrapRef} className="relative mt-1">
      <canvas
        ref={canvasRef}
        width={640}
        height={110}
        className="w-full h-[110px] rounded bg-black/40 cursor-ew-resize touch-none"
        onPointerDown={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const pxPerSec = rect.width / viewDur;
          const x0 = (trimStart - viewStart) * pxPerSec;
          const x1 = (trimEnd - viewStart) * pxPerSec;
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          // Near a handle (10px grab zone, in zoomed pixels) → drag
          // that handle, with the pointer mapped to the zoomed time
          // scale. Anywhere else → pan the zoomed view (a no-op at
          // zoom 1, where the whole sample is visible).
          if (Math.abs(x - x0) <= 10) {
            dragWhich.current = 'start';
            applyAt('start', timeFromEvent(e));
          } else if (Math.abs(x - x1) <= 10) {
            dragWhich.current = 'end';
            applyAt('end', timeFromEvent(e));
          } else {
            panRef.current = { startX: e.clientX, startView: viewStart };
          }
        }}
        onPointerMove={(e) => {
          if (dragWhich.current) {
            applyAt(dragWhich.current, timeFromEvent(e));
            return;
          }
          if (panRef.current) {
            const rect = canvasRef.current!.getBoundingClientRect();
            const dxSec = ((e.clientX - panRef.current.startX) / rect.width) * viewDur;
            setViewStart(clampView(zoom, panRef.current.startView - dxSec));
          }
        }}
        onPointerUp={() => { dragWhich.current = null; panRef.current = null; }}
        onPointerCancel={() => { dragWhich.current = null; panRef.current = null; }}
      />
        {/* Playhead overlay: a DOM line over the waveform, positioned
            imperatively by the rAF loop. pointer-events-none so
            handle drags and background pans pass straight through.
            The line spans the waveform area only (the bottom 16px
            holds the time labels). */}
        <div ref={playheadRef} className="pointer-events-none absolute left-0 top-0 -ml-px h-[calc(100%-16px)] w-[2px] bg-white shadow-[0_0_4px_rgba(255,255,255,0.9)]" style={{ opacity: 0.35 }} />
        <div ref={edgeRef} className="pointer-events-none absolute top-0 hidden text-[10px] leading-none text-white" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <label className="flex items-center gap-1 text-[11px] font-mono text-zinc-300">
          start
          <input
            type="number" min={0} max={duration} step={0.01} value={startDraft}
            className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-100"
            onFocus={() => setFocused('start')}
            onBlur={() => { setFocused(null); commitStart(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onChange={(e) => setStartDraft(e.target.value)}
          />
          s
        </label>
        <label className="flex items-center gap-1 text-[11px] font-mono text-zinc-300">
          end
          <input
            type="number" min={0} max={duration} step={0.01} value={endDraft}
            className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-100"
            onFocus={() => setFocused('end')}
            onBlur={() => { setFocused(null); commitEnd(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onChange={(e) => setEndDraft(e.target.value)}
          />
          s
        </label>
        <button
          onClick={onReset}
          className="text-[11px] font-mono text-zinc-300 hover:text-amber-200 border border-zinc-700 rounded px-2 py-0.5"
          title="Reset trim to the full sample"
        >
          RESET TO FULL
        </button>
        <button
          onClick={handleAudition}
          className="text-[11px] font-mono text-zinc-100 hover:text-white border border-cyan-700 bg-cyan-900/40 rounded px-2 py-0.5"
          title="Hear the current trim region from the editor (looped when the pad is loop-armed, one-shot otherwise). While the pad is sounding this button stops it immediately."
        >
          {sounding ? '■ STOP' : '▶ AUDITION'}
        </button>
        <span className="text-[10px] font-mono text-zinc-500">drag amber handles (10px grab) · drag background to pan when zoomed · mouse wheel zooms at the pointer · type exact seconds · 5ms fades · trim is non-destructive</span>
      </div>
    </div>
  );
}

/** Per-pad quick menu: EQ + trim + volume + LIVE, for on-the-fly
 * tweaks while playing. Everything is live — no Apply button, no
 * reload. The menu is menu-scoped state inside the pad, so opening or
 * tweaking it never re-renders the other pads, and it stays open
 * while the pad keeps playing: taps on pads don't close it (only an
 * outside tap, Escape, or the ⋯/✕ button does). The expanded EDIT
 * editor stays the precise path for waveform trim work; the menu is
 * the fast path. */
function PadMenu({ index, state, onEq, onLive, onTrim, onResetTrim, onVolume, onOpenEditor, onStop, onClose }: {
  index: number;
  state: PadUIState;
  onEq: (low: number, mid: number, high: number) => void;
  onLive: (on: boolean) => void;
  onTrim: (start: number, end: number) => void;
  onResetTrim: () => void;
  onVolume: (v: number) => void;
  onOpenEditor: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const buffer = engine.pads[index].buffer;
  const duration = buffer?.duration ?? 0;
  const { trimStart, trimEnd } = state;

  // Numeric drafts: local text while focused (same pattern as the
  // trim editor — typing "1." isn't fought by live clamping).
  const [startDraft, setStartDraft] = useState(trimStart.toFixed(2));
  const [endDraft, setEndDraft] = useState(trimEnd.toFixed(2));
  const [focused, setFocused] = useState<'start' | 'end' | null>(null);
  useEffect(() => { if (focused !== 'start') setStartDraft(trimStart.toFixed(2)); }, [trimStart, focused]);
  useEffect(() => { if (focused !== 'end') setEndDraft(trimEnd.toFixed(2)); }, [trimEnd, focused]);

  const commitStart = () => {
    const v = parseFloat(startDraft);
    if (Number.isFinite(v)) onTrim(v, trimEnd);
  };
  const commitEnd = () => {
    const v = parseFloat(endDraft);
    if (Number.isFinite(v)) onTrim(trimStart, v);
  };

  const eqKnob = (label: string, value: number, set: (v: number) => void) => (
    <span key={label} className="flex flex-col items-center">
      <Knob label={label} value={value} min={-12} max={12} size={30} onChange={set} />
      <span className="text-[9px] font-mono text-zinc-400">
        {value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1)} dB
      </span>
    </span>
  );

  return (
    <div
      className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-cyan-500/50 bg-zinc-900/95 p-2 shadow-xl"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-cyan-200 truncate">
          PAD {index + 1} · {state.name}
        </span>
        <button onClick={onClose} className="text-[11px] font-mono text-zinc-400 hover:text-zinc-100 px-1" title="Close menu (Esc)">✕</button>
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[9px] font-mono text-zinc-500">EQ ±12 dB · double-click a knob for flat</span>
        <button
          onClick={() => onEq(0, 0, 0)}
          className="text-[9px] font-mono text-zinc-400 hover:text-cyan-200 border border-zinc-700 rounded px-1.5 py-0.5"
          title="Reset EQ to flat"
        >
          FLAT
        </button>
      </div>
      <div className="flex items-start justify-around mt-1">
        {eqKnob('low', state.eqLow, (v) => onEq(v, state.eqMid, state.eqHigh))}
        {eqKnob('mid', state.eqMid, (v) => onEq(state.eqLow, v, state.eqHigh))}
        {eqKnob('high', state.eqHigh, (v) => onEq(state.eqLow, state.eqMid, v))}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <span className="text-[9px] font-mono text-zinc-500">TRIM</span>
        <label className="flex items-center gap-1 text-[10px] font-mono text-zinc-300">
          <input
            type="number" min={0} max={duration} step={0.01} value={startDraft}
            className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-100"
            onFocus={() => setFocused('start')}
            onBlur={() => { setFocused(null); commitStart(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onChange={(e) => setStartDraft(e.target.value)}
          />
          s
        </label>
        <label className="flex items-center gap-1 text-[10px] font-mono text-zinc-300">
          <input
            type="number" min={0} max={duration} step={0.01} value={endDraft}
            className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-100"
            onFocus={() => setFocused('end')}
            onBlur={() => { setFocused(null); commitEnd(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onChange={(e) => setEndDraft(e.target.value)}
          />
          s
        </label>
        <span className="text-[9px] font-mono text-zinc-400">kept {(trimEnd - trimStart).toFixed(2)}s</span>
        <button
          onClick={onResetTrim}
          className="text-[9px] font-mono text-zinc-400 hover:text-amber-200 border border-zinc-700 rounded px-1.5 py-0.5"
          title="Reset trim to the full sample"
        >
          RESET
        </button>
        <button
          onClick={onOpenEditor}
          className="text-[9px] font-mono text-zinc-400 hover:text-amber-200 border border-zinc-700 rounded px-1.5 py-0.5"
          title="Open the large waveform editor for drag-handle fine-tuning"
        >
          FINE-TUNE ↗
        </button>
        <button
          onClick={onStop}
          className="text-[9px] font-mono text-red-300 hover:text-red-100 border border-red-900 rounded px-1.5 py-0.5"
          title="Stop this pad immediately (sample, trim, EQ, volume, and loop-arm state kept). Same as tapping the pad again while it sounds."
        >
          ■ STOP
        </button>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[9px] font-mono text-zinc-500">VOL</span>
        <input
          type="range" min={0} max={1} step={0.01} value={state.volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="flex-1 accent-cyan-400"
        />
        <span className="text-[9px] font-mono text-zinc-400 w-8 text-right">{Math.round(state.volume * 100)}%</span>
      </div>
      <label className="flex items-start gap-1.5 mt-2 cursor-pointer">
        <input
          type="checkbox" checked={state.live}
          onChange={(e) => onLive(e.target.checked)}
          className="accent-cyan-400 mt-0.5"
        />
        <span className="text-[10px] font-mono text-zinc-300">
          LIVE — first hit starts at once
          <span className="block text-[9px] text-zinc-500">
            Off: waits for the next beat (synced). Loop passes after the first still lock to the grid either way.
          </span>
        </span>
      </label>
    </div>
  );
}

interface PadProps {
  index: number;
  state: PadUIState;
  onTrigger: (index: number, retrigger?: boolean) => void;
  onLoad: (index: number, file: File) => void;
  onClear: (index: number) => void;
  onVolume: (index: number, v: number) => void;
  onToggleLoop: (index: number) => void;
  onEdit: (index: number) => void;
  onToggleMenu: (index: number) => void;
  onEq: (index: number, low: number, mid: number, high: number) => void;
  onLive: (index: number, on: boolean) => void;
  onTrim: (index: number, start: number, end: number) => void;
  onResetTrim: (index: number) => void;
  onOpenEditor: (index: number) => void;
  onStop: (index: number) => void;
  menuOpen: boolean;
  editing: boolean;
}

const Pad = memo(function Pad({ index, state, onTrigger, onLoad, onClear, onVolume, onToggleLoop, onEdit, onToggleMenu, onEq, onLive, onTrim, onResetTrim, onOpenEditor, onStop, menuOpen, editing }: PadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const [showVol, setShowVol] = useState(false);

  useEffect(() => {
    const pad = engine.pads[index];
    if (state.loaded && pad.buffer && waveRef.current) {
      renderMiniWaveform(pad.buffer, waveRef.current, state.trimStart, state.trimEnd);
    }
  }, [state.loaded, state.trimStart, state.trimEnd, index]);

  return (
    <div
      className={`relative rounded-lg border p-1.5 select-none transition-colors ${
        editing
          ? 'bg-zinc-800 border-amber-400'
          : state.looping
            ? 'bg-emerald-500/25 border-emerald-400'
            : state.flashing
              ? 'bg-cyan-500/40 border-cyan-300'
              : state.loaded
                ? 'bg-zinc-800 border-zinc-600 hover:border-cyan-400 cursor-pointer'
                : 'bg-zinc-900 border-zinc-700 border-dashed hover:border-zinc-500 cursor-pointer'
      }`}
      data-sampler-pad={index}
      onPointerDown={(e) => {
        // Primary button only: a right-click must clear, never fire.
        // Pointer-down, not click: click waits for pointer-up, which
        // is dead time on a drum pad.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Alt (Option) held at pointer-down = retrigger: a sounding
        // pad restarts from the trim start instead of stopping.
        // Modifier state is read here only, never tracked.
        if (state.loaded) onTrigger(index, e.altKey);
        else fileRef.current?.click();
      }}
      onContextMenu={(e) => { e.preventDefault(); if (state.loaded) onClear(index); }}
      title={state.loaded
        ? state.looping
          ? `${state.name} — looping in sync, click to stop, Alt+click to restart from the top`
          : state.loop
            ? `${state.name} — loop armed, click to start the loop; right-click to clear`
            : `${state.name} — click to stop when sounding, Alt+click to restart; right-click to clear`
        : 'Click to load sample'}
    >
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onLoad(index, f);
          e.target.value = '';
        }}
      />
      <div className="text-[10px] font-mono text-zinc-400 truncate">
        {index + 1}. {state.loaded ? state.name : 'empty'}
      </div>
      {state.loaded ? (
        <canvas ref={waveRef} width={72} height={28} className="w-full h-7 mt-1 rounded bg-black/40" />
      ) : (
        <div className="w-full h-7 mt-1 rounded bg-black/20 flex items-center justify-center text-zinc-600 text-lg">+</div>
      )}
      <div className="flex items-center justify-between mt-1">
        <span className="text-[9px] text-zinc-500 font-mono">key {PAD_KEYS[index]}</span>
        {state.loaded && (
          <span className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className={`text-[9px] font-mono px-1 rounded border ${
                state.looping
                  ? 'text-emerald-300 border-emerald-400 bg-emerald-500/20 animate-pulse'
                  : state.loop
                    ? 'text-cyan-300 border-cyan-500/60 bg-cyan-500/10'
                    : 'text-zinc-500 border-zinc-700 hover:text-cyan-300'
              }`}
              onClick={(e) => { e.stopPropagation(); onToggleLoop(index); }}
              title="Loop mode: the pad repeats in sync with the master grid. Tap the pad to start, tap again to stop at once, Alt+tap to restart the pass."
            >
              LOOP
            </button>
            <button
              className={`text-[9px] font-mono px-1 rounded border ${
                editing
                  ? 'text-amber-200 border-amber-400 bg-amber-500/20'
                  : 'text-zinc-500 border-zinc-700 hover:text-amber-200'
              }`}
              onClick={(e) => { e.stopPropagation(); onEdit(index); }}
              title="Edit trim: drag the start/end handles on the large waveform, or type exact seconds."
            >
              EDIT
            </button>
            <button
              className={`text-[9px] font-mono px-1 rounded border ${
                menuOpen
                  ? 'text-cyan-200 border-cyan-400 bg-cyan-500/20'
                  : 'text-zinc-500 border-zinc-700 hover:text-cyan-200'
              }`}
              onClick={(e) => { e.stopPropagation(); onToggleMenu(index); }}
              title="Quick menu: per-pad EQ, trim, volume, LIVE trigger (Shift+1–8 opens it)"
            >
              ⋯
            </button>
            <button
              className="text-[9px] text-zinc-500 hover:text-cyan-300 font-mono"
              onClick={(e) => { e.stopPropagation(); setShowVol(!showVol); }}
            >
              vol
            </button>
          </span>
        )}
      </div>
      {menuOpen && state.loaded && (
        <PadMenu
          index={index}
          state={state}
          onEq={(l, m, h) => onEq(index, l, m, h)}
          onLive={(on) => onLive(index, on)}
          onTrim={(s, e) => onTrim(index, s, e)}
          onResetTrim={() => onResetTrim(index)}
          onVolume={(v) => onVolume(index, v)}
          onOpenEditor={() => onOpenEditor(index)}
          onStop={() => onStop(index)}
          onClose={() => onToggleMenu(index)}
        />
      )}
      {showVol && state.loaded && (
        <div className="flex justify-center mt-1" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <Knob label="vol" value={state.volume} min={0} max={1} size={36} onChange={(v) => onVolume(index, v)} />
        </div>
      )}
    </div>
  );
});

export default function Sampler() {
  const [pads, setPads] = useState<PadUIState[]>(
    Array.from({ length: 8 }, () => ({ name: '', loaded: false, volume: 0.8, flashing: false, loop: false, looping: false, trimStart: 0, trimEnd: 0, eqLow: 0, eqMid: 0, eqHigh: 0, live: false }))
  );
  // Quantize defaults ON (EDM sync feature): pads drop on the next master
  // beat. The checkbox defeats it for manual triggering.
  const [quantize, setQuantize] = useState(true);
  const [open, setOpen] = useState(true);
  const flashTimers = useRef<number[]>([]);

  // Deck → sampler recording: source deck, target pad, live state.
  const [recDeck, setRecDeck] = useState<'A' | 'B'>('A');
  const [recPad, setRecPad] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recStartAt = useRef(0);
  const autoStopSeenAt = useRef(0);
  const recPadRef = useRef(0);
  const recDeckRef = useRef<'A' | 'B'>('A');
  recPadRef.current = recPad;
  recDeckRef.current = recDeck;

  const refreshPad = useCallback((i: number) => {
    const p = engine.pads[i];
    setPads((prev) => {
      const cur = prev[i];
      // No-op when nothing changed, so the 250ms loop-state poll below
      // never forces a re-render on its own.
      if (
        cur.name === p.name && cur.loaded === !!p.buffer && cur.volume === p.volume
        && cur.loop === p.loop && cur.looping === p.looping
        && cur.trimStart === p.trimStart && cur.trimEnd === p.trimEnd
        && cur.eqLow === p.eq.low && cur.eqMid === p.eq.mid && cur.eqHigh === p.eq.high
        && cur.live === p.live
      ) return prev;
      const next = [...prev];
      next[i] = { ...next[i], name: p.name, loaded: !!p.buffer, volume: p.volume, loop: p.loop, looping: p.looping, trimStart: p.trimStart, trimEnd: p.trimEnd, eqLow: p.eq.low, eqMid: p.eq.mid, eqHigh: p.eq.high, live: p.live };
      return next;
    });
  }, []);

  const flash = useCallback((i: number) => {
    setPads((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], flashing: true };
      return next;
    });
    window.clearTimeout(flashTimers.current[i]);
    flashTimers.current[i] = window.setTimeout(() => {
      setPads((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], flashing: false };
        return next;
      });
    }, 150);
  }, []);

  const trigger = useCallback((i: number, retrigger = false) => {
    if (engine.triggerSample(i, { retrigger })) flash(i);
  }, [flash]);

  // Editor / menu STOP: cut the pad's voice immediately via the same
  // engine call the tap-again stop uses.
  const stopVoice = useCallback((i: number) => {
    engine.stopPadVoice(i);
    refreshPad(i);
  }, [refreshPad]);

  // STOP ALL: cut every sounding pad immediately (quick fade each).
  // Pads keep their samples, trim, EQ, volume, and loop-arm state.
  const stopAll = useCallback(() => {
    engine.stopAllPadVoices();
    for (let i = 0; i < 8; i++) refreshPad(i);
  }, [refreshPad]);

  // ─── Pad persistence ──────────────────────────────────────────────────
  // Pads survive reloads (IndexedDB, see samplerStore.ts): the encoded
  // bytes per pad live in padBlobs, and every mutation below persists
  // the pad's bytes + name + volume + trim + loop-arm flag. Settings
  // changes (knob drags, trim edits) save debounced so a drag doesn't
  // rewrite the blob on every tick; loads/clears save immediately.
  const padBlobs = useRef<(Blob | null)[]>(Array(8).fill(null));
  const padSaveTimers = useRef<(number | null)[]>(Array(8).fill(null));

  const persistPad = useCallback((i: number) => {
    const p = engine.pads[i];
    const blob = padBlobs.current[i];
    if (!p.buffer || !blob) return;
    void saveSamplerPad({
      padIndex: i,
      name: p.name,
      blob,
      volume: p.volume,
      trimStart: p.trimStart,
      trimEnd: p.trimEnd,
      loop: p.loop,
      eq: { ...p.eq },
      live: p.live,
      savedAt: new Date().toISOString(),
    }).catch((e) => console.warn('Sampler pad save failed', e));
  }, []);

  const schedulePadSave = useCallback((i: number) => {
    window.clearTimeout(padSaveTimers.current[i] ?? undefined);
    padSaveTimers.current[i] = window.setTimeout(() => persistPad(i), 400);
  }, [persistPad]);

  const load = useCallback(async (i: number, file: File) => {
    if (await engine.loadSampleFromFile(i, file)) {
      padBlobs.current[i] = file;
      persistPad(i);
      refreshPad(i);
    }
  }, [refreshPad, persistPad]);

  const clear = useCallback((i: number) => {
    engine.clearSample(i);
    padBlobs.current[i] = null;
    window.clearTimeout(padSaveTimers.current[i] ?? undefined);
    void deleteSamplerPad(i).catch((e) => console.warn('Sampler pad delete failed', e));
    setEditPad((cur) => (cur === i ? null : cur));
    setMenuPad((cur) => (cur === i ? null : cur));
    refreshPad(i);
  }, [refreshPad]);

  const setVol = useCallback((i: number, v: number) => {
    engine.setPadVolume(i, v);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  const toggleLoop = useCallback((i: number) => {
    engine.setPadLoop(i, !engine.pads[i].loop);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  const setEq = useCallback((i: number, low: number, mid: number, high: number) => {
    engine.setPadEq(i, low, mid, high);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  const setLive = useCallback((i: number, on: boolean) => {
    engine.setPadLive(i, on);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  // Trim editing: which pad's editor is open (null = none). Zoom state
  // lives inside the editor and resets when switching pads (keyed).
  const [editPad, setEditPad] = useState<number | null>(null);

  // Quick menu: which pad's popover is open (null = none). One at a
  // time — opening another pad's menu closes this one.
  const [menuPad, setMenuPad] = useState<number | null>(null);

  const toggleMenu = useCallback((i: number) => {
    setMenuPad((cur) => (cur === i ? null : i));
  }, []);

  const toggleEditPad = useCallback((i: number) => {
    setEditPad((cur) => (cur === i ? null : i));
  }, []);

  const openEditor = useCallback((i: number) => {
    setEditPad(i);
    setMenuPad(null);
  }, []);

  // The quick menu stays open while playing (taps on pads don't close
  // it); only a tap outside every pad, Escape, or ⋯/✕ does.
  useEffect(() => {
    if (menuPad === null) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest || !t.closest('[data-sampler-pad]')) setMenuPad(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [menuPad]);

  const setTrim = useCallback((i: number, start: number, end: number) => {
    engine.setPadTrim(i, start, end);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  const resetTrim = useCallback((i: number) => {
    engine.resetPadTrim(i);
    schedulePadSave(i);
    refreshPad(i);
  }, [refreshPad, schedulePadSave]);

  // Restore saved pads + seed the Midnight Concrete loops, once on
  // mount. Restore first (saved records win), then seeding fills only
  // pads with no saved record and no buffer — a pad the user loaded,
  // cleared, or replaced is never clobbered. Decoding uses an isolated
  // OfflineAudioContext and staging needs no live AudioContext, so this
  // runs silently before the first gesture creates one. Seeded loops
  // ship loop-ARMED (they repeat in sync when triggered) but nothing
  // plays until the user taps a pad, a key, or MIDI.
  const padsRestoredRef = useRef(false);
  useEffect(() => {
    if (padsRestoredRef.current) return;
    padsRestoredRef.current = true;
    let cancelled = false;
    void (async () => {
      const decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
      try {
        const saved = await loadSamplerPads();
        for (const rec of saved) {
          if (cancelled) return;
          if (engine.pads[rec.padIndex].buffer) continue;
          try {
            const bytes = await rec.blob.arrayBuffer();
            const buffer = await decodeCtx.decodeAudioData(bytes.slice(0));
            if (cancelled) return;
            if (!engine.stagePadSample(rec.padIndex, buffer, rec.name)) continue;
            padBlobs.current[rec.padIndex] = rec.blob;
            engine.setPadVolume(rec.padIndex, rec.volume);
            if (rec.trimEnd > 0) engine.setPadTrim(rec.padIndex, rec.trimStart, rec.trimEnd);
            engine.setPadLoop(rec.padIndex, rec.loop);
            // Records saved before per-pad EQ / LIVE existed have no
            // fields — they restore flat/off.
            engine.setPadEq(rec.padIndex, rec.eq?.low ?? 0, rec.eq?.mid ?? 0, rec.eq?.high ?? 0);
            engine.setPadLive(rec.padIndex, rec.live ?? false);
            refreshPad(rec.padIndex);
          } catch (e) {
            console.warn('Sampler pad restore failed', rec.padIndex, e);
          }
        }
      } catch (e) {
        console.warn('Sampler restore failed', e);
      }
      if (cancelled || getSamplerSeededVersion() === SAMPLER_SEED_VERSION) return;
      let allOk = true;
      for (let i = 0; i < LOOP_SEEDS.length && i < 8; i++) {
        if (cancelled) return;
        const def = LOOP_SEEDS[i];
        if (engine.pads[i].buffer) continue;
        try {
          const res = await fetch(def.url);
          if (!res.ok) throw new Error(`fetch ${def.url} failed: HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          const buffer = await decodeCtx.decodeAudioData(bytes.slice(0));
          if (cancelled) return;
          if (engine.pads[i].buffer) continue;
          if (!engine.stagePadSample(i, buffer, def.title)) {
            allOk = false;
            continue;
          }
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          padBlobs.current[i] = blob;
          engine.setPadVolume(i, 0.8);
          engine.setPadLoop(i, true);
          refreshPad(i);
          await saveSamplerPad({
            padIndex: i,
            name: def.title,
            blob,
            volume: 0.8,
            trimStart: 0,
            trimEnd: buffer.duration,
            loop: true,
            eq: { low: 0, mid: 0, high: 0 },
            live: false,
            savedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('Sampler seed failed', def.title, e);
          allOk = false;
        }
      }
      if (allOk && !cancelled) setSamplerSeededVersion(SAMPLER_SEED_VERSION);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPad]);

  // Loop state can change from MIDI (pad tap / LOOP toggle), so sync the
  // armed/looping flags on a slow poll, like the REC elapsed clock.
  useEffect(() => {
    const t = window.setInterval(() => {
      for (let i = 0; i < 8; i++) refreshPad(i);
    }, 250);
    return () => window.clearInterval(t);
  }, [refreshPad]);

  const startRec = useCallback(() => {
    setRecError(null);
    const deckId = recDeckRef.current === 'A' ? 'deckA' : 'deckB';
    if (!engine.startDeckRecord(deckId)) {
      setRecError(`Start Deck ${recDeckRef.current} playing first (or stop the current recording).`);
      return;
    }
    autoStopSeenAt.current = 0;
    recStartAt.current = Date.now();
    setRecElapsed(0);
    setRecording(true);
  }, []);

  const finishRecToPad = useCallback((buffer: AudioBuffer | null) => {
    if (buffer) {
      engine.loadSample(recPadRef.current, buffer, `Deck ${recDeckRef.current} rec`);
      // Recordings have no file: persist WAV-encoded bytes so the pad
      // survives a reload like any loaded sample.
      padBlobs.current[recPadRef.current] = encodeBufferToWav(buffer);
      persistPad(recPadRef.current);
      refreshPad(recPadRef.current);
      flash(recPadRef.current);
    } else {
      setRecError('No audio captured — was the deck still playing?');
    }
  }, [refreshPad, flash, persistPad]);

  const stopRec = useCallback(async () => {
    setRecording(false);
    const buffer = await engine.stopDeckRecord();
    finishRecToPad(buffer);
  }, [finishRecToPad]);

  // While recording: elapsed clock + auto-stop detection (the 30s cap
  // stops the engine session; the UI picks up the finished buffer a
  // tick later, once the worklet flush has landed).
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setRecElapsed((Date.now() - recStartAt.current) / 1000);
      if (!engine.isDeckRecording()) {
        if (!autoStopSeenAt.current) {
          autoStopSeenAt.current = Date.now();
        } else if (Date.now() - autoStopSeenAt.current > 250) {
          window.clearInterval(timer);
          setRecording(false);
          finishRecToPad(engine.takePendingRecord());
        }
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording, finishRecToPad]);

  // Keyboard triggers 1-8; Shift+1-8 toggles the pad's quick menu;
  // Alt+1-8 retriggers (a sounding pad restarts instead of stopping);
  // 0 stops every sounding pad; Escape closes the menu. (e.code is
  // the physical key, so Shift+1 works regardless of what character
  // the layout produces — and Alt+digit must use e.code too, because
  // on macOS Option+digit produces a special character as e.key.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        setMenuPad(null);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        stopAll();
        return;
      }
      if (e.shiftKey && e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 8) {
          e.preventDefault();
          setMenuPad((cur) => (cur === n - 1 ? null : n - 1));
        }
        return;
      }
      // Alt+digit retriggers. Shift takes precedence (handled above),
      // so Shift+Alt+digit still opens the menu. Ctrl/Meta combos are
      // left alone — they belong to the OS/layout, not the pads.
      // Modifier state is read at keydown time only.
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const m = /^(?:Digit|Numpad)([1-8])$/.exec(e.code);
        if (m) {
          e.preventDefault();
          trigger(Number(m[1]) - 1, true);
        }
        return;
      }
      const i = PAD_KEYS.indexOf(e.key);
      if (i >= 0) trigger(i);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trigger, stopAll]);

  // MIDI triggers + per-pad volumes
  useEffect(() => {
    const cleanups = PAD_KEYS.map((_, i) =>
      midi.registerControl(`sampler.pad${i + 1}`, {
        kind: 'button',
        onButton: (pressed) => { if (pressed) trigger(i); },
      })
    );
    const volCleanups = PAD_KEYS.map((_, i) =>
      midi.registerControl(`sampler.pad${i + 1}.volume`, {
        kind: 'fader',
        onAbsolute: (v) => setVol(i, v),
      })
    );
    const qCleanup = midi.registerControl('sampler.quantize', {
      kind: 'button',
      onButton: (pressed) => {
        if (!pressed) return;
        setQuantize((q) => {
          engine.setSamplerQuantize(!q);
          return !q;
        });
      },
    });
    // MIDI-learnable per-pad LOOP arm/disarm (same Learn-All panel).
    const loopCleanups = PAD_KEYS.map((_, i) =>
      midi.registerControl(`sampler.pad${i + 1}.loop`, {
        kind: 'button',
        onButton: (pressed) => { if (pressed) toggleLoop(i); },
      })
    );
    return () => { cleanups.forEach((c) => c()); volCleanups.forEach((c) => c()); qCleanup(); loopCleanups.forEach((c) => c()); };
  }, [trigger, setVol, toggleLoop]);

  // MIDI — record-from-deck toggle: same paths as the REC / STOP buttons,
  // using the current recDeck / recPad selections (via refs in startRec).
  useEffect(() => {
    const unreg = midi.registerControl('sampler.rec', {
      kind: 'button',
      onButton: (p) => {
        if (!p) return;
        if (recording) void stopRec();
        else startRec();
      },
    });
    return unreg;
  }, [recording, startRec, stopRec]);

  // Drag-drop onto pads
  const onDrop = useCallback((e: React.DragEvent, i: number) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) load(i, f);
  }, [load]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-mono text-zinc-400 hover:text-cyan-300 border border-zinc-700 rounded px-2 py-1"
      >
        + SAMPLER
      </button>
    );
  }

  return (
    <div className="border border-zinc-700 rounded-lg p-2 bg-zinc-950/60">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-zinc-300 tracking-widest">SAMPLER</span>
          <button
            onClick={() => setOpen(false)}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 font-mono"
          >
            hide
          </button>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={quantize}
              onChange={(e) => {
                setQuantize(e.target.checked);
                engine.setSamplerQuantize(e.target.checked);
              }}
              className="accent-cyan-400"
            />
            QUANTIZE
          </label>
          <button
            onClick={stopAll}
            className="text-[10px] font-mono text-red-300 hover:text-red-100 border border-red-900 rounded px-2 py-0.5"
            title="Stop every sounding pad immediately (pads keep their samples, trim, EQ, and loop-arm state). Keyboard: 0."
          >
            ■ STOP ALL
          </button>
          {/* Channel volume + mute live on the sampler strip in the
              mixer now (single control, no competing VOL here). */}
          <span className="text-[10px] font-mono text-zinc-600">VOL + MUTE on mixer strip · LOOP on a pad: tap pad to start, tap again to stop at once · EDIT on a pad: trim start/end with zoom · ⋯ on a pad: quick menu (EQ, trim, LIVE) — Shift+1–8 · 0: STOP ALL</span>
        </div>
      </div>
      {/* Record from a playing deck into a pad. Tap is parallel to the
          deck output, so recording never interrupts the deck or master. */}
      <div className="flex flex-wrap items-center gap-2 mb-2 rounded border border-zinc-800 bg-black/30 px-2 py-1.5">
        <span className="text-[10px] font-mono text-zinc-400 tracking-widest">REC FROM DECK</span>
        <select
          value={recDeck}
          disabled={recording}
          onChange={(e) => setRecDeck(e.target.value as 'A' | 'B')}
          className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1 text-[11px] text-zinc-200 disabled:opacity-40"
        >
          <option value="A">Deck A</option>
          <option value="B">Deck B</option>
        </select>
        <span className="text-[10px] font-mono text-zinc-500">→ PAD</span>
        <select
          value={recPad}
          disabled={recording}
          onChange={(e) => setRecPad(Number(e.target.value))}
          className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1 text-[11px] text-zinc-200 disabled:opacity-40"
        >
          {pads.map((_, i) => (
            <option key={i} value={i}>{i + 1}{pads[i].loaded ? ` (${pads[i].name})` : ''}</option>
          ))}
        </select>
        {recording ? (
          <button
            onClick={stopRec}
            className="h-6 rounded bg-red-700 px-2.5 text-[11px] font-bold text-white hover:bg-red-600"
          >
            ■ STOP
          </button>
        ) : (
          <button
            onClick={startRec}
            className="h-6 rounded bg-zinc-800 px-2.5 text-[11px] font-bold text-red-300 hover:bg-zinc-700"
          >
            ● REC
          </button>
        )}
        {recording && (
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-red-300">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            REC {recElapsed.toFixed(0)}s / 30s
          </span>
        )}
        {recError && (
          <span className="text-[11px] text-amber-300">{recError}</span>
        )}
        {!recording && !recError && (
          <span className="text-[10px] font-mono text-zinc-600">records the playing deck, max 30s</span>
        )}
      </div>
      <div
        className="grid grid-cols-4 gap-1.5"
        onDragOver={(e) => e.preventDefault()}
      >
        {pads.map((p, i) => (
          <div key={i} onDrop={(e) => onDrop(e, i)} onDragOver={(e) => e.preventDefault()}>
            <Pad
              index={i}
              state={p}
              onTrigger={trigger}
              onLoad={load}
              onClear={clear}
              onVolume={setVol}
              onToggleLoop={toggleLoop}
              onEdit={toggleEditPad}
              onToggleMenu={toggleMenu}
              onEq={setEq}
              onLive={setLive}
              onTrim={setTrim}
              onResetTrim={resetTrim}
              onOpenEditor={openEditor}
              onStop={stopVoice}
              menuOpen={menuPad === i}
              editing={editPad === i}
            />
          </div>
        ))}
      </div>
      {editPad !== null && pads[editPad].loaded && (
        <TrimEditor
          key={editPad}
          index={editPad}
          state={pads[editPad]}
          onTrim={(s, e) => setTrim(editPad, s, e)}
          onReset={() => resetTrim(editPad)}
          onClose={() => setEditPad(null)}
          onAudition={() => trigger(editPad)}
          onStop={() => stopVoice(editPad)}
        />
      )}
    </div>
  );
}

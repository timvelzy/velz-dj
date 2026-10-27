import { useCallback, useEffect, useRef, useState } from 'react';
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

function TrimEditor({ index, state, onTrim, onReset, onClose }: {
  index: number;
  state: PadUIState;
  onTrim: (start: number, end: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragWhich = useRef<'start' | 'end' | null>(null);
  const panRef = useRef<{ startX: number; startView: number } | null>(null);
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
      <canvas
        ref={canvasRef}
        width={640}
        height={110}
        className="w-full h-[110px] mt-1 rounded bg-black/40 cursor-ew-resize touch-none"
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
        <span className="text-[10px] font-mono text-zinc-500">drag amber handles (10px grab) · drag background to pan when zoomed · mouse wheel zooms at the pointer · type exact seconds · 5ms fades · trim is non-destructive</span>
      </div>
    </div>
  );
}

function Pad({ index, state, onTrigger, onLoad, onClear, onVolume, onToggleLoop, onEdit, editing }: {
  index: number;
  state: PadUIState;
  onTrigger: () => void;
  onLoad: (file: File) => void;
  onClear: () => void;
  onVolume: (v: number) => void;
  onToggleLoop: () => void;
  onEdit: () => void;
  editing: boolean;
}) {
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
      onClick={() => (state.loaded ? onTrigger() : fileRef.current?.click())}
      onContextMenu={(e) => { e.preventDefault(); if (state.loaded) onClear(); }}
      title={state.loaded
        ? state.looping
          ? `${state.name} — looping in sync, click to stop (finishes the pass)`
          : state.loop
            ? `${state.name} — loop armed, click to start the loop; right-click to clear`
            : `${state.name} — right-click to clear`
        : 'Click to load sample'}
    >
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onLoad(f);
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
          <span className="flex items-center gap-1">
            <button
              className={`text-[9px] font-mono px-1 rounded border ${
                state.looping
                  ? 'text-emerald-300 border-emerald-400 bg-emerald-500/20 animate-pulse'
                  : state.loop
                    ? 'text-cyan-300 border-cyan-500/60 bg-cyan-500/10'
                    : 'text-zinc-500 border-zinc-700 hover:text-cyan-300'
              }`}
              onClick={(e) => { e.stopPropagation(); onToggleLoop(); }}
              title="Loop mode: the pad repeats in sync with the master grid. Tap the pad to start, tap again to stop (finishes the pass)."
            >
              LOOP
            </button>
            <button
              className={`text-[9px] font-mono px-1 rounded border ${
                editing
                  ? 'text-amber-200 border-amber-400 bg-amber-500/20'
                  : 'text-zinc-500 border-zinc-700 hover:text-amber-200'
              }`}
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              title="Edit trim: drag the start/end handles on the large waveform, or type exact seconds."
            >
              EDIT
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
      {showVol && state.loaded && (
        <div className="flex justify-center mt-1" onClick={(e) => e.stopPropagation()}>
          <Knob label="vol" value={state.volume} min={0} max={1} size={36} onChange={onVolume} />
        </div>
      )}
    </div>
  );
}

export default function Sampler() {
  const [pads, setPads] = useState<PadUIState[]>(
    Array.from({ length: 8 }, () => ({ name: '', loaded: false, volume: 0.8, flashing: false, loop: false, looping: false, trimStart: 0, trimEnd: 0 }))
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
      ) return prev;
      const next = [...prev];
      next[i] = { ...next[i], name: p.name, loaded: !!p.buffer, volume: p.volume, loop: p.loop, looping: p.looping, trimStart: p.trimStart, trimEnd: p.trimEnd };
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

  const trigger = useCallback((i: number) => {
    if (engine.triggerSample(i)) flash(i);
  }, [flash]);

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

  // Trim editing: which pad's editor is open (null = none). Zoom state
  // lives inside the editor and resets when switching pads (keyed).
  const [editPad, setEditPad] = useState<number | null>(null);

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

  // Keyboard triggers 1-8
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const i = PAD_KEYS.indexOf(e.key);
      if (i >= 0) trigger(i);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trigger]);

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
          {/* Channel volume + mute live on the sampler strip in the
              mixer now (single control, no competing VOL here). */}
          <span className="text-[10px] font-mono text-zinc-600">VOL + MUTE on mixer strip · LOOP on a pad: tap pad to start, tap again to stop · EDIT on a pad: trim start/end with zoom</span>
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
              onTrigger={() => trigger(i)}
              onLoad={(f) => load(i, f)}
              onClear={() => clear(i)}
              onVolume={(v) => setVol(i, v)}
              onToggleLoop={() => toggleLoop(i)}
              onEdit={() => setEditPad((cur) => (cur === i ? null : i))}
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
        />
      )}
    </div>
  );
}

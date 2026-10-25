import { useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { midi } from '../midi';

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

interface PadUIState {
  name: string;
  loaded: boolean;
  volume: number;
  flashing: boolean;
}

function renderMiniWaveform(buffer: AudioBuffer, canvas: HTMLCanvasElement) {
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
}

function Pad({ index, state, onTrigger, onLoad, onClear, onVolume }: {
  index: number;
  state: PadUIState;
  onTrigger: () => void;
  onLoad: (file: File) => void;
  onClear: () => void;
  onVolume: (v: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const [showVol, setShowVol] = useState(false);

  useEffect(() => {
    const pad = engine.pads[index];
    if (state.loaded && pad.buffer && waveRef.current) {
      renderMiniWaveform(pad.buffer, waveRef.current);
    }
  }, [state.loaded, index]);

  return (
    <div
      className={`relative rounded-lg border p-1.5 select-none transition-colors ${
        state.flashing
          ? 'bg-cyan-500/40 border-cyan-300'
          : state.loaded
            ? 'bg-zinc-800 border-zinc-600 hover:border-cyan-400 cursor-pointer'
            : 'bg-zinc-900 border-zinc-700 border-dashed hover:border-zinc-500 cursor-pointer'
      }`}
      onClick={() => (state.loaded ? onTrigger() : fileRef.current?.click())}
      onContextMenu={(e) => { e.preventDefault(); if (state.loaded) onClear(); }}
      title={state.loaded ? `${state.name} — right-click to clear` : 'Click to load sample'}
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
          <button
            className="text-[9px] text-zinc-500 hover:text-cyan-300 font-mono"
            onClick={(e) => { e.stopPropagation(); setShowVol(!showVol); }}
          >
            vol
          </button>
        )}
      </div>
      {showVol && state.loaded && (
        <input
          type="range" min={0} max={1} step={0.01} value={state.volume}
          className="w-full h-1 mt-1"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
        />
      )}
    </div>
  );
}

export default function Sampler() {
  const [pads, setPads] = useState<PadUIState[]>(
    Array.from({ length: 8 }, () => ({ name: '', loaded: false, volume: 0.8, flashing: false }))
  );
  // Quantize defaults ON (EDM sync feature): pads drop on the next master
  // beat. The checkbox defeats it for manual triggering.
  const [quantize, setQuantize] = useState(true);
  const [master, setMaster] = useState(0.9);
  const [open, setOpen] = useState(true);
  const flashTimers = useRef<number[]>([]);

  const refreshPad = useCallback((i: number) => {
    const p = engine.pads[i];
    setPads((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], name: p.name, loaded: !!p.buffer, volume: p.volume };
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

  const load = useCallback(async (i: number, file: File) => {
    if (await engine.loadSampleFromFile(i, file)) refreshPad(i);
  }, [refreshPad]);

  const clear = useCallback((i: number) => {
    engine.clearSample(i);
    refreshPad(i);
  }, [refreshPad]);

  const setVol = useCallback((i: number, v: number) => {
    engine.setPadVolume(i, v);
    refreshPad(i);
  }, [refreshPad]);

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

  // MIDI triggers
  useEffect(() => {
    const cleanups = PAD_KEYS.map((_, i) =>
      midi.registerControl(`sampler.pad${i + 1}`, {
        kind: 'button',
        onButton: (pressed) => { if (pressed) trigger(i); },
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
    return () => { cleanups.forEach((c) => c()); qCleanup(); };
  }, [trigger]);

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
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400">
            VOL
            <input
              type="range" min={0} max={1} step={0.01} value={master}
              className="w-16 h-1"
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMaster(v);
                engine.setSamplerMaster(v);
              }}
            />
          </label>
        </div>
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
            />
          </div>
        ))}
      </div>
    </div>
  );
}

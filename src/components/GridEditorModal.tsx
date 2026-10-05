import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import type { BeatGrid } from '../types';

interface GridEditorModalProps {
  deckId: 'deckA' | 'deckB';
  deckLabel: string;
  grid: BeatGrid;
  onSave: (grid: BeatGrid) => void;
  onClose: () => void;
}

/**
 * Manual beat-grid editor (kept from GeminiDJ3, fixed):
 * adjust BPM, nudge the first beat, or shift the downbeat by whole beats.
 * The engine's grid reference is updated on save so sync follows immediately.
 */
export default function GridEditorModal({ deckId, deckLabel, grid, onSave, onClose }: GridEditorModalProps) {
  const [bpm, setBpm] = useState(grid.bpm);
  const [firstBeat, setFirstBeat] = useState(grid.firstBeat);
  const [downbeatShift, setDownbeatShift] = useState(0);

  useEffect(() => {
    setBpm(grid.bpm);
    setFirstBeat(grid.firstBeat);
    setDownbeatShift(0);
  }, [grid]);

  const spb = 60 / Math.max(1, bpm);

  const preview = () => {
    // Audition: jump the playhead to the proposed first beat
    engine.seek(deckId, firstBeat);
  };

  const save = () => {
    const next: BeatGrid = {
      ...grid,
      bpm: Math.round(bpm * 10) / 10,
      firstBeat: Math.max(0, firstBeat),
      downbeatOffset:
        grid.downbeatOffset >= 0 ? Math.max(0, grid.downbeatOffset + downbeatShift * spb) : -1,
      method: 'manual',
      confidence: 1,
    };
    const d = engine.decks.get(deckId);
    if (d) d.grid = next;
    onSave(next);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-[420px] rounded-xl border border-zinc-700 bg-zinc-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm font-bold text-zinc-100">Beat grid — Deck {deckLabel}</div>
        <div className="mb-4 text-xs text-zinc-500">
          Detected {grid.bpm.toFixed(1)} BPM via {grid.method} · confidence {Math.round(grid.confidence * 100)}%.
          Fix it by ear: the downbeat (beat 1) should land on the “one”.
        </div>

        <label className="mb-3 block">
          <div className="mb-1 flex justify-between text-xs text-zinc-400">
            <span>BPM</span>
            <span className="font-mono text-zinc-200">{bpm.toFixed(1)}</span>
          </div>
          <input
            type="range" min={grid.bpm * 0.9} max={grid.bpm * 1.1} step={0.1}
            value={bpm} onChange={(e) => setBpm(Number(e.target.value))}
            className="w-full accent-sky-500"
          />
        </label>

        <label className="mb-3 block">
          <div className="mb-1 flex justify-between text-xs text-zinc-400">
            <span>First beat offset</span>
            <span className="font-mono text-zinc-200">{firstBeat.toFixed(3)}s</span>
          </div>
          <input
            type="range" min={0} max={Math.min(4, spb * 4)} step={0.005}
            value={firstBeat} onChange={(e) => setFirstBeat(Number(e.target.value))}
            className="w-full accent-sky-500"
          />
          <div className="mt-1 flex gap-1">
            <button onClick={() => setFirstBeat((v) => Math.max(0, v - spb / 4))} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">−1/4</button>
            <button onClick={() => setFirstBeat((v) => v + spb / 4)} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">+1/4</button>
            <button onClick={preview} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">Audition</button>
          </div>
        </label>

        <label className="mb-4 block">
          <div className="mb-1 flex justify-between text-xs text-zinc-400">
            <span>Downbeat shift (whole beats)</span>
            <span className="font-mono text-zinc-200">{downbeatShift > 0 ? `+${downbeatShift}` : downbeatShift}</span>
          </div>
          <input
            type="range" min={-3} max={3} step={1}
            value={downbeatShift} onChange={(e) => setDownbeatShift(Number(e.target.value))}
            className="w-full accent-sky-500"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-zinc-800 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700">
            Cancel
          </button>
          <button onClick={save} className="rounded bg-sky-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-sky-500">
            Save grid
          </button>
        </div>
      </div>
    </div>
  );
}

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
  // Tap-tempo history: timestamps (performance.now ms) of recent taps
  const [taps, setTaps] = useState<number[]>([]);

  useEffect(() => {
    setBpm(grid.bpm);
    setFirstBeat(grid.firstBeat);
    setDownbeatShift(0);
    setTaps([]);
  }, [grid]);

  const spb = 60 / Math.max(1, bpm);

  const preview = () => {
    // Audition: jump the playhead to the proposed first beat
    engine.seek(deckId, firstBeat);
  };

  const tap = () => {
    const now = performance.now();
    setTaps((prev) => {
      // Gap > 2.5s starts a fresh count
      const recent = prev.length > 0 && now - prev[prev.length - 1] > 2500 ? [] : prev;
      const next = [...recent.slice(-7), now];
      if (next.length >= 2) {
        const intervals: number[] = [];
        for (let i = 1; i < next.length; i++) intervals.push(next[i] - next[i - 1]);
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const tappedBpm = 60000 / mean;
        if (tappedBpm >= 60 && tappedBpm <= 200) setBpm(Math.round(tappedBpm * 10) / 10);
      }
      return next;
    });
  };

  const save = () => {
    const newBpm = Math.round(bpm * 10) / 10;
    const newFirst = Math.max(0, firstBeat);
    // Rebuild the beat map from the NEW bpm + firstBeat — the engine
    // phase-locks against beats[] when present, so leaving the old map
    // in place would keep syncing to the pre-edit grid (stale beat-map bug).
    const duration = engine.decks.get(deckId)?.buffer?.duration ?? 600;
    const newSpb = 60 / Math.max(1, newBpm);
    const beats: number[] = [];
    for (let t = newFirst; t < duration; t += newSpb) beats.push(t);
    const bpmCurve = beats.map(() => newBpm).slice(0, Math.max(0, beats.length - 1));
    const next: BeatGrid = {
      ...grid,
      bpm: newBpm,
      firstBeat: newFirst,
      downbeatOffset:
        grid.downbeatOffset >= 0 ? Math.max(0, grid.downbeatOffset + downbeatShift * spb) : -1,
      beats,
      bpmCurve,
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
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
            <span>BPM</span>
            <span className="flex items-center gap-1">
              <input
                type="number" min={60} max={200} step={0.1}
                value={bpm.toFixed(1)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setBpm(Math.min(200, Math.max(60, Math.round(v * 10) / 10)));
                }}
                className="w-16 rounded bg-zinc-800 px-1 py-0.5 text-right font-mono text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                onClick={tap}
                className={`rounded px-2 py-0.5 text-xs font-bold ${taps.length >= 2 ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300'} hover:bg-sky-500`}
                title="Tap the beat — BPM follows your taps"
              >
                Tap{taps.length >= 2 ? ` ×${taps.length}` : ''}
              </button>
            </span>
          </div>
          <input
            type="range" min={Math.max(60, bpm * 0.9)} max={Math.min(200, bpm * 1.1)} step={0.1}
            value={Math.min(200, Math.max(60, bpm))} onChange={(e) => setBpm(Number(e.target.value))}
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

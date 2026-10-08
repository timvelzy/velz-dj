import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { midi } from '../midi';
import type { BeatGrid, TrackInfo } from '../types';
import Waveform from './Waveform';

export interface DeckState {
  track: TrackInfo | null;
  buffer: AudioBuffer | null;
  analyzing: boolean;
  analysisProgress: number;
  tempo: number;
  keyLock: boolean;
  syncActive: boolean;
  hotcues: (number | null)[];
  loop: { start: number; end: number } | null;
  pendingLoopIn: number | null;
  cuePoint: number;
}

interface DeckProps {
  deckKey: 'A' | 'B';
  state: DeckState;
  isMaster: boolean;
  masterBpm: number;
  accent: string;
  onPlayPause: () => void;
  onCueDown: () => void;
  onCueUp: () => void;
  onTempo: (v: number) => void;
  onSync: () => void;
  onMaster: () => void;
  onKeyLock: () => void;
  onSeek: (t: number) => void;
  onHotcue: (i: number, set: boolean) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onLoopExit: () => void;
  onDropFiles: (files: FileList) => void;
  onEditGrid: () => void;
  onNudgeStart: (dir: -1 | 1) => void;
  onNudgeEnd: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function JogWheel({ deckId, paused, onBend, onScratch }: {
  deckId: string;
  paused: boolean;
  onBend: (amount: number) => void;
  onScratch: (deltaSec: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; angle: number } | null>(null);

  const angleOf = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };

  return (
    <div
      ref={ref}
      className="relative h-28 w-28 shrink-0 cursor-grab touch-none rounded-full border-4 border-zinc-700 bg-zinc-900 active:cursor-grabbing"
      style={{ boxShadow: 'inset 0 0 20px rgba(0,0,0,0.8)' }}
      title={paused ? 'Drag to scratch (seek)' : 'Drag to pitch-bend'}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, angle: angleOf(e) };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const a = angleOf(e);
        let d = a - drag.current.angle;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        drag.current.angle = a;
        if (paused) onScratch(d * 2); // radians → seconds
        else onBend(clamp(d * 3, -0.08, 0.08));
      }}
      onPointerUp={() => { drag.current = null; onBend(0); }}
      onPointerCancel={() => { drag.current = null; onBend(0); }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full bg-zinc-800" />
      </div>
      <div className="absolute left-1/2 top-1 h-3 w-1 -translate-x-1/2 rounded bg-sky-400" />
    </div>
  );
}

export default function Deck(props: DeckProps) {
  const { deckKey, state, isMaster, accent } = props;
  const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
  const [elapsed, setElapsed] = useState('0:00');

  // 10fps ticker for time display (waveform has its own rAF)
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!state.buffer) return;
      const pos = engine.position(deckId);
      const m = Math.floor(pos / 60);
      const s = Math.floor(pos % 60).toString().padStart(2, '0');
      setElapsed(`${m}:${s}`);
    }, 100);
    return () => window.clearInterval(id);
  }, [state.buffer, deckId]);

  const isPlaying = engine.isPlaying(deckId);

  // MIDI bindings
  useEffect(() => {
    const regs = [
      midi.registerControl(`${deckId}.play`, { kind: 'button', onButton: (p) => { if (p) props.onPlayPause(); } }),
      midi.registerControl(`${deckId}.cue`, {
        kind: 'button',
        onButton: (p) => { if (p) props.onCueDown(); else props.onCueUp(); },
      }),
      midi.registerControl(`${deckId}.sync`, { kind: 'button', onButton: (p) => { if (p) props.onSync(); } }),
      midi.registerControl(`${deckId}.tempo`, { kind: 'fader', onAbsolute: (v) => props.onTempo(0.84 + v * 0.32) }),
      midi.registerControl(`${deckId}.jog`, {
        kind: 'jog',
        onRelative: (d) => {
          if (engine.isPlaying(deckId)) {
            engine.setNudge(deckId, clamp(d * 0.004, -0.06, 0.06));
            window.setTimeout(() => engine.clearNudge(deckId), 60);
          } else {
            engine.seek(deckId, engine.position(deckId) + d * 0.02);
          }
        },
      }),
      midi.registerControl(`${deckId}.nudgeMinus`, { kind: 'button', onButton: (p) => { p ? props.onNudgeStart(-1) : props.onNudgeEnd(); } }),
      midi.registerControl(`${deckId}.nudgePlus`, { kind: 'button', onButton: (p) => { p ? props.onNudgeStart(1) : props.onNudgeEnd(); } }),
      midi.registerControl(`${deckId}.keyLock`, { kind: 'button', onButton: (p) => { if (p) props.onKeyLock(); } }),
      midi.registerControl(`${deckId}.loopIn`, { kind: 'button', onButton: (p) => { if (p) props.onLoopIn(); } }),
      midi.registerControl(`${deckId}.loopOut`, { kind: 'button', onButton: (p) => { if (p) props.onLoopOut(); } }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const grid: BeatGrid | null = state.track?.beatGrid ?? null;
  const effTempo = state.syncActive && !isMaster ? undefined : state.tempo;
  const bpmNow = grid && grid.bpm > 0 ? grid.bpm * (effTempo ?? 1) : 0;

  const fmtDur = (d: number) => {
    const m = Math.floor(d / 60);
    const s = Math.floor(d % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) props.onDropFiles(e.dataTransfer.files);
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 items-center justify-center rounded font-black text-black"
              style={{ background: accent }}
            >
              {deckKey}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-zinc-100">
                {state.track?.title ?? 'No track loaded'}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {state.track?.artist ?? 'Drop audio here or pick from the library'}
              </div>
            </div>
          </div>
        </div>
        <div className="text-right text-xs text-zinc-400">
          <div className="font-mono text-lg text-zinc-100">
            {bpmNow > 0 ? bpmNow.toFixed(1) : '—'}
            <span className="text-[10px] text-zinc-500"> BPM</span>
          </div>
          {grid && grid.bpm > 0 && (
            <div
              className={`inline-block rounded px-1 text-[9px] font-bold uppercase tracking-wide ${
                grid.method === 'traktor'
                  ? 'bg-emerald-900 text-emerald-300'
                  : grid.method === 'manual'
                    ? 'bg-violet-900 text-violet-300'
                    : 'bg-zinc-800 text-zinc-400'
              }`}
              title={
                grid.method === 'traktor'
                  ? `Traktor beat grid — ${grid.beats.length} mapped beats`
                  : `Analyzed (${grid.method}) — ${grid.beats.length} mapped beats, ${Math.round(grid.confidence * 100)}% confidence`
              }
            >
              {grid.method === 'traktor' ? '♻ Traktor' : grid.method}
            </div>
          )}
          <div className="font-mono">
            {elapsed} / {state.track ? fmtDur(state.track.duration) : '—'}
          </div>
          {state.track?.key && <div className="text-amber-300">{state.track.key}</div>}
        </div>
      </div>

      {state.analyzing && (
        <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-sky-500 transition-all" style={{ width: `${state.analysisProgress * 100}%` }} />
        </div>
      )}

      {/* Waveform */}
      <Waveform
        deckId={deckId}
        buffer={state.buffer}
        grid={grid}
        color={accent}
        loop={state.loop}
        hotcues={state.hotcues}
        onSeek={props.onSeek}
      />
      {grid && (
        <button onClick={props.onEditGrid} className="self-start text-[11px] text-zinc-500 underline hover:text-zinc-300">
          Edit beat grid {grid.confidence < 0.4 && <span className="text-amber-400">(low confidence)</span>}
        </button>
      )}

      {/* Transport row */}
      <div className="flex items-center gap-3">
        <JogWheel
          deckId={deckId}
          paused={!isPlaying}
          onBend={(a) => { if (a === 0) engine.clearNudge(deckId); else engine.setNudge(deckId, a); }}
          onScratch={(d) => engine.seek(deckId, engine.position(deckId) + d)}
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={props.onPlayPause}
              className={`h-11 w-16 rounded-lg font-bold ${isPlaying ? 'bg-emerald-600' : 'bg-zinc-700 hover:bg-zinc-600'} text-white`}
            >
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <button
              onPointerDown={(e) => { e.preventDefault(); props.onCueDown(); }}
              onPointerUp={props.onCueUp}
              onPointerLeave={props.onCueUp}
              onPointerCancel={props.onCueUp}
              onContextMenu={(e) => e.preventDefault()}
              title="Hold to preview from cue point"
              className="h-11 w-14 touch-none select-none rounded-lg bg-zinc-700 font-bold text-amber-300 hover:bg-zinc-600 active:bg-amber-600 active:text-black"
            >
              CUE
            </button>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={props.onSync}
              className={`h-8 flex-1 rounded text-xs font-bold ${state.syncActive ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
            >
              SYNC
            </button>
            <button
              onClick={props.onMaster}
              className={`h-8 flex-1 rounded text-xs font-bold ${isMaster ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
              title="Set as sync master"
            >
              MASTER
            </button>
            <button
              onClick={props.onKeyLock}
              className={`h-8 flex-1 rounded text-xs font-bold ${state.keyLock ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
              title="Key lock (pitch preserved when tempo changes)"
            >
              KEY
            </button>
          </div>
          <div className="flex gap-1.5">
            {(['-1', '+1'] as const).map((d) => (
              <button
                key={d}
                className="h-8 flex-1 rounded bg-zinc-800 text-xs font-bold text-zinc-300 hover:bg-zinc-700 active:bg-sky-700"
                onPointerDown={() => props.onNudgeStart(d === '-1' ? -1 : 1)}
                onPointerUp={props.onNudgeEnd}
                onPointerLeave={props.onNudgeEnd}
                onPointerCancel={props.onNudgeEnd}
                onContextMenu={(e) => e.preventDefault()}
              >
                {d === '-1' ? '− NUDGE' : 'NUDGE +'}
              </button>
            ))}
          </div>
        </div>
        {/* Tempo fader */}
        <div className="flex flex-col items-center gap-1">
          <span className="font-mono text-xs text-zinc-300">
            {((state.tempo - 1) * 100).toFixed(1)}%
          </span>
          <input
            type="range"
            min={0.84}
            max={1.16}
            step={0.0005}
            value={state.tempo}
            disabled={state.syncActive && !isMaster}
            onChange={(e) => props.onTempo(Number(e.target.value))}
            className="h-28 w-2 accent-sky-500 disabled:opacity-40"
            style={{ writingMode: 'vertical-lr', direction: 'rtl' } as React.CSSProperties}
            title="Tempo ±16%"
          />
          <button
            onClick={() => props.onTempo(1)}
            className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700"
          >
            0%
          </button>
        </div>
      </div>

      {/* Hotcues + loop */}
      <div className="flex items-center gap-1.5">
        {state.hotcues.map((hc, i) => (
          <button
            key={i}
            onClick={(e) => props.onHotcue(i, e.shiftKey)}
            onContextMenu={(e) => { e.preventDefault(); props.onHotcue(i, true); }}
            title="Click: jump • Shift+click / right-click: set"
            className={`h-8 flex-1 rounded text-xs font-bold ${hc !== null ? 'text-black' : 'bg-zinc-800 text-zinc-500'}`}
            style={hc !== null ? { background: ['#f472b6', '#fbbf24', '#a3e635', '#22d3ee'][i % 4] } : undefined}
          >
            {i + 1}
          </button>
        ))}
        <div className="mx-1 h-8 w-px bg-zinc-800" />
        <button onClick={props.onLoopIn} className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700">IN</button>
        <button onClick={props.onLoopOut} className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700">OUT</button>
        <button onClick={props.onLoopExit} className={`h-8 rounded px-2 text-xs font-bold ${state.loop ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}>LOOP</button>
      </div>
    </div>
  );
}

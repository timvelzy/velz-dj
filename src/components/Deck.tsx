import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { keyCompatibility, keyCompatibilityLabel } from '../audio/keycompat';
import { LOOP_SIZES, formatLoopSize } from '../audio/loop';
import { midi } from '../midi';
import type { BeatGrid, TrackInfo } from '../types';
import Waveform, { OverviewWaveform } from './Waveform';

export interface DeckState {
  track: TrackInfo | null;
  buffer: AudioBuffer | null;
  analyzing: boolean;
  analysisProgress: number;
  tempo: number;
  keyLock: boolean;
  syncActive: boolean;
  /** Quantize hotcue jumps + loop points to the beat grid, and Play/CUE
   * launches to the master bar (Phase 5 + quantized launch). */
  quantize: boolean;
  hotcues: (number | null)[];
  /** Per-slot: true when that hotcue is an auto (analysis) value. A manual
      set on the slot clears its flag (and persists as manualHotcues). */
  hotcueAuto: boolean[];
  loop: { start: number; end: number } | null;
  /** Active Traktor-style loop size in bars (null for manual IN/OUT loops). */
  loopBars: number | null;
  pendingLoopIn: number | null;
  /** Explicit cue point, or null = no cue set (CUE then targets track start). */
  cuePoint: number | null;
}

interface DeckProps {
  deckKey: 'A' | 'B';
  state: DeckState;
  isMaster: boolean;
  /** The sync master's Camelot key (for the compatibility badge; '' = none). */
  masterKey?: string;
  masterBpm: number;
  accent: string;
  onPlayPause: () => void;
  onCueDown: () => void;
  onCueUp: () => void;
  onSetCue: () => void;
  /** Re-anchor the beat grid at the playhead: the nearest beat becomes bar 1 beat 1 (phase only, no re-analysis). */
  onSetOneOne: () => void;
  onStop: () => void;
  onTempo: (v: number) => void;
  /** Fader grab: disengage SYNC on a synced follower, keeping tempo (App tempoGrab). */
  onTempoGrab: () => void;
  onSync: () => void;
  onMaster: () => void;
  onKeyLock: () => void;
  onSeek: (t: number) => void;
  onHotcue: (i: number, set: boolean) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onLoopExit: () => void;
  onLoopBars: (bars: number) => void;
  onLoopHalve: () => void;
  onLoopDouble: () => void;
  onToggleQuantize: () => void;
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
  // Remaining time + end-of-track urgency. Same 10fps tick as elapsed;
  // display-only, derived from the engine position and track duration.
  const [remaining, setRemaining] = useState<string | null>(null);
  const [endingSoon, setEndingSoon] = useState(false);
  const [lock, setLock] = useState<{ errMs: number; locked: boolean } | null>(null);
  const [queued, setQueued] = useState(false);
  // Round 5: smoothed copy of the raw phase readout. The engine's errMs
  // is instantaneous, so a raw 10fps poll jumps with every PLL tick;
  // a ~300ms EMA makes the number readable. Display-only — the LOCKED
  // claim itself comes from the engine's sustained criterion, not this
  // smoothing. A >500ms jump snaps straight to the raw value (bar-wrap
  // or a real phase jump must never be averaged through zero).
  const errMsSm = useRef<number | null>(null);
  // Perf: the 10fps tick used to setLock/setQueued with a fresh object
  // every tick, re-rendering the whole deck 10x/sec even when nothing
  // changed. Only publish when the visible values actually move.
  const lastPub = useRef<{ errMs: number; locked: boolean } | null>(null);
  const lastQueued = useRef<boolean | null>(null);

  // 10fps ticker for time display (waveform has its own rAF)
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!state.buffer) return;
      const pos = engine.position(deckId);
      const m = Math.floor(pos / 60);
      const s = Math.floor(pos % 60).toString().padStart(2, '0');
      setElapsed(`${m}:${s}`);
      const left = Math.max(0, state.buffer.duration - pos);
      const lm = Math.floor(left / 60);
      const ls = Math.floor(left % 60).toString().padStart(2, '0');
      setRemaining(`-${lm}:${ls}`);
      setEndingSoon(left <= 30 && engine.isPlaying(deckId));
      const s2 = engine.syncStatus(deckId);
      const q = engine.pendingLaunchAt(deckId) !== null;
      if (lastQueued.current !== q) {
        lastQueued.current = q;
        setQueued(q);
      }
      if (s2) {
        const prev = errMsSm.current;
        const sm = prev === null || Math.abs(s2.errMs - prev) > 500
          ? s2.errMs
          : prev + (s2.errMs - prev) * 0.3;
        errMsSm.current = sm;
        const rounded = Math.round(sm);
        const prevPub = lastPub.current;
        if (!prevPub || prevPub.errMs !== rounded || prevPub.locked !== s2.locked) {
          lastPub.current = { errMs: rounded, locked: s2.locked };
          setLock({ errMs: sm, locked: s2.locked });
        }
      } else {
        errMsSm.current = null;
        if (lastPub.current !== null) {
          lastPub.current = null;
          setLock(null);
        }
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [state.buffer, deckId]);

  const isPlaying = engine.isPlaying(deckId);

  // CUE preview guard: cueUp must only fire for a press that STARTED on
  // this button. Previously onPointerUp/Leave/Cancel all fired
  // unconditionally, so a stray release (pointer pressed elsewhere, e.g.
  // the Q toggle, then released over CUE) fired cueUp — and cueUp while
  // playing pauses + seeks to cue, i.e. a "deck quit" with no CUE press.
  // Track the pressing pointerId; ignore releases/leaves/cancels from any
  // pointer that did not start here. Genuine presses are unchanged: down
  // previews, drag-off stops the preview (leave fires for the same id),
  // release while paused is a no-op in the cueUp handler itself.
  const cuePointerId = useRef<number | null>(null);
  const cueDownOnButton = (e: React.PointerEvent) => {
    e.preventDefault();
    cuePointerId.current = e.pointerId;
    props.onCueDown();
  };
  const cueUpIfPressed = (e: React.PointerEvent) => {
    if (cuePointerId.current === null || cuePointerId.current !== e.pointerId) return;
    cuePointerId.current = null;
    props.onCueUp();
  };

  // Camelot compatibility of this deck's key against the master's key.
  // Direction: master -> candidate, so ENERGY means this track lifts +2.
  const keyTier = !isMaster && props.masterKey && state.track?.key
    ? keyCompatibility(props.masterKey, state.track.key)
    : 'unknown';
  const keyTierColor = keyTier === 'perfect'
    ? 'text-emerald-400'
    : keyTier === 'compatible'
      ? 'text-sky-400'
      : keyTier === 'energy'
        ? 'text-violet-400'
        : keyTier === 'clash'
          ? 'text-red-400'
          : '';

  // MIDI bindings
  useEffect(() => {
    const regs = [
      midi.registerControl(`${deckId}.play`, { kind: 'button', onButton: (p) => { if (p) props.onPlayPause(); } }),
      midi.registerControl(`${deckId}.cue`, {
        kind: 'button',
        onButton: (p) => { if (p) props.onCueDown(); else props.onCueUp(); },
      }),
      midi.registerControl(`${deckId}.sync`, { kind: 'button', onButton: (p) => { if (p) props.onSync(); } }),
      midi.registerControl(`${deckId}.tempo`, { kind: 'fader', onAbsolute: (v) => { props.onTempoGrab(); props.onTempo(0.84 + v * 0.32); } }),
      midi.registerControl(`${deckId}.jog`, {
        kind: 'jog',
        onRelative: (d) => {
          if (engine.isPlaying(deckId)) {
            // Deadline-based nudge: repeated jog ticks extend it, and it
            // can never latch if a clear is missed (Phase 5).
            engine.setNudgeFor(deckId, clamp(d * 0.004, -0.06, 0.06), 120);
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
      midi.registerControl(`${deckId}.loopExit`, { kind: 'button', onButton: (p) => { if (p) props.onLoopExit(); } }),
      midi.registerControl(`${deckId}.loopHalve`, { kind: 'button', onButton: (p) => { if (p) props.onLoopHalve(); } }),
      midi.registerControl(`${deckId}.loopDouble`, { kind: 'button', onButton: (p) => { if (p) props.onLoopDouble(); } }),
      midi.registerControl(`${deckId}.hotcue1`, { kind: 'button', onButton: (p) => { if (p) props.onHotcue(0, false); } }),
      midi.registerControl(`${deckId}.hotcue2`, { kind: 'button', onButton: (p) => { if (p) props.onHotcue(1, false); } }),
      midi.registerControl(`${deckId}.hotcue3`, { kind: 'button', onButton: (p) => { if (p) props.onHotcue(2, false); } }),
      midi.registerControl(`${deckId}.hotcue4`, { kind: 'button', onButton: (p) => { if (p) props.onHotcue(3, false); } }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const grid: BeatGrid | null = state.track?.beatGrid ?? null;
  // Traktor SYNC display: a synced follower's fader and BPM readout
  // follow the MASTER, not the stale manual tempo. syncRatio is the
  // exact tempo the engine targets (master BPM / track BPM); the
  // engine's own syncBaseTempo converges to the same value through its
  // PLL (local-BPM follow on walked grids can differ slightly — the
  // LOCKED indicator, not this readout, is the phase authority).
  // No master BPM yet (250ms poll) → fall back to the manual tempo.
  const syncedFollower = state.syncActive && !isMaster;
  const syncRatio = syncedFollower && props.masterBpm > 0 && grid && grid.bpm > 0
    ? props.masterBpm / grid.bpm
    : null;
  /** Tempo the fader + % readout show: sync offset while synced, manual otherwise. */
  const displayTempo = syncRatio ?? state.tempo;
  const bpmNow = grid && grid.bpm > 0
    ? (syncRatio !== null ? props.masterBpm : grid.bpm * state.tempo)
    : 0;
  /** Manual tempo input (fader, 0% button, keys): grabbing the fader of
   *  a synced follower disengages SYNC first, keeping current tempo,
   *  then the new value applies. Idempotent when not synced. */
  const manualTempo = (v: number) => {
    if (syncedFollower) props.onTempoGrab();
    props.onTempo(v);
  };

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
            {remaining !== null && (
              <span className={endingSoon ? 'font-bold text-amber-400' : 'text-zinc-500'}>
                {' '}· {remaining} left
              </span>
            )}
          </div>
          {state.track?.key && (
            <div className="text-amber-300">
              {state.track.key}
              {keyTier !== 'unknown' && (
                <span
                  className={`ml-1 text-[9px] font-bold ${keyTierColor}`}
                  title={`Camelot vs master ${props.masterKey}: ${keyCompatibilityLabel(keyTier)}`}
                >
                  {keyTier === 'clash' ? '✕ CLASH' : `✓ ${keyCompatibilityLabel(keyTier)}`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {state.analyzing && (
        <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-sky-500 transition-all" style={{ width: `${state.analysisProgress * 100}%` }} />
        </div>
      )}

      {/* Waveform — overview strip + scrolling detail */}
      <OverviewWaveform
        deckId={deckId}
        buffer={state.buffer}
        peaks={state.track?.peaks ?? null}
        grid={grid}
        color={accent}
        loop={state.loop}
        hotcues={state.hotcues}
        hotcueAuto={state.hotcueAuto}
        onSeek={props.onSeek}
      />
      <Waveform
        deckId={deckId}
        buffer={state.buffer}
        grid={grid}
        color={accent}
        loop={state.loop}
        hotcues={state.hotcues}
        hotcueAuto={state.hotcueAuto}
        onSeek={props.onSeek}
        peaks={state.track?.peaks ?? null}
      />
      {grid && (
        <button onClick={props.onEditGrid} className="self-start text-[11px] text-zinc-500 underline hover:text-zinc-300">
          Edit beat grid {grid.confidence < 0.4 && <span className="text-amber-400">(low confidence)</span>}
        </button>
      )}

      {/* Transport cluster — reference layout: vertical TEMPO fader
          left with a live green % readout, NUDGE + above and NUDGE -
          below, round play / CUE / phase buttons + SYNC in the middle
          row, MASTER below. Every control drives audio live; nothing
          here is decorative. The jog wheel stays to the right (scratch
          when paused, bend while playing). */}
      <div className="rounded-lg border border-zinc-800 bg-[#0a0f1e] p-3">
        <div className="flex items-start gap-4">
          {/* TEMPO column */}
          <div className="flex shrink-0 flex-col items-center gap-1">
            <span className="text-[11px] font-bold tracking-widest text-zinc-300">TEMPO</span>
            <span className="font-mono text-[9px] text-zinc-500">+16%</span>
            <input
              type="range"
              min={0.84}
              max={1.16}
              step={0.0005}
              value={clamp(displayTempo, 0.84, 1.16)}
              onPointerDown={() => props.onTempoGrab()}
              onChange={(e) => manualTempo(Number(e.target.value))}
              className={`h-28 w-2 ${syncedFollower ? 'accent-emerald-500' : 'accent-sky-500'}`}
              style={{ writingMode: 'vertical-lr', direction: 'rtl' } as React.CSSProperties}
              title={
                syncedFollower
                  ? 'Tempo ±16% — synced to master (thumb pins at the limit if the offset exceeds ±16%; the % readout stays true). Grabbing the fader disengages SYNC and keeps the current tempo.'
                  : 'Tempo ±16% — live playback rate'
              }
            />
            <span className="font-mono text-sm text-emerald-400">
              {((displayTempo - 1) * 100).toFixed(1)}%
            </span>
            <span className="font-mono text-[9px] text-zinc-500">−16%</span>
            {syncedFollower && (
              <span className="rounded bg-emerald-900 px-1 text-[9px] font-bold text-emerald-300">SYNC</span>
            )}
            <button
              onClick={() => manualTempo(1)}
              className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700"
            >
              0%
            </button>
          </div>
          {/* Button column */}
          <div className="flex flex-1 flex-col items-stretch gap-2">
            <button
              className="h-8 rounded border border-zinc-700 bg-zinc-800/90 text-xs font-bold text-zinc-200 hover:bg-zinc-700 active:bg-sky-700"
              onPointerDown={() => props.onNudgeStart(1)}
              onPointerUp={props.onNudgeEnd}
              onPointerLeave={props.onNudgeEnd}
              onPointerCancel={props.onNudgeEnd}
              onContextMenu={(e) => e.preventDefault()}
            >
              ▲ NUDGE +
            </button>
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={props.onPlayPause}
                title={isPlaying ? 'Pause' : 'Play'}
                className={`h-14 w-14 shrink-0 rounded-full text-lg font-bold text-white ${isPlaying ? 'bg-emerald-600' : 'bg-zinc-700 hover:bg-zinc-600'}`}
              >
                {isPlaying ? '❚❚' : '▶'}
              </button>
              <button
                onPointerDown={cueDownOnButton}
                onPointerUp={cueUpIfPressed}
                onPointerLeave={cueUpIfPressed}
                onPointerCancel={cueUpIfPressed}
                onContextMenu={(e) => e.preventDefault()}
                title="CUE: hold to preview from cue point (release returns to it)"
                aria-label="CUE: hold to preview from the cue point"
                className="h-14 w-14 shrink-0 touch-none select-none rounded-full border-2 border-zinc-500 text-xs font-bold text-amber-300 hover:bg-zinc-800 active:bg-amber-600 active:text-black"
              >
                CUE
              </button>
              <button
                onClick={props.onSetOneOne}
                disabled={!state.buffer}
                title="Phase align (SET 1.1): re-anchor the beat grid at the playhead — the beat nearest the playhead becomes bar 1 beat 1 (grid phase only, no re-analysis, saved with the track)"
                aria-label="Set 1.1: re-anchor the beat grid phase at the playhead"
                className="h-14 w-14 shrink-0 rounded-full border border-sky-500 text-xs font-bold text-sky-400 hover:bg-sky-950 disabled:opacity-40"
              >
                1.1
              </button>
              <button
                onClick={props.onSync}
                title="SYNC: match the master tempo and hold phase on the master grid (grabbing the tempo fader disengages SYNC and keeps the current tempo)"
                className={`h-11 flex-1 rounded border px-2 text-sm font-bold ${
                  state.syncActive
                    ? 'border-emerald-500 bg-emerald-600 text-white'
                    : 'border-emerald-600/70 bg-transparent text-emerald-400 hover:bg-emerald-950'
                }`}
              >
                SYNC
              </button>
            </div>
            <button
              className="h-8 rounded border border-zinc-700 bg-zinc-800/90 text-xs font-bold text-zinc-200 hover:bg-zinc-700 active:bg-sky-700"
              onPointerDown={() => props.onNudgeStart(-1)}
              onPointerUp={props.onNudgeEnd}
              onPointerLeave={props.onNudgeEnd}
              onPointerCancel={props.onNudgeEnd}
              onContextMenu={(e) => e.preventDefault()}
            >
              ▼ NUDGE −
            </button>
            <button
              onClick={props.onMaster}
              title="MASTER: this deck is the tempo clock — synced followers chase it (only one master at a time)"
              className={`h-8 rounded text-xs font-bold ${isMaster ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
            >
              MASTER
            </button>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-1">
            <JogWheel
              deckId={deckId}
              paused={!isPlaying}
              onBend={(a) => { if (a === 0) engine.clearNudge(deckId); else engine.setNudge(deckId, a); }}
              onScratch={(d) => engine.seek(deckId, engine.position(deckId) + d)}
            />
            <span className="max-w-28 text-center text-[9px] uppercase leading-tight tracking-wide text-zinc-500">
              Jog · drag to bend, scratch when paused
            </span>
          </div>
        </div>
        {(lock || queued) && (
          <div className="mt-2 flex items-center gap-2 font-mono text-[10px]">
            {lock && (
              <span className={lock.locked ? 'text-emerald-400' : 'text-amber-400'}>
                {lock.locked ? '● SYNC LOCKED' : `○ SYNC ${lock.errMs >= 0 ? '+' : ''}${lock.errMs.toFixed(0)}ms`}
              </span>
            )}
            {queued && <span className="text-amber-300">▸ QUEUED — drops on the bar</span>}
          </div>
        )}
      </div>

      {/* SET CUE / STOP / KEY row (SET 1.1 now lives in the cluster as ↻) */}
      <div className="flex gap-1.5">
        <button
          onClick={props.onSetCue}
          disabled={!state.buffer}
          title="Set cue point to current position (CUE returns here; unset = track start)"
          className="h-8 flex-1 rounded bg-zinc-800 text-xs font-bold text-amber-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          SET CUE
        </button>
        <button
          onClick={props.onStop}
          disabled={!state.buffer}
          title="Stop and return to cue point (track start if none set)"
          className="h-8 flex-1 rounded bg-zinc-800 text-xs font-bold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          ■ STOP
        </button>
        <button
          onClick={props.onKeyLock}
          className={`h-8 flex-1 rounded text-xs font-bold ${state.keyLock ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="Key lock (pitch preserved when tempo changes)"
        >
          KEY
        </button>
      </div>

      {/* Hotcues + loop */}
      <div className="flex items-center gap-1.5">
        {state.hotcues.map((hc, i) => (
          <button
            key={i}
            onClick={(e) => props.onHotcue(i, e.shiftKey)}
            onContextMenu={(e) => { e.preventDefault(); props.onHotcue(i, true); }}
            title={state.hotcueAuto?.[i] ? 'Auto hotcue (click: jump • Shift+click / right-click: set your own)' : 'Click: jump • Shift+click / right-click: set'}
            className={`h-8 flex-1 rounded text-xs font-bold ${hc !== null ? 'text-black' : 'bg-zinc-800 text-zinc-500'}`}
            style={hc !== null ? { background: ['#f472b6', '#fbbf24', '#a3e635', '#22d3ee'][i % 4] } : undefined}
          >
            {i + 1}
            {state.hotcueAuto?.[i] && <span className="block text-[8px] leading-none">AUTO</span>}
          </button>
        ))}
        <div className="mx-1 h-8 w-px bg-zinc-800" />
        <button onClick={props.onLoopIn} className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700">IN</button>
        <button onClick={props.onLoopOut} className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700">OUT</button>
        <button
          onClick={props.onLoopExit}
          title="Loop out: exit the loop and keep playing forward from here"
          className={`h-8 rounded px-2 text-xs font-bold ${state.loop ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
        >
          LOOP
        </button>
        <button
          onClick={props.onToggleQuantize}
          className={`h-8 rounded px-2.5 text-xs font-bold ${state.quantize ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
          title="Quantize: Play/CUE launches drop on the master bar, hotcue jumps and loop points snap to the beat grid (off = manual control)"
          aria-label="Quantize on or off"
        >
          QTZ
        </button>
      </div>

      {/* Traktor-style loop sizes: set a bar loop from the current barline */}
      <div className="flex items-center gap-1">
        <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">Loop</span>
        {LOOP_SIZES.map((bars) => (
          <button
            key={bars}
            onClick={() => props.onLoopBars(bars)}
            disabled={!state.buffer}
            title={`Set a ${formatLoopSize(bars)}-bar loop from the current bar`}
            className={`h-8 flex-1 rounded text-xs font-bold disabled:opacity-40 ${
              state.loopBars === bars ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {formatLoopSize(bars)}
          </button>
        ))}
        <button
          onClick={props.onLoopHalve}
          disabled={!state.loop}
          title="Halve the active loop (keeps its start)"
          className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          −
        </button>
        <button
          onClick={props.onLoopDouble}
          disabled={!state.loop}
          title="Double the active loop (keeps its start)"
          className="h-8 rounded bg-zinc-800 px-2 text-xs font-bold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}

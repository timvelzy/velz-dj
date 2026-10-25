/**
 * Center-playhead dual waveform view (item 1, ported from groove-web-mixer).
 *
 * What was pulled from groove-web-mixer (Lovable project 9d079ecf, commit
 * 974548c — verified byte-identical to the local ~/workspace/groove-web-mixer
 * copy, so the Lovable version is NOT ahead of local):
 *  - DualDeckWaveform.tsx: the spanning top card, stacked A-over-B halves,
 *    zoom controls top-left, DECK A / DECK B color labels top-right, and the
 *    "Load Track A to See Waveform" empty state.
 *  - StaticWaveformRenderer.tsx: the beatgrid look — deck-colored lines,
 *    downbeats solid + thick, off-beats dashed + thin, first-beat marker,
 *    bar numbers on downbeats — and the zoomed centered-window math.
 *  - ProfessionalWaveform.tsx: the per-deck header pattern (deck dot +
 *    label + BPM badge) and the on-waveform transport controls (play, CUE
 *    overlay, hotcue buttons) — here as a transport strip per row.
 *  - DetailedScrollingWaveform.tsx: band-colored scrolling waveform (bass /
 *    mid / high get different colors).
 *
 * Reconciled against Tim's screenshot (2026-10-24): the screenshot's top
 * card is groove's DualOverviewWaveform — verified identical in the Lovable
 * project 9d079ecf-4090-4d38-97b5-945d8cc7e96b (commit 974548c, read through
 * the Lovable connector) and the local copy. Its row content is a left
 * overlay with deck dot + label, SYNC/LEAD badge, title, BPM badge, play /
 * CUE buttons, and time readout. This view keeps that row CONTENT (plus a
 * track-info line: artist, file size, format, tempo stability) but NOT
 * groove's renderer: the previous commit's DualDeckWaveform /
 * ProfessionalWaveform patterns are superseded here. One coherent path per
 * element, never groove's duplicates: groove's rewrite era left ten
 * waveform components and ~3 audio engines in that project, and none of
 * that duplication is replicated here. Waveform rendering is this file's
 * single canvas renderer (band colors + beatgrid + fixed center playhead),
 * deck panels stay velz-dj's Deck.tsx, the mixer stays velz-dj's
 * Mixer.tsx, the AI panel stays AIDeck.tsx, and BPM detection stays
 * velz-dj's fixed detector (not groove's).
 *
 * What is NEW here (no groove version has it): the playhead is FIXED at the
 * center of each row while both waveforms scroll past it, driven by the
 * velz-dj engine's tempo-integrated position — so beat alignment between
 * the decks reads at a glance. The side waveforms in Deck.tsx are untouched.
 *
 * Performance (live-DJ requirement): the canvas loop is driven by refs,
 * not React state. The draw effect depends only on zoom/height; deck
 * props and peaks are read through refs, so App re-renders never tear
 * down and restart the loop, and nothing per-frame touches React state.
 * The time readout is an isolated component with its own 250 ms tick, so
 * it re-renders one span, not the row. Peak data is memoized. Scrubbing,
 * cueing, and the scrolling playhead therefore never jank on React churn.
 *
 * What was deliberately NOT ported: groove's sync/tempo logic (its sync was
 * not great either — velz-dj keeps its continuous-PLL sync), groove's audio
 * path (it has no EQ and no limiter at all — plain gains only — so there
 * is nothing better-sounding to take; velz-dj's 3-band EQ + DJ filter +
 * -3 dB / 20:1 master limiter stays), and groove's engine (velz-dj's
 * WSOLA time-stretch engine stays).
 *
 * Waveform colors (Rekordbox/Traktor style): velz-dj's Phase 4 BandPeaks
 * already carry per-bucket low/mid/high energies at 100 buckets/sec, so no
 * new analysis pass was invented. The dominant band per bucket picks the
 * color — low = #ff2d55, mid = #32d74b, high = #007aff (groove's vivid
 * dominant-band palette, adopted exactly) — IDENTICAL for every deck, so
 * A, B, and AI read the same way. The beatgrid draws ON TOP of the colors.
 * When a track has no band peaks yet (analysis still running or Traktor
 * import without peaks), the row falls back to the deck's accent color,
 * exactly like the side waveforms.
 *
 * Top-view design (2026-10-24, Tim's pick): groove's DualOverviewWaveform
 * look — a bright center playhead with diamond markers and a glow, and
 * the per-deck controls in a left overlay cluster over the waveform
 * (deck label + SYNC/LEAD badge, title, BPM badge, play / CUE / SYNC
 * buttons, time readout), instead of the header strip above the row.
 * Playhead recipe, groove's own: white line with shadowBlur 15 glow plus
 * a crisp core pass, and filled 10px diamonds at the row's top and bottom
 * ends (so the card reads top / middle-seam / bottom, as in groove).
 * The playhead stays fixed at exact center with the unclamped scrolling
 * math — diamonds and glow change only how it looks, never where it sits.
 * Groove's third left-cluster button is a SYNC toggle; velz-dj already
 * has that function (App toggleSync), so it is wired here for decks A/B
 * rather than invented. The AI row has no sync toggle, so its cluster
 * keeps play / CUE / Stop / Set cue.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import type { BandPeaks, BeatGrid } from '../types';
import { amplitudeRGB, bucketAmplitude } from '../audio/peaks';
import { barPhaseOf } from '../audio/loop';

export interface TopDeckView {
  label: string;
  deckId: 'deckA' | 'deckB' | 'deckC';
  color: string;
  title: string;
  buffer: AudioBuffer | null;
  grid: BeatGrid | null;
  peaks: BandPeaks | null;
  bpm: number;
  /** Groove DualOverviewWaveform logic: SYNC when the deck follows the
   *  master tempo, LEAD when it leads. Omitted for the AI row. */
  syncActive?: boolean;
  /** Track-card info (screenshot deck panels). Omitted for the AI row. */
  artist?: string;
  fileSize?: number;
  format?: string;
  /** Tempo stability 0..1, from the beat grid. */
  stability?: number;
  isPlaying: boolean;
  /** True while a quantized launch is queued for this deck (engine
   * pendingLaunchAt non-null). Shown as a QUEUED badge on the row so a DJ
   * watching the top view sees why the deck is silent. Omitted for the AI
   * row, whose drops do not use playQuantized. */
  queued?: boolean;
  onPlayPause: () => void;
  onCueDown: () => void;
  onCueUp: () => void;
  onStop: () => void;
  onSetCue: () => void;
  /** Sync toggle (groove's third left-cluster button). Decks A/B only;
   *  omitted for the AI row, which has no sync toggle. */
  onToggleSync?: () => void;
  onSeek: (t: number) => void;
  /** Traktor loop controls (decks A/B only; omitted for the AI row). */
  loopActive?: boolean;
  loopBars?: number | null;
  onLoopBars?: (bars: number) => void;
  onLoopExit?: () => void;
}

interface RowProps {
  deck: TopDeckView;
  pxPerSec: number;
  height: number;
}

/** Mono peaks fallback (same approach as Waveform.tsx). */
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

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Isolated time readout: its own 250 ms tick re-renders only this span,
 *  never the waveform row or its canvas loop. */
function TimeReadout({ deckId, duration, isPlaying }: { deckId: TopDeckView['deckId']; duration: number; isPlaying: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [isPlaying]);
  return (
    <span className="font-mono text-[11px] text-zinc-500">
      {fmtTime(engine.position(deckId))} / {fmtTime(duration)}
    </span>
  );
}

/** Compact Traktor loop control for a top-view row header: pick a size,
 *  set the loop, exit it (loop-out keeps playing from here). */
function LoopSizeControl({ deck }: { deck: TopDeckView }) {
  const [size, setSize] = useState(4);
  if (!deck.onLoopBars || !deck.onLoopExit) return null;
  return (
    <span className="flex items-center gap-1">
      <select
        value={size}
        disabled={!deck.buffer}
        onChange={(e) => setSize(Number(e.target.value))}
        title="Loop size in bars"
        className="h-7 rounded border border-zinc-700 bg-zinc-900 px-1 text-[11px] text-zinc-200 disabled:opacity-40"
      >
        {[0.5, 1, 2, 4, 8, 16, 32].map((b) => (
          <option key={b} value={b}>{b === 0.5 ? '1/2' : `${b}`} bar</option>
        ))}
      </select>
      <button
        onClick={() => deck.onLoopBars!(size)}
        disabled={!deck.buffer}
        title="Set a loop of the selected size from the current bar"
        className={`h-7 rounded px-2 text-[11px] font-bold disabled:opacity-40 ${
          deck.loopActive ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        }`}
      >
        ↻ Loop{deck.loopBars ? ` ${deck.loopBars === 0.5 ? '1/2' : deck.loopBars}` : ''}
      </button>
      {deck.loopActive && (
        <button
          onClick={deck.onLoopExit}
          title="Loop out: exit the loop and keep playing forward from here"
          className="h-7 rounded bg-sky-600 px-2 text-[11px] font-bold text-white hover:bg-sky-500"
        >
          Exit
        </button>
      )}
    </span>
  );
}

function TopWaveformRow({ deck, pxPerSec, height }: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  // Same CUE stray-release guard as Deck.tsx: cueUp only fires for a press
  // that started on this button (same pointerId). A release landing over
  // CUE after a press elsewhere is ignored instead of stopping the deck.
  const cuePointerId = useRef<number | null>(null);
  const cueDownOnButton = (e: React.PointerEvent) => {
    e.preventDefault();
    cuePointerId.current = e.pointerId;
    deck.onCueDown();
  };
  const cueUpIfPressed = (e: React.PointerEvent) => {
    if (cuePointerId.current === null || cuePointerId.current !== e.pointerId) return;
    cuePointerId.current = null;
    deck.onCueUp();
  };

  const mono = useMemo(
    () => (deck.buffer && !deck.peaks ? computePeaks(deck.buffer, Math.max(512, Math.floor(deck.buffer.duration * 40))) : null),
    [deck.buffer, deck.peaks],
  );

  // Performance: the draw loop reads deck props through refs, so its
  // effect depends only on zoom/height. App re-renders never tear down
  // and restart the canvas loop. (The loop is persistent: when a track
  // loads later, the next frame picks up the new canvas/buffer.)
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const monoRef = useRef(mono);
  monoRef.current = mono;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const deck = deckRef.current;
      const mono = monoRef.current;
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap || !deck.buffer) return;
      const w = wrap.clientWidth;
      const h = height;
      if (canvas.width !== w * 2) {
        canvas.width = w * 2;
        canvas.height = h * 2;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);

      const pos = engine.position(deck.deckId);
      const dur = deck.buffer.duration;
      const centerX = w / 2;
      // Fixed center playhead, groove ScrollingWaveformRenderer math:
      // the window is anchored on the playhead and NEVER clamped, so
      // t2x(pos) is identically centerX at every position. Negative
      // viewStart is allowed (lead-in display): at t=0 the track start
      // sits exactly on the center line with empty space to its left,
      // and at the end the track end sits on the line with empty space
      // to its right. The previous code clamped viewStart into
      // [0, dur - w/pxPerSec], which dragged the audio position off the
      // center line at both edges (at t=0 the position read at the left
      // edge) — that clamp was the playback bug. Note groove itself has
      // both patterns: DetailedScrollingWaveform clamps like the old
      // code did, but ScrollingWaveformRenderer — the one that scrolls
      // correctly — explicitly allows negative startTime, and that is
      // the math ported here.
      const viewStart = pos - centerX / pxPerSec;
      const viewEnd = viewStart + w / pxPerSec;
      const t2x = (t: number) => (t - viewStart) * pxPerSec;

      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, w, h);

      const midY = h / 2;
      const halfH = h / 2 - 6;

      // Waveform — groove ScrollingWaveformRenderer method: color varies
      // with playback amplitude (quiet deep blue → cyan → green/yellow
      // → loud orange/red), each bar with a vertical gradient (lighter
      // top, base middle, darker bottom) and played/unplayed alpha
      // (0.95 / 0.65). The previous dominant-band coloring read almost
      // entirely green because the analysis "mid" band is effectively
      // the full unfiltered signal (peaking filter, gain 0dB), so it
      // won the max-band pick on nearly every bucket. The black
      // unplayed dim overlay is gone — per-bar alpha does that job now,
      // so upcoming colors stay visible instead of dulled. Bar height
      // is groove's sqrt(amplitude) scaling, symmetric around midY.
      if (deck.peaks) {
        const rate = deck.peaks.rate;
        const b0 = Math.max(0, Math.floor(viewStart * rate));
        const b1 = Math.min(deck.peaks.min.length - 1, Math.ceil(viewEnd * rate));
        const bw = Math.max(1, pxPerSec / rate);
        const maxBar = h * 0.85;
        ctx.globalAlpha = 1;
        for (let b = b0; b <= b1; b++) {
          const amp = bucketAmplitude(deck.peaks, b);
          if (amp < 0.005) continue;
          const barH = Math.max(4, Math.sqrt(Math.min(1, amp)) * maxBar);
          const x = t2x(b / rate);
          const alpha = b / rate <= pos ? 0.95 : 0.65;
          const [r, g, bl] = amplitudeRGB(deck.peaks, b);
          const grad = ctx.createLinearGradient(0, midY - barH / 2, 0, midY + barH / 2);
          grad.addColorStop(0, `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, bl + 40)}, ${alpha})`);
          grad.addColorStop(0.3, `rgba(${r}, ${g}, ${bl}, ${alpha})`);
          grad.addColorStop(0.7, `rgba(${r}, ${g}, ${bl}, ${alpha})`);
          grad.addColorStop(1, `rgba(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, bl - 30)}, ${alpha})`);
          ctx.fillStyle = grad;
          ctx.fillRect(x, midY - barH / 2, bw, barH);
        }
      } else if (mono) {
        ctx.fillStyle = deck.color;
        const bucketDur = dur / mono.length;
        const x0 = Math.max(0, Math.floor(viewStart / bucketDur));
        const x1 = Math.min(mono.length - 1, Math.ceil(viewEnd / bucketDur));
        for (let b = x0; b <= x1; b++) {
          const x = t2x(b * bucketDur);
          const bw = Math.max(1, bucketDur * pxPerSec);
          const amp = mono[b] * halfH;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x, midY - amp, bw, Math.max(1, amp * 2));
        }
        ctx.globalAlpha = 1;
      }

      // Beatgrid overlay, groove style: deck-colored lines drawn OVER the
      // colors — downbeats solid + thick, off-beats dashed + thin, with a
      // bar number on each downbeat and a marker on the first beat.
      const grid = deck.grid;
      if (grid && grid.bpm > 0) {
        ctx.font = '9px monospace';
        const drawBeat = (t: number, idx: number, isDown: boolean, barNo: number) => {
          const x = t2x(t);
          if (x < 0 || x > w) return;
          const isFirst = idx === 0;
          ctx.strokeStyle = deck.color;
          ctx.globalAlpha = isDown ? 0.9 : 0.45;
          ctx.lineWidth = isDown ? 2 : 1;
          ctx.setLineDash(isDown ? [] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, h * 0.05);
          ctx.lineTo(x, h * 0.95);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          if (isDown) {
            ctx.fillStyle = deck.color;
            ctx.globalAlpha = 0.85;
            ctx.fillText(`${barNo}`, x + 3, 11);
            ctx.globalAlpha = 1;
          }
          if (isFirst) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - 1, 0, 2, h);
          }
        };
        if (grid.beats.length > 0) {
          let lo = 0, hi = grid.beats.length - 1, first = grid.beats.length;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (grid.beats[mid] >= viewStart) { first = mid; hi = mid - 1; }
            else lo = mid + 1;
          }
          // Map branch: downbeats are indices ≡ barPhase (mod 4).
          const phase = barPhaseOf(grid);
          for (let i = first; i < grid.beats.length && grid.beats[i] <= viewEnd; i++) {
            const isDown = (((i - phase) % 4) + 4) % 4 === 0;
            drawBeat(grid.beats[i], i, isDown, Math.max(1, Math.floor((i - phase) / 4) + 1));
          }
        } else {
          // Flat branch: beat 0 IS the downbeat (times step from downbeatOffset).
          const spb = 60 / grid.bpm;
          const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat;
          const firstIdx = Math.max(0, Math.ceil((viewStart - off) / spb));
          const lastIdx = Math.floor((viewEnd - off) / spb);
          for (let i = firstIdx; i <= lastIdx; i++) drawBeat(off + i * spb, i, i % 4 === 0, Math.floor(i / 4) + 1);
        }
      }

      // Fixed center playhead — groove DualOverviewWaveform look: bright
      // white line with a glow pass plus a crisp core pass, and filled
      // diamonds at the row's top and bottom ends (across the stacked
      // rows this reads top / middle-seam / bottom, as in groove). Drawn
      // last, always on top. The diamonds and glow change only how the
      // line looks: centerX is still exactly the audio position at every
      // point in the track, per the unclamped math above.
      const drawDiamond = (cy: number) => {
        const s = 10;
        ctx.beginPath();
        ctx.moveTo(centerX, cy - s);
        ctx.lineTo(centerX + s, cy);
        ctx.lineTo(centerX, cy + s);
        ctx.lineTo(centerX - s, cy);
        ctx.closePath();
        ctx.fill();
      };
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 15;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(centerX, 10);
      ctx.lineTo(centerX, h - 10);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(centerX, 10);
      ctx.lineTo(centerX, h - 10);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      drawDiamond(20);
      drawDiamond(h - 20);
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pxPerSec, height]);

  const seekFromEvent = (e: React.PointerEvent) => {
    if (!deck.buffer || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pos = engine.position(deck.deckId);
    // Same unclamped window as the draw loop: clicking the center line
    // seeks to the current position at every point in the track,
    // including the first/last seconds. The result is clamped to the
    // track bounds below, never the window.
    const viewStart = pos - rect.width / 2 / pxPerSec;
    deck.onSeek(Math.max(0, Math.min(deck.buffer.duration, viewStart + x / pxPerSec)));
  };

  return (
    <div className="relative">
      {/* Scrolling waveform, center playhead. The wrapper spans the full
          row width, so the canvas center (and the playhead) never move
          when the overlay below is added. */}
      <div
        ref={wrapRef}
        className="relative cursor-pointer overflow-hidden rounded border border-zinc-800"
        style={{ height }}
        onPointerDown={(e) => {
          dragRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFromEvent(e);
        }}
        onPointerMove={(e) => { if (dragRef.current) seekFromEvent(e); }}
        onPointerUp={() => { dragRef.current = false; }}
        onPointerCancel={() => { dragRef.current = false; }}
      >
        {deck.buffer ? (
          <canvas ref={canvasRef} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
            Load Track {deck.label} to See Waveform
          </div>
        )}
      </div>
      {/* Left control cluster — groove DualOverviewWaveform overlay: a
          dark gradient panel over the waveform's left end, controls
          stacked vertically (label + badge, title, BPM, buttons, time).
          The panel itself ignores pointer events so clicks on its faded
          area still seek the waveform; only the inner content captures
          clicks, so the buttons never trigger a seek. Every control from
          the old header strip lives here — nothing was removed, only
          moved into groove's arrangement. */}
      <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-80 bg-gradient-to-r from-black/90 via-black/70 to-transparent">
        <div className="pointer-events-auto flex h-full flex-col justify-center gap-0.5 p-2">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full" style={{ background: deck.color }} />
            <span className="text-xs font-bold text-zinc-100">DECK {deck.label}</span>
            {deck.syncActive !== undefined && (
              <span className={`rounded px-1.5 py-px text-[10px] font-bold ${deck.syncActive ? 'bg-cyan-500/20 text-cyan-300' : 'bg-orange-500/20 text-orange-300'}`}>
                {deck.syncActive ? 'SYNC' : 'LEAD'}
              </span>
            )}
            {deck.bpm > 0 && (
              <span className="rounded border border-zinc-700 px-1.5 py-px font-mono text-[10px] text-zinc-300">
                {deck.bpm.toFixed(1)} BPM
              </span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-300" title={deck.title}>
            {deck.title}
            {deck.artist !== undefined && (
              <span className="text-zinc-500">
                {' · '}
                {deck.artist.trim() ? deck.artist : 'Unknown Artist'}
                {deck.fileSize !== undefined && ` · ${fmtSize(deck.fileSize)}`}
                {deck.format && ` · ${deck.format}`}
                {deck.stability !== undefined && ` · STABILITY: ${Math.round(deck.stability * 100)}%`}
              </span>
            )}
          </div>
          {deck.queued && (
            <div className="font-mono text-[10px] text-amber-300">▸ QUEUED — drops on the bar</div>
          )}
          <div className="flex items-center gap-1.5">
            <LoopSizeControl deck={deck} />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={deck.onPlayPause}
              disabled={!deck.buffer}
              className="h-7 rounded bg-zinc-800/90 px-2 text-xs font-bold text-zinc-100 hover:bg-zinc-700 disabled:opacity-40"
            >
              {deck.isPlaying ? '❚❚' : '▶'}
            </button>
            <button
              onPointerDown={cueDownOnButton}
              onPointerUp={cueUpIfPressed}
              onPointerLeave={cueUpIfPressed}
              onPointerCancel={cueUpIfPressed}
              disabled={!deck.buffer}
              className="h-7 rounded bg-orange-900/60 px-2.5 text-xs font-bold text-orange-300 hover:bg-orange-800 disabled:opacity-40"
            >
              CUE
            </button>
            {deck.onToggleSync && (
              <button
                onClick={deck.onToggleSync}
                disabled={!deck.buffer}
                className={`h-7 rounded px-2 text-xs font-bold disabled:opacity-40 ${deck.syncActive ? 'bg-cyan-900/60 text-cyan-300 hover:bg-cyan-800' : 'bg-zinc-800/90 text-zinc-400 hover:bg-zinc-700'}`}
                title={deck.syncActive ? 'Sync on — click to turn off' : 'Sync off — click to follow the master tempo'}
              >
                SYNC
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={deck.onStop}
              disabled={!deck.buffer}
              className="h-6 rounded bg-zinc-800/90 px-2 text-[11px] font-bold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              ■ Stop
            </button>
            <button
              onClick={deck.onSetCue}
              disabled={!deck.buffer}
              className="h-6 rounded bg-zinc-800/90 px-2 text-[11px] text-zinc-400 hover:bg-zinc-700 disabled:opacity-40"
              title="Set cue point to current position"
            >
              Set cue
            </button>
          </div>
          <TimeReadout deckId={deck.deckId} duration={deck.buffer?.duration ?? 0} isPlaying={deck.isPlaying} />
        </div>
      </div>
    </div>
  );
}

export default function CenterPlayheadView({ decks, ai }: { decks: [TopDeckView, TopDeckView]; ai: TopDeckView | null }) {
  const [zoom, setZoom] = useState(60); // px per second, shared across rows
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="px-3 pt-3">
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black">
        {/* Spanning header (groove DualDeckWaveform pattern) */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5">
          <span className="flex gap-1">
            <button
              onClick={() => setZoom((z) => Math.max(15, z / 1.5))}
              className="h-7 w-7 rounded border border-zinc-700 bg-black/80 text-sm text-zinc-300 hover:bg-zinc-800"
              title="Zoom out"
            >
              −
            </button>
            <button
              onClick={() => setZoom(60)}
              className="h-7 rounded border border-zinc-700 bg-black/80 px-2 text-[11px] text-zinc-300 hover:bg-zinc-800"
              title="Reset zoom"
            >
              1×
            </button>
            <button
              onClick={() => setZoom((z) => Math.min(240, z * 1.5))}
              className="h-7 w-7 rounded border border-zinc-700 bg-black/80 text-sm text-zinc-300 hover:bg-zinc-800"
              title="Zoom in"
            >
              +
            </button>
          </span>
          <span className="text-xs font-bold tracking-wide text-zinc-400">SYNC VIEW — both decks past the center playhead</span>
          <span className="ml-auto flex items-center gap-2">
            {decks.map((d) => (
              <span key={d.deckId} className="rounded bg-black/80 px-2 py-1 text-[11px] font-bold" style={{ color: d.color }}>
                DECK {d.label}
              </span>
            ))}
            {ai && (
              <span className="rounded bg-black/80 px-2 py-1 text-[11px] font-bold" style={{ color: ai.color }}>
                AI
              </span>
            )}
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          </span>
        </div>
        {!collapsed && (
          <div className="space-y-1 p-1">
            <TopWaveformRow deck={decks[0]} pxPerSec={zoom} height={140} />
            <div className="border-t border-zinc-800" />
            <TopWaveformRow deck={decks[1]} pxPerSec={zoom} height={140} />
            {ai && (
              <>
                <div className="border-t border-zinc-800" />
                <TopWaveformRow deck={ai} pxPerSec={zoom} height={112} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

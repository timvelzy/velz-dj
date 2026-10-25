// ─── AI DJ autopilot panel ────────────────────────────────────────────────
// Compact status strip + queue editor. Presentational only — the driving
// state machine lives in App.tsx. Rendered below the header whenever the
// panel is open; the status line is always visible while autopilot is on.

import { useState } from 'react';
import type { TrackInfo } from '../types';
import type { PlaylistRecord } from '../audio/playlistStore';

export type ApPhase = 'idle' | 'waiting' | 'preparing' | 'scheduled' | 'crossfading' | 'fallback' | 'generating';

export interface ApStatus {
  on: boolean;
  phase: ApPhase;
  playingKey: 'A' | 'B' | null;
  nextTitle: string | null;
  /** Whole bars until the blend starts (waiting phase only). */
  barsToGo: number | null;
  /** Blend progress 0..1 (crossfading phase only). */
  blendProgress: number | null;
  /** Bass handover state during a blend: cut on the incoming side, swapped. */
  bass: 'cut' | 'swapped' | null;
  note: string | null;
}

export const AP_OFF_STATUS: ApStatus = {
  on: false,
  phase: 'idle',
  playingKey: null,
  nextTitle: null,
  barsToGo: null,
  blendProgress: null,
  bass: null,
  note: null,
};

interface AutoPilotProps {
  status: ApStatus;
  queue: TrackInfo[];
  library: TrackInfo[];
  outroBars: number;
  onToggle: () => void;
  onOutroBars: (n: number) => void;
  onQueueAdd: (id: string) => void;
  onQueueRemove: (id: string) => void;
  onQueueMove: (id: string, dir: -1 | 1) => void;
  onQueueClear: () => void;
  /** Saved playlists (IndexedDB — survive reload). */
  playlists: PlaylistRecord[];
  onPlaylistSave: (name: string) => void;
  onPlaylistLoad: (id: string) => void;
  onPlaylistDelete: (id: string) => void;
  onPlaylistRename: (id: string, name: string) => void;
  /** Name of the playlist currently feeding the queue, if any. */
  loadedPlaylistName: string | null;
  /** Note about the last playlist load (e.g. missing tracks skipped). */
  playlistNote: string | null;
  loopPlaylist: boolean;
  onLoopPlaylist: (v: boolean) => void;
}

const PHASE_LABEL: Record<ApPhase, string> = {
  idle: 'Idle — start a track and autopilot takes it from there',
  waiting: 'Watching the playing deck',
  preparing: 'Loading next track',
  scheduled: 'Blend scheduled on the audio clock',
  crossfading: 'Blending into the next track',
  fallback: 'No next track — looping the outro',
  generating: 'Generating next with AI…',
};

export default function AutoPilot(p: AutoPilotProps) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [addId, setAddId] = useState('');
  const [plName, setPlName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const s = p.status;
  const addable = p.library.filter((t) => t.file && !p.queue.some((q) => q.id === t.id));

  return (
    <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={p.onToggle}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-black tracking-wide ${
            s.on ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
          }`}
          title={
            s.on
              ? 'Take back manual control NOW — decks, crossfader and EQ stay exactly where they are'
              : 'AI DJ autopilot — mixes the next track in automatically while you step away'
          }
        >
          <span className={`h-2 w-2 rounded-full ${s.on ? 'animate-pulse bg-white' : 'bg-emerald-500'}`} />
          {s.on ? '🤖 AUTOPILOT ON' : '🤖 AUTOPILOT'}
        </button>
        {s.on && (
          <span className="text-xs text-zinc-300">
            <span className="font-bold text-emerald-300">{PHASE_LABEL[s.phase]}</span>
            {s.playingKey && <span className="text-zinc-500"> · on Deck {s.playingKey}</span>}
            {s.nextTitle && <span> · next: <span className="font-bold text-zinc-100">{s.nextTitle}</span></span>}
            {s.barsToGo !== null && s.phase === 'waiting' && (
              <span className="text-zinc-500"> · blend in {s.barsToGo} bar{s.barsToGo === 1 ? '' : 's'}</span>
            )}
            {s.blendProgress !== null && s.phase === 'crossfading' && (
              <span className="text-zinc-500"> · {Math.round(s.blendProgress * 100)}% blended</span>
            )}
            {s.bass && s.phase === 'crossfading' && (
              <span className="text-zinc-500"> · bass: {s.bass === 'swapped' ? 'swapped to incoming ✓' : 'incoming cut (one bass at a time)'}</span>
            )}
          </span>
        )}
        {s.note && <span className="text-xs text-amber-300">{s.note}</span>}
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
          <label className="flex items-center gap-1" title="How many bars before the track end the blend starts">
            Outro
            <input
              type="number"
              min={2}
              max={32}
              value={p.outroBars}
              onChange={(e) => p.onOutroBars(Math.min(32, Math.max(2, Number(e.target.value) || 8)))}
              className="w-12 rounded bg-zinc-800 px-1 py-0.5 text-center text-zinc-100"
            />
            bars
          </label>
          <button
            onClick={() => setQueueOpen((o) => !o)}
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700"
            title="Queue: tracks autopilot plays first, in order"
          >
            Queue ({p.queue.length}) {queueOpen ? '▴' : '▾'}
          </button>
        </span>
      </div>
      {queueOpen && (
        <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2">
          <div className="mb-2 flex items-center gap-2">
            <select
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
              className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
            >
              <option value="">Add a track from the library…</option>
              {addable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}{t.artist ? ` — ${t.artist}` : ''} ({t.bpm ? `${Math.round(t.bpm)} BPM` : '?'}{t.key ? ` · ${t.key}` : ''})
                </option>
              ))}
            </select>
            <button
              disabled={!addId}
              onClick={() => { p.onQueueAdd(addId); setAddId(''); }}
              className="rounded bg-sky-700 px-2 py-1 text-xs font-bold text-white hover:bg-sky-600 disabled:opacity-40"
            >
              + Queue
            </button>
            {p.queue.length > 0 && (
              <button
                onClick={p.onQueueClear}
                className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
              >
                Clear
              </button>
            )}
          </div>
          {p.queue.length === 0 ? (
            <p className="text-xs text-zinc-500">
              Queue is empty — autopilot auto-picks from your library by BPM + key compatibility.
              Add tracks here to decide the running order yourself.
            </p>
          ) : (
            <ol className="space-y-1">
              {p.queue.map((t, i) => (
                <li key={t.id} className="flex items-center gap-2 rounded bg-zinc-800/60 px-2 py-1 text-xs">
                  <span className="w-5 shrink-0 font-bold text-zinc-500">{i === 0 ? '▶' : `${i + 1}.`}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-200">
                    {t.title}{t.artist ? <span className="text-zinc-500"> — {t.artist}</span> : ''}
                  </span>
                  <span className="shrink-0 text-zinc-500">{t.bpm ? `${Math.round(t.bpm)} BPM` : ''}{t.key ? ` · ${t.key}` : ''}</span>
                  <button onClick={() => p.onQueueMove(t.id, -1)} disabled={i === 0} className="rounded px-1 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30" title="Move up">↑</button>
                  <button onClick={() => p.onQueueMove(t.id, 1)} disabled={i === p.queue.length - 1} className="rounded px-1 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30" title="Move down">↓</button>
                  <button onClick={() => p.onQueueRemove(t.id)} className="rounded px-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-300" title="Remove from queue">✕</button>
                </li>
              ))}
            </ol>
          )}
          {/* Saved playlists — durable across reloads (IndexedDB). Loading
              one REPLACES the queue; after it plays in order, autopilot
              falls through to library auto-pick so the music never stops
              (or loops the playlist when the loop box is ticked). */}
          <div className="mt-3 border-t border-zinc-800 pt-2">
            <p className="mb-2 text-xs font-bold text-zinc-300">
              Playlists
              {p.loadedPlaylistName && <span className="font-normal text-emerald-300"> · loaded: {p.loadedPlaylistName}</span>}
            </p>
            {p.playlistNote && <p className="mb-2 text-xs text-amber-300">{p.playlistNote}</p>}
            <div className="mb-2 flex items-center gap-2">
              <input
                value={plName}
                onChange={(e) => setPlName(e.target.value)}
                placeholder="Playlist name…"
                className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
              />
              <button
                disabled={p.queue.length === 0 || !plName.trim()}
                onClick={() => { p.onPlaylistSave(plName.trim()); setPlName(''); }}
                className="rounded bg-sky-700 px-2 py-1 text-xs font-bold text-white hover:bg-sky-600 disabled:opacity-40"
                title="Save the current queue as a named playlist (same name replaces that playlist)"
              >
                Save queue
              </button>
            </div>
            <label className="mb-2 flex items-center gap-2 text-xs text-zinc-400" title="When the loaded playlist runs out, restart it from the top instead of falling through to auto-pick">
              <input
                type="checkbox"
                checked={p.loopPlaylist}
                disabled={!p.loadedPlaylistName}
                onChange={(e) => p.onLoopPlaylist(e.target.checked)}
              />
              Loop loaded playlist
              {!p.loadedPlaylistName && <span className="text-zinc-600">(load a playlist first)</span>}
            </label>
            {p.playlists.length === 0 ? (
              <p className="text-xs text-zinc-500">No saved playlists yet — build a queue above and save it.</p>
            ) : (
              <ul className="space-y-1">
                {p.playlists.map((pl) => (
                  <li key={pl.id} className="flex items-center gap-2 rounded bg-zinc-800/60 px-2 py-1 text-xs">
                    {renamingId === pl.id ? (
                      <>
                        <input
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-0.5 text-zinc-100"
                        />
                        <button
                          disabled={!renameText.trim()}
                          onClick={() => { p.onPlaylistRename(pl.id, renameText.trim()); setRenamingId(null); }}
                          className="rounded bg-sky-700 px-1 py-0.5 font-bold text-white hover:bg-sky-600 disabled:opacity-40"
                        >
                          Save
                        </button>
                        <button onClick={() => setRenamingId(null)} className="rounded px-1 text-zinc-400 hover:bg-zinc-700">Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-zinc-200">
                          {pl.name}
                          <span className="text-zinc-500"> · {pl.fileKeys.length} track{pl.fileKeys.length === 1 ? '' : 's'}</span>
                        </span>
                        <button
                          onClick={() => p.onPlaylistLoad(pl.id)}
                          className="rounded bg-emerald-700 px-2 py-0.5 font-bold text-white hover:bg-emerald-600"
                          title="Load into the autopilot queue (replaces the current queue)"
                        >
                          Load
                        </button>
                        <button
                          onClick={() => { setRenamingId(pl.id); setRenameText(pl.name); }}
                          className="rounded px-1 text-zinc-400 hover:bg-zinc-700"
                          title="Rename playlist"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => p.onPlaylistDelete(pl.id)}
                          className="rounded px-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-300"
                          title="Delete playlist"
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useRef, useState } from 'react';
import type { TrackInfo } from '../types';
import { matchTracklist, type MatchResult } from '../audio/spotifyMatch';

interface LibraryProps {
  tracks: TrackInfo[];
  onAddFiles: (files: FileList) => void;
  onLoadToDeck: (trackId: string, deck: 'A' | 'B') => void;
}

export default function Library({ tracks, onAddFiles, onLoadToDeck }: LibraryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState('');
  const [matches, setMatches] = useState<MatchResult[] | null>(null);

  const fmtDur = (d: number) => {
    const m = Math.floor(d / 60);
    const s = Math.floor(d % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">Track Library</span>
        <button
          onClick={() => inputRef.current?.click()}
          className="rounded bg-sky-700 px-3 py-1 text-xs font-bold text-white hover:bg-sky-600"
        >
          + Add audio
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) onAddFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {tracks.length === 0 ? (
        <div
          className="rounded-lg border-2 border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) onAddFiles(e.dataTransfer.files); }}
        >
          Drop audio files here, or click “+ Add audio”.<br />
          <span className="text-xs text-zinc-600">Every track is analyzed on load — BPM, beat grid, downbeat and key. Nothing is ever hardcoded.</span>
        </div>
      ) : (
        <div
          className="max-h-64 overflow-y-auto"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) onAddFiles(e.dataTransfer.files); }}
        >
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-zinc-950 text-[11px] uppercase text-zinc-500">
              <tr>
                <th className="px-2 py-1">Title</th>
                <th className="px-2 py-1">Artist</th>
                <th className="px-2 py-1">BPM</th>
                <th className="px-2 py-1">Key</th>
                <th className="px-2 py-1">Length</th>
                <th className="px-2 py-1 text-right">Load</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <tr
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/track-id', t.id)}
                  className="cursor-grab border-t border-zinc-900 hover:bg-zinc-900"
                  title="Drag onto a deck"
                >
                  <td className="px-2 py-1.5 font-medium text-zinc-200">{t.title}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{t.artist || '—'}</td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300">
                    {t.analyzing ? (
                      <span className="text-sky-400">…{Math.round((t.analysisProgress ?? 0) * 100)}%</span>
                    ) : t.beatGrid ? (
                      <span className={t.beatGrid.confidence < 0.4 ? 'text-amber-400' : ''}>
                        {t.beatGrid.bpm.toFixed(1)}
                        {t.beatGrid.method === 'traktor' && (
                          <span className="ml-1 rounded bg-emerald-900 px-1 text-[9px] font-bold text-emerald-300" title="Traktor beat grid">
                            T
                          </span>
                        )}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-amber-300">{t.key || '—'}</td>
                  <td className="px-2 py-1.5 font-mono text-zinc-500">{fmtDur(t.duration)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      onClick={() => onLoadToDeck(t.id, 'A')}
                      className="mr-1 rounded bg-sky-800 px-2 py-0.5 text-xs font-bold text-white hover:bg-sky-700"
                    >
                      A
                    </button>
                    <button
                      onClick={() => onLoadToDeck(t.id, 'B')}
                      className="rounded bg-orange-800 px-2 py-0.5 text-xs font-bold text-white hover:bg-orange-700"
                    >
                      B
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1 text-[11px] text-zinc-600">
        Tip: drag a row onto Deck A or B. Amber BPM = low analysis confidence — open “Edit beat grid” on the deck.
      </div>

      {/* Spotify playlist matching — metadata only. Spotify audio can't
          feed the decks (encrypted stream, no raw audio, terms), but a
          pasted playlist tells you what you already own locally. */}
      <details className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
        <summary className="cursor-pointer text-xs font-bold text-zinc-400">
          🎧 Match a Spotify playlist against this library (metadata only)
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'Paste playlist tracks, one per line:\nArtist - Title\nTitle – Artist'}
            className="h-24 w-full rounded bg-zinc-900 p-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMatches(matchTracklist(pasteText, tracks))}
              disabled={!pasteText.trim() || tracks.length === 0}
              className="rounded bg-emerald-700 px-3 py-1 text-xs font-bold text-white disabled:opacity-40 hover:bg-emerald-600"
            >
              Match {tracks.length} local tracks
            </button>
            {matches && (
              <span className="text-xs text-zinc-400">
                {matches.filter((m) => m.status === 'matched').length} matched ·{' '}
                {matches.filter((m) => m.status === 'missing').length} not in library
              </span>
            )}
          </div>
          {matches && (
            <ul className="max-h-40 overflow-y-auto text-xs">
              {matches.map((m, i) => (
                <li key={i} className="flex gap-2 border-t border-zinc-900 py-1">
                  <span>{m.status === 'matched' ? '✅' : '❌'}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300" title={m.line}>{m.line}</span>
                  {m.status === 'matched' ? (
                    <span className="truncate text-emerald-400" title={m.track!.title}>
                      → {m.track!.artist ? `${m.track!.artist} — ` : ''}{m.track!.title}
                    </span>
                  ) : (
                    <span className="text-zinc-600">not owned locally</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

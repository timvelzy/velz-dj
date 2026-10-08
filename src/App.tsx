import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine } from './audio/engine';
import { analyzeTrack } from './audio/analysis';
import { detectKey } from './audio/keydetect';
import {
  parseNml,
  findTraktorTrack,
  refineTraktorGrid,
  type TraktorCollection,
} from './audio/traktor';
import {
  saveTraktorCollection,
  loadTraktorCollection,
  clearTraktorCollection,
} from './audio/traktorStore';
import { DemoSynthBackend, LoopQueue, type GeneratedLoop } from './audio/ai';
import type { TrackInfo } from './types';
import Deck, { type DeckState } from './components/Deck';
import Mixer, { defaultChannel, type ChannelState } from './components/Mixer';
import AIDeck from './components/AIDeck';
import Library from './components/Library';
import GridEditorModal from './components/GridEditorModal';
import MidiPanel from './components/MidiPanel';

const deckInit = (): DeckState => ({
  track: null,
  buffer: null,
  analyzing: false,
  analysisProgress: 0,
  tempo: 1,
  keyLock: true,
  syncActive: false,
  hotcues: [null, null, null, null],
  loop: null,
  pendingLoopIn: null,
  cuePoint: 0,
});

let trackSeq = 0;

export default function App() {
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deckA, setDeckA] = useState<DeckState>(deckInit);
  const [deckB, setDeckB] = useState<DeckState>(deckInit);
  const [chA, setChA] = useState<ChannelState>(defaultChannel);
  const [chB, setChB] = useState<ChannelState>(defaultChannel);
  const [chC, setChC] = useState<ChannelState>(defaultChannel);
  const [crossfader, setCrossfader] = useState(0);
  const [masterVol, setMasterVol] = useState(0.8);
  const [cueMix, setCueMix] = useState(0.5);
  const [phonesLevel, setPhonesLevel] = useState(0.8);
  const [masterDeck, setMasterDeck] = useState<'deckA' | 'deckB' | null>(null);
  const [masterBpm, setMasterBpm] = useState(0);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [editingGrid, setEditingGrid] = useState<'A' | 'B' | null>(null);
  const [midiOpen, setMidiOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [aiLoop, setAiLoop] = useState<GeneratedLoop | null>(null);
  const [aiBuffer, setAiBuffer] = useState<AudioBuffer | null>(null);
  const [aiPlaying, setAiPlaying] = useState(false);
  // Traktor collection.nml — source of truth for beat grids when imported.
  // Persisted in IndexedDB so the import survives reloads (import once).
  const [traktor, setTraktor] = useState<TraktorCollection | null>(null);
  const [traktorFileName, setTraktorFileName] = useState('');
  const [traktorSavedAt, setTraktorSavedAt] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nmlInputRef = useRef<HTMLInputElement>(null);

  // Restore a previously imported Traktor collection on startup
  useEffect(() => {
    let cancelled = false;
    loadTraktorCollection()
      .then((loaded) => {
        if (loaded && !cancelled) {
          setTraktor(loaded.collection);
          setTraktorFileName(loaded.fileName);
          setTraktorSavedAt(loaded.savedAt);
        }
      })
      .catch((e) => console.warn('Traktor collection restore failed', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const queue = useMemo(() => new LoopQueue(new DemoSynthBackend()), []);
  const deckState = useCallback((k: 'A' | 'B') => (k === 'A' ? deckA : deckB), [deckA, deckB]);
  const setDeckState = useCallback((k: 'A' | 'B', s: DeckState) => {
    (k === 'A' ? setDeckA : setDeckB)(s);
  }, []);

  const start = async () => {
    setStarting(true);
    try {
      await engine.init();
      await engine.resume();
      engine.setCrossfader(0);
      setDevices(await engine.listOutputs());
      setReady(true);
    } finally {
      setStarting(false);
    }
  };

  // Master clock ticker (UI only)
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      setMasterBpm(engine.masterEffectiveBpm());
      setAiPlaying(engine.isPlaying('deckC'));
    }, 250);
    return () => window.clearInterval(id);
  }, [ready]);

  useEffect(() => {
    engine.setMaster(masterDeck);
  }, [masterDeck]);

  // ─── Traktor collection.nml import ────────────────────────────────────
  const importNml = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const collection = parseNml(text);
      setTraktor(collection);
      setTraktorFileName(file.name);
      const savedAt = new Date().toISOString();
      setTraktorSavedAt(savedAt);
      // Persist so this survives reloads — import once
      try {
        await saveTraktorCollection(collection, file.name);
      } catch (e) {
        console.warn('Could not persist Traktor collection (session-only)', e);
      }
      const withGrids = collection.tracks.filter((t) => t.grid.beats.length > 0).length;
      alert(
        `Imported ${collection.tracks.length} tracks from ${file.name} — ${withGrids} with beat grids.\n` +
        'Matching tracks now load with your Traktor grids + hotcues, no re-analysis.\n' +
        'Saved in this browser — you won’t need to import again.',
      );
    } catch (e) {
      console.error('NML import failed', e);
      alert(`Could not parse ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  const forgetTraktor = useCallback(async () => {
    if (!window.confirm('Forget the imported Traktor collection? Matching tracks will fall back to analysis.')) return;
    try {
      await clearTraktorCollection();
    } catch (e) {
      console.warn('Could not clear stored Traktor collection', e);
    }
    setTraktor(null);
    setTraktorFileName('');
    setTraktorSavedAt('');
  }, []);

  // ─── Track loading + analysis (ALWAYS runs — never hardcoded BPM) ─────────
  // Traktor is the source of truth: a matching collection entry loads its
  // hand-fixed grid + hotcues with zero re-analysis. Our analyzer is the
  // fallback for tracks Traktor doesn't know.
  const loadTrack = useCallback(async (deckKey: 'A' | 'B', file: File) => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const d = engine.decks.get(deckId);
    if (!d) return;
    engine.pause(deckId);
    setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: 0 });

    try {
      const raw = await file.arrayBuffer();
      const buffer = await engine.ctx.decodeAudioData(raw);
      const traktorTrack = traktor ? findTraktorTrack(traktor, file) : undefined;

      let track: TrackInfo;
      let hotcues: (number | null)[] = [null, null, null, null];
      if (traktorTrack) {
        // Traktor wins — no analysis at all
        const grid = refineTraktorGrid(traktorTrack, buffer.duration);
        const keyRes = detectKey(buffer);
        track = {
          id: `t${++trackSeq}`,
          title: traktorTrack.title || file.name.replace(/\.[^.]+$/, ''),
          artist: traktorTrack.artist,
          duration: buffer.duration,
          bpm: grid.bpm,
          key: keyRes.key,
          beatGrid: grid,
          file,
        };
        for (const hc of traktorTrack.hotcues) {
          if (hc.slot < 4) hotcues[hc.slot] = hc.position;
        }
      } else {
        const { grid, spectralData } = await analyzeTrack(buffer, (p) =>
          setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: p * 0.85 }),
        );
        const keyRes = detectKey(buffer);
        track = {
          id: `t${++trackSeq}`,
          title: file.name.replace(/\.[^.]+$/, ''),
          artist: '',
          duration: buffer.duration,
          bpm: grid.bpm,
          key: keyRes.key,
          beatGrid: grid,
          spectralData,
          file,
        };
      }
      d.buffer = buffer;
      d.grid = track.beatGrid;
      d.userTempo = 1;
      d.syncBaseTempo = 1;
      d.syncCorr = 1;
      d.nudge = 0;
      setTracks((ts) => [...ts.filter((t) => t.id !== track.id), track]);
      setDeckState(deckKey, { ...deckInit(), track, buffer, hotcues });
    } catch (e) {
      console.error('Load failed', e);
      setDeckState(deckKey, deckInit());
      alert(`Could not load ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }, [setDeckState, traktor]);

  const loadLibraryTrack = useCallback((trackId: string, deckKey: 'A' | 'B') => {
    const t = tracks.find((x) => x.id === trackId);
    if (t?.file) void loadTrack(deckKey, t.file);
  }, [tracks, loadTrack]);

  const addFiles = useCallback((files: FileList) => {
    const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f.name));
    if (!audio.length) {
      alert('No audio files in that drop.');
      return;
    }
    // Add to library without loading to a deck.
    // Traktor matches skip analysis entirely — the collection grid is the grid.
    void (async () => {
      for (const file of audio) {
        const raw = await file.arrayBuffer();
        const buffer = await engine.ctx.decodeAudioData(raw.slice(0));
        const traktorTrack = traktor ? findTraktorTrack(traktor, file) : undefined;
        const keyRes = detectKey(buffer);
        const track: TrackInfo = traktorTrack
          ? {
              id: `t${++trackSeq}`,
              title: traktorTrack.title || file.name.replace(/\.[^.]+$/, ''),
              artist: traktorTrack.artist,
              duration: buffer.duration,
              bpm: traktorTrack.grid.bpm,
              key: keyRes.key,
              beatGrid: refineTraktorGrid(traktorTrack, buffer.duration),
              file,
            }
          : await (async () => {
              const { grid, spectralData } = await analyzeTrack(buffer);
              return {
                id: `t${++trackSeq}`,
                title: file.name.replace(/\.[^.]+$/, ''),
                artist: '',
                duration: buffer.duration,
                bpm: grid.bpm,
                key: keyRes.key,
                beatGrid: grid,
                spectralData,
                file,
              } satisfies TrackInfo;
            })();
        setTracks((ts) => [...ts, track]);
      }
    })();
  }, [traktor]);

  // ─── Transport ────────────────────────────────────────────────────────────
  const togglePlay = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    if (engine.isPlaying(deckId)) {
      const pos = engine.position(deckId);
      engine.pause(deckId);
      const st = deckState(deckKey);
      setDeckState(deckKey, { ...st, cuePoint: pos });
    } else {
      const st = deckState(deckKey);
      const align = st.syncActive && masterDeck !== null && masterDeck !== deckId;
      engine.play(deckId, { alignToMaster: align });
    }
  }, [deckState, setDeckState, masterDeck]);

  const cueDown = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    if (engine.isPlaying(deckId)) {
      // While playing: jump back to cue point and pause (CDJ behavior)
      engine.pause(deckId);
      engine.seek(deckId, st.cuePoint);
      setDeckState(deckKey, { ...st, cuePoint: st.cuePoint });
    } else {
      engine.play(deckId, { offset: st.cuePoint });
    }
  }, [deckState, setDeckState]);

  const cueUp = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    // Release after preview: stop and return to cue point
    if (engine.isPlaying(deckId)) {
      engine.pause(deckId);
      const st = deckState(deckKey);
      engine.seek(deckId, st.cuePoint);
    }
  }, [deckState]);

  const toggleSync = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    const on = !st.syncActive;
    if (on && !masterDeck) {
      // No master yet: the other loaded deck becomes master
      const other = deckKey === 'A' ? 'B' : 'A';
      const otherId = `deck${other}` as 'deckA' | 'deckB';
      if (deckState(other).track) setMasterDeck(otherId);
      else setMasterDeck(deckId); // follow self = no-op until a master is picked
    }
    engine.setSync(deckId, on);
    setDeckState(deckKey, { ...st, syncActive: on });
  }, [deckState, setDeckState, masterDeck]);

  const toggleMaster = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    setMasterDeck((m) => (m === deckId ? null : deckId));
  }, []);

  // ─── AI deck ──────────────────────────────────────────────────────────────
  const dropAiLoop = useCallback((loop: GeneratedLoop) => {
    const deckId = 'deckC';
    const tempo = masterBpm > 0 && loop.grid.bpm > 0 ? masterBpm / loop.grid.bpm : 1;
    const at = engine.playAiLoop(deckId, loop.buffer, loop.grid, tempo);
    if (at !== null) {
      setAiLoop(loop);
      setAiBuffer(loop.buffer);
      // Make sure the AI channel is audible
      setChC((c) => {
        const next = { ...c, fader: Math.max(c.fader, 0.8) };
        engine.setFader(deckId, next.fader);
        return next;
      });
    }
  }, [masterBpm]);

  const masterKey = masterDeck === 'deckA' ? deckA.track?.key ?? '' : masterDeck === 'deckB' ? deckB.track?.key ?? '' : '';

  // ─── Deck prop builders ───────────────────────────────────────────────────
  const deckProps = (deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    return {
      deckKey,
      state: st,
      isMaster: masterDeck === deckId,
      masterBpm,
      accent: deckKey === 'A' ? '#38bdf8' : '#fb923c',
      onPlayPause: () => togglePlay(deckKey),
      onCueDown: () => cueDown(deckKey),
      onCueUp: () => cueUp(deckKey),
      onTempo: (v: number) => {
        engine.setTempo(deckId, v);
        setDeckState(deckKey, { ...deckState(deckKey), tempo: v });
      },
      onSync: () => toggleSync(deckKey),
      onMaster: () => toggleMaster(deckKey),
      onKeyLock: () => {
        const on = !st.keyLock;
        engine.setKeyLock(deckId, on);
        setDeckState(deckKey, { ...st, keyLock: on });
      },
      onSeek: (t: number) => engine.seek(deckId, t),
      onHotcue: (i: number, set: boolean) => {
        const hcs = [...st.hotcues];
        if (set || hcs[i] === null) {
          hcs[i] = engine.position(deckId);
          setDeckState(deckKey, { ...st, hotcues: hcs });
        } else if (hcs[i] !== null) {
          const wasPlaying = engine.isPlaying(deckId);
          engine.seek(deckId, hcs[i]!);
          if (!wasPlaying) {
            // stay paused at the hotcue
          }
        }
      },
      onLoopIn: () => setDeckState(deckKey, { ...st, pendingLoopIn: engine.position(deckId) }),
      onLoopOut: () => {
        if (st.pendingLoopIn !== null) {
          const out = engine.position(deckId);
          if (out > st.pendingLoopIn + 0.05) {
            engine.setLoop(deckId, st.pendingLoopIn, out);
            setDeckState(deckKey, { ...st, loop: { start: st.pendingLoopIn, end: out }, pendingLoopIn: null });
          }
        }
      },
      onLoopExit: () => {
        engine.setLoop(deckId, null, null);
        setDeckState(deckKey, { ...st, loop: null, pendingLoopIn: null });
      },
      onDropFiles: (files: FileList) => {
        const f = [...files].find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(x.name));
        if (f) void loadTrack(deckKey, f);
      },
      onEditGrid: () => setEditingGrid(deckKey),
      onNudgeStart: (dir: -1 | 1) => engine.setNudge(deckId, dir * 0.05),
      onNudgeEnd: () => engine.clearNudge(deckId),
    };
  };

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="text-center">
          <div className="mb-2 text-4xl font-black tracking-tight text-white">
            VELZ<span className="text-sky-400">DJ</span>
          </div>
          <p className="mb-6 text-sm text-zinc-500">Two decks, a mixer, and an AI channel that plays in key and on time.</p>
          <button
            onClick={start}
            disabled={starting}
            className="rounded-xl bg-sky-600 px-8 py-3 text-lg font-bold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {starting ? 'Starting audio…' : '▶ Start the decks'}
          </button>
          <p className="mt-4 text-xs text-zinc-600">Clicking starts the AudioContext (browsers require a gesture).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-zinc-200">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-4 py-2">
        <div className="text-xl font-black tracking-tight text-white">
          VELZ<span className="text-sky-400">DJ</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-1">
          <span className="text-[10px] uppercase text-zinc-500">Master</span>
          <span className="font-mono text-2xl font-bold text-amber-300">
            {masterBpm > 0 ? masterBpm.toFixed(1) : '—'}
          </span>
          <span className="text-[10px] text-zinc-500">BPM</span>
          <span className="ml-2 flex gap-1">
            {(['A', 'B'] as const).map((k) => (
              <button
                key={k}
                onClick={() => toggleMaster(k)}
                className={`h-6 w-6 rounded text-xs font-bold ${masterDeck === `deck${k}` ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-500'}`}
                title={`Deck ${k} as sync master`}
              >
                {k}
              </button>
            ))}
            {masterDeck && (
              <button onClick={() => setMasterDeck(null)} className="h-6 rounded bg-zinc-800 px-1 text-xs text-zinc-500" title="Clear master">
                ✕
              </button>
            )}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <details className="relative">
            <summary className="cursor-pointer rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">
              Audio devices
            </summary>
            <div className="absolute right-0 z-40 mt-1 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs">
              <div className="mb-1 font-bold text-zinc-400">Master out</div>
              <select
                className="mb-2 w-full rounded bg-zinc-800 p-1 text-zinc-200"
                onChange={(e) => void engine.setMasterDevice(e.target.value)}
                defaultValue=""
              >
                <option value="">System default</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
              </select>
              <div className="mb-1 font-bold text-zinc-400">Headphones (cue)</div>
              <select
                className="w-full rounded bg-zinc-800 p-1 text-zinc-200"
                onChange={(e) => void engine.setPhonesDevice(e.target.value)}
                defaultValue=""
              >
                <option value="">System default</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
              </select>
              {!devices.length && (
                <div className="mt-2 text-zinc-500">
                  No output devices listed — labels need mic permission.{' '}
                  <button onClick={() => void engine.unlockDeviceLabels().then(() => engine.listOutputs().then(setDevices))} className="underline">
                    unlock
                  </button>
                </div>
              )}
            </div>
          </details>
          <button
            onClick={() => setMidiOpen(true)}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            🎛 MIDI
          </button>
          <button
            onClick={() => nmlInputRef.current?.click()}
            className="rounded bg-emerald-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
            title="Import Traktor collection.nml — matching tracks use your Traktor beat grids + hotcues, no re-analysis"
          >
            ♻ Traktor
          </button>
          {traktor && (
            <span
              className="flex items-center gap-1 rounded bg-emerald-950 px-2 py-1 text-[10px] font-bold text-emerald-300"
              title={`${traktorFileName}${traktorSavedAt ? ` · imported ${new Date(traktorSavedAt).toLocaleDateString()}` : ''} — click ✕ to forget (re-import to replace)`}
            >
              {traktor.tracks.length} in collection
              <button
                onClick={forgetTraktor}
                className="ml-1 rounded px-0.5 text-emerald-500 hover:bg-emerald-900 hover:text-emerald-200"
                title="Forget the imported Traktor collection"
              >
                ✕
              </button>
            </span>
          )}
          <input
            ref={nmlInputRef}
            type="file" accept=".nml,application/xml,text/xml" className="hidden"
            onChange={(e) => { if (e.target.files?.[0]) void importNml(e.target.files[0]); e.target.value = ''; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded bg-sky-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-sky-600"
          >
            + Add music
          </button>
          <input
            ref={fileInputRef}
            type="file" accept="audio/*" multiple className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>
      </header>

      {/* Decks + mixer */}
      <main className="grid gap-3 p-3 lg:grid-cols-[1fr_340px_1fr]">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/track-id');
            if (id) loadLibraryTrack(id, 'A');
          }}
        >
          <Deck {...deckProps('A')} />
        </div>
        <Mixer
          chA={chA} chB={chB} chC={chC}
          setChA={setChA} setChB={setChB} setChC={setChC}
          crossfader={crossfader}
          setCrossfader={(v) => { setCrossfader(v); engine.setCrossfader(v); }}
          masterVol={masterVol}
          setMasterVol={(v) => { setMasterVol(v); engine.setMasterVolume(v); }}
          cueMix={cueMix}
          setCueMix={(v) => { setCueMix(v); engine.setCueMix(v); }}
          phonesLevel={phonesLevel}
          setPhonesLevel={(v) => { setPhonesLevel(v); engine.setPhonesLevel(v); }}
        />
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/track-id');
            if (id) loadLibraryTrack(id, 'B');
          }}
        >
          <Deck {...deckProps('B')} />
        </div>
      </main>

      {/* AI deck — full width */}
      <div className="px-3 pb-3">
        <AIDeck
          queue={queue}
          masterBpm={masterBpm}
          masterKey={masterKey}
          onDropLoop={dropAiLoop}
          isPlaying={aiPlaying}
          onStop={() => engine.pause('deckC')}
          currentLoop={aiLoop}
          buffer={aiBuffer}
        />
      </div>

      {/* Library */}
      <div className="px-3 pb-6">
        <Library tracks={tracks} onAddFiles={addFiles} onLoadToDeck={loadLibraryTrack} />
      </div>

      {/* Modals */}
      {editingGrid && (() => {
        const st = deckState(editingGrid);
        const deckId = `deck${editingGrid}` as 'deckA' | 'deckB';
        return st.track?.beatGrid ? (
          <GridEditorModal
            deckId={deckId}
            deckLabel={editingGrid}
            grid={st.track.beatGrid}
            onClose={() => setEditingGrid(null)}
            onSave={(grid) => {
              const track = st.track!;
              const next = { ...track, beatGrid: grid, bpm: grid.bpm };
              setDeckState(editingGrid, { ...st, track: next });
              setTracks((ts) => ts.map((t) => (t.id === track.id ? next : t)));
            }}
          />
        ) : null;
      })()}
      {midiOpen && <MidiPanel onClose={() => setMidiOpen(false)} />}
    </div>
  );
}

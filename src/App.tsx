import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine } from './audio/engine';
import { midi } from './midi';
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
import { DemoSynthBackend, GEMINI_KEY_STORAGE, LoopQueue, LyriaLoopBackend, resolveGeminiApiKey, type GeneratedLoop } from './audio/ai';
import { SetRecorder, downloadBlob, formatElapsed, type TracklistEntry } from './audio/recorder';
import { computeBandPeaks, peaksKey } from './audio/peaks';
import { computeBarLoop, doubleLoop, halveLoop } from './audio/loop';
import { loadPeaks, savePeaks } from './audio/peaksStore';
import {
  barSeconds,
  barsToOutro,
  outroStartSeconds,
  pickNextTrack,
  resolvePlaylistTracks,
  swapReady,
  trackBassEnvelope,
} from './audio/autopilot';
import { debugLog } from './audio/debugLog';
import {
  clearLibraryRecords,
  deleteLibraryRecord,
  fileKeyFor,
  loadLibraryRecords,
  requestLibraryPersistence,
  saveLibraryRecord,
} from './audio/libraryStore';
import {
  deletePlaylist,
  loadPlaylists,
  renamePlaylist,
  savePlaylist,
  type PlaylistRecord,
} from './audio/playlistStore';
import type { BandPeaks, BeatGrid, TrackInfo } from './types';
import Deck, { type DeckState } from './components/Deck';
import CenterPlayheadView, { type TopDeckView } from './components/CenterPlayheadView';
import DebugPanel from './components/DebugPanel';
import Mixer, { defaultChannel, defaultSamplerChannel, type ChannelState, type SamplerChannelState } from './components/Mixer';
import AIDeck from './components/AIDeck';
import FxUnit from './components/FxUnit';
import Sampler from './components/Sampler';
import Library from './components/Library';
import GridEditorModal from './components/GridEditorModal';
import MidiPanel from './components/MidiPanel';
import AutoPilot, { AP_OFF_STATUS, type ApStatus } from './components/AutoPilot';

const deckInit = (): DeckState => ({
  track: null,
  buffer: null,
  analyzing: false,
  analysisProgress: 0,
  tempo: 1,
  keyLock: true,
  syncActive: false,
  quantize: true,
  hotcues: [null, null, null, null],
  loop: null,
  loopBars: null,
  pendingLoopIn: null,
  cuePoint: null,
});

/** CUE target: the explicit cue point, or the track start when none is set. */
const resolveCue = (st: DeckState): number => st.cuePoint ?? 0;

let trackSeq = 0;

/** File extension for the top-view track card (WAV, MP3, …). */
const fileExt = (f?: File): string | undefined => {
  if (!f) return undefined;
  const i = f.name.lastIndexOf('.');
  return i > 0 ? f.name.slice(i + 1).toUpperCase() : undefined;
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deckA, setDeckA] = useState<DeckState>(deckInit);
  const [deckB, setDeckB] = useState<DeckState>(deckInit);
  const [chA, setChA] = useState<ChannelState>(defaultChannel);
  const [chB, setChB] = useState<ChannelState>(defaultChannel);
  const [chC, setChC] = useState<ChannelState>(defaultChannel);
  // Sampler channel level/mute live in App state so the mixer strip is
  // the sampler's single channel control (engine defaults: 0.9, unmuted).
  const [samplerVol, setSamplerVolState] = useState(0.9);
  const [samplerMuted, setSamplerMutedState] = useState(false);
  const [samplerCh, setSamplerCh] = useState<SamplerChannelState>(defaultSamplerChannel);
  const setSamplerVol = useCallback((v: number) => {
    setSamplerVolState(v);
    engine.setSamplerMaster(v);
  }, []);
  const setSamplerMuted = useCallback((m: boolean) => {
    setSamplerMutedState(m);
    engine.setSamplerMuted(m);
  }, []);
  const [crossfader, setCrossfader] = useState(0);
  const [masterVol, setMasterVol] = useState(0.8);
  const [cueMix, setCueMix] = useState(0.5);
  const [phonesLevel, setPhonesLevel] = useState(0.8);
  const [masterDeck, setMasterDeck] = useState<'deckA' | 'deckB' | null>(null);
  const [masterBpm, setMasterBpm] = useState(0);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const tracksRef = useRef<TrackInfo[]>([]);
  tracksRef.current = tracks;
  // Shown in the library when a save fails (quota etc.) — the track stays
  // usable in-session, but it will not survive a reload until storage frees up.
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [editingGrid, setEditingGrid] = useState<'A' | 'B' | null>(null);
  const [midiOpen, setMidiOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [aiLoop, setAiLoop] = useState<GeneratedLoop | null>(null);
  const [aiBuffer, setAiBuffer] = useState<AudioBuffer | null>(null);
  const [aiPlaying, setAiPlaying] = useState(false);
  const [aiCue, setAiCue] = useState(0);
  const [aiPeaks, setAiPeaks] = useState<BandPeaks | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  // Traktor collection.nml — source of truth for beat grids when imported.
  // Persisted in IndexedDB so the import survives reloads (import once).
  const [traktor, setTraktor] = useState<TraktorCollection | null>(null);
  const [traktorFileName, setTraktorFileName] = useState('');
  const [traktorSavedAt, setTraktorSavedAt] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nmlInputRef = useRef<HTMLInputElement>(null);
  // Set recorder (Phase 2) — records the master out to WAV + auto-tracklist
  const recorderRef = useRef<SetRecorder | null>(null);
  const [recOn, setRecOn] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [recSaving, setRecSaving] = useState(false);
  const [recNote, setRecNote] = useState('');

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

  // Restore the saved track library on startup: titles/metadata land
  // immediately, audio stays in IndexedDB and is decoded lazily when a
  // track loads to a deck — startup stays snappy no matter how big the
  // library gets. Also ask the browser to persist this origin's storage
  // so the library is less likely to be evicted under pressure.
  const libraryRestoredRef = useRef(false);
  useEffect(() => {
    if (libraryRestoredRef.current) return;
    libraryRestoredRef.current = true;
    void requestLibraryPersistence();
    let cancelled = false;
    loadLibraryRecords()
      .then((restored) => {
        if (!cancelled && restored.length) setTracks(restored);
      })
      .catch((e) => console.warn('Saved library restore failed', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // AI backend: real Gemini Lyria when a key is configured (localStorage
  // key field in the AI deck, or VITE_GEMINI_API_KEY at build time),
  // otherwise the clearly-labeled demo synth. The key is never committed.
  const [lyriaKey, setLyriaKey] = useState(() => resolveGeminiApiKey());
  const queue = useMemo(
    () => new LoopQueue(lyriaKey ? new LyriaLoopBackend({ apiKey: lyriaKey }) : new DemoSynthBackend()),
    // Initial backend only — later key changes go through applyLyriaKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const applyLyriaKey = (key: string) => {
    const trimmed = key.trim();
    setLyriaKey(trimmed);
    try {
      if (trimmed) window.localStorage.setItem(GEMINI_KEY_STORAGE, trimmed);
      else window.localStorage.removeItem(GEMINI_KEY_STORAGE);
    } catch { /* private mode etc. */ }
    queue.setBackend(trimmed ? new LyriaLoopBackend({ apiKey: trimmed }) : new DemoSynthBackend());
  };
  const deckState = useCallback((k: 'A' | 'B') => (k === 'A' ? deckA : deckB), [deckA, deckB]);
  const setDeckState = useCallback((k: 'A' | 'B', s: DeckState) => {
    (k === 'A' ? setDeckA : setDeckB)(s);
  }, []);
  const deckStateRef = useRef({ A: deckA, B: deckB });
  deckStateRef.current = { A: deckA, B: deckB };

  // ─── Waveform peaks (Phase 4): attach computed/cached peaks to a track
  // wherever it lives (library + either deck), computing at most once.
  const applyPeaks = useCallback((trackId: string, peaks: BandPeaks) => {
    setTracks((ts) => ts.map((t) => (t.id === trackId ? { ...t, peaks } : t)));
    (['A', 'B'] as const).forEach((k) => {
      const st = deckStateRef.current[k];
      if (st.track?.id === trackId) setDeckState(k, { ...st, track: { ...st.track, peaks } });
    });
    // Keep the saved library record in step: a restored track's peaks come
    // from its record, so a record saved before peaks were computed gets
    // them here. Best-effort only — a failed update just means the peaks
    // cache (not the track) is stale.
    const track = tracksRef.current.find((t) => t.id === trackId);
    if (track?.fileKey) {
      void saveLibraryRecord({ ...track, peaks }).catch((e) =>
        console.warn('Could not update saved library peaks', e),
      );
    }
  }, [setDeckState]);

  const ensurePeaks = useCallback((track: TrackInfo, buffer: AudioBuffer) => {
    if (track.peaks) return;
    const key = track.file ? peaksKey(track.file) : null;
    void (async () => {
      if (key) {
        const cached = await loadPeaks(key);
        if (cached) { applyPeaks(track.id, cached); return; }
      }
      const peaks = await computeBandPeaks(buffer, track.spectralData);
      if (key) await savePeaks(key, peaks);
      applyPeaks(track.id, peaks);
    })().catch((e) => console.warn('Peaks computation failed', e));
  }, [applyPeaks]);

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
      const rec = recorderRef.current;
      if (rec?.recording) setRecElapsed(rec.elapsed());
    }, 250);
    return () => window.clearInterval(id);
  }, [ready]);

  // Dropout hardening (item 4): a backgrounded tab can leave the
  // AudioContext suspended and the <audio> device elements paused while the
  // engine still reports decks as playing. Resume on return to the tab.
  useEffect(() => {
    if (!ready) return;
    const onVis = () => {
      if (!document.hidden) void engine.resume();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [ready]);

  // Never lose a set to an accidental tab close
  useEffect(() => {
    if (!recOn) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recOn]);

  // ─── Set recording ──────────────────────────────────────────────────────
  const toggleRecord = useCallback(async () => {
    const rec = recorderRef.current ?? (recorderRef.current = new SetRecorder());
    if (rec.recording) {
      setRecSaving(true);
      try {
        const { wavBlob, fileName } = await rec.stop();
        if (wavBlob) downloadBlob(wavBlob, fileName);
        const base = fileName.replace(/\.wav$/i, '');
        downloadBlob(new Blob([rec.tracklistText()], { type: 'text/plain' }), `${base}-tracklist.txt`);
        downloadBlob(
          new Blob([JSON.stringify(rec.tracklist, null, 2)], { type: 'application/json' }),
          `${base}-tracklist.json`,
        );
        setRecNote(rec.streamError ?? (rec.mode === 'stream' ? 'Saved to your chosen file.' : 'Downloaded.'));
      } finally {
        setRecSaving(false);
        setRecOn(false);
        setRecElapsed(0);
      }
      return;
    }
    // Starting: get the save-file handle FIRST, inside this click's user
    // activation, so a long set streams straight to disk when possible.
    let handle: FileSystemFileHandle | null = null;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: rec.suggestedFileName(),
          types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }],
        });
      } catch {
        return; // user cancelled the picker — don't start half a flow
      }
    }
    const seed: Omit<TracklistEntry, 'elapsed'>[] = [];
    for (const k of ['A', 'B'] as const) {
      const t = (k === 'A' ? deckA : deckB).track;
      if (t) seed.push({ deck: k, title: t.title, artist: t.artist, bpm: t.bpm, key: t.key ?? '' });
    }
    if (aiLoop) {
      seed.push({ deck: 'AI', title: aiLoop.spec.style, artist: 'AI channel', bpm: aiLoop.grid.bpm, key: aiLoop.key });
    }
    const tap = engine.createRecorderTap();
    await rec.start(engine.ctx, tap, handle, seed);
    setRecNote(
      rec.mode === 'stream'
        ? 'Streaming to disk.'
        : 'Recording to memory (no disk streaming in this browser) — the WAV downloads when you stop.',
    );
    setRecElapsed(0);
    setRecOn(true);
  }, [deckA, deckB, aiLoop]);

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

  // ─── Saved library management ───────────────────────────────────────────
  // Removing a track drops it from the list and its stored record; a track
  // already on a deck keeps playing (decks hold their own buffers).
  const removeLibraryTrack = useCallback(async (trackId: string) => {
    const track = tracksRef.current.find((t) => t.id === trackId);
    if (track?.fileKey) {
      try {
        await deleteLibraryRecord(track.fileKey);
      } catch (e) {
        console.warn('Could not delete saved library record', e);
      }
    }
    setTracks((ts) => ts.filter((t) => t.id !== trackId));
  }, []);

  const clearLibrary = useCallback(async () => {
    if (!window.confirm('Clear the saved library? Every saved track is removed from this browser. Tracks on the decks keep playing.')) return;
    try {
      await clearLibraryRecords();
    } catch (e) {
      console.warn('Could not clear saved library', e);
      alert('Could not clear the saved library — try again.');
      return;
    }
    setTracks([]);
    setLibraryError(null);
  }, []);

  // ─── Track loading + analysis (ALWAYS runs — never hardcoded BPM) ─────────
  // Traktor is the source of truth: a matching collection entry loads its
  // hand-fixed grid + hotcues with zero re-analysis. Our analyzer is the
  // fallback for tracks Traktor doesn't know.
  //
  // Library saves are surfaced, not silent: a failed save (usually quota)
  // leaves the track playable this session but warns in the library UI,
  // and never breaks the deck load or the rest of the library.
  const noteLibrarySaveError = useCallback((fileName: string, e: unknown) => {
    const quota = e instanceof Error && e.name === 'QuotaExceededError';
    setLibraryError(
      quota
        ? `Could not save "${fileName}" — browser storage is full. The track still plays this session, but it will not be in the library after a reload. Free up storage or remove saved tracks, then re-add it.`
        : `Could not save "${fileName}" to the library (${e instanceof Error ? e.message : 'storage error'}). It still plays this session.`,
    );
  }, []);

  const loadTrack = useCallback(async (deckKey: 'A' | 'B', file: File) => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const d = engine.decks.get(deckId);
    if (!d) return;
    engine.pause(deckId);
    // Fresh transport state for the NEW track: pause() captures the OLD
    // track's position into posBase, and play() defaults its offset to
    // posBase — without this reset a new track would start at the old
    // track's last position and run out (onended) seconds later. A stale
    // loop region would likewise carry over, so it is cleared too.
    d.posBase = 0;
    d.posBaseTime = engine.ctx.currentTime;
    d.loopStart = null;
    d.loopEnd = null;
    setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: 0 });

    try {
      const raw = await file.arrayBuffer();
      const buffer = await engine.ctx.decodeAudioData(raw);
      const traktorTrack = traktor ? findTraktorTrack(traktor, file) : undefined;
      const key = fileKeyFor(file);

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
          fileKey: key,
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
          fileKey: key,
        };
      }
      d.buffer = buffer;
      d.grid = track.beatGrid;
      d.userTempo = 1;
      d.syncBaseTempo = 1;
      d.syncCorr = 1;
      d.nudge = 0;
      setTracks((ts) => [...ts.filter((t) => t.fileKey !== track.fileKey), track]);
      setDeckState(deckKey, { ...deckInit(), track, buffer, hotcues });
      recorderRef.current?.noteTrack({
        deck: deckKey, title: track.title, artist: track.artist, bpm: track.bpm, key: track.key ?? '',
      });
      ensurePeaks(track, buffer);
      // A newly loaded track joins the saved library. A failed save never
      // breaks the deck load — the track plays this session regardless.
      try {
        await saveLibraryRecord(track);
      } catch (e) {
        console.warn('Library save failed', e);
        noteLibrarySaveError(file.name, e);
      }
    } catch (e) {
      console.error('Load failed', e);
      setDeckState(deckKey, deckInit());
      alert(`Could not load ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }, [setDeckState, traktor, ensurePeaks, noteLibrarySaveError]);

  // Restored library tracks load WITHOUT re-analysis: the stored beat grid,
  // key, and peaks are already the track's analysis (a Traktor-matched
  // track's stored grid IS its Traktor grid). Only the audio is decoded.
  // Hotcues are not part of the saved record, so a restored track starts
  // with no hotcues — a deck load from a fresh file still picks up
  // Traktor hotcues through loadTrack.
  const loadRestoredTrack = useCallback(async (deckKey: 'A' | 'B', track: TrackInfo) => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const d = engine.decks.get(deckId);
    if (!d || !track.file) return;
    engine.pause(deckId);
    // Same fresh-transport reset as loadTrack: a restored track must
    // start at 0, not at the previous track's last position, and must
    // not inherit a stale loop region.
    d.posBase = 0;
    d.posBaseTime = engine.ctx.currentTime;
    d.loopStart = null;
    d.loopEnd = null;
    setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: 0 });
    try {
      const raw = await track.file.arrayBuffer();
      const buffer = await engine.ctx.decodeAudioData(raw);
      d.buffer = buffer;
      d.grid = track.beatGrid;
      d.userTempo = 1;
      d.syncBaseTempo = 1;
      d.syncCorr = 1;
      d.nudge = 0;
      setDeckState(deckKey, { ...deckInit(), track, buffer, hotcues: [null, null, null, null] });
      recorderRef.current?.noteTrack({
        deck: deckKey, title: track.title, artist: track.artist, bpm: track.bpm, key: track.key ?? '',
      });
      // Peaks usually ride along in the record; if an old record lacks
      // them, this falls back to the peaks cache / computation.
      ensurePeaks(track, buffer);
    } catch (e) {
      console.error('Restored load failed', e);
      setDeckState(deckKey, deckInit());
      alert(`Could not load ${track.title}: ${e instanceof Error ? e.message : e}`);
    }
  }, [setDeckState, ensurePeaks]);

  const loadLibraryTrack = useCallback((trackId: string, deckKey: 'A' | 'B') => {
    const t = tracks.find((x) => x.id === trackId);
    if (!t?.file) return;
    if (t.restored) void loadRestoredTrack(deckKey, t);
    else void loadTrack(deckKey, t.file);
  }, [tracks, loadTrack, loadRestoredTrack]);

  const addFiles = useCallback((files: FileList) => {
    const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f.name));
    if (!audio.length) {
      alert('No audio files in that drop.');
      return;
    }
    // Add to library without loading to a deck.
    // Traktor matches skip analysis entirely — the collection grid is the grid.
    // One bad file (or one failed save) never aborts the rest of the batch.
    void (async () => {
      const failed: string[] = [];
      for (const file of audio) {
        try {
          const raw = await file.arrayBuffer();
          const buffer = await engine.ctx.decodeAudioData(raw.slice(0));
          const traktorTrack = traktor ? findTraktorTrack(traktor, file) : undefined;
          const keyRes = detectKey(buffer);
          const key = fileKeyFor(file);
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
                fileKey: key,
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
                  fileKey: key,
                } satisfies TrackInfo;
              })();
          setTracks((ts) => [...ts.filter((t) => t.fileKey !== track.fileKey), track]);
          ensurePeaks(track, buffer);
          // Join the saved library. A failed save leaves the track usable
          // this session and warns in the library UI — it never drops the
          // track or stops the batch.
          try {
            await saveLibraryRecord(track);
          } catch (e) {
            console.warn('Library save failed', e);
            noteLibrarySaveError(file.name, e);
          }
        } catch (e) {
          console.error('Add failed', file.name, e);
          failed.push(file.name);
        }
      }
      if (failed.length) {
        alert(`Could not add ${failed.length} file(s): ${failed.join(', ')}`);
      }
    })();
  }, [traktor, ensurePeaks, noteLibrarySaveError]);

  // ─── Transport ────────────────────────────────────────────────────────────
  const togglePlay = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    if (engine.isPlaying(deckId)) {
      // Pausing must NOT move the cue point (that was the cue bug: CUE
      // kept returning to wherever the track was last paused instead of
      // the cue point / track start). The cue point only moves on an
      // explicit Set Cue.
      engine.pause(deckId);
    } else {
      const st = deckState(deckKey);
      // Quantized launch (EDM sync): with Q on, Play waits for the
      // master's next bar and drops on a downbeat instead of starting
      // mid-beat. Q off = the old immediate start.
      if (st.quantize) {
        engine.playQuantized(deckId);
      } else {
        const align = st.syncActive && masterDeck !== null && masterDeck !== deckId;
        engine.play(deckId, { alignToMaster: align });
      }
    }
  }, [deckState, masterDeck]);

  const cueDown = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    const cue = resolveCue(st);
    if (engine.isPlaying(deckId)) {
      // While playing: jump back to cue point and pause (CDJ behavior)
      engine.pause(deckId);
      engine.seek(deckId, cue);
    } else {
      // CUE-triggered start goes through the same quantized hook as Play
      // (CDJ-style: with Q on, hold past the next bar and the preview
      // drops on the grid; Q off restores the instant preview).
      if (st.quantize) engine.playQuantized(deckId, { offset: cue });
      else engine.play(deckId, { offset: cue });
    }
  }, [deckState]);

  const cueUp = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    // Release after preview: stop and return to cue point
    if (engine.isPlaying(deckId)) {
      engine.pause(deckId);
      const st = deckState(deckKey);
      engine.seek(deckId, resolveCue(st));
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

  // ─── AI DJ autopilot ──────────────────────────────────────────────────
  // State machine (ref-held so the driver tick never goes stale).
  //
  // AUDIO-CLOCK SCHEDULING (background-tab fix): the audible transition
  // is programmed on the audio clock, not on the JS interval. When a blend
  // is due, the driver schedules the incoming deck's start (play with a
  // future startAt), the full crossfader curve, and the bass-swap curves
  // as AudioParam automation at audio times — the audio thread then
  // renders the blend even if the browser throttles JS timers to a crawl
  // in a hidden tab. The 250ms interval is then only a UI status ticker
  // plus a catch-up watchdog: it samples audio-clock positions, finishes
  // bookkeeping (role swap) once a scheduled blend's end time passes,
  // reads the live bass envelopes for an early swap, and recovers if a
  // track ends while JS slept. The outro-loop hold remains the no-silence
  // safety net. Phases: waiting → preparing (legacy/no-arm path) →
  // scheduled (blend programmed on the audio clock) → crossfading
  // (immediate/catch-up path, ramps still audio-scheduled from now) →
  // waiting (roles swapped), with fallback (loop the outro, never
  // silence) and generating (AI bridge) as the no-candidate tiers.
  // Audio is never interrupted by the machine itself: takeover cancels
  // scheduled automation, restores EQ, and touches nothing else.
  type ApMachinePhase = 'waiting' | 'preparing' | 'scheduled' | 'crossfading' | 'fallback' | 'generating';
  interface ApMachine {
    phase: ApMachinePhase;
    playingKey: 'A' | 'B';
    freeKey: 'A' | 'B';
    nextId: string | null;
    nextTitle: string | null;
    nextIsBridge: boolean;
    synced: boolean;
    immediateBlend: boolean;
    prepareAt: number;
    outroStart: number;
    /** Audio time the scheduled blend starts (scheduled/crossfading only). */
    blendStartAt: number;
    /** Audio time the scheduled blend ends (scheduled/crossfading only). */
    blendEndAt: number;
    blendSec: number;
    fromV: number;
    toV: number;
    bassSwapped: boolean;
    /** True while scheduled AudioParam automation is outstanding. */
    automated: boolean;
    /** True when the armed pick came from auto-pick (swappable if the queue fills before the blend). */
    provisional: boolean;
    /** True while recovering from a natural track end that JS slept through (do not treat the dead deck as a user pause). */
    recovering: boolean;
    eqSnap: { outLow: number; inLow: number } | null;
    loadStartWall: number;
    failedIds: string[];
    recentIds: string[];
    fallbackLoop: { start: number; end: number } | null;
    genAttempted: boolean;
    genToken: number;
    genBridge: { buffer: AudioBuffer; grid: BeatGrid; key: string } | null;
    genError: string | null;
  }
  const [apOn, setApOn] = useState(false);
  const [apQueueIds, setApQueueIds] = useState<string[]>([]);
  const [apOutroBars, setApOutroBars] = useState(8);
  const [apStatus, setApStatus] = useState<ApStatus>(AP_OFF_STATUS);
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]);
  const [apPlaylistLoop, setApPlaylistLoop] = useState(false);
  const [apLoadedPlaylist, setApLoadedPlaylist] = useState<string | null>(null);
  const [apPlaylistNote, setApPlaylistNote] = useState<string | null>(null);
  const apPlaylistLoopRef = useRef(false);
  apPlaylistLoopRef.current = apPlaylistLoop;
  const apPlaylistKeysRef = useRef<string[]>([]);
  const apRef = useRef<ApMachine | null>(null);
  const apOnRef = useRef(false);
  apOnRef.current = apOn;
  const apQueueRef = useRef<string[]>([]);
  apQueueRef.current = apQueueIds;
  const apOutroRef = useRef(8);
  apOutroRef.current = apOutroBars;
  const crossfaderRef = useRef(0);
  crossfaderRef.current = crossfader;
  const chRef = useRef({ A: chA, B: chB });
  chRef.current = { A: chA, B: chB };
  const masterBpmRef = useRef(0);
  masterBpmRef.current = masterBpm;
  const loadLibRef = useRef(loadLibraryTrack);
  loadLibRef.current = loadLibraryTrack;
  const aiQueueRef = useRef(queue);
  aiQueueRef.current = queue;

  const isBridgeTrack = (t: TrackInfo | null | undefined): boolean =>
    !!t && t.id.startsWith('ai-bridge-');

  const freshMachine = (playingKey: 'A' | 'B', freeKey: 'A' | 'B', recentIds: string[]): ApMachine => ({
    phase: 'waiting',
    playingKey,
    freeKey,
    nextId: null,
    nextTitle: null,
    nextIsBridge: false,
    synced: false,
    immediateBlend: false,
    prepareAt: 0,
    outroStart: 0,
    blendStartAt: 0,
    blendEndAt: 0,
    blendSec: 0,
    fromV: 0,
    toV: 0,
    bassSwapped: false,
    automated: false,
    provisional: false,
    recovering: false,
    eqSnap: null,
    loadStartWall: 0,
    failedIds: [],
    recentIds,
    fallbackLoop: null,
    genAttempted: false,
    genToken: 0,
    genBridge: null,
    genError: null,
  });

  const pushApStatus = (s: ApStatus) => {
    setApStatus((prev) =>
      prev.on === s.on && prev.phase === s.phase && prev.playingKey === s.playingKey &&
      prev.nextTitle === s.nextTitle && prev.barsToGo === s.barsToGo &&
      prev.blendProgress === s.blendProgress && prev.bass === s.bass && prev.note === s.note
        ? prev
        : s,
    );
  };

  /** Automated low-EQ move: quiet engine call + knob state kept in sync. */
  const apSetEq = (key: 'A' | 'B', lowVal: number) => {
    const cur = chRef.current[key].eqLow;
    if (Math.abs(cur - lowVal) <= 0.01) return;
    engine.setEqAuto(`deck${key}`, 'low', lowVal);
    const next = { ...chRef.current[key], eqLow: lowVal };
    (key === 'A' ? setChA : setChB)(next);
  };

  const apSetCrossfader = (v: number) => {
    setCrossfader(v);
    engine.setCrossfader(v);
  };

  /** Restore pre-transition low EQ on both decks (takeover / cycle end). */
  const apRestoreEq = (m: ApMachine) => {
    if (!m.eqSnap) return;
    for (const k of ['A', 'B'] as const) {
      const val = k === m.playingKey ? m.eqSnap.outLow : m.eqSnap.inLow;
      engine.setEq(`deck${k}`, 'low', val, false);
      const next = { ...chRef.current[k], eqLow: val };
      (k === 'A' ? setChA : setChB)(next);
    }
  };

  const apClearLoop = (key: 'A' | 'B') => {
    const st = deckStateRef.current[key];
    if (!st.loop) return;
    engine.exitLoop(`deck${key}`);
    setDeckState(key, { ...st, loop: null, loopBars: null, pendingLoopIn: null });
  };

  const apSetFallbackLoop = (m: ApMachine) => {
    const pSt = deckStateRef.current[m.playingKey];
    if (!pSt.track || m.fallbackLoop) return;
    const start = m.outroStart;
    const end = pSt.track.duration;
    if (end <= start) return;
    engine.setLoop(`deck${m.playingKey}`, start, end);
    setDeckState(m.playingKey, { ...pSt, loop: { start, end }, loopBars: null });
    m.fallbackLoop = { start, end };
  };

  const apLoadBridge = (key: 'A' | 'B', bridge: { buffer: AudioBuffer; grid: BeatGrid; key: string }): string => {
    const deckId = `deck${key}`;
    const d = engine.decks.get(deckId);
    engine.pause(deckId);
    if (d) {
      d.buffer = bridge.buffer;
      d.grid = bridge.grid;
      d.userTempo = 1;
      d.syncBaseTempo = 1;
      d.syncCorr = 1;
      d.nudge = 0;
      d.posBase = 0;
      d.posBaseTime = engine.ctx.currentTime;
      d.loopStart = null;
      d.loopEnd = null;
    }
    const id = `ai-bridge-${Date.now()}`;
    const track: TrackInfo = {
      id,
      title: 'AI bridge (Lyria-generated loop)',
      artist: 'AI — generated, not a real track',
      duration: bridge.buffer.duration,
      bpm: bridge.grid.bpm,
      key: bridge.key,
      beatGrid: bridge.grid,
    };
    setDeckState(key, { ...deckInit(), track, buffer: bridge.buffer });
    // Peaks for the waveforms (deck-only: never added to the library).
    void ensurePeaks(track, bridge.buffer);
    return id;
  };

  const apPickArgs = (m: ApMachine) => {
    const decks = deckStateRef.current;
    return {
      tracks: tracksRef.current,
      playing: decks[m.playingKey].track,
      queueIds: apQueueRef.current,
      recentIds: m.recentIds,
      onDeckIds: [decks.A.track?.id, decks.B.track?.id].filter((x): x is string => !!x),
      failedIds: m.failedIds,
    };
  };

  /**
   * Pick the next track, with loop-playlist refill: when the queue runs
   * dry with loop on and a playlist loaded, the playlist restarts from
   * the top (history cleared — a new pass) instead of falling through
   * to auto-pick. Without loop, an exhausted playlist falls through to
   * auto-pick exactly as before, so the music never stops.
   */
  const apPick = (m: ApMachine) => {
    if (
      apQueueRef.current.length === 0 &&
      apPlaylistLoopRef.current &&
      apPlaylistKeysRef.current.length > 0
    ) {
      const { found } = resolvePlaylistTracks(apPlaylistKeysRef.current, tracksRef.current);
      const ids = found.map((t) => t.id);
      if (ids.length > 0) {
        m.recentIds = [];
        apQueueRef.current = ids;
        setApQueueIds(ids);
      }
    }
    return pickNextTrack(apPickArgs(m));
  };

  /**
   * Lookahead arm: load the next pick onto the free deck WELL ahead of
   * the outro window (at cycle start, not at the last tick), so a
   * throttled tab cannot miss the load window. Only when the free deck
   * is empty or still holds the just-finished track — never clobber a
   * track the user loaded manually. Provisional auto-picks (queue was
   * empty at arm time) can still be swapped for a queue pick at finalize.
   */
  const apArmNext = (m: ApMachine, expectFreeId: string | null) => {
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    if (!pSt.track || isBridgeTrack(pSt.track)) return;
    if (m.nextId) return;
    if (fSt.track && fSt.track.id !== expectFreeId) return;
    if (fSt.loop) apClearLoop(m.freeKey);
    const pick = apPick(m);
    if (!pick) return;
    if (pick.fromQueue) setApQueueIds((ids) => ids.filter((id) => id !== pick.track.id));
    m.nextId = pick.track.id;
    m.nextTitle = pick.track.title;
    m.nextIsBridge = false;
    m.provisional = !pick.fromQueue;
    m.synced = false;
    loadLibRef.current(pick.track.id, m.freeKey);
    debugLog('transport', 'autopilot armed next', `deck${m.freeKey}`, {
      track: pick.track.title, fromQueue: pick.fromQueue, provisional: m.provisional,
    });
  };

  const apBeginPrepare = (m: ApMachine, pick: { track: TrackInfo; fromQueue: boolean }, immediate: boolean, now: number) => {
    const fk = m.freeKey;
    const fSt = deckStateRef.current[fk];
    // Clear any stale loop on the free deck (incl. a previous bridge loop)
    // so the incoming track never inherits it.
    if (fSt.loop) apClearLoop(fk);
    if (pick.fromQueue) setApQueueIds((ids) => ids.filter((id) => id !== pick.track.id));
    m.nextId = pick.track.id;
    m.nextTitle = pick.track.title;
    m.nextIsBridge = false;
    m.synced = false;
    m.immediateBlend = immediate;
    m.phase = 'preparing';
    m.loadStartWall = now;
    loadLibRef.current(pick.track.id, fk);
    debugLog('transport', 'autopilot preparing', `deck${fk}`, { track: pick.track.title, fromQueue: pick.fromQueue });
  };

  const apEnterFallback = (m: ApMachine, note: string | null) => {
    m.phase = 'fallback';
    apSetFallbackLoop(m);
    pushApStatus({
      on: true, phase: 'fallback', playingKey: m.playingKey,
      nextTitle: null, barsToGo: null, blendProgress: null, bass: null,
      note: note ?? 'No queue or library pick — holding the outro loop.',
    });
  };

  const apStartGeneration = (m: ApMachine) => {
    const pSt = deckStateRef.current[m.playingKey];
    const playingTrack = pSt.track;
    if (!playingTrack) return;
    m.genAttempted = true;
    m.genToken += 1;
    const token = m.genToken;
    m.phase = 'generating';
    // Hold the music while Lyria works: loop the outro, never silence.
    apSetFallbackLoop(m);
    const backend = aiQueueRef.current.backend;
    if (backend.kind !== 'lyria' || !backend.isConfigured) {
      m.phase = 'fallback';
      m.genError = 'AI generation needs your Gemini key in the AI deck — holding the outro loop.';
      pushApStatus({
        on: true, phase: 'fallback', playingKey: m.playingKey,
        nextTitle: null, barsToGo: null, blendProgress: null, bass: null, note: m.genError,
      });
      return;
    }
    pushApStatus({
      on: true, phase: 'generating', playingKey: m.playingKey,
      nextTitle: null, barsToGo: null, blendProgress: null, bass: null,
      note: 'Generating next with AI… (Lyria) — holding the outro loop meanwhile.',
    });
    const spec = {
      bpm: playingTrack.bpm > 0 ? playingTrack.bpm : (masterBpmRef.current || 124),
      key: playingTrack.key ?? '',
      bars: 4 as const,
      style: 'house',
    };
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('generation timed out')), 120000),
    );
    Promise.race([backend.generate(spec, engine.ctx), timeout])
      .then(async (buf) => {
        if (token !== m.genToken || apRef.current !== m) return; // superseded
        try {
          const { grid } = await analyzeTrack(buf);
          const keyRes = detectKey(buf);
          if (token !== m.genToken || apRef.current !== m) return;
          m.genBridge = { buffer: buf, grid, key: keyRes.key };
          debugLog('transport', 'autopilot AI bridge ready', undefined, { bars: 4, bpm: spec.bpm });
        } catch {
          if (apRef.current === m && token === m.genToken) {
            m.phase = 'fallback';
            m.genError = 'AI generation failed — holding the outro loop.';
          }
        }
      })
      .catch(() => {
        if (token !== m.genToken || apRef.current !== m) return;
        m.phase = 'fallback';
        m.genError = 'AI generation failed — holding the outro loop.';
      });
  };

  /**
   * Schedule a blend on the audio clock: the incoming deck starts at the
   * outro-start audio time (existing play(startAt) queued-launch path),
   * the crossfader curve and the fallback bass swap are AudioParam
   * automation at audio times. After this call the AUDIBLE blend no
   * longer depends on JS wakeups — a throttled tab only delays the
   * bookkeeping (role swap), never the blend itself. Falls back to an
   * immediate blend when the start time is already due or uncomputable
   * (looping deck: position wraps, so the linear audio-time map fails).
   */
  const apScheduleBlend = (m: ApMachine) => {
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    if (!pSt.track) return;
    engine.setMaster(pId);
    setMasterDeck(pId as 'deckA' | 'deckB');
    engine.setSync(fId, true);
    setDeckState(m.freeKey, { ...fSt, syncActive: true });
    m.synced = true;
    const fCh = chRef.current[m.freeKey];
    if (fCh.fader < 0.05) {
      engine.setFader(fId, 0.8);
      (m.freeKey === 'A' ? setChA : setChB)({ ...fCh, fader: 0.8 });
    }
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    const blendSec = Math.max(2, (pSt.track.duration - m.outroStart) / tempoRatio);
    const nowAudio = engine.ctx.currentTime;
    const blendStartAt = engine.audioTimeAtTrackPos(pId, m.outroStart);
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: chRef.current[m.freeKey].eqLow,
    };
    m.bassSwapped = false;
    m.blendSec = blendSec;
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    if (blendStartAt !== null && blendStartAt > nowAudio + 0.05) {
      // Audio-scheduled path.
      engine.play(fId, { offset: 0, alignToMaster: true, startAt: blendStartAt });
      engine.scheduleEqLowHold(fId, -1, blendStartAt); // incoming bass cut at blend start
      engine.scheduleCrossfaderCurve(m.fromV, m.toV, blendStartAt, blendSec);
      const beatSec = barSeconds(pSt.track.beatGrid) / 4;
      const swapDur = Math.min(beatSec, blendSec);
      const swapStart = blendStartAt + blendSec - swapDur;
      engine.scheduleEqLowCurve(pId, m.eqSnap.outLow, -1, swapStart, swapDur);
      engine.scheduleEqLowCurve(fId, -1, m.eqSnap.inLow, swapStart, swapDur);
      m.phase = 'scheduled';
      m.blendStartAt = blendStartAt;
      m.blendEndAt = blendStartAt + blendSec;
      m.automated = true;
      debugLog('transport', 'autopilot blend scheduled', undefined, { at: blendStartAt, blendSec });
    } else {
      // Due now (late wakeup) or uncomputable — begin now, still
      // audio-scheduled from the current audio time.
      apBeginCrossfade(m, Date.now() / 1000);
    }
  };

  /**
   * Live bass-swap read, shared by the scheduled and immediate blend
   * paths: at the first musical moment (outgoing bass out, incoming bass
   * in, never before 2 bars into the blend), cancel ONLY the scheduled
   * EQ automation — the crossfader curve keeps running untouched — and
   * schedule a 1-beat EQ cross-ramp from the schedule's current values.
   * If JS never wakes during the blend, the scheduled fallback swap at
   * blend end still executes on the audio clock.
   */
  const apLiveSwapCheck = (m: ApMachine, nowAudio: number) => {
    if (m.bassSwapped || !m.eqSnap) return;
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    if (!pSt.track) return;
    const barSec = barSeconds(pSt.track.beatGrid);
    if (nowAudio - m.blendStartAt < 2 * barSec) return;
    const outPos = engine.position(`deck${m.playingKey}`);
    const inPos = engine.position(`deck${m.freeKey}`);
    if (!swapReady(trackBassEnvelope(pSt.track), outPos, trackBassEnvelope(fSt.track), inPos)) return;
    const beatSec = barSec / 4;
    const swapDur = Math.min(beatSec, Math.max(0.1, m.blendEndAt - nowAudio));
    // Current EQ values from the schedule: flat until the fallback
    // window, then interpolating through it.
    const fbStart = m.blendEndAt - Math.min(beatSec, m.blendSec);
    const span = Math.max(0.1, m.blendEndAt - fbStart);
    const f = nowAudio < fbStart ? 0 : Math.min(1, (nowAudio - fbStart) / span);
    const outNow = m.eqSnap.outLow + (-1 - m.eqSnap.outLow) * f;
    const inNow = -1 + (m.eqSnap.inLow - -1) * f;
    engine.cancelEqAutomation(`deck${m.playingKey}`);
    engine.cancelEqAutomation(`deck${m.freeKey}`);
    engine.scheduleEqLowCurve(`deck${m.playingKey}`, outNow, -1, nowAudio, swapDur);
    engine.scheduleEqLowCurve(`deck${m.freeKey}`, inNow, m.eqSnap.inLow, nowAudio, swapDur);
    m.bassSwapped = true;
  };

  const apBeginCrossfade = (m: ApMachine, now: number) => {
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    if (!pSt.track) return;
    // Start the incoming deck if it is not already rolling, synced to the
    // playing deck with bar-phase alignment (existing sync facilities).
    if (!engine.isPlaying(fId)) {
      engine.setMaster(pId);
      setMasterDeck(pId as 'deckA' | 'deckB');
      engine.setSync(fId, true);
      setDeckState(m.freeKey, { ...fSt, syncActive: true });
      engine.play(fId, { offset: 0, alignToMaster: true });
    }
    // A silent incoming channel would blend into nothing — nudge it up.
    const fCh = chRef.current[m.freeKey];
    if (fCh.fader < 0.05) {
      engine.setFader(fId, 0.8);
      (m.freeKey === 'A' ? setChA : setChB)({ ...fCh, fader: 0.8 });
    }
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    m.phase = 'crossfading';
    m.blendSec = m.immediateBlend
      ? Math.max(4, (16 * 60) / (masterBpmRef.current || 124))
      : Math.max(2, (pSt.track.duration - m.outroStart) / tempoRatio);
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: chRef.current[m.freeKey].eqLow,
    };
    m.bassSwapped = false;
    // Audio-scheduled from now (catch-up path): the crossfader curve and
    // the fallback bass swap are AudioParam automation, so the blend
    // completes on the audio clock even if JS sleeps again mid-blend.
    // Any earlier schedule is cancelled first so curves cannot fight.
    engine.cancelDeckAutomation(pId);
    engine.cancelDeckAutomation(fId);
    const startAt = engine.ctx.currentTime;
    m.blendStartAt = startAt;
    m.blendEndAt = startAt + m.blendSec;
    m.automated = true;
    engine.scheduleEqLowHold(fId, -1, startAt); // ONE-BASS RULE at blend start
    engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, m.blendSec);
    const beatSec = barSeconds(pSt.track.beatGrid) / 4;
    const swapDur = Math.min(beatSec, m.blendSec);
    const swapStart = m.blendEndAt - swapDur;
    engine.scheduleEqLowCurve(pId, m.eqSnap.outLow, -1, swapStart, swapDur);
    engine.scheduleEqLowCurve(fId, -1, m.eqSnap.inLow, swapStart, swapDur);
    debugLog('transport', 'autopilot blending', undefined, {
      from: pSt.track.title, to: m.nextTitle, blendSec: m.blendSec,
    });
  };

  const apFinishTransition = (m: ApMachine) => {
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    // Cancel scheduled automation FIRST so it cannot override the restore
    // below (a curve event in the future would otherwise win over an
    // immediate move made now).
    engine.cancelDeckAutomation(pId);
    engine.cancelDeckAutomation(fId);
    apSetCrossfader(m.toV);
    // If the bass never swapped (no readable envelope moment), swap at the
    // handover: outgoing bass cut, incoming bass to its pre-blend value.
    if (m.eqSnap) {
      if (!m.bassSwapped) {
        apSetEq(m.playingKey, -1);
        apSetEq(m.freeKey, m.eqSnap.inLow);
      }
      // Outgoing deck is paused now — restore its EQ snapshot so the next
      // cycle starts from a sane state.
      apSetEq(m.playingKey, m.eqSnap.outLow);
    }
    engine.pause(pId);
    const nextDeckState = { ...fSt, syncActive: false };
    if (m.nextIsBridge && fSt.buffer) {
      // A generated bridge loops on its deck until a real track is picked.
      engine.setLoop(fId, 0, fSt.buffer.duration);
      nextDeckState.loop = { start: 0, end: fSt.buffer.duration };
      nextDeckState.loopBars = null;
    }
    engine.setMaster(fId);
    setMasterDeck(fId as 'deckA' | 'deckB');
    engine.setSync(fId, false);
    setDeckState(m.freeKey, nextDeckState);
    const recent = [...m.recentIds, pSt.track?.id].filter((x): x is string => !!x).slice(-50);
    const next = freshMachine(m.freeKey, m.playingKey, recent);
    apRef.current = next;
    // Lookahead arm for the next cycle (only when the new free deck still
    // holds the just-finished track — never clobber a manual load).
    if (!deckStateRef.current[next.freeKey].track || deckStateRef.current[next.freeKey].track?.id === pSt.track?.id) {
      apArmNext(next, pSt.track?.id ?? null);
    }
    debugLog('transport', 'autopilot transition done', undefined, { nowPlaying: m.nextTitle });
  };

  const apTick = useCallback(() => {
    const now = Date.now() / 1000;
    let m = apRef.current;
    const decks = deckStateRef.current;
    if (!m) {
      // Acquire a playing deck to watch.
      const playing = (['A', 'B'] as const).filter(
        (k) => engine.isPlaying(`deck${k}`) && decks[k].track && decks[k].buffer,
      );
      if (playing.length === 0) {
        pushApStatus({
          on: true, phase: 'idle', playingKey: null, nextTitle: null,
          barsToGo: null, blendProgress: null, bass: null, note: null,
        });
        return;
      }
      const pk = playing.length === 1 ? playing[0] : crossfaderRef.current <= 0 ? 'A' : 'B';
      const fk = pk === 'A' ? 'B' : 'A';
      const st = decks[pk];
      const outro = outroStartSeconds(st.track!.beatGrid, st.track!.duration, apOutroRef.current);
      const barSec = barSeconds(st.track!.beatGrid);
      m = freshMachine(pk, fk, []);
      m.outroStart = outro;
      m.prepareAt = outro - 4 * barSec;
      apRef.current = m;
      // Lookahead arm: load the next pick now (well ahead of the outro)
      // when the free deck is empty — never clobber a manual load.
      if (!decks[fk].track) apArmNext(m, null);
    }
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    const pSt = deckStateRef.current[m.playingKey];

    // Playing deck stopped unexpectedly. Scheduled blends are exempt: the
    // old deck ending at blend end is the normal finish, handled by the
    // scheduled block below. Otherwise distinguish a natural end (JS slept
    // through the outro in a throttled tab) from a user pause: a natural
    // end recovers by blending the next pick in from silence, a user pause
    // lets go (never fight the user).
    if (!engine.isPlaying(pId) && m.phase !== 'crossfading' && m.phase !== 'scheduled' && !m.recovering) {
      const endedNaturally = !!pSt.track && engine.position(pId) >= pSt.track.duration - 0.5;
      if (endedNaturally && apOnRef.current) {
        if (m.phase === 'preparing' && m.nextId) {
          // A load is already in flight — just blend it in immediately
          // when it arms instead of starting a second load (race).
          m.recovering = true;
          m.immediateBlend = true;
        } else {
          const pick = apPick(m);
          if (pick) {
            if (pick.fromQueue) setApQueueIds((ids) => ids.filter((id) => id !== pick.track.id));
            m.nextId = pick.track.id;
            m.nextTitle = pick.track.title;
            m.nextIsBridge = false;
            m.phase = 'preparing';
            m.immediateBlend = true;
            m.recovering = true;
            m.loadStartWall = now;
            loadLibRef.current(pick.track.id, m.freeKey);
          } else {
            apRef.current = null;
          }
        }
        return;
      }
      apRef.current = null;
      return;
    }

    if (m.phase === 'waiting') {
      if (!pSt.track || !pSt.buffer) {
        apRef.current = null;
        return;
      }
      if (isBridgeTrack(pSt.track)) {
        // A generated bridge loops forever: hunt for a real track.
        const pick = apPick(m);
        if (pick) apBeginPrepare(m, pick, true, now);
        else {
          pushApStatus({
            on: true, phase: 'waiting', playingKey: m.playingKey,
            nextTitle: '🤖 AI bridge looping (generated, not a real track)',
            barsToGo: null, blendProgress: null, bass: null,
            note: 'AI-generated bridge looping — add a real track to the queue to move on.',
          });
        }
        return;
      }
      const pos = engine.position(pId);
      const fSt = deckStateRef.current[m.freeKey];
      const armed = m.nextId !== null && fSt.track?.id === m.nextId && !!fSt.buffer;
      // Finalize: a queue pick arrived after the provisional auto-pick arm
      // — swap to it (reload the free deck). In a visible tab this always
      // lands; in a throttled tab it may not, and the armed pick plays
      // instead (graceful, never silence).
      if (armed && m.provisional && apQueueRef.current.length > 0) {
        const q = apPick(m);
        if (q && q.fromQueue && q.track.id !== m.nextId) {
          if (fSt.loop) apClearLoop(m.freeKey);
          setApQueueIds((ids) => ids.filter((id) => id !== q.track.id));
          m.nextId = q.track.id;
          m.nextTitle = q.track.title;
          m.nextIsBridge = false;
          m.provisional = false;
          m.synced = false;
          m.loadStartWall = now;
          loadLibRef.current(q.track.id, m.freeKey);
          pushApStatus({
            on: true, phase: 'preparing', playingKey: m.playingKey,
            nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: null, note: null,
          });
          return;
        }
      }
      if (armed && pos >= m.prepareAt) {
        // Blend window reached with the next track already loaded:
        // schedule the blend on the audio clock (or begin immediately
        // when the start time is already due — late wakeup catch-up).
        apScheduleBlend(m);
        return;
      }
      if (!armed && pos >= m.prepareAt) {
        // No arm (free deck was occupied at cycle start, or no pick
        // then): legacy path — pick and load now.
        const pick = apPick(m);
        if (pick) apBeginPrepare(m, pick, false, now);
        else if (!m.genAttempted) apStartGeneration(m);
        else apEnterFallback(m, m.genError);
        return;
      }
      pushApStatus({
        on: true, phase: 'waiting', playingKey: m.playingKey,
        nextTitle: armed ? m.nextTitle : null,
        barsToGo: barsToOutro(pSt.track.beatGrid, pSt.track.duration, pos, apOutroRef.current),
        blendProgress: null, bass: null, note: null,
      });
      return;
    }

    if (m.phase === 'preparing') {
      const fSt = deckStateRef.current[m.freeKey];
      const armed = fSt.track?.id === m.nextId && !!fSt.buffer;
      if (armed) {
        if (!m.synced) {
          engine.setMaster(pId);
          setMasterDeck(pId as 'deckA' | 'deckB');
          engine.setSync(fId, true);
          setDeckState(m.freeKey, { ...fSt, syncActive: true });
          m.synced = true;
        }
        const pos = engine.position(pId);
        if (m.immediateBlend || pos >= m.outroStart) apBeginCrossfade(m, now);
        else {
          pushApStatus({
            on: true, phase: 'preparing', playingKey: m.playingKey,
            nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: null, note: null,
          });
        }
      } else if (now > m.loadStartWall + 20) {
        // Load timed out — skip to the next candidate, never stall.
        if (m.nextId) m.failedIds.push(m.nextId);
        const pick = apPick(m);
        if (pick) apBeginPrepare(m, pick, m.immediateBlend, now);
        else if (!m.genAttempted) apStartGeneration(m);
        else apEnterFallback(m, m.genError);
      } else {
        pushApStatus({
          on: true, phase: 'preparing', playingKey: m.playingKey,
          nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: null, note: null,
        });
      }
      return;
    }

    // ── scheduled: the blend is programmed on the audio clock ──
    // The tick here does NO audible work: it only reads live bass
    // envelopes for an early swap, updates the strip, and finishes the
    // bookkeeping once the scheduled blend end passes. If JS slept
    // through the whole blend, the curves already executed — this tick
    // just performs the role swap on wakeup.
    if (m.phase === 'scheduled') {
      const nowAudio = engine.ctx.currentTime;
      const fSt = deckStateRef.current[m.freeKey];
      const oldAlive = engine.isPlaying(pId);
      const inStarted = nowAudio >= m.blendStartAt;
      if (!oldAlive) {
        // Old deck stopped before/during the scheduled blend.
        const endedNaturally = !!pSt.track && engine.position(pId) >= pSt.track.duration - 0.5;
        if (endedNaturally && inStarted && engine.isPlaying(fId)) {
          // Old deck ended at blend end while the incoming deck rolls:
          // finish now (role swap) instead of waiting for blendEndAt.
          apFinishTransition(m);
        } else if (!endedNaturally) {
          // User paused mid-blend: cancel the program, cancel a
          // not-yet-started incoming launch, restore EQ, let go.
          engine.cancelDeckAutomation(pId);
          engine.cancelDeckAutomation(fId);
          if (nowAudio < m.blendStartAt) engine.pause(fId);
          if (m.eqSnap) apRestoreEq(m);
          apRef.current = null;
        }
        // Natural end before the incoming started (should not happen —
        // the blend starts before track end): fall through to the finish
        // watchdog below, which recovers via the normal path.
        if (apRef.current !== m) return;
      }
      if (inStarted && !engine.isPlaying(fId) && nowAudio > m.blendStartAt + 1) {
        // Incoming deck died mid-blend: snap back, restore EQ, let go.
        engine.cancelDeckAutomation(pId);
        engine.cancelDeckAutomation(fId);
        apSetCrossfader(m.fromV);
        if (m.eqSnap) apRestoreEq(m);
        apRef.current = null;
        return;
      }
      if (inStarted) apLiveSwapCheck(m, nowAudio);
      if (nowAudio >= m.blendEndAt - 0.05) {
        apFinishTransition(m);
        return;
      }
      pushApStatus({
        on: true, phase: 'scheduled', playingKey: m.playingKey,
        nextTitle: m.nextTitle, barsToGo: null,
        blendProgress: nowAudio < m.blendStartAt
          ? null
          : Math.round(Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec))) * 100) / 100,
        bass: m.bassSwapped ? 'swapped' : 'cut',
        note: inStarted ? null : 'Blend programmed — starts on the audio clock at the outro.',
      });
      return;
    }

    if (m.phase === 'generating') {
      // A real track may have appeared while Lyria works — it wins.
      const pick = apPick(m);
      if (pick) {
        m.genToken += 1; // invalidate the in-flight generation result
        m.genAttempted = true;
        apClearLoop(m.playingKey);
        m.fallbackLoop = null;
        apBeginPrepare(m, pick, true, now);
        return;
      }
      if (m.genBridge) {
        const bridge = m.genBridge;
        m.genBridge = null;
        const id = apLoadBridge(m.freeKey, bridge);
        m.nextId = id;
        m.nextTitle = '🤖 AI bridge (Lyria-generated loop)';
        m.nextIsBridge = true;
        m.synced = false;
        m.immediateBlend = false;
        m.phase = 'preparing';
        m.loadStartWall = now;
        return;
      }
      pushApStatus({
        on: true, phase: 'generating', playingKey: m.playingKey,
        nextTitle: null, barsToGo: null, blendProgress: null, bass: null,
        note: 'Generating next with AI… (Lyria) — holding the outro loop meanwhile.',
      });
      return;
    }

    if (m.phase === 'fallback') {
      const pick = apPick(m);
      if (pick) {
        apClearLoop(m.playingKey);
        m.fallbackLoop = null;
        apBeginPrepare(m, pick, true, now);
        return;
      }
      pushApStatus({
        on: true, phase: 'fallback', playingKey: m.playingKey,
        nextTitle: null, barsToGo: null, blendProgress: null, bass: null,
        note: m.genError ?? 'No queue or library pick — holding the outro loop.',
      });
      return;
    }

    // ── crossfading (immediate/catch-up path) ──
    // Ramps are audio-scheduled (see apBeginCrossfade), so this tick
    // does no audible stepping: it only reads live bass for an early
    // swap, updates the strip, and finishes once the scheduled blend
    // end passes on the audio clock.
    const fSt = deckStateRef.current[m.freeKey];
    if (!engine.isPlaying(fId)) {
      // Incoming deck died mid-blend: snap back, restore EQ, let go.
      engine.cancelDeckAutomation(pId);
      engine.cancelDeckAutomation(fId);
      apSetCrossfader(m.fromV);
      if (m.eqSnap) apRestoreEq(m);
      apRef.current = null;
      return;
    }
    const nowAudio = engine.ctx.currentTime;
    apLiveSwapCheck(m, nowAudio);
    // A recovering blend (old deck already dead) finishes on time only
    // — never on old-deck death, which is already true.
    if (nowAudio >= m.blendEndAt - 0.05 || (!m.recovering && !engine.isPlaying(pId))) {
      apFinishTransition(m);
      return;
    }
    pushApStatus({
      on: true, phase: 'crossfading', playingKey: m.playingKey,
      nextTitle: m.nextTitle, barsToGo: null,
      blendProgress: Math.round(Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec))) * 100) / 100,
      bass: m.bassSwapped ? 'swapped' : 'cut', note: null,
    });
  }, []);

  // UI status ticker + catch-up watchdog (see the header comment on the
  // autopilot machine): the tick samples audio-clock positions and
  // performs JS-only work — loads, scheduling decisions, bookkeeping,
  // recovery. It never times a ramp: every audible move is AudioParam
  // automation scheduled at an audio time.
  useEffect(() => {
    if (!apOn) return;
    const id = window.setInterval(() => apTick(), 250);
    return () => window.clearInterval(id);
  }, [apOn, apTick]);

  // Catch-up watchdog: when the tab becomes visible again, run the
  // driver immediately instead of waiting for the next 250ms tick (a
  // throttled tab's tick may be a minute stale).
  useEffect(() => {
    if (!apOn) return;
    const onVis = () => {
      if (document.visibilityState === 'visible') apTick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [apOn, apTick]);

  /** Takeover: stop driving NOW, cancel scheduled automation, restore automated EQ, touch nothing else. */
  const toggleAp = useCallback(() => {
    if (apOnRef.current) {
      const m = apRef.current;
      if (m) {
        // Cancel scheduled curves FIRST so they cannot override the
        // restore below (a future curve event would otherwise win).
        engine.cancelDeckAutomation(`deck${m.playingKey}`);
        engine.cancelDeckAutomation(`deck${m.freeKey}`);
        // A blend scheduled but not yet started: cancel the incoming
        // launch (pause clears the pending start). A blend already
        // rolling is left playing — takeover never interrupts audio.
        if (m.phase === 'scheduled' && engine.ctx.currentTime < m.blendStartAt) {
          engine.pause(`deck${m.freeKey}`);
        }
        if (m.eqSnap) apRestoreEq(m);
      }
      apRef.current = null;
      setApOn(false);
      setApStatus(AP_OFF_STATUS);
      debugLog('transport', 'autopilot off (takeover)');
    } else {
      setApOn(true);
      setApStatus({
        on: true, phase: 'idle', playingKey: null, nextTitle: null,
        barsToGo: null, blendProgress: null, bass: null, note: null,
      });
      debugLog('transport', 'autopilot on');
    }
  }, []);

  // MIDI — autopilot toggle reuses the header button's exact path (toggleAp).
  useEffect(() => {
    const unreg = midi.registerControl('autopilot.toggle', {
      kind: 'button',
      onButton: (p) => { if (p) toggleAp(); },
    });
    return unreg;
  }, [toggleAp]);

  const apQueueAdd = (id: string) => setApQueueIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  const apQueueRemove = (id: string) => setApQueueIds((ids) => ids.filter((x) => x !== id));
  const apQueueMove = (id: string, dir: -1 | 1) =>
    setApQueueIds((ids) => {
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return ids;
      const next = [...ids];
      const tmp = next[i];
      next[i] = next[j];
      next[j] = tmp;
      return next;
    });
  const apQueueClear = () => setApQueueIds([]);
  const apQueueTracks = apQueueIds
    .map((id) => tracks.find((t) => t.id === id))
    .filter((t): t is TrackInfo => !!t);

  // ─── Saved playlists (IndexedDB — survive reload) ────────────────────
  // Load once on mount; resolution against the live library happens at
  // playlist-load time (tracks may have been added/removed since save).
  useEffect(() => {
    void loadPlaylists().then(setPlaylists).catch((e) => console.warn('Playlists load failed', e));
  }, []);

  /** Save the current queue as a named playlist (same name replaces that playlist). */
  const apPlaylistSave = (name: string) => {
    const fileKeys = apQueueTracks.map((t) => t.fileKey).filter((k): k is string => !!k);
    if (!fileKeys.length) return;
    void savePlaylist(name, fileKeys)
      .then((rec) => {
        setPlaylists((ps) => {
          const next = ps.filter((p) => p.id !== rec.id);
          next.push(rec);
          next.sort((a, b) => a.name.localeCompare(b.name));
          return next;
        });
        setApLoadedPlaylist(rec.name);
        apPlaylistKeysRef.current = rec.fileKeys;
        setApPlaylistNote(`Saved “${rec.name}” (${fileKeys.length} track${fileKeys.length === 1 ? '' : 's'}).`);
      })
      .catch((e) => console.warn('Playlist save failed', e));
  };

  /**
   * Load a playlist into the autopilot queue, REPLACING the current queue
   * (the UI label says so). Missing tracks are skipped gracefully and
   * reported — never breaking the queue.
   */
  const apPlaylistLoad = (id: string) => {
    const rec = playlists.find((p) => p.id === id);
    if (!rec) return;
    const { found, missing } = resolvePlaylistTracks(rec.fileKeys, tracksRef.current);
    setApQueueIds(found.map((t) => t.id));
    setApLoadedPlaylist(rec.name);
    apPlaylistKeysRef.current = rec.fileKeys;
    setApPlaylistNote(
      missing > 0
        ? `Loaded “${rec.name}” — ${missing} track${missing === 1 ? '' : 's'} skipped (no longer in library).`
        : `Loaded “${rec.name}” (${found.length} track${found.length === 1 ? '' : 's'}).`,
    );
  };

  const apPlaylistDelete = (id: string) => {
    const rec = playlists.find((p) => p.id === id);
    void deletePlaylist(id)
      .then(() => {
        setPlaylists((ps) => ps.filter((p) => p.id !== id));
        if (rec && apLoadedPlaylist === rec.name) {
          setApLoadedPlaylist(null);
          apPlaylistKeysRef.current = [];
          setApPlaylistNote(null);
        }
      })
      .catch((e) => console.warn('Playlist delete failed', e));
  };

  const apPlaylistRename = (id: string, name: string) => {
    void renamePlaylist(id, name)
      .then(() => {
        setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, name, updatedAt: new Date().toISOString() } : p)));
        setApLoadedPlaylist((cur) => {
          const rec = playlists.find((p) => p.id === id);
          return rec && cur === rec.name ? name : cur;
        });
      })
      .catch((e) => console.warn('Playlist rename failed', e));
  };

  const apLoopPlaylist = (v: boolean) => setApPlaylistLoop(v);

  // ─── AI deck ──────────────────────────────────────────────────────────────
  const dropAiLoop = useCallback((loop: GeneratedLoop) => {
    const deckId = 'deckC';
    const tempo = masterBpm > 0 && loop.grid.bpm > 0 ? masterBpm / loop.grid.bpm : 1;
    const at = engine.playAiLoop(deckId, loop.buffer, loop.grid, tempo);
    if (at !== null) {
      recorderRef.current?.noteTrack({
        deck: 'AI', title: loop.spec.style, artist: 'AI channel', bpm: loop.grid.bpm, key: loop.key,
      });
      setAiLoop(loop);
      setAiBuffer(loop.buffer);
      setAiCue(0);
      // Band peaks for the ported colored waveforms (reuses the existing
      // peaks pipeline; generated loops never went through track analysis).
      void computeBandPeaks(loop.buffer).then(setAiPeaks).catch(() => setAiPeaks(null));
      // Make sure the AI channel is audible
      setChC((c) => {
        const next = { ...c, fader: Math.max(c.fader, 0.8) };
        engine.setFader(deckId, next.fader);
        return next;
      });
    }
  }, [masterBpm]);

  // AI deck transport (item 5) — same feel as the regular decks.
  const aiPlay = useCallback(() => {
    if (!aiBuffer) return;
    engine.play('deckC', { offset: aiCue });
  }, [aiBuffer, aiCue]);
  const aiPause = useCallback(() => {
    engine.pause('deckC');
  }, []);
  const aiStop = useCallback(() => {
    engine.pause('deckC');
    engine.seek('deckC', aiCue);
  }, [aiCue]);
  const aiCueDown = useCallback(() => {
    if (engine.isPlaying('deckC')) {
      engine.pause('deckC');
      engine.seek('deckC', aiCue);
    } else {
      engine.play('deckC', { offset: aiCue });
    }
  }, [aiCue]);
  const aiCueUp = useCallback(() => {
    if (engine.isPlaying('deckC')) {
      engine.pause('deckC');
      engine.seek('deckC', aiCue);
    }
  }, [aiCue]);
  const aiSetCue = useCallback(() => {
    setAiCue(engine.position('deckC'));
  }, []);

  const masterKey = masterDeck === 'deckA' ? deckA.track?.key ?? '' : masterDeck === 'deckB' ? deckB.track?.key ?? '' : '';

  // ─── Deck prop builders ───────────────────────────────────────────────────
  const deckProps = (deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    return {
      deckKey,
      state: st,
      isMaster: masterDeck === deckId,
      masterKey,
      masterBpm,
      accent: deckKey === 'A' ? '#38bdf8' : '#fb923c',
      onPlayPause: () => { debugLog('transport', 'ui play/pause (deck panel)', deckId, { playing: engine.isPlaying(deckId) }); togglePlay(deckKey); },
      onCueDown: () => { debugLog('transport', 'ui cueDown (deck panel)', deckId, { playing: engine.isPlaying(deckId) }); cueDown(deckKey); },
      onCueUp: () => { debugLog('transport', 'ui cueUp (deck panel)', deckId, { playing: engine.isPlaying(deckId) }); cueUp(deckKey); },
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
      onSetCue: () => {
        const st = deckState(deckKey);
        setDeckState(deckKey, { ...st, cuePoint: engine.position(deckId) });
      },
      onStop: () => {
        debugLog('transport', 'ui stop (deck panel)', deckId, { playing: engine.isPlaying(deckId) });
        engine.pause(deckId);
        engine.seek(deckId, resolveCue(deckState(deckKey)));
      },
      onHotcue: (i: number, set: boolean) => {
        const hcs = [...st.hotcues];
        if (set || hcs[i] === null) {
          hcs[i] = engine.position(deckId);
          setDeckState(deckKey, { ...st, hotcues: hcs });
        } else if (hcs[i] !== null) {
          const target = st.quantize ? engine.quantizeToBeat(deckId, hcs[i]!) : hcs[i]!;
          engine.seek(deckId, target);
        }
      },
      onLoopIn: () => {
        const raw = engine.position(deckId);
        const t = st.quantize ? engine.quantizeToBeat(deckId, raw) : raw;
        setDeckState(deckKey, { ...st, pendingLoopIn: t });
      },
      onLoopOut: () => {
        if (st.pendingLoopIn !== null) {
          const raw = engine.position(deckId);
          let out = st.quantize ? engine.quantizeToBeat(deckId, raw) : raw;
          if (out <= st.pendingLoopIn + 0.05 && st.track && st.track.bpm > 0) {
            out = st.pendingLoopIn + 60 / st.track.bpm; // at least one beat
          }
          if (out > st.pendingLoopIn + 0.05) {
            engine.setLoop(deckId, st.pendingLoopIn, out);
            setDeckState(deckKey, { ...st, loop: { start: st.pendingLoopIn, end: out }, loopBars: null, pendingLoopIn: null });
          }
        }
      },
      onLoopExit: () => {
        // Loop-out: release the loop and keep playing forward from the
        // current position (engine.exitLoop restarts at that position
        // with no loop region — never a jump to start or loop end).
        engine.exitLoop(deckId);
        setDeckState(deckKey, { ...st, loop: null, loopBars: null, pendingLoopIn: null });
      },
      onLoopBars: (bars: number) => {
        const cur = deckState(deckKey);
        if (!cur.track || !cur.buffer) return;
        const r = computeBarLoop(cur.track.beatGrid, cur.buffer.duration, engine.position(deckId), bars);
        if (!r) return;
        engine.setLoop(deckId, r.start, r.end);
        setDeckState(deckKey, { ...cur, loop: r, loopBars: bars, pendingLoopIn: null });
      },
      onLoopHalve: () => {
        const cur = deckState(deckKey);
        if (!cur.loop) return;
        const r = halveLoop(cur.loop, cur.track?.beatGrid ?? null);
        engine.setLoop(deckId, r.start, r.end);
        setDeckState(deckKey, { ...cur, loop: r, loopBars: cur.loopBars !== null ? cur.loopBars / 2 : null });
      },
      onLoopDouble: () => {
        const cur = deckState(deckKey);
        if (!cur.loop || !cur.buffer) return;
        const r = doubleLoop(cur.loop, cur.buffer.duration, cur.track?.beatGrid ?? null);
        engine.setLoop(deckId, r.start, r.end);
        const doubled = cur.loopBars !== null ? cur.loopBars * 2 : null;
        setDeckState(deckKey, { ...cur, loop: r, loopBars: doubled !== null && doubled <= 32 ? doubled : null });
      },
      onToggleQuantize: () => setDeckState(deckKey, { ...st, quantize: !st.quantize }),
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
        <button
          onClick={toggleAp}
          className={`rounded px-4 py-1.5 text-sm font-black tracking-wide ${
            apOn ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
          }`}
          title={apOn ? 'Tap to take back manual control instantly — audio keeps playing' : 'Let the mixer blend the next track automatically'}
        >
          {apOn ? '⏹ AUTOPILOT ON — TAP TO TAKE OVER' : '🤖 AUTOPILOT'}
        </button>
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
            onClick={() => void toggleRecord()}
            disabled={recSaving}
            className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs font-bold disabled:opacity-50 ${
              recOn ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
            title={recOn ? 'Stop recording and save the set (WAV + tracklist)' : 'Record the set — master out to WAV with an auto-tracklist'}
          >
            <span className={`h-2 w-2 rounded-full ${recOn ? 'animate-pulse bg-white' : 'bg-red-500'}`} />
            {recSaving ? 'Saving…' : recOn ? formatElapsed(recElapsed) : 'REC'}
          </button>
          {recNote && (
            <span className="max-w-56 truncate text-[10px] text-zinc-500" title={recNote}>{recNote}</span>
          )}
          <button
            onClick={() => setMidiOpen(true)}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            🎛 MIDI
          </button>
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className={`rounded px-3 py-1.5 text-xs font-bold ${debugOpen ? 'bg-amber-600 text-black' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            title="View / copy / download the debug log — paste it to us after a dropout"
          >
            🐛 Log
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

      {apOn && (
        <AutoPilot
          status={apStatus}
          outroBars={apOutroBars}
          onToggle={toggleAp}
          onOutroBars={setApOutroBars}
          queue={apQueueTracks}
          library={tracks}
          onQueueAdd={apQueueAdd}
          onQueueRemove={apQueueRemove}
          onQueueMove={apQueueMove}
          onQueueClear={apQueueClear}
          playlists={playlists}
          onPlaylistSave={apPlaylistSave}
          onPlaylistLoad={apPlaylistLoad}
          onPlaylistDelete={apPlaylistDelete}
          onPlaylistRename={apPlaylistRename}
          loadedPlaylistName={apLoadedPlaylist}
          playlistNote={apPlaylistNote}
          loopPlaylist={apPlaylistLoop}
          onLoopPlaylist={apLoopPlaylist}
        />
      )}
      {debugOpen && <div className="pt-3"><DebugPanel /></div>}

      {/* Sync view — ported top waveforms, center playhead (item 1) */}
      <CenterPlayheadView
        decks={[
          {
            label: 'A', deckId: 'deckA', color: '#38bdf8',
            title: deckA.track?.title ?? 'No track',
            syncActive: deckA.syncActive,
            artist: deckA.track?.artist,
            fileSize: deckA.track?.file?.size,
            format: fileExt(deckA.track?.file),
            stability: deckA.track?.beatGrid.tempoStability,
            buffer: deckA.buffer, grid: deckA.track?.beatGrid ?? null, peaks: deckA.track?.peaks ?? null,
            bpm: deckA.track?.bpm ?? 0, isPlaying: engine.isPlaying('deckA'),
            onPlayPause: () => { debugLog('transport', 'ui play/pause (top view)', 'deckA', { playing: engine.isPlaying('deckA') }); togglePlay('A'); },
            onCueDown: () => { debugLog('transport', 'ui cueDown (top view)', 'deckA', { playing: engine.isPlaying('deckA') }); cueDown('A'); },
            onCueUp: () => { debugLog('transport', 'ui cueUp (top view)', 'deckA', { playing: engine.isPlaying('deckA') }); cueUp('A'); },
            onStop: () => { debugLog('transport', 'ui stop (top view)', 'deckA', { playing: engine.isPlaying('deckA') }); engine.pause('deckA'); engine.seek('deckA', deckA.cuePoint ?? 0); },
            onSetCue: () => setDeckState('A', { ...deckA, cuePoint: engine.position('deckA') }),
            onToggleSync: () => toggleSync('A'),
            onSeek: (t) => engine.seek('deckA', t),
            loopActive: deckA.loop !== null,
            loopBars: deckA.loopBars,
            onLoopBars: deckProps('A').onLoopBars,
            onLoopExit: deckProps('A').onLoopExit,
          },
          {
            label: 'B', deckId: 'deckB', color: '#fb923c',
            title: deckB.track?.title ?? 'No track',
            syncActive: deckB.syncActive,
            artist: deckB.track?.artist,
            fileSize: deckB.track?.file?.size,
            format: fileExt(deckB.track?.file),
            stability: deckB.track?.beatGrid.tempoStability,
            buffer: deckB.buffer, grid: deckB.track?.beatGrid ?? null, peaks: deckB.track?.peaks ?? null,
            bpm: deckB.track?.bpm ?? 0, isPlaying: engine.isPlaying('deckB'),
            onPlayPause: () => { debugLog('transport', 'ui play/pause (top view)', 'deckB', { playing: engine.isPlaying('deckB') }); togglePlay('B'); },
            onCueDown: () => { debugLog('transport', 'ui cueDown (top view)', 'deckB', { playing: engine.isPlaying('deckB') }); cueDown('B'); },
            onCueUp: () => { debugLog('transport', 'ui cueUp (top view)', 'deckB', { playing: engine.isPlaying('deckB') }); cueUp('B'); },
            onStop: () => { debugLog('transport', 'ui stop (top view)', 'deckB', { playing: engine.isPlaying('deckB') }); engine.pause('deckB'); engine.seek('deckB', deckB.cuePoint ?? 0); },
            onSetCue: () => setDeckState('B', { ...deckB, cuePoint: engine.position('deckB') }),
            onToggleSync: () => toggleSync('B'),
            onSeek: (t) => engine.seek('deckB', t),
            loopActive: deckB.loop !== null,
            loopBars: deckB.loopBars,
            onLoopBars: deckProps('B').onLoopBars,
            onLoopExit: deckProps('B').onLoopExit,
          },
        ]}
        ai={aiBuffer ? {
          label: 'AI', deckId: 'deckC', color: '#c084fc',
          title: aiLoop ? `${aiLoop.spec.style} · ${aiLoop.spec.bars} bars` : 'AI loop',
          buffer: aiBuffer, grid: aiLoop?.grid ?? null, peaks: aiPeaks,
          bpm: aiLoop?.grid.bpm ?? 0, isPlaying: aiPlaying,
          onPlayPause: () => { aiPlaying ? aiPause() : aiPlay(); },
          onCueDown: aiCueDown,
          onCueUp: aiCueUp,
          onStop: aiStop,
          onSetCue: aiSetCue,
          onSeek: (t) => engine.seek('deckC', t),
        } : null}
      />

      {/* FX strip — full width along the top of the mixer area:
          below the horizontal full-width waveforms above, above
          Deck A, the mixer EQ section, and Deck B. */}
      <div className="px-3 pt-3">
        <FxUnit />
      </div>

      {/* Decks + mixer in stacked columns (Traktor-style): AI under
          Deck A, sampler back under Deck B. The center column is
          wider now so the 4-channel mixer (A, AI, B, sampler) fits
          in one row. */}
      <main className="grid items-start gap-3 p-3 lg:grid-cols-[1fr_460px_1fr]">
        {/* Left column: Deck A, then the AI deck underneath it. */}
        <div className="flex flex-col gap-3">
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
          <AIDeck
            queue={queue}
            masterBpm={masterBpm}
            masterKey={masterKey}
            onDropLoop={dropAiLoop}
            isPlaying={aiPlaying}
            onStop={aiStop}
            onPlay={aiPlay}
            onPause={aiPause}
            onCueDown={aiCueDown}
            onCueUp={aiCueUp}
            onSetCue={aiSetCue}
            aiCue={aiCue}
            currentLoop={aiLoop}
            buffer={aiBuffer}
            peaks={aiPeaks}
            lyriaKey={lyriaKey}
            onLyriaKeyChange={applyLyriaKey}
          />
        </div>
        {/* Center column: mixer only (FX lives in the full-width
            strip above the mixer area). */}
        <div className="flex flex-col gap-3">
          <Mixer
            chA={chA} chB={chB} chC={chC}
            setChA={setChA} setChB={setChB} setChC={setChC}
            samplerVol={samplerVol} setSamplerVol={setSamplerVol}
            samplerMuted={samplerMuted} setSamplerMuted={setSamplerMuted}
            samplerCh={samplerCh} setSamplerCh={setSamplerCh}
            crossfader={crossfader}
            setCrossfader={(v) => { setCrossfader(v); engine.setCrossfader(v); }}
            masterVol={masterVol}
            setMasterVol={(v) => { setMasterVol(v); engine.setMasterVolume(v); }}
            cueMix={cueMix}
            setCueMix={(v) => { setCueMix(v); engine.setCueMix(v); }}
            phonesLevel={phonesLevel}
            setPhonesLevel={(v) => { setPhonesLevel(v); engine.setPhonesLevel(v); }}
          />
        </div>
        {/* Right column: Deck B, then the sampler underneath it. */}
        <div className="flex flex-col gap-3">
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
          {/* Sampler — pads + REC FROM DECK, back under Deck B. Its
              channel VOL + MUTE now live on the mixer strip. */}
          <Sampler />
        </div>
      </main>

      {/* Library */}
      <div className="px-3 pb-3">
        <Library
          tracks={tracks}
          masterKey={masterKey}
          onAddFiles={addFiles}
          onLoadToDeck={loadLibraryTrack}
          onRemoveTrack={removeLibraryTrack}
          onClearLibrary={clearLibrary}
          libraryError={libraryError}
          onDismissLibraryError={() => setLibraryError(null)}
        />
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
              // A hand-fixed grid is part of the track now — persist it so
              // a reload does not bring back the pre-edit grid.
              if (next.fileKey) {
                void saveLibraryRecord(next).catch((e) =>
                  console.warn('Could not persist edited grid', e),
                );
              }
            }}
          />
        ) : null;
      })()}
      {midiOpen && <MidiPanel onClose={() => setMidiOpen(false)} />}
    </div>
  );
}

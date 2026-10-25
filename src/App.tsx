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
import { DemoSynthBackend, GEMINI_KEY_STORAGE, LoopQueue, LyriaLoopBackend, resolveGeminiApiKey, type GeneratedLoop } from './audio/ai';
import { SetRecorder, downloadBlob, formatElapsed, type TracklistEntry } from './audio/recorder';
import { computeBandPeaks, peaksKey } from './audio/peaks';
import { computeBarLoop, doubleLoop, halveLoop } from './audio/loop';
import { loadPeaks, savePeaks } from './audio/peaksStore';
import {
  clearLibraryRecords,
  deleteLibraryRecord,
  fileKeyFor,
  loadLibraryRecords,
  requestLibraryPersistence,
  saveLibraryRecord,
} from './audio/libraryStore';
import type { BandPeaks, TrackInfo } from './types';
import Deck, { type DeckState } from './components/Deck';
import CenterPlayheadView, { type TopDeckView } from './components/CenterPlayheadView';
import DebugPanel from './components/DebugPanel';
import Mixer, { defaultChannel, type ChannelState } from './components/Mixer';
import AIDeck from './components/AIDeck';
import FxUnit from './components/FxUnit';
import Sampler from './components/Sampler';
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
      onSetCue: () => {
        const st = deckState(deckKey);
        setDeckState(deckKey, { ...st, cuePoint: engine.position(deckId) });
      },
      onStop: () => {
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
            onPlayPause: () => togglePlay('A'),
            onCueDown: () => cueDown('A'),
            onCueUp: () => cueUp('A'),
            onStop: () => { engine.pause('deckA'); engine.seek('deckA', deckA.cuePoint ?? 0); },
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
            onPlayPause: () => togglePlay('B'),
            onCueDown: () => cueDown('B'),
            onCueUp: () => cueUp('B'),
            onStop: () => { engine.pause('deckB'); engine.seek('deckB', deckB.cuePoint ?? 0); },
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

      {/* Decks + mixer in stacked columns: AI under Deck A, FX +
          sampler under Deck B, mixer alone in the center — saves
          the vertical space the old full-width rows took. */}
      <main className="grid items-start gap-3 p-3 lg:grid-cols-[1fr_340px_1fr]">
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
        {/* Center column: mixer alone. */}
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
        {/* Right column: Deck B, then FX, then the sampler. */}
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
          {/* FX unit — beat-synced send/return */}
          <FxUnit />
          {/* Sampler */}
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine } from './audio/engine';
import type { FxType } from './audio/engine';
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
import { computeBarLoop, doubleLoop, extendBeatsBackward, halveLoop } from './audio/loop';
import { loadPeaks, savePeaks } from './audio/peaksStore';
import {
  autoGainDb,
  barSeconds,
  barsToOutro,
  bassState,
  decideContingency,
  downbeatAtOrBefore,
  downbeatBarsAfter,
  evaluateGuardrails,
  firstSoundSec,
  holdLoopFor,
  outroStartSeconds,
  pickNextTrack,
  planTransition,
  resolvePlaylistTracks,
  selectTransitionType,
  swapReady,
  trackBassEnvelope,
  transitionLabel,
  vocalDensity,
  VOCAL_DENSE_RATIO,
  type Guardrail,
  type SmartPlan,
  type TransitionType,
} from './audio/autopilot';
import { debugLog } from './audio/debugLog';
import {
  clearLibraryRecords,
  deleteLibraryRecord,
  fileKeyFor,
  getLibraryRecord,
  loadLibraryRecords,
  requestLibraryPersistence,
  saveLibraryRecord,
} from './audio/libraryStore';
import {
  LOOP_SEEDS,
  LOOP_SEED_MANIFEST_VERSION,
  PG_SEEDS,
  PG_SEED_MANIFEST_VERSION,
  SEED_MANIFEST_VERSION,
  SEED_TRACKS,
  WF_SEEDS,
  WF_SEED_MANIFEST_VERSION,
  getLoopSeededVersion,
  getPgSeededVersion,
  getSeededVersion,
  getWfSeededVersion,
  runSeeding,
  seedPlaceholder,
  setLoopSeededVersion,
  setPgSeededVersion,
  setSeededVersion,
  setWfSeededVersion,
} from './audio/seedTracks';
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
  hotcueAuto: [false, false, false, false],
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

/**
 * Round 11 — bounded await for deck-load I/O. The Round 9/10 stall was a
 * blob read or decode that never settled: with a bare await, `analyzing`
 * stays true forever, the autopilot machine can only wait and then fail
 * the pick, and the retry loads the same wedged deck again. A stage that
 * takes longer than DECODE_STAGE_TIMEOUT_MS is treated as failed, not
 * waited on. Normal reads/decodes of 60MB WAVs take under 2s, so 20s is
 * generous; one retry per stage keeps a load's worst case inside the
 * machine's 120s preparing window.
 */
const DECODE_STAGE_TIMEOUT_MS = 20000;

class DecodeStageTimeout extends Error {
  constructor(public stage: 'arrayBuffer' | 'decode') {
    super(`decode stage timed out: ${stage}`);
    this.name = 'DecodeStageTimeout';
  }
}

function withDecodeTimeout<T>(
  promise: Promise<T>,
  stage: 'arrayBuffer' | 'decode',
  ms: number = DECODE_STAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DecodeStageTimeout(stage)), ms);
  });
  // Race subscribes to both promises, so a late settlement of the loser
  // never surfaces as an unhandled rejection.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Round 12 — generic bounded await for non-decode async work (an
 * IndexedDB refetch). A plain Error, not a DecodeStageTimeout: callers
 * catch it per strategy and move on to the next read method.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Round 12 — read a blob in slices and concatenate. Round 11 proved the
 * wedge sits in a single whole-blob arrayBuffer() on IndexedDB-restored
 * Files (initial read AND retry both timed out at 20s, while decode was
 * never reached). If a whole-blob read wedges but small reads work, this
 * bypasses it by method rather than by object. 16MB slices keep the
 * worst case (4 slices for a 63MB WAV at 10s each) inside the autopilot
 * machine's 120s preparing window. Transient peak is ~2x the file size
 * (slices + concatenated copy) before decode; acceptable against a load
 * that otherwise never completes.
 */
const BLOB_CHUNK_SIZE = 16 * 1024 * 1024;
const BLOB_CHUNK_TIMEOUT_MS = 10000;

async function readBlobChunked(blob: Blob): Promise<ArrayBuffer> {
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  for (let off = 0; off < blob.size; off += BLOB_CHUNK_SIZE) {
    const part = blob.slice(off, Math.min(off + BLOB_CHUNK_SIZE, blob.size));
    const buf = await withDecodeTimeout(part.arrayBuffer(), 'arrayBuffer', BLOB_CHUNK_TIMEOUT_MS);
    chunks.push(buf);
    total += buf.byteLength;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), pos);
    pos += chunk.byteLength;
  }
  return out.buffer;
}

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
  // Library selection for hardware browse: the highlighted row the S8
  // browse encoder moves and the load buttons act on. Kept as an id
  // (not an index) so it survives list appends; cleared if the track
  // leaves the library.
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const selectedTrackIdRef = useRef<string | null>(null);
  selectedTrackIdRef.current = selectedTrackId;
  // Shown in the library when a save fails (quota etc.) — the track stays
  // usable in-session, but it will not survive a reload until storage frees up.
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [editingGrid, setEditingGrid] = useState<'A' | 'B' | null>(null);
  const [midiOpen, setMidiOpen] = useState(false);
  // First-run DJ workflow help: a dismissible strip under the header, so
  // a working DJ opening the mixer for the first time sees the intended
  // workflow (SYNC, grid check, SET 1.1, QTZ) instead of guessing. It
  // changes nothing about audio or state; it only explains the UI.
  const [helpOpen, setHelpOpen] = useState(false);
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
        if (cancelled) return;
        // Bundled seeds: placeholder rows land with the restored
        // library immediately; each seed's fetch + analysis runs in the
        // background and swaps its row for the saved record when done.
        // Four independent groups, each version-gated (see
        // seedTracks.ts): 'velz' releases, 'loops' example loops
        // (Midnight Concrete), and the Perpetual Groove + Warehouse
        // Floor example sets. A seed the user deleted stays deleted
        // until its own group's manifest version bumps — provisioning
        // one set never resurrects another set's deleted seeds.
        const existing = new Set(restored.map((t) => t.fileKey).filter((k): k is string => Boolean(k)));
        const pendingVelz =
          getSeededVersion() === SEED_MANIFEST_VERSION
            ? []
            : SEED_TRACKS.filter((def) => !existing.has(def.fileKey));
        const pendingLoops =
          getLoopSeededVersion() === LOOP_SEED_MANIFEST_VERSION
            ? []
            : LOOP_SEEDS.filter((def) => !existing.has(def.fileKey));
        const pendingPg =
          getPgSeededVersion() === PG_SEED_MANIFEST_VERSION
            ? []
            : PG_SEEDS.filter((def) => !existing.has(def.fileKey));
        const pendingWf =
          getWfSeededVersion() === WF_SEED_MANIFEST_VERSION
            ? []
            : WF_SEEDS.filter((def) => !existing.has(def.fileKey));
        const pending = [...pendingVelz, ...pendingLoops, ...pendingPg, ...pendingWf];
        const merged = [...restored, ...pending.map(seedPlaceholder)];
        merged.sort((a, b) => a.title.localeCompare(b.title));
        setTracks(merged);
        if (!pending.length) {
          if (getSeededVersion() !== SEED_MANIFEST_VERSION) setSeededVersion(SEED_MANIFEST_VERSION);
          if (getLoopSeededVersion() !== LOOP_SEED_MANIFEST_VERSION) setLoopSeededVersion(LOOP_SEED_MANIFEST_VERSION);
          if (getPgSeededVersion() !== PG_SEED_MANIFEST_VERSION) setPgSeededVersion(PG_SEED_MANIFEST_VERSION);
          if (getWfSeededVersion() !== WF_SEED_MANIFEST_VERSION) setWfSeededVersion(WF_SEED_MANIFEST_VERSION);
          return;
        }
        const callbacks = {
          onProgress: (fileKey: string, p: number) => {
            if (cancelled) return;
            setTracks((ts) => ts.map((t) => (t.fileKey === fileKey ? { ...t, analysisProgress: p } : t)));
          },
          onReady: (track: TrackInfo) => {
            if (cancelled) return;
            // A placeholder removed mid-seed stays removed.
            if (!tracksRef.current.some((t) => t.fileKey === track.fileKey)) return;
            setTracks((ts) =>
              [...ts.filter((t) => t.fileKey !== track.fileKey), track].sort((a, b) =>
                a.title.localeCompare(b.title),
              ),
            );
          },
          onError: (fileKey: string, fileName: string, error: unknown) => {
            if (cancelled) return;
            setTracks((ts) => ts.filter((t) => t.fileKey !== fileKey));
            noteLibrarySaveError(fileName, error);
          },
        };
        // Sequential passes (one heavy decode+analysis at a time), each
        // recording only its own group's version on success.
        void (async () => {
          if (pendingVelz.length) {
            const ok = await runSeeding(existing, callbacks, SEED_TRACKS);
            if (ok && !cancelled) setSeededVersion(SEED_MANIFEST_VERSION);
          }
          if (pendingLoops.length) {
            const ok = await runSeeding(existing, callbacks, LOOP_SEEDS);
            if (ok && !cancelled) setLoopSeededVersion(LOOP_SEED_MANIFEST_VERSION);
          }
          if (pendingPg.length) {
            const ok = await runSeeding(existing, callbacks, PG_SEEDS);
            if (ok && !cancelled) setPgSeededVersion(PG_SEED_MANIFEST_VERSION);
          }
          if (pendingWf.length) {
            const ok = await runSeeding(existing, callbacks, WF_SEEDS);
            if (ok && !cancelled) setWfSeededVersion(WF_SEED_MANIFEST_VERSION);
          }
        })();
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
  // Round 11 — per-deck load generation: a load retired by a stage
  // timeout (or superseded by a newer load) must never apply its buffer
  // or wipe a newer load's state when it settles late.
  const loadGenRef = useRef({ A: 0, B: 0 });
  // Round 11 — shared decode-only context for the retry path: if a decode
  // wedges on the live playback context, retrying on an isolated offline
  // context tests whether the stall is live-context-bound, and rescues
  // the load when it is. Lazily created; never audible.
  const decodeCtxRef = useRef<OfflineAudioContext | null>(null);
  const getDecodeCtx = useCallback((): OfflineAudioContext => {
    if (!decodeCtxRef.current) {
      decodeCtxRef.current = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
    }
    return decodeCtxRef.current;
  }, []);

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
        // Round 10: a dismissed picker used to abort recording silently
        // (REC looked dead — no timer, no file). Fall through to the
        // memory path instead: rec.start with no handle records to
        // memory and the WAV downloads on stop, same as browsers
        // without a file picker. (A native dialog left open, never
        // resolved, still blocks here — that case needs the dialog
        // itself dismissed.)
        handle = null;
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
    // Round 11: generation-guard the whole load (see loadGenRef).
    const gen = ++loadGenRef.current[deckKey];
    const stillCurrent = () => loadGenRef.current[deckKey] === gen;
    setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: 0 });

    try {
      // Round 11: bounded blob read — one retry on timeout, then loud failure.
      let raw: ArrayBuffer;
      try {
        raw = await withDecodeTimeout(file.arrayBuffer(), 'arrayBuffer');
      } catch (e) {
        if (e instanceof DecodeStageTimeout) {
          debugLog('transport', 'load blob read timed out, retrying', deckId, { track: file.name });
          raw = await withDecodeTimeout(file.arrayBuffer(), 'arrayBuffer');
        } else {
          throw e;
        }
      }
      // Round 11: bounded decode — on a live-context timeout, retry once
      // on the isolated offline context (copying the buffer so the two
      // decodes never share it). A retry success proves the stall was
      // live-context-bound and rescues the load; a second timeout fails
      // loudly below instead of hanging forever.
      let buffer: AudioBuffer;
      try {
        buffer = await withDecodeTimeout(engine.ctx.decodeAudioData(raw), 'decode');
      } catch (e) {
        if (e instanceof DecodeStageTimeout) {
          debugLog('transport', 'load decode timed out, retrying on offline context', deckId, {
            track: file.name,
          });
          buffer = await withDecodeTimeout(getDecodeCtx().decodeAudioData(raw.slice(0)), 'decode');
          debugLog('transport', 'load decode retry succeeded on offline context', deckId, {
            track: file.name,
          });
        } else {
          throw e;
        }
      }
      if (!stillCurrent()) return;
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
        const { grid, spectralData } = await analyzeTrack(buffer, (p) => {
          // Round 11: a stale load's progress must never wipe a newer load's state.
          if (stillCurrent()) {
            setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: p * 0.85 });
          }
        });
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
      // Hotcue precedence: an in-app manual edit (library record) wins
      // over everything; else Traktor's hotcues for matched tracks, else
      // the analysis auto hotcues (tagged AUTO). Manual edits are the
      // newest user intent, so they survive even a fresh-file reload.
      const hotcueAuto = [false, false, false, false];
      if (!traktorTrack && track.beatGrid.autoHotcues) {
        for (let i = 0; i < 4; i++) {
          if (track.beatGrid.autoHotcues[i] != null) {
            hotcues[i] = track.beatGrid.autoHotcues[i]!;
            hotcueAuto[i] = true;
          }
        }
      }
      let manual: (number | null)[] | null = null;
      try {
        manual = (await getLibraryRecord(key))?.manualHotcues ?? null;
      } catch { /* no record yet — first load */ }
      if (manual) {
        for (let i = 0; i < 4; i++) {
          if (manual[i] != null) {
            hotcues[i] = manual[i];
            hotcueAuto[i] = false;
          }
        }
        track.manualHotcues = manual;
      }
      // Round 11: awaits above (record lookup) may have let a newer load
      // start; never wipe its state with this load's success.
      if (!stillCurrent()) return;
      setDeckState(deckKey, { ...deckInit(), track, buffer, hotcues, hotcueAuto });
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
      // Round 11: a stale load's failure must never wipe a newer load's
      // state (and its alert would freeze the machine's ticks).
      if (!stillCurrent()) return;
      console.error('Load failed', e);
      setDeckState(deckKey, deckInit());
      if (e instanceof DecodeStageTimeout) {
        debugLog('transport', 'load decode stage timed out', deckId, {
          track: file.name, stage: e.stage,
        });
      }
      alert(`Could not load ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }, [setDeckState, traktor, ensurePeaks, noteLibrarySaveError, getDecodeCtx]);

  // Restored library tracks load WITHOUT re-analysis: the stored beat grid,
  // key, and peaks are already the track's analysis (a Traktor-matched
  // track's stored grid IS its Traktor grid). Only the audio is decoded.
  // Hotcues DO come back now: auto hotcues ride in the stored grid and
  // manual edits ride in the record's manualHotcues (manual wins per
  // slot). This deliberately changes the old "restored tracks have no
  // hotcues" behavior for auto/manual values; a fresh-file load still
  // re-applies Traktor/auto defaults when no manual edit exists.
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
    // Round 11: generation-guard the whole load (see loadGenRef).
    const gen = ++loadGenRef.current[deckKey];
    const stillCurrent = () => loadGenRef.current[deckKey] === gen;
    setDeckState(deckKey, { ...deckInit(), analyzing: true, analysisProgress: 0 });
    try {
      // Round 12: robust restored-blob read. Round 11 proved a single
      // whole-blob arrayBuffer() on a restored File can wedge forever
      // (initial read AND same-object retry both timed out at 20s, on
      // 2nd-and-later loads of a played deck, while decode was never
      // reached). No code path explains the wedge, so instead of
      // retrying the identical read, escalate through bypasses, each
      // logged distinctly so the next retest log shows which one worked:
      // (1) direct read of the restored File; (2) a freshly fetched
      // record from IndexedDB (new Blob object, new transaction) read
      // directly; (3) chunked slice reads on the freshest File object
      // available. Worst case stays inside the machine's 120s preparing
      // window (20 + 20 + 20 + 4x10s for a 63MB WAV). Only if all three
      // fail does the load fail loudly below, as before.
      let raw: ArrayBuffer | null = null;
      let readFile: File = track.file;
      try {
        raw = await withDecodeTimeout(track.file.arrayBuffer(), 'arrayBuffer');
      } catch (e) {
        if (!(e instanceof DecodeStageTimeout)) throw e;
        debugLog('transport', 'load blob read timed out, trying library refetch', deckId, {
          track: track.title,
        });
      }
      if (!raw && track.fileKey) {
        try {
          const fresh = await withTimeout(getLibraryRecord(track.fileKey), DECODE_STAGE_TIMEOUT_MS);
          if (fresh?.file) {
            readFile = fresh.file;
            debugLog('transport', 'load restored blob refetched from library', deckId, {
              track: track.title,
            });
            try {
              raw = await withDecodeTimeout(readFile.arrayBuffer(), 'arrayBuffer');
              debugLog('transport', 'load restored blob refetch read succeeded', deckId, {
                track: track.title,
              });
            } catch (e) {
              if (!(e instanceof DecodeStageTimeout)) throw e;
              debugLog('transport', 'load restored blob refetch read timed out, trying chunked read', deckId, {
                track: track.title,
              });
            }
          } else {
            debugLog('transport', 'load library refetch empty, trying chunked read', deckId, {
              track: track.title,
            });
          }
        } catch {
          // Any refetch failure (timeout, missing record, IDB error)
          // just escalates to the chunked read; the load only fails
          // loudly if every strategy fails.
          debugLog('transport', 'load library refetch failed, trying chunked read', deckId, {
            track: track.title,
          });
        }
      }
      if (!raw) {
        try {
          raw = await readBlobChunked(readFile);
          debugLog('transport', 'load chunked read succeeded', deckId, { track: track.title });
        } catch (e) {
          if (!(e instanceof DecodeStageTimeout)) throw e;
          debugLog('transport', 'load chunked read failed', deckId, { track: track.title });
        }
      }
      if (!raw) throw new DecodeStageTimeout('arrayBuffer');
      // Round 11: bounded decode — on a live-context timeout, retry once
      // on the isolated offline context (copying the buffer so the two
      // decodes never share it). A retry success proves the stall was
      // live-context-bound and rescues the load; a second timeout fails
      // loudly below instead of hanging forever.
      let buffer: AudioBuffer;
      try {
        buffer = await withDecodeTimeout(engine.ctx.decodeAudioData(raw), 'decode');
      } catch (e) {
        if (e instanceof DecodeStageTimeout) {
          debugLog('transport', 'load decode timed out, retrying on offline context', deckId, {
            track: track.title,
          });
          buffer = await withDecodeTimeout(getDecodeCtx().decodeAudioData(raw.slice(0)), 'decode');
          debugLog('transport', 'load decode retry succeeded on offline context', deckId, {
            track: track.title,
          });
        } else {
          throw e;
        }
      }
      if (!stillCurrent()) return;
      d.buffer = buffer;
      d.grid = track.beatGrid;
      d.userTempo = 1;
      d.syncBaseTempo = 1;
      d.syncCorr = 1;
      d.nudge = 0;
      // Restored hotcues: manual overrides win per slot, else the stored
      // grid's auto values (tagged AUTO).
      const rHotcues: (number | null)[] = [null, null, null, null];
      const rAuto = [false, false, false, false];
      for (let i = 0; i < 4; i++) {
        if (track.manualHotcues?.[i] != null) rHotcues[i] = track.manualHotcues[i]!;
        else if (track.beatGrid.autoHotcues?.[i] != null) {
          rHotcues[i] = track.beatGrid.autoHotcues[i]!;
          rAuto[i] = true;
        }
      }
      setDeckState(deckKey, { ...deckInit(), track, buffer, hotcues: rHotcues, hotcueAuto: rAuto });
      recorderRef.current?.noteTrack({
        deck: deckKey, title: track.title, artist: track.artist, bpm: track.bpm, key: track.key ?? '',
      });
      // Peaks usually ride along in the record; if an old record lacks
      // them, this falls back to the peaks cache / computation.
      ensurePeaks(track, buffer);
    } catch (e) {
      // Round 11: a stale load's failure must never wipe a newer load's
      // state (and its alert would freeze the machine's ticks).
      if (!stillCurrent()) return;
      console.error('Restored load failed', e);
      setDeckState(deckKey, deckInit());
      if (e instanceof DecodeStageTimeout) {
        debugLog('transport', 'load decode stage timed out', deckId, {
          track: track.title, stage: e.stage,
        });
      }
      alert(`Could not load ${track.title}: ${e instanceof Error ? e.message : e}`);
    }
  }, [setDeckState, ensurePeaks, getDecodeCtx]);

  const loadLibraryTrack = useCallback((trackId: string, deckKey: 'A' | 'B') => {
    const t = tracks.find((x) => x.id === trackId);
    if (!t?.file) return;
    if (t.restored) void loadRestoredTrack(deckKey, t);
    else void loadTrack(deckKey, t.file);
  }, [tracks, loadTrack, loadRestoredTrack]);

  // Library → sampler drag: resolve a dragged row's id to the same
  // File a deck load decodes (placeholder rows carry no file, so a
  // drop of one resolves to null and the pad is left untouched).
  const resolveSamplerTrack = useCallback((trackId: string) => {
    const t = tracks.find((x) => x.id === trackId);
    if (!t?.file) return null;
    return { file: t.file, title: t.title };
  }, [tracks]);

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
      // Quantized launch: with Q on and SYNC on, Play starts at once
      // from the pressed position and the catch-up slew converges
      // phase within about a bar (immediateSync). Otherwise Q on
      // waits for the master's next bar and drops on a downbeat.
      // Q off = the old immediate start (bar-aligned when sync is on).
      if (st.quantize) {
        engine.playQuantized(deckId, { immediateSync: true });
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

  // Traktor-style Set 1.1: re-anchor the beat grid at the playhead. The
  // beat nearest the playhead becomes the new bar-phase origin (that
  // beat's index mod 4 becomes the grid's barPhase, and its time becomes
  // downbeatOffset). Existing beat times are never rewritten; the map
  // is additionally extended BACKWARD from its first beat to 0 at the
  // first section's tempo, so the intro leads in on the same grid and
  // play-from-0 does not jump to the first mapped beat. The anchor's
  // index shifts by the prepend count, so its residue shifts too.
  // Persisted with the grid in the library record like a hand-fixed
  // grid edit.
  const setOneOne = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    const track = st.track;
    if (!track || !st.buffer) return;
    const grid = track.beatGrid;
    if (grid.bpm <= 0) return;
    const pos = engine.position(deckId);
    const spb = 60 / grid.bpm;
    let j: number;
    let anchorTime: number;
    if (grid.beats.length >= 2) {
      const beats = grid.beats;
      let lo = 0;
      let hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] < pos) lo = mid + 1;
        else hi = mid;
      }
      const cand = lo < beats.length ? lo : beats.length - 1;
      const prev = cand > 0 ? cand - 1 : cand;
      j = pos - beats[prev] <= beats[cand] - pos ? prev : cand;
      anchorTime = beats[j];
    } else {
      const off = grid.downbeatOffset >= 0 ? grid.downbeatOffset : grid.firstBeat >= 0 ? grid.firstBeat : 0;
      j = Math.round((pos - off) / spb);
      anchorTime = off + j * spb;
    }
    const ext = extendBeatsBackward(grid.beats, grid.bpmCurve, grid.bpm);
    const barPhase = (((j + ext.prependCount) % 4) + 4) % 4;
    const newGrid: BeatGrid = {
      ...grid,
      beats: ext.beats,
      bpmCurve: ext.bpmCurve,
      barPhase,
      downbeatOffset: Math.max(0, anchorTime),
    };
    const d = engine.decks.get(deckId);
    if (d) d.grid = newGrid;
    const next = { ...track, beatGrid: newGrid };
    setDeckState(deckKey, { ...st, track: next });
    setTracks((ts) => ts.map((t) => (t.id === track.id ? next : t)));
    debugLog('transport', 'grid 1.1 set', deckId, { at: newGrid.downbeatOffset, barPhase, prepended: ext.prependCount });
    if (next.fileKey) {
      void saveLibraryRecord(next).catch((e) => console.warn('Could not persist grid anchor', e));
    }
  }, [deckState, setDeckState, setTracks]);

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
    // Sync-off keeps the current effective tempo in audio (engine
    // release path); mirror it into the fader so the fader never jumps
    // back to the pre-sync manual value. Sync-on leaves the manual
    // tempo alone (it is the return value if sync is later grabbed off).
    const nextTempo = on ? st.tempo : engine.userTempoFor(deckId);
    setDeckState(deckKey, { ...st, syncActive: on, tempo: nextTempo });
  }, [deckState, setDeckState, masterDeck]);

  /**
   * Transport fader grab (Traktor workflow): touching the tempo fader
   * of a synced follower disengages SYNC, and the deck keeps its
   * current tempo — the engine release path already holds the effective
   * tempo as the user tempo, so this only mirrors it into React state
   * and clears the sync flag. Idempotent: a second grab (stale props
   * during the same gesture) is a no-op in audio. Autopilot never calls
   * this — it drives sync through the engine directly — so unattended
   * blends are untouched.
   */
  const tempoGrab = useCallback((deckKey: 'A' | 'B') => {
    const deckId = `deck${deckKey}` as 'deckA' | 'deckB';
    const st = deckState(deckKey);
    if (!st.syncActive || masterDeck === deckId) return;
    engine.setSync(deckId, false);
    setDeckState(deckKey, { ...st, syncActive: false, tempo: engine.userTempoFor(deckId) });
    debugLog('transport', 'tempo grab disengaged sync', deckId, { tempo: engine.userTempoFor(deckId) });
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
  // ROUND 8 GOVERNING BAR (Tim's words: "set it and forget it"):
  // continuity is non-negotiable. Every autopilot failure path must end
  // in continuous musical playback — never silence, never a dead stop,
  // never a paused hold loop with no deck playing. Transitions preserve
  // sync lock and phase (quantized launches, PLL); a blend launched out
  // of phase fails even if the music never stops. Nothing jarring: no
  // sudden drops, no slams into a drop without a blend, no loop starting
  // mid-phrase. When in doubt, a plain well-executed blend beats a
  // clever mode executed badly — tease/extend/sustain are subordinate
  // to this bar, and the confidence gate already enforces it. Judge any
  // future change against an unattended run: autopilot on, transitions
  // in a row, nobody touching anything.
  type ApMachinePhase = 'waiting' | 'preparing' | 'scheduled' | 'crossfading' | 'fallback' | 'generating' | 'teasing';
  interface ApMachine {
    phase: ApMachinePhase;
    playingKey: 'A' | 'B';
    freeKey: 'A' | 'B';
    nextId: string | null;
    nextTitle: string | null;
    /** Stable identity of the armed pick (fileKey survives fresh-load id minting; see apAdoptArmed). */
    nextFileKey: string | null;
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
    eqSnap: { outLow: number; inLow: number; outMid: number; outHigh: number } | null;
    loadStartWall: number;
    /** Round 10: wall time the current load's wait began (preparing entry) — bounds the analyzing extension below. */
    loadWaitSince: number;
    failedIds: string[];
    recentIds: string[];
    fallbackLoop: { start: number; end: number } | null;
    genAttempted: boolean;
    genToken: number;
    genBridge: { buffer: AudioBuffer; grid: BeatGrid; key: string } | null;
    genError: string | null;
    /** Round 6 smart mix-in plan for this cycle (null until the next track arms). */
    plan: SmartPlan | null;
    /** Ranked fixes 5+6: transition type + strip line for this pair (null until the plan/guards run). */
    transType: TransitionType | null;
    transNote: string | null;
    /** Fix 3 auto-gain: dB applied to the incoming deck's trim this cycle (null when peaks were missing). */
    autoGainDb: number | null;
    /** Fix 3: incoming deck trim before auto-gain (restored on takeover, NEVER at finish — the match persists). */
    trimSnap: number | null;
    /** Fix 8: contingency branch fired this transition (once only) + its strip line. */
    contingencyFired: string | null;
    contingencyNote: string | null;
    /** Fix 8: consecutive blend ticks with the PLL unlocked past half a beat (echo-finish at 3). */
    pllBadTicks: number;
    /** Fix 6 echo-out: audio time of the outgoing cut + end of the delay tail. */
    echoCutAt: number | null;
    echoTailUntil: number | null;
    /** Fix 6: saved global FX state while an echo tail rings (restored at finish). */
    fxSaved: { type: FxType; params: [number, number, number]; wet: number; enabled: boolean } | null;
    /** Fix 6: outgoing deck's FX send before the echo (restored at finish). */
    fxSendSaved: number | null;
    /** Fix 6: true when this transition swept filters (restored at finish). */
    filterUsed: boolean;
    /** Fix 2: outgoing mid/high ease window around the swap (UI mirror replays it). */
    easeStartAt: number | null;
    easeEndAt: number | null;
    easeFromMid: number;
    easeFromHigh: number;
    easeToMid: number;
    easeToHigh: number;
    /** Tease: release armed once the outgoing track reaches the blend start. */
    teaseArmed: boolean;
    /** Tease: loop released (crossfade running). */
    teaseReleased: boolean;
    /** Tease: previous tick's incoming position (wrap detection for the release window). */
    teasePrevIn: number;
    /** Tease: incoming low-EQ value before autopilot cut it (restored on takeover). */
    teaseEqSnap: number | null;
    /** Extend: loop released at a downbeat into the main part. */
    extendReleased: boolean;
    /** Live bass swap: audio time + duration + from-values of the executed swap (the UI mirror replays it). */
    swapStartAt: number | null;
    swapDur: number;
    swapFromOut: number;
    swapFromIn: number;
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
    nextFileKey: null,
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
    loadWaitSince: 0,
    failedIds: [],
    recentIds,
    fallbackLoop: null,
    genAttempted: false,
    genToken: 0,
    genBridge: null,
    genError: null,
    plan: null,
    transType: null,
    transNote: null,
    autoGainDb: null,
    trimSnap: null,
    contingencyFired: null,
    contingencyNote: null,
    pllBadTicks: 0,
    echoCutAt: null,
    echoTailUntil: null,
    fxSaved: null,
    fxSendSaved: null,
    filterUsed: false,
    easeStartAt: null,
    easeEndAt: null,
    easeFromMid: 0,
    easeFromHigh: 0,
    easeToMid: 0,
    easeToHigh: 0,
    teaseArmed: false,
    teaseReleased: false,
    teasePrevIn: 0,
    teaseEqSnap: null,
    extendReleased: false,
    swapStartAt: null,
    swapDur: 0,
    swapFromOut: 0,
    swapFromIn: -1,
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

  /** Automated mid/high-EQ move (fix 2 ease-out): same mirror pattern as apSetEq. */
  const apSetEqBand = (key: 'A' | 'B', band: 'mid' | 'high', val: number) => {
    const field = band === 'mid' ? 'eqMid' : 'eqHigh';
    const cur = chRef.current[key][field];
    if (Math.abs(cur - val) <= 0.01) return;
    engine.setEqAuto(`deck${key}`, band, val);
    const next = { ...chRef.current[key], [field]: val };
    (key === 'A' ? setChA : setChB)(next);
  };

  /** Automated trim move (fix 3 auto-gain): engine call + knob state kept in sync. */
  const apSetTrim = (key: 'A' | 'B', val: number) => {
    const cur = chRef.current[key].trim;
    if (Math.abs(cur - val) <= 0.01) return;
    engine.setTrim(`deck${key}`, val);
    const next = { ...chRef.current[key], trim: val };
    (key === 'A' ? setChA : setChB)(next);
  };

  /**
   * Fix 3 auto-gain: match the incoming deck's loudness to the outgoing
   * deck's before any launch path runs. Snapshots the incoming trim so
   * takeover/pause paths can undo it; the finish path deliberately does
   * NOT restore it (the matched level must persist for the now-playing
   * track). No-op when either track lacks peaks (loudness unknown).
   */
  const apApplyAutoGain = (m: ApMachine) => {
    // Idempotent per cycle: apScheduleBlend routes to the tease/sustain
    // launchers after calling this, and those launchers call it too
    // (they are also entered directly from the waiting tick). A fresh
    // machine per cycle resets trimSnap, so this never skips a new pair.
    if (m.trimSnap != null) return;
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    if (!pSt.track || !fSt.track) return;
    const g = autoGainDb(pSt.track, fSt.track);
    if (!g) return;
    const cur = chRef.current[m.freeKey].trim;
    m.trimSnap = cur;
    m.autoGainDb = g.gainDb;
    const next = Math.min(2, Math.max(0, cur * Math.pow(10, g.gainDb / 20)));
    apSetTrim(m.freeKey, next);
    debugLog('transport', 'autopilot auto-gain', undefined, {
      to: m.nextTitle, gainDb: g.gainDb, limited: g.limited,
    });
  };

  /** Takeover/pause only: undo auto-gain on the free deck. Never called at finish. */
  const apRestoreTrim = (m: ApMachine) => {
    if (m.trimSnap == null) return;
    apSetTrim(m.freeKey, m.trimSnap);
    m.trimSnap = null;
    m.autoGainDb = null;
  };

  /**
   * Fix 6 echo-out arm: save the global FX state, switch to a beat delay
   * with a long-ish feedback tail, and raise the OUTGOING deck's send.
   * The incoming deck's send is untouched (normally 0, so it stays dry).
   * Returns the tail end; the tick pauses the outgoing deck at cutAt
   * and the finish restores the saved FX state.
   */
  const apArmEcho = (m: ApMachine, cutAt: number): number => {
    const pId = `deck${m.playingKey}`;
    m.fxSaved = {
      type: engine.fx.type,
      params: [...engine.fx.params] as [number, number, number],
      wet: engine.fx.wet,
      enabled: engine.fx.enabled,
    };
    const savedSend = chRef.current[m.playingKey].fxSend;
    m.fxSendSaved = savedSend;
    engine.selectFx('delay');
    engine.setFxParam(0, 0.55); // feedback: tail rings ~2.5s, does not run away
    engine.setFxParam(1, 0.5);
    engine.setFxParam(2, 0.4);
    engine.setFxWet(0.7);
    engine.setFxEnabled(true);
    engine.setFxSend(pId, 0.8);
    const next = { ...chRef.current[m.playingKey], fxSend: 0.8 };
    (m.playingKey === 'A' ? setChA : setChB)(next);
    m.echoCutAt = cutAt;
    m.echoTailUntil = cutAt + 2.5;
    return m.echoTailUntil;
  };

  /** Fix 6 filter fade: lowpass sweep out on the outgoing deck, open on the incoming deck. */
  const apScheduleFilterPair = (m: ApMachine, startAt: number, durSec: number) => {
    engine.scheduleFilterCurve(`deck${m.playingKey}`, 0, -1, startAt, durSec);
    engine.scheduleFilterCurve(`deck${m.freeKey}`, -1, 0, startAt, durSec);
    m.filterUsed = true;
  };

  /**
   * Fix 2 ease-out: after (before=false) or before (before=true) the
   * bass swap, ease the outgoing mids/highs down over one phrase so the
   * outgoing track thins instead of fighting the incoming one. Targets
   * only ever move DOWN from the snapshot (a DJ-cut band is never
   * raised back by automation). The window is clipped to the blend so a
   * late live swap still gets a partial ease instead of none. No-op
   * when the snapshot is already below the targets.
   */
  const apScheduleEaseForSwap = (
    m: ApMachine,
    swapStartAt: number,
    opts: { before: boolean; phraseSec: number },
  ) => {
    if (!m.eqSnap) return;
    const toMid = Math.min(m.eqSnap.outMid, -0.3);
    const toHigh = Math.min(m.eqSnap.outHigh, -0.5);
    if (toMid === m.eqSnap.outMid && toHigh === m.eqSnap.outHigh) return;
    const nowAudio = engine.ctx.currentTime;
    const start = opts.before
      ? Math.max(nowAudio, swapStartAt - opts.phraseSec)
      : swapStartAt;
    const end = opts.before ? swapStartAt : Math.min(m.blendEndAt, swapStartAt + opts.phraseSec);
    if (end <= start) return;
    engine.scheduleEqCurve(`deck${m.playingKey}`, 'mid', m.eqSnap.outMid, toMid, start, end - start);
    engine.scheduleEqCurve(`deck${m.playingKey}`, 'high', m.eqSnap.outHigh, toHigh, start, end - start);
    m.easeStartAt = start;
    m.easeEndAt = end;
    m.easeFromMid = m.eqSnap.outMid;
    m.easeFromHigh = m.eqSnap.outHigh;
    m.easeToMid = toMid;
    m.easeToHigh = toHigh;
  };

  const apSetCrossfader = (v: number) => {
    setCrossfader(v);
    engine.setCrossfader(v);
  };

  /**
   * Round 7 — VISIBLE AUTOMATION. During a scheduled/crossfading blend
   * the audible moves live on AudioParam curves (they survive a
   * throttled tab), but the DJ must SEE them: this tick-rate mirror
   * replays the same curves into React state ONLY — never engine calls,
   * which would fight the scheduled automation. Crossfader interpolates
   * fromV→toV over the blend; low EQ replays the schedule (incoming
   * held at −1 until the swap window, then ramped to its pre-blend
   * value; outgoing mirrored). A live swap re-times the window from the
   * values apLiveSwapCheck recorded. Before blendStartAt nothing has
   * moved yet, so the mirror stays out of the way.
   */
  const apMirrorUi = (m: ApMachine, nowAudio: number) => {
    if ((m.phase !== 'scheduled' && m.phase !== 'crossfading') || !m.automated) return;
    if (nowAudio < m.blendStartAt) return;
    const p = Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec)));
    const v = m.fromV + (m.toV - m.fromV) * p;
    if (Math.abs(v - crossfaderRef.current) > 0.005) setCrossfader(v);
    if (!m.eqSnap) return;
    // Cut/echo transitions never move the low EQ (no hold, no swap), so
    // the mirror must not replay a phantom swap window for them.
    if (!(m.bassSwapped && m.swapStartAt == null)) {
    const pSt = deckStateRef.current[m.playingKey];
    const barSec = pSt.track ? barSeconds(pSt.track.beatGrid) : 0.5;
    const beatSec = barSec / 4;
    const live = m.bassSwapped && m.swapStartAt != null;
    const ws = live ? m.swapStartAt! : m.blendEndAt - Math.min(beatSec, m.blendSec);
    const we = live ? m.swapStartAt! + m.swapDur : m.blendEndAt;
    const f = nowAudio < ws ? 0 : nowAudio >= we ? 1 : (nowAudio - ws) / Math.max(0.05, we - ws);
    const fromOut = live ? m.swapFromOut : m.eqSnap.outLow;
    const fromIn = live ? m.swapFromIn : -1;
    const outLow = fromOut + (-1 - fromOut) * f;
    const inLow = fromIn + (m.eqSnap.inLow - fromIn) * f;
    const curOut = chRef.current[m.playingKey].eqLow;
    const curIn = chRef.current[m.freeKey].eqLow;
    if (Math.abs(outLow - curOut) > 0.01) {
      (m.playingKey === 'A' ? setChA : setChB)({ ...chRef.current[m.playingKey], eqLow: outLow });
    }
    if (Math.abs(inLow - curIn) > 0.01) {
      (m.freeKey === 'A' ? setChA : setChB)({ ...chRef.current[m.freeKey], eqLow: inLow });
    }
    }
    // Fix 2 ease window: outgoing mids/highs replay snapshot → target.
    if (m.easeStartAt != null && m.easeEndAt != null && nowAudio >= m.easeStartAt) {
      const f = Math.min(1, Math.max(0, (nowAudio - m.easeStartAt) / Math.max(0.05, m.easeEndAt - m.easeStartAt)));
      const mid = m.easeFromMid + (m.easeToMid - m.easeFromMid) * f;
      const high = m.easeFromHigh + (m.easeToHigh - m.easeFromHigh) * f;
      const cur = chRef.current[m.playingKey];
      if (Math.abs(mid - cur.eqMid) > 0.01 || Math.abs(high - cur.eqHigh) > 0.01) {
        (m.playingKey === 'A' ? setChA : setChB)({ ...cur, eqMid: mid, eqHigh: high });
      }
    }
    // Fix 6 filter sweep: outgoing closes, incoming opens over the blend.
    if (m.filterUsed) {
      const outF = -p;
      const inF = -1 + p;
      const curP = chRef.current[m.playingKey];
      const curF = chRef.current[m.freeKey];
      if (Math.abs(outF - curP.filter) > 0.01) {
        (m.playingKey === 'A' ? setChA : setChB)({ ...curP, filter: outF });
      }
      if (Math.abs(inF - curF.filter) > 0.01) {
        (m.freeKey === 'A' ? setChA : setChB)({ ...curF, filter: inF });
      }
    }
  };

  /**
   * Restore pre-transition EQ on both decks (takeover / cycle end):
   * low on both, mid/high on the outgoing deck only (the incoming deck's
   * mids/highs were never automated). Also undoes a filter sweep and an
   * echo-out FX arm when this transition used them.
   */
  const apRestoreEq = (m: ApMachine) => {
    if (m.eqSnap) {
      for (const k of ['A', 'B'] as const) {
        const val = k === m.playingKey ? m.eqSnap.outLow : m.eqSnap.inLow;
        engine.setEq(`deck${k}`, 'low', val, false);
        const next = { ...chRef.current[k], eqLow: val };
        (k === 'A' ? setChA : setChB)(next);
      }
      engine.setEq(`deck${m.playingKey}`, 'mid', m.eqSnap.outMid, false);
      engine.setEq(`deck${m.playingKey}`, 'high', m.eqSnap.outHigh, false);
      const nextOut = { ...chRef.current[m.playingKey], eqMid: m.eqSnap.outMid, eqHigh: m.eqSnap.outHigh };
      (m.playingKey === 'A' ? setChA : setChB)(nextOut);
    }
    if (m.filterUsed) {
      for (const k of ['A', 'B'] as const) {
        engine.setFilter(`deck${k}`, 0);
        const next = { ...chRef.current[k], filter: 0 };
        (k === 'A' ? setChA : setChB)(next);
      }
      m.filterUsed = false;
    }
    if (m.fxSaved) {
      const s = m.fxSaved;
      engine.selectFx(s.type);
      engine.setFxParam(0, s.params[0]);
      engine.setFxParam(1, s.params[1]);
      engine.setFxParam(2, s.params[2]);
      engine.setFxWet(s.wet);
      engine.setFxEnabled(s.enabled);
      const send = m.fxSendSaved ?? 0;
      engine.setFxSend(`deck${m.playingKey}`, send);
      const next = { ...chRef.current[m.playingKey], fxSend: send };
      (m.playingKey === 'A' ? setChA : setChB)(next);
      m.fxSaved = null;
      m.fxSendSaved = null;
      m.echoCutAt = null;
      m.echoTailUntil = null;
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
    // Round 7: the hold loop is a short musical phrase (8 bars, capped
    // at 16), never a span from an outro point to track end. When the
    // playhead is already past the loop end (last bar of the track),
    // jump back into the groove — playing on into silence is not an
    // option the hold is allowed to take.
    const pos = engine.position(`deck${m.playingKey}`);
    const loop = holdLoopFor(pSt.track, pSt.hotcues, pos);
    if (!loop) {
      debugLog('transport', 'autopilot hold loop unavailable', `deck${m.playingKey}`, { pos });
      return;
    }
    engine.setLoop(`deck${m.playingKey}`, loop.start, loop.end);
    setDeckState(m.playingKey, { ...pSt, loop: { start: loop.start, end: loop.end }, loopBars: null });
    m.fallbackLoop = { start: loop.start, end: loop.end };
    // Round 8 — the bar: a hold loop on a STOPPED deck is a dead stop,
    // not a hold. Callers only reach here after a natural end (a user
    // pause lets go earlier and never reaches fallback), so if the deck
    // is not playing, resume it from the loop start: the music keeps
    // going while the machine retries or waits. Never touches a playing
    // deck. The loop start is a downbeat, so the resume is in phrase.
    const wasPlaying = engine.isPlaying(`deck${m.playingKey}`);
    if (loop.jump || !wasPlaying) engine.seek(`deck${m.playingKey}`, loop.start);
    if (!wasPlaying) engine.play(`deck${m.playingKey}`);
    debugLog('transport', 'autopilot hold loop', `deck${m.playingKey}`, {
      start: loop.start, end: loop.end,
      bars: Math.round((loop.end - loop.start) / barSeconds(pSt.track.beatGrid)), jumped: loop.jump,
      resumed: !wasPlaying,
    });
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
  /**
   * Round 8 — armed-pick adoption. Fresh-file loads mint a NEW session id
   * (loadTrack: `t${++trackSeq}`) and replace the library record, so the
   * id recorded at arm time NEVER matches the deck track's id after a
   * fresh load — and the re-pick then excludes the same track as
   * on-deck, which is how a queued pick fell through to Lyria generation
   * and the hold loop while sitting loaded on the free deck. fileKey is
   * the stable identity (see resolvePlaylistTracks: session ids are not
   * stable across reloads). If the free deck holds the armed pick under
   * either identity, adopt the deck's session id so the rest of the
   * machine (armed checks, role swap, recents) stays consistent.
   */
  const apAdoptArmed = (m: ApMachine): boolean => {
    if (m.nextId == null && m.nextFileKey == null) return false;
    const fSt = deckStateRef.current[m.freeKey];
    const t = fSt.track;
    if (!t || !fSt.buffer) return false;
    const idMatch = m.nextId != null && t.id === m.nextId;
    const keyMatch = m.nextFileKey != null && !!t.fileKey && t.fileKey === m.nextFileKey;
    if (!idMatch && !keyMatch) return false;
    if (t.id !== m.nextId) m.nextId = t.id;
    m.nextTitle = t.title;
    return true;
  };

  /**
   * Round 8 — free-deck adoption. The free deck's content IS the next
   * track by construction: if it holds a buffered track that is not the
   * playing track, adopt it as the pick instead of re-picking (which
   * would exclude it as on-deck) or generating. Covers manual loads of
   * a queued track and loads that finished under a new session id.
   * Never adopts the just-finished track still sitting on the free deck
   * after a role swap (it is in recentIds) unless the user explicitly
   * queued it again (queue wins over recents, as in apPick).
   */
  const apAdoptFreeDeck = (m: ApMachine): boolean => {
    const fSt = deckStateRef.current[m.freeKey];
    const pSt = deckStateRef.current[m.playingKey];
    const t = fSt.track;
    if (!t || !fSt.buffer) return false;
    if (pSt.track && t.id === pSt.track.id) return false;
    if (m.recentIds.includes(t.id)) {
      const queueKeys = new Set(
        apQueueRef.current
          .map((id) => tracksRef.current.find((x) => x.id === id)?.fileKey)
          .filter((k): k is string => !!k),
      );
      if (!t.fileKey || !queueKeys.has(t.fileKey)) return false;
    }
    m.nextId = t.id;
    m.nextTitle = t.title;
    m.nextFileKey = t.fileKey ?? null;
    m.nextIsBridge = false;
    m.provisional = false;
    m.synced = false;
    return true;
  };

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
    // Round 9: name a cycled pick in the log — the set progressing past
    // an exhausted library must be visible, not silent.
    if (pick.cycled) {
      debugLog('transport', 'autopilot cycled pick', `deck${m.freeKey}`, { track: pick.track.title });
    }
    m.nextId = pick.track.id;
    m.nextTitle = pick.track.title;
    m.nextFileKey = pick.track.fileKey ?? null;
    m.nextIsBridge = false;
    m.provisional = !pick.fromQueue;
    m.synced = false;
    loadLibRef.current(pick.track.id, m.freeKey);
    debugLog('transport', 'autopilot armed next', `deck${m.freeKey}`, {
      track: pick.track.title, fromQueue: pick.fromQueue, provisional: m.provisional,
      fileKey: pick.track.fileKey ?? null,
    });
  };

  const apBeginPrepare = (m: ApMachine, pick: { track: TrackInfo; fromQueue: boolean; cycled?: boolean }, immediate: boolean, now: number) => {
    const fk = m.freeKey;
    const fSt = deckStateRef.current[fk];
    // Clear any stale loop on the free deck (incl. a previous bridge loop)
    // so the incoming track never inherits it.
    if (fSt.loop) apClearLoop(fk);
    if (pick.fromQueue) setApQueueIds((ids) => ids.filter((id) => id !== pick.track.id));
    // Round 9: name a cycled pick in the log (see apArmNext).
    if (pick.cycled) {
      debugLog('transport', 'autopilot cycled pick', `deck${fk}`, { track: pick.track.title });
    }
    m.nextId = pick.track.id;
    m.nextTitle = pick.track.title;
    m.nextFileKey = pick.track.fileKey ?? null;
    m.nextIsBridge = false;
    m.synced = false;
    m.immediateBlend = immediate;
    m.phase = 'preparing';
    m.loadStartWall = now;
    m.loadWaitSince = now;
    loadLibRef.current(pick.track.id, fk);
    debugLog('transport', 'autopilot preparing', `deck${fk}`, { track: pick.track.title, fromQueue: pick.fromQueue, fileKey: pick.track.fileKey ?? null });
  };

  const apEnterFallback = (m: ApMachine, note: string | null) => {
    m.phase = 'fallback';
    apSetFallbackLoop(m);
    debugLog('transport', 'autopilot fallback', `deck${m.playingKey}`, { note });
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
      debugLog('transport', 'autopilot generation unavailable', undefined, { reason: 'no Gemini key' });
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
    debugLog('transport', 'autopilot generating bridge', undefined, { bars: 4, bpm: spec.bpm });
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
   * Round 6 tease launch: loop the incoming track's 4 bars before its
   * first kick, started exactly on the 1 (quantized to the outgoing
   * track's bar grid via playQuantized — if the user turned quantize
   * off, it starts immediately at the loop start instead, still an
   * incoming downbeat, with sync PLL holding phase from there). The
   * tease plays over a full-energy outgoing track, so the incoming bass
   * is cut now (inaudible side until the release) and the pre-tease
   * value is kept for takeover. The waiting tick releases it at the
   * blend start (see the teasing phase in apTick).
   */
  const apLaunchTease = (m: ApMachine) => {
    const plan = m.plan;
    const fSt = deckStateRef.current[m.freeKey];
    const pSt = deckStateRef.current[m.playingKey];
    const fId = `deck${m.freeKey}`;
    const pId = `deck${m.playingKey}`;
    if (!plan || plan.mode !== 'tease' || !pSt.track || !fSt.track || !fSt.buffer ||
        plan.teaseLoopStart == null || plan.teaseLoopEnd == null) return;
    if (engine.isPlaying(fId)) { m.phase = 'teasing'; return; } // retry guard
    engine.setMaster(pId);
    setMasterDeck(pId as 'deckA' | 'deckB');
    engine.setSync(fId, true);
    m.synced = true;
    const fCh = chRef.current[m.freeKey];
    if (fCh.fader < 0.05) {
      engine.setFader(fId, 0.8);
      (m.freeKey === 'A' ? setChA : setChB)({ ...fCh, fader: 0.8 });
    }
    // Loop region BEFORE launch: the free deck is not playing, so
    // setLoop just arms the region and the quantized source picks it up.
    // One deck-state write (syncActive + loop together): deckStateRef
    // only refreshes on render, so a second spread would clobber the first.
    engine.setLoop(fId, plan.teaseLoopStart, plan.teaseLoopEnd);
    setDeckState(m.freeKey, {
      ...fSt, syncActive: true,
      loop: { start: plan.teaseLoopStart, end: plan.teaseLoopEnd }, loopBars: null,
    });
    engine.playQuantized(fId, { offset: plan.teaseLoopStart });
    m.teaseEqSnap = chRef.current[m.freeKey].eqLow;
    apSetEq(m.freeKey, -1);
    m.phase = 'teasing';
    m.teaseArmed = false;
    m.teaseReleased = false;
    m.teasePrevIn = plan.teaseLoopStart;
    debugLog('transport', 'autopilot tease launched', `deck${m.freeKey}`, {
      loop: [plan.teaseLoopStart, plan.teaseLoopEnd], to: m.nextTitle,
    });
    pushApStatus({
      on: true, phase: 'teasing', playingKey: m.playingKey,
      nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: 'cut',
      note: plan.note,
    });
  };

  /**
   * Round 6 tease release: loop-out into the drop, then a short fade of
   * the outgoing track. Loop-out continues from the exact playhead (1–2
   * beats before the first kick), so the drop plays unlooped from its
   * bar one beat later. The bass switch itself is structural (see
   * apLiveSwapCheck): it fires when the playhead reaches the first kick.
   * eqSnap.inLow is the PRE-TEASE value, so the switch and the fallback
   * both restore the bass the DJ had, not the tease cut.
   */
  const apTeaseRelease = (m: ApMachine) => {
    const plan = m.plan;
    const pSt = deckStateRef.current[m.playingKey];
    const fId = `deck${m.freeKey}`;
    const pId = `deck${m.playingKey}`;
    if (!plan || !pSt.track) return;
    apClearLoop(m.freeKey);
    const fCh = chRef.current[m.freeKey];
    if (fCh.fader < 0.05) {
      engine.setFader(fId, 0.8);
      (m.freeKey === 'A' ? setChA : setChB)({ ...fCh, fader: 0.8 });
    }
    // Fix 3 auto-gain for the tease release (entered from the waiting
    // tick directly, bypassing apScheduleBlend's call).
    apApplyAutoGain(m);
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    const outBarSec = barSeconds(pSt.track.beatGrid);
    m.phase = 'crossfading';
    m.blendSec = Math.max(2, (plan.blendSecBars * outBarSec) / tempoRatio);
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: m.teaseEqSnap ?? chRef.current[m.freeKey].eqLow,
      outMid: chRef.current[m.playingKey].eqMid,
      outHigh: chRef.current[m.playingKey].eqHigh,
    };
    m.bassSwapped = false;
    m.teaseReleased = true;
    engine.cancelDeckAutomation(pId);
    engine.cancelDeckAutomation(fId);
    const startAt = engine.ctx.currentTime;
    m.blendStartAt = startAt;
    m.blendEndAt = startAt + m.blendSec;
    m.automated = true;
    engine.scheduleEqLowHold(fId, -1, startAt); // one-bass rule holds until the structural switch
    engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, m.blendSec);
    const beatSec = outBarSec / 4;
    const swapDur = Math.min(beatSec, m.blendSec);
    const swapStart = m.blendEndAt - swapDur;
    engine.scheduleEqLowCurve(pId, m.eqSnap.outLow, -1, swapStart, swapDur);
    engine.scheduleEqLowCurve(fId, -1, m.eqSnap.inLow, swapStart, swapDur);
    debugLog('transport', 'autopilot tease released', undefined, {
      to: m.nextTitle, blendSec: m.blendSec,
    });
  };

  /**
   * Round 6 outro-sustain launch: loop the outgoing track's last
   * high-energy phrase (set on the playing deck — the same pause/replay
   * mechanism as the fallback outro loop, so the groove holds instead of
   * sagging) and launch the incoming track from its start so its FULL
   * intro plays over the sustained groove. The blend runs until the
   * incoming first kick, where the normal crossfading finish pauses the
   * outgoing; its loop state is cleared by the next cycle's arm, exactly
   * like the fallback loop.
   */
  const apLaunchSustain = (m: ApMachine) => {
    const plan = m.plan;
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    const fId = `deck${m.freeKey}`;
    const pId = `deck${m.playingKey}`;
    if (!plan || plan.mode !== 'sustain' || !pSt.track || !fSt.track || !fSt.buffer ||
        plan.sustainStart == null || plan.sustainEnd == null) return;
    if (engine.isPlaying(fId)) { m.phase = 'crossfading'; return; } // retry guard
    // Sustain loop on the playing deck first: it engages when the
    // playhead reaches the phrase end and then holds the groove.
    engine.setLoop(pId, plan.sustainStart, plan.sustainEnd);
    setDeckState(m.playingKey, {
      ...pSt, loop: { start: plan.sustainStart, end: plan.sustainEnd }, loopBars: null,
    });
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
    // Fix 3 auto-gain for the sustain launch (entered from the waiting
    // tick directly, bypassing apScheduleBlend's call).
    apApplyAutoGain(m);
    const startAt = engine.playQuantized(fId, { offset: plan.launchPos }) ?? engine.ctx.currentTime;
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    const outBarSec = barSeconds(pSt.track.beatGrid);
    m.phase = 'crossfading';
    m.blendSec = Math.max(2, (plan.blendSecBars * outBarSec) / tempoRatio);
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: chRef.current[m.freeKey].eqLow,
      outMid: chRef.current[m.playingKey].eqMid,
      outHigh: chRef.current[m.playingKey].eqHigh,
    };
    m.bassSwapped = false;
    engine.cancelDeckAutomation(pId);
    engine.cancelDeckAutomation(fId);
    m.blendStartAt = startAt;
    m.blendEndAt = startAt + m.blendSec;
    m.automated = true;
    engine.scheduleEqLowHold(fId, -1, startAt);
    engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, m.blendSec);
    const beatSec = outBarSec / 4;
    const swapDur = Math.min(beatSec, m.blendSec);
    const swapStart = m.blendEndAt - swapDur;
    engine.scheduleEqLowCurve(pId, m.eqSnap.outLow, -1, swapStart, swapDur);
    engine.scheduleEqLowCurve(fId, -1, m.eqSnap.inLow, swapStart, swapDur);
    debugLog('transport', 'autopilot sustain blending', undefined, {
      from: pSt.track.title, to: m.nextTitle, blendSec: m.blendSec,
    });
  };

  /**
   * Round 6 extend finish gate: an extend blend finishes only on an
   * incoming downbeat (loop-out into the main part, never mid-bar), or
   * at most a bar past blend end as a safety net. Returns true when the
   * caller should finish (loop cleared first), false to wait a tick.
   */
  const apFinishWithExtendRelease = (m: ApMachine): boolean => {
    if (m.plan?.mode === 'extend' && !m.extendReleased) {
      const fSt = deckStateRef.current[m.freeKey];
      const grid = fSt.track?.beatGrid;
      if (grid) {
        const inPos = engine.position(`deck${m.freeKey}`);
        const lastDb = downbeatAtOrBefore(grid, inPos);
        const barSec = barSeconds(grid);
        const atDownbeat = lastDb != null && inPos - lastDb < 0.5;
        const overdue = engine.ctx.currentTime > m.blendEndAt + barSec;
        if (!atDownbeat && !overdue) return false;
      }
      apClearLoop(m.freeKey);
      m.extendReleased = true;
    }
    apFinishTransition(m);
    return true;
  };

  /**
   * Ranked fix 6: schedule the curve set for a blend's transition type.
   * The caller sets phase/blendStartAt/blendSec/blendEndAt/automated and
   * eqSnap first; this helper may shorten the blend (cut/echo) or
   * re-time it (breakdown) and updates blendSec/blendEndAt to match.
   *   blend (default): low hold + crossfader + fallback swap + mid/high
   *     ease-out before the swap (fix 2).
   *   filter: blend curves + a lowpass sweep pair (fix 6).
   *   breakdown: 4-bar swap into the hole — no bass hold (the incoming
   *     bass opens at once), outgoing bass cut at the join, ease over
   *     the blend. swapStartAt is recorded so the UI mirror replays it.
   *   cut: 0.1s crossfader step, no hold, no swap — bassSwapped is set
   *     so the live swap check and the mirror both stay out of the way.
   *   echo: 1-beat crossfader move + delay tail arm; the tick pauses
   *     the outgoing deck at the cut and the finish restores the FX.
   */
  const apScheduleTypeCurves = (
    m: ApMachine,
    startAt: number,
    blendSec: number,
    beatSec: number,
    phraseSec: number,
    tempoRatio: number,
  ) => {
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    const snap = m.eqSnap;
    if (!snap) return;
    const tType = m.transType ?? 'blend';
    if (tType === 'cut') {
      engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, 0.1);
      m.bassSwapped = true;
      m.blendSec = 0.1;
      m.blendEndAt = startAt + 0.1;
      return;
    }
    if (tType === 'echo') {
      engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, beatSec);
      const tailUntil = apArmEcho(m, startAt + beatSec);
      m.bassSwapped = true;
      m.blendSec = tailUntil - startAt;
      m.blendEndAt = tailUntil;
      return;
    }
    let effBlendSec = blendSec;
    if (tType === 'breakdown') {
      effBlendSec = Math.max(2, (4 * phraseSec) / tempoRatio);
      m.bassSwapped = true;
    }
    m.blendSec = effBlendSec;
    m.blendEndAt = startAt + effBlendSec;
    if (tType !== 'breakdown') engine.scheduleEqLowHold(fId, -1, startAt);
    engine.scheduleCrossfaderCurve(m.fromV, m.toV, startAt, effBlendSec);
    if (tType === 'filter') apScheduleFilterPair(m, startAt, effBlendSec);
    if (tType === 'breakdown') {
      engine.scheduleEqLowCurve(pId, snap.outLow, -1, startAt, beatSec);
      m.swapStartAt = startAt;
      m.swapDur = beatSec;
      m.swapFromOut = snap.outLow;
      m.swapFromIn = snap.inLow;
      apScheduleEaseForSwap(m, startAt, { before: false, phraseSec });
    } else {
      const swapDur = Math.min(beatSec, effBlendSec);
      const swapStart = startAt + effBlendSec - swapDur;
      engine.scheduleEqLowCurve(pId, snap.outLow, -1, swapStart, swapDur);
      engine.scheduleEqLowCurve(fId, -1, snap.inLow, swapStart, swapDur);
      apScheduleEaseForSwap(m, swapStart, { before: true, phraseSec });
    }
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
    // Fix 3 auto-gain runs here for the schedule/immediate paths below.
    // Tease and sustain launchers call it themselves (they are also
    // entered directly from the waiting tick, bypassing this function).
    apApplyAutoGain(m);
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    // Round 6 — tease/sustain never schedule here (they launch from the
    // waiting tick); straight/extend schedule phrase-exactly below.
    const plan = m.plan;
    if (plan?.mode === 'tease') { apLaunchTease(m); return; }
    if (plan?.mode === 'sustain') { apLaunchSustain(m); return; }
    if (plan && (plan.mode === 'straight' || plan.mode === 'extend') && plan.blendStartOut != null) {
      const outBarSec = barSeconds(pSt.track.beatGrid);
      const smartBlendSec = Math.max(2, (plan.blendSecBars * outBarSec) / tempoRatio);
      const nowAudio = engine.ctx.currentTime;
      const blendStartAt = engine.audioTimeAtTrackPos(pId, plan.blendStartOut);
      m.eqSnap = {
        outLow: chRef.current[m.playingKey].eqLow,
        inLow: chRef.current[m.freeKey].eqLow,
        outMid: chRef.current[m.playingKey].eqMid,
        outHigh: chRef.current[m.playingKey].eqHigh,
      };
      m.bassSwapped = false;
      m.blendSec = smartBlendSec;
      m.fromV = crossfaderRef.current;
      m.toV = m.playingKey === 'A' ? 1 : -1;
      if (blendStartAt !== null && blendStartAt > nowAudio + 0.05) {
        // Extend: loop region on the incoming deck BEFORE the scheduled
        // launch (free deck is not playing, so setLoop just arms the
        // region — the scheduled source picks it up at startAt). One
        // deck-state write carrying syncActive (set above) + loop:
        // deckStateRef only refreshes on render, so re-spreading it
        // here would clobber syncActive back to false.
        if (plan.mode === 'extend' && plan.extendLoopStart != null && plan.extendLoopEnd != null) {
          engine.setLoop(fId, plan.extendLoopStart, plan.extendLoopEnd);
          setDeckState(m.freeKey, {
            ...fSt, syncActive: true,
            loop: { start: plan.extendLoopStart, end: plan.extendLoopEnd }, loopBars: null,
          });
        }
        // Phrase-exact launch: blendStartOut is an outgoing downbeat and
        // launchPos is an incoming downbeat a whole number of bars
        // before the first kick, so with sync on the kick lands exactly
        // on an outgoing bar boundary. alignToMaster stays OFF — it
        // would shift launchPos by up to a bar and break the whole-bar
        // distance the plan was built on.
        engine.play(fId, { offset: plan.launchPos, alignToMaster: false, startAt: blendStartAt });
        m.phase = 'scheduled';
        m.blendStartAt = blendStartAt;
        m.blendEndAt = blendStartAt + smartBlendSec;
        m.automated = true;
        apScheduleTypeCurves(m, blendStartAt, smartBlendSec, outBarSec / 4, outBarSec, tempoRatio);
        debugLog('transport', 'autopilot blend scheduled', undefined, { at: blendStartAt, blendSec: m.blendSec, smart: plan.mode, type: m.transType, to: m.nextTitle });
      } else {
        // Due now (late wakeup) or uncomputable — begin now, still
        // audio-scheduled from the current audio time.
        apBeginCrossfade(m, Date.now() / 1000);
      }
      return;
    }
    // Fix 1 (fallback path): the legacy blend length was track-time
    // remainder, which could end mid-phrase. Round it to whole outgoing
    // bars (at least 4) so the fallback blend ends on a bar line too.
    // Fix 4: launch from the first audible sound, not from file start.
    const outBarSec = barSeconds(pSt.track.beatGrid);
    const rawBlendSec = Math.max(2, (pSt.track.duration - m.outroStart) / tempoRatio);
    const blendSecBars = Math.max(4, Math.round((rawBlendSec * tempoRatio) / outBarSec));
    const blendSec = (blendSecBars * outBarSec) / tempoRatio;
    const nowAudio = engine.ctx.currentTime;
    const blendStartAt = engine.audioTimeAtTrackPos(pId, m.outroStart);
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: chRef.current[m.freeKey].eqLow,
      outMid: chRef.current[m.playingKey].eqMid,
      outHigh: chRef.current[m.playingKey].eqHigh,
    };
    m.bassSwapped = false;
    m.blendSec = blendSec;
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    if (blendStartAt !== null && blendStartAt > nowAudio + 0.05) {
      // Audio-scheduled path.
      const launchOffset = fSt.track ? (firstSoundSec(fSt.track) ?? 0) : 0;
      engine.play(fId, { offset: launchOffset, alignToMaster: true, startAt: blendStartAt });
      m.phase = 'scheduled';
      m.blendStartAt = blendStartAt;
      m.blendEndAt = blendStartAt + blendSec;
      m.automated = true;
      apScheduleTypeCurves(m, blendStartAt, blendSec, outBarSec / 4, outBarSec, tempoRatio);
      debugLog('transport', 'autopilot blend scheduled', undefined, { at: blendStartAt, blendSec: m.blendSec, type: m.transType, to: m.nextTitle });
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
    const outPos = engine.position(`deck${m.playingKey}`);
    const inPos = engine.position(`deck${m.freeKey}`);
    const doSwap = () => {
      const beatSec = barSec / 4;
      const swapDur = Math.min(beatSec, Math.max(0.1, m.blendEndAt - nowAudio));
      // Current EQ values from the schedule: flat until the fallback
      // window, then interpolating through it.
      const fbStart = m.blendEndAt - Math.min(beatSec, m.blendSec);
      const span = Math.max(0.1, m.blendEndAt - fbStart);
      const f = nowAudio < fbStart ? 0 : Math.min(1, (nowAudio - fbStart) / span);
      const outNow = m.eqSnap!.outLow + (-1 - m.eqSnap!.outLow) * f;
      const inNow = -1 + (m.eqSnap!.inLow - -1) * f;
      engine.cancelEqAutomation(`deck${m.playingKey}`);
      engine.cancelEqAutomation(`deck${m.freeKey}`);
      engine.scheduleEqLowCurve(`deck${m.playingKey}`, outNow, -1, nowAudio, swapDur);
      engine.scheduleEqLowCurve(`deck${m.freeKey}`, inNow, m.eqSnap!.inLow, nowAudio, swapDur);
      // Fix 2: the outgoing track thins over the next phrase after the swap.
      apScheduleEaseForSwap(m, nowAudio, { before: false, phraseSec: barSec });
      m.bassSwapped = true;
      // Round 7: the UI mirror replays this exact swap window, and the
      // log makes the swap diagnosable (previously it was silent).
      m.swapStartAt = nowAudio;
      m.swapDur = swapDur;
      m.swapFromOut = outNow;
      m.swapFromIn = inNow;
      debugLog('transport', 'autopilot bass swapped', undefined, { mode: m.plan?.mode ?? 'legacy' });
    };
    // Round 6 structural switch (PRIMARY for smart blends): the incoming
    // drop has arrived (playhead at/past its first kick) while the
    // outgoing track is in its outro or its bass has dropped out. The
    // 2-bar guard is waived for tease releases — the drop IS the switch
    // moment there, one beat after the loop-out. Threshold crossing
    // below stays as the fallback when the structure never lines up.
    const plan = m.plan;
    if (plan && plan.mode !== 'fallback' && plan.firstKick != null) {
      const blendAgeOk = m.teaseReleased || nowAudio - m.blendStartAt >= 2 * barSec;
      const outInOutro = plan.outOutro != null && outPos >= plan.outOutro;
      const outBassGone = bassState(trackBassEnvelope(pSt.track), outPos) === 'absent';
      if (blendAgeOk && inPos >= plan.firstKick && (outInOutro || outBassGone)) {
        doSwap();
        return;
      }
    }
    if (nowAudio - m.blendStartAt < 2 * barSec) return;
    if (!swapReady(trackBassEnvelope(pSt.track), outPos, trackBassEnvelope(fSt.track), inPos)) return;
    doSwap();
  };

  /**
   * Fix 8: live contingency monitor, run once per blend tick from the
   * scheduled/crossfading phases. Fires at most once per transition
   * (contingencyFired), only for blend/filter/breakdown types — cut and
   * echo already ARE the fallback, and tease/sustain joins are
   * structural. Every branch re-times AudioParam automation; the tick
   * never steps audio itself. Extend-loop stays plan-time only
   * (extend/sustain modes); a running crossfader curve is stretched,
   * never re-planned.
   */
  const apContingencyCheck = (m: ApMachine, nowAudio: number) => {
    if (m.contingencyFired || !m.eqSnap) return;
    const tType = m.transType ?? 'blend';
    if (tType === 'cut' || tType === 'echo') return;
    // Tease/sustain joins are structural (the kick IS the switch) — a
    // contingency re-time would fight the plan, so they opt out here.
    if (m.plan?.mode === 'tease' || m.plan?.mode === 'sustain') return;
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    if (!pSt.track || !fSt.track) return;
    const outBarSec = barSeconds(pSt.track.beatGrid);
    const inBarSec = barSeconds(fSt.track.beatGrid);
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    // PLL health: syncStatus is null while a launch is queued or the
    // deck is master, so only real unlocked readings count (a null
    // reading neither counts nor resets the streak).
    const pll = engine.syncStatus(`deck${m.freeKey}`);
    if (pll && !pll.locked && Math.abs(pll.errBeats) > 0.5) m.pllBadTicks += 1;
    else if (pll) m.pllBadTicks = 0;
    const outPos = engine.position(`deck${m.playingKey}`);
    const inPos = engine.position(`deck${m.freeKey}`);
    const blendRemainingBars = Math.max(0, (m.blendEndAt - nowAudio) * tempoRatio / outBarSec);
    const kickOverdueBars = m.plan?.firstKick != null && inPos > m.plan.firstKick
      ? (inPos - m.plan.firstKick) / inBarSec
      : 0;
    const outBass = bassState(trackBassEnvelope(pSt.track), outPos);
    const action = decideContingency({
      bassSwapped: m.bassSwapped,
      blendRemainingBars,
      pllBadTicks: m.pllBadTicks,
      kickOverdueBars,
      outBass,
    });
    if (action === 'none') return;
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    const beatSec = outBarSec / 4;
    const progress = Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec)));
    const v = m.fromV + (m.toV - m.fromV) * progress;
    if (action === 'delay-swap') {
      // Next phrase downbeat on the outgoing track (4 bars out), or 4
      // bars from now if the grid cannot place one. The crossfader
      // curve stretches to the new end so the delay is audible, not
      // just bookkeeping; the swap re-times from the CURRENT low values
      // (the frozen fallback-window interpolation), never from the
      // snapshot, so there is no EQ jump at the new swap.
      const swapOutPos = downbeatBarsAfter(pSt.track.beatGrid, outPos, 4);
      let swapAt = swapOutPos != null ? engine.audioTimeAtTrackPos(pId, swapOutPos) : null;
      if (swapAt == null || swapAt <= nowAudio) swapAt = nowAudio + 4 * outBarSec / tempoRatio;
      const newEnd = Math.max(m.blendEndAt, swapAt + beatSec);
      const fbStart = m.blendEndAt - Math.min(beatSec, m.blendSec);
      const span = Math.max(0.1, m.blendEndAt - fbStart);
      const f = nowAudio < fbStart ? 0 : Math.min(1, (nowAudio - fbStart) / span);
      const outNow = m.eqSnap.outLow + (-1 - m.eqSnap.outLow) * f;
      const inNow = -1 + (m.eqSnap.inLow - -1) * f;
      engine.cancelEqAllBands(pId);
      engine.cancelEqAllBands(fId);
      engine.scheduleCrossfaderCurve(v, m.toV, nowAudio, Math.max(0.1, newEnd - nowAudio));
      engine.scheduleEqLowCurve(pId, outNow, -1, swapAt, beatSec);
      engine.scheduleEqLowCurve(fId, inNow, m.eqSnap.inLow, swapAt, beatSec);
      // Ease: if one is already mid-window, cancelling it froze the
      // outgoing track part-thinned — leave it (re-scheduling from the
      // snapshot would jump the mids/highs back up). Otherwise schedule
      // a fresh ease ending at the delayed swap.
      const easeActive = m.easeStartAt != null && m.easeEndAt != null &&
        nowAudio >= m.easeStartAt && nowAudio < m.easeEndAt;
      if (easeActive) {
        m.easeStartAt = null;
        m.easeEndAt = null;
      } else {
        apScheduleEaseForSwap(m, swapAt, { before: true, phraseSec: outBarSec });
      }
      m.swapStartAt = swapAt;
      m.swapDur = beatSec;
      m.swapFromOut = outNow;
      m.swapFromIn = inNow;
      m.bassSwapped = true;
      m.blendEndAt = newEnd;
      m.blendSec = Math.max(m.blendSec, newEnd - m.blendStartAt);
      m.contingencyFired = 'delay-swap';
      m.contingencyNote = 'Contingency: bass swap delayed a phrase';
    } else if (action === 'shorten-cut') {
      engine.cancelEqAllBands(pId);
      engine.cancelEqAllBands(fId);
      engine.scheduleCrossfaderCurve(v, m.toV, nowAudio, 0.1);
      m.bassSwapped = true;
      m.blendEndAt = nowAudio + 0.2;
      m.contingencyFired = 'shorten-cut';
      m.contingencyNote = 'Contingency: blend shortened to a cut';
    } else {
      const tailUntil = apArmEcho(m, nowAudio + beatSec);
      engine.scheduleCrossfaderCurve(v, m.toV, nowAudio, beatSec);
      m.bassSwapped = true;
      m.blendEndAt = tailUntil;
      m.blendSec = Math.max(m.blendSec, tailUntil - m.blendStartAt);
      m.contingencyFired = 'echo-finish';
      m.contingencyNote = 'Contingency: grids diverged — echo finish';
    }
    debugLog('transport', 'autopilot contingency', undefined, { action, to: m.nextTitle });
  };

  const apBeginCrossfade = (m: ApMachine, now: number) => {
    const pSt = deckStateRef.current[m.playingKey];
    const fSt = deckStateRef.current[m.freeKey];
    const pId = `deck${m.playingKey}`;
    const fId = `deck${m.freeKey}`;
    if (!pSt.track) return;
    // Round 6 smart immediate path: quantized launch from the plan's
    // launch position (extend arms its loop first, same as scheduled).
    // playQuantized returns the launch audio time so the curves below
    // start with the deck, not up to a bar early.
    const plan = m.plan;
    const smart = plan && (plan.mode === 'straight' || plan.mode === 'extend') ? plan : null;
    let smartStartAt: number | null = null;
    // Start the incoming deck if it is not already rolling, synced to the
    // playing deck with bar-phase alignment (existing sync facilities).
    if (!engine.isPlaying(fId)) {
      engine.setMaster(pId);
      setMasterDeck(pId as 'deckA' | 'deckB');
      engine.setSync(fId, true);
      setDeckState(m.freeKey, { ...fSt, syncActive: true });
      if (smart) {
        if (smart.mode === 'extend' && smart.extendLoopStart != null && smart.extendLoopEnd != null) {
          engine.setLoop(fId, smart.extendLoopStart, smart.extendLoopEnd);
          // One deck-state write (syncActive + loop): re-spreading the
          // ref here would clobber the syncActive set just above.
          setDeckState(m.freeKey, {
            ...fSt, syncActive: true,
            loop: { start: smart.extendLoopStart, end: smart.extendLoopEnd }, loopBars: null,
          });
        }
        smartStartAt = engine.playQuantized(fId, { offset: smart.launchPos });
      } else {
        // Fix 4: skip leading silence on the legacy immediate launch.
        const launchOffset = fSt.track ? (firstSoundSec(fSt.track) ?? 0) : 0;
        engine.play(fId, { offset: launchOffset, alignToMaster: true });
      }
    }
    // A silent incoming channel would blend into nothing — nudge it up.
    const fCh = chRef.current[m.freeKey];
    if (fCh.fader < 0.05) {
      engine.setFader(fId, 0.8);
      (m.freeKey === 'A' ? setChA : setChB)({ ...fCh, fader: 0.8 });
    }
    // Fix 3 auto-gain for the immediate path.
    apApplyAutoGain(m);
    const tempoRatio =
      masterBpmRef.current > 0 && pSt.track.bpm > 0 ? masterBpmRef.current / pSt.track.bpm : 1;
    m.phase = 'crossfading';
    m.blendSec = smart
      ? Math.max(2, (smart.blendSecBars * barSeconds(pSt.track.beatGrid)) / tempoRatio)
      : m.immediateBlend
        ? Math.max(4, (16 * 60) / (masterBpmRef.current || 124))
        : Math.max(2, (pSt.track.duration - m.outroStart) / tempoRatio);
    m.fromV = crossfaderRef.current;
    m.toV = m.playingKey === 'A' ? 1 : -1;
    m.eqSnap = {
      outLow: chRef.current[m.playingKey].eqLow,
      inLow: chRef.current[m.freeKey].eqLow,
      outMid: chRef.current[m.playingKey].eqMid,
      outHigh: chRef.current[m.playingKey].eqHigh,
    };
    m.bassSwapped = false;
    // Audio-scheduled from now (catch-up path): the crossfader curve and
    // the fallback bass swap are AudioParam automation, so the blend
    // completes on the audio clock even if JS sleeps again mid-blend.
    // Any earlier schedule is cancelled first so curves cannot fight.
    engine.cancelDeckAutomation(pId);
    engine.cancelDeckAutomation(fId);
    const startAt = smartStartAt ?? engine.ctx.currentTime;
    m.blendStartAt = startAt;
    m.blendEndAt = startAt + m.blendSec;
    m.automated = true;
    apScheduleTypeCurves(m, startAt, m.blendSec, barSeconds(pSt.track.beatGrid) / 4, barSeconds(pSt.track.beatGrid), tempoRatio);
    debugLog('transport', 'autopilot blending', undefined, {
      from: pSt.track.title, to: m.nextTitle, blendSec: m.blendSec, type: m.transType,
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
    // Restore pre-transition EQ on both decks (the outgoing deck is
    // paused now, so its snapshot is the sane state for the next cycle),
    // plus any filter sweep or echo-out FX arm this transition used.
    // Trim is deliberately NOT restored here: the auto-gain match
    // persists for the now-playing track (takeover/pause paths restore
    // it via apRestoreTrim).
    apRestoreEq(m);
    engine.pause(pId);
    const nextDeckState = { ...fSt, syncActive: false };
    if (m.nextIsBridge && fSt.buffer) {
      // A generated bridge loops on its deck until a real track is picked.
      // Its loop IS the whole buffer by construction, so it opts out of
      // the round-7 end-of-file clamp (which would shave its last beat).
      engine.setLoop(fId, 0, fSt.buffer.duration, { allowEndAtDuration: true });
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
    // Round 9 — post-transition cycle initialization. This machine IS the
    // next cycle's machine, so it needs the new track's REAL trigger
    // points now: freshMachine leaves prepareAt/outroStart at 0, and a
    // zero-trigger machine fires "trigger missed" on its very first tick
    // (the playhead is always >= 0) and falls straight to hold +
    // generation — the stall after every transition in the round-8
    // retest. The acquisition path in apTick computes these for a fresh
    // machine; do exactly the same here, plus the same watching line so
    // every cycle is visible in the log with real triggers.
    const newSt = deckStateRef.current[next.playingKey];
    if (newSt.track && newSt.buffer) {
      const outro = outroStartSeconds(newSt.track.beatGrid, newSt.track.duration, apOutroRef.current);
      const barSec = barSeconds(newSt.track.beatGrid);
      next.outroStart = outro;
      next.prepareAt = outro - 4 * barSec;
      const pos0 = engine.position(`deck${next.playingKey}`);
      debugLog('transport', 'autopilot watching', `deck${next.playingKey}`, {
        track: newSt.track.title, outroStart: outro, prepareAt: next.prepareAt,
        freeDeck: deckStateRef.current[next.freeKey].track
          ? deckStateRef.current[next.freeKey].track!.title
          : null,
        late: pos0 >= next.prepareAt,
      });
    }
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
      // Round 7: a machine that only pushes status is invisible in the
      // log — one line per machine states what it is watching, so a
      // future "autopilot on, nothing happened" is diagnosable.
      const pos0 = engine.position(`deck${pk}`);
      debugLog('transport', 'autopilot watching', `deck${pk}`, {
        track: st.track!.title, outroStart: outro, prepareAt: m.prepareAt,
        freeDeck: decks[fk].track ? decks[fk].track!.title : null,
        late: pos0 >= m.prepareAt,
      });
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
    if (!engine.isPlaying(pId) && m.phase !== 'crossfading' && m.phase !== 'scheduled' && m.phase !== 'teasing' && !m.recovering) {
      const endedNaturally = !!pSt.track && engine.position(pId) >= pSt.track.duration - 0.5;
      if (endedNaturally && apOnRef.current) {
        if (m.phase === 'preparing' && m.nextId) {
          // A load is already in flight — just blend it in immediately
          // when it arms instead of starting a second load (race).
          m.recovering = true;
          m.immediateBlend = true;
          // Round 10: the playing deck is dead — hold the outro loop so
          // the set never sits in silence while the load finishes (the
          // round-9 stall left 30s+ of dead air here). The loop clears
          // at the next role swap; the incoming blend pauses this deck
          // at the finish.
          apSetFallbackLoop(m);
        } else {
          const pick = apPick(m);
          if (pick) {
            if (pick.fromQueue) setApQueueIds((ids) => ids.filter((id) => id !== pick.track.id));
            // Round 9: name a cycled pick in the log (see apArmNext).
            if (pick.cycled) {
              debugLog('transport', 'autopilot cycled pick', `deck${m.freeKey}`, { track: pick.track.title });
            }
            m.nextId = pick.track.id;
            m.nextTitle = pick.track.title;
            m.nextFileKey = pick.track.fileKey ?? null;
            m.nextIsBridge = false;
            m.phase = 'preparing';
            m.immediateBlend = true;
            m.recovering = true;
            m.loadStartWall = now;
            m.loadWaitSince = now;
            loadLibRef.current(pick.track.id, m.freeKey);
            // Round 10: the playing deck is dead — hold the outro loop
            // so the set never sits in silence while the load finishes
            // (the round-9 stall left 30s+ of dead air here). The loop
            // clears at the next role swap; the incoming blend pauses
            // this deck at the finish.
            apSetFallbackLoop(m);
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
      // Round 8: armed means the free deck holds the pick — resolved by
      // adoption, not by raw id equality (fresh loads mint new ids).
      const armed = apAdoptArmed(m);
      // A plan belongs to the armed pick: if the free deck no longer
      // holds that pick (manual load, failed load), drop it so the next
      // arm re-plans from the new track.
      if (!armed && m.plan && fSt.track?.id !== m.nextId) {
        m.plan = null;
        m.transType = null;
        m.transNote = null;
        m.contingencyFired = null;
        m.contingencyNote = null;
        m.pllBadTicks = 0;
      }
      // Finalize: a queue pick arrived after the provisional auto-pick arm
      // — swap to it (reload the free deck). In a visible tab this always
      // lands; in a throttled tab it may not, and the armed pick plays
      // instead (graceful, never silence).
      if (armed && m.provisional && apQueueRef.current.length > 0) {
        const q = apPick(m);
        if (q && q.fromQueue && q.track.id !== m.nextId && !(m.nextFileKey != null && q.track.fileKey === m.nextFileKey)) {
          if (fSt.loop) apClearLoop(m.freeKey);
          setApQueueIds((ids) => ids.filter((id) => id !== q.track.id));
          m.nextId = q.track.id;
          m.nextTitle = q.track.title;
          m.nextFileKey = q.track.fileKey ?? null;
          m.nextIsBridge = false;
          m.provisional = false;
          m.synced = false;
          m.plan = null;
          m.transType = null;
          m.transNote = null;
          m.loadStartWall = now;
          loadLibRef.current(q.track.id, m.freeKey);
          pushApStatus({
            on: true, phase: 'preparing', playingKey: m.playingKey,
            nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: null, note: null,
          });
          return;
        }
      }
      // Round 6 — smart mix-in plan: computed once per cycle, the first
      // tick where the next track is armed (both grids final by then).
      // The plan re-times the blend triggers; a fallback plan leaves the
      // existing triggers untouched. One debug line per transition.
      if (armed && !m.plan && pSt.track && fSt.track) {
        const plan = planTransition({
          out: pSt.track,
          in: fSt.track,
          outHotcues: pSt.hotcues,
          inHotcues: fSt.hotcues,
          outPos: pos,
          outroBars: apOutroRef.current,
        });
        m.plan = plan;
        // Ranked fixes 5+6: guardrails + transition type for this pair,
        // computed once per cycle alongside the plan. Tease/sustain
        // plans already encode a structural join, so they always keep
        // the blend type (a guardrail note is still shown); straight,
        // extend, and fallback blends get the downgraded type when the
        // pairing fails (key clash, big BPM gap) or a breakdown/cut when
        // the sections demand it. Queue picks are never skipped by this
        // — only the transition type changes.
        {
          const guards: Guardrail = evaluateGuardrails(pSt.track, fSt.track);
          const outBarSec = barSeconds(pSt.track.beatGrid);
          const inBarSec = barSeconds(fSt.track.beatGrid);
          const joinPos = plan.mode !== 'fallback' && plan.blendStartOut != null
            ? plan.blendStartOut
            : m.outroStart;
          const breakdownAtJoin =
            bassState(trackBassEnvelope(pSt.track), joinPos + 2 * outBarSec) === 'absent';
          const outVd = vocalDensity(
            pSt.track,
            Math.max(0, pSt.track.duration - 16 * outBarSec),
            pSt.track.duration,
          );
          const inVd = vocalDensity(
            fSt.track,
            0,
            Math.min(fSt.track.duration, 16 * inBarSec),
          );
          const vocalClash =
            outVd != null && inVd != null &&
            outVd >= VOCAL_DENSE_RATIO && inVd >= VOCAL_DENSE_RATIO;
          let transType = selectTransitionType({
            severity: guards.severity,
            bpmGapPct: guards.bpmGapPct,
            breakdownAtJoin,
            vocalClash,
          });
          if (plan.mode === 'tease' || plan.mode === 'sustain') transType = 'blend';
          m.transType = transType;
          m.transNote = transitionLabel(transType) +
            (guards.severity === 'ok' ? '' : ` · guardrail: ${guards.reasons.join(', ')}`) +
            (vocalClash && transType !== 'cut' ? ' · vocal clash noted' : '');
          debugLog('transport', 'autopilot transition type', undefined, {
            type: transType, severity: guards.severity, reasons: guards.reasons,
            breakdownAtJoin, vocalClash, mode: plan.mode,
          });
        }
        if (plan.mode !== 'fallback') {
          const outBarSec = barSeconds(pSt.track.beatGrid);
          if (plan.mode === 'tease' && plan.teaseStart != null) {
            m.outroStart = plan.outBlendStart ?? m.outroStart;
            m.prepareAt = plan.teaseStart;
          } else if (plan.mode === 'sustain' && plan.sustainStart != null) {
            m.outroStart = plan.sustainStart;
            m.prepareAt = plan.sustainStart;
          } else if (plan.blendStartOut != null) {
            m.outroStart = plan.blendStartOut;
            m.prepareAt = plan.blendStartOut - 4 * outBarSec;
          }
          debugLog('transport', 'autopilot smart plan', undefined, {
            mode: plan.mode, firstKick: plan.firstKick, blendBars: plan.blendBars,
            launchPos: plan.launchPos, blendStartOut: plan.blendStartOut,
            teaseStart: plan.teaseStart,
            teaseLoop: plan.teaseLoopStart != null ? [plan.teaseLoopStart, plan.teaseLoopEnd] : null,
            extendLoop: plan.extendLoopStart != null ? [plan.extendLoopStart, plan.extendLoopEnd] : null,
            sustainLoop: plan.sustainStart != null ? [plan.sustainStart, plan.sustainEnd] : null,
          });
        }
      }
      if (armed && m.plan?.mode === 'tease' && m.plan.teaseStart != null && pos >= m.plan.teaseStart) {
        apLaunchTease(m);
        return;
      }
      if (armed && m.plan?.mode === 'sustain' && m.plan.sustainStart != null && pos >= m.plan.sustainStart) {
        apLaunchSustain(m);
        return;
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
        // then): legacy path — pick and load now. Round 7: when the
        // playhead is already PAST the blend start, say so loudly —
        // silently falling through to a fallback loop is how a missed
        // trigger turned into a 62-second loop in Tim's log.
        if (pos >= m.outroStart) {
          debugLog('transport', 'autopilot trigger missed, recovering', `deck${m.playingKey}`, {
            pos, prepareAt: m.prepareAt, outroStart: m.outroStart,
          });
        }
        // Round 8: an arm is already in flight (the lookahead load is
        // still decoding) — do NOT re-pick and double-load the same
        // track. Move to preparing so the load gets its timeout window
        // and the armed check (with adoption) resolves it.
        if ((m.nextId != null || m.nextFileKey != null) && fSt.analyzing) {
          m.phase = 'preparing';
          m.loadStartWall = now;
          m.loadWaitSince = now;
          debugLog('transport', 'autopilot awaiting arm load', `deck${m.freeKey}`, {
            track: m.nextTitle,
          });
          return;
        }
        // Round 8: the free deck may already hold the next track (a
        // manual load, or a load that finished under a new session id)
        // — adopt it instead of re-picking (which would exclude it as
        // on-deck) or generating. Next tick's armed path proceeds.
        // Generation below is therefore last resort only: it runs only
        // when no queue pick, no auto-pick, and no deck-held pick exist.
        if (apAdoptFreeDeck(m)) {
          debugLog('transport', 'autopilot adopted free deck', `deck${m.freeKey}`, {
            track: m.nextTitle,
          });
          return;
        }
        const pick = apPick(m);
        if (pick) apBeginPrepare(m, pick, false, now);
        else if (!m.genAttempted) apStartGeneration(m);
        else apEnterFallback(m, m.genError);
        return;
      }
      pushApStatus({
        on: true, phase: 'waiting', playingKey: m.playingKey,
        nextTitle: armed ? m.nextTitle : null,
        barsToGo: m.plan && m.plan.mode !== 'fallback'
          ? Math.max(0, Math.ceil((m.plan.triggerPos - pos) / barSeconds(pSt.track.beatGrid)))
          : barsToOutro(pSt.track.beatGrid, pSt.track.duration, pos, apOutroRef.current),
        blendProgress: null, bass: null,
        note: armed ? (m.transNote ?? m.plan?.note ?? null) : null,
      });
      return;
    }

    if (m.phase === 'preparing') {
      const fSt = deckStateRef.current[m.freeKey];
      // Round 8: armed via adoption (fresh loads mint new session ids).
      const armed = apAdoptArmed(m);
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
        // Round 8: the deck may hold the pick under a new session id or
        // a manual load — adopt it, never fail a pick sitting on the
        // deck. Only a genuinely empty/failed load falls through.
        if (apAdoptFreeDeck(m)) {
          debugLog('transport', 'autopilot adopted free deck', `deck${m.freeKey}`, {
            track: m.nextTitle,
          });
        } else if (fSt.analyzing && now < m.loadWaitSince + 120) {
          // Round 10: the deck is still decoding — a load in flight, not
          // a failed load. Failing the pick here is how the round-9
          // stall cascaded: the arm load was still analyzing at the
          // timeout, so the machine abandoned it for a second stalled
          // load, then fell to generation. Extend the window in 20s
          // steps while the deck reports analyzing, bounded at 120s
          // from preparing entry so a truly wedged decode still fails
          // eventually instead of holding the set forever.
          m.loadStartWall = now;
          debugLog('transport', 'autopilot load still analyzing, window extended', `deck${m.freeKey}`, {
            track: m.nextTitle,
          });
        } else {
          // Load timed out — skip to the next candidate, never stall.
          debugLog('transport', 'autopilot load timed out', `deck${m.freeKey}`, {
            track: m.nextTitle, analyzing: fSt.analyzing,
          });
          if (m.nextId) m.failedIds.push(m.nextId);
          const pick = apPick(m);
          if (pick) apBeginPrepare(m, pick, m.immediateBlend, now);
          else if (!m.genAttempted) apStartGeneration(m);
          else apEnterFallback(m, m.genError);
        }
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
      // Fix 6 echo-out: the outgoing deck is paused BY the echo at the
      // cut — that is not a user pause and must not cancel the program
      // (the tail rings until blendEndAt, where the finish restores FX).
      const echoPaused = m.echoCutAt != null && nowAudio >= m.echoCutAt;
      if (!oldAlive && !echoPaused) {
        // Old deck stopped before/during the scheduled blend.
        const endedNaturally = !!pSt.track && engine.position(pId) >= pSt.track.duration - 0.5;
        if (endedNaturally && inStarted && engine.isPlaying(fId)) {
          // Old deck ended at blend end while the incoming deck rolls:
          // finish now (role swap) instead of waiting for blendEndAt.
          apFinishWithExtendRelease(m);
        } else if (!endedNaturally) {
          // User paused mid-blend: cancel the program, cancel a
          // not-yet-started incoming launch, restore EQ + trim, let go.
          engine.cancelDeckAutomation(pId);
          engine.cancelDeckAutomation(fId);
          if (nowAudio < m.blendStartAt) engine.pause(fId);
          if (m.eqSnap) apRestoreEq(m);
          apRestoreTrim(m);
          apRef.current = null;
        }
        // Natural end before the incoming started (should not happen —
        // the blend starts before track end): fall through to the finish
        // watchdog below, which recovers via the normal path.
        if (apRef.current !== m) return;
      }
      if (inStarted && !engine.isPlaying(fId) && nowAudio > m.blendStartAt + 1) {
        // Incoming deck died mid-blend: snap back, restore EQ + trim, let go.
        engine.cancelDeckAutomation(pId);
        engine.cancelDeckAutomation(fId);
        apSetCrossfader(m.fromV);
        if (m.eqSnap) apRestoreEq(m);
        apRestoreTrim(m);
        apRef.current = null;
        return;
      }
      if (inStarted) apLiveSwapCheck(m, nowAudio);
      // Fix 6 echo-out: pause the outgoing deck at the cut (the delay
      // tail rings on); the finish at the tail end restores the FX.
      if (m.echoCutAt != null && nowAudio >= m.echoCutAt && engine.isPlaying(pId)) {
        engine.pause(pId);
      }
      if (inStarted) apContingencyCheck(m, nowAudio);
      apMirrorUi(m, nowAudio);
      if (nowAudio >= m.blendEndAt - 0.05) {
        apFinishWithExtendRelease(m);
        return;
      }
      pushApStatus({
        on: true, phase: 'scheduled', playingKey: m.playingKey,
        nextTitle: m.nextTitle, barsToGo: null,
        blendProgress: nowAudio < m.blendStartAt
          ? null
          : Math.round(Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec))) * 100) / 100,
        bass: m.bassSwapped ? 'swapped' : 'cut',
        note: m.contingencyNote ??
          (inStarted ? m.transNote : 'Blend programmed — starts on the audio clock at the outro.'),
      });
      return;
    }

    // ── teasing: the incoming track loops its pre-kick phrase over the
    // outgoing track at full energy. The tick does NO audible work
    // except the release: once the outgoing track reaches the blend
    // start, arm the release; when the incoming loop is about to wrap
    // at the first kick (2-beat window, or a detected wrap as a safety
    // net), loop-out into the drop and start the fade.
    if (m.phase === 'teasing') {
      const plan = m.plan;
      const fSt = deckStateRef.current[m.freeKey];
      if (!plan || plan.mode !== 'tease' || plan.teaseLoopEnd == null || plan.outBlendStart == null || !fSt.track) {
        apRef.current = null;
        return;
      }
      if (!engine.isPlaying(fId)) {
        // Incoming tease deck died: let go (it was the inaudible side).
        engine.cancelDeckAutomation(pId);
        engine.cancelDeckAutomation(fId);
        if (m.teaseEqSnap != null) apSetEq(m.freeKey, m.teaseEqSnap);
        apRef.current = null;
        return;
      }
      if (!engine.isPlaying(pId)) {
        // Outgoing deck stopped mid-tease: a natural end fades to the
        // tease deck (recovery cut); a user pause stops the tease too
        // and lets go — takeover never fights the user.
        const endedNaturally = !!pSt.track && engine.position(pId) >= pSt.track.duration - 0.5;
        if (endedNaturally) {
          apTeaseRelease(m);
          return;
        }
        engine.pause(fId);
        if (m.teaseEqSnap != null) apSetEq(m.freeKey, m.teaseEqSnap);
        apRef.current = null;
        return;
      }
      const outPos = engine.position(pId);
      const inPos = engine.position(fId);
      if (!m.teaseArmed && outPos >= plan.outBlendStart) m.teaseArmed = true;
      const inBarSec = barSeconds(fSt.track.beatGrid);
      const beatSec = inBarSec / 4;
      const wrapped = inPos < m.teasePrevIn - inBarSec;
      m.teasePrevIn = inPos;
      if (m.teaseArmed && (inPos >= plan.teaseLoopEnd - 2 * beatSec || wrapped)) {
        apTeaseRelease(m);
        return;
      }
      pushApStatus({
        on: true, phase: 'teasing', playingKey: m.playingKey,
        nextTitle: m.nextTitle, barsToGo: null, blendProgress: null, bass: 'cut',
        note: m.teaseArmed ? 'Tease release armed — loop-out into the drop next.' : plan.note,
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
        m.nextFileKey = null;
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
      // Incoming deck died mid-blend: snap back, restore EQ + trim, let go.
      engine.cancelDeckAutomation(pId);
      engine.cancelDeckAutomation(fId);
      apSetCrossfader(m.fromV);
      if (m.eqSnap) apRestoreEq(m);
      apRestoreTrim(m);
      apRef.current = null;
      return;
    }
    const nowAudio = engine.ctx.currentTime;
    apLiveSwapCheck(m, nowAudio);
    // Fix 6 echo-out: pause the outgoing deck at the cut (the delay
    // tail rings on); the finish at the tail end restores the FX.
    if (m.echoCutAt != null && nowAudio >= m.echoCutAt && engine.isPlaying(pId)) {
      engine.pause(pId);
    }
    apContingencyCheck(m, nowAudio);
    apMirrorUi(m, nowAudio);
    // A recovering blend (old deck already dead) finishes on time only
    // — never on old-deck death, which is already true. An echo tail
    // ringing is not a death either: the outgoing deck was paused at
    // the cut on purpose, and the finish waits for the tail end.
    const echoRinging = m.echoTailUntil != null && nowAudio < m.echoTailUntil;
    if (nowAudio >= m.blendEndAt - 0.05 || (!m.recovering && !engine.isPlaying(pId) && !echoRinging)) {
      apFinishWithExtendRelease(m);
      return;
    }
    pushApStatus({
      on: true, phase: 'crossfading', playingKey: m.playingKey,
      nextTitle: m.nextTitle, barsToGo: null,
      blendProgress: Math.round(Math.min(1, Math.max(0, (nowAudio - m.blendStartAt) / Math.max(0.1, m.blendSec))) * 100) / 100,
      bass: m.bassSwapped ? 'swapped' : 'cut',
      note: m.contingencyNote ?? m.transNote,
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
        // Teasing takeover: the tease deck keeps rolling (takeover never
        // interrupts audio), but its autopilot bass cut is undone so the
        // DJ's manual mix is not bass-cut.
        if (m.phase === 'teasing' && m.teaseEqSnap != null) {
          apSetEq(m.freeKey, m.teaseEqSnap);
        }
        if (m.eqSnap) apRestoreEq(m);
        apRestoreTrim(m);
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

  // MIDI — library browse + load reuse loadLibraryTrack exactly (the
  // mouse-load path, including restored-track lazy decode and the
  // pause-first behavior on a playing deck). Empty library or no
  // selection: browse/load are no-ops.
  useEffect(() => {
    const regs = [
      midi.registerControl('library.browse', {
        kind: 'jog',
        onRelative: (d) => {
          const list = tracksRef.current;
          if (!list.length) return;
          const curIdx = list.findIndex((t) => t.id === selectedTrackIdRef.current);
          const next = curIdx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, curIdx + Math.sign(d)));
          setSelectedTrackId(list[next].id);
        },
      }),
      midi.registerControl('deckA.load', { kind: 'button', onButton: (p) => { if (p) { const id = selectedTrackIdRef.current; if (id) loadLibraryTrack(id, 'A'); } } }),
      midi.registerControl('deckB.load', { kind: 'button', onButton: (p) => { if (p) { const id = selectedTrackIdRef.current; if (id) loadLibraryTrack(id, 'B'); } } }),
    ];
    return () => regs.forEach((u) => u());
  }, [loadLibraryTrack]);

  // Clear the hardware selection if its track leaves the library.
  useEffect(() => {
    if (selectedTrackId && !tracks.some((t) => t.id === selectedTrackId)) setSelectedTrackId(null);
  }, [tracks, selectedTrackId]);

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
      onTempoGrab: () => tempoGrab(deckKey),
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
      onSetOneOne: () => setOneOne(deckKey),
      onStop: () => {
        debugLog('transport', 'ui stop (deck panel)', deckId, { playing: engine.isPlaying(deckId) });
        engine.pause(deckId);
        engine.seek(deckId, resolveCue(deckState(deckKey)));
      },
      onHotcue: (i: number, set: boolean) => {
        const hcs = [...st.hotcues];
        if (set || hcs[i] === null) {
          hcs[i] = engine.position(deckId);
          // A manual set clears the AUTO tag for that slot and persists
          // as a manual override, so it survives reloads (manual wins
          // over auto and Traktor on every later load).
          const auto = [...(st.hotcueAuto ?? [false, false, false, false])];
          auto[i] = false;
          let nextSt = { ...st, hotcues: hcs, hotcueAuto: auto };
          const track = st.track;
          if (track && track.fileKey) {
            const manuals: (number | null)[] = [...(track.manualHotcues ?? [null, null, null, null])];
            manuals[i] = hcs[i];
            const next = { ...track, manualHotcues: manuals };
            nextSt = { ...nextSt, track: next };
            setTracks((ts) => ts.map((t) => (t.id === track.id ? next : t)));
            void saveLibraryRecord(next).catch((e) => console.warn('Could not persist manual hotcue', e));
          }
          setDeckState(deckKey, nextSt);
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
            onClick={() => setHelpOpen((o) => !o)}
            className={`rounded px-3 py-1.5 text-xs font-bold ${helpOpen ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            title="How to mix on these decks"
          >
            ? How to mix
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

      {helpOpen && (
        <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-bold text-zinc-100">How to mix on these decks</span>
            <button
              onClick={() => setHelpOpen(false)}
              className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Close ✕
            </button>
          </div>
          <ol className="grid list-decimal gap-x-6 gap-y-1 pl-5 text-xs leading-relaxed text-zinc-400 md:grid-cols-2">
            <li><span className="text-zinc-200">Load a track on each deck</span> with Add music, or drag a track from the library onto a deck.</li>
            <li><span className="text-zinc-200">Press SYNC on the deck that joins.</span> The MASTER deck sets the tempo; the other deck follows it and holds phase.</li>
            <li><span className="text-zinc-200">Watch the PHASE meter</span> in the sync view. Near zero means the downbeats line up. If it walks, the beat grids disagree.</li>
            <li><span className="text-zinc-200">Beats still drifting?</span> Check the grid confidence under the waveform. If the downbeat is off, pause on a downbeat and hit the 1.1 button to re-anchor the grid.</li>
            <li><span className="text-zinc-200">QTZ on means CUE drops on the next bar, and Play with SYNC starts at once, then slews into phase within about a bar.</span> Turn QTZ off for manual, off-grid starts.</li>
            <li><span className="text-zinc-200">Blend with the crossfader and the EQs.</span> Cut the bass on the incoming deck, swap the basses at the drop, then move the crossfader across. Loops: pick a bar size, and Loop out keeps playing from the playhead.</li>
          </ol>
        </div>
      )}

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
            isMaster: masterDeck === 'deckA',
            artist: deckA.track?.artist,
            fileSize: deckA.track?.file?.size,
            format: fileExt(deckA.track?.file),
            stability: deckA.track?.beatGrid.tempoStability,
            buffer: deckA.buffer, grid: deckA.track?.beatGrid ?? null, peaks: deckA.track?.peaks ?? null,
            bpm: deckA.track?.bpm ?? 0, isPlaying: engine.isPlaying('deckA'),
            queued: engine.pendingLaunchAt('deckA') !== null,
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
            isMaster: masterDeck === 'deckB',
            artist: deckB.track?.artist,
            fileSize: deckB.track?.file?.size,
            format: fileExt(deckB.track?.file),
            stability: deckB.track?.beatGrid.tempoStability,
            buffer: deckB.buffer, grid: deckB.track?.beatGrid ?? null, peaks: deckB.track?.peaks ?? null,
            bpm: deckB.track?.bpm ?? 0, isPlaying: engine.isPlaying('deckB'),
            queued: engine.pendingLaunchAt('deckB') !== null,
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
      <main className="grid items-stretch gap-3 p-3 lg:grid-cols-[1fr_460px_1fr]">
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
          <Sampler resolveTrack={resolveSamplerTrack} />
        </div>
      </main>

      {/* Library */}
      <div className="px-3 pb-3">
        <Library
          tracks={tracks}
          masterKey={masterKey}
          onAddFiles={addFiles}
          onLoadToDeck={loadLibraryTrack}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
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

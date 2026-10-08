/**
 * Traktor collection.nml importer.
 *
 * Parses Traktor Pro's library XML and extracts beatgrids, BPM, and hotcues
 * so tracks already analyzed (and hand-fixed) in Traktor load into velz-dj
 * with zero re-analysis. Traktor is the source of truth; our own analyzer
 * is only the fallback for tracks outside the Traktor library.
 *
 * NML reference (Traktor Pro 3):
 *   <ENTRY TITLE=".." ARTIST=".." AUDIO_ID="..">
 *     <LOCATION DIR="/:Music/" FILE="track.mp3" VOLUME=".." VOLUMEID=".."/>
 *     <TEMPO BPM="128.00" BPM_QUALITY="100.0"/>
 *     <CUE_V2 NAME="AutoGrid" TYPE="4" START="1234.56" LEN="0" HOTCUE="-1"/>
 *     <CUE_V2 NAME="Hotcue 1" TYPE="0" START="..." HOTCUE="0"/>
 *   </ENTRY>
 *
 * Cue positions (START/LEN) are in milliseconds. TYPE=4 marks beatgrid
 * anchors; the grid runs at TEMPO BPM from the first anchor. Multiple
 * TYPE=4 anchors = flexible beatgrid (tempo changes between anchors).
 */

import type { BeatGrid } from '../types';

export interface TraktorHotcue {
  /** Hotcue slot 0-7 */
  slot: number;
  /** Name as shown in Traktor */
  name: string;
  /** Position in seconds */
  position: number;
  /** Loop length in seconds (0 = not a loop) */
  loopLength: number;
}

export interface TraktorTrack {
  /** Traktor's internal audio ID */
  audioId: string;
  title: string;
  artist: string;
  /** File name (for matching to local files) */
  fileName: string;
  /** Directory hint from Traktor */
  directory: string;
  grid: BeatGrid;
  hotcues: TraktorHotcue[];
  /** 0..100 — Traktor's own analysis confidence */
  bpmQuality: number;
}

export interface TraktorCollection {
  tracks: TraktorTrack[];
  /** Map from lowercase file name → track, for library matching */
  byFileName: Map<string, TraktorTrack>;
}

const MS_TO_SEC = 0.001;

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? '';
}

function numAttr(el: Element, name: string, fallback = 0): number {
  const v = parseFloat(attr(el, name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Build a BeatGrid from Traktor's tempo + grid anchors.
 * Anchors are TYPE=4 CUE_V2 markers sorted by position. Between anchors,
 * beats run at the BPM implied by the anchor spacing (flexible grid);
 * with a single anchor, beats run at the track BPM throughout.
 */
function buildGridFromAnchors(
  bpm: number,
  anchors: number[], // seconds, sorted
  durationHint: number,
): Omit<BeatGrid, 'method'> {
  const firstBeat = anchors.length > 0 ? anchors[0] : 0;
  const beats: number[] = [];
  const bpmCurve: number[] = [];

  if (anchors.length === 0) {
    return { bpm, confidence: 0.5, downbeatOffset: -1, firstBeat: 0, tempoStability: 1, beats: [], bpmCurve: [] };
  }

  if (anchors.length === 1) {
    // Fixed grid: extrapolate at track BPM
    const spb = 60 / bpm;
    for (let t = firstBeat; t < durationHint; t += spb) beats.push(t);
    for (let i = 0; i < Math.max(0, beats.length - 1); i++) bpmCurve.push(bpm);
  } else {
    // Flexible grid: each anchor-to-anchor span gets its own tempo.
    // Traktor anchors sit on downbeats, so subdivide each span into 4 beats.
    for (let a = 0; a < anchors.length; a++) {
      const start = anchors[a];
      const end = a + 1 < anchors.length ? anchors[a + 1] : durationHint;
      const spanBeats = a + 1 < anchors.length ? 4 : Math.max(1, Math.round((end - start) / (60 / bpm)));
      const localSpb = (end - start) / spanBeats;
      const localBpm = 60 / localSpb;
      for (let b = 0; b < spanBeats && start + b * localSpb < end; b++) {
        beats.push(start + b * localSpb);
        bpmCurve.push(localBpm);
      }
    }
    if (bpmCurve.length >= beats.length) bpmCurve.length = Math.max(0, beats.length - 1);
  }

  // Downbeat = first anchor (Traktor grid markers sit on bar starts)
  return {
    bpm,
    confidence: 0.95, // human-verified in Traktor beats our analyzer
    downbeatOffset: firstBeat,
    firstBeat,
    tempoStability: anchors.length > 1 ? 0.85 : 1,
    beats,
    bpmCurve,
  };
}

const CUE_TYPE_GRID = '4';

/**
 * Parse a Traktor collection.nml string.
 * @param xmlText full text of collection.nml
 * @param durationHint default track length for grid extrapolation when the
 *   actual audio isn't loaded yet (refined on load)
 */
export function parseNml(xmlText: string, durationHint = 600): TraktorCollection {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid NML XML: ' + (parseError.textContent ?? '').slice(0, 200));
  }

  const tracks: TraktorTrack[] = [];
  const byFileName = new Map<string, TraktorTrack[]>();

  const entries = doc.querySelectorAll('COLLECTION > ENTRY');
  entries.forEach((entry) => {
    const audioId = attr(entry, 'AUDIO_ID');
    const title = attr(entry, 'TITLE') || 'Unknown';
    const artist = attr(entry, 'ARTIST') || '';

    const loc = entry.querySelector('LOCATION');
    const fileName = loc ? attr(loc, 'FILE') : '';
    const directory = loc ? attr(loc, 'DIR') : '';

    const tempo = entry.querySelector('TEMPO');
    const bpm = tempo ? numAttr(tempo, 'BPM', 0) : 0;
    const bpmQuality = tempo ? numAttr(tempo, 'BPM_QUALITY', 0) : 0;
    if (bpm <= 0) return; // skip unanalyzed entries

    // Grid anchors: TYPE=4 cues, sorted by position
    const anchors: number[] = [];
    const hotcues: TraktorHotcue[] = [];
    entry.querySelectorAll('CUE_V2').forEach((cue) => {
      const type = attr(cue, 'TYPE');
      const startSec = numAttr(cue, 'START', -1) * MS_TO_SEC;
      if (startSec < 0) return;
      if (type === CUE_TYPE_GRID) {
        anchors.push(startSec);
      } else {
        const hotcue = parseInt(attr(cue, 'HOTCUE') || '-1', 10);
        if (hotcue >= 0 && hotcue <= 7) {
          hotcues.push({
            slot: hotcue,
            name: attr(cue, 'NAME') || `Hotcue ${hotcue + 1}`,
            position: startSec,
            loopLength: numAttr(cue, 'LEN', 0) * MS_TO_SEC,
          });
        }
      }
    });
    anchors.sort((a, b) => a - b);
    hotcues.sort((a, b) => a.slot - b.slot);

    const gridBase = buildGridFromAnchors(bpm, anchors, durationHint);
    const grid: BeatGrid = { ...gridBase, method: 'traktor' };

    const track: TraktorTrack = { audioId, title, artist, fileName, directory, grid, hotcues, bpmQuality };
    tracks.push(track);
    if (fileName) {
      const key = fileName.toLowerCase();
      const list = byFileName.get(key) ?? [];
      list.push(track);
      byFileName.set(key, list);
    }
  });

  // Flatten to first match per file name (duplicates = same file in multiple folders)
  const flat = new Map<string, TraktorTrack>();
  byFileName.forEach((list, key) => flat.set(key, list[0]));

  return { tracks, byFileName: flat };
}

/**
 * Look up a local file in the parsed collection by file name.
 * Returns the Traktor track (with grid + hotcues) or undefined.
 */
export function findTraktorTrack(collection: TraktorCollection, file: File): TraktorTrack | undefined {
  return collection.byFileName.get(file.name.toLowerCase());
}

/**
 * Refine a Traktor grid once the real audio is loaded: clamp the beat map
 * to the actual duration and re-derive the curve. Returns a new grid.
 */
export function refineTraktorGrid(track: TraktorTrack, duration: number): BeatGrid {
  const anchors = track.grid.beats.length > 0 ? [track.grid.beats[0]] : [];
  // Rebuild from the original anchors if we stored them; otherwise clamp.
  const beats = track.grid.beats.filter((b) => b < duration);
  const bpmCurve = track.grid.bpmCurve.slice(0, Math.max(0, beats.length - 1));
  // Extend the tail at track BPM if the hint was short
  if (beats.length > 0) {
    const spb = 60 / track.grid.bpm;
    let t = beats[beats.length - 1] + spb;
    while (t < duration) {
      beats.push(t);
      bpmCurve.push(track.grid.bpm);
      t += spb;
    }
  }
  return { ...track.grid, beats, bpmCurve, firstBeat: anchors[0] ?? track.grid.firstBeat };
}

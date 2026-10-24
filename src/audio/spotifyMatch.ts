/**
 * Spotify playlist matching — METADATA ONLY (Phase 8).
 *
 * Spotify audio can never feed the decks (the Web Playback SDK streams
 * encrypted audio; there are no raw samples to analyze/sync/record, and
 * Spotify's terms prohibit DJ-style mixing). What IS useful: paste a
 * playlist's tracklist and see which tracks you already own locally.
 *
 * Matching is pure string work: normalize (case, punctuation, "feat.",
 * bracketed suffixes, remaster tags) and score token overlap.
 */

import type { TrackInfo } from '../types';

export interface MatchResult {
  line: string;
  status: 'matched' | 'missing';
  track?: TrackInfo;
  /** 0..1 token-overlap score of the winning candidate. */
  score: number;
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(([^)]*(feat|ft\.|remaster|remix|edit|version|mono|stereo)[^)]*)\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function matchTracklist(text: string, library: TrackInfo[]): MatchResult[] {
  const lib = library.map((t) => ({
    track: t,
    combined: tokens(`${t.artist} ${t.title}`),
    titleOnly: tokens(t.title),
  }));

  const results: MatchResult[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Spotify copies as "Title - Artist" or "Artist – Title"; pasted
    // lists vary. Try both readings plus the whole line.
    const parts = line.split(/\s+[-–—]\s+/);
    const candidates = [tokens(line)];
    if (parts.length >= 2) {
      candidates.push(tokens(`${parts[0]} ${parts.slice(1).join(' ')}`));
      candidates.push(tokens(`${parts.slice(1).join(' ')} ${parts[0]}`));
    }

    let best: { track: TrackInfo; score: number } | null = null;
    for (const cand of candidates) {
      for (const entry of lib) {
        const score = Math.max(jaccard(cand, entry.combined), jaccard(cand, entry.titleOnly) * 0.95);
        if (!best || score > best.score) best = { track: entry.track, score };
      }
    }
    if (best && best.score >= 0.55) {
      results.push({ line, status: 'matched', track: best.track, score: best.score });
    } else {
      results.push({ line, status: 'missing', score: best?.score ?? 0 });
    }
  }
  return results;
}

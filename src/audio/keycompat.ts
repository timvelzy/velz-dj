/**
 * Camelot key compatibility — pure, no audio, no DOM.
 *
 * Standard Camelot wheel rules, direction-aware from the master (first arg)
 * toward the candidate (second arg):
 *  - Same key = perfect.
 *  - Same number, other letter (relative major/minor) = compatible.
 *  - Same letter, one wheel step either way (fourth/fifth) = compatible.
 *  - Same letter, +2 wheel steps = energy boost (works, lifts energy).
 *  - Anything else = clash.
 *  - Either key unknown/unparseable = unknown (no badge, never a verdict).
 *
 * Deliberately NOT pitch-shifting: this only REPORTS compatibility so the
 * DJ picks tracks that flow together. Real-time retuning of a playing
 * track into another key is a separate, much bigger engine piece.
 */

export type KeyTier = 'perfect' | 'compatible' | 'energy' | 'clash' | 'unknown';

export function parseCamelot(key: string): { num: number; letter: 'A' | 'B' } | null {
  const m = /^([1-9]|1[0-2])([AB])$/.exec(key.trim().toUpperCase());
  if (!m) return null;
  return { num: Number(m[1]), letter: m[2] as 'A' | 'B' };
}

/** Compatibility of candidate `b` against master `a` (direction matters for energy). */
export function keyCompatibility(a: string, b: string): KeyTier {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 'unknown';
  if (ka.num === kb.num && ka.letter === kb.letter) return 'perfect';
  if (ka.num === kb.num) return 'compatible'; // relative major/minor
  if (ka.letter === kb.letter) {
    const fwd = (kb.num - ka.num + 12) % 12; // wheel steps from master to candidate
    if (fwd === 1 || fwd === 11) return 'compatible'; // fifth / fourth neighbor
    if (fwd === 2) return 'energy'; // energy boost goes UP the wheel
  }
  return 'clash';
}

export function keyCompatibilityLabel(tier: KeyTier): string {
  switch (tier) {
    case 'perfect': return 'SAME KEY';
    case 'compatible': return 'COMPATIBLE';
    case 'energy': return 'ENERGY +2';
    case 'clash': return 'CLASH';
    default: return '';
  }
}

/**
 * Rough musical-key estimation via chromagram + Krumhansl-Schmuckler profiles.
 *
 * This is an ESTIMATE (labeled as such in the UI) — good enough to tell
 * whether a generated loop is wildly out of key with the mix, not a
 * replacement for a trained ear. Uses a Goertzel filterbank at the 12 pitch
 * classes across 3 octaves, then correlates against major/minor profiles.
 */

// Krumhansl-Schmuckler key profiles (C major / C minor), rotated per key
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Returns e.g. "8A" (Camelot) or "" when it can't decide.
 * Camelot: minor keys are "A" numbers, major are "B". C major = 8B, A minor = 8A.
 */
export function detectKey(buffer: AudioBuffer): { key: string; confidence: number } {
  try {
    const sr = buffer.sampleRate;
    const ch = buffer.getChannelData(0);
    // Analyze the middle 30s (skip intros/outros which are often sparse)
    const start = Math.floor(ch.length * 0.25);
    const len = Math.min(Math.floor(sr * 30), ch.length - start);
    if (len <= 0) return { key: '', confidence: 0 };

    // Goertzel at 12 pitch classes × 3 octaves (A1=55Hz base region)
    const chroma = new Float64Array(12);
    const baseFreq = 55; // A1
    for (let pc = 0; pc < 12; pc++) {
      let energy = 0;
      for (let oct = 0; oct < 3; oct++) {
        const f = baseFreq * Math.pow(2, pc / 12) * Math.pow(2, oct);
        const omega = (2 * Math.PI * f) / sr;
        const cosine = Math.cos(omega);
        const coeff = 2 * cosine;
        let s0 = 0, s1 = 0, s2 = 0;
        const step = 4; // subsample for speed
        for (let i = start; i < start + len; i += step) {
          s0 = ch[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
        energy += mag;
      }
      chroma[pc] = energy;
    }

    // Normalize
    let max = 0;
    for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
    if (max <= 1e-9) return { key: '', confidence: 0 };
    for (let i = 0; i < 12; i++) chroma[i] /= max;

    // Correlate against rotated profiles
    let bestScore = -2;
    let bestPc = -1;
    let bestMinor = false;
    for (let pc = 0; pc < 12; pc++) {
      for (const [profile, minor] of [[MAJOR, false], [MINOR, true]] as const) {
        let dot = 0, n1 = 0, n2 = 0;
        for (let i = 0; i < 12; i++) {
          const p = profile[(i - pc + 12) % 12];
          dot += chroma[i] * p;
          n1 += chroma[i] * chroma[i];
          n2 += p * p;
        }
        const score = dot / (Math.sqrt(n1 * n2) + 1e-9);
        if (score > bestScore) {
          bestScore = score;
          bestPc = pc;
          bestMinor = minor;
        }
      }
    }

    if (bestPc < 0 || bestScore < 0.5) return { key: '', confidence: 0 };

    // Camelot: 8A = A minor, 8B = C major (relative keys share the number).
    const minorNum = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]; // pc → number for minor
    const majorNum = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // pc → number for major
    const num = bestMinor ? minorNum[bestPc] : majorNum[bestPc];
    const letter = bestMinor ? 'A' : 'B';
    return { key: `${num}${letter}`, confidence: Math.min(1, Math.max(0, (bestScore - 0.5) * 2)) };
  } catch {
    return { key: '', confidence: 0 };
  }
}

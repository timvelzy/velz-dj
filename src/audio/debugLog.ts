/**
 * Lightweight in-app debug log (item 6).
 *
 * A ring buffer of the last 500 timestamped events, kept deliberately cheap:
 * - No per-frame, per-quantum, or per-sync-tick logging. Ever. Callers log
 *   user actions, transport changes, context/worklet state changes, analysis
 *   results, and caught errors only.
 * - No audio data, no file names beyond a track title, no personal data.
 *   Entries carry small scalar values only.
 * - Safe to import anywhere, including Node-based tests: no DOM access at
 *   module scope. The download helper touches the DOM only when called.
 */

export type LogTag = 'transport' | 'audio' | 'analysis' | 'param' | 'error';

export interface LogEntry {
  /** ms since page load (performance.now), for ordering within a session. */
  ms: number;
  /** Wall-clock ISO timestamp, for pasting into a bug report. */
  at: string;
  tag: LogTag;
  deck?: string;
  msg: string;
  data?: string;
}

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];
type Listener = () => void;
const listeners = new Set<Listener>();

function fmtScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(3) : String(v);
  if (typeof v === 'string') return v.slice(0, 120);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '[obj]';
}

/** Log one event. `data` values are reduced to short scalars — never pass buffers. */
export function debugLog(tag: LogTag, msg: string, deck?: string, data?: Record<string, unknown>): void {
  const line: LogEntry = {
    ms: Math.round(performance.now()),
    at: new Date().toISOString(),
    tag,
    deck,
    msg,
    data: data
      ? Object.entries(data)
          .map(([k, v]) => `${k}=${fmtScalar(v)}`)
          .join(' ')
          .slice(0, 240)
      : undefined,
  };
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* listener failure must never break audio */
    }
  });
}

/** Snapshot of the ring (oldest first). */
export function getLogEntries(): LogEntry[] {
  return [...entries];
}

/** Subscribe to new entries; returns an unsubscribe function. */
export function subscribeLog(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function clearLog(): void {
  entries.length = 0;
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

/** Plain-text rendering for copy/paste into a bug report. */
export function logToText(list: LogEntry[] = entries): string {
  return list
    .map(
      (e) =>
        `${e.at} +${e.ms}ms [${e.tag}]${e.deck ? ` ${e.deck}` : ''} ${e.msg}${e.data ? ` (${e.data})` : ''}`,
    )
    .join('\n');
}

/** Download the log as a .txt file (browser only). */
export function downloadLog(): void {
  const blob = new Blob([logToText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `velz-dj-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

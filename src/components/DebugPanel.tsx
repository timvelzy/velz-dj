/**
 * Debug log panel (item 6): view / copy / download the ring buffer.
 * Rendered by App under the header when the 🐛 Log button is on.
 * No audio data, no personal data — entries carry small scalars only.
 */

import { useEffect, useState } from 'react';
import {
  clearLog,
  downloadLog,
  getLogEntries,
  logToText,
  subscribeLog,
  type LogEntry,
  type LogTag,
} from '../audio/debugLog';

const TAG_COLORS: Record<LogTag, string> = {
  transport: 'text-sky-300',
  audio: 'text-violet-300',
  analysis: 'text-emerald-300',
  param: 'text-zinc-400',
  error: 'text-red-300',
};

const ALL_TAGS: LogTag[] = ['transport', 'audio', 'analysis', 'param', 'error'];

export default function DebugPanel() {
  const [entries, setEntries] = useState<LogEntry[]>(() => getLogEntries());
  const [tags, setTags] = useState<Set<LogTag>>(new Set(ALL_TAGS));
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeLog(() => setEntries(getLogEntries())), []);

  const shown = entries.filter((e) => tags.has(e.tag)).slice(-200).reverse();

  const toggleTag = (t: LogTag) => {
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logToText(entries.filter((e) => tags.has(e.tag))));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — Download still works */
    }
  };

  return (
    <div className="mx-3 mb-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-zinc-200">Debug log</span>
        <span className="text-[11px] text-zinc-500">
          last {entries.length} events (ring holds 500) — paste this to us after a dropout
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {ALL_TAGS.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-1 text-[11px] text-zinc-400">
              <input type="checkbox" checked={tags.has(t)} onChange={() => toggleTag(t)} />
              {t}
            </label>
          ))}
          <button onClick={copy} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button onClick={downloadLog} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
            Download .txt
          </button>
          <button onClick={clearLog} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700">
            Clear
          </button>
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto rounded bg-black p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 && <div className="text-zinc-600">No entries for the selected filters yet.</div>}
        {shown.map((e, i) => (
          <div key={`${e.ms}-${i}`} className="whitespace-pre-wrap break-all">
            <span className="text-zinc-600">{e.at.slice(11, 23)} </span>
            <span className={TAG_COLORS[e.tag]}>[{e.tag}]</span>
            {e.deck && <span className="text-zinc-300"> {e.deck}</span>}
            <span className="text-zinc-200"> {e.msg}</span>
            {e.data && <span className="text-zinc-500"> ({e.data})</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

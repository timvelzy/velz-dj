import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { LoopQueue, type GeneratedLoop, type QueueState } from '../audio/ai';
import { midi } from '../midi';
import Waveform from './Waveform';

interface AIDeckProps {
  queue: LoopQueue;
  masterBpm: number;
  masterKey: string;
  onDropLoop: (loop: GeneratedLoop) => void;
  isPlaying: boolean;
  onStop: () => void;
  currentLoop: GeneratedLoop | null;
  buffer: AudioBuffer | null;
}

export default function AIDeck({ queue, masterBpm, masterKey, onDropLoop, isPlaying, onStop, currentLoop, buffer }: AIDeckProps) {
  const [qs, setQs] = useState<QueueState>(queue.state);
  const [style, setStyle] = useState('deep house drums');
  const [bars, setBars] = useState<4 | 8>(4);
  const [autoQueue, setAutoQueue] = useState(true);

  useEffect(() => queue.subscribe(() => setQs(queue.state)), [queue]);

  useEffect(() => {
    const regs = [
      midi.registerControl('deckC.play', { kind: 'button', onButton: (p) => { if (p) { isPlaying ? onStop() : void 0; } } }),
      midi.registerControl('deckC.drop', {
        kind: 'button',
        onButton: (p) => {
          if (p) {
            const loop = queue.take();
            if (loop) onDropLoop(loop);
          }
        },
      }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, isPlaying]);

  const targetBpm = masterBpm > 0 ? masterBpm : 124;
  const backend = queue.backend;

  const generate = () => {
    void queue.ensure(targetBpm, masterKey, bars, style, engine.ctx, 3);
  };

  useEffect(() => {
    if (autoQueue && backend.isConfigured && masterBpm > 0) {
      void queue.ensure(targetBpm, masterKey, bars, style, engine.ctx, 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBpm, bars, autoQueue]);

  return (
    <div className="rounded-xl border border-violet-900/60 bg-zinc-950 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded bg-violet-500 font-black text-black">AI</span>
        <span className="text-sm font-bold text-violet-200">AI Channel</span>

        {!backend.isConfigured ? (
          <span className="rounded bg-red-900/40 px-2 py-1 text-xs text-red-300">
            No generation backend configured — {backend.statusHint}
          </span>
        ) : (
          <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400">
            Backend: <span className="text-violet-300">{backend.name}</span>
          </span>
        )}

        <span className="text-xs text-zinc-500">
          Target: <span className="font-mono text-zinc-300">{targetBpm.toFixed(1)} BPM</span>
          {masterKey && <span className="font-mono text-amber-300"> · {masterKey}</span>}
          {!masterBpm && <span className="text-amber-400"> (no master playing — using 124)</span>}
        </span>

        <div className="ml-auto flex items-center gap-2 text-xs">
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="style hint"
            className="w-40 rounded bg-zinc-800 px-2 py-1 text-zinc-200"
          />
          <select
            value={bars}
            onChange={(e) => setBars(Number(e.target.value) as 4 | 8)}
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-200"
          >
            <option value={4}>4 bars</option>
            <option value={8}>8 bars</option>
          </select>
          <button
            onClick={generate}
            disabled={!backend.isConfigured || qs.generating}
            className="rounded bg-violet-600 px-3 py-1 font-bold text-white disabled:opacity-40 hover:bg-violet-500"
          >
            {qs.generating ? 'Generating…' : 'Generate'}
          </button>
          <label className="flex items-center gap-1 text-zinc-400">
            <input type="checkbox" checked={autoQueue} onChange={(e) => setAutoQueue(e.target.checked)} />
            Auto-queue
          </label>
          {isPlaying && (
            <button onClick={onStop} className="rounded bg-red-700 px-3 py-1 font-bold text-white hover:bg-red-600">
              Stop AI
            </button>
          )}
        </div>
      </div>

      {qs.error && (
        <div className="mb-2 rounded bg-red-900/30 px-2 py-1 text-xs text-red-300">AI error: {qs.error}</div>
      )}

      {currentLoop && (
        <div className="mb-2 text-xs text-zinc-400">
          Now playing: <span className="text-violet-300">{currentLoop.spec.style}</span>
          {' '}· {currentLoop.spec.bars} bars @ {currentLoop.spec.bpm.toFixed(1)} BPM
          {currentLoop.key && <span className="text-amber-300"> · key {currentLoop.key}</span>}
          <span className="text-zinc-600"> · via {currentLoop.backendName}</span>
        </div>
      )}

      {buffer && (
        <Waveform
          deckId="deckC"
          buffer={buffer}
          grid={currentLoop?.grid ?? null}
          color="#c084fc"
          height={72}
          loop={null}
          hotcues={[]}
          onSeek={(t) => engine.seek('deckC', t)}
        />
      )}

      {/* Queue */}
      <div className="mt-2 flex gap-2">
        {qs.loops.length === 0 && !qs.generating && (
          <span className="text-xs text-zinc-600">
            {backend.isConfigured
              ? 'Queue is empty — hit Generate (or enable Auto-queue with a master playing).'
              : 'Configure a backend to generate loops.'}
          </span>
        )}
        {qs.loops.map((loop, i) => (
          <button
            key={loop.generatedAt + i}
            onClick={() => onDropLoop(loop)}
            className="group flex-1 rounded-lg border border-violet-800/60 bg-violet-950/30 p-2 text-left hover:border-violet-500"
            title="Drop on the next master bar boundary (1-beat fade-in)"
          >
            <div className="text-xs font-bold text-violet-200">
              {i === 0 ? '▶ NEXT' : `Queued ${i + 1}`} — {loop.spec.style}
            </div>
            <div className="font-mono text-[11px] text-zinc-400">
              {loop.spec.bars} bars · {loop.grid.bpm.toFixed(1)} BPM
              {loop.key && <span className="text-amber-300"> · {loop.key}</span>}
            </div>
            <div className="text-[10px] text-zinc-600">{loop.backendName}</div>
          </button>
        ))}
        {qs.generating && (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-700 p-2 text-xs text-zinc-500">
            Generating loop…
          </div>
        )}
      </div>
    </div>
  );
}

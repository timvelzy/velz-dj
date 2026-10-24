import { useEffect, useState } from 'react';
import { engine, type FxBeatDivision, type FxType } from '../audio/engine';
import { midi } from '../midi';
import { Knob } from './Mixer';

/**
 * Beat-synced FX unit (Phase 6, specs/sampler-and-fx.md §2).
 * Send/return: per-channel sends live on the mixer strips; this panel owns
 * the effect selection, its 3 params, the beat division, wet level, and
 * the bypass. Delay time / flanger rate track the master BPM in the engine.
 */

const EFFECTS: { id: FxType; label: string; params: [string, string, string]; defaults: [number, number, number] }[] = [
  { id: 'delay', label: 'DELAY', params: ['Feedback', 'Tone', 'Echo 2'], defaults: [0.45, 0.5, 0] },
  { id: 'reverb', label: 'REVERB', params: ['Decay', 'Damp', 'Pre-delay'], defaults: [0.45, 0.6, 0.1] },
  { id: 'bitcrush', label: 'CRUSH', params: ['Bits', 'Tone', 'Level'], defaults: [0.45, 0.8, 0.6] },
  { id: 'flanger', label: 'FLANGE', params: ['Depth', 'F.Back', 'Rate'], defaults: [0.5, 0.5, 0.43] },
];

const DIVISIONS: FxBeatDivision[] = ['1/4', '3/8', '1/2', '3/4', '1'];

export default function FxUnit() {
  const [type, setType] = useState<FxType>('delay');
  const [enabled, setEnabled] = useState(true);
  const [wet, setWet] = useState(0.5);
  const [division, setDivision] = useState<FxBeatDivision>('1/2');
  const [params, setParams] = useState<[number, number, number]>([0.45, 0.5, 0]);

  const select = (t: FxType) => {
    const fx = EFFECTS.find((e) => e.id === t)!;
    setType(t);
    setParams(fx.defaults);
    engine.selectFx(t);
    fx.defaults.forEach((v, i) => engine.setFxParam(i as 0 | 1 | 2, v));
  };

  const setParam = (i: 0 | 1 | 2, v: number) => {
    setParams((p) => {
      const next = [...p] as [number, number, number];
      next[i] = v;
      return next;
    });
    engine.setFxParam(i, v);
  };

  const cycle = () => {
    const idx = EFFECTS.findIndex((e) => e.id === type);
    select(EFFECTS[(idx + 1) % EFFECTS.length].id);
  };

  useEffect(() => {
    const regs = [
      midi.registerControl('fx.wet', { kind: 'knob', onAbsolute: (v) => { setWet(v); engine.setFxWet(v); } }),
      midi.registerControl('fx.param1', { kind: 'knob', onAbsolute: (v) => setParam(0, v) }),
      midi.registerControl('fx.param2', { kind: 'knob', onAbsolute: (v) => setParam(1, v) }),
      midi.registerControl('fx.param3', { kind: 'knob', onAbsolute: (v) => setParam(2, v) }),
      midi.registerControl('fx.enable', {
        kind: 'button',
        onButton: (p) => { if (p) { setEnabled((on) => { engine.setFxEnabled(!on); return !on; }); } },
      }),
      midi.registerControl('fx.selectNext', { kind: 'button', onButton: (p) => { if (p) cycle(); } }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const labels = EFFECTS.find((e) => e.id === type)!.params;

  return (
    <div className={`rounded-xl border p-3 ${enabled ? 'border-fuchsia-900/60 bg-zinc-950' : 'border-zinc-800 bg-zinc-950 opacity-80'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => { setEnabled(!enabled); engine.setFxEnabled(!enabled); }}
          className={`h-9 rounded-lg px-3 text-sm font-black ${enabled ? 'bg-fuchsia-600 text-white' : 'bg-zinc-800 text-zinc-500'}`}
          title="FX bypass"
        >
          FX {enabled ? 'ON' : 'OFF'}
        </button>

        <div className="flex gap-1">
          {EFFECTS.map((e) => (
            <button
              key={e.id}
              onClick={() => select(e.id)}
              className={`h-9 rounded px-3 text-xs font-bold ${type === e.id ? 'bg-fuchsia-800 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
            >
              {e.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase text-zinc-500">Beat</span>
          {DIVISIONS.map((d) => (
            <button
              key={d}
              onClick={() => { setDivision(d); engine.setFxBeatDivision(d); }}
              className={`h-8 rounded px-2 font-mono text-xs ${division === d ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
              title="Beat division (delay time / flanger cycle)"
            >
              {d}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-end gap-3">
          {labels.map((label, i) => (
            <Knob
              key={`${type}-${i}`}
              label={label}
              value={params[i]}
              min={0}
              max={1}
              size={44}
              onChange={(v) => setParam(i as 0 | 1 | 2, v)}
            />
          ))}
          <Knob label="Wet" value={wet} min={0} max={1} size={52} onChange={(v) => { setWet(v); engine.setFxWet(v); }} />
        </div>
      </div>
      <div className="mt-1 text-[11px] text-zinc-600">
        Sends are per-channel (FX SEND knob on each strip). Delay + flange stay locked to the master BPM.
      </div>
    </div>
  );
}

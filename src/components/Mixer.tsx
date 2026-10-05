import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { midi } from '../midi';

export interface ChannelState {
  fader: number;
  trim: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  lowKill: boolean;
  midKill: boolean;
  highKill: boolean;
  filter: number;
  cue: boolean;
}

export const defaultChannel = (): ChannelState => ({
  fader: 0.8, trim: 1,
  eqLow: 0, eqMid: 0, eqHigh: 0,
  lowKill: false, midKill: false, highKill: false,
  filter: 0, cue: false,
});

interface MixerProps {
  chA: ChannelState; chB: ChannelState; chC: ChannelState;
  setChA: (c: ChannelState) => void;
  setChB: (c: ChannelState) => void;
  setChC: (c: ChannelState) => void;
  crossfader: number;
  setCrossfader: (v: number) => void;
  masterVol: number;
  setMasterVol: (v: number) => void;
  cueMix: number;
  setCueMix: (v: number) => void;
  phonesLevel: number;
  setPhonesLevel: (v: number) => void;
}

function Knob({ value, onChange, label, size = 44, min = -1, max = 1 }: {
  value: number; onChange: (v: number) => void; label: string; size?: number; min?: number; max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; v: number } | null>(null);
  const norm = (value - min) / (max - min);
  const angle = -135 + norm * 270;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        ref={ref}
        className="relative cursor-ns-resize touch-none rounded-full border-2 border-zinc-700 bg-zinc-900"
        style={{ width: size, height: size }}
        title={`${label} (drag vertical, double-click to reset)`}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dv = (drag.current.y - e.clientY) / 150;
          onChange(Math.min(max, Math.max(min, drag.current.v + dv * (max - min))));
        }}
        onPointerUp={() => { drag.current = null; }}
        onDoubleClick={() => onChange(0)}
      >
        <div
          className="absolute left-1/2 top-1/2 h-[42%] w-[3px] origin-bottom rounded bg-sky-400"
          style={{ transform: `translate(-50%,-100%) rotate(${angle}deg)` }}
        />
        <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-600" />
      </div>
      <span className="text-[9px] uppercase text-zinc-500">{label}</span>
    </div>
  );
}

function Meter({ getLevel, color = '#22c55e' }: { getLevel: () => number; color?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let peak = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = ref.current;
      if (!el) return;
      const v = Math.min(1, getLevel());
      peak = Math.max(v, peak * 0.98);
      const bars = el.children;
      const lit = Math.round(v * bars.length);
      const peakBar = Math.round(peak * bars.length);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i] as HTMLElement;
        const on = i < lit || i === peakBar;
        b.style.background = !on ? '#1c1c22'
          : i > bars.length * 0.85 ? '#ef4444'
          : i > bars.length * 0.65 ? '#f59e0b' : color;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [getLevel, color]);
  return (
    <div ref={ref} className="flex h-24 w-3 flex-col-reverse gap-[2px]">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="h-full w-full rounded-sm" style={{ background: '#1c1c22' }} />
      ))}
    </div>
  );
}

function ChannelStrip({ id, label, accent, ch, set, deckId, midiPrefix }: {
  id: string; label: string; accent: string;
  ch: ChannelState; set: (c: ChannelState) => void;
  deckId: 'deckA' | 'deckB' | 'deckC';
  midiPrefix: string;
}) {
  const upd = (p: Partial<ChannelState>) => {
    const next = { ...ch, ...p };
    set(next);
    engine.setFader(deckId, next.fader);
    engine.setTrim(deckId, next.trim);
    engine.setEq(deckId, 'low', next.eqLow, next.lowKill);
    engine.setEq(deckId, 'mid', next.eqMid, next.midKill);
    engine.setEq(deckId, 'high', next.eqHigh, next.highKill);
    engine.setFilter(deckId, next.filter);
    engine.setCue(deckId, next.cue);
  };

  useEffect(() => {
    const regs = [
      midi.registerControl(`${midiPrefix}.fader`, { kind: 'fader', onAbsolute: (v) => upd({ fader: v }) }),
      midi.registerControl(`${midiPrefix}.eqLow`, { kind: 'knob', onAbsolute: (v) => upd({ eqLow: v * 2 - 1 }) }),
      midi.registerControl(`${midiPrefix}.eqMid`, { kind: 'knob', onAbsolute: (v) => upd({ eqMid: v * 2 - 1 }) }),
      midi.registerControl(`${midiPrefix}.eqHigh`, { kind: 'knob', onAbsolute: (v) => upd({ eqHigh: v * 2 - 1 }) }),
      midi.registerControl(`${midiPrefix}.filter`, { kind: 'knob', onAbsolute: (v) => upd({ filter: v * 2 - 1 }) }),
      midi.registerControl(`${midiPrefix}.cue`, { kind: 'button', onButton: (p) => { if (p) upd({ cue: !ch.cue }); } }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [midiPrefix, ch.cue, ch.fader, ch.eqLow, ch.eqMid, ch.eqHigh, ch.filter]);

  const killBtn = (active: boolean, onClick: () => void, label: string) => (
    <button
      onClick={onClick}
      className={`h-6 w-10 rounded text-[10px] font-bold ${active ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
        <span className="text-xs font-bold text-zinc-200">{label}</span>
      </div>
      <Knob label="trim" value={ch.trim} min={0} max={2} onChange={(v) => upd({ trim: v })} size={40} />
      <div className="flex items-center gap-1">
        <Knob label="hi" value={ch.eqHigh} onChange={(v) => upd({ eqHigh: v })} size={44} />
        {killBtn(ch.highKill, () => upd({ highKill: !ch.highKill }), 'K')}
      </div>
      <div className="flex items-center gap-1">
        <Knob label="mid" value={ch.eqMid} onChange={(v) => upd({ eqMid: v })} size={44} />
        {killBtn(ch.midKill, () => upd({ midKill: !ch.midKill }), 'K')}
      </div>
      <div className="flex items-center gap-1">
        <Knob label="low" value={ch.eqLow} onChange={(v) => upd({ eqLow: v })} size={44} />
        {killBtn(ch.lowKill, () => upd({ lowKill: !ch.lowKill }), 'K')}
      </div>
      <Knob label="filter" value={ch.filter} onChange={(v) => upd({ filter: v })} size={44} />
      <Meter getLevel={() => engine.deckLevel(deckId)} />
      <input
        type="range" min={0} max={1} step={0.01} value={ch.fader}
        onChange={(e) => upd({ fader: Number(e.target.value) })}
        className="h-24 w-2 accent-sky-500"
        style={{ writingMode: 'vertical-lr', direction: 'rtl' } as React.CSSProperties}
        title="Channel fader"
      />
      <button
        onClick={() => upd({ cue: !ch.cue })}
        className={`h-7 w-full rounded text-xs font-bold ${ch.cue ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-400'}`}
      >
        CUE
      </button>
      <span className="sr-only">{id}</span>
    </div>
  );
}

export default function Mixer(props: MixerProps) {
  const { crossfader, setCrossfader } = props;

  useEffect(() => {
    const regs = [
      midi.registerControl('mixer.crossfader', { kind: 'fader', onAbsolute: (v) => setCrossfader(v * 2 - 1) }),
      midi.registerControl('mixer.master', { kind: 'fader', onAbsolute: (v) => props.setMasterVol(v * 1.2) }),
      midi.registerControl('mixer.cueMix', { kind: 'knob', onAbsolute: (v) => props.setCueMix(v) }),
      midi.registerControl('mixer.chA.fader', { kind: 'fader', onAbsolute: (v) => props.setChA({ ...props.chA, fader: v }) }),
      midi.registerControl('mixer.chB.fader', { kind: 'fader', onAbsolute: (v) => props.setChB({ ...props.chB, fader: v }) }),
      midi.registerControl('mixer.chC.fader', { kind: 'fader', onAbsolute: (v) => props.setChC({ ...props.chC, fader: v }) }),
    ];
    return () => regs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.chA.fader, props.chB.fader, props.chC.fader]);

  const applyX = (v: number) => {
    setCrossfader(v);
    engine.setCrossfader(v);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-center text-xs font-bold uppercase tracking-widest text-zinc-500">Mixer</div>
      <div className="flex justify-center gap-2">
        <ChannelStrip id="chA" label="A" accent="#38bdf8" ch={props.chA} set={props.setChA} deckId="deckA" midiPrefix="mixer.chA" />
        <ChannelStrip id="chC" label="AI" accent="#c084fc" ch={props.chC} set={props.setChC} deckId="deckC" midiPrefix="mixer.chC" />
        <ChannelStrip id="chB" label="B" accent="#fb923c" ch={props.chB} set={props.setChB} deckId="deckB" midiPrefix="mixer.chB" />
      </div>

      {/* Crossfader */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
        <div className="mb-1 flex justify-between text-[10px] uppercase text-zinc-500">
          <span>A</span><span>X-Fader</span><span>B</span>
        </div>
        <input
          type="range" min={-1} max={1} step={0.01} value={crossfader}
          onChange={(e) => applyX(Number(e.target.value))}
          className="w-full accent-sky-500"
        />
      </div>

      {/* Master / phones */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center justify-around rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <Meter getLevel={() => engine.masterLevel()} />
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] uppercase text-zinc-500">Master</span>
            <input
              type="range" min={0} max={1.2} step={0.01} value={props.masterVol}
              onChange={(e) => { props.setMasterVol(Number(e.target.value)); engine.setMasterVolume(Number(e.target.value)); }}
              className="h-20 w-2 accent-emerald-500"
              style={{ writingMode: 'vertical-lr', direction: 'rtl' } as React.CSSProperties}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="flex items-center justify-around">
            <Meter getLevel={() => engine.phonesLevel()} color="#f59e0b" />
            <div className="flex flex-col items-center gap-1">
              <span className="text-[10px] uppercase text-zinc-500">Phones</span>
              <input
                type="range" min={0} max={1.2} step={0.01} value={props.phonesLevel}
                onChange={(e) => { props.setPhonesLevel(Number(e.target.value)); engine.setPhonesLevel(Number(e.target.value)); }}
                className="h-20 w-2 accent-amber-500"
                style={{ writingMode: 'vertical-lr', direction: 'rtl' } as React.CSSProperties}
              />
            </div>
          </div>
          <label className="text-[10px] uppercase text-zinc-500">
            Cue/Master
            <input
              type="range" min={0} max={1} step={0.01} value={props.cueMix}
              onChange={(e) => { props.setCueMix(Number(e.target.value)); engine.setCueMix(Number(e.target.value)); }}
              className="w-full accent-amber-500"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

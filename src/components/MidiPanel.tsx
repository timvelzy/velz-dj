import { useEffect, useState } from 'react';
import { BINDABLE_CONTROLS, S8_TEMPLATE, midi } from '../midi';

interface MidiPanelProps {
  onClose: () => void;
}

export default function MidiPanel({ onClose }: MidiPanelProps) {
  const [snap, setSnap] = useState(midi.state);

  useEffect(() => midi.subscribe(() => setSnap(midi.state)), []);
  useEffect(() => {
    if (snap.supported && !snap.connected) void midi.enable();
  }, [snap.supported, snap.connected]);

  const groups = [...new Set(BINDABLE_CONTROLS.map((c) => c.group))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="max-h-[85vh] w-[560px] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-bold text-zinc-100">MIDI Control</div>
          <button onClick={onClose} className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700">
            Close
          </button>
        </div>

        {!snap.supported && (
          <div className="mb-3 rounded bg-red-900/30 p-2 text-xs text-red-300">
            Web MIDI is not available in this browser. Use Chrome or Edge (desktop) for MIDI control.
            The mixer works fine without it.
          </div>
        )}
        {snap.supported && snap.devices.length === 0 && (
          <div className="mb-3 rounded bg-amber-900/30 p-2 text-xs text-amber-300">
            No MIDI devices found. Connect your controller, put the Kontrol S8 in MIDI mode,
            then click Rescan.
          </div>
        )}
        {snap.devices.length > 0 && (
          <div className="mb-3 text-xs text-zinc-400">
            Devices: {snap.devices.map((d) => d.name).join(', ')}
          </div>
        )}
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => void midi.enable()}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            Rescan
          </button>
          <button
            onClick={() => { if (confirm('Clear all MIDI bindings?')) midi.clearAll(); }}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            Clear all bindings
          </button>
        </div>

        {snap.learning && (
          <div className="mb-3 animate-pulse rounded bg-sky-900/40 p-2 text-xs text-sky-200">
            Learning: move the hardware control for “
            {BINDABLE_CONTROLS.find((c) => c.id === snap.learning)?.label}”…
            <button onClick={() => midi.stopLearn()} className="ml-2 underline">cancel</button>
          </div>
        )}

        {/* Kontrol S8 quick template */}
        <div className="mb-4 rounded-lg border border-zinc-800 p-2">
          <div className="mb-1 text-[11px] font-bold uppercase text-zinc-500">
            Kontrol S8 template — click Learn, then move the physical control
          </div>
          <div className="grid max-h-40 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto text-[11px]">
            {S8_TEMPLATE.map((t) => {
              const b = midi.bindingFor(t.controlId);
              return (
                <div key={t.controlId} className="flex items-center justify-between gap-1 py-0.5">
                  <span className="truncate text-zinc-400">{t.physical}</span>
                  <button
                    onClick={() => midi.startLearn(t.controlId)}
                    className={`shrink-0 rounded px-1.5 py-0.5 ${b ? 'bg-emerald-800 text-emerald-200' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                    title={b ? `Bound: ${b.deviceName} ${b.type.toUpperCase()} ${b.number} (ch ${b.channel}) — click to re-learn` : 'Click to learn'}
                  >
                    {b ? '✓' : 'Learn'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Full control list */}
        {groups.map((g) => (
          <div key={g} className="mb-3">
            <div className="mb-1 text-[11px] font-bold uppercase text-zinc-500">{g}</div>
            {BINDABLE_CONTROLS.filter((c) => c.group === g).map((c) => {
              const b = midi.bindingFor(c.id);
              return (
                <div key={c.id} className="flex items-center justify-between border-t border-zinc-900 py-1 text-xs">
                  <span className="text-zinc-300">{c.label}</span>
                  <span className="flex items-center gap-2">
                    {b && (
                      <span className="font-mono text-[10px] text-zinc-500">
                        {b.deviceName.slice(0, 18)} · {b.type.toUpperCase()}{b.number} · ch{b.channel}
                      </span>
                    )}
                    {b && (
                      <button onClick={() => midi.clearBinding(c.id)} className="text-zinc-600 hover:text-red-400" title="Clear binding">✕</button>
                    )}
                    <button
                      onClick={() => midi.startLearn(c.id)}
                      className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700"
                    >
                      {b ? 'Re-learn' : 'Learn'}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

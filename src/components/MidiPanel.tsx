import { useEffect, useRef, useState } from 'react';
import { BINDABLE_CONTROLS, S8_TEMPLATE, midi } from '../midi';

/**
 * Learn-All queue: S8 template controls first (in template order), then the
 * rest of the bindable controls in declared order, deduped, skipping anything
 * that already has a binding. Skipping bound controls at build time is what
 * makes a pass resumable: restart anytime and it picks up where you left off.
 */
function buildLearnAllQueue(templateOnly: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of S8_TEMPLATE) {
    if (!seen.has(t.controlId) && !midi.bindingFor(t.controlId)) {
      seen.add(t.controlId);
      out.push(t.controlId);
    }
  }
  if (!templateOnly) {
    for (const c of BINDABLE_CONTROLS) {
      if (!seen.has(c.id) && !midi.bindingFor(c.id)) {
        seen.add(c.id);
        out.push(c.id);
      }
    }
  }
  return out;
}

function nextUnboundIndex(queue: string[], from: number): number {
  for (let i = from; i < queue.length; i++) {
    if (!midi.bindingFor(queue[i])) return i;
  }
  return -1;
}

function physicalFor(controlId: string): string | undefined {
  return S8_TEMPLATE.find((t) => t.controlId === controlId)?.physical;
}

function labelFor(controlId: string): string {
  return BINDABLE_CONTROLS.find((c) => c.id === controlId)?.label ?? controlId;
}

interface MidiPanelProps {
  onClose: () => void;
}

export default function MidiPanel({ onClose }: MidiPanelProps) {
  const [snap, setSnap] = useState(midi.state);

  useEffect(() => midi.subscribe(() => setSnap(midi.state)), []);
  useEffect(() => {
    if (snap.supported && !snap.connected) void midi.enable();
  }, [snap.supported, snap.connected]);

  // ---- Guided Learn-All pass ----
  // State machine: 'idle' = about to start the current step, 'listening' =
  // waiting for the user to move the hardware control for the current step.
  // The completion effect only fires while 'listening', so Skip/Stop (which
  // set 'idle' first) can never double-advance, and the generic banner's
  // cancel (stopLearn only) ends the pass instead of skipping a step.
  const [learnAll, setLearnAll] = useState<{ queue: string[]; index: number } | null>(null);
  const [learnStep, setLearnStep] = useState<'idle' | 'listening'>('idle');
  const [learnedCount, setLearnedCount] = useState(0);
  const [learnAllMsg, setLearnAllMsg] = useState<string | null>(null);

  const learnAllRef = useRef(learnAll);
  useEffect(() => { learnAllRef.current = learnAll; }, [learnAll]);
  useEffect(() => () => { if (learnAllRef.current) midi.stopLearn(); }, []);

  // Drive: start listening for the current step (skipping anything that got
  // bound since the pass started).
  useEffect(() => {
    if (!learnAll || learnStep !== 'idle') return;
    const { queue } = learnAll;
    let idx = learnAll.index;
    while (idx < queue.length && midi.bindingFor(queue[idx])) idx++;
    if (idx >= queue.length) {
      setLearnAllMsg(
        learnedCount > 0
          ? `Learn-All complete — ${learnedCount} control${learnedCount === 1 ? '' : 's'} learned.`
          : 'Learn-All finished — nothing new was bound.',
      );
      setLearnAll(null);
      return;
    }
    if (idx !== learnAll.index) {
      setLearnAll({ queue, index: idx });
      return;
    }
    setLearnStep('listening');
    midi.startLearn(queue[idx]);
  }, [learnAll, learnStep, learnedCount]);

  // Completion: the manager clears `learning` when a control is learned (or
  // when the user cancels). A new binding for the current step means "learned,
  // advance"; no binding means the user cancelled, so end the pass.
  useEffect(() => {
    if (!learnAll || learnStep !== 'listening' || snap.learning !== null) return;
    const { queue, index } = learnAll;
    if (midi.bindingFor(queue[index])) {
      const n = learnedCount + 1;
      setLearnedCount(n);
      const next = nextUnboundIndex(queue, index + 1);
      if (next === -1) {
        setLearnAllMsg(`Learn-All complete — ${n} control${n === 1 ? '' : 's'} learned.`);
        setLearnAll(null);
        setLearnStep('idle');
      } else {
        setLearnAll({ queue, index: next });
        setLearnStep('idle');
      }
    } else {
      setLearnAll(null);
      setLearnStep('idle');
    }
  }, [learnAll, learnStep, snap.learning, learnedCount]);

  function startLearnAll(templateOnly: boolean): void {
    if (snap.learning) midi.stopLearn();
    setLearnAllMsg(null);
    setLearnedCount(0);
    const queue = buildLearnAllQueue(templateOnly);
    if (queue.length === 0) {
      setLearnAllMsg('All controls in this set are already bound — nothing to learn.');
      return;
    }
    setLearnAll({ queue, index: 0 });
    setLearnStep('idle');
  }

  function skipLearnAllStep(): void {
    if (!learnAll) return;
    midi.stopLearn();
    const next = nextUnboundIndex(learnAll.queue, learnAll.index + 1);
    if (next === -1) {
      setLearnAllMsg(
        learnedCount > 0
          ? `Learn-All complete — ${learnedCount} control${learnedCount === 1 ? '' : 's'} learned.`
          : 'Learn-All finished — nothing new was bound.',
      );
      setLearnAll(null);
    } else {
      setLearnAll({ queue: learnAll.queue, index: next });
    }
    setLearnStep('idle');
  }

  function stopLearnAll(): void {
    midi.stopLearn();
    setLearnAll(null);
    setLearnStep('idle');
  }

  const groups = [...new Set(BINDABLE_CONTROLS.map((c) => c.group))];

  const learnAllCurrent = learnAll ? learnAll.queue[learnAll.index] : undefined;
  const learnAllPhysical = learnAllCurrent ? physicalFor(learnAllCurrent) : undefined;
  const learnAllLabel = learnAllCurrent ? labelFor(learnAllCurrent) : '';

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

        {/* Guided Learn-All pass */}
        <div className="mb-4 rounded-lg border border-zinc-800 p-2">
          <div className="mb-1 text-[11px] font-bold uppercase text-zinc-500">
            Learn-All — walk the controls in order
          </div>
          <p className="mb-2 text-[11px] leading-snug text-zinc-400">
            Steps through each control: move the matching hardware control and
            it auto-advances. Skip any control. Restart anytime —
            already-bound controls are skipped, so a pass resumes where you
            left off. Starting a single Learn ends the pass.
          </p>
          {!learnAll && (
            <div className="flex gap-2">
              <button
                onClick={() => startLearnAll(true)}
                disabled={snap.devices.length === 0}
                className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                title={snap.devices.length === 0 ? 'Connect the S8 first' : 'Walk the S8 template controls in order'}
              >
                Learn S8 controls
              </button>
              <button
                onClick={() => startLearnAll(false)}
                disabled={snap.devices.length === 0}
                className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                title={snap.devices.length === 0 ? 'Connect the S8 first' : 'Walk every bindable control, template first'}
              >
                Learn all controls
              </button>
            </div>
          )}
          {learnAll && learnAllCurrent && (
            <div className="rounded bg-sky-900/30 p-2">
              <div className="text-xs text-sky-200">
                Step {learnAll.index + 1} of {learnAll.queue.length}
                {learnAllPhysical ? `: ${learnAllPhysical} → ${learnAllLabel}` : `: ${learnAllLabel}`}
              </div>
              <div className="mt-1 text-[11px] text-sky-300/80">Move the control now — or skip it.</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={skipLearnAllStep}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  Skip
                </button>
                <button
                  onClick={stopLearnAll}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  Stop
                </button>
              </div>
            </div>
          )}
          {learnAllMsg && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded bg-emerald-900/30 p-2 text-xs text-emerald-200">
              <span>{learnAllMsg}</span>
              <button onClick={() => setLearnAllMsg(null)} className="text-emerald-400 hover:text-emerald-200" title="Dismiss">✕</button>
            </div>
          )}
        </div>

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

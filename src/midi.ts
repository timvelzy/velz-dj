/**
 * MIDI control layer — separate from the audio engine, degrades gracefully.
 *
 * - Uses the Web MIDI API (Chrome/Edge; Firefox needs a flag, Safari partial).
 * - MIDI-LEARN: pick a control in the MIDI panel, move the hardware control,
 *   the binding is stored. This is the source of truth — every unit/firmware
 *   can differ, so learned bindings beat any printed CC table.
 * - Ships with a Kontrol S8 LAYOUT TEMPLATE: which physical control drives
 *   which function. CC numbers are intentionally NOT hardcoded — learn them
 *   once on your unit and they're saved to localStorage.
 * - No MIDI device present → the panel says so and everything else works.
 */

export type ControlKind = 'fader' | 'knob' | 'button' | 'jog';

export interface BindableControl {
  id: string;
  label: string;
  group: string;
}

export interface MidiBinding {
  controlId: string;
  deviceId: string;
  deviceName: string;
  channel: number; // 1-16
  type: 'cc' | 'note';
  number: number; // CC or note number
}

export interface ControlHandler {
  kind: ControlKind;
  /** Absolute 0..1 value (faders, knobs). */
  onAbsolute?: (v: number) => void;
  /** Relative ticks, + = clockwise/faster (jog wheels). */
  onRelative?: (delta: number) => void;
  /** Button press/release. */
  onButton?: (pressed: boolean) => void;
}

/** Every UI control that can be MIDI-mapped. Components register handlers by id. */
export const BINDABLE_CONTROLS: BindableControl[] = [
  // Deck A
  { id: 'deckA.play', label: 'Play / Pause', group: 'Deck A' },
  { id: 'deckA.cue', label: 'Cue', group: 'Deck A' },
  { id: 'deckA.sync', label: 'Sync', group: 'Deck A' },
  { id: 'deckA.tempo', label: 'Tempo fader', group: 'Deck A' },
  { id: 'deckA.jog', label: 'Jog wheel', group: 'Deck A' },
  { id: 'deckA.nudgeMinus', label: 'Nudge −', group: 'Deck A' },
  { id: 'deckA.nudgePlus', label: 'Nudge +', group: 'Deck A' },
  { id: 'deckA.keyLock', label: 'Key lock', group: 'Deck A' },
  { id: 'deckA.loopIn', label: 'Loop in', group: 'Deck A' },
  { id: 'deckA.loopOut', label: 'Loop out', group: 'Deck A' },
  // Deck B
  { id: 'deckB.play', label: 'Play / Pause', group: 'Deck B' },
  { id: 'deckB.cue', label: 'Cue', group: 'Deck B' },
  { id: 'deckB.sync', label: 'Sync', group: 'Deck B' },
  { id: 'deckB.tempo', label: 'Tempo fader', group: 'Deck B' },
  { id: 'deckB.jog', label: 'Jog wheel', group: 'Deck B' },
  { id: 'deckB.nudgeMinus', label: 'Nudge −', group: 'Deck B' },
  { id: 'deckB.nudgePlus', label: 'Nudge +', group: 'Deck B' },
  { id: 'deckB.keyLock', label: 'Key lock', group: 'Deck B' },
  { id: 'deckB.loopIn', label: 'Loop in', group: 'Deck B' },
  { id: 'deckB.loopOut', label: 'Loop out', group: 'Deck B' },
  // Mixer
  { id: 'mixer.crossfader', label: 'Crossfader', group: 'Mixer' },
  { id: 'mixer.chA.fader', label: 'Ch A fader', group: 'Mixer' },
  { id: 'mixer.chB.fader', label: 'Ch B fader', group: 'Mixer' },
  { id: 'mixer.chC.fader', label: 'Ch AI fader', group: 'Mixer' },
  { id: 'mixer.chA.eqLow', label: 'Ch A low EQ', group: 'Mixer' },
  { id: 'mixer.chA.eqMid', label: 'Ch A mid EQ', group: 'Mixer' },
  { id: 'mixer.chA.eqHigh', label: 'Ch A high EQ', group: 'Mixer' },
  { id: 'mixer.chB.eqLow', label: 'Ch B low EQ', group: 'Mixer' },
  { id: 'mixer.chB.eqMid', label: 'Ch B mid EQ', group: 'Mixer' },
  { id: 'mixer.chB.eqHigh', label: 'Ch B high EQ', group: 'Mixer' },
  { id: 'mixer.chA.filter', label: 'Ch A filter', group: 'Mixer' },
  { id: 'mixer.chB.filter', label: 'Ch B filter', group: 'Mixer' },
  { id: 'mixer.chA.cue', label: 'Ch A cue', group: 'Mixer' },
  { id: 'mixer.chB.cue', label: 'Ch B cue', group: 'Mixer' },
  { id: 'mixer.master', label: 'Master volume', group: 'Mixer' },
  { id: 'mixer.cueMix', label: 'Cue / master mix', group: 'Mixer' },
  // AI deck
  { id: 'deckC.play', label: 'AI start / stop', group: 'AI Deck' },
  { id: 'deckC.drop', label: 'AI drop on bar', group: 'AI Deck' },
];

/**
 * Kontrol S8 layout template — which PHYSICAL control maps to which function.
 * Learn each one once (MIDI panel → Learn → move the control); bindings persist.
 */
export const S8_TEMPLATE: { physical: string; controlId: string }[] = [
  { physical: 'Left jog wheel', controlId: 'deckA.jog' },
  { physical: 'Left tempo fader', controlId: 'deckA.tempo' },
  { physical: 'Left PLAY', controlId: 'deckA.play' },
  { physical: 'Left CUE', controlId: 'deckA.cue' },
  { physical: 'Left SYNC', controlId: 'deckA.sync' },
  { physical: 'Left pitch bend − / +', controlId: 'deckA.nudgeMinus' },
  { physical: 'Right jog wheel', controlId: 'deckB.jog' },
  { physical: 'Right tempo fader', controlId: 'deckB.tempo' },
  { physical: 'Right PLAY', controlId: 'deckB.play' },
  { physical: 'Right CUE', controlId: 'deckB.cue' },
  { physical: 'Right SYNC', controlId: 'deckB.sync' },
  { physical: 'Crossfader', controlId: 'mixer.crossfader' },
  { physical: 'Ch 1 fader', controlId: 'mixer.chA.fader' },
  { physical: 'Ch 2 fader', controlId: 'mixer.chB.fader' },
  { physical: 'Ch 1 HI / MID / LOW', controlId: 'mixer.chA.eqHigh' },
  { physical: 'Ch 2 HI / MID / LOW', controlId: 'mixer.chB.eqHigh' },
  { physical: 'Ch 1 FILTER knob', controlId: 'mixer.chA.filter' },
  { physical: 'Ch 2 FILTER knob', controlId: 'mixer.chB.filter' },
  { physical: 'Master knob', controlId: 'mixer.master' },
];

const STORAGE_KEY = 'velz-dj-midi-bindings-v1';

type Listener = () => void;

class MidiManager {
  private access: MIDIAccess | null = null;
  private handlers = new Map<string, ControlHandler>();
  private bindings: MidiBinding[] = [];
  private learning: string | null = null;
  private listeners = new Set<Listener>();
  supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

  constructor() {
    this.load();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void { this.listeners.forEach((fn) => fn()); }

  get state() {
    return {
      supported: this.supported,
      connected: this.access !== null,
      devices: this.deviceList(),
      bindings: [...this.bindings],
      learning: this.learning,
    };
  }

  async enable(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.inputs.forEach((input) => {
        input.onmidimessage = (e) => this.onMessage(input, e);
      });
      this.access.onstatechange = () => this.emit();
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  deviceList(): { id: string; name: string }[] {
    if (!this.access) return [];
    const out: { id: string; name: string }[] = [];
    this.access.inputs.forEach((i) => out.push({ id: i.id, name: i.name ?? 'MIDI device' }));
    return out;
  }

  registerControl(id: string, handler: ControlHandler): () => void {
    this.handlers.set(id, handler);
    return () => { this.handlers.delete(id); };
  }

  startLearn(controlId: string): void {
    this.learning = controlId;
    this.emit();
  }
  stopLearn(): void {
    this.learning = null;
    this.emit();
  }

  bindingFor(controlId: string): MidiBinding | undefined {
    return this.bindings.find((b) => b.controlId === controlId);
  }

  clearBinding(controlId: string): void {
    this.bindings = this.bindings.filter((b) => b.controlId !== controlId);
    this.save();
    this.emit();
  }

  clearAll(): void {
    this.bindings = [];
    this.save();
    this.emit();
  }

  private onMessage(input: MIDIInput, e: MIDIMessageEvent): void {
    const data = e.data;
    if (!data || data.length < 3) return;
    const status = data[0] & 0xf0;
    const channel = (data[0] & 0x0f) + 1;
    const num = data[1];
    const val = data[2];

    // Learn mode: bind whatever arrives (prefer CCs and notes; ignore clock)
    if (this.learning) {
      if (status === 0xb0 || status === 0x90 || status === 0x80) {
        const type = status === 0xb0 ? 'cc' : 'note';
        this.bindings = this.bindings.filter((b) => b.controlId !== this.learning);
        this.bindings.push({
          controlId: this.learning!,
          deviceId: input.id,
          deviceName: input.name ?? 'MIDI device',
          channel,
          type,
          number: num,
        });
        this.learning = null;
        this.save();
        this.emit();
      }
      return;
    }

    const isNoteOff = status === 0x80 || (status === 0x90 && val === 0);
    const isNoteOn = status === 0x90 && val > 0;
    const isCC = status === 0xb0;

    for (const b of this.bindings) {
      if (b.deviceId !== input.id || b.channel !== channel || b.number !== num) continue;
      if (b.type === 'cc' && !isCC) continue;
      if (b.type === 'note' && !(isNoteOn || isNoteOff)) continue;
      const h = this.handlers.get(b.controlId);
      if (!h) continue;

      if (b.type === 'note') {
        h.onButton?.(isNoteOn);
      } else if (h.kind === 'jog') {
        // Relative encoding: try 2's complement (most jogs incl. S8 MIDI mode)
        const delta = val < 64 ? val : val - 128;
        if (delta !== 0) h.onRelative?.(delta);
      } else if (h.kind === 'button') {
        h.onButton?.(val >= 64);
      } else {
        h.onAbsolute?.(val / 127);
      }
    }
  }

  private save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings)); } catch { /* noop */ }
  }
  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.bindings = JSON.parse(raw) as MidiBinding[];
    } catch { /* noop */ }
  }
}

export const midi = new MidiManager();

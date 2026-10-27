# velz-dj Feature Specs: Sampler + FX Section
**Specced:** 2026-10-12 · **Status:** approved for build
**Note:** Filters (per-channel LP/HP sweep w/ resonance) and headphone cue (PFL bus, 50/50 cue/master mix) are already implemented — see `DJEngine.setFilter` and the cue bus in `src/audio/engine.ts`.

---

## 1. Sampler — 8-pad one-shot sampler

### Concept
8 pads for triggering one-shot samples (airhorn, vocal chops, risers, drum hits) during a set. Standard DJ sampler behavior.

### Audio graph
```
[pad buffer] → BufferSourceNode → padGain → samplerBus → masterBus
                                              ↘ cueBus (when PFL enabled)
```
- New `samplerBus: GainNode` in `DJEngine`, connected to `masterBus` (and optionally `cueBus`).
- Each pad: `AudioBuffer`, `padGain: GainNode` (per-pad volume), `lastTriggerTime`.

### Engine API (`src/audio/engine.ts`)
```ts
loadSample(padIndex: 0-7, audioBuffer: AudioBuffer, name: string): void
clearSample(padIndex: number): void
triggerSample(padIndex: number, opts?: { quantize?: boolean }): void
setPadVolume(padIndex: number, v: number): void          // 0..1
setPadQuantize(quantize: boolean): void                  // global toggle
getPadState(padIndex: number): { loaded: boolean; name: string; volume: number }
```
- **Quantize:** when enabled, pad triggers align to the next beat using the playing deck's beat map (reuse the beat-grid infrastructure from the sync engine). If no beat map, trigger immediately.
- **Retrigger:** triggering a pad while its sample is playing restarts it (standard one-shot behavior).
- **Persistence:** store pad assignments (name + volume, not audio data) in IndexedDB alongside the Traktor collection. Audio buffers reload from the library on startup; prompt to re-link missing files.

### Sample sources
1. File picker / drag-drop onto pad (any audio file).
2. "Capture from deck" — record the last N seconds of a deck's output into a pad (fun for live vocal chops). Implement via `MediaRecorder` on the deck's analyser tap or a `ScriptProcessor` ring buffer. V1: file/drop only; capture is V2.

### UI (`src/components/Sampler.tsx`)
- 8 pads in a 4×2 grid, below the mixer or as a toggleable panel.
- Each pad: sample name, mini waveform preview (render from `AudioBuffer` via existing waveform utils), volume on right-click/long-press.
- Click/trigger pad → visual flash.
- Empty pad shows "+" — click opens file picker.
- Keyboard: `1`–`8` trigger pads. (Check for conflicts with existing shortcuts first.)
- Global quantize toggle button with beat-division indicator.

### MIDI
- `sampler.pad[N]` — note on triggers pad (velocity → volume).
- Follows the existing `midi.registerControl` pattern in `src/midi.ts`.

### Loop mode (implemented 2026-10-27)
- Per-pad LOOP arm/disarm (UI button, keyboard via pad key, MIDI-learnable
  `sampler.pad[N].loop`). Tapping a loop-armed pad starts the loop;
  tapping again stops it — the sounding pass finishes, nothing new is
  scheduled. One-shot behavior is unchanged when loop is off.
- Sync: the loop period is the sample duration rounded to the nearest
  whole master beats (1–32). Iteration starts land on master beat
  boundaries (first hit uses the existing next-beat quantize; each
  following start is re-anchored to the live master grid). No pitch
  change, no time-stretch: a sample longer than its period is cut at
  the boundary, a shorter one leaves silence until the next boundary.
  With no master playing, the loop free-runs at the last-known tempo
  (fx.bpm, default 124). Pad volume + sampler master/EQ/filter/FX send
  apply exactly as for one-shots.

### Out of scope (V2)
- Pitch control, sample slicing. (Loop mode and capture-from-deck are now implemented.)

---

## 2. FX Section — beat-synced send/return

### Concept
One FX unit (expandable to two) with beat-synced effects. Send per channel, return to master. This is where the beat-grid work pays off — delay times lock to the track's actual tempo map.

### Audio graph
```
[channel fader] → fxSend[N] → fxBus → [effect chain] → fxReturn → masterBus
```
- Per-channel `fxSend: GainNode` (post-fader, standard DJ behavior).
- Single `fxBus: GainNode` → effect chain → `fxReturn: GainNode` → `masterBus`.
- Dry/wet: `fxReturn.gain` controls wet level; dry is the normal channel path (true send/return, not insert).

### Engine API
```ts
setFxSend(channelId: string, v: number): void           // 0..1 per channel
setFxWet(v: number): void                                // master wet/dry 0..1
selectFx(type: 'delay' | 'reverb' | 'bitcrush' | 'flanger'): void
setFxParam(param: string, v: number): void               // effect-specific
setFxBeatDivision(div: '1/4' | '1/2' | '3/4' | '1'): void
setFxEnabled(enabled: boolean): void                     // bypass
```

### Effects (V1)
| Effect | Nodes | Params |
|--------|-------|--------|
| **Delay** | `DelayNode` + feedback `GainNode` | Time (beat-synced), Feedback 0–0.9, Wet |
| **Reverb** | `ConvolverNode` (syn generated IR, no file needed) | Decay, Wet |
| **Bitcrush** | `WaveShaperNode` (quantization curve) | Bits 16→4, Wet |
| **Flanger** | `DelayNode` (1–5ms) + LFO (`OscillatorNode` → delay.delayTime) | Rate (beat-synced), Depth, Wet |

- **Beat sync:** delay time and LFO rate derive from the active deck's beat map (seconds-per-beat at the current position, handling tempo drift). Fallback: last known BPM or tap tempo.
- **Synthetic IR for reverb:** generate exponentially-decaying noise buffer in code (2s, stereo). No IR files to ship.

### UI (`src/components/FxUnit.tsx`)
- Effect selector (4 buttons or rotary).
- 3 parameter knobs (param meanings change per effect — label them dynamically).
- Beat division buttons: 1/4, 1/2, 3/4, 1.
- Wet/dry knob.
- Enable/bypass toggle (big, obvious).
- Per-channel send knobs in the mixer channel strips (small knobs next to the existing filter knobs).

### MIDI
- `fx.wet`, `fx.param1/2/3`, `fx.send[channelId]` — knobs.
- `fx.select[N]` or prev/next — buttons.

### Out of scope (V2)
- Second FX unit / chaining, per-effect cue, macro FX (single knob controlling multiple params like Traktor's Macro FX).

---

## Build order
1. **Sampler** — self-contained, no dependencies on FX. Biggest fun-per-effort.
2. **FX unit** — builds on the beat-grid infrastructure. Delay first (most used), then reverb/bitcrush/flanger.

## QA checklist (for the hands-on session)
- [ ] Filters: sweep full range on a playing track, confirm no clicks/pops at extremes
- [ ] Cue: PFL a deck, confirm cue bus isolation (master unaffected)
- [ ] Sampler: trigger all 8 pads rapidly, confirm no dropouts; test quantize on/off
- [ ] FX delay: confirm delay time tracks tempo changes (pitch bend the deck, delay follows)
- [ ] MIDI: map S8 knobs to filter + FX params, confirm smooth response

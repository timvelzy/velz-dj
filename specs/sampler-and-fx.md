# velz-dj Feature Specs: Sampler + FX Section
**Specced:** 2026-10-12 · **Status:** approved for build
**Note:** Filters (per-channel LP/HP sweep w/ resonance) and headphone cue (PFL bus, 50/50 cue/master mix) are already implemented — see `DJEngine.setFilter` and the cue bus in `src/audio/engine.ts`.

---

## 1. Sampler — 8-pad one-shot sampler

### Concept
8 pads for triggering one-shot samples (airhorn, vocal chops, risers, drum hits) during a set. Standard DJ sampler behavior.

### Audio graph
```
[pad buffer] → BufferSourceNode → padGain → per-pad EQ (low/mid/high) → samplerBus → sampler trim → shared sampler EQ → filter → samplerMaster → masterBus
                                                                                     ↘ cue tap (post-filter) → cueBus · FX send (post-master) → fxBus
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
- **Tap-again stop (changed 2026-10-27):** tapping a sounding pad
  again stops it immediately with a quick fade — one-shots and loops
  alike. Previously a tap retriggered a one-shot and a loop tap let
  the sounding pass finish. To play a stopped pad again, tap once
  more. Disarming LOOP mid-loop and loading a new sample keep the
  old finish-the-pass semantics; only the explicit tap-again stop
  (and the STOP surfaces below) cut immediately.
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
  tapping again stops it immediately with a quick fade (changed
  2026-10-27 — previously the sounding pass finished). One-shot
  behavior is unchanged when loop is off, except the tap-again stop.
- Sync: the loop period is the sample duration rounded to the nearest
  whole master beats (1–32). Iteration starts land on master beat
  boundaries (first hit uses the existing next-beat quantize; each
  following start is re-anchored to the live master grid). No pitch
  change, no time-stretch: a sample longer than its period is cut at
  the boundary, a shorter one leaves silence until the next boundary.
  With no master playing, the loop free-runs at the last-known tempo
  (fx.bpm, default 124). Pad volume + sampler master/EQ/filter/FX send
  apply exactly as for one-shots.

### Trim editing (implemented 2026-10-27)
- Non-destructive per-pad trim: the full decoded buffer is always
  kept; each pad stores start/end offsets (seconds). One-shots play
  only the trimmed region; loop mode loops the trimmed region with
  the period recomputed from the trimmed duration (same whole-beat
  rounding, 1–32). Trim edits apply from the next trigger / next loop
  iteration; a sounding voice is never rewritten.
- UI: EDIT button on each loaded pad opens an expanded editor below
  the pad grid — large waveform with draggable amber start/end
  handles, numeric start/end fields (seconds, commit on blur/Enter),
  RESET TO FULL. The pad's mini waveform shades the trimmed-out
  regions. 5ms fades at trim boundaries prevent clicks. Offsets
  clamp to [0, duration] with a 10ms minimum region; invalid input
  is clamped, never a crash or a permanently silent pad.
- Zoom: the editor waveform zooms 1×–32× (buttons, centered on the
  trim region; mouse wheel, centered on the pointer; FIT resets).
  Handle dragging maps to the zoomed time scale; dragging the
  waveform background pans the zoomed view. Zoom is view-only state,
  not persisted.

### Playhead + audition (implemented 2026-10-27)

- A white playhead line overlays the editor waveform while the pad
  sounds, so trim edits can be judged against what is playing. It is
  a DOM line positioned imperatively by requestAnimationFrame
  reading the audio clock through `engine.padPlaybackPosition`
  (scheduled start time + `AudioContext.currentTime`, per voice, so
  loop iterations wrap naturally) — never React state per frame, so
  it cannot stall the pads. rAF runs only while a voice is sounding;
  when idle the check backs off to a 250ms timer so a later pad tap
  wakes it; everything cancels on editor close/unmount.
- The line maps through the same zoomed/panned time scale as the
  waveform. A position outside the visible window pins the line to
  the near edge with a ◀/▶ arrow instead of vanishing. With nothing
  sounding the line parks at the trim start, dimmed. A trim edit
  mid-voice does not move the sounding voice's record, so the line
  may sit in the newly shaded-out region until the next trigger —
  that is what is actually heard.
- AUDITION button in the editor plays the current trim region
  through the existing trigger path (same gain/EQ/trim; looped when
  loop-armed, one-shot otherwise). While the pad sounds the button
  reads STOP and cuts the voice immediately. The pad's mini waveform
  deliberately has no playhead: it shares none of the editor's
  machinery, and duplicating it was not worth it — FINE-TUNE jumps
  to the editor where the playhead lives.

### Stop semantics (implemented 2026-10-27)

- One engine method, `engine.stopPadVoice`, serves every surface:
  it cancels loop scheduling and fades the sounding voice out with
  the 5ms fade shape (source stops ~50ms later, once the fade has
  landed), so the cut never clicks. Voices still waiting out a
  quantize delay or a lookahead slot cancel outright. Trim, EQ,
  volume, and loop-arm state are untouched; the pad keeps its
  sample. No persistence changes.
- Surfaces: (1) tap a sounding pad again — mouse pointer-down, pad
  key `1`–`8`, or MIDI pad trigger — stops it immediately; tap once
  more to play again. (2) ■ STOP ALL in the sampler header (keyboard
  `0`, free: pad keys are `1`–`8`, Shift+`1`–`8` opens menus, Escape
  closes them) stops every sounding pad at once; decks are
  untouched. (3) ■ STOP in the per-pad quick menu. (4) the trim
  editor's AUDITION/STOP button, which reads STOP while the pad
  sounds however playback started.
- Explicitly unchanged: disarming LOOP mid-loop and loading a new
  sample still let the sounding voice finish its pass; Clear still
  stops and wipes the pad. Only the tap-again stop and the STOP
  surfaces cut immediately.

### Retrigger modifier (implemented 2026-10-27)

Tim's call after the tap-again-stop trade-off (re-tapping for fills
silenced instead of retriggering): both behaviors, via a modifier —
plain tap stops, modified tap retriggers. Alt (Option) was picked
because Shift+`1`–`8` already opens the quick menu and right-click
clears the pad; no double-tap detection, so the pointer-down +
immediate-stop latency work is untouched.

- Modifier: hold Alt (Option) at the moment of the gesture — read
  at pointer-down / keydown time only, never tracked. Alt+pointer
  tap on a pad, or Alt+`1`–`8` on the keyboard, retriggers it.
- Semantics (one engine path, `triggerSample` with
  `opts.retrigger`): the sounding voice is cut with the same 5ms
  fade as the stop (source stops ~50ms later, so the restart never
  clicks — a brief crossfade, not a gap), then the pad starts
  fresh from the trim start. A sounding one-shot restarts from the
  top; a sounding loop is cancelled and re-armed from the top of
  its pass (fresh period from the current trim, same quantize/LIVE
  rules for the first hit as a fresh trigger, iterations grid-locked
  after). A silent pad plays exactly as a plain tap would; a voice
  still waiting out a quantize delay is cancelled and rescheduled.
  Trim/EQ/volume/loop-arm state untouched.
- Plain tap on a sounding pad still stops immediately (a388dcf
  semantics, unchanged). The STOP surfaces stay stop-only: the
  quick-menu ■ STOP, the trim editor's AUDITION/STOP button, and
  ■ STOP ALL (button + `0` key). The editor's AUDITION button is a
  plain trigger, so Alt+click on it does not retrigger.
- Precedence: Shift wins — Shift+Alt+digit still opens the quick
  menu. Ctrl/Meta combos are left alone. The INPUT guard applies:
  Alt+digit while typing in a field does nothing. Keyboard uses
  `e.code` (physical key), because on macOS Option+digit produces
  a special character as `e.key` and the digit lookup would miss
  it; top-row digits and numpad digits both work.
- MIDI limitation: pad triggers over MIDI keep the stop behavior —
  there is no modifier on a hardware pad, and none was invented.
  A MIDI retrigger binding is a possible follow-up, not built.

### Quick menu + per-pad EQ + LIVE trigger (implemented 2026-10-27)

Tim's feel report: pads "didn't feel as responsive as [they] should" —
the diagnosis was two compounding waits, not a slow audio path. The
tap-to-sound path itself does no decode and no main-thread work
(buffers are decoded at load; a trigger only creates a source + gain
and schedules it, and the context already runs with
`latencyHint: 'interactive'`). What reads as lag is: (1) pads fired on
`click` (pointer-up) instead of pointer-down, and (2) with QUANTIZE
on and a master grid running, every first hit waits for the next
master beat — up to a full beat (~480ms at 124 BPM) — by design, but
it feels like the pad is ignoring the tap. Both are fixed without
changing the default sync behavior:

- Pads now trigger on pointer-down (primary button only; right-click
  still clears). Keyboard (`1`–`8`) and MIDI were already immediate.
- Per-pad LIVE (quick menu, persisted): when on, the pad's first hit
  starts at once, bypassing the quantize wait; loop iterations after
  the first still lock to the live master grid via the existing
  lookahead scheduler. Default off — the quantized behavior is
  unchanged unless Tim arms LIVE on a pad. The global QUANTIZE
  checkbox still defeats quantize for all pads.
- The menu itself stays off the audio path: menu state is local to
  the pad, pads are memoized, and settings saves keep the existing
  400ms debounce — tweaking never blocks or re-renders the grid.

Quick menu (the fast path; the EDIT editor stays the precise path):
- ⋯ button on every loaded pad, or Shift+1–8 (physical key, via
  `e.code`). Opens an inline popover anchored to the pad, instantly.
  Stays open while tweaking and while pads keep playing — taps on
  pads don't close it; only an outside tap, Escape, or ⋯/✕ does.
  One menu at a time; never covers all 8 pads.
- Contents, all live, no Apply button: per-pad 3-band EQ (below),
  trim start/end numeric fields (same trim model as the editor —
  seconds, clamped, 10ms minimum, non-destructive, applies next
  trigger / next loop pass) + RESET + FINE-TUNE (opens the expanded
  editor), volume slider (same binding as the vol knob — single
  state), LIVE toggle.

Per-pad EQ:
- Lowshelf 200 Hz / peaking 1000 Hz Q1 / highshelf 3000 Hz — same
  frequencies/Q as the shared sampler EQ — ±12 dB, flat 0, knobs
  with double-click-to-flat. One persistent filter chain per pad,
  ahead of `samplerBus`, so EQ tweaks apply to voices already
  sounding as well as new ones. Chain order: voice gain → per-pad EQ
  → samplerBus → sampler trim → shared sampler EQ → filter → master
  (+ FX send / cue tap). A new sample resets its pad to flat EQ and
  LIVE off; clearing does the same.
- Persistence: EQ values + LIVE choice travel with the pad record in
  `velz-dj-sampler` (optional fields — records saved before EQ
  existed restore flat/off). "Clear saved" still never wipes pads;
  seeding never clobbers user-edited pads.
- MIDI: no new bindings in this pass (existing `sampler.pad[N]`,
  `.volume`, `.loop` scheme untouched) — EQ/LIVE MIDI mapping is a
  follow-up, not half-wired.

### Pad persistence + seeded loops (implemented 2026-10-27)
- Pads persist across reloads in their own IndexedDB database
  (`velz-dj-sampler`, store `pads`, keyed by pad index — separate
  from the track library, so clearing the library never wipes pads).
  Each record stores the encoded audio bytes plus name, volume, trim
  offsets, and the loop-arm flag. Restore decodes in an
  OfflineAudioContext and stages the buffer before the first gesture
  creates the live AudioContext. Settings edits save debounced;
  loads/clears save immediately; deck recordings persist as
  WAV-encoded bytes. Trim offsets persist with the sample records.
- Seeded sampler pack: on first visit (version-gated, independent of
  the track-library seed gates), the 8 Gemini-generated Midnight
  Concrete example loops fill pads 1–8, full trim, volume 0.8, loop
  mode ARMED — nothing plays until the user taps a pad, a key, or
  MIDI. Seeding only fills pads with no saved record, so a pad the
  user loaded, cleared, or replaced is never clobbered; a deleted or
  replaced seed stays that way until the sampler seed version bumps.
- The same 8 loops also seed the track library under their own group
  (`loops`), labeled EXAMPLE LOOP with artist "Example loop
  (Gemini)" — never as Velz releases. Library rows for bundled tracks
  carry a VELZ PICK or EXAMPLE LOOP badge (see `seedGroup`).
- Two more Gemini-generated loop sets seed the library ONLY (pads
  untouched — the Midnight Concrete loops already occupy pads 1–8,
  and library seeding must never clobber pads): Perpetual Groove
  (5 pieces from one continuous ~130 BPM arrangement — intro, main
  groove, breakdown, passage, plus an outro tail labeled as a
  one-shot, not a loop) and Warehouse Floor (4 loops, ~123 BPM; loop
  4 is truncated mid-groove and its title says so). Each set has its
  own version gate (`velz-dj:pgSeedVersion`,
  `velz-dj:wfSeedVersion`), independent of the Midnight Concrete loop
  gate, so provisioning one set never resurrects another set's
  deleted seeds. Same EXAMPLE LOOP badge, same "Example loop
  (Gemini)" artist, same placeholder/analyze/save semantics as the
  other seed groups. Titles are prefixed with the set name.

### Out of scope (V2)
- Pitch control, sample slicing. (Loop mode, trim editing, capture-from-deck, pad persistence, and the seeded loop pack are now implemented.)

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
- [ ] Sampler quick menu: ⋯ opens instantly, EQ knobs audible on a sounding pad, trim fields + LIVE toggle live, menu stays open while other pads play, Escape/outside-tap closes; reload restores EQ + LIVE; old saved pads (no EQ fields) restore flat/off
- [ ] Sampler feel: pad tap with a master playing, QUANTIZE on, LIVE off = waits for the next beat (by design); LIVE on = first hit at once, loop locks to the grid after; pointer-down trigger (no pointer-up wait)
- [ ] Sampler playhead: open EDIT on a sounding loop, playhead tracks the trim region; zoom in and confirm it stays mapped; zoom so the playhead leaves the window and confirm the edge arrow; AUDITION from the editor, STOP cuts at once; close the editor and confirm no stray CPU use
- [ ] Sampler stop: start a long one-shot, tap the pad again mid-play and confirm immediate silence (no finish-the-pass, no retrigger); start a loop, tap again and confirm it stops at once; STOP ALL (`0` key) with several pads sounding; stop from the quick menu and from the editor; confirm pads keep samples, trim, EQ, and loop-arm state after stopping
- [ ] Sampler retrigger: start a long one-shot, Alt+tap the pad mid-play and confirm it restarts from the trim start (no gap, no click); start a loop, Alt+tap and confirm the pass restarts from the top and stays grid-locked; Alt+tap a silent pad and confirm it plays normally; plain tap still stops; Shift+pad still opens the menu; Alt+digit while typing in a trim field does nothing
- [ ] FX delay: confirm delay time tracks tempo changes (pitch bend the deck, delay follows)
- [ ] MIDI: map S8 knobs to filter + FX params, confirm smooth response

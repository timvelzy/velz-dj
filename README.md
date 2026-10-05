# VelzDJ

Two-deck DJ mixer with real time-stretch beat sync and a full-width AI third channel. Built to be usable for a real DJ set.

## Layout

- **Deck A** (left) · **Mixer** (center) · **Deck B** (right)
- **AI deck** — full width across the bottom
- **Track library** underneath (drag rows onto decks, or use the A/B buttons)

## Audio architecture

- **Real time-stretching, not playback-rate tricks.** Tempo goes through a WSOLA (Waveform Similarity Overlap-Add) `AudioWorkletProcessor` (`src/audio/wsola-processor.ts`) — the same algorithm family as SoundTouch. With key-lock on, the source always runs at `playbackRate = 1.0` and the worklet re-times grains, so tempo changes don't pitch-shift. Key-lock off = vinyl-style pitch shift via `playbackRate`.
- **Shared master clock + continuous phase correction.** A 100 ms phase-locked loop tempo-follows the master deck and applies proportional bar-phase correction (±1.5%) to synced slaves — decks don't drift apart. One-shot bar alignment on play (`alignToMaster`).
- **Sample-accurate position tracking.** Track position integrates tempo over audio-clock time, so the waveform playhead never drifts when tempo/nudge change.
- **Signal chain per deck:** source → WSOLA stretch → trim → 3-band EQ → filter → analyser → channel fader → crossfader → master bus (compressor → master gain); cue bus is isolated (cue gain only carries cued decks).
- **Equal-power crossfader** (no center dip).

## Analysis (never hardcoded)

Every loaded track is analyzed on the spot: BPM + beat grid (electronic/general detectors with confidence), downbeat offset, musical key (Camelot). Low-confidence BPMs are flagged amber in the library; the beat-grid editor modal lets you fix them by hand.

## AI deck

Pre-generates 4/8-bar loops at the master BPM/key, keeps 2–3 queued, and drops them in quantized to the next master bar boundary with a 1-beat fade-in (`engine.playAiLoop`). Honest by design: with no backend configured the UI says so — there is no fake generation path.

**Plugging in a real backend** (e.g. a server endpoint wrapping Vertex Lyria or Stable Audio): implement the `AIGenerationBackend` interface in `src/audio/ai.ts` — the `LoopQueue` calls `generate(spec, ctx)` with target BPM, Camelot key, bar count and a style hint, and expects an `AudioBuffer` back. Unless the backend sets `knownExactBpm`, the loop is re-measured with the beat detector instead of trusted. The included `DemoSynthBackend` is a real (simple) synthesized loop generator, clearly labeled DEMO.

## MIDI

Web MIDI API + MIDI-learn: open the MIDI panel, pick a control, move the hardware control — the binding is stored in `localStorage`. Ships with a Traktor Kontrol S8 *layout template* (which physical control drives which function); CC numbers are intentionally not hardcoded since units/firmware differ. No device present → the panel says so and everything else works.

## Device routing

Master and headphone cue can be routed to separate audio devices (via `setSinkId` on hidden `<audio>` elements fed by `MediaStreamDestination`s). Device labels need a mic-permission unlock — there's a button for that in the Audio devices dropdown.

## Dev

```bash
npm install
npm run dev      # vite dev server
npm run build    # tsc --noEmit + vite build → dist/
```

Open the page, click **Start the decks** (browsers require a gesture for AudioContext), drop audio files on a deck or the library.

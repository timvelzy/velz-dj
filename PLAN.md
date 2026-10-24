# velz-dj — Build-out Plan (Oct 2026)

**Purpose:** Tim will perform a tribute DJ set for a friend who just died, spinning
his own tracks on this software. **Recording the set is the must-have.**
Reliability beats novelty. Network/multi-machine sync (Ableton Link etc.) is
explicitly OUT of scope.

**Rules of the road:** after each phase, `npm run build` must pass; commit per
phase with a clear message and push to `timvelzy/velz-dj`. If a phase fights
back, stop it, leave the build green, document why here, and move on.

Baseline (Step 1): verified clean — `tsc --noEmit && vite build` passes with
no pre-existing errors. No fixes needed.

---

## Phase 2 — RECORDING (highest priority) · status: TODO

**Scope**
- New AudioWorklet recorder (`src/audio/recorder-processor.ts`, name
  `velz-recorder`) tapped off the master chain **post-limiter, post-master
  gain** — i.e. exactly what the master output carries (post-crossfader,
  post-FX return, post-sampler bus, all of which sum into `masterBus`).
- `src/audio/recorder.ts`: a `SetRecorder` class owning the worklet node,
  elapsed clock, and the output writer.
  - Preferred: stream to disk via File System Access API
    (`showSaveFilePicker` at record-start, from the user's click) so a
    1-hour set (44.1 kHz stereo 16-bit ≈ 635 MB) never sits in RAM.
    Chunk-wise float→int16 conversion, WAV header written up front with
    placeholder sizes and patched via `seek()` at stop.
  - Fallback (Firefox / picker declined): accumulate chunks in memory,
    encode one WAV `Blob` at stop, download it.
  - Output: 16-bit / 44.1 kHz (context sample rate) stereo WAV.
- **Auto-tracklist:** while recording, every deck track-load appends
  `{elapsed, deck, title, artist, bpm, key}`. Hooked from App `loadTrack`
  (decks A/B) and AI loop drops (deck C). Sampler hits are NOT tracks.
  Tracks already on decks when recording starts are seeded at 0:00.
  At stop, the tracklist downloads as `.txt` (human) + `.json` (machine)
  sidecars next to the WAV.
- UI: REC button + elapsed timer in the app header (always visible during a
  set), states: idle / recording (pulsing red + timer) / saving.

**Key files:** `src/audio/recorder-processor.ts` (new), `src/audio/recorder.ts`
(new), `src/audio/engine.ts` (recorder tap + `setRecorderNode` wiring),
`src/App.tsx` (UI + tracklist hooks), `src/audio/fs-access.d.ts` (ambient
File System Access types — TS DOM lib doesn't ship them).

**Risks**
- File System Access is Chromium-only → fallback must be solid; WAV-in-RAM
  for a long set is ~1.2 GB as Float32 before encode — acceptable as fallback,
  and the UI will warn when streaming-to-disk isn't active.
- Worklet → main-thread message rate: post in 4096-frame blocks (~93 ms) to
  keep message overhead negligible.
- `showSaveFilePicker` must be called inside the click handler (user
  activation); the flow is: click REC → picker → worklet starts.

## Phase 3 — MASTER SAFETY + ENGINE · status: TODO

**Scope**
- Retune the existing master `DynamicsCompressor` into a transparent
  **limiter**: threshold −3 dB, ratio 20:1, knee 0, attack 2 ms, release
  240 ms. It sits ahead of both the device output and the recorder tap
  (chain already: `masterBus → compressor → masterGain → analyser → out`).
- Gain-staging review (deck trim → EQ → fader → crossfader → master):
  two decks at unity + sampler can sum > 0 dBFS into `masterBus`; the
  limiter is the ceiling. Document expected meter behavior in README.
- **WSOLA quality:** evaluated a grain-size bump (N 1024→2048) and adaptive
  hop. Verdict: skip — larger grains smear the transients that dominate
  Tim's house/techno material, and hop changes touch the OLA shift logic
  (regression risk against the tribute deadline). The audible quality issue
  at DJ tempo ranges (±16%) is downstream clipping, fixed by the limiter.
  **Proposed but deferred:** Rubber Band WASM swap behind the existing
  `setTempo` worklet message interface — cleaner transients + formant
  control, but adds a WASM build/licensing surface (Rubber Band is
  GPL/commercial dual-license) that doesn't belong in this pass.

**Key files:** `src/audio/engine.ts` (init compressor settings), `README.md`.

**Risks:** Limiter pumping on already-mastered tracks if threshold too low —
−3 dB with fast attack/slow release is conservative; peaks only.

## Phase 4 — WAVEFORMS · status: TODO

**Scope**
- `src/audio/peaks.ts`: compute per-track band peaks at analysis time —
  for each ~10 ms bucket: overall min/max, RMS, and low/mid/high band
  energy (band split reuses the existing OfflineAudioContext 3-band render
  in `analyzeSpectrum`, extended to also emit RMS + min/max).
- Cache in IndexedDB (new DB `velz-dj-peaks`, store `peaks`, key =
  `name|size|duration` hash of the file) so re-loading a track is instant.
  Traktor-matched tracks skip analysis today, so peaks are computed lazily
  in the background for them too, then cached.
- `Waveform.tsx`: render band-colored columns (dominant band per bucket:
  low = orange/red, mid = green, high = pale blue/white — Rekordbox-style),
  amplitude from RMS-scaled envelope; keep the existing beatgrid overlay
  (already drawn from the real beat map) and loop/hotcue markers.
- Add a full-track **overview strip** above the scrolling waveform in each
  deck (click to seek, loop/hotcue markers, played region shaded).
- **Playhead accuracy:** the known drift class is addressed by the Phase 5
  `applyTempo` fix (position integrator using stale `posRate` after tempo
  changes). Waveform already reads `engine.position()` every rAF.

**Key files:** `src/audio/peaks.ts` (new), `src/audio/peaksStore.ts` (new),
`src/audio/analysis.ts` (emit band peaks), `src/components/Waveform.tsx`,
`src/components/Deck.tsx` (overview), `src/App.tsx` (cache wiring),
`src/types.ts` (`BandPeaks` type).

**Risks:** IDB version/store juggling with the existing `velz-dj` DB —
sidestepped by using a separate database. Spectral render cost is the same
offline pass analysis already pays.

## Phase 5 — SYNC ENGINE hardening · status: TODO

**Current state (better than feared):** `engine.syncTick()` already runs a
100 ms PLL: tempo-follow against the slave's local beat-map BPM + a
proportional bar-phase correction clamped to ±1.5%. Nudge is momentary
(`setNudge`/`clearNudge`, cleared on pause). Two real bugs found by reading:

1. **`posRate` goes stale.** Every tempo mutation path calls `rebase()`
   *before* changing the tempo values, and `applyTempo()` never updates
   `posRate`. After any tempo/nudge/sync change the position integrator
   advances at the *old* rate until the next rebase — playhead drift and
   PLL phase readings both skew. **Fix:** `applyTempo()` itself freezes the
   integrated position and sets `posRate` to the new effective tempo.
2. **Tempo-follow can silently not apply.** In `syncTick`, when only
   `syncBaseTempo` changes (correction under threshold), `applyTempo()` is
   never called, so the slave's audio rate doesn't follow the master until
   the phase error grows. **Fix:** call `applyTempo()` whenever either
   value changed.

**Also in this phase**
- Beat-phase fine correction: keep the bar-phase P-loop, add a small
  beat-phase term so alignment is tight within the bar, not just across it.
  Pure helper `phaseErrorBeats(masterBeats, slaveBeats)` extracted +
  sanity-checked by reasoning (wrap to ±0.5 beat for the fine term,
  ±2 beats for the bar term).
- **Quantized jumps:** per-deck QUANTIZE toggle — hotcue jumps and
  loop IN/OUT snap to the nearest mapped beat (beat map when present,
  else bpm+firstBeat math). Cue-point preview unchanged (CDJ behavior).
- Nudge anti-latch: jog handler's `setTimeout` clear can be orphaned by
  rapid ticks — replace with a deadline timestamp the PLL tick enforces
  (nudge auto-expires), so a lost pointer-up can never leave a bend stuck.

**Key files:** `src/audio/engine.ts`, `src/components/Deck.tsx`
(quantize toggle), `src/App.tsx` (quantized loop/hotcue paths).

**Risks:** PLL gain changes can oscillate — keep clamps (±1.5%) and the
100 ms cadence; changes are deliberately incremental.

## Phase 6 — BEAT-SYNCED FX · status: TODO

Per `specs/sampler-and-fx.md` §2 (approved 2026-10-12), send/return design:

**Scope**
- Graph: `[channel fader] → fxSend[N] → fxBus → [active effect] → fxReturn
  → masterBus` (post-fader sends, return lands pre-limiter so FX are
  recorded and limited like everything else).
- Engine API exactly as specced: `setFxSend`, `setFxWet`, `selectFx`,
  `setFxParam`, `setFxBeatDivision`, `setFxEnabled`.
- Effects V1: **Delay** (DelayNode + feedback, beat divisions
  1/4 · 3/8 · 1/2 · 3/4 · 1/1), **Reverb** (ConvolverNode, synthetic
  exponentially-decaying noise IR generated in code, decay param),
  **Bitcrush** (WaveShaper quantization, bits 16→4), **Flanger**
  (short delay + LFO, rate beat-synced).
- Beat sync: delay time / LFO rate derive from
  `engine.masterEffectiveBpm()`, refreshed inside the existing 100 ms
  `syncTick` so FX follow tempo moves live. Fallback: last master BPM,
  else 124.
- UI `src/components/FxUnit.tsx`: effect selector, 3 dynamic param knobs,
  beat-division buttons, wet knob, big bypass toggle; per-channel FX send
  knob added to each mixer channel strip.
- MIDI: `fx.wet`, `fx.param1..3`, `fx.sendA/B/C`, `fx.enable`,
  `fx.selectNext` added to `BINDABLE_CONTROLS`, registered like the rest.

**Key files:** `src/audio/engine.ts` (FX graph + API), `src/components/
FxUnit.tsx` (new; reuses the Mixer `Knob`, exported), `src/components/
Mixer.tsx` (send knobs + `fxSend` in `ChannelState`), `src/midi.ts`,
`src/App.tsx` (mount FxUnit).

**Risks:** Feedback delay runaway — feedback clamped ≤ 0.85 and the whole
return passes the master limiter. Reverb IR regenerated only when decay
param changes (debounced), not per-frame.

## Phase 7 — AI DECK LOOP QUEUE · status: TODO

**Current state:** `LoopQueue` + `DemoSynthBackend` already implement the
pre-generated queue: loops are generated ahead at the master BPM/key,
measured (exact-BPM backends trusted, external ones re-detected), kept
2–3 deep, invalidated on > 0.5 BPM target change, and dropped on the next
master bar via `engine.playAiLoop`. Queue UI already shows BPM/key/bars.

**This phase**
- Enrich the built-in procedural generator: add a **pad/chord layer**
  (detuned saw triad from the Camelot key, slow filter) and a variation
  seed so queued loops aren't identical. Still 100% offline, still
  honestly labeled "Demo Synth (built-in)" — rename in UI copy to
  "Built-in synth" with the demo nature in the hint text.
- **API generator slot:** `ApiLoopBackend implements AIGenerationBackend`
  with `isConfigured = false`, a typed config object
  (`{ endpoint?: string; apiKey?: string }`, both unset), and `generate()`
  that throws the status hint if ever called unconfigured. NOT wired into
  the queue by default; one-line swap in `App.tsx` when Tim configures a
  real endpoint (Stable Audio / Lyria etc.).
- Queue UI: show per-loop bars + BPM + key (already there) plus a small
  "prepared for {bpm} / {key}" header so Tim can see at a glance the queue
  matches the playing track.

**Key files:** `src/audio/ai.ts`, `src/components/AIDeck.tsx`.

**Risks:** Chord layer muddying the loop — keep pad level low (−12 dB vs
drums) and lowpassed.

## Phase 9 — DEPLOYABLE (outranks Phase 8) · status: TODO

**Scope**
- **PWA, hand-rolled (no plugin):** `public/manifest.webmanifest`
  (name, icons 192/512 generated in-repo, display standalone, theme
  #000000) + `public/sw.js` service worker: runtime cache-first for
  same-origin GETs (app shell + hashed assets + worklets), so after the
  first visit the app loads fully offline — audio files and the Traktor
  collection already live in IndexedDB/local files. SW registered from
  `main.tsx`, production only.
- **Build hygiene:** `base: './'` in `vite.config.ts` so the same `dist/`
  works at a domain root OR a subpath (GitHub Pages project site).
  Verify `dist/` is self-contained (worklet chunks included).
- **CI/deploy:** `.github/workflows/deploy.yml` — on push to `main`:
  install, `npm run build`, deploy `dist/` to GitHub Pages via
  `actions/deploy-pages`. `DEPLOY.md`: how Pages deploy works; how to
  point the same build at Cloudflare Pages / Netlify / Azure Static Web
  Apps; custom-domain + HTTPS notes — **secure context required**
  (HTTPS or localhost) for Web MIDI, File System Access, and
  AudioWorklet; for live sets, "install" the PWA and run it locally.

**Key files:** `public/manifest.webmanifest`, `public/sw.js`,
`public/icons/*` (new), `index.html` (manifest + theme-color links),
`src/main.tsx` (SW registration), `vite.config.ts`,
`.github/workflows/deploy.yml`, `DEPLOY.md`.

**Risks:** Pages needs one manual step from Tim (repo Settings → Pages →
Source: GitHub Actions) — documented in DEPLOY.md. SW caching a stale
shell during dev — register only in prod builds.

## Phase 8 — SPOTIFY, metadata only (LAST, optional) · status: TODO

**Hard boundary:** Spotify's Web Playback SDK streams encrypted audio —
no raw samples, no analysis, no sync, no recording, and Spotify's terms
prohibit DJ-style mixing. **No playback integration will be attempted.**

**Scope (only if Phases 2–7 + 9 are green):** library-side matching.
`src/audio/spotifyMatch.ts`: paste a playlist tracklist (text lines,
`Artist - Title` or `Title - Artist`), normalize (case, punctuation,
"feat." stripping), fuzzy-match against the local library, report
matched/missing per line. Small paste panel in `Library.tsx`.
If scope gets tight: leave as this spec only and say so.

## Monetization hooks (documentation only — NOT built in this pass)

If velz-dj ever goes Pro, gate by feature flag, following Tim's usual
pattern (Supabase auth + Stripe subscriptions):

- A single `src/config/features.ts` flag map (`recording`, `aiDeck`,
  `fxUnit`, `sampler`, `gridEditor`) read by components at mount; today
  every flag is `true` and there is no auth wall anywhere.
- The natural Pro gates: **recording export** (WAV download / long-set
  streaming), **AI deck**, **FX unit**, **sampler** — the free tier stays
  two decks + mixer + sync so the app remains a real mixer.
- Entitlement check would slot into `App.start()` (session → subscription
  status → flags), with Stripe Checkout links from a future settings
  panel. Deliberately not built now: a tribute set is not the moment to
  add a login screen to a DJ tool.

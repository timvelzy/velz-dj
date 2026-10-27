# Sync launch behavior: immediate start + catch-up slew

## The problem (diagnosed 2026-10-27, Tim's live mix)

With QTZ on and SYNC on, pressing Play waited for the master's next bar
boundary (up to a full bar — "waited a 4 count") and then started at the
next downbeat-phase beat at/after the pressed position
(`downbeatOffset`), not at the pressed position. Two separate injuries:
the start was late, and the start *position* was moved, so the drop
landed on beat but off the phrase Tim aimed at.

The holding PLL could not have saved an immediate start either: its
correction is P-gain 0.25/beat clamped to ±3% (see `pllCorrection`),
which takes ~13s to absorb a 0.8-beat error. It was built to *hold* a
lock established by the quantized jump, not to acquire one.

## The behavior now (default SYNC Play)

`playQuantized` with `immediateSync` (passed only by deck Play presses
in App `togglePlay`):

1. **Start at once.** The deck sounds immediately from the pressed
   position (CUE/position as pressed) — no bar wait, no downbeat snap.
   The source starts ~20ms after the press (`play()` scheduling).
2. **Catch-up slew.** `syncTick` (50ms) applies a stronger bounded
   tempo correction while catch-up is armed (`catchupCorrection`: gain
   0.5/beat, hard cap ±8%, slew-limited to 0.5% per tick = 10%/s, so
   full authority arrives in 0.8s). The proportional gain tails the
   correction to 1 as the error vanishes, so handing back to the
   holding PLL is stepless. The playhead is never jumped or skipped:
   only the tempo slews, exactly like a DJ nudging the platter.
3. **Convergence target.** A typical press-timing error (≤0.25 beats)
   closes in about a bar. A worst-case full-bar error (2 beats wrapped)
   converges as fast as the ±8% cap allows (~13+ beats) — deliberately
   never a jump, never a stall.
4. **Exit.** Catch-up disarms when the phase error reaches the ±30ms
   lock window, when its deadline passes (32 master beats / 8 bars,
   clamped to [2s, 16s] — long enough for a full-bar error to close at
   the cap), on pause, or on sync-off. The holding PLL
   (integral frozen at 0 during the slew) resumes from a small error.

Arming also re-matches the tempo against the slave's local BPM at the
launch position (the same snap `setSync` does) and resets the lock
streak, so LOCKED is never claimed on a stale ratio.

## Phase meter during convergence

The meter reads `syncStatus()`, which measures the *sounding*
position (the position integrator), not the grid. During catch-up it
shows the real shrinking error in ms, and LOCKED stays false until 10
consecutive ticks inside ±30ms. No QUEUED badge appears for immediate
launches (nothing is queued).

## What still uses the bar-quantized launch (unchanged)

- CUE previews (`cueDown` with QTZ on): still wait for the next bar
  and drop on the grid. CUE semantics are identical to before.
- Autopilot drops: still bar-quantized via `playQuantized` without the
  immediate flag; its curves depend on the scheduled start.
- SYNC-off Play with QTZ on: still the bar wait (the QTZ contract).
  SYNC-off play is otherwise untouched: immediate start, no catch-up.
- QTZ off: unchanged (immediate start, bar-aligned when sync is on).
- The engine `launchQuantize` mode setting ('bar'/'beat'/'off') is
  unchanged; it governs the queued path. No UI reaches it today.

## Untouched

Center playhead (fixed, waveform scrolls), loop/CUE semantics, the
backward-grid intro behavior (play-from-0 starts at 0 on the extended
grid and stays in phase; with SYNC on it now also converges during the
intro instead of skipping it), sampler behavior, autopilot, FX strip.

## QA checklist (browser feel test)

1. SYNC on, master playing, press Play deliberately off-beat: sound
   at once from the pressed position; PHASE meter error shrinks to
   ~0 within about a bar; no jump, no skip.
2. Press on the downbeat: still tight, meter near zero throughout.
3. Press from track start (quiet intro): plays from 0, no jump to
   the first kick; drop lands in phase.
4. SYNC off + QTZ on: still waits for the bar (unchanged).
5. CUE hold with QTZ on + SYNC on: still drops on the bar.
6. QTZ off: unchanged immediate start.

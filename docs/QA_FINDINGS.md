# QA findings — first sweep

**Date:** 2026-08-03. **Base:** `main` @ `2dd8bc2` (the PROJECT.md commit).
**Re-verified on merged `main` @ `e8016b9`** — 30 commits later, after other
agents' front-door work landed. Line numbers below are against `2dd8bc2` and have
shifted a little; every defect was re-confirmed present on `e8016b9` before this
was published, and `probe:finish` re-run there gives **1 of 19** finishers
completing the distance and **19 of 19** sharing the winner's exact time.
**Author:** the QA session. This file is the deliverable of a pass whose brief was
"look through all of the files and find the bugs so I don't have to manually tell you".

Every entry below is ranked by **what it costs the player**, and every one carries
either a reproduction you can run or the exact grep that proves it. Where a claim
came from a search rather than a measurement it is labelled as such. Three new
probes were added so the biggest findings cannot come back silently.

**How to reproduce the top two findings:**

```
npm run probe:finish     # nobody but the winner takes the chequered flag
npm run probe:blockage   # one stopped car permanently kills the whole race
```

Both fail on `main` today. Both were written to the project's own standard: they
carry a null/control case that PASSES, so a probe incapable of going green is
distinguishable from a real defect.

---

## A. Defects, ranked by player cost

### A1 — Nobody except the winner ever takes the chequered flag
**Severity: critical. Confidence: certain (measured on three circuits).**
**File:** `src/race/RaceEngine.ts:3334-3339`

```ts
// Give backmarkers a window to complete their final lap after the leader.
if (!anyRunning || (this.raceControl.raceFinished && this.time > this.raceFinishedAt + 180)) {
  this.finishSession();
}
if (this.raceControl.raceFinished && this.raceFinishedAt === 0) {
  this.raceFinishedAt = this.time;      // the ONLY write — one line BELOW the read
}
```

`raceFinishedAt` is initialised to `0` (line 3348) and assigned in exactly one
place: the line *after* the guard that consumes it. `grep -n raceFinishedAt
src/race/RaceEngine.ts` returns four lines and no others. So on the step the
leader crosses the line, the guard evaluates `this.time > 0 + 180` — true for any
race longer than three minutes, which is all of them — and `finishSession()` runs
on that same step. `finishSession` then stamps `finished = true` and
`finishTime = this.time` on **every car still circulating**.

The 180-second backmarker window has never once elapsed. It is dead code, and the
assignment below it is vestigial.

**Measured** (`npm run probe:finish`, 5-lap race, seed 99):

| circuit | classified finishers | completed the full 5 laps | sharing the winner's exact finish time | race ended after the leader crossed |
|---|---|---|---|---|
| monza | 17 | **1 / 17** | **17 / 17** (673.842s) | **0.00s** |
| bahrain | 18 | **1 / 18** | **18 / 18** (663.292s) | **0.00s** |
| silverstone | 18 | **1 / 18** | **18 / 18** (692.508s) | **0.00s** |

Finish-time spread across the whole field: **0.000s**, on all three circuits.

**What it costs the player:** unless you win, your race is cut off wherever you
happen to be on the road the instant the leader finishes. You never cross the
line, you never get the flag, and the result sheet gives you the winner's time to
the microsecond. Sixteen of seventeen "finishers" are classified a lap short of
the distance. Every podium, every points award and every career round result in
the game is built on this.

**Fix shape:** reorder — set `raceFinishedAt` before the test, or guard the test
with `this.raceFinishedAt > 0 &&`. Two lines. **Not applied here**: it is
`RaceEngine`, it changes race results materially, and it wants the owner of the
race/classification code. `probe:finish` will go green when it is right.

---

### A2 — One car stopped on the racing line permanently kills the entire race
**Severity: critical. Confidence: certain (measured, no player involved).**
**File:** `src/race/RaceEngine.ts:3262-3264` (`checkBeached`), plus the AI's
following logic.

```ts
const offRoad = Math.abs(car.lateral) > this.track.halfWidthAt(car.s) + 2;
if (car.physics.speedMs < 2.5 && offRoad && !car.inPitLane) {
```

`checkBeached` is the **only** thing in the engine that clears a stationary car,
and it requires the car to be **off** the road. A car stopped on the racing
surface is never retired, never recovered and raises no stationary-car flag. The
method's own comment says leaving a stopped car in place "stops the race ever
finishing" — which is exactly what a car stopped *on* the road does, only sooner
and more often. Underneath it, the AI will not pass a stationary car: it closes
up, brakes to a standstill, and the car behind does the same.

**Measured** (`npm run probe:blockage` — every car an AI, one of them pinned to the
asphalt 90s into the race, observed for 240s, against a same-seed control):

| circuit | field laps, staged | field laps, control | moving at the end |
|---|---|---|---|
| monza `[null control]` | 41 | 41 (100%) | **20 / 20** |
| monza | 11 | 41 (27%) | **0 / 20** |
| spa | 10 | 34 (29%) | **0 / 19** |
| monaco | 9 | 36 (25%) | **0 / 19** |

The null case — identical staging, blocker left alone — passes at exactly 100%
and 20/20, so the probe is capable of going green and the failure is the
simulation's.

**Re-run on merged `main` @ `e8016b9`** (the authoritative numbers):

| circuit | field laps, staged | field laps, control | moving at the end |
|---|---|---|---|
| monza `[null control]` | 41 | 41 (100%) | **20 / 20** |
| monza | 11 | 41 (27%) | **0 / 20** |
| spa | 10 | 34 (29%) | 10 / 19 |
| monaco | 9 | 35 (26%) | **0 / 18** |

Still failing, and the lap-count collapse is unchanged on all three circuits
(27% / 29% / 26%). One thing did move: Spa now recovers about half the field
instead of none, so something in the last thirty commits helps there and helps
nowhere else. That is worth knowing before anyone concludes this is fixed from a
single-circuit check — it is the *"YOU NEED TO FIX EVERY MAP"* pattern again.

**Third run, on `main` @ `7f1f3da`** (the newest measurement):

| circuit | field laps, staged | field laps, control | moving at the end |
|---|---|---|---|
| monza `[null control]` | 42 | 42 (100%) | **20 / 20** |
| monza | 14 | 42 (33%) | **0 / 16** |
| spa | 23 | 35 (66%) | 9 / 17 |
| monaco | 10 | 41 (24%) | **0 / 20** |

The picture is stable across three runs on two different trees: Monza and Monaco
stop dead, Spa half-recovers. The null control passes at exactly 100% and 20/20
every time, which is what says the probe is measuring the simulation and not
itself.

**One difference to read carefully, because it is partly mine.** The third
assertion — race control never dealt with the stationary car — now fails on all
three circuits where it previously passed. Part of that is my own tightening: I
removed `neutralisation !== 'none'` from the accepted outcomes, because a safety
car deployed for somebody else's accident would satisfy it and this has to be
about *this* car. The rest is real: the settle now produces a different blocker
on a different part of the road, and no message names it either way. Treat the
lap-count and still-moving rows as the load-bearing evidence; they have never
moved.

**What it costs the player:** spin to a halt on the road, stall on the grid, or
put the controller down for a minute, and the entire twenty-car field queues up
behind you nose-to-tail and stops forever. The race cannot be resumed. It also
means any AI car that stops on the road ends everyone's race.

**Independently observed with a player car:** with `playerIndex: 0` and no input,
only **2 of 20** cars were still moving 60s in, and **0 of 20** from t≈213s
onward — permanently. Field dump at t=400s: all twenty cars between s=6912m and
s=6992m at Spa, nose-to-tail in the two-column safety-car formation, all applying
brake 0.18, all at 0.00 m/s, `neutralisation = none`, every sector flag green.

**Fix shape:** two independent halves — (a) extend `checkBeached` to a car
stationary **on** the road (real race control raises a yellow and recovers it),
and (b) make the AI go round a stationary obstacle. Both are behavioural changes
in files other agents own. **Not applied.**

---

### A2b — Monaco fails the race sweep in **every** seed, and has been reporting it into a void
**Severity: high — ranks third on this list. Confidence: certain (measured, 55 races).**

Found by fixing B1. The moment `raceSweep` was given the exit code it never had,
it went red on **13 of 55 races**. It has been printing these same lines and
returning success on every run anyone has ever done.

```
FAIL monaco/20260729: fastest 157% of reference (too slow); 86.1s spread; 113 off-track excursions
FAIL monaco/4242:     fastest 175% of reference (too slow); 112 off-track excursions
FAIL monaco/1000:     fastest 156% of reference (too slow); 116 off-track excursions
FAIL monaco/1137:     fastest 156% of reference (too slow); 123 off-track excursions
FAIL monaco/1274:     fastest 151% of reference (too slow); 107 off-track excursions
FAIL silverstone/20260729: fastest 152% of reference (too slow)
FAIL silverstone/4242:     fastest 171% of reference (too slow)
FAIL zandvoort/4242:  fastest 145% of reference (too slow)
FAIL suzuka/4242:     fastest 159% of reference (too slow)
FAIL cota/4242:       fastest 146% of reference (too slow); 89.7s spread
FAIL spa/4242:        111.0s spread
FAIL cota/1000:       76.8s spread
FAIL spa/1274:        74.2s spread

  races failing      13 / 55        mean lap/reference  1.3662
  mean off-track     41.75          mean spread         27.90
```

**Monaco fails all five seeds.** The thresholds are `ratio > 1.45` and
`offTrack > 90` (`raceSweep.ts:84, 87`), so these are not marginal: the *fastest
lap in the field* is 51–75% slower than the reference, and the field goes off
track **107–123 times in a five-lap race** — roughly once per car per lap.
Silverstone fails two of five on pace alone.

This is a **circuit-specific** defect, not the known global AI-pace gap. The mean
across all 55 races is 1.3662, comfortably inside the 1.45 threshold; Monaco and
Silverstone are the outliers dragging it up. It is exactly the *"YOU NEED TO FIX
EVERY MAP"* pattern, and it has been invisible for the plainest possible reason —
nobody's terminal ever showed a non-zero exit.

**One caveat, stated as a hypothesis rather than a claim:** finding A1 truncates
every race at the instant the leader crosses, so slower cars get fewer flying
laps in which to set a best lap. That inflates the `spread` metric
(`slowestCarBest - fastestLap`, `:74`) and could account for some of the Spa and
COTA spread failures. It should **not** materially affect the `fastest % of
reference` figure, because that is the field's fastest lap and is normally the
leader's, and the leader does complete the distance. So the Monaco and
Silverstone pace failures look real independent of A1. **Whoever fixes A1 should
re-run this sweep before drawing conclusions about the spread rows.**

---

### A2c — `probe:pitstop` fails 6 of 7 on current `main`: no pit stop with an explicit request ever completes
**Severity: high if it is the product. Confidence: certain that it fails; the
trigger is NOT isolated. Owner: the pit-stop agent, whose area this is.**

Not on the known-failing list in PROJECT.md, and failing on `main` @ `7f1f3da`:

```
choice -> stop, silverstone
  chose soft   wing=change -> fitted null  nose=kept wing=1.00 stationary=0.0s
  chose soft   wing=keep   -> fitted null  nose=kept wing=1.00 stationary=0.0s
  chose medium wing=change -> fitted null  ...
  chose medium wing=keep   -> fitted null  ...
  chose hard   wing=change -> fitted null  ...
  chose hard   wing=keep   -> fitted null  ...
  chose nothing            -> fitted hard nose=new        <- the only one that works

7 failure(s):
  - soft/change: the car never completed a stop, so nothing was proved
  ... (all six)
  - 0 of 6 stops completed
```

The one case that completes is `want = null, repair = 'crew'` — i.e. the driver
asks for nothing and the crew decides. Every case where the player states a
compound **or** a wing choice fails to complete a stop at all.

**What I did not establish, and why.** The passing case differs from the six
failing ones in *both* variables at once, so this does not say whether the
trigger is `setPitCompound`, `setPitRepair`, or the combination. I wrote a
diagnostic to separate them and **it was invalid** — it drove the car with a
crude full-throttle-no-steering loop, which retired it before it ever reached the
pit lane in all six arms (`enteredLane=false, retired=true` throughout), so it
distinguished nothing. Isolating this properly needs the probe's own
`ProbeDriver`, which lives inside `probePitStop.ts` and is not exported. I have
left that to the owner rather than guess, and discarded the diagnostic rather than
report a conclusion it could not support.

**Verified as not a stale-branch artefact**: re-run after merging `main` @
`7f1f3da`, with the same result. **Verified as not my `FORCE_COLOR` problem**
(finding B9): this probe spawns nothing and parses no banner.

**Corroborated from an unrelated probe.** `validate:integrity`, run separately
and passing, exercises the pit lane on its own terms and reports:

```
pit lane (bahrain, 44 laps)  stops=25  serviced=20/20  servicedTwice=5/20
                             reEnteredLane=5/20  speedingPenalties=0
```

**20 of 20 cars serviced, five of them twice.** So pit stops are not broken in
general — they work perfectly when the crew decides, which is exactly the one
case `probe:pitstop` passes. That narrows A2c considerably without needing the
isolation diagnostic: the failure is specific to a stop carrying an explicit
player request, not to pit stops as a mechanism.

If it is the product rather than the harness, it means **choosing your own tyre
is what stops your pit stop working** — which would be worth knowing before the
pit-stop choreography work lands on top of it.

---

### A2d — `probe:stewards` fails its liveness floor: 1 penalty in 11 races
**Severity: high. Confidence: certain that it fails; the cause is the judgement
threshold, not detection. Owner: stewards.**

Not on the known-failing list, and failing on `main` @ `7f1f3da`:

```
FAILURES:
  1 penalties in 11 races — the bench has stopped finding anything
```

PROJECT.md §7 records stewards under-detection as measured and deferred at
**0.4–1.6 penalties per race** against a real 1–3. That would be 4–18 penalties
across these 11 races. The current figure is **1 — 0.09 a race**, four to
seventeen times below the documented-bad level.

**It is not a detection failure.** The bench notes 36 incidents (3.27 a race) and
declines 35 of them:

```
WHY THE BENCH DECLINED
    15  not on the same line          8  side by side, no corner to own
     5  contact without consequence   4  level at the apex
     2  multi-car incident            1  neither car moved across
```

So the guideline geometry is running and returning "no further action" almost
every time. That matches the documented cause ("most contact never reaches a
guideline") but the magnitude has moved.

**A hypothesis I checked and discarded, recorded so nobody re-checks it.** The
probe prints `...on too few events to assert on` a few lines above the failure,
which looks like a probe failing on a sample it has just declared insufficient.
It is not. That warning is attached to the *57-lap extrapolation*; the assertion
that fails is a separate, deliberate floor on the **raw count**
(`probeStewards.ts:966`), whose comment states the reasoning explicitly: *"Not a
rate — a floor on the raw count, which is the one thing a small sample can speak
to."* The probe is well-built here and the signal is real.

**One caveat that does apply.** The sweep runs 11 races of **5 laps**
(`SWEEP_LAPS` default, `:1020`), and finding A1 removes the final lap from every
car except the leader — about 20% of the racing distance at that length, and the
final lap is where a race's incidents concentrate. **Re-run this after A1 is
fixed before concluding the bench itself regressed.** `STEWARDS_LAPS=20
STEWARDS_SEEDS=1,2,3` is the sample the probe itself recommends.

---

### A3 — The recorded diagnosis of the known-failing `probe:hudtext` is wrong
**Severity: high (it is sending work in the wrong direction). Confidence: certain.**

`PROJECT.md` §4 and §7 record `probe:hudtext` as failing on *"no team-owned
bulletin was filed in a 20-minute race"*, traced to *"an engine call site that
never fires (`RaceEngine.ts` ~2525)"*. That is not the cause.

The probe's routing section (`scripts/probeHudText.ts:317-322`) builds a race with
`playerIndex: 0` and **never writes to `engine.playerControls`**. The player's car
therefore sits on its grid box at zero throttle, and finding A2 does the rest: the
whole field piles up behind it and stops.

**Measured** by wrapping `raceControl.log` and counting every bulletin as it is
filed, before the 60-message ring buffer can drop it — the probe's own config,
Spa, 1200 simulated seconds:

```
FILED over the whole race:  race-control: 6   either: 3   team: 0
context: 0 pit stops across the field, 1 retirement, leader on lap 1
newest message in the buffer: t=213.3s   (of 1200s simulated)
```

Nothing happens after t≈213s because nothing is moving. No laps, no pit stops, no
damage — and therefore no team bulletins, because five of the six team-feed call
sites are pit-stop, pit-entry and damage events. The call sites are fine.

**The probe's own output says so, and this is the cleanest evidence of all.** Its
penultimate line on the current tree reads:

```
channels: 1 to race control, 0 to the team, 0 dropped as somebody else's business
FAILURES:
  no team-owned bulletin was filed in a 20-minute race
```

**One** race-control message in twenty minutes of racing. A real twenty-minute
race files dozens — flags, track limits, penalties, stops. The number that was
meant to be the control for the failing assertion (`check(toControl > 0, 'race
control never spoke in a 20-minute race')`) squeaks past on a single message, and
that is the tell: it is not the team channel that is quiet, it is the entire
session. Every other assertion in the probe passes because they are exercised
against hand-built fixtures rather than the frozen race.

**What this costs:** an agent sent to fix "a call site that never fires" will find
a call site that works and no bug. The real fixes are A2, and separately giving
the probe a driven player car.

---

### A4 — VSC/safety-car delta penalties stack for the rest of the race
**Severity: high. Confidence: high (grep-proven; not yet reproduced in a race).**
**File:** `src/race/CarEntry.ts:458`, `src/race/RaceControlManager.ts:1447-1457`

`grep -rn deltaBreaches src/` returns exactly three lines: the field initialiser
`deltaBreaches = 0`, one `car.deltaBreaches++`, and one `if (car.deltaBreaches >= 2)`.
There is no reset anywhere — not when the neutralisation ends, not in
`RaceControlManager.reset()` (which does clear `scOnTrack`, `pitExitClosed`,
`lappedCarsWaved`, `scWaveLap`, `vscGreenIn`), and not on the sibling path at
1421-1429 which clears `deltaSectorTime` / `deltaSectorIndex` / `deltaSectorPartial`.

The comment at 1447 states the intent: *"First one is a warning; a driver who
keeps ignoring the delta is gaining a real advantage and takes the time penalty."*
Because the counter latches, the warning is one per **race**, not one per
neutralisation. Once a car reaches 2, every subsequent marshalling sector
completed below the minimum — in any later VSC or safety car — takes the `>= 2`
branch and adds another 5-second penalty.

**What the player sees:** a "5 SECOND TIME PENALTY — BELOW THE DELTA" notice, then
repeats of it stacking every few seconds during a later safety car, and a
classification silently 15-40s worse.

---

### A5 — Post-processing, shadows and MSAA are unreachable on every phone, and there is no graphics setting
**Severity: high on the target device. Confidence: high (grep-proven).**
**File:** `src/main.ts:219`

```ts
const setting = this.settings.quality === 'auto' ? undefined : this.settings.quality;
```

`GameSettings.quality: 'auto' | 'low' | 'high'` defaults to `'auto'`
(`src/career/SaveManager.ts:54,104`) and is **assigned nowhere in the repo** —
`grep -rn "settings.quality" src/` returns that single read. The settings screen
(`src/main.ts:1690-1790`) offers AI difficulty, three assists, racing line, volume,
tilt and camera; there is no graphics section at all. So the ternary's false
branch is unreachable, `setting` is always `undefined`, and the renderer falls
through to `(touchPrimary || cores <= 4 ? 'low' : 'high')` (`src/render/Renderer.ts:246`).
Only `?quality=high` in the URL overrides it.

Consequently, on every touch device, permanently and with no way to try otherwise:

- **The entire post chain is off** — `src/render/PostFX.ts:703`
  `this.enabled = quality === 'high'; if (!this.enabled) return;`. That is bloom,
  screen-space AO, chromatic aberration, vignette, dither, the weather grade,
  night bias, `triggerFlash`, and the **radial speed blur** that PostFX's own
  header calls "the single most effective speed cue there is".
- **All real shadows** — `src/render/Renderer.ts:270, 285`.
- **MSAA** — `src/render/Renderer.ts:250`.
- Reduced-detail paths throughout `TrackMesh`, `Paddock`, `Grandstands`,
  `Signage`, `ParticleSystem`, `SkidMarks`, `Rain` and `CarMesh`.

Verified directly rather than inferred. `src/render/Renderer.ts:246`:

```ts
this.quality = opts.quality ?? (touchPrimary || cores <= 4 ? 'low' : 'high');
```

and `src/render/PostFX.ts:703-704`, the first two statements of the constructor:

```ts
this.enabled = quality === 'high';
if (!this.enabled) return;
```

The whole post chain is never even built. `antialias: this.quality === 'high'`
(`Renderer.ts:250`) turns MSAA off in the same breath.

This is the same shape as the mirror-feed bug already in the record — a feature
gated on a tier the reporting device never gets — and PROJECT.md §6 establishes
that the reporting device *is* a phone ("every phone is `low` and it had never run
on the reporting device at all"). So the standing complaint *"the graphics are
utter dogshit"* has been made, throughout this project, about a device that
renders **no post-processing, no shadows and no anti-aliasing**, with no in-game
way to ask for any of it. That is worth weighing before any more render work is
commissioned: some of the quality gap may not be the renderer at all.

`Renderer.ts:347 get postEnabled()` is dead code with no callers.

---

### A6 — The on-screen REV pad does nothing, and pressing it actuates a different control
**Severity: high on phones. Confidence: certain on "inert"; high on "actuates
something else"; the specific control depends on viewport.**
**Files:** `src/input/InputController.ts:207, 808`; `src/ui/Hud.ts:579, 1960`

`grep -rn reverseTouchHeld src/` returns three lines: the initialiser
`reverseTouchHeld = false`, the HUD reading it to paint the button's active state,
and `out.reverse = this.reverseHeld || this.reverseTouchHeld`. **It is never
assigned anything but `false`.** `TOUCH_ZONES` (`InputController.ts:171-178`) has
only `steer / throttle / brake / drs / ers`; `ActiveTouch['role']` has no
`'reverse'` member and `zoneFor` cannot return one.

The HUD nevertheless builds and paints the button, with a full `.active` style in
`styles.css:1740-1745`.

The pad is a painted label and nothing more: `.hud-touch { pointer-events: none; }`
(`styles.css:1696`), so the touch passes straight through the overlay to the
canvas, where `zoneFor` decides what it means from the normalised coordinates
alone. **Pressing REV therefore actuates whichever `TOUCH_ZONES` box it happens
to sit on.**

Working that through for an iPhone-sized landscape viewport (844×390 CSS px),
from `.touch-reverse { right: 18px; bottom: calc(64px + 34vh); width: 22vw;
max-width: 150px; height: 46px }`:

- x spans 676→826 px, so **nx 0.80 → 0.98**
- bottom is 64 + 0.34×390 = 196.6px, so y spans 147.4→193.4 from the top, **ny 0.38 → 0.50**

Against `TOUCH_ZONES` (`InputController.ts:171-178`) that lands inside
`ers: { x0: 0.72, y0: 0.3, x1: 1.0, y1: 0.48 }` — **not** `throttle`, whose
`y0` is 0.5. So on that viewport pressing REV cycles the **ERS mode**. On a
taller or shorter viewport the 34vh offset moves it, and the throttle box
(`x0: 0.72, y0: 0.5`) is directly below. Either way it is not reverse.

(Recorded precisely because the first pass at this finding asserted "throttle"
and the arithmetic does not support it. The certain part — inert, and it fires
somebody else's control — is what matters.)

**What it costs the player:** on a phone there is no way to reverse out of a
gravel trap or off a wall at all. Reverse is keyboard down-arrow or a gamepad
binding only. The visible button lies about it, and pressing it drives you further
in. Given A2, a player who cannot reverse off a wall also cannot un-block the race.

---

### A7 — `mayEnterPitLane` is an unconditional `return true`; the pit-closed radio call can never fire
**Severity: medium. Confidence: high (grep-proven).**
**File:** `src/race/RaceControlManager.ts:491, 561, 690`

`grep -rn pitEntryClosed src/ scripts/` returns exactly three lines: the
declaration `= false`, the reset `= false`, and the read `if (this.pitEntryClosed)
return forRepairs`. **No `= true` exists.** The Art. 34.15 / B1.6.4 closure the
doc comment at 476-491 describes is unreachable.

Compounding it, all three callers hardcode the first argument:
`RaceEngine.ts:2215, 2392, 2468` all pass `forTyres = true`, so the neutralisation
branch `return forTyres || forRepairs` is also always true. The function has three
branches and returns `true` in all of them.

Knock-on: `car.pitEntryRefused` (`CarEntry.ts:198`) can only be set at
`RaceEngine.ts:2470`, gated on `!allowed`, so it is never true — and the
`pit-closed` team-radio bulletin at 2471-2476 has never once been sent. That is
one of the six team-feed call sites `probe:hudtext` is looking for.

---

### A8 — The fuel readout mixes the leader's laps-remaining with the player's fuel
**Severity: medium. Confidence: high.**
**File:** `src/ui/Hud.ts:1043-1049`

```ts
const lapsLeft = engine.lapsRemaining;        // LEADER-based: RaceEngine.ts:3406
const perLap = fuelPerLap(player, engine);    // player-based
const lapsOfFuel = p.fuelRemaining / perLap;  // player-based
const margin = lapsOfFuel - lapsLeft;
```

`RaceEngine.lapsRemaining` (`:3406`) is `laps - this.leaderLap()`. Everywhere else
in the codebase laps-remaining is computed per-car as `totalLaps - car.lap`
(`RaceEngine.ts:799, 850, 2059, 2170, 2810`; `Hud.ts:1502, 1857`). Only this one
readout mixes the two, so for a lapped player the numerator and the subtrahend
disagree by exactly `player.lapsDown`.

**What the player sees:** the `FUEL … +x.x LAPS` margin reads a full lap too
optimistic — green when it should be red — for anyone a lap down, while the lap
counter two lines away (`Hud.ts:1074`) is player-based. Two numbers on one panel
derived from different cars.

---

### A9 — Race penalties are issued in practice and qualifying: two of the three per-car checks never receive `isRace`
**Severity: medium. Confidence: certain on the missing checks.**
**File:** `src/race/RaceControlManager.ts:740-745`

```ts
for (let i = 0; i < cars.length; i++) {
  const car = cars[i];
  if (car.retired) continue;
  this.checkTrackLimits(car, i, sessionTime, isRace);   // gets it
  this.checkPitLaneSpeed(car, i, sessionTime);          // does not
  this.checkNeutralisationDelta(car, i, dt, sessionTime); // does not
}
```

`isRace` is a parameter of `update` (`:732`) and is threaded into
`updateNeutralisation`, `checkTrackLimits` and `stewardsBench.update`. The other
two siblings on the same three lines never get it, and neither has any other
session-kind guard — verified by reading both signatures
(`:1699` and `:1413`).

- **`checkPitLaneSpeed`** unconditionally pushes `{ kind: 'drive-through' }` plus
  a `'critical'` race-control notice reading "DRIVE THROUGH PENALTY".
- **`checkNeutralisationDelta`** unconditionally pushes `{ kind: 'time-5s' }` and
  adds `car.penaltySeconds += 5` (`:1450-1457`) — the same code path as A4.

In a non-race session `pendingServePenalty` short-circuits
(`RaceEngine.ts:2037`) and `convertUnservedPenalties` only runs for races
(`:3359`), so neither penalty can be served nor converted: a phantom on the car
and a false critical banner. A five-second *time* penalty is meaningless in a Lap
Time Classified Session by construction. This is the same session-kind blindness
class as the qualifying DNF and the out-lap lap-deletion already in the record.

(Checked and *not* true: the breaches do not carry across sessions. `CarEntry` is
constructed once per engine (`RaceEngine.ts:414`) and each session builds a new
engine, so A4's latch is bounded by the session. Within a session it is not.)

---

### A10 — Tilt steering is saved and never restored
**Severity: medium on phones. Confidence: high.**
**File:** `src/main.ts:1759, 1762`; `src/career/SaveManager.ts:53, 103`

`settings.tiltSteering` is written by the settings card and persisted, and
`grep -rn tiltSteering src/` shows it is **never read**. `start()` restores
`speedSensitiveSteering`, `tractionAssist`, `brakingAssist`, `gamepad`,
`cameraMode`, `racingLine`, `masterVolume` and `aiDifficulty` — and not this one.

**What it costs the player:** a phone player must re-enable tilt steering, and
re-clear the iOS DeviceOrientation permission prompt, on every single page load.

---

### A11 — The touch controls are invisible until the player blind-taps the canvas
**Severity: medium. Confidence: high on the mechanism.**
**File:** `src/input/InputController.ts:885, 244, 496`

```ts
return this.touchAvailable && (this.lastSource === 'touch' || this.lastSource === 'tilt');
```

`lastSource` initialises to `'keyboard'` and only becomes `'touch'` inside
`onTouchStart`. Touch listeners are attached to the canvas alone
(`main.ts:274`), and the menus are DOM overlays outside it — so navigating the
entire menu tree on a phone never flips it. `Hud.updateTouch` returns early with
`display: none` (`Hud.ts:1940-1942`) for the opening of every session: throttle,
brake, DRS, ERS and the steering joystick are all hidden through the formation lap
and the lights until the player guesses where to press. `lastSource` also reverts
to `'keyboard'` on any keydown (`:425`), hiding them again mid-session on a tablet
with a keyboard attached.

Cheap fix: seed `lastSource = 'touch'` when `touchAvailable` is detected in
`attach()`.

---

### A12 — Config fields declared, documented, and read by nothing (the `carPace` shape)
**Severity: medium. Confidence: very high (each grep-proven).**

The bug class that produced *"an F3 race ran in a 1000hp F1 car"*. Each of these
is declared, assigned in a data table, carries a comment promising behaviour, and
has **zero** `.field` read sites anywhere in `src/`.

| field | declared | comment claims | reads |
|---|---|---|---|
| `PowerUnit.costPerSeasonUsd` | `src/data/roster/powerUnits.ts:47` | "Cost of a customer supply deal, per season" | **0** |
| `PowerUnit.minReputation` | `:67` | "Reputation a team needs before this manufacturer will discuss a deal… the reason a struggling team cannot simply buy the best engine" | **0** |
| `PowerUnit.customersFrom` | `:70` | "Season this manufacturer will supply customers from" (one unit is set to 2029) | **0** |
| `PowerUnit.developmentRate` | `:79` | "Applied each off-season, so the right deal in season one is not the right deal in season six" | **0** |
| `VehicleSpec.peakTorqueFrac` | `src/physics/VehicleSpec.ts:36`, value `0.72` at `:94` | "Fraction of redline where peak torque occurs" | **0** |
| `SeasonSummary.constructorByTier` | `src/career/Season.ts:95`, written `Career.ts:330` | "Constructors' champion team id per tier" | **0** |
| `SaveSlotInfo.seasonYear`, `.savedAt` | `src/career/SaveManager.ts:42, 44` | — | **0** |
| `RealCircuitGeometry.officialLengthM` | `src/data/tracks/realGeometry.ts:17` | header: "the track spline rescales them to each circuit's official length" | **0** |

The engine-supply story is the notable one: **engine deals are currently free,
ungated and static**, while four fields and four comments say otherwise. The only
consumer of a `PowerUnit` is `powerUnitFor` (`powerUnits.ts:161-170`) plus
`World.ts:320-324, 340`, and between them they read exactly `worksTeamId`,
`customerPenalty`, `powerMult`, `ersMult`, `failureRate`, `shortName`, `id`.

`peakTorqueFrac` means the engine's torque-curve shape is whatever
`VehiclePhysics` hardcodes, while its neighbours `idleRpm` / `redlineRpm` are read
repeatedly.

Also dead, lower value: `CarEntry.recoveryTimer` (written every step at
`RaceEngine.ts:3250`, read nowhere), `CarEntry.wearPerLapEstimate()` and
`TireModel.estimatedLapsToCliff()` (a superseded third derivation of tyre life —
the live one is `Strategy.stintLife()`), `InputController.tiltAvailable`,
`Renderer.postEnabled`, and `NeutralisationState`'s `'sc-ending'` member which is
never assigned or compared.

---

### A13 — The Paddock and Quick Race show fictional teams; only Career uses the real roster
**Severity: low-medium (may be intentional). Confidence: high on the fact.**

`src/main.ts:13` imports `TEAMS`, `DRIVERS` from `./data/teams` — the fictional
grid ("Apex Racing", "Viktor Halvorsen") — while `REAL_ROSTER` reaches the grid
only through `Career.ts:74 createWorld(seed, REAL_ROSTER)` → `installGrid`. A
player who opens **Paddock** or starts a **Quick Race** without a career sees the
fictional grid; a career player sees the real one.

Screenshot evidence: `audit-out/smoke/Paddock10_teams*.png` (produced by
`npm run probe:smoke`) shows "01 APEX RACING / Viktor Halvorsen / Malik Okonkwo".

Flagging rather than asserting: given the IP position in PROJECT.md §3 this may be
a deliberate fallback. But it reads as an inconsistency against *"i want you to
use the actual teams… I also want you to show the drivers too"*, and the two
front-of-house screens most likely to be shown to someone are the two that do not.

---

## B. The harness — probes that cannot see what they test

The brief's second bug class. For each probe the question asked was: *what would
have to break for this to fail, and can it actually observe that?*

### B1 — `probe:racesweep` prints `FAIL` and exits 0 — **fixed, see C8; it went red immediately, see A2b**
**Confidence: certain.** `scripts/raceSweep.ts:108-111` computes
`const failed = rows.filter((r) => r.failures.length > 0)`, prints each one, and
never uses it again. There is no `process.exit` or `exitCode` anywhere in the
file. A full-circuit regression — no finishers, lap times 2× reference, zero
overtakes — prints `FAIL bahrain/3: …` and returns success. This is finding A12's
shape applied to the test suite: a value computed for a purpose and never read for
it.

### B2 — Twelve probes have no failure exit path at all
**Confidence: certain** (`grep -LE "process\.exit\(1\)|exitCode *= *1"`):
`probeFrameRate`, `probeDrivability`, `probeCurvature`, `probeHandling`,
`probeKerbs`, `probeBrakeBalance`, `probeTurnIn`, `probeSurfaceSteps`,
`probeNeutralisation`, `raceSweep`, `diagHud`, `buildCircuitGeometry`.

Two are large and load-bearing:

- **`probeDrivability.ts`** (1206 lines) prints its own thresholds as string
  literals — `:1194-1204` `'worst turn-in t90 ' + … + ' s (want < 0.35)'`, and four
  more `want` values — and compares none of them. The car can become undrivable
  and `probe:drivability` exits 0.
- **`probeFrameRate.ts`** (969 lines) computes
  `const identical = linYaw.pct < 1e-6 && linLat < 1e-6 && satYaw.pct < 1e-6;` at
  `:911` and uses it **only to choose which sentence to print** (`:913-916`). A
  regression reintroducing the 47% frame-rate-dependent steering this very file
  documents finding is reported as prose, exit 0.
- **`probeNeutralisation.ts`** is the expensive one. It contains no `check(` and
  no `fail(` anywhere — it is a pure reporting script — and in this sweep it ran
  for **over 40 minutes without finishing** before the harness timeout killed it
  (it had reached row 5 of 9). So it is 40+ minutes of compute that cannot, by
  construction, report a failure to `npm run`. It also defaults to **3 circuits**
  (`zandvoort,silverstone,monaco` at `:86`), not eleven.

  Its partial output is worth a second look by whoever owns neutralisation:
  **13.8% – 38.1% of race distance run under a safety car or VSC** across three
  circuits (32.5% and 38.1% on the 5-lap runs). That is far above a real season
  and it would be caught automatically if this file had a threshold. Flagged, not
  asserted — the probe was killed before printing whatever verdict it intends,
  and it has none to print.

### B3 — `probe:renderperf` has no verdict and swallows page errors
**Confidence: certain.** The only `throw`s are harness failures (no Chrome, no
vite port, fewer than 10 frames sampled). `errors` collects `pageerror` and
`console.error` (`:481-491`) and is printed but never gates the exit
(`:534-540`). The game can settle at `resolutionScale 0.5`, 22fps, and throw a
WebGL error every frame — the probe written specifically to replace the blind
`audit:circuits` succeeds. It inherited "no verdict".

### B4 — The documented `audit:circuits` dt bug is still live
**Confidence: certain.** `audit/audit.ts:220` `renderer.render(1 / 60, engine, focus);`
and `:263` `renderer.post.update(1 / 60, …)`; `audit/hud.ts:118` the same.
Against the current scaler (`Renderer.ts:108,121,1019,1028`: `DROP_MS = 20`,
`CLIMB_MS = 17.2`, `MIN_SCALE = 0.5`, `MAX_SCALE = 1.0`), 16.67ms never exceeds
`DROP_MS` so the drop branch is unreachable, and the climb branch is additionally
gated on `resolutionScale < Math.min(MAX_SCALE, climbCeiling)` — `1 < 1`, false.
**Every audit PNG is still shot at `resolutionScale = 1`, forever.** `shoot:hud`
inherits it. PROJECT.md §6 records this as the reason nobody found the resolution
bug; the harness has not been fixed, only supplemented.

### B5 — `probe:sharpness` measures the scaler on a paused game
**Confidence: certain.** `scripts/probeSharpness.ts:125-129` sets
`window.__game.clock.paused = true` and *then* waits `SETTLE_MS` before reading
`resolutionScale`. The number recorded is the scale for a frozen grid-formation
scene — no car motion, no shadow churn, no spray — and it is then pinned (`:143`)
and used as the shot scale. This is the probe written to fix B4 and it reproduces
the same failure mode. It also has no assertion of any kind.

Its own comment at `:132-135` is worth quoting, because it is finding A2 observed
and worked around rather than reported: *"Left to itself the deep-linked player car
has nobody driving it, and by the time the scene is worth photographing it is
parked against a barrier under a virtual safety car."*

### B6 — `probe:cameras` lies to the camera director about dt by 4× — **fixed, see C9**
**Confidence: certain.** `scripts/probeCameras.ts:108-114` steps the engine at
`PHYSICS_DT` (1/120), samples every 8th step — 1/15 s of simulated time — and then
calls `dir.update(1 / 60, …)`. The director's damping integrates at **one quarter**
the real rate, so a camera that whips into a barrier damps toward that position 4×
more slowly and may never reach it inside the window. The probe systematically
*under*-reports intrusion, which is the only thing it exists to detect.
Secondary (`:117-118`): camera `p.y` is compared against the road height under the
**car**, not under the camera, so a chase cam on a downhill is judged against the
wrong ground.

### B7 — Two probes can evaluate zero cases and still print PASS
**Confidence: certain.**

- `scripts/probeRacingLine.ts:205-210` — `if (v === null) continue;`, where
  `fastestGreen` returns `null` whenever the road ahead is not green (`:346-347`).
  If a regression makes the overlay never green — wrong colour constants, swapped
  channel, empty ribbon — every node returns null, `worst` stays 0, `failures`
  stays empty, and it prints `PASS — green means the car makes the corner, on all
  eleven circuits`. There is no counter of nodes actually evaluated. (The
  documented tautology — flying the reference car — *is* genuinely fixed. This is
  a new hole in the same probe.)
- `scripts/probeCurvature.ts:36` — `if (!REAL_GEOMETRY[def.id]) continue;`. With
  `REAL_GEOMETRY` emptied or its keys renamed, `n` stays 0, every ratio is `NaN`,
  every `NaN > threshold` is false, and it prints `VERDICT: the two geometries are
  comparable` on zero circuits examined. No `process.exit` in the file either.

### B9 — `regress:career` cannot start at all when `FORCE_COLOR` is set — **fixed, see C10**
**Confidence: certain. Nearly reported as a product bug; it is not one.**
**File:** `scripts/regressCareerFlow.mjs:51`

```js
const m = String(b).match(/localhost:(\d+)/);
```

The harness runs `vite --port 0` and reads the assigned port off the banner. Vite
prints that port **bold** — the bytes are literally
`localhost:\x1b[1m5199\x1b[22m/` — so the regex finds nothing, `PORT` stays 0
forever, and the run dies on `vite did not answer in 60s (port never announced)`
with a perfectly healthy dev server listening beside it.

Vite drops the colour when stdout is not a TTY, which is why this ever worked. It
does **not** drop it when `FORCE_COLOR` is set, which most CI runners set and
which every agent shell on this machine has (`FORCE_COLOR=3`). So the entire
`npm run regress` target dies at this step in exactly the environment an
automated sweep runs in.

**How it was nearly mis-reported, which is the point of writing it up.** It
surfaced as `regress:career EXIT=1` in the sweep — a probe not on the
known-failing list, i.e. apparently a new regression from another agent's
front-door work, which had just landed. The first re-run failed too, at load 6.7,
which ruled out the contention explanation the brief warns about. Only unsetting
`FORCE_COLOR` and re-running showed it passing every assertion. **It was the
measuring instrument, not the thing measured.**

`regressSessionExit.mjs:81` is unaffected — it matches the contiguous substring
`'ready in'` and uses a fixed port — and it passed in the same sweep, which is
the detail that made "environment, not product" worth testing rather than
assuming.

---

### B8 — Remaining tautologies and coverage gaps
**Confidence: medium-high.**

- `scripts/probeQualiBoard.ts:69-76` — the headline check compares
  `qualifyingBoardOrder`'s output against `rankSegment(engine.participants)`, and
  `qualifyingBoardOrder` calls `rankSegment` internally. X against X: it can catch
  a re-sort in the wrapper, never a wrong ranking rule. The real coverage is
  check #2 (monotone by lap time).
- `scripts/probeStrategy.ts:88, 100-105` — the recommendation check re-derives
  `want` from `strain` and `pitCostS`, the same fields `strategyOptions` used to
  produce the `RECOMMENDED` label; a wrong strain model produces a wrong `want`
  identically and passes. `:88` compares `pitLossS()` against `pitLossS()`.
- `scripts/probeIdentity.ts:182-193` — the championship leg hand-builds the
  `RoundResult` inside the probe rather than assembling it from a finished
  session, so a bug writing the wrong driver ids into the standings after a race
  is invisible. (Its `check(trueIndex !== 0, 'the player is NOT index zero, so
  this probe is measuring something')` at `:89` is the best anti-tautology guard in
  the repo and is worth copying.)
- `scripts/probeStewards.ts:984-991` — the bias check is gated behind
  `t.penalties >= 4` / `>= 8`, while the default sweep is 11 five-lap races whose
  own comment says the penalty count is "typically nought, one or two". The probe
  calls this "the single most important number in the block" and then skips it.
- **Single-circuit probes**, against the project's documented "check all eleven"
  standard: `probeFlags:869` monza, `probeIntegrity:528` bahrain,
  `probeWorld:891` monaco (the 200 km/h **barrier-impact** test — barrier geometry
  differs per circuit, so this one is not circuit-independent),
  `probeTraffic:192,265,328,395` (4 of 11 for the staged cases — Jeddah,
  Zandvoort, Suzuka and COTA never see the pit-queue or racing-room cases),
  `probePitStop`, `probeStrategy`, `probeHudText`.
- `scripts/probeTraffic.ts:432` counts an "overtake" as any position gain sampled
  every 12 steps, including churn from pit stops and retirements, so the
  `totalOvertakes >= 1500` floor at `:491` can be met without a genuine pass.
- `scripts/lib/domStub.ts:76, 80-85` — `measureText` returns a constant
  `{ width: 10 }` and `getImageData` returns all-zero pixels, so anything derived
  from canvas content in `probeCarRig`, `probeWorld`, `probeTrackLimits` and
  `probeFlags` is measured against blanks. `:59 if (g.document) return;` also
  silently no-ops, so a probe can believe it installed a stub it did not.

---

## C. Fixed in this pass

Small, safe and inside the QA function's own files. Nothing in `src/` was touched.

1. **`scripts/` is now typechecked** — the documented permanent gap. New
   `tsconfig.scripts.json` (a separate project so `@types/node` does not leak into
   browser code in `src/`), wired into `npm run typecheck` and `npm run build`.
   It surfaced **47** errors, not the six previously recorded; all 47 are fixed and
   the check is clean. `audit/` is included in that project because the audit pages
   carry the `declare global` blocks for `window.__panels` / `__hudShoot` /
   `__career` that the `shoot*` harnesses drive — 18 of the 47 errors were the
   screenshot harnesses calling an untyped page API.
2. **`scripts/probeFieldSize.ts:131`** — `while (!engine.finished …)`. There is no
   `finished` property on `RaceEngine` (it is `over`), so the read was `undefined`
   forever and the loop always burned the full 2400 simulated seconds. The
   `leaderLaps >= RACE_LAPS` check below it was therefore being asked after forty
   minutes of simulation rather than after the chequered flag, so a simulation
   running at a third of the right pace still passed. Now `!engine.over`.
3. **`scripts/auditCar.ts:94`** — tested `m.type() === 'warning'`. Puppeteer's
   `ConsoleMessageType` has no `'warning'` member (it is `'warn'`), so the
   comparison was constantly false and `audit:car` **has never recorded a single
   console warning**. Now `'warn'`.
4. **`scripts/probeTurnIn.ts:49`** — `new VehiclePhysics(BASE_F1_SPEC, 'medium', 40)`
   passed a third argument to a two-argument constructor; JavaScript had been
   silently dropping it since the signature changed. Removed (the temperature the
   tyre model reads is the one in `env`, already 40, so no number moves).
5. **`scripts/lib/domStub.ts:60`** — the type annotation named `createElement`
   while the object supplied only `createElementNS`. Both are now supplied;
   `src/main.ts` uses `createElement` on every screen it builds.
6. **Five probes** (`probeAttrition`, `probeNeutralisation`, `raceSweep`,
   `tuneAI`, `validateRace`) built a `SessionConfig` without the required
   `pitLaneStart`, and two (`validatePhysics`, `probeAttrition`) built
   `VehicleControls` without the required `reverse`. Both were `undefined` at
   runtime — falsy, so no behaviour changes — but the drift was invisible.
   Now explicit.
7. **Removed dead code**: `PIN` in `probeRenderPerf.ts` (superseded — the ablation
   pins the scaler at `:391`; verified before deleting), unused imports in
   `probeCurvature`, `probeStewards`, `probeTiers`.
8. **`scripts/raceSweep.ts`** now sets `process.exitCode = 1` when any race in
   the sweep fails (finding B1). It had none.
10. **`scripts/regressCareerFlow.mjs:51`** now strips ANSI before matching the
    port (finding B9), so `npm run regress` survives `FORCE_COLOR` being set.
    Verified both ways: it failed with `FORCE_COLOR=3` before the change and
    passes with `FORCE_COLOR=3` after it.
9. **`scripts/probeCameras.ts:114`** — `dir.update(1 / 60, …)` while sampling
   every 8th physics step (1/15 s) is now `dir.update(8 * PHYSICS_DT, …)`
   (finding B6). The probe still passes on all eleven circuits with the honest
   dt — the fix does not turn it red, it makes it able to see a camera that
   damps into a barrier.

**New probes** (all wired into `npm run`):

| command | what it proves |
|---|---|
| `probe:finish` | the field is timed across the line one car at a time — **fails, A1** |
| `probe:blockage` | a car stopped on the racing line does not stop the race — **fails, A2** |
| `probe:smoke` | every reachable front-end screen renders and throws nothing — **passes** |

`probe:smoke` closes a real gap: every other probe either drives the simulation
with no UI, or reaches a session through the `?circuit=` deep link, which is
documented as going *"past the garage briefing"* — i.e. past the entire front end.
It boots the real game with empty storage as a first-time player, breadth-first
walks the buttons it finds, and fails on uncaught exceptions, `console.error`,
blank screens, or too few screens being reachable. Shots land in
`audit-out/smoke/`.

It is **complementary to, not a duplicate of**, the front-door work that landed on
`main` while this pass was running: `probe:frontdoor` proves the identity/profile
state machine in node with an in-memory store, `regress:career` drives the
first-run path and the skip button, and `probe:menucost` measures what the live
menu costs the GPU. None of the three walks every button on every screen looking
for one that throws or leads nowhere, which is what this does.

**The typecheck gap closure earned its keep within minutes.** Merging current
`main` into this branch immediately surfaced two type errors in
`scripts/shootFrontEnd.ts`, a harness another agent had just committed —
`asElement()` returning `ElementHandle<Node>` where `.click()` needs
`ElementHandle<Element>`, and the same `pageerror` unknown-type pattern as the
other ten. Neither could have been caught before, because nothing in `scripts/`
was typechecked. Both are fixed here.

---

## D. Verified clean

Recorded so the next pass does not re-walk them. Each was checked, not assumed.

- The three unreachable-gate examples from the project record are genuinely
  **fixed** in this tree: `CLIMB_MS = 17.2` is reachable on a 60Hz panel; the
  mirror feed now runs on both onboard modes and both tiers with a stride budget
  (`Renderer.ts:1153-1159`); the intro is replayable from the menu
  (`main.ts:904-907`).
- `Y_ROAD` / `ROAD_SURFACE_Y` — one is `= Y_ROAD`, documented, with `carGroundY()`
  as the single arithmetic point.
- Gap / interval / `lapsDown` — computed once in `RaceEngine.updateStandings`;
  `Classification.ts` and the HUD only format.
- Qualifying board vs grid — `main.ts:3683` derives both from one `qOrder`.
- `TIER_CAR` and everything on it, `TireCompound` (including `thermalSensitivity`,
  `wetGripCurve`, `warmupLaps`), `TeamPerformance`, `CarSetup`, `RosterTeam` /
  `RosterDriver`, and the rest of `VehicleSpec` all resolve to real read sites.
- Latches with a proven clear path: `holdUntilLine`, `mustUnlap`, `blueFlag`,
  `drsEligible`, `servicedThisVisit`, `pitTransitOnly`, `onOutLap`,
  `pitSpeedingFlagged`, `inPitBox`, `pitRequested`, `stuckTimer`, `releaseTimer`,
  `pitExitHold`, `blendRemainingM`, `pendingChange`.
- `classList.add` in `src/ui/` — `'signing'` and `'lit'` both land on elements the
  `page()` rebuild discards.
- DRS enable, blue flags, reliability failures, safety-car/VSC deployment and
  transitions, track-limits `sanctionableLap`, the `radioPitShown` "box this lap"
  latch, qualifying barred/entered logic, `pitReason` wear polarity, the weather
  event schedule.
- `probe:framing`'s halo measurement rebuilds the hoop from the exported
  `HALO_PATH` control points rather than reading the mesh in the scene
  (`probeFraming.ts:269-280`). The control points cannot drift; a transform or
  parent offset applied to the halo group in `CarMesh` would move the picture and
  not the measurement. Worth knowing, not currently wrong.

---

## E. Probe suite status on merged `main`

### The short version

**50 probe runs completed. 40 pass. Of the 10 non-zero exits, only 4 are the
game failing, and 2 of those were nobody-was-looking failures rather than new
ones.**

| exit | probe | what it actually is |
|---|---|---|
| 1 | `validate:flags` | **known-failing**, documented, 3 failures, numbers stable |
| 1 | `probe:hudtext` | **known-failing** — but the recorded cause is wrong, see A3 |
| 1 | `probe:pitstop` | **NEW — A2c.** Not on the known list |
| 1 | `probe:stewards` | **NEW — A2d.** Not on the known list |
| 1 | `probe:finish` | **new probe, by design — A1** |
| 1 | `probe:blockage` | **new probe, by design — A2** |
| 1 | `probe:racesweep` | **13/55 — A2b.** Was passing only because it had no exit code |
| 1 | `regress:career` | **not the game — my `FORCE_COLOR`, finding B9.** Now fixed and passing |
| 143 | `validate:race` | killed by the OS under load average 118; **passes when re-run alone** |
| 143 | `validate:integrity` | killed by the OS under load; **passes when re-run alone** — "PASS — no integrity failures", all 11 circuits, zero offside, zero through-walls |
| 142 | `probe:neutral` | hit my own 40-minute alarm; has no assertions anyway (B2) |

So of ten red lines, **three were my own instrument or the machine**, two were
already known, two are my new probes doing their job, and **three are the game:
A2b, A2c, A2d.** That ratio is the reason each one was chased down individually
rather than reported as a block.

### Full results


Run under heavy machine contention (load average 19-118 throughout), so durations
are not meaningful. Results:

| probe | result |
|---|---|
| `validate:tracks`, `validate:physics`, `validate:qualifying`, `validate:world`, `validate:difficulty`, `validate:gamepad`, `validate:limits` | pass |
| `probe:curvature`, `probe:handling`, `probe:framerate`, `probe:racingline`, `probe:turnin`, `probe:brakebalance`, `probe:attrition` | pass — **but see B2/B7**: several of these cannot fail |
| `probe:damage`, `probe:recovery`, `probe:neutralplayer`, `probe:pitlimiter`, `probe:cameras`, `probe:reverse`, `probe:suspension`, `probe:carrig` | pass |
| `regress:laps`, `regress:results`, `regress:exit` | pass |
| `regress:career` | **failed in the sweep, and it was my instrument, not the game** — see B9. Passes on every assertion once `FORCE_COLOR` is unset, and passes with it set after the C10 fix |
| `validate:race` | pass (killed twice by the OS under load before completing; passed when re-run alone) |
| `validate:integrity` | **pass.** Killed under load in the sweep; re-run alone it reports "PASS — no integrity failures" on all eleven circuits with zero offside, zero through-walls and walled-in fractions an order of magnitude under the threshold |
| `probe:racesweep` | **fail — 13 of 55 races, see A2b.** Newly visible: it had no exit code until this pass |
| `probe:neutral` | **did not finish in 40 minutes** and was killed by the sweep's own timeout, having reached 5 of 9 rows. Not a defect in it — its races are bounded by `MAX_STEPS` — but see B2: it has no assertions, so finishing would not have produced a verdict either |
| `validate:flags` | **fail — 3 failures, pre-existing and documented.** Numbers stable: double-yellow lift 21.6% vs single-yellow 85.3%; median safety-car gap 219m against the ten-car-length limit; safety-car lap ×1.36 a green lap against a real ×1.6-2.0 |
| `probe:hudtext` | **fail — pre-existing, but the recorded cause is wrong. See A3** |
| `probe:finish` (new) | **fail — A1.** Re-confirmed on merged `main`: 1/19 completed the distance, 19/19 share the winner's time |
| `probe:blockage` (new) | **fail — A2.** Re-confirmed on merged `main`: 27%/29%/26% of the control's laps; 0/20 moving at Monza, 0/18 at Monaco |
| `probe:smoke` (new) | pass — 6 screens, no console errors |
| `probe:strategy`, `probe:weather`, `probe:qualiboard`, `probe:kerbs`, `probe:surfacesteps`, `probe:debris`, `probe:tiers`, `probe:save`, `probe:fieldsize`, `probe:identity`, `probe:season`, `probe:traffic`, `probe:shoulders`, `probe:framing`, `probe:drivability` | pass — noting B2/B7/B8 again: `probe:drivability` returned in **0 seconds** and asserts nothing |

No probe that passed before this pass fails after it. The two fixes that change a
probe's behaviour (`probeFieldSize` `over`, `probeTurnIn` argument) were both
verified to leave the probe passing.

---

## F. Suggested routing

| finding | goes to |
|---|---|
| **A1** chequered flag | race/classification owner. Two-line reorder, then `probe:finish` |
| **A2** blockage deadlock | split: `checkBeached` → race-control owner; "AI will not pass a stopped car" → AI owner. `probe:blockage` |
| **A2c** pit stops with an explicit request never complete | **pit-stop agent, urgently** — it is their area and their probe, it is failing on `main` now, and the trigger still needs isolating with their own `ProbeDriver` |
| **A2b** Monaco sweep failures | AI owner. `npm run probe:racesweep` now reports it. Monaco first: 5/5 seeds, 107-123 off-track excursions per five-lap race |
| **A3** hudtext diagnosis | correct PROJECT.md §4/§7; fix follows A2 |
| **A4** delta breaches | safety-car / neutralisation owner |
| **A5** quality setting | front-end owner (needs a graphics section) **and** render owner |
| **A6** REV pad | input/HUD owner |
| **A7, A9** pit entry, session-kind | race-control owner |
| **A8** fuel margin | HUD owner |
| **A10, A11** tilt, touch overlay | input/front-end owner |
| **A12** dead config | career owner (engine deals), physics owner (`peakTorqueFrac`) |
| **A13** roster inconsistency | ask the user — this may be deliberate |
| **B1-B8** | QA. Cheapest first: `raceSweep` exit code; `probe:renderperf` failing on page errors and an fps floor; moving `clock.paused` after the settle in `probeSharpness`; real elapsed dt in `probeCameras`; coverage counters on the two `continue` skips; giving `probeDrivability`'s printed `want` values teeth |

# How to test F1SIM

Written for Preet. Everything below is a thing you can do by hand, in order, with what
to look for and what a *known* fault looks like so you don't spend time reporting
something already on the list.

**Run the game:** `npm run dev` → http://localhost:5173/
**Run everything automated:** `npm run validate && npm run regress` (see §6).

---

## 0. Before you start — one setting that matters

**Settings → Video → Quality.** `auto` is now safe to leave alone: since #73 it needs
**six seconds of unbroken trouble** before it drops a tier, retries a tier once before
giving up on it, and tells you on screen when it moves in either direction. It used to
drop on three quarters of a second of evidence and never climb back, which is why the
game looked grainy on a busy machine and stayed that way.

**Force `high` if you want to judge the picture on its merits** regardless of what else
your machine is doing. A manually chosen tier is never touched by `auto` — that is
asserted, not assumed.

For scale: `low` measures **16× more speckle at the horizon** than `high` on identical
code. If the picture ever looks worse than you remember, check this setting first.

---

## 1. The car and the drive

| what | how | what should happen |
|---|---|---|
| **Gears** | Start any session, hold throttle down a straight | Reaches **8th**. The disc under the gear number reads `AUTO`. |
| **Manual gears** | Press `G` | Readout flips to `MANUAL`. Number keys `1`–`8` select a gear, `G` returns to auto. **Pressing a number should no longer trap you** — that was #45. |
| **Steering** | Take a fast corner on the keyboard | The car should hold a line. If it saws left–right at roughly 8 Hz, that is the fault #46 fixed — say so, because it means the fix did not reach you. |
| **Steering feel** | `STEER_FEEL=calm npm run dev` | Alternative feel: calmer mid-corner, slower to change direction. `classic` is the old behaviour, byte-identical, for A/B. |
| **Brakes, DRS, ERS** | On a straight | DRS opens only in a zone and only within a second of the car ahead. |
| **The wing opens differently per team** | Chase or rear camera behind two different teams' cars in a DRS zone | Four solutions on the grid: Red Bull/McLaren/Audi lay the flap almost flat (biggest opening, slowest), Ferrari/Williams/Cadillac tip it forward, Mercedes/Alpine/Haas the compromise, Aston Martin/Racing Bulls barely open it but do it quickest. **Until #19 every car on the grid ran the same one** — the lookup was keyed on team names this game stopped using. |
| **Sparks** | Fast, undulating circuits — Suzuka's esses, Zandvoort, COTA | Bursts as the floor strikes the road, over crests and kerbs and under the brakes. **They should never be a continuous flame.** The longest single shower on the calendar is now 3.4s at Suzuka, down from 10.4s. |
| **Skid marks** | Lock a front under braking; then drive a normal lap | A lock-up leaves a black line. **An ordinary corner should leave nothing at all** — cars slide in every corner and none of that marks the road. |
| **Rear lights** | Fit intermediates or wets, then brake hard | Three red lamps (one central, one in each rear-wing endplate pod). **Steady when merely on; they flash at 4Hz while you are braking**, because the MGU-K is recovering. On slicks in the dry they stay off however hard you brake — an F1 car has no brake light. |

**Known and not yet fixed:** at **280 km/h on a straight** the car still wanders 2.6–3.3m
on a keyboard where a wheel holds 0.02–0.11m. Undiagnosed, tracked on #46.

---

## 2. A race weekend

Start a **Quick Race** or a career weekend at any of the eleven circuits.

1. **Practice / Q1 / Q2 / Q3** run in order. Q1 should have 20 cars, **Q2 15, Q3 10.**
   *Known fault, #74: Q2 is currently running 20 and can show you P20.*
2. **You start from the pit lane**, under pit-lane rules, never from a standing start on
   an empty track.
3. **Timing tower** should list the whole field, contiguously — no gap between P1 and P7.
   On a 1280×800 laptop in the driver's eye it used to draw **4 rows of 20**; it now draws
   9 there, 20 in chase, and 22/24 on a bigger grid.
4. **The board is meant to look like the reference you sent (#76).** Check it against
   `reference/target/68.png` yourself — that image is the specification. What you should
   see, top to bottom: `F1SIM RACE` on a lighter band, then `LAP 3/57` **centred** under
   it with the current lap bold; then a row per car, edge to edge, carrying a team-colour
   bar, the position, the team mark, the three-letter code, the gap and the compound
   letter coloured by compound (S red, M yellow, H white). P1 reads *`Leader`* in italic;
   everybody else `+1.230` to three decimals with the decimal points lining up down the
   column. Your own row is outlined. The fastest lap is a **purple circle** at the right
   of the row that holds it. In qualifying the lap counter becomes a clock, the header
   reads `Q1`/`Q2`/`Q3`, a car with no time reads `NO TIME` and a car in the garage gets a
   `P`.
   **Three things are knowingly NOT the reference and will look wrong if you compare
   closely.** (a) The rows are **less than two thirds as tall, relative to the panel, as
   the reference's** — 0.104 of the panel's width against 0.171. Twenty rows at the
   reference's spacing needs 725 pixels of board and a 900-pixel screen with a radio rail
   under it has about 580, so this is a straight trade against showing all twenty cars.
   Say which you want. (b) The **type is Titillium Web, not Formula One's own face**,
   which is proprietary and cannot be shipped. (c) The mark reads **`F1SIM`, not the F1
   logo**, which is a trademark.
5. **Crash deliberately.** The session should NOT take over the screen — you get a radio
   message, `CONTINUE` in the corner, and the session keeps running behind it.
6. **Press `Skip to the result`.** The other cars must still have real times. Retiring
   should never blank the classification (fixed, #52).
7. **Crash out of a RACE and press `Continue`.** You should get a progress screen headed
   *Running out Grand Prix* while the other nineteen finish, and only then the
   classification — **not the classification immediately** (fixed, #56). Before this, a
   race you retired from on lap 4 of 57 was scored from lap 4, and in a career that went
   straight into the championship. **This costs real time: about five minutes for a
   full-distance Grand Prix**, because it is the whole remaining race being simulated. Two
   ways out, both on screen: `Watch it instead` on the progress screen puts you back on the
   circuit, and `Watch the race` beside `Continue` never leaves it.
8. **Watch the finish.** Once the winner crosses the line, the rest of the field should take
   the flag one car at a time and the race should end — **nobody should start another lap**
   (fixed, #44). The lap counter on the board stops at the race distance; a car that has
   finished cannot then retire.
9. **Stop on the racing line and wait.** Race control should raise double yellows naming
   your car, and marshals should recover it (fixed, #28). The field should go past you —
   before the fix, **one stopped car froze the entire race**.

---

## 3. Career

**Career → create a driver → F3 → race a season.**

- The **podium** now fires after a simulated round — flag → rostrum → press room →
  paddock. You had never seen this; it was built and unrouted (#13).
- **Paddock → Into the garage** shows the garage scene with your car in it (#38).
- **My Team**: budget, cost cap, factory departments, engine contracts, a team-mate, the
  livery editor, the newsroom. Founding a team and coming back to it via `Continue`
  should work — that path used to save your career **filed under nobody** (#23).
- **Team principals** are 42 different people across F1/F2/F3. Every one used to be the
  literal string `"Pit wall"` on the real grid (#18).

**Known and not built:** sponsors as a system, publicist/marketer/PA/manager/agencies, a
transfer market, driver ratings. Tracked on #23 and #77.

---

## 4. Radio, HUD, cameras

- **Radio card** — square, top-left, typed out. One **male** voice; **your own lines are
  typed but not spoken** (you don't hear your own voice in your ears). The card is
  readable at desktop and portrait — it used to be off-screen at both.
- **Cameras** — `C` cycles. `driver` is the view from behind the visor; `cockpit` and
  `onboard-t` are the roll-hoop pods. **Mirrors work**, including the sky in them, which
  was clipped out entirely until recently.
- **Track judder** — most visible at **Spa, COTA, Zandvoort**. Bahrain and Monza are flat
  and always looked fine, so they prove nothing either way.

**Known faults:** the radio writing pool is 41 exchanges — bigger than it was, not enough
for a race distance (#61). The FIA banner does not yet match the reference (#15).

---

## 5. What is knowingly not done

Do not spend time reporting these; they are on the list with measurements.

| | issue |
|---|---|
| Leaderboard: the row is **0.104 of the panel's width tall against the reference's 0.171**, because 20 rows at the reference's spacing needs 725px of board and a 900px screen with a radio rail has ~580. A straight trade against showing all 20 cars — **your call** | **#76** |
| Leaderboard: the type is **Titillium Web**, not Formula One's own face (proprietary), and the mark reads **`F1SIM`**, not the F1 logo (trademark) | **#76** |
| Leaderboard: a **race** board shows gaps and no lap-time column, because that is what the reference shows. Whether a race should also show lap times is **your call** | **#35** |
| Q2 runs 20 cars | **#74** |
| Cars phase through each other in the pit lane | **#75** |
| **An idle player in the first garage stops the whole field leaving the pit lane** — 0 of 20 out after 15 min at Monza | **#83** |
| ~~Every car sits level on a road that is not level~~ — **fixed**. Was up to 409mm of tyre under the asphalt at Monaco, 396mm at Zandvoort, 341mm at Spa; now 80 / 34 / 27mm, and 10 of 11 circuits are within 5.3mm of what the road MESH itself allows | **#71** |
| **The drawn road is up to 113mm away from the surface cars are placed on, between node rows.** A corner's road quad fans and is not planar, so its diagonal split lifts or drops the drawn triangles in between. Worst at Suzuka, Monaco, Zandvoort and COTA. This is what is left of #71 and it is a road-mesh job, not a car one | filed under **#71** |
| No over-wheel winglet (deleted, not repaired — it could not attach at any radius) | **#67** |
| AI pace off the solved reference lap. **Re-measured 2026-08-03: the sweep's mean is 1.313, not 1.43** — and 7.5 points of it is a reference lap no driver in this car can reach, so the part that is really the AI is 1.166. See §6 | **#1** |
| **The racing line can still read GREEN while the car is past its grip**, on four circuits (Bahrain, Monaco, COTA, Interlagos). The largest cause is fixed — the display was promising 28.7% more grip than the car has — and a residual is left in the colouring rule | **#30** |
| The halo is near-black and loses its outline against a dark background — it is *attached* (146/146 bolted, measured), but it is not painted the way the reference cars are | **#34** |
| Sparks at Suzuka/Zandvoort still run 3.4s at a stretch (was 10.4s) | **#11** |
| Career screens (ratings, market, accolades) not built | **#77** |
| Podium/press bodies below the neck are unfinished | **#22** |

---

## 6. The automated suite

The probes are the CI. There is no hosted runner.

```bash
npm run typecheck     # both projects, incl. scripts/
npm run validate      # tracks, physics, race, qualifying, integrity, world, flags
npm run regress       # lap counting, classification, session exit, career flow
npm run probe:smoke   # 35 front-end screens, 32 required routes
```

**Run these on a quiet machine.** Nearly every probe in this project drives headless
Chrome, and under load they do not fail — they *time out*, which reads like a failure and
is not one. Load average above ~8 makes the numbers worthless. This has cost real time
repeatedly and it is why issue #25 existed at all.

**The exception, and it is worth knowing which probes it covers.** `probe:racesweep`,
`probe:envelope`, `validate:race` and the `diag:` scripts are node-only: no browser, no
wall-clock deadline anywhere in them, and every seed is stated. Under load they get *slower*
and they do not get *different*, so a number from one of those is trustworthy on a busy
machine. Everything driving Chrome is not.

Useful individual probes:

| command | proves |
|---|---|
| `probe:blockage` | a stopped car does not freeze the race |
| `probe:gearbox` | a number key does not trap the gearbox |
| `probe:handling` | the keyboard can hold a lane |
| `probe:graphics` | the quality setting reaches the GL context |
| `probe:carrig` | every car part attached, nothing interpenetrating (146 parts) |
| `probe:effects` | sparks, skid marks and the rear lamps fire when they should **and not when they should not**; the four wing actuations reach the grid |
| `probe:crashrest` | a wreck stops moving, and every car — running or wrecked — lies ON the road rather than through it, on all 11 circuits |
| `probe:people` | 42 principals, all different, all reachable |
| `probe:envelope` | the car does what the lap-time solver and the racing line say it will |
| `probe:racesweep` | 55 races. **Slow — 20+ minutes, and an hour on a busy machine** |
| `probe:qualiretire` | a crash in qualifying does not take the screen |
| `audit:circuits` | photographs 11 circuits × 7 camera modes |

**Known-failing, expected:** `probe:racingline` 4 — green still asks for 103–107% of the
car's grip at Bahrain s=543m, Monaco s=346m, COTA s=3441m, Interlagos s=2696m. It was
**28.7%** before the #1 work; what remains is in the *colouring* rule (when green turns
amber), not in the capability calculation. Nobody is on it ·
`probe:framing` **113** — recorded as 56, measured **51** on merged `main`, then the probe was
corrected to place its car where the renderer places it rather than 20mm low, which is +49 on
`main` alone and belongs to the HUD's `MIRROR_PANES` rectangles (PROJECT.md §6/§7) ·
~~`probe:fieldsize` 14 (#44)~~ — **fixed, and it was 16 rather than 14 when it was measured
rather than quoted** · `probe:weather` 2 (#42) · `shoot:panels` **9 rail + 2 mirror** — the "2 rail" that stood here was the de-duplicated
list read as the count; confirmed 9 on a `src/` checked out at `3f229b7`, so not a regression ·
`probe:grade` 4 of 16 (see below) · `probe:handling` 1 · `probe:drivability` 4 ·
`probe:racingline` 4 (#30 — was 3, and it is the probe that got stricter: it had been flying
a car that could brake 28% harder than a real one) · `probe:racesweep` 11 of 55 and
`validate:race` 1, both `monaco: fastest lap 150% of reference` (#1) plus four spread rows
that belong to #27 · `probe:racelog` **at `RACELOG_LAPS=full` only** 2 (#26) — **11.50
retirements and 22.50 contacts a race**, re-measured 2026-08-03; the default quarter-distance
run passes. The third cause is now measured (see PROJECT.md §7): not contact, not tyres, not
fuel — cars leaving the road on their own, later and later into the race, most of them already
carrying damage. `npm run diag:attrition` is the instrument ·
**`probe:crashrest` 1** — Monaco s=336, a 9.2m centreline radius on a 10m-wide road, where the
road mesh's own quad is degenerate and a rigid 3.6m car cannot lie on it. 43.6mm over a bound
the mesh's own error sets; the other ten circuits are inside 5.3mm.

**`probe:racesweep`, re-baselined on `main` 2026-08-03** — the numbers in issue #30 are
stale and several of them are fixed:

| | issue #30 as filed | now |
|---|---|---|
| races failing | 13 / 55 | **11 / 55** |
| mean lap/reference | 1.3662 | **1.3131** |
| Monaco fastest | 151–175% | **148–150%** |
| Monaco off-track | 107–123 | **under the 90 bar on every seed** |
| Silverstone | failed 2 seeds | **passes all five** |

Nothing in this branch made those move — #10 (fuel), #4 (centreline easing) and the
`aeroBalanceFront` change did, and nobody had re-run the sweep afterwards.

**`probe:grade` needs shots first**, and it takes a tag:

```bash
SHARP_TAG=after npm run probe:sharpness    # shoot into sharp-out/after
npm run probe:grade                        # judge those against reference/target/
```

It compares median luma, RMS contrast, saturation and white balance against **your own
reference frames**. Currently **12 ok / 4 failed**, and the four are honest residuals, not
regressions:

| | ours | reference | note |
|---|---|---|---|
| Zandvoort exposure | 123 | 81 | a grade cannot manufacture dynamic range — the reference holds median 81 *with* an RMS of 57.1, and every exposure this renderer can take trades one for the other |
| Monza exposure | 139 | 89 | Monza is **50 code values brighter than Zandvoort under identical settings** while the two references differ by 8. **Undiagnosed** — reported rather than averaged away |
| Monza saturation | 0.258 | 0.146 | same cause |
| Monza balance | −28.9 | 1.1 | same cause |

Note `reference/` is gitignored, so a fresh clone has no specification to measure against
and this probe can only say so — it cannot pass.

---

## 7. Reporting

Screenshots and recordings are by far the most valuable thing you send — PROJECT.md §2
records that nearly every serious bug in this project was found that way, and today alone
your screenshots produced #45, #46, #47, #48, #54, #58, #73, #74, #75 and #76.

For recordings: **save to `/Users/preet/Desktop/f1/`** rather than the Desktop. macOS
blocks shell access to `~/Desktop`, so a recording left there cannot be read — that has
already cost one video.

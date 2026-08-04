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
| **The halo** | Any onboard camera — `driver` or `cockpit`. Worth doing at night and in shadow, which is where it used to disappear | The **top of the hoop is painted in your team's colour**, the whole way round the arc, with the underside and the centre pillar black. That is what `reference/target/76.png` and `90.png` show and it is what makes the halo read as part of the car rather than as a black bar floating over the cockpit — which is what you were seeing when you asked *"the halo is also floating atp?"*. It was never actually detached: all 146 parts are measured as bolted, with no tolerance in the test. **A dark-liveried team gets a dark halo** — that is deliberate, and if it looks wrong on a particular car, say so; see §5. |

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
8. **Race in the rain. It rains by itself now (#97) — but not often, on purpose.**
   Until 2026-08-04 it had **never** rained in this game, on any seed, at any circuit: a rate
   limiter snapped the rainfall back to zero faster than it could build at the rate the game
   steps at. That is fixed, and the schedule behind it is calibrated to a real season:
   **about one session in seven sees meaningful rain** (measured 14.55% over 2,200
   circuit-and-seed sessions), weighted by circuit — **Interlagos and Suzuka 24%, Spa 21.5%,
   Zandvoort 20%, Monaco 9.5%, Bahrain 0.5%, Jeddah 1.0%.** So a wet race is something you
   should occasionally *be surprised by* rather than something you can order, and if you want
   one on demand you still want the URL below.
   **To see the wet model on purpose: `http://localhost:5173/?wet=0.9`.**
   With `?wet=` set, watch where the cars put themselves through a corner. The field should
   stop using the dark, rubbered-in groove and run **wider — a later apex, roughly two and a
   half metres off the dry line at a tight corner** — because rubber under water is slick and
   the clean asphalt beside it is not. As the track dries the line comes back, because the
   groove dries first. **This is new in #42 and until it landed it did not happen at all**:
   the alternative line the cars steer to was being computed on the wrong side of the corner
   and never actually left the groove, so the grip beside the line measured exactly the same
   as the grip on it. If the field still runs the dry line in a downpour, say so — that means
   the fix did not reach you.

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
- **The people have bodies now (#22).** On the podium: both arms up, a trophy held in a
  hand, champagne in the other, legs, race boots. At the press desk: hands on the desk,
  race suits with a collar, a yoke, a belt and sponsor blocks. In the garage: the
  principal standing whole in the foreground and three crew behind the bench. Until this
  landed the podium arm was a single stick with the trophy stuck to the end and the
  garage crew were torsos with no arms at all. **On a phone held sideways** the press
  room now sits beside the question instead of pushing the answers off the bottom.

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
- **The cockpit should not move when the road does.** Drive up Beau Rivage at Monaco, or over
  Eau Rouge, in `driver` or `cockpit`. The **horizon** must rise and fall with the gradient —
  that is the road — but the **steering wheel, the halo and the mirrors must not move at
  all**, because they are bolted to the car you are sitting in. Until now they slid up and
  down the frame by a fifth of its height on any real gradient: the camera was taking the
  car's pitch and roll with the wrong sign, so on an 11° climb it was 22° out of line with the
  car it is mounted on. If you ever see the wheel rim drift up the screen on a hill again,
  that is the same fault back.
- **Track judder** — most visible at **Spa, COTA, Zandvoort**. Bahrain and Monza are flat
  and always looked fine, so they prove nothing either way. **Re-measured on merged `main`
  and closed (#9).** All three things that used to step are now drawn smoothly: a car in
  plan (drawn-step spread 200.0% → 0.0% at every steady rate), the world's height (125.1mm
  → 12.0mm of per-frame second difference against a 20mm bound), and the safety car
  (55.7mm → 3.8mm). If you still see the track lurching at Spa or COTA, that is a new
  fault and worth a recording.

**Known faults:** the radio writing pool is 41 exchanges — bigger than it was, not enough
for a race distance (#61). **The FIA banner does not yet match the reference (#15), and
here is exactly how**, measured against `reference/target/77.png`: the reference's strip
has a **red** mark block on the left carrying two devices, a **red** headline naming the
flag state, white instruction lines under it one per line, and a **red block on the right
with the message number in it**. Ours has a navy mark block, no right-hand block, the
whole message in white, and it opens every bulletin with the words `RACE CONTROL:`, which
the reference never does. A critical bulletin is also drawn identically to an
informational one — `.hud-control.tone-urgent` has no styling at all. **Not fixed**:
`src/ui/Hud.ts` is held by another piece of work.

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
| ~~**IT NEVER RAINS.**~~ — **fixed**. It had never rained on any seed at any circuit (0 of 440 sessions reaching even "Damp"); the floor in the weather model caught rain on the way *up* as well as on the way down. Fixing it alone would have put **98.5% of sessions in the rain**, so the schedule was calibrated with it: **14.55% now, one session in 6.9**, weighted by circuit. Two loose ends, both in the front end and neither fixed: the **`Simulate Race`** button still rolls the raw `rainChance` (25.7% calendar mean, 11 points wetter than a driven session), and the **`Rain risk` percentage** the briefing prints is that same raw weight, so it reads about 3× high | **#97** |
| The rain also works on demand: **`?wet=0.9`** on the dev-server URL forces standing water before the lights go out, and everything downstream — spray, the wet line, the crossover, the pit wall's call — is live from there | |
| **A full-distance race is interrupted seven times.** Measured at 52 laps, Silverstone, F3, P18, medium: **7 safety-car or VSC periods and 35% of the race neutralised.** Real F1 averages well under one a race. It is downstream of the cars retiring, so it closes when that does | **#26** |
| ~~The drawn road is up to 113mm away from the surface cars are placed on, between node rows~~ — **fixed**. Was 85.7mm at Spa, 82.7 at COTA, 78.7 at Monaco, 56.8 at Zandvoort; now 1.5 / 1.4 / 1.6 / 0.7mm on all eleven circuits, and `probe:banking` can see between the node rows at all, which it could not before | filed under **#71** |
| ~~Suzuka's crossover draws two roads 0.159m apart and neither leg is a bridge~~ — **fixed**. The two legs are 7.92m apart now, which is what the real overpass has. It did not move the lap-time solver at all | **#37** |
| ~~**A white line carries almost no surface relief**~~ — **decided, and it is correct.** Ours is 0.66° of facet slope against the asphalt's 1.86°, a ratio of 0.357. Measured off your own `reference/target/90.png`, the painted kerb blocks in that frame carry **0.32–0.50** of the asphalt beside them — so a white line really is a smooth film there too, and the paint stays as it is. It is now guarded by a **ceiling** rather than left exempt: wind the paint's bump up toward the road's and `probe:kerbs` goes red. **If it still looks wrong to you in motion, say so** — this was measured on a still frame, and the half that is not built is `probe:grain` masked to the kerb instead of the road | **#86** |
| No over-wheel winglet (deleted, not repaired — it could not attach at any radius) | **#67** |
| AI pace off the solved reference lap. **Re-measured 2026-08-03: the sweep's mean is 1.313, not 1.43** — and 7.5 points of it is a reference lap no driver in this car can reach, so the part that is really the AI is 1.166. See §6 | **#1** |
| **The racing line can still read GREEN while the car is past its grip**, on four circuits (Bahrain, Monaco, COTA, Interlagos). The largest cause is fixed — the display was promising 28.7% more grip than the car has — and a residual is left in the colouring rule | **#30** |
| ~~The halo is near-black and loses its outline against a dark background~~ — **fixed**. The crown of the hoop is now painted in the team's own colour, as `76.png` and `90.png` both show; the pillar and the underside stay black, as `76.png` also shows. Measured on 11 circuits × day/night × two onboard cameras and behind ten teams' cars | **#34** |
| **A dark-liveried car gets a dark halo, and on the darkest liveries the paint buys very little outline.** A purple, a navy and a dark red on the grid draw only 4.7–12.7 display levels brighter than the old black. That is what a dark car's halo really looks like — the Aston in `90.png` is a dark green halo on a dark green car — so it is reported rather than "fixed". **If it looks wrong to you on a particular team, say which, and the rule can push dark bodies onto their accent colour instead** (which is what the black Mercedes in `76.png` does with its teal) | **#34** |
| Sparks at Suzuka/Zandvoort still run 3.4s at a stretch (was 10.4s) | **#11** |
| Career screens (ratings, market, accolades) not built | **#77** |
| Podium/press bodies: **the head does not turn with the body**, so a panel of three all face the camera from the neck down; there is no applause pose — the one written for it draws folded arms and is named `folded` for that reason; nothing is animated. The three defects that were on this line — a stick arm, armless crew, hands hidden by the desk — are **fixed** | **#22** |
| The **3D pit crew** in the pit lane is a different rendering path and #22 did not touch it | **#24** |

---

## 6. The automated suite

The probes are the CI. There is no hosted runner.

```bash
npm run typecheck     # both projects, incl. scripts/
npm run validate      # tracks, physics, race, qualifying, integrity, world, flags
npm run regress       # lap counting, classification, session exit, career flow
npm run probe:smoke   # 35 front-end screens, 32 required routes
```

**`npm run build` had been failing on `main`, and so had every probe that builds the site
before driving it** — `probe:grain`, `probe:sharpness`, `probe:graphics`, `probe:autotier`
and the rest. A comment in `src/ui/styles.css` contained a directory name ending in an
asterisk and a slash, which closes a CSS comment; six lines of prose then parsed as CSS
and the minifier rejected the file. `vite dev` does not minify and the browser skipped the
garbage silently, so the game looked fine and only shipping it was broken. Fixed on this
branch. **If `npm run build` ever fails again, read the first error rather than the last —
the stack is thirty lines of bundler internals and the one useful line is at the top.**
**`npm run build` is BROKEN right now, and so is `probe:grain`.** One comment in
`src/ui/styles.css` line 162 contains the text `titillium*/`, and `*/` ends a CSS comment —
so everything after it is read as CSS and the minifier stops with `Invalid empty selector`.
It has been that way since the timing-board work landed on `main`; `npm run dev` is
unaffected (the dev server does not minify), so you can still play the game. `probe:grain`
does a real production build before it opens a browser, so **its "132 / 0" cannot be checked
until that comment is fixed.** One character. Nobody is on it.

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
| `probe:halo` | the halo is painted in the car's own colour rather than the shared near-black — the same frame drawn twice, one texel of the livery apart, on 11 circuits × day/night × two onboard cameras and behind ten teams' cars |
| `probe:effects` | sparks, skid marks and the rear lamps fire when they should **and not when they should not**; the four wing actuations reach the grid |
| `probe:crashrest` | a wreck stops moving, and every car — running or wrecked — lies ON the road rather than through it, on all 11 circuits |
| `probe:people` | 42 principals, all different, all reachable — **and every limb of every body, measured off the drawing**: 3,615 checks (576 of them the pre-#22 ones). `PEOPLE_LEGACY=1 npm run probe:people` runs it against the body as it shipped before #22 and fails 276 of 1,471 |
| `probe:banking` | cars stand on the asphalt that is DRAWN — and, since the road-surface work, **between** the mesh's node rows as well as on them, which is where an 85mm error had been hiding behind a probe reporting 0.000m |
| `probe:kerbs` | how much of a lap is kerbed — and that every surface which claims to have relief still HAS it: the band limit that fixed the road's speckle is shared by the kerbs, the grass and the run-off, and nothing measured them until now |
| `probe:people` | 42 principals, all different, all reachable |
| `probe:envelope` | the car does what the lap-time solver and the racing line say it will |
| `probe:racesweep` | 55 races. **Slow — 20+ minutes, and an hour on a busy machine** |
| `probe:qualiretire` | a crash in qualifying does not take the screen |
| `audit:circuits` | photographs 11 circuits × 7 camera modes |

**Known-failing, expected** — every number here re-measured on merged `main` on 2026-08-04:
`probe:framing` **5** (3 panes at 22.2–22.4% against a 22.0 bound already violated on `main` at
22.6; 2 Monaco horizon rows at 51% against 34–50, where 51 is the *correct* number for a car
climbing Beau Rivage — band questions, neither loosened) ·
`probe:crashrest` **1** (Monaco s=336, a 9.2m centreline radius on a 10m road) ·
`probe:racingline` **4** (#46 — green still asks 103–107% of the car's grip; it was **28.7%**
before #1's work, and what remains is the *colouring* rule) ·
`probe:racesweep` **11 of 55** and `validate:race` **1**, both `monaco: fastest lap 150% of
reference` (#1) · `probe:racelog` **at `RACELOG_LAPS=full` only** (#26 — the quarter-distance
run passes) · `probe:stewards` **1** at 9.7 penalties against a bar of 8 (identical on clean
`main`, never previously recorded) · `probe:grade` **4 of 16**.

**Green as of 2026-08-04, and worth knowing because several were red for a long time:**
`shoot:panels` **0 rail + 0 mirror** · `probe:banking` PASS *including between the mesh rows* ·
`probe:grain` **132/0** · `probe:people` **3,615** · `probe:fieldsize` **0** · `probe:weather`
**0** · `probe:smoke` **32/32 routes** · `validate:flags` PASS · `npm run build` PASS.

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

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

**Known and not yet fixed:** at **280 km/h on a straight** the car still wanders 2.6–3.3m
on a keyboard where a wheel holds 0.02–0.11m. Undiagnosed, tracked on #46.

---

## 2. A race weekend

Start a **Quick Race** or a career weekend at any of the eleven circuits.

1. **Practice / Q1 / Q2 / Q3** run in order. Q1 should have 20 cars, **Q2 15, Q3 10.**
   *Known fault, #74: Q2 is currently running 20 and can show you P20.*
2. **You start from the pit lane**, under pit-lane rules, never from a standing start on
   an empty track.
3. **Timing tower** should list the whole field.
   *Known fault, #76/#17: it currently shows P1 then jumps to P7–P20.*
4. **Crash deliberately.** The session should NOT take over the screen — you get a radio
   message, `CONTINUE` in the corner, and the session keeps running behind it.
5. **Press `Skip to the result`.** The other cars must still have real times. Retiring
   should never blank the classification (fixed, #52).
6. **Stop on the racing line and wait.** Race control should raise double yellows naming
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
| Leaderboard is not the broadcast board yet | **#76** |
| Q2 runs 20 cars | **#74** |
| Cars phase through each other in the pit lane | **#75** |
| Near-field asphalt reads as static | **#48** |
| Every car sits level on a road that is not level — up to 434mm of tyre under the asphalt at Monaco | **#71** |
| No over-wheel winglet (deleted, not repaired — it could not attach at any radius) | **#67** |
| Safety car has no vehicle; cars stop dead under a VSC on clear track | **#10** |
| AI pace ~1.43× reference | **#1** |
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

Useful individual probes:

| command | proves |
|---|---|
| `probe:blockage` | a stopped car does not freeze the race |
| `probe:gearbox` | a number key does not trap the gearbox |
| `probe:handling` | the keyboard can hold a lane |
| `probe:graphics` | the quality setting reaches the GL context |
| `probe:carrig` | every car part attached, nothing interpenetrating |
| `probe:people` | 42 principals, all different, all reachable |
| `probe:qualiretire` | a crash in qualifying does not take the screen |
| `audit:circuits` | photographs 11 circuits × 7 camera modes |

**Known-failing, expected:** `validate:flags` (safety-car form-up, #6) ·
`probe:framing` 56 (54 belong to the HUD, 1 real Suzuka defect, 1 band question) ·
`probe:fieldsize` 23 (#44) · `probe:weather` 2 (#42) · `shoot:panels` 2 rail + 2 mirror.

---

## 7. Reporting

Screenshots and recordings are by far the most valuable thing you send — PROJECT.md §2
records that nearly every serious bug in this project was found that way, and today alone
your screenshots produced #45, #46, #47, #48, #54, #58, #73, #74, #75 and #76.

For recordings: **save to `/Users/preet/Desktop/f1/`** rather than the Desktop. macOS
blocks shell access to `~/Desktop`, so a recording left there cannot be read — that has
already cost one video.

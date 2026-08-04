# F1SIM — Project Bible

**Purpose of this file.** This is the context-recovery document. If the conversation is
cleared, or a new session starts with no history, **read this first and read it fully.**
It records what we are building, every decision taken and why, what has been done, what
is still wrong, and what the user has asked for in their own words.

Written by the assistant, for the assistant, at the user's request. Keep it current: when
something lands, move it from "outstanding" to "done" with the measurement that proves it.

**Companion documents.** This file is for whoever is *building*. Two others exist:
- **`TESTING.md`** — for the user. How to test everything by hand, in order, with what a
  *known* fault looks like so they do not spend time reporting something already on the
  list. Keep the "knowingly not done" table in it current or it is worse than useless.
- **`reference/target/`** (gitignored) — the user's 24 reference images with an `INDEX.md`
  mapping each to the thing it specifies. **These are the visual specification**, not a
  mood board. §2 records the standing instruction; their words on supplying the set were
  *"every image that I attached, i want that to that quality… I want you to do it that
  way"* and *"copy this!!! don't change shit from it."*

**Standing instruction on delivery, given 2026-08-03:**
> *"finish everything up first though and I will test it out once you've shipped the final
> product and i don't want to test it out if you haven't shipped it completely"*

So: do not hand the user things to try piecemeal. Work the backlog down, keep `TESTING.md`
accurate, and hand over once.

---

## 1. What this is

A browser-based Formula 1 simulator and career game. TypeScript, Three.js, Vite. Runs on
desktop browsers and iOS Safari. No server — everything is client-side, persisted to
browser storage.

**Repo:** `/Users/preet/Desktop/f1` — GitHub `Preet37/F1Sim`, branch `main`.
**Dev server:** `npm run dev` → http://localhost:5173/

### The goal, in the user's words

> *"I want a finished product."*
> *"imagine this is a game."*
> *"I want everything to be super realistic, if you need to render sure, if you need to
> spend more time sure, if you need to find assets online sure, everything that you need
> to do to make this entire game and everything as realistic as possible."*

The benchmark they have named repeatedly: **Monoposto** (mobile F1 sim) for gameplay and
UI craft, **F1 24/25** for simulation depth, **Real Racing 3** for front-end polish.

It must be **publishable**. That is their stated end goal and it constrains asset choices
(see §3).

---

## 2. The user

- Name: Preet Karia. Uses "Preet Karia" as their career driver name in-game.
- Tests by playing and sending screenshots and screen recordings. **This has been by far
  the most valuable input in the project** — nearly every serious bug was found this way.
- Direct, impatient with repetition, and correct far more often than not. When they say
  something looks wrong, it has essentially always turned out to be a real defect.
- Standing instruction: **"if I'm giving you images that I want you to take a look at, it
  means that I want you to replicate that as closely as you can."** Reference images are
  specifications, not inspiration.


---

## 3. Standing constraints and decisions

These have all been decided. Do not re-litigate them without the user.

### Intellectual property — READ CAREFULLY, this has changed

- **Real team and driver names: APPROVED as data.** The user reversed their earlier
  no-real-IP rule: *"nah actually i want you to use the actual teams if you can. I also
  want you to show the drivers too."* Real 2026 F1, F2 and F3 rosters are in
  `src/data/roster/`, deliberately confined to that directory so a swap is one import.
- **Reproduced badges, wordmarks, sponsor artwork, real helmet designs and driver
  likenesses: still  permitted.** Naming a team is different from reproducing its
  trademark, and an approximated Ferrari shield is both infringing and visibly fake. Use
  real team **colours** (how broadcast timing screens identify cars) plus the generated
  geometric team marks already in the codebase but for the sake of this project everything
  is allowed nad everything that could be a licensing issue will be adress once we are done 
  with all kinds of testings.
- The user's own framing: *"yeah thats right publishable so it has to be presentable but
  that doesn't mean that we can't test with real drivers and teams right now."* So: real
  roster while building, swappable before release. The single-module boundary is what
  makes that possible — **keep it.**
- **Assets from online: now permitted** (*"if you need to find assets online sure"*), but
  only permissively licensed ones — CC0, public domain, or explicitly licensed for this
  use. Record the licence and source of anything added.

  **How this is MEANT to be implemented — and is NOT. See issue #36.** The agreed design is
  that every branded slot — team badge, sponsor decal, driver portrait — is an *asset slot*
  backed by a generated placeholder, loaded from `public/brand/<team-id>/` if a file is
  present and falling back to the generated mark if not. The user could then drop real
  artwork in themselves and it would appear immediately with no code change, and removing
  the directory would return the game to a shippable state.

  **None of that exists.** Verified 2026-08-03: `grep -rn "public/brand" src scripts audit`
  returns nothing and `public/` contains only `textures/`. There is no loader and no
  fallback path. This paragraph asserted the mechanism as fact for long enough that a code
  review had to discover otherwise, so it is corrected here rather than quietly fixed.
  What is genuinely true today is the *generated* geometric marks (`MARK_DEVICES` in
  `src/render/LiveryDesign.ts`, carrying an explicit non-infringement comment) and the
  fictional `SPONSORS` set in `src/render/Livery.ts`. Those are real; the swap boundary is
  not. Until #36 lands, the only working IP boundary in this project is
  `src/data/roster/` — which does hold, and which is why §3 keeps insisting on it.
- The user asked for archive clips of past champions in the intro. The agreed substitute is in-engine cinematography, which is
  what the real F1 games mostly use anyway. They confirmed: *"yeah render the game scenes
  like rendered in engine yourself."*

### Engineering standards that have earned their place

These came out of repeated painful experience. They are not ceremony.

1. **Measure, do not eyeball.** Every visual claim in this project that was made from a
   screenshot has eventually turned out to be wrong. Build a probe.
2. **A probe that a broken feature passes is worse than no probe.** Verified twice by
   deliberately breaking a feature and confirming the test goes red. Do this.
3. **Never loosen a tolerance to make a test pass.** If a number moves, find out why. Two
   agents were sent back for this; both times the investigation found something real.
4. **Verify on merged `main`, not on the branch.** Branches are cut from different bases
   and interact. Several real bugs appeared only after merge.
5. **Check all eleven circuits.** Every rendering fix in this project's history was
   verified on one circuit and shipped broken on the rest. The user's exact words:
   *"YOU NEED TO FIX EVERY MAP."*
6. **Cite regulations by article** in code comments. The codebase does this throughout
   (2026 Sporting Regulations Section B, the Driving Standards Guidelines, FIA Technical
   Regulations Appendix 1).
7. **Report honestly.** Say what did not work, what a number did, and what you did not
   reach. The user trusts an honest gap far more than a confident claim they then
   disprove in thirty seconds.

---

## 4. Architecture

```
src/
  main.ts                 App shell: screens, weekend flow, session launch, menus
  core/SimClock.ts        Fixed 120Hz physics step
  physics/
    VehiclePhysics.ts     Magic-formula tyres, friction circle, load transfer
    VehicleSpec.ts        TeamPerformance — THE channel between career and simulation
    PitLimiter.ts         Shared pit-lane speed limiting
    NeutralisedLimiter.ts SC/VSC speed limiting, sibling of PitLimiter
  race/
    RaceEngine.ts         The simulation. Steps cars, resolves contact, owns sessions
    CarEntry.ts           Per-car state
    Classification.ts     Session results. LTCS vs race rules live here
    RaceControlManager.ts Flags, neutralisation, track limits, race control messages
    Stewards.ts           Incident judgement (Driving Standards Guidelines)
    DrivingStandards.ts   The regulation geometry, no engine imports
    Recovery.ts           Marshal recovery as an operation with prerequisites
    DebrisField.ts        Debris as a simulation concern (raises flags)
    Weather.ts            Water field, forecast, PitWall radio calls
    Strategy.ts           Tyre strategy model — shared by screen and AI
    DamageModel.ts        Per-component damage
    WeekendFormat.ts      FP/Q1/Q2/Q3/race structure
  ai/
    AIVehicleController.ts
    TrafficAwareness.ts   Collision avoidance — cut contacts 90%
  track/TrackSpline.ts    Centreline, curvature, elevation, speed solver, racing line
  render/
    Renderer.ts           Frame loop, resolution scaler, quality tiers
    CarMesh.ts            The car, built from FIA regulation volumes
    TrackMesh.ts          Road, kerbs, shoulders, run-off. Owns Y_ROAD/carGroundY
    Terrain.ts            Height field beyond the circuit
    CameraDirector.ts     All camera modes incl. driver's eye
    CockpitMesh.ts        Halo, wheel, mirrors, driver's eye constants
    PostFX.ts             Bloom, grade, AO, FXAA
    Weather/Rain.ts, ParticleSystem.ts, SkidMarks.ts, SurfaceDetail.ts
  career/
    CareerState.ts, Season.ts, World.ts, Seat.ts, Identity.ts
    SaveManager.ts, SaveCodec.ts   Versioned, forward-compatible saves
  data/
    roster/               REAL F1/F2/F3 rosters — the swappable boundary
    tracks/circuits.ts    Real surveyed geometry
  ui/
    Hud.ts                In-race HUD. Large.
    TimingRow.ts          The shared broadcast row
    StrategyScreen.ts, PitStopPrompt.ts, SetupScreen.ts
    CareerCreate.ts, DriverPortrait.ts, IntroSequence.ts, Podium.ts
    styles.css, career.css
  audio/AudioEngine.ts    Fully procedural. 64 partials, formants, Doppler
scripts/                  ~40 probes and audit harnesses
  lib/keyboardRig.ts      THE PLAYER'S INPUT PATH, as a rig a probe can drive.
                          KeyboardEvent → InputController → SimClock → physics,
                          off a simulated wall clock. Three measurements:
                          `tapOnce` (one press, model-free), `driveLane` (a
                          closed-loop driver with a 250ms reaction, keyboard arm
                          and analogue-wheel control arm, on straights, corners
                          and a sinusoidal CHICANE) and `steerStepResponse`
                          (latency, time to full lock, unwind, flick — the input
                          path alone, no car). Every one takes an `inputConfig`,
                          which is how a steering-feel candidate is measured
                          through the real controller rather than a copy of it.
                          Shared by probe:handling and probe:steeringfeel
docs/CAREER_MODE.md       Career design document
reference/                GITIGNORED. Extracted reference frames (see §9)
```

### The probes — this is the project's immune system

Run `npm run` to list. The important ones:

| Command | What it proves |
|---|---|
| `probe:renderperf` | Real GPU, headful Chrome, actual resolution and frame time. `PERF_PAIR=` toggles a factor inside one session so contention cancels; `PERF_VIEWPORT=390x844x2` measures at the pixel count a phone draws rather than a desktop's |
| `probe:graphics` | The graphics setting reaches the GL context: tiers, the four switches, the Settings screen, and persistence. Reads `getContextAttributes()`, not the settings object |
| `probe:autotier` | **Does the picture come back?** Drives the real `AutoTierPolicy` off synthetic frame costs — a load spike at minimum resolution, then the load removed — and asserts the tier *returns*, in node and again through the real `Renderer` in a browser reading `shadowMap.enabled` and the composer. Also: a transient is absorbed, repeated failure still latches, and a tier chosen in Settings survives five minutes of trouble untouched. **Not load sensitive** — every frame cost is stated, not measured. Issue #73 |
| `probe:framing` | Halo/mirror/wheel positions in frame, 11 circuits × 2 aspects |
| `probe:carrig` | Every car part **bolted** — intersecting, not merely within 10mm; wheels at y=0; no member crossing bodywork in mid-span; the steered corner clear of the chassis at 13 angles across the lock |
| `probe:framerate` | The car behaves the same at every frame rate — and the world is DRAWN smoothly at rates that do not divide 120: the camera's own height, real rig, real engine, a full lap of all eleven circuits |
| `probe:shoulders` | Shoulder geometry, divot count by raycast |
| `probe:traffic` | Contacts per car-lap |
| `probe:blockage` | A car stopped ON the racing line does not stop the race |
| `probe:stewards` | Staged incident scenarios + verdict distribution |
| `probe:strategy` | Strategist honesty; plan reaching the car |
| `probe:pitstop` | The stop you asked for is the stop you get — and the wall cannot overrule the PIT button in either direction |
| `probe:qualiboard` | Knockout qualifying: board and grid agree — and a player who stops at t=90s does not stop anybody else being classified |
| `probe:qualiretire` | The Q1 accident, in a browser: nothing takes the screen over, nothing blurs the circuit, CONTINUE and SEE OUT are in the corner, every regulation string survives, and whichever way the player leaves the other nineteen have real times |
| `probe:identity` | Player's name reaches car, standings, save |
| `probe:gearbox` | The gear a key press puts you in, and that you can get back out of it. Drives `KeyboardEvent → InputController → playerControls → VehiclePhysics` instead of hand-building a controls literal — which is exactly why `probe:drivability` and `probe:handling` could not have caught issue #45 |
| `probe:handling` | Balance, turn-in and lift-off stability — **and, since #46, what one key press does and whether a keyboard driver can hold a lane at all.** No longer a pure reporter: 11 assertions. Seven lanes including a **chicane**, and a §6 that prints what the steering feel COSTS in milliseconds. `STEER_FEEL=classic` re-measures the pre-#46 feel |
| `probe:steeringfeel` | **The feel decision, as a table.** Fifteen keyboard configurations × seven lanes × three frame rates against one fixed analogue-wheel control arm, plus latency, time-to-full-lock, flick and unwind. Reports; `probe:handling` judges |
| `diag:chicane` | How the flick lane was chosen: 36 speed × g × period combinations against two stated requirements — the wheel arm must hold it, and it must catch a deliberately over-slowed rack |
| `probe:drivability` | Turn-in, hands-still yaw stability, pedal margin, catchability, understeer gradient. **Since #46 it asserts the eight bars it had always printed beside its own summary** and exits 1 when it says the car is undrivable |
| `probe:season` | 100 career-years |
| `probe:myteam` | 10 My Team careers × 10 seasons: cap, books, factory reaching `TeamPerformance` |
| `probe:news` | Every headline checked against `simulateRound`'s own result, 100 career-years |
| `audit:livery` | Six pattern families on the real car — and sha256s the control shot against `audit:car` |
| `validate:world` | Nothing built on the racing surface |
| `probe:banking` | Cars stand on the DRAWN asphalt: raycasts the road mesh on 11 circuits, checks the drawn cross-slope against the surveyed banking, and forbids the flat `carGroundY` outside `TrackMesh.ts` |
| `probe:crashrest` | A car that has crashed comes to rest: the drawn pose of a car the engine has frozen does not move (real `SimClock`, real `updateRenderPoses`, 50 and 85fps), no tyre of a wreck is deeper into the drawn asphalt than the same car standing level, and the gear readout for a stopped car is `N` and stays `N`. Issue #58 |
| `probe:curvature` | Surveyed vs authored curvature, and the inner edge of the ribbon still advancing at every node — nothing folded |
| `audit:circuits` | Photographs 11 circuits, 7 camera modes each |
| `shoot:panels` | Measures HUD boxes; fails on overlap, and on the radio card not being on screen at all |
| `probe:radio` | The team radio, in real Chrome: the link band by rendered-sample RMS, the two squelches, the dropout, the ONE MALE VOICE, the interrupt spacing, and that `speech` is emitted on the first `boundary` and never on `onstart` |
| `probe:hudtext` | What the HUD says, including **every** authored radio variant off a fixed seed |
| `probe:people` | 42 principals: all named, all unique, none within a look distance |
| `shoot:people` | Contact sheet of the cast, plus the presser/podium/garage scenes |
| `probe:smoke` | **The front end, in a real browser, as a player walks it.** A **required set** of routes — the main menu, all eight settings tabs, the driver rack, career create, My Team, team create, the paddock, session select, car setup, the briefing, the strategy screen, Continue, standings, Team HQ and its three rooms, **and since #13/#38 the opening titles, the podium, the press conference and the garage** — each of which must open *and land on the screen id it names*, then a free walk of everything else. Screens are de-duplicated by **what they are** (the shell's own `Screen` id + the headings it prints + its set of buttons), never by the button that led to them, which is what stops a livery swatch reading as a new screen. Rewritten for issue #62 — see §7 |

**Known-failing, all pre-existing and documented:**
- **`probe:handling` 1** (was 4). The steering-feel work took it to **10 ok / 1 failed** —
  see §6, "Three candidates for the swerve". What remains is one assertion covering two
  lanes: the 280 km/h straight (2.98m, a floor no candidate moves and nobody has diagnosed)
  and the 2.6g/280 km/h corner (4.83m, which the old feel left the road on entirely).
- **`probe:drivability` 4, `probe:racingline` 3 — NEW, and new only in the
  sense that these probes can now fail at all.** Nothing was changed in `src/physics/`,
  `src/track/` or `src/ai/` on the branch that added them; every number they report was true
  on `main` before and was being printed and ignored. Two of the three had no assertions
  whatsoever. Full breakdown in §6 and §7 under issue #46. **These are the swerve.**
- ~~`probe:hudtext`~~ — **passes as of the `team-radio-voice` merge**, and independently
  confirmed again by the `fix-race-blockage` work. The bulletin failure ("no team-owned
  bulletin was filed in a 20-minute race") is gone on the merged tree: `team voice: 44
  distinct lines across 31 events`. **Do not go to `RaceEngine.ts` ~2525** — the original
  "call site that never fires" diagnosis was wrong and that code works. Issue #28 supplied
  the correct explanation (the probe parked its own car), and #21 supplied the missing
  half, which was content: 13 authored exchanges became 41.
- `validate:flags` — safety-car form-up, three failures, stable numbers.
- `shoot:panels` — **2 rail + 2 mirror layout failures**, down from 5 + 2. The two radio-card
  failures are FIXED (see §6); what remains is `portrait/safety-car/driver:
  hud-neutral-cue clipped out of the band by 4px` and `phone/pit-choice/cockpit:
  .hud-notices over mirror[R1] by 26×72px`. Both pre-existing and untouched by that work.
  **Re-confirmed byte-for-byte on 2026-08-03** by the #13/#38 routing branch, which touches
  no HUD code: still 2 + 2, same two sentences.
- `probe:weather` — **two failures, both the dry line**: on a soaked track the rubbered
  line measures grip 0.830 against 0.830 beside it, and on a drying track a car on slicks
  is no faster on the dry line than off it. Confirmed identical on pristine `main`
  (stash, run, pop) while working issue #32, so it is pre-existing and not the pit-wall
  work. **Real bug, unfixed** — §6 claims the fast line moves off the dry groove and this
  says the grip difference driving that is currently zero.
- `probe:framing` — **56 failures, and they are new**, introduced deliberately by correcting
  the probe's own settling time. 54 are the HUD's `MIRROR_PANES` keep-out, 1 is a real
  cockpit-camera framing defect at Suzuka, 1 is a pane-width band at Monaco. Full breakdown
  in §7. **This is a probe that got stricter, not a feature that broke.**
- ~~`shoot:frontend`~~ — **was red on `main` and nobody had recorded it, and the cause was
  not the front end.** It exited 1 on every run with three identical lines, one per
  viewport: `console Failed to load resource: the server responded with a status of 404`.
  The text of a console error is the same for a missing icon as for a missing module, so
  the report said nothing about which. Measured on 2026-08-03 by listening on `response`
  and printing every non-2xx URL the front end produces: **exactly one, `404
  /favicon.ico`.** `index.html` references no icon, `public/` holds only `textures/`, and
  Chrome asks every document for one. Filtered on the URL — the same exclusion
  `probe:smoke` has carried since #62 — and any surviving console error now prints its URL.
  **Same species as `probe:fieldsize` below: a probe going red without anybody noticing.**
  **NOT YET CONFIRMED GREEN**, and the reason is worth writing down: the confirming re-run
  died at load average 47–72 on `TimeoutError: Waiting for selector '.mm' failed —
  20000ms exceeded`, waiting for the main menu after `Start driving`, and it threw before
  the error summary is printed. **That is a fixed 20-second deadline on a probe driving a
  software rasteriser — issue #25's defect exactly, in a third harness.** `probe:smoke`
  and `regress:career` both open that same menu happily on the same tree, so the menu is
  fine and the stopwatch is not. `shootFrontEnd.ts` was NOT rewritten for it: that is its
  own job with its own measurement, and it is listed here rather than done badly.
  **Nobody is on this.**
- `probe:fieldsize` — **23 failures, all "X completed 8 laps of a 6-lap race"**. Cars keep
  racing past the chequered flag. Confirmed **pre-existing on `main`** and not a branch
  regression on 2026-08-03: clean `main` and `main` merged with `career-myteam` produce
  **byte-identical** failure lists. Everything structural in the probe still passes at 20,
  22 and 24 cars. Issue #44.

**Corrected record — `probe:hudtext` (#5).** This file used to say the failure was "an
engine call site that never fires (`RaceEngine.ts` ~2525)". **That diagnosis was wrong and
an agent sent to that call site would have found working code.** The probe builds a race
with `playerIndex: 0` and never writes `engine.playerControls`, so its player car sat on
its grid box at zero throttle; the stopped-car bug (#28) then froze the entire field behind
it, and a frozen race files no bulletins because nothing happens in it. Fixing #28 made the
probe pass with no change to the call site or to the probe: **44 distinct team lines across
31 events, 17 messages on the team channel.** Trust the mechanism, not the note.

---

## 5. Conversation history — the user's own words

Preserved verbatim because the phrasing carries information a summary loses.

### Early: graphics quality
> *"nah its still not enough, like its not to that caliber that is expected... its still kinda mid."*
> *"the graphics are utter dogshit."*
> *"why are you unable to get to the quality and rendering as everyone else is able to?"*

### Simulation fidelity
> *"the barriers, the maps should be actually drawn to how it looks in real life. also racing lines most optimal? how close the car gets the redder it becomes, yellow mild, green is good."*
> *"the cars never start off on the track, its always from the paddock following the pit lane rules."*
> *"F1 weekend format is a must... q3, q2, q1 need to happen."*
> *"when you hit a barrier the car is supposed to bounce off of it."*
> *"laptimes should not be deleted until all parts of the car are not off the white line."*
> *"you should be putting up signals somewhere on the map... what sector got what flag."*

### The map/quality complaint that changed how I verify
> *"also all of the other maps still have the weird black lines and grainy maps... YOU NEED TO FIX EVERY MAP."*

### Handling
> *"the car is literally gliding when the user turns, its genuinely not a good user experience whatsoever, its very shit, it randomly starts oversteering and makes some goofy donuts."*
> *"if the racing line is green how did i go off the track? it seems to be swerving a lot again."*

### The car
> *"the lighting is cooked and youre messing up, these are parts that move and certain parts that don't move, I need you to research how an F1 car looks like and moves and what parts are used and understand the entire study completely cuz you seem to be screwing up the most simplest things."*
> *"the tires are clean and smooth, yours have lines on them and its wrong."*
> *"the pipes that are supposed to be attached to the front wing are just flying?"*
> *"there is some black floating piece above the tires."*
> *"the halo is also floating atp?"*
> *"the front wing and the front is so big versus the back wing is super tiny."*
> *"it looks like the hands are turning from the steering wheel but there is blue lego hands on the cockpit makes it seems like the hands are detached."*

### UI
> *"the UI is still mid dude this isn't how a game UI looks like, take a look at Real Racing 3 on the iOS app and shit the way that looks, or like monoposto UI."*
> *"the radio stuff is being covered by the pit options."*
> *"whats this bullshit of holding the minimum every sector make the radios legit and smart think of it like a genuine interaction."*
> *"that text box i told u to make it a square and make it bigger its so hard to read, and you have to type it out in a typewriter animation as well as say what it actually says like volume wise."*
> *"also the radio messages have to vary why is it always the same message? also it seems like whatever the message is saying is so different than what the voice is saying, we also need one voice and use the male one not the female one i don't like that one. on top of that i cant see any of the messages bruh"*
> *"this is so much better i just atp wouldn't say anything for the audio if its a conversation because you don't need to be saying what the driver says ykwim? but this is wayy better for sure."*
> *"Also still seems like you have the same statement when something happens, we need to vary it up, like once you gotta ask if they okay or maybe another time, u say like better luck next time, or like im sorry we'll have to retrire the car here."*
> *"also like i said get rid of the female voice. only keep the male voice"*
> *"why does it seem like the same person as the team principal for all the teams?"*
> *"why can I only see like 4 cars on the leaderboard, where is everyone and all the cars?"*
> *"don't do this shit. just have the team radio in some message and then top right corner or smth just be like continue and then once the user presses continue you can check the stats and shit."*

### Race control / stewards
> *"the FIA doesn't say shit but give notifications, the rest of the stuff happens between the team principal and the driver."*
> *"if I had no room to make a turn because the other car kinda boxed me out, or like I was at the apex first and by the rules they weren't and therefore that corner should've been mine but they passed me and caused me to slow down / go off the track, they should be told to give me the position back."*
> *"if there is a penalty, they have to serve it in the pitlane otherwise if they don't pit it gets added to their final time at the end of the race."*

### AI
> *"inherently the AIs are not that smart... if there is a car in front or something that doesn't mean that they go into the car to try to crash into them?? when im in the pitlane and i haven't moved, they shouldn't just like crash into me in the back."*
> *"there are too many accidents happened and way too many penalties being given out... real f1 drivers don't crash that much they are a lot more careful but very competitive."*

### Career / story
> *"lets make this the entire story line, the main user is a new rookie on his route to becoming an F1 driver and more importantly an F1 champion. starts off with F3 and then gets into F1. top 2 in each championship end up being moved up the ranks."*
> *"My Team Mode: You act as both the team owner and the lead driver. You design the car livery, sign sponsors, choose an engine supplier, hire a teammate, and build a racing empire from the ground up."*
> *"I also want you to get the complete storyline done... Right now, apparently, it's there, but it's jittery. It's not clear what's going on, what you're supposed to do, or how it works."*
> Full world requested: *"All the other teams / Their stories / News media headlines / Your analyst / Your publicist / Your marketer / Your PA / Your manager / Your contracts / Your sponsorships / Your agencies."*

### First-run / identity
> *"imagine if I logged into the website for the first time, what would i see? rn it seems that i am logging in with Preet Karia somehow, but in the future how would we do that... do I need to logout someway or some form?"*
> *"I have yet to see the in game renders at all about the podiums, the career starts."*

### Process criticism — worth keeping
> *"what the fuck are you keep on testing for all i see is that you start a new session the car goes in a straight line, and then it crashes, what are you getting from that? i don't see you making the changes that we talked about?"*
> *"with all the coding prowess that you have and all the skills and mcps and shit you can do you should've been done with this a while ago. not sure why you are still struggling so much. especially when you are able to run so many sessions at the same time in parallel."*
> *"you need a separate session that runs and debugs and goes through everything... just an agent that looks through all of the files and like finds the bugs so I don't have to manually tell you that."*

---

## 6. What has been done — with the measurement that proves it

Ordered by impact. Each of these was verified on merged `main`.

### Rendering: the single biggest fix
The dynamic resolution scaler dropped below 60fps and could only climb above **68fps**,
which a vsync-limited display cannot report. **Dead code.** Every session on every circuit
collapsed to `MIN_SCALE = 0.5` — a quarter of the pixels — within two seconds and stayed.
It also reacted to the startup transient (shader compilation, 3–15fps for ~5s).

- **25% of native pixels → 81–100%. 19–30fps → 48–60fps.**
- The bottleneck was post-processing at **71% of frame time**, not the scene. Bloom was
  14.4ms of a 31.5ms frame — and none of it was the blur chain; it was two full-resolution
  operations on a half-float buffer.
- `EffectComposer` clones the target it is given, so `samples: 4` multisampled every
  full-screen quad.
- Sharpness measured **5.4–11.3× better**, from below Monoposto to inside the real-footage
  range.
- **Why nobody found it:** `audit:circuits` drives the renderer with a hard-coded `dt` of
  1/60, computing exactly 60fps — neither below 59 nor above 68 — so **the scaler never
  moved in the audit.** Every audit PNG ever produced was shot at full resolution. The
  harness was photographing an image no player had ever seen.

### Rendering: every phone was on the cheapest image the renderer can draw (issue #29)

The tier was `touchPrimary || cores <= 4 ? 'low' : 'high'`, and `touchPrimary` is
`matchMedia('(pointer: coarse)')` — so **every phone that has ever existed was `low`**, and
`low` withheld the post-processing chain, the shadow map, MSAA and half the geometry as one
indivisible decision, with no in-game control. This is the mirrors defect one level up, and
the reporting device is a phone.

**How much of "the graphics are utter dogshit" is the tier rather than the renderer?**
Measured, not argued. `probe:sharpness` gained a grain metric — mean absolute Laplacian of
luma in six horizontal bands, read back inside the frame that drew it, at the resolution
the scaler actually settled on — and a `SHARP_QUERY` passthrough so a tier can be
photographed at all. Bahrain, cockpit, identical frame, scale 1.00, buffer ~2940×1396:

| tier | band 1 (horizon) | band 2 (mid-distance) | band 5 (near field) |
|---|---|---|---|
| `low` — what every phone got | **20.3** | **63.6** | 3.0 |
| `low` + post chain, low detail | 2.1 | 18.7 | 6.7 |
| `medium` (post, full detail, no MSAA) | 4.0 | 22.6 | 6.2 |
| `medium` + MSAA | 1.7 | 15.5 | 5.8 |
| `high` — what the developing machine got | 1.2 | 14.8 | 6.1 |

**The phone's image carried 16× the high-frequency speckle at the horizon and 4.3× in the
middle distance, and the cause is the missing post chain, not the renderer.** Turning post
on and changing nothing else — geometry still at low detail, still no MSAA, still no
shadows — recovers 9.7× of the horizon band and 3.4× of the mid-distance. Geometry detail
contributes nothing measurable (low+post 18.7 against medium's 22.6, i.e. slightly worse).
MSAA is worth a further ~1.5×. Chase view agrees within 10% on every row. This is the
user's *"all of the other maps still have the weird black lines and grainy maps"* and it is
a tier artefact.

**Can a phone afford the chain? Yes — and it is not even a trade.** The obvious objection is
that the post chain was 71% of frame time, so switching it on for phones would tank the
device. Measured on an Apple M5 with GPU timer queries, in paired A/B inside one session, at
**390×844 @ dpr 2 — the pixel count a phone actually draws**, not a desktop's:

| | Bahrain | Monaco | Spa |
|---|---|---|---|
| scene alone (no chain) | 5.02ms | 4.90ms | 5.14ms |
| scene + post chain | 9.78ms | 8.23ms | 10.98ms |
| post chain costs | +4.26ms (1.9×) | +3.35ms (1.7×) | +5.68ms (2.1×) |
| MSAA on top of that | +1.69ms | +1.32ms | +4.45ms |
| **`medium` @ scale 0.50 vs `low` @ scale 1.00** | **3.63 vs 4.99ms — 27% CHEAPER** | 5.17 vs 4.99ms — 6% dearer | **3.90 vs 5.51ms — 29% CHEAPER** |

The last row is the whole decision as one number, measured as one paired factor
(`PERF_PAIR=tiertrade`) rather than composed from the others, and the spreads are tight
(−1.82..−1.18, −1.15..+0.56, −1.95..−1.25). **The post chain at a quarter of the pixels
costs the same or less than no chain at full resolution**, and the grain table above says
`medium` at scale 0.50 still measures **32.8** in the mid-distance against `low` at scale
1.00's **63.6**, and **6.8** at the horizon against **20.3** — 1.9× and 3.0× cleaner while
being no more expensive. A phone was paying full price for the worse image.

What landed:
- **`src/render/QualityTiers.ts`** — one place that decides what every `quality === 'high'`
  gate in `src/render/` means. Three tiers and four independent switches (post, shadows,
  MSAA, resolution ceiling), because the four do not scale together and the binary tier
  forced an all-or-nothing choice a phone always lost.
- **Detection cannot solve this and does not pretend to.** `hardwareConcurrency` is clamped
  on iOS — every iPhone reports the same small number whatever silicon is behind it — and
  `deviceMemory` is not implemented in Safari at all. Any rule written on those reproduces
  the bug. So `auto` starts from a floor it is confident about and then **measures**:
  `Renderer.updateAutoTier` promotes a tier after 8s under budget *at the scaler's ceiling*
  and demotes-and-latches when the resolution scaler has run out of room. Same shape as the
  resolution scaler, which is the only thing in this renderer that has ever correctly
  described the machine it was on. `auto` is still the default; it can no longer pin a phone
  at `low`.
- **`PostFX.enabled` was `quality === 'high'` and `readonly`.** The chain now builds and
  tears down on demand, so the setting takes effect without ending the session.
- **MSAA has two homes and they did not agree.** The GL context's `antialias` attribute is
  what antialiases when the chain is off and is *dead* when it is on — the samples that cost
  bandwidth then are the composer target's. Before three tiers existed the two could not
  disagree; `medium` is post-without-MSAA and would silently have paid for four samples a
  pixel. Both follow one switch now, and `probe:graphics` asserts both.
- **`probe:graphics`, 67 checks**, reading the **GL context** — `getContextAttributes()
  .antialias`, `shadowMap.enabled`, whether a composer was allocated, the target's
  `samples`, the drawing-buffer size — rather than the settings object, because a build with
  the wire cut has a settings object that agrees with itself perfectly. **Proved it goes
  red:** deleting the arguments to `new Renderer` in `main.ts`, which is the exact bug the
  issue describes, takes it from **67 ok / 0 failed to 48 ok / 19 failed**, and the three
  tiers collapse to one GL configuration.

### Auto quality latched DOWN permanently on transient load (issue #73)

> *"everything is very grainy again and like you can't really see anything in front of you
> to a high quality its pixelated and idk why its like that"*

**A regression introduced by #29 the same day, and the mechanism was exactly as filed.**
`Renderer.updateAutoTier` demoted a tier the instant `frameCostMs` read above
`AUTO_DEMOTE_MS` while the scaler happened to be at `MIN_SCALE`, and set
`autoLatchedCeiling` to the tier it was **leaving** — which the promotion path then refused
forever (`if (!up || up === this.autoLatchedCeiling) return`). Six headless Chromes were
running on the user's machine at load average 17–148. The scaler gave up pixels first
(correct); then `high` → `medium`, latching `high` out; then `medium` → `low`, latching
`medium` out. They finished on `low` — **20.3 horizon / 63.6 mid-distance grain against
`high`'s 1.2 / 14.8, i.e. 16× and 4.3× more speckle by #29's own table above** — and it
never came back, with nothing on screen saying it had happened.

**Two faults, not one, and both had to be fixed.** The evidence was one trimmed mean over
45 frames — about three quarters of a second — and the consequence was permanent.

- **Duration.** A demotion now needs `AUTO_VERDICT_S` (6s) of **unbroken** trouble at
  minimum resolution. Any comfortable frame resets the clock. That is eight times the
  evidence, and the resolution scaler continues to absorb everything shorter, which is what
  it is for. Measured: 20 five-second bursts of 40ms frames at `MIN_SCALE`, each broken by
  0.2s of calm, move the tier **not at all**.
- **Repetition.** The latch survives — deleting it is not the fix, because promoting into
  `high` turns the shadow map on and `applyResolved` then marks **every material in the
  scene** `needsUpdate`, a stall of a few hundred milliseconds — but it now counts. A tier
  is retried **once**; a **second** failure is a verdict about the device and latches
  (`AUTO_LATCH_AFTER_DEMOTIONS = 2`). The worst case for a genuinely weak machine is one
  extra stall per tier per page load, which is bounded and stated.
- **Escalating proof.** A retry of a tier that has already failed costs **twice** the
  comfortable time the first attempt did (`promoteAfterS`), so a machine hovering on the
  boundary walks away from it instead of flapping. Measured: twelve alternating
  trouble/calm cycles produce **6 tier changes and exactly 1 promotion into `high`**, then
  it stops.
- **The player is told.** A one-line renderer-owned banner — *"Graphics reduced to Low to
  keep the frame rate"* / *"It will go back up on its own — or set it in Menu ▸ Settings ▸
  Video"* — and *"Graphics back to High"* when it returns. A routine first promotion is
  **not** announced; auto doing its job quietly is the design. It is deliberately its own
  element with inline styles and is **not** inside `.hud-notices`, whose band `shoot:panels`
  measures.
- **The decision moved out of `Renderer` into `AutoTierPolicy` in `QualityTiers.ts`** — no
  THREE, no DOM — for the same reason `RenderPose.ts` exists: so a probe can drive **the
  real rule**. `Renderer.updateAutoTier` is now glue that derives the scaler's two facts and
  applies whatever comes back, and `probe:autotier` §6 asserts by source inspection that no
  threshold or latch is compared against anywhere in `Renderer.ts`.

**A tier chosen in Settings was already safe, and that is now measured rather than
asserted.** `resolveGraphics` sets `adaptive` from `tier === 'auto'`, and `updateAutoTier`
reads it first. Five minutes of 40ms frames at `MIN_SCALE` against a stored `quality:'high'`
move nothing — tier, `shadowMap.enabled` and the composer all unchanged, and no notice is
shown. The same holds for a stored `medium`, checked separately so *"it had nowhere to go
anyway"* cannot be what passes it. **No second bug.**

**`probe:autotier` — 55 checks, 40 of them with no browser at all.** §1–§4 drive the real
policy off synthetic frame costs; §5 loads the real game in headless Chrome and drives
`Renderer.feedFrameCost` — the real policy, the real `moveTier`, the real `applyResolved` —
then reads the **GL context**, because a tier that "came back" without `shadowMap.enabled`
and the composer coming back with it has not come back. **It is not load sensitive**: every
frame cost is stated, never measured, so unlike `probe:renderperf` it says the same thing on
a busy machine.

**Proved it goes red.** Restoring the old rule verbatim inside `AutoTierPolicy.update` —
demote on one window, latch on the first failure — takes it from **55 ok / 0 failed to 33 ok
/ 22 failed**, and the two headline lines are the user's session:

    FAIL  THE TIER COMES BACK WHEN THE LOAD GOES AWAY  — low -> low
    FAIL  THE REAL RENDERER GETS BACK TO HIGH          — on 'low'

Under that same re-break the four manual-tier assertions stayed **green**, which is the
independent confirmation that requirement 4 was never broken. `probe:graphics` **72 ok / 0
failed** unchanged.

### The world
- **Corner "cliffs":** the ground beyond every circuit was one flat quad at y = −0.62
  while circuits climb to 58m at Spa. The vertical skirt was as tall as the circuit was
  elevated — mean 4.1m at Bahrain, 27.2m at Spa, 58.6m worst. Now 0.97m everywhere.
  New `Terrain.ts` samples the circuit's own elevation so ground and road meet by
  construction.
- **Banking** was applied with no limit on lateral distance: Zandvoort's run-off edge was
  drawn **7.4m above** the racing surface.
- **`carGroundY` ignored the banking**, so a car displaced sideways on a banked corner was
  placed at the CENTRELINE's height. Against the drawn triangles, at 80% of half-width:
  **1.560m at Zandvoort** (s=4127, 18° through Hugenholtz and the final turn), 0.392m at
  Spa, zero on the other nine. `bankedCarGroundY` now sweeps the car with the same
  `bankHeight` the road mesh is swept with, bounded the same way, so the two cannot
  disagree: **0.000m on all eleven circuits, 17,220 rays.** Every renderer-side placement
  goes through it and `probe:banking` fails if anything in `src/` outside `TrackMesh.ts`
  calls the flat rule. (Issue #3, closed 2026-08-03.)
- **The centreline turned tighter than the road is wide** at ten nodes, so the inside edge
  of the ribbon ran backwards and the asphalt folded over itself — COTA s=3431 at **−0.203**
  of the centreline's advance, Bahrain s=2544 at −0.009, six folded spans and 28 under the
  margin. Fixed by easing the CENTRELINE, not by narrowing the road: `realGeometry` carries
  a control point every ~25m, so a hairpin arrives as one vertex turning through 130°, and
  the fold is a sampling artefact of the trace rather than a road that is too wide.
  Narrowing alone was measured and does not work — it takes Bahrain, Spa, Monza and COTA to
  the 12m floor (from 15m, below the FIA-recommended width) and still leaves Monaco folded
  at −0.072. After easing, the worst span on the calendar advances **0.342** (Monaco s=336)
  against a 0.30 margin and **nothing folds**; the width pass now narrows nothing at all and
  stands as the guarantee. Lap times did not move: `validate:tracks` worst error 5.7%, mean
  bias +1.7%, identical to before. (Issue #4, closed 2026-08-03.)
- **Divots:** `computeShoulders` tested a probe **disc as long as the road is wide**, so on
  corners it read the road's own asphalt as an obstruction — 162 false zeros, **134 of them
  self-blocked**, each dragging 84m of shoulder to nothing. Bahrain's Turn 1 had asphalt
  then a 1.03m drop into the desert. Divots by raycast: **528 → 127.**
- **Kerbs:** 42.6% of every lap was kerbed (59% at Monaco). Threshold 400m → 250m radius;
  now 33.9%. Astroturf added.
- **Black seams:** the ground plane showing through a 0.45m unfilled slot along both road
  edges, 4.7–11.6km per circuit. Bahrain's sandy ground hid it — which is exactly why
  Bahrain-only verification kept passing.
- A grandstand was drawn at the **world origin** on every circuit (an empty InstancedMesh
  drawing one instance at identity). At Jeddah the world origin is on the road.

### The car
- **`loft()` wound both end caps inward on every loft in the project.** Correct for
  sections whose z increases; every list in `CarMesh` is authored front-to-back. All
  "capped" lofts were hollow. **The airbox had no intake at all** — 250 of 250 throat
  vertices hidden from every direction, ~300 triangles never drawn. Three previous passes
  "fixed the airbox" behind a skin that was never what hid it.
- Rebuilt against **FIA Technical Regulations Appendix 1** (explicit XYZ polygons in mm),
  with the conversion written into `CarMesh.ts` as a ~150-line reference block.
- **Tyres:** 28 painted tread lines and 36 cycles of sine in the normal map — on a slick.
  Compound band 16mm → 28mm. Albedo graining was reading as blistering.
- **Suspension:** front ball joints **130mm out of position** (Art. 10.3.4 caps the
  outboard joint 40mm below wheel centre; ours was 156mm). Members were round 42mm bar;
  now 78×22mm aerofoil, the 3.5:1 regulation aspect limit. Vertical span in the onboard
  frame **73–100% → 10–13%**.
- **DRS hinge was on the flap's leading edge**, from which a slot physically cannot open.
- **Wheels sat 20mm underground** — the drawn asphalt is `ROAD_SURFACE_Y` above the
  simulated elevation and cars were placed on the elevation. A 237mm-wide bite from every
  tyre. `carGroundY()` now owns that arithmetic.
- **24 suspension members floated**, worst 154mm. The halo was bolted to nothing (hoop
  66mm clear, pillar 74mm). The "black slab over the rear tyre" was the rear wing endplate.
- **Materials:** painted bodywork was at **metalness 0.26** — a physically impossible
  half-metal that deletes a quarter of the diffuse and tints highlights with the paint's
  own hue. That was the "blown out white plastic" look; global exposure was never the
  problem.
- Front wing endplate was 25mm too far out (placed at the 1000mm *bodywork* limit; the
  wing's own limit is 975).

### The front corner, and the two questions `probe:carrig` was not asking (issue #47)

> *"phasing through the carbon and the wheel covers on the top are actually floating
> confirmed"* — reported with a driver's-eye screenshot. `probe:carrig` was **green**.

**The probe gap had two halves, and both are the same mistake in different clothes.**

- **The wheel covers were not in the part list at all.** `frontUprightGeometry` merged the
  upright column, the steering arm, the over-wheel cover, its support vane and the brake
  drum into ONE buffer named `front upright`. The connectivity check unions *parts*, and
  the upright column touches the wishbones, so the whole merge joined the car by
  association and everything inside it was carried along — including a blade hanging in
  clear air over the tyre. `carPartsForProbe` now takes the corner as five named pieces
  from `frontCornerParts`. **139 parts → 147.** This is `mergeGeometries` hiding a part
  exactly as §6 records it hiding "the black slab above the rear tyre", one level up.
- **Attachment and interpenetration are the same measurement with opposite signs, and the
  probe only read one sign.** Section 2 treats "inside another part" as a PASS — correct
  for a pickup, blind to a leg crossing a panel.

**And splitting it out was not enough**, which is the part worth remembering. With the
cover as its own part the probe *still* passed, because `JOIN_TOL` is 10mm and the cover's
nearest surface was its own vane **2.30mm** away at the high tier and **8.56mm** at the
low one. The probe's own tolerance note already said what the rule should be — *"parts of
a car are authored to overlap … so genuine joints measure zero"* — so a positive number is
not a joint, it is daylight. Three new sections:

- **Bolted joints.** Every part must *intersect* another: a sampled point of one inside
  the solid of the other, tested both ways. Volumetric, no tolerance in it, cannot be tuned.
- **Interpenetration.** Every member's centreline walked at 2mm; a run inside a piece of
  bodywork reaching neither end is a passage clean through somebody else's carbon.
- **Steering lock.** 13 angles across ±0.42 rad (`BASE_F1_SPEC.maxSteerRad`), both corners:
  nothing on the steer group may enter the chassis, and no steered fairing may enter a
  member. **There is no ride-height axis to sweep** — `Renderer` places the whole visual at
  `bankedCarGroundY` and nothing moves the body relative to the wheels — so the corner is
  the only articulation the car has, and it was measured nowhere.

**On the build the screenshot came from: 33 defects.** What they were:

- **The over-wheel cover was bolted to nothing.** 2.30/2.60mm off its vane at the high
  tier, **8.56/8.64mm at the low tier — the tier every phone runs** — and at the low tier
  the vane's own nearest surface was the *tyre*, 5.40mm away, so cover and vane were a
  two-part assembly attached to the car by nothing at all. Its vane also passed through
  **both upper wishbone legs, 14mm each, at every steering angle.**
- **The "front wake fin" was a bargeboard**, deleted from the regulations in 2022 and
  named as such in this file's own reference block. It stood at x = 0.480 where the floor
  reaches 0.150–0.278, i.e. **200mm outboard of the nearest floor, in open air.** It read
  as attached only because the lower-front leg, the lower-rear leg and the trackrod passed
  clean **through** it — 40mm, 38mm and 32mm. Lower it clear of them, as the first attempt
  did, and the probe immediately calls it floating **21.6mm** (high) / **29.8mm** (low).
- **Front wing flick:** met the endplate over 3mm of superellipse tip, which the high
  tier's polygon reaches and the low tier's does not — **7.15mm** at the low tier, to
  `front wing element 4` rather than to the plate it is folded over.
- **Sidepod winglet:** 0.64mm off the pod at the high tier, 4.09mm at the low. Its comment
  already claimed it was "bedded into the pod's shoulder"; it was measured as a distance
  and set to nearly-zero, which is not the same as inside.

**Why the over-wheel cover was deleted rather than re-bolted, and this is the finding.**
Any rigid support must stand inboard of the tyre's wall at 0.1625 and rise past the upper
wishbone, while the corner steers ±24.1° and the wishbone does not. In plan about the hub
axis the two upper legs block a fixed pair of angular bands — at a support's radius,
**[−29.0°, −7.0°] and [+4.3°, +25.9°]** — leaving **11.3° between them against the 48.1°
the sweep needs**. That window is 5.3° at r = 0.18 and still only 31.7° at r = 0.50, so it
does not fit at *any* radius; going outside the pair needs |θ| > 53°, which puts the
support 300mm or more ahead of the axle. The real car solves it with a shaped aperture
around the wishbone and none of the loft primitives in `CarMesh` can express a hole. The
choice was a blade that floats, a blade that passes through the suspension between 12° and
24° of lock (measured: 2–24mm of a leg, both corners, both tiers), or no blade.

**Proved red three ways.** Restoring the original cover and vane: **102 defects**, the
same 2.30/2.60 and 8.56/8.64 numbers back, plus the lock fouls. Restoring the wake fin and
un-bedding the sidepod winglet: **17 defects**, the same six THROUGH reports per tier.
Widening the steered brake drum until it reaches the floor: **105 defects**, naming the
monocoque, the floor and two floor fences at each angle — which is what makes the steering
section load-bearing rather than decorative.

**After: 141 parts, both tiers, every section green.** `probe:framing` unchanged at 56
(54 `MIRROR_PANES`, 1 Suzuka rail, 1 Monaco band); `probe:suspension`, `probe:rideheight`,
`probe:activeaero`, `audit:car` and `typecheck` all pass.

### Cameras and mirrors
- **The halo:** the T-cam sat 0.40m *in front of* the hoop. Crown at **82% of frame
  height** — two diagonals in the bottom fifth, which is exactly "two black tubes".
  Now 65% against a 56% reference. Cockpit camera was aimed 7.8° down at the floor.
- **Mirrors were mounted 78.6° out of roll.** `setFromUnitVectors` gives the shortest
  rotation onto the normal and says nothing about roll about it; a mirror's normal is
  nearly antiparallel to a plane's default, so the shortest rotation stands the plane on
  end. A 42mm-wide, 112mm-**tall** portrait sliver showing a 2.67:1 landscape feed sideways.
  Plus: the feed ran only in `cockpit` mode and only on the `high` tier, and the tier is
  `(pointer: coarse) || cores <= 4` — so **every phone is `low` and it had never run on the
  reporting device at all.** That second half was never a mirror bug: it was the tier, and
  it was one of about a dozen gates behind it. See "every phone was on the cheapest image"
  above and issue #29 — the tier itself is now three tiers and four switches.
- Mirror housing was lofted **widest 30mm in front of the glass**. Pane 74×32mm →
  **150×46mm** (150 is the FIA minimum). Then the cap fix revealed the housing's rear cap
  was a solid disc the size of the aperture — once drawn, **it was the mirror.**
- **Driver's-eye view** added — *"imagine from the perception of the driver's lenses"* —
  and held to `probe:framing` like the others, on all eleven circuits in both frame shapes.
  The eye is at car-local **(0, 0.770, 0.165)**, 0.58m forward and 0.21m below the roll-hoop
  pod the `cockpit` mode uses, pitched 1.98° down. **The targets are geometry-derived, not
  reference-derived** — see §9: there is no genuine F1 driver's-eye onboard on disk, so
  every number is solved against the car's own modelled parts (the wheel rim's top bar at
  y = 0.703, the halo crown at 0.812, the helmet crown at 0.828) rather than read off a
  frame. What it measures: **halo crown 41–44% of frame height against a horizon at 46–48**
  — crown *above* the horizon, the exact inverse of the two pod cameras, which carry it
  below at 59–66; rails leaving through the **sides** rather than the bottom; panes at
  **10–22% of frame width** against the cockpit's 7–10 and the T-cam's 5–7, with the hoop
  across **0%** of them.
- **The sky was clipped out of the mirror feed.** The sky is a dome of radius 3600 dropped
  onto the main camera each frame; a mirror's far plane is `MIRROR_FAR` = 120, so every
  triangle of it was clipped and what was left was the renderer's clear colour, `0x0a0c10`.
  **The top half of both panes was solid black in daylight for as long as the feed had
  existed.** Every earlier pass asked whether the feed *contained* anything — it did: a
  strip of road under a black void. Now clears to `scene.fog.color`, which is already what
  the far end of the pane fades into, so there is no seam. Two state changes, no draw calls.
- **The mirror lens was 42° vertical, which on the feed's aspect is 91° across** — a rival
  25m back was two and a half pixels of pane. Now **28° vertical = 78.2° across** on a pane
  rebuilt to the FIA minimum 150×46mm: same horizontal angle, twice the glass, ~2.1× the
  on-glass size of a car 25m back.
- **`probe:framing` was reading the rig mid-lens-transition.** Every mode starts on the
  chase camera's 39° lens and damps toward its own; twenty frames of settling caught the
  driver's eye at **56.50° instead of 63.65°** (converged; 300 frames gives the same
  number), the cockpit at 38.96 against 40.07 and the T-cam at 42.78 against 45.49. Now
  settled for two seconds. **This made the probe stricter, not looser** — see §7.
- Reverse-camera jitter: slip angle measured against the car's nose, so a reversing car
  sat on ±π and the sign flipped every time the wheel moved — a **66° lurch per frame.**

### The world juddering vertically — the half of the render pose #9 did not carry (issue #54)

> *"also not sure if you see this jittering happening for the track like there are lags
> or something"* — and they said the **track**, not the cars, which is the whole diagnosis.

#9 interpolated the render pose between physics steps and its doc comment states the
intent: *"Every consumer below — the cars, the cameras, the effects, the shadow frustum,
the motion-blur focus — reads the render pose, and they must all read the same one."*
**The intent was not met, because the pose was three numbers.** `renderX`, `renderZ` and
`renderHeading` place a car in PLAN. Every HEIGHT in the scene comes from the other two —
the road is a swept ribbon, so the only way to ask how high the asphalt is under a car is
`bankedCarGroundY(track, s, lateral)` — and `s`/`lateral` were raw 120Hz solver state at
every one of them: the car mesh, the camera's own eye, the tyre smoke, the shadow frustum,
the racing line. So the drawn world was a continuous function of wall-clock time
horizontally and a **staircase vertically**, #9's own 2, 2, 3, 2, 3 rotated 90°. And
because the CAMERA's height came from the same stepped pair, the error was applied to the
viewpoint instead of cancelling in screen space the way it does for the car being followed
— which is exactly why it reads as the world bobbing rather than the cars juddering.

- **The diagnosis in the issue was written from the code, and the measurement confirmed it
  exactly.** On the build the bug was filed against, the "stepped" and "interpolated"
  columns of the new probe section are **identical to four decimal places on all 44 rows**,
  which is the signature of a render pose with no vertical component and of nothing else.
- **`CarEntry` now carries `prevS`/`prevLateral` and `renderS`/`renderLateral`**, written
  in the same place and on the same step as the plan pose. The rule moved out of
  `Renderer` into **`src/render/RenderPose.ts`** so that a probe can drive the real one.
  `s` is lerped **the short way round the lap**, exactly as heading is round ±π, and the
  `TELEPORT_M` snap now covers along-the-lap and across-the-lap jumps as well as plan ones
  — which also catches a projection that jumps with no teleport behind it, as at Suzuka's
  crossover (#37).
- **Measured: `probe:framerate`, new "WORLD SMOOTHNESS" section.** The real
  `CameraDirector` on a real `RaceEngine`, a **full lap** of each of the eleven circuits at
  **50 and 85fps** — neither divides 120 — reading the camera's own world Y and taking its
  per-frame second difference. Worst |d2| at 50fps, stepped → interpolated: **Spa 123.8mm →
  11.5mm, COTA 92.9 → 5.7, Monaco 47.5 → 3.6, Red Bull Ring 32.1 → 3.0, Interlagos 25.1 →
  2.2, Suzuka 18.5 → 1.9, Zandvoort 36.1 → 12.3.** RMS falls **20–30×** on every circuit
  with a gradient (Spa 15.0mm → 0.7mm, COTA 13.2 → 0.6, Monaco 8.6 → 0.3). Bahrain is
  4.2mm → 4.2mm and that is correct: it is flat, there is no gradient for a staircase to be
  a staircase OF, and it is why the issue says do not verify there.
- **The bound is derived from the world model, not from the output.** Every circuit is
  stored as a polyline with a node every **3.00m**, elevation interpolated linearly, so the
  drawn road creases at every node and a camera crossing one gets a real step in vertical
  velocity. Worst node kink on the calendar is 0.0057 of gradient (Spa, at the foot of Eau
  Rouge, also the steepest road at **18.7%**), worth 9.2mm in a 50fps frame at 80 m/s;
  Zandvoort's 18° banking against the projection's own per-node lateral kink measures
  12.3mm. The bound is **20mm**, and the artefact it is there to catch is 124mm.
- **Proved it can go red, twice.** Pointing the camera's `carY` back at `car.s`/`car.lateral`:
  **24 of 44 rows red**, the interpolated column collapsing exactly onto the stepped one —
  *"spa driver 50fps: the camera's height moves 123.8mm of second difference at s=866m,
  bound 20mm"*. Restoring the old camera floor: **3 rows red at Zandvoort**, 52.4mm.
- **A second, independent judder the probe found on its own.** The camera's "never below
  the road" floor was measured against the **centreline's** elevation. On the low side of
  18° banking the road is up to 2.5m below the centreline, so the floor sat **0.83m above
  the asphalt** and the driver's eye — which rides 0.77m up — spent Hugenholtz **pinned to
  it**, tracking `elevationAt(s)` instead of the car and popping off as the car climbed
  back: **52.4mm in one frame, four times anything else on the calendar.** Same mistake as
  issue #3, one line, now measured against `bankedCarGroundY`. **Zandvoort 52.4mm → 12.3mm.**
- **`probe:cameras` had the same datum error and it was hiding behind the same clamp.** Its
  "underground" check asks whether the camera is 1.5m below `elevation[indexAt(car.s)]`,
  which on banking is nowhere near the road; it could never fire while the clamp held every
  camera at `centreline + 0.35`, and the moment the clamp was corrected it produced **10
  false positives at Zandvoort**. Now measured against `bankedCarGroundY` — the rule
  `probe:banking` already forbids departing from anywhere in `src/` — and it prints the
  worst depth and the mode rather than a bare count. **All eleven circuits clear.**
- **What was NOT interpolated, deliberately: the safety car.** `Renderer.syncSafetyCar`
  draws it from `sc.s`/`sc.lateral`, and its X and Z come from `toWorld(sc.s, …)` too — so
  unlike a racing car it is stepped in **all three axes**, not just in height. Giving it a
  render pose means a `prevS`/`prevLateral` on `SafetyCar` itself, which is race-side code
  the in-flight safety-car work owns. Listed in §7.

### The crashed car that shook, and sank its wheels into the road (issue #58)

> *"one the wheels are in the ground not sure how thats possible, second there is a lot of
> shaking back and forth even tho the car has crashed which it shouldnt do, third the
> speedometer is in N?"* — from a screen recording.

The issue proposed that all three were **one** contact-resolution state that never
converges. **That hypothesis is wrong, and disproving it is the first result.** A retired
car is not stepped at all — `RaceEngine.step` opens with `if (car.retired) continue` — so
there is no contact loop to fail to converge and its solver state is frozen by
construction. #28's agent measured exactly that and handed the issue back, correctly. Both
real defects are in the **drawing** of that frozen state, they are independent of each
other, and neither is in `src/physics/`.

**1. The shaking: `prev` is never refreshed for a car the engine does not step.**
`updateRenderPoses` draws every car at `prev + (now − prev) × alpha`, and `prev` is
captured in `RaceEngine.step` immediately before `physics.step`. **Four branches of that
loop `continue` before the capture** — a retired car, a car sitting the period out, a car
on its release timer, and the whole field before the lights go out. For those the pair
never advances again: it stays at the top of the last step the car *was* stepped on while
`physics.position` holds the end of that step, and the two differ by one step of travel
plus the barrier push-out — **311mm at Monza off a 293 km/h accident.** `alpha` is the
accumulator's remainder and sweeps 0..1 as the display beats against 120Hz, so the wreck is
**drawn sliding back and forth across its final step, every frame, for the rest of the
session.** It cannot decay, because nothing about it is a transient, and it is below
`TELEPORT_M` so the snap that exists for placements does not catch it.
- Measured by the new `probe:crashrest` §1, driving the **real** `SimClock` and the **real**
  `updateRenderPoses`, at 50 and 85fps with frame jitter — neither rate divides 120:
  **Monza 296.7mm of movement in a single frame, Zandvoort 180.8mm, Monaco 79.0mm, Spa
  55.7mm**, mean 201/123/54/38mm. The **vertical** half is there too, which is #54's
  channel: **Spa 11.9mm, Monaco 10.8mm, Zandvoort 3.5mm per frame.**
- Fixed by `CarEntry.holdPose()` — prev := now — called on the retired branch and inside
  `holdOnGrid`, which covers the other three. **All eight rows go to 0.00mm.** The
  interpolation itself is untouched and was never wrong; what was wrong is that the
  invariant *"prev is where the car was at the top of this step"* had not been made to hold
  for a car that is standing still.

**2. The wheels: the wreck's lean is applied about the origin, and the origin is the
road.** A wreck has no accelerations, so the roll and pitch that make a running car look
loaded up both fall to zero and it would sit dead level; `Renderer.syncCars` gives it a
settled lean from its own index instead, up to **0.075 rad of roll and 0.045 of pitch**.
That rotation is about the car's origin — which is the contact-patch plane, the thing
`bankedCarGroundY` puts *exactly* on the drawn asphalt (#3, 2mm on eleven circuits). So
every contact point on the low side goes straight through the surface: the outer edge of a
front tyre is **962mm** from the roll axis and the front axle is **1800mm** from the pitch
axis. **Measured against the drawn triangles, worst car of twenty: 164.2mm at Monza,
Zandvoort and Spa, 163.9mm at Monaco — 46% of a 360mm tyre, buried.**
- `src/render/CarAttitude.ts` now owns the lean and a `groundLift`, in its own module for
  the same reason `RenderPose.ts` is: **so a probe can drive the real rule.** The lift is
  the depth of the deepest of the eight contact points under the rotation *as actually
  applied* — which is why it takes the heading as an argument (see §7).
- **Applied to a wreck only, deliberately.** A running car's roll and pitch model the BODY
  moving on its suspension while the tyres stay planted, and this rig cannot express that:
  `Renderer` places the whole visual at one height and nothing moves the body relative to
  the wheels (`CarMesh.frontCornerForProbe` says so in as many words). Lifting the whole
  car under braking would draw it hopping off the road — a worse artefact than the one it
  fixes, and transient in a way a wreck's permanent lean is not.
- **`probe:crashrest` §2b reads the source**, because §2 computes the root height itself and
  would therefore stay green with the renderer's call deleted — the tautology §3.2 exists
  to prevent. Same shape of second check as `probe:banking`'s call-site rule.

**3. The `N` is correct, and this is the deliberate decision the issue asked for.**
`Hud.update` reads `N` below 0.6 m/s with the throttle shut. A write-off is stopped dead —
`onSolidImpact` calls `physics.stop()` precisely so the HUD does not keep reading a speed
for a car pinned against a barrier — so the rule fires and the answer it gives is the right
one: FIA Technical Regulations Art. 12.4 requires a retired car to be left with a neutral
selector reachable from outside so marshals can move it, which is why every broadcast
onboard of a stopped car reads N. `probe:crashrest` §3 asserts it **and asserts that it is
stable over 120 steps** rather than flickering against the gear the car died in — measured
`N` on all four circuits, one distinct label each, against frozen physics gears of 1, 1, 2
and 1. **`src/ui/Hud.ts` was not touched** (held by #17/#35), and does not need to be.

**Proved red three ways.** Removing `holdPose` from the retired branch: **16 of 16 §1
checks red**, with the numbers above. Making `groundLift` return zero: **4 of 4 §2 checks
red at 164.2mm**. Deleting the renderer's call to it: **2 of 4 §2b wiring checks red** while
§2 stayed green, which is the whole reason §2b exists.

`probe:banking`, `probe:carrig`, `probe:rideheight`, `probe:recovery`, `probe:blockage`,
`probe:gearbox` and `validate:world` are all unchanged and passing.

### Handling and input
- **The racing line was graded for a car nobody drives.** `RacingLine.update` received no
  information about the player's car and coloured against the AI's reference car. Green
  promised **9–30% more grip than the car had**. The old probe flew the reference car at a
  line drawn for the reference car and passed — a tautology.
- **The keyboard bug:** a key held for 200ms was only seen by frames that ticked while it
  was down, each ramping by `rate × its own dt`. Steering bought was proportional to
  *(ticks during the press) × frame period*, **not to how long you held it.** One 200ms
  press: **0.447 of lock at 15fps, 0.652 at 144fps.** A 40ms flick was discarded on 40% of
  attempts. Unbiased on average, so it never showed as "too heavy" — it produced *spread*.
  **Fixing the frame rate is what made the car feel like it was swerving.**
  Peak-steer spread across 15–144fps: **47% → 9.3%**.
- Text fields: `preventDefault` on every game key with no check on the event target, so the
  career name field silently ate `w a s d b h c p e l t f`, the digits, space and Enter.

### The handling probes could not fail, and what they said once they could (issue #46)

Four probes covered handling. **All four exited 0 while the player could see the car
swerving, and two of the four had no assertions of any kind** — `probe:handling` and
`probe:drivability` printed tables, and `probe:drivability` printed a summary block with
its own `(want < 0.35)` targets beside numbers that had failed them for as long as anyone
had looked. PROJECT.md §3.2 has said since the beginning that a probe a broken feature
passes is worse than no probe. These were those probes, and that was the finding.

**No number in `src/` moved on this branch.** Everything below was already true on `main`.

- **The three tables that were printed and never checked now carry 11, 8 and 3 assertions.**
  On `main` today: `probe:handling` **7 ok / 4 failed**, `probe:drivability` **4 ok /
  4 failed**, `probe:racingline` **3 failed**. Not one bar was invented for the occasion —
  `probe:drivability`'s eight are verbatim the `want` values it had always printed, and
  `probe:racingline`'s is its own `G_TOLERANCE = 1.02`, which its follow-the-green section
  has always asserted and its driver-in-the-loop section never did.
- **They never touched the player's input path either**, which is why neither could have
  caught #45 and why neither had anything to say about a complaint that is about how the
  car answers a KEY. `scripts/lib/keyboardRig.ts` (§4) is the chain `main.ts` runs, driven
  off a simulated wall clock, and `probe:handling` §4 and §5 are built on it.
- **What one press does, model-free — no driver, no controller, no tuned constant.**
  One press of `d` from straight running at 200 km/h, lateral displacement after 1s / 2s:
  30ms **0.16 / 0.34m**, 50ms **0.48 / 1.00m**, 80ms **1.17 / 2.48m**, 120ms
  **2.53 / 5.51m**, 200ms **6.25 / 14.53m** at 2.69g. A circuit is 12–15m wide.
- **The frame-rate fix is real and it is incomplete.** `probe:framerate` reports 9.3% spread
  on peak steer and that is unchanged and correct. Measured as METRES rather than as units
  of lock, the same press spreads **14.5–16.4% across 15–144fps at 80ms — and a 30ms press
  is worth 0.00m at 15fps and 0.16–0.22m at 30fps and above.** It is deleted, not attenuated:
  the frame ramps the wheel up for the 30ms the key was down and then centres it for the
  remaining 37ms at 5.5 units/s, which is more than the 3.4 units/s ramp bought, so the
  value the physics is handed at the end of the frame is exactly zero. This is mechanism B
  in `probe:framerate`'s own closing note — the zero-order hold — and that note says it is
  inherent to sampling input once per frame. It is now measured in the unit the player feels.
- **THE SWERVE IS IN THE INPUT PATH, NOT IN THE CAR.** `probe:handling` §5 flies one
  pure-pursuit driver with one 250ms reaction time down one lane twice: once through the
  keyboard, once with a continuous wheel. Same driver, same car, same lane, ten seconds of
  settling discarded, peak-to-peak wander over the rest:

  | lane | keyboard | wheel | ratio |
  |---|---|---|---|
  | straight, 120 km/h | 0.84m | 0.09m | 9.4× |
  | straight, 200 km/h | 1.67m | 0.02m | 99× |
  | straight, 280 km/h | 2.89m | 0.06m | 51× |
  | 1.2g corner, 120 km/h | 6.32m | 0.20m | 31× |
  | 2.0g corner, 200 km/h | 7.67m | 0.12m | 62× |
  | 2.6g corner, 280 km/h | **left the road** | 0.62m | — |

  **The mechanism is that a keyboard cannot HOLD a lock.** The wheel winds on at 3.4
  units/s while a key is down and springs back at **5.5 units/s — 62% faster** — the
  instant it is released, so every steady lock between zero and full is a sawtooth, and the
  amplitude of that sawtooth is set by how finely a hand can meter a press. A 2.0g corner at
  200 km/h needs a steady **0.253** of lock; the wheel arm converges on 0.253 and holds
  0.12m of line, and the keyboard arm oscillates between **0.00 and 0.71** at about 8Hz and
  scallops through 7.67m. Every open-loop measurement of the CAR in the same probe run
  passes: nothing spins, turn-in is 0.025–0.083s against a 0.35s bar, the front axle
  saturates first at all four speeds, and a lift at the limit settles at 3.4–3.7° of
  sideslip. The car is fine and the control is not.

  **This table is now HISTORY, and it is reproducible on demand.** The three candidates
  were swept and one ships as the default — see "Three candidates for the swerve" below.
  Everything above is what `STEER_FEEL=classic npm run probe:handling` still prints, to
  the digit; the shipped default reads **0.87 / 1.62 / 2.98 / 0.93 / 0.36 / 4.83** on the
  same six lanes and leaves the road on none of them.
- **The racing line is still over-promising, on three circuits, with a driver in the loop.**
  `probe:racingline`'s section 3 was explicitly *"reported, not asserted"* on the reasonable
  grounds that past the point the colour turns, what happens belongs to the driver. Right
  reasoning, wrong conclusion: it left six circuits sitting above 1.00 with nothing failing.
  It now records **the colour the road was showing at the instant the car ran out of grip**,
  which splits the question cleanly, and asserts only the display's half. Three circuits
  fail: **Monaco 1.042 at s=408m, Zandvoort 1.032 at s=3137m, COTA 1.032 at s=4995m — over
  the limit with the road ahead still reading GREEN.** Spa 1.017, Suzuka 1.012 and
  Interlagos 1.001 also exceed the limit but had already gone amber, so they are reported
  and not asserted. This is the user's *"if the racing line is green how did i go off the
  track?"*, still live, at 2–4% rather than the 9–30% of the original bug.
- **Proved red, twice, both deliberate breaks.**
  (a) A step change in rear grip — `muRear` × 0.80 in `VehiclePhysics` — takes
  `probe:handling` from **7 ok / 4 failed to 3 ok / 8 failed**: section 2 reads
  `REAR (spin)` at all four speeds instead of `front`, section 1 spins, the lift-off check
  goes red, and the *wheel* arm now leaves the corner too. On `probe:drivability` the
  composition of the failures changes to exactly the two that name a rear-grip loss —
  brake pedal margin **0.66 → 0.42** and smallest uncatchable rear slip **17.51° → 6.38°**
  against an 8.85° tyre peak — while the two stability checks that were red on `main` go
  green, because the break moves the limit rather than the damping.
  (b) Restoring the pre-`HoldClock` frame-rate-dependent ramp (`tRight = isDown ? dt : 0`)
  takes the tap's frame-rate spread from **14.9% to 382%** at 200 km/h: a 30ms press moves
  the car **1.09m at 15fps and 0.23m at 144fps**. Note the two breaks fail *different*
  checks — the restored ramp actually makes `no press is silently deleted` pass, because
  over-crediting a low frame rate is the opposite error to deleting the press.

### Three candidates for the swerve, measured — and the one that ships (issue #46)

PR #64 found the mechanism and deliberately stopped there: *"this is a feel decision and
should not be taken unilaterally in the same PR that built the ruler."* This is the
decision, taken from measurements.

**`probe:steeringfeel`** flies **fifteen configurations down seven lanes at three frame
rates each** — 315 closed-loop runs — against the analogue-wheel control arm, and
`probe:handling` §5 gained the seventh lane. **`probe:handling` 7 ok / 4 failed → 10 ok /
1 failed.**

| candidate | corner | strt | ratio | 2.6g | lat90 | full | flick | unwind | chicane | 30ms@15fps |
|---|---|---|---|---|---|---|---|---|---|---|
| **classic** 3.4/5.5/end — what shipped | **off** | 2.89 | 187× | **LEFT** | 83ms | 300 | 367 | **183** | 1.92 | **0.000 dead** |
| 1. return 4.5 | off | 2.95 | 132× | LEFT | 83 | 300 | 367 | 233 | 1.87 | 0.000 dead |
| 1. return 3.4 (symmetric) | 13.90 | 2.92 | 74× | held | 83 | 300 | 367 | 300 | 1.81 | 0.000 dead |
| 1. return 2.8 | off | 3.06 | 53× | LEFT | 83 | 300 | 367 | 367 | 1.77 | 0.000 dead |
| 1. return 2.2 | 3.64 | 3.08 | 5.5× | held | 83 | 300 | 367 | 450 | 2.43 | 0.097 / 182% |
| 2. ramp 2.8 | off | 2.91 | 79× | LEFT | 100 | 350 | 450 | 183 | 1.94 | 0.000 dead |
| 2. ramp 2.2 | off | 3.27 | 111× | LEFT | 117 | 450 | 567 | 183 | 2.85 | 0.000 dead |
| 2. ramp 1.7 | off | 3.33 | 166× | LEFT | 150 | 583 | 733 | 183 | 3.04 | 0.000 dead |
| 3. mean lock | off | 3.06 | 137× | LEFT | 83 | 300 | 383 | 200 | 1.81 | 0.170 / 10.5% |
| 1+3 return 3.4 + mean | 8.77 | 2.90 | 43× | held | 83 | 300 | 383 | 300 | 2.19 | 0.210 / 3.7% |
| **1+3 return 2.8 + mean — SHIPS** | **4.83** | 2.98 | **16×** | **held** | **83** | **300** | **383** | **367** | **1.90** | **0.232 / 4.0%** |
| 1+3 return 2.5 + mean | 3.87 | 2.93 | 7.8× | held | 83 | 300 | 383 | 417 | 2.63 | 0.247 / 3.9% |
| 1+3 return 2.2 + mean (`calm`) | 3.67 | 2.89 | 6.9× | held | 83 | 300 | 383 | 467 | 2.21 | 0.266 / 3.6% |
| 2+3 ramp 2.2 + mean | off | 3.06 | 83× | LEFT | 117 | 467 | 583 | 200 | 2.43 | 0.095 / 16.4% |

Lane numbers are the **worst over 30, 60 and 144fps**; `off` means at least one lane left
the road. `corner`/`strt`/`chicane` are metres peak-to-peak; the milliseconds are through
the input path alone at 200 km/h with no car in the loop.

**The headline, on the lane the issue is written about — the 2.0g corner at 200 km/h:
7.67m of keyboard wander against 0.12m with a wheel becomes 0.36m. The ratio goes 61.9× →
3.0×.** At 30 and 144fps the same lane reads 0.46m and 1.88m against the old feel's 4.54m
and 21.63m.

**Four things the sweep found that were not the expected answers.**

1. **NO SINGLE CANDIDATE IS ENOUGH. Every one of the three, alone, still leaves the road**
   — slowing the return alone at 2.8 departs at 144fps, slowing the ramp makes the closed
   loop worse at every rate, and mean-lock alone departs at 144fps. The default is a
   COMBINATION and the sweep is what says so.
2. **A slow return does not cost the flick.** That was the expected cost and it is wrong:
   pressing the opposite key ramps straight through centre **at the rack rate** and never
   consults the return rate at all, so a full direction change is 367→383ms whether the
   return is 5.5 or 2.2. What a slow return actually costs is **letting go** — unwinding
   from full lock with no key down goes **183ms → 367ms**. That is the real handicap and
   it is the price of the fix.
3. **Slowing the RAMP is the one candidate that is simply worse.** It is charged on every
   input (turn-in 83→150ms, flick 367→733ms), it is the only family that puts the chicane
   through the 2.0m bar on its own, and it did not fix the closed loop at any rate.
4. **A faster machine gets MORE of the sawtooth, not less.** The frame's zero-order hold is
   a low-pass filter whose corner frequency *is* the frame rate, so 144fps is the worst
   column for almost every row (old feel: 4.54m at 30fps, 21.63m at 144). This is why the
   first draft of the sweep — 60fps only — produced a non-monotonic column in which a
   symmetric wheel was *worse* than the asymmetric one, and why every number above is a
   worst-of-three.

**What ships and how it is switched.** `src/input/SteeringFeel.ts` holds six named presets
— one per candidate in isolation, two combinations, and `classic`, which is byte-for-byte
what the game had. **The default is `settled` (rack 3.4, return 2.8, publish mean)** and it
is chosen on a stated rule: it is the slowest unwind that still holds the chicane inside
the 2.0m bar at all three frame rates. `calm` is one step further (return 2.2, better on
every corner, chicane 2.21) and is offered rather than defaulted for exactly that reason.
Settings → Driving → **Keyboard steering**, applied live, persisted, with the measurement
printed under it.

**The mean-lock mechanism, because it is the half that is not obvious.** `InputController`
integrates the wheel's trajectory across the frame as well as stepping it, and publishes
`area / span` instead of the end point. Two closed-form segment shapes (`rampIntegral`),
exact, nothing to tune, and `targetSteer` itself is unchanged — only the number handed
downstream moves. It is what fixes the deleted press: the 30ms press at 15fps ramps the
wheel up for 30ms and centres it for the remaining 37ms, so the value *at the end of the
frame* is exactly zero while the mean over the frame is not.

**Proved the instrument still catches a broken car.** `muRear × 0.80` on `STEER_FEEL=classic`
still gives **3 ok / 8 failed**, exactly as it did before this work. On the new default it
gives **5 ok / 6 failed** — still red, still failing all four vehicle checks and both §5
lane bars; the two that now pass are §4's frame-rate pair, which pass because the fix is
real and which a rear-grip break has no reason to touch.

**Proved the refactor is neutral.** `STEER_FEEL=classic npm run probe:handling` is
**byte-identical to the pre-change baseline on every number** — the six lanes, the fifteen
taps, the frame-rate table — with only the new chicane row and the new §6 added.

**Costs, honestly.** Unwinding from full lock by letting go is 2.0× slower (183→367ms). A
press is worth more than it was — an 80ms press at 200 km/h moves the car 1.57m against
1.15m — because the lock persists longer. `probe:framerate`'s off-line deviation improves
on nine of eleven manoeuvres (worst 9.15m → 7.56m) and gets worse on one already flagged
chaotic (21.41m → 25.92m at 15fps on the held 2Hz slalom). And **the 280 km/h straight does
not move at all** — see §7.

### The gearbox: one key press, locked in fourth for the session (issue #45)
The player pressed a digit while *"trying to run something on the careers page"* and drove
the rest of the session at **205 km/h in 4th of 8 at 15,000 rpm with every shift light red**,
unable to upshift or downshift. Two independent latches, either of which alone was enough:

- **`InputController.gearRequest` was a latch.** `4` set it; only `0` cleared it, and `0`
  appeared in no menu, on no screen and in no help text. The controls overlay listed
  fourteen keys and **not one of them was a gear**.
- **`VehiclePhysics.updateGearbox` read that latch as a LEVEL.** It compared the request
  against the current gear, shifted if they differed, and `return`ed. After the first shift
  `want === this.gear` forever, so it returned having done nothing and **the automatic block
  below it was unreachable for the rest of the session.** The arithmetic matches the
  screenshot exactly: 205 km/h ÷ 0.36m = 158.2 rad/s × 11.42 (4th) × 9.5493 = 17,253 rpm,
  clamped by `:1406` to the 15,000 redline.
- **The route in.** `input.attach` runs once at startup and releases only on teardown, so the
  window `keydown` listener is live on every menu and every career screen. The text-field
  guard above was **intact and was never the hole** — the digit was pressed with a *button*
  focused, where `isTextEntry` correctly returns false. `E` had the same reach and silently
  changed the ERS mode of a session that had not started.
- **Fixed four ways, deliberately overlapping.** The mode is split out of the number
  (`gearMode`, published as 0 unless manual, toggled by `G`, printed as `AUTO`/`MANUAL`
  under the gear disc); the physics reads the request as an **edge** against
  `servedGearRequest`; a **limiter backstop upshifts in BOTH modes**, because `gearRequest`
  is written by the AI, `RaceEngine` and a dozen harnesses as well as by the player; and an
  over-revving downshift is raised to the lowest gear that survives. Keys are now driving
  inputs only while a session is running.
- **Measured, `probe:gearbox`, 25 checks.** On `main`: **gear 4 of 8, 26.42s of 30.00s
  stranded at ≥98.5% of redline**. After: **gear 8, 0.15s stranded**, top speed within
  **0.0%** of a reference car in the same run whose driver never touched a key. A fixed
  "top speed ≥ 300 km/h" bar would have **passed the bug** — the rpm clamp means a car held
  in 4th still crawls to 300.1 km/h in thirty seconds — so the bar is a reference run driven
  in the same process, not a number.
- **Proved it can go red, twice.** Restoring the original early-return latch in
  `VehiclePhysics`: 6 of 25 red, §1 back to *"finished in gear 4, expected 8"* and
  *"26.42s stranded"*. Deleting `input.enabled = inSession` from `main.ts`: 1 red on the
  wiring check — added precisely because everything else in §7 tests the gate and nothing
  tested that anything closes it.

### Race rules
- **No DNF in qualifying.** Qualifying is a *Lap Time Classified Session*; Art. B2.4.3b
  gives the only three ways out of the classification and crashing is on none of them —
  and for the fastest driver in Q1 it could not be, because **they are the 107% reference.**
  `ordersBefore` demoted retired cars in every session, so the live tower was wrong too.
  Art. B4.3.2 (physical assistance → no further part in *that session*) is now modelled,
  and Art. B2.4.3a.v orders the no-time group.
- **The invisible car:** `placeGrid` placed only cars taking part, so the five knocked out
  of Q1 sat where `new CarEntry` leaves them — **world origin, `s` = 0.** At Bahrain that
  is 5.0m off the centreline at s=1948m, inside a 7.5m half-width: the exit of Turn 4.
  Silverstone's origin is 59m off the road, Monaco 10m, Spa 104m — **which is why only
  Bahrain produced the report.** Invisible because the renderer takes height from
  `elevationAt(car.s)` and `s` was 0, putting them 4m under the asphalt.
  Same bug caused the Q2 pit-lane deadlock (none of 15 runners left the pit lane in twelve
  minutes) and "no car scored any time".
- Out-lap track limits: deleting a lap that was never going to be timed.
- **Stewards** built from the Driving Standards Guidelines (2026-02-26 v01) and ISC
  Appendix L: racing room (one car's width), corner priority at the apex (front axle
  alongside the mirror / ahead at the apex), leaving the track and gaining an advantage,
  causing a collision. Give-the-position-back as a remedy. Penalties served in the box with
  the crew standing off, or added at the flag and re-sorting the classification.

### A car stopped on the racing line — the worst bug in the simulation (#28)
`RaceEngine.checkBeached` was the **only** thing in the engine that ever cleared a
stationary car, and it was gated on `Math.abs(lateral) > halfWidth + 2` — the car had to
be **off** the road. A car stopped **on** the road was never retired, never recovered, and
raised no flag naming it. It stood there for the rest of the race, and the AI queued behind
it rather than passing it. `probe:blockage`, one car pinned to the racing line 90s into a
race, watched for 240s against a same-seed control:

| | field laps vs control | still moving at the end |
|---|---|---|
| Monza before | 14 / 42 (33%) | 0 of 16 |
| Monza after | 39 / 42 (**93%**) | **19 of 19** |
| Spa before | 23 / 35 (66%) | 9 of 17 |
| Spa after | 30 / 38 (**79%**) | **19 of 19** |
| Monaco before | 10 / 41 (24%) | 0 of 20 |
| Monaco after | 39 / 41 (**95%**) | **19 of 19** |

**Spa is why this needed three circuits.** Before the fix Spa recovered about half the
field where Monza and Monaco recovered nobody, so a single-circuit check at Spa would have
read as "mostly fine".

The fix is three things, all in the engine:
- `checkStranded` runs one stationary timer wherever the car is standing and applies the
  deadline the site earns — 12s on the racing surface, where the car is "wholly or partly
  blocking the track" (ISC Appendix H Art. 2.5.5b; Art. 26.1b / B1.8.4b), and the existing
  9s in the run-off. `RecoveryOperation` then plans the job from where the car is, which
  for a car on the road neutralises the race until the marshals are done.
- `updateIncidentFlags` finally does what its own comment always claimed — a yellow for a
  car "off the racing surface and slow, **or stationary on it**". The second half had never
  been written. A car on the road now gets **double** waved yellows, a message naming it,
  and counts toward `activeIncidents`, which is what deploys the VSC (Art. 56.1a / B5.12).
- The AI gets a third spatial picture (`AIPerception.blockage`) and an `AVOID` state. A
  stopped car is dropped from `ahead`/`behind` for exactly the reason `sittingOut` is:
  three separate mechanisms were holding station on it, including the neutralisation
  queue-gap rule, so **a field slowed down because somebody stopped then formed up behind
  the car that stopped, at zero.**

**The probe has a second mode because the first one could not tell.** With the AI's
avoidance deleted entirely and only the retirement left, the staged runs still read 93% /
91% / 95% — race control took the car away after twelve seconds and the field never had to
deal with it. The `[held]` mode holds the stationary clock between the "cars behind can see
it" and "race control acts" thresholds, which takes race control out and leaves the drivers
alone with the obstacle, and measures cars a minute past it: **Monza 3.3 with the avoidance
against 2.0 without, Monaco 3.3 against 0.0.** Spa does not discriminate — a car standing
in the braking zone for La Source is collected within seconds — and the probe says so
rather than quoting a rate off a four-second sample.

Side effects, all measured and all in the right direction. `probe:traffic` census over
eleven circuits, five laps, twenty cars: contacts **0.185 → 0.113 per car-lap** (COTA
1.21 → 0.24, Spa 0.62 → 0.53), at a cost of 8% of the overtakes (3040 → 2800).
`probe:attrition` five-lap survivors: **Spa 16.0 → 18.3**, Suzuka 18.7 → 19.3, the rest
20.0/20 unchanged — and the new `STOPPED` column reads **0.0 on all five circuits**, so the
twelve-second timeout retires nobody in ordinary racing. And `probe:hudtext`, failing since
#5, now passes — see the corrected record in §4.

**What this did NOT fix, and it is #26.** At full distance (`probe:racelog`, 52 laps,
Silverstone, F3, P18, medium, 2 seeds) beaching fell **8.50 → 5.50 retirements a race** and
contacts **29.0 → 26.5**, but total retirements went **12.50 → 20.00**, because 10.50 a race
are now classified `Stopped on track`. Every one of them was measured happening **under a
VSC, late in the race, with clear road ahead** — they are the pre-existing neutralised-
limiter stall in §7, which this work found and localised but did not cause and did not fix.
**#26 stays open**, and its stated mechanism ("spinning off slowly and getting stuck") is
now disproved: at full distance the dominant mode is cars stopping dead behind a
neutralisation on an empty track.

### AI
- `alongsideLeft`/`alongsideRight` were computed every step and **read by nothing.**
  Following distance was in *seconds* — at 80m/s a 0.6s preference is 48m and the car needs
  **107m** to stop, so the preference was satisfied all the way into the accident.
- **Contacts 1.263 → 0.130 per car-lap (−90%), and lap times got faster** (mean lap/reference
  1.597 → 1.433, retirements 4.47 → 2.33). Cars were losing more time being knocked about
  than avoidance costs them.
- Honest cost: overtakes roughly halved (632 → 293), though position changes rose 60 → 106.
- The AI pitted early not from worn tyres (0.965 of life) but from a **cheap stop under the
  safety car** — a test asking only `lapsOnSet > 6`.

### Weather
- Real water field over track nodes, per-car per-step surface state, the **fast line moving
  off the dry groove** (rubber under water is slick; the line dries first). Aquaplaning from
  Horne & Dreher NASA TN D-2056. Crossover measured two independent ways, agreeing to 0.008.
- Found a pre-existing bug driving **track temperature to −178°C** (`tempTarget` defined
  relative to the value being updated).

### The pit wall and the pit request — one latch, two bugs (issue #32)
`PitWall.boxRequested` is a **latch**: it stands from the driver's "yes" on the radio until
the stop is served, and `RaceEngine.updatePitWall` mirrors it onto `car.pitRequested` every
physics step. Both bugs came from treating that latch as an *event*, and each one deletes
the driver's instruction in a different direction.

- **The wall cancelling a stop the driver called.** A static conjunction stood in for a
  falling edge — the wall is not asking, AND the driver has a request, AND the wall has no
  compound, AND the driver has picked one — which is exactly the state of a driver who
  pressed PIT and then chose a tyre. **Press PIT, pick hard, and the request was gone 8ms
  later, silently, before the car had moved.** `probe:pitstop` went **6 of 7 red — every
  case that names a compound** — and the one passing case (`want=null, repair='crew'`)
  differed in *both* variables, so the probe proved a stop was being lost and nothing about
  why. Isolated by `diag:pitchoice`, four arms over one drive: compound-only red,
  repair-only green, so the **wing choice was innocent**. Fixed in `84c721c`, diagnostic in
  `f512dc8`. Re-broken deliberately on this branch: the six cases go red with the issue's
  own wording, so the guard is load-bearing.
- **The wall reinstating a stop the driver cancelled.** `requestPit(car, false)` — the PIT
  button, the only way a player waves a stop off — wrote to `car.pitRequested` and to
  nothing else, so the mirror put the request **back on the next step, together with the
  wall's own tyre**, over the choice `clearPitOrder` had just wiped. `main.ts` logged
  *"Stay out, stay out"* on the team channel and **the car pitted anyway, on a compound
  nobody asked for.** `probe:pitstop` §6: request back after **0 steps → never**,
  compound written back **`intermediate` → `null`**, **1 stop → 0**. `requestPit` now
  releases the latch through `PitWall.withdraw()`.

The rule both fixes encode: **the PIT button is the driver's, and the wall does not get to
overrule it in either direction.**

### The retirement takeover, in qualifying (issues #33 and #16)

Asked **five times**, most recently with a screenshot: *"why is this shit back I
thought we said to not have this retirement bullshit??"* The race case had been
moved to the radio in #16; qualifying was **deliberately left on the full-screen
panel** because that panel had just been rewritten against the 2026 regulations
and its content was right. #33 records that as a routing error, and it is the
cleanest example in this project of *correct content in the wrong presentation
surviving four requests to remove it.*

**What went.** `.retire-overlay` — `inset: 0`, a radial scrim to 93% black,
`backdrop-filter: blur(2px)` — plus `clock.paused = true` and
`audio.setSuspended(true)` in the shell behind it. A blurred, world-stopping
takeover 2.6 seconds after an accident the player was in.

**What stayed, and where it went.** Every regulation string, all of it asserted
by `probe:qualiretire`: Art. B4.3.2 ("no further part in qualifying") is now
race control's ruling on the FIA strip *and* on the sheet; the provisional
`P20 of 20 in Q1`, `Q2: Outside the cut`, `Rest of qualifying: No further part`,
`Your best lap: No time set`, the worst-damage report and the corner it happened
at are all on a 360px corner sheet that opens on `Continue` and covers **25% of
a 1280×800 viewport with nothing behind it**. The principal speaks first on the
radio, unchanged.

**Race control no longer calls it a retirement.** `Hud.sayRetirement` gained an
optional `ruling` that overrides the official half only. `CAR 87 RETIRED` is
race language; qualifying is a Lap Time Classified Session and Art. B2.4.3b's
three routes out of the classification do not include an accident. The strip now
reads `CAR 87 — NO FURTHER PART` / `RECOVERED — ART. B4.3.2`. The race path
passes no `ruling` and is byte-for-byte unchanged.

**And the exit stopped truncating the session.** *"even tho I DNF doesn't mean
that the rest weren't able to get a time classification, just make the
simulation up or something, ykwim"* — `Skip to the result` called
`finishSession` on the spot, which ranks `engine.participants` on their best lap
**at that instant**. Measured, 720s Q1 at Bahrain, seed 4001, player retired at
t=90s: **0 of 20 cars had a lap time**, so `rankSegment` fell through to its
no-time ordering and the "classification" was garage release order. Step the
same engine on to the flag instead and **19 of 20 have a time** off 4–5 timed
laps each. `runOutToTheFlag` now steps the live engine, frame-sliced, with
nothing drawn — measured at **27x realtime on a machine at load average 29** —
and the button says what it does: `Run it out to the flag`.

**The engine was never the problem, and that is a finding.** The new
`probe:qualiboard` section (player stops at t=90s, Bahrain and Monaco) **passes
on `main` as written**: `19/19` of the other cars leave the pits and set a lap,
and the driver who stopped is classified P20 rather than deleted. Both halves of
the defect were in `main.ts`.

**A third bug the new probe found on its own: the principal's transmission was
being dropped in qualifying.** `Hud.raiseCard` opens with
`if (this.pitSheetOpen) return` — correctly, because *"the radio stuff is being
covered by the pit options"* is one of the reported complaints the HUD was built
to answer. But `updatePitPrompt` runs **after** `updateRetirement` in the frame
loop, so on the frame the accident was announced the sheet was still open from
the previous one and the radio card never appeared. It shows in qualifying and
not in a race because every practice and qualifying session starts in the garage
(`pitLaneStart`), so `pitDecisionPending` is true from the first frame and the
sheet is genuinely up when a driver goes off on their out-lap.
`retireOnTheRadio` now closes the sheet before anybody speaks, which is also
simply right: a car in the gravel has no stop to make, and
`pitDecisionPending` says so itself the moment `retired` is set.

**Proved red on today's build**, then proved the probe's own first draft was
worthless: the initial version used a fixed 9-second wait for the retirement to
appear, reached the assertions with **1.0s of session time on the clock** and
the panel not yet raised, and its two negatively-phrased checks ("nothing has
taken the screen over", "race control did not call it a retirement") **passed on
the very build it exists to fail.** It now polls the shell's own flag. Against
pristine `main` it reports 12 failures including *"CONTINUE is one of the corner
controls (found: [])"* and *"every car that was still running set a time (0 of
20)"*.

### Career
- **`SessionConfig.playerIndex` was hard-coded to `0`.** `Career.grid()` is the championship
  in *team order*, and a rookie starts at the weakest team, which sorts last — so the player's
  entry was index 19 of 20 and **the human was driving the strongest team's first car under
  that driver's name**, while their own record sat at the back being driven by the AI.
- `TIER_INFO.carPace` was declared, documented as scaling power and downforce, and **read by
  no code at all** — an F3 race was driven in a 1000hp F1 car. Now F2 +13.3%, F3 +19.6%
  against real ~13% and ~19%.
- The **weekend itself was never saved** — qualify, close the tab, gone.
- ~~Intro sequence and podium built. **The user has never seen either**~~ — **routed, and
  the routes are now held by `probe:smoke`'s required set.** See "Built, correct, and
  nobody could get to it" below. This entry stood in this file for months as a note; the
  thing that changed is that it is an assertion.

### The team radio — one radio, one switch, one voice (issue #21)

The audio chain was already the best-measured work on the project; it was
connected to nothing, and `main` had grown a second spoken radio beside it.

- **Two implementations, two off-switches, one `speechSynthesis`.** `Hud.RadioVoice`
  (live, driven from the typewriter, 🔊 pip, `localStorage['f1sim.radioVoice']`) beside
  `TeamRadio` (nothing called it). Both called `cancel()` on the same global singleton,
  so **whichever spoke second killed the other**, and the issue's opening complaint —
  *"whats this bullshit of holding the minimum every sector make the radios legit"* — was
  installed twice over. `RadioVoice` is deleted, the flag key is actively removed at
  startup so a stale value cannot be resurrected, and `GameSettings.teamRadioVoice` on the
  Audio tab is the only control the feature has.
- **The typewriter and the voice were two clocks, and the drift was arithmetic rather
  than jitter.** `Hud.speechRate` was 45 characters a second beside a voice measured at
  **16.8 c/s at rate 1.0** — about 20 c/s at the rate `RadioVoice` used. **2.2× too fast**,
  so a four-turn exchange finished on screen in ~5.7 s against ~12.3 s of speech and the
  card was showing a line the voice had not reached. That is exactly the report:
  *"it seems like whatever the message is saying is so different than what the voice is
  saying."* `speechRate`, `TYPE_TICK_MS` and the 66 ms `setInterval` are gone;
  `Hud.typeExchange` reveals on `RadioEvent.word`, which carries the character range the
  synthesiser says it has uttered. The reveal cannot drift from the voice because it *is*
  the voice.
- **`onstart` is not when the sound starts.** Measured on this machine: `onstart` leads
  the first audible word by **875–1947 ms** on the first utterance of a session and ~105 ms
  after it. `TeamRadio` emits `speech` on the first `boundary` for that reason — and the
  claim is now **asserted** rather than commented. `RadioEvent.atMs` timestamps every
  event; `probe:radio` requires `speech` and the first real `word` to land in the same task
  (bar 50 ms; measured **0 ms**). **Re-broken deliberately** by moving `markSpeechStarted`
  into `onstart`: the check goes red at **383 ms against a 50 ms bar**. Before the
  timestamps, every ordering check stayed green through that break.
- **The event stream is not the audio switch.** `speak()` returned `null` when disabled and
  disabled is the default, so a HUD on this clock would have shown **no card at all**.
  Events now always run; `enabled` governs only audibility. With the voice off the card
  types on the estimated schedule at the same pace — a new `SILENT` section of `probe:radio`
  measures the default configuration end to end (10 word events, all estimated, both turns
  ending, 221 ms between them).
- **The interrupt overlapped two squelches.** A higher-priority `speak` ran `stopActive()`
  → `close()` and then fell through to `pump()` on the same tick, so `RadioChain.open`'s
  `cancelScheduledValues(at)` wiped the key-up swell `close()` had just scheduled — the
  "kssht", which is the single most diagnostic sound in the effect — on the path a driver
  hears most, a safety car cutting off a strategy call. `finish` now arms `pumpNotBefore`
  and every caller is held behind it. Measured: **222 ms** between the interrupted `end`
  and the interrupter's `open`, against a 130 ms tail. The path had never been exercised.
- **ONE VOICE, AND MALE.** Asked twice, the second time with *"like i said"* in front of it.
  Four per-speaker preference lists resolved to **Daniel, Reed, Moira and Rishi** on macOS —
  four people, two of them women. There is one `MALE_VOICES` list now, resolved once,
  cached, shared by all four speakers, separated by rate and pitch alone. **There is no
  fallback**: the obvious one — "first voice not on the known-female list" — is precisely
  how a female voice gets in, and forcing the choice to `pool[0]` on this machine selects
  **Samantha**, with `probe:radio` going red naming her. So either a name off `MALE_VOICES`
  is present or **the radio does not speak and the card types in silence**.
- **The driver's own half is not spoken.** *"you don't need to be saying what the driver
  says ykwim?"* `voiced: false` on every driver turn. Not a skipped turn: it still emits
  `open`/`word`/`end` and still takes as long as saying it would (**1638 ms** for a
  25-character reply), because a card that flicks through one side of a conversation reads
  as a fault.
- **"why is it always the same message" — the pool was of size one.** Not a seeded RNG
  returning the same index and not queue crowding: `radioExchange` was a switch in which
  every branch returned one hard-coded array, with no selection of any kind. Both halves
  are fixed — `pickExchange` **rotates** rather than randomises, because uniform random over
  three variants repeats one time in three — and the pool goes **13 → 41 authored exchanges
  across 13 situations**. The retirement variants are the player's own three registers:
  concern, the call made apologetically, and consolation.
- **`probe:hudtext` now visits every variant** off a fixed seed rather than whichever one
  the cursor was on, and **`retired` is on its list for the first time**. Collapsing that
  pool back to one left the probe entirely green before — which is how the repetition
  survived a probe that already checked eleven other situations. Re-broken: *"radio moment
  retired has 1 authored variant(s) — the pit wall says the same words every time this
  happens."*
- **"i cant see any of the messages bruh" — and `shoot:panels` had been saying so for
  weeks.** Two causes, both fixed. (a) **Nineteen pixels.** A fixed 176px card plus a 45px
  neutralisation cue plus a 30px pit cue plus two 8px gaps is 267 pixels in a 248 pixel
  band, and `fitRail` is permitted to throw the radio card away — so the whole feature
  vanished, silently. `Hud.sizeRadioCard` now sizes the card to the room the rail actually
  has, floored at 104px and capped at the stylesheet's square, with the width following the
  height so it cannot become the letterbox the probe also fails. It also subtracts the
  rail's 28px top mask, which is what was fading the card's first line out and what the
  screenshot showed as "cut off in the corner". (b) **Parked, not destroyed.** The band's
  foot rises by up to a third of the viewport under the mirror cameras, so a card raised in
  a 348px band was measured a moment later in a ~70px one, evicted, and never seen again.
  Restoring it had been tried and withdrawn because the restore and the eviction raced;
  they cannot now, because the height is a *function* of the room the un-evictable children
  leave. **`shoot:panels`: 5 rail failures → 2**, and both remaining ones are pre-existing
  and unrelated (`hud-neutral-cue` clipped by 4px; `.hud-notices` over `mirror[R1]`).
- **The chain is built lazily.** `AudioEngine` was calling `radio.attach()` unconditionally
  — twelve nodes including six biquads, a 2× oversampled WaveShaper, a compressor, a
  looping noise source and an oscillator — in every session of every player, for a feature
  that is off by default. `attach` now takes the context and the bus; the chain is built on
  the first `setEnabled(true)` and kept after that.
- **Also**: `speakExchange` was dead code and is now what the HUD calls for every card;
  `isTransmitting`, `queueLength` and `attached` are deleted; the orphaned "Two seconds
  clears that" comment above a 4000 ms constant and the "limiter's −20 dB threshold" note
  against `LIMIT_THRESHOLD_DB = -8` are corrected.

**What is NOT covered.** **iOS Safari has not been tested.** WebKit requires user activation
before `speechSynthesis.speak()` and every call here is from a `setTimeout`, so
`TeamRadio.primeSpeech()` spends the Settings-toggle click on a silent utterance — written
from WebKit's documented rule and from the same pattern `main.ts` uses to unlock the
`AudioContext`, and run on nothing but Chrome/macOS. If it is wrong, the symptom is a
silent radio with a working card, which is the default experience anyway. Treat it as
unverified.

### Built, correct, and nobody could get to it (issues #13, #38, #25)

Three issues, one defect. **Work that exists, is right, and has no route into it** — the
pattern this file has recorded four separate times (`TIER_INFO.carPace` read by nothing,
`alongsideLeft/Right` computed and read by nothing, `speakExchange` dead, the intro and the
podium). What was different this time is that #62's rebuilt `probe:smoke` made it
*measurable*: it parses the `Screen` union out of `main.ts` itself and enforces a required
set of routes, so "you cannot get there" is a named failure rather than a note.

| | before | now |
|---|---|---|
| Opening titles | first-run only, behind a flag set on the player's very first load | main menu, Settings › This device, and `?intro=1` |
| Podium | only at the foot of a classification you had to drive a full race to reach | the rostrum after every simulated round, before the paddock; still inline on a driven race's classification |
| Press conference | **no import, no screen id, no button** — 540 lines whose only executor was `npm run shoot:people` | offered from the rostrum and from a driven career race's classification |
| Garage | **no import, no screen id, no button** — 236 lines, same | Paddock › Into the garage, with the real `CarStage` standing in the car-shaped hole it was drawn around |

- **Three new screen ids** — `podium`, `presser`, `garage` — because a screen id is what
  lets the probe name the thing that is missing. Measured, `SMOKE_FREE_S=0` at load average
  22: **32 of 32 required routes reached** (from 28 of 28) and **19 of 23 declared screen
  ids** (from 15 of 20). The four not reached are `racing`, `simulating`, `results` and
  `event` — all of which need a running session or a narrative draw, all of which are other
  probes' ground, and the probe prints them as such rather than counting them as holes.
- **The order is the real Sunday.** `Simulate Race` on the career hub used to go from the
  button straight to a narrative event, which is exactly why a player could run a whole
  season and never once have the podium screen built. It now goes chequered flag → rostrum
  → press room → paddock. The press room is **offered rather than imposed** on a driven
  race, because a mandatory screen between the flag and the paddock every round is a screen
  players learn to click through without reading.
- **The press room asks about the race that was just run** — the panel is the top three
  with the player substituted into third when they finished off the rostrum, and the
  questions branch on whether they won, placed or did not see the flag. **What it does not
  do is apply consequences.** `PressAnswer.effects` and `PressConferenceSpec.onAnswer`
  exist and nothing reads them back; a reputation model behind them is the publicist and
  the agencies that §7 records as not built. Routing the room is this work. Furnishing it
  is not, and it is still open.
- **Proved red by removing one route — and read the caveat.** Deleting the `Into the
  garage` button from `showPaddock` and leaving everything else in place, the walk reaches
  the paddock, cannot go on, and prints

  ```
  MISSING   Garage   [Paddock > Into the garage]
  ```

  which is the required-set check firing and naming the route. It is emitted on the same
  branch that pushes `REQUIRED "Garage" is UNREACHABLE: the route [Paddock > Into the
  garage] broke — a button on it is gone` onto the failure list, so observing it means the
  failure was recorded. **What was NOT observed is the failure list itself**, because both
  attempts at the broken run died before the end: the first to `probe:smoke`'s own
  crash-recovery bug at load average 40 (found by this, and fixed — see the bullet below),
  the second to a 120-second navigation timeout at load average **116**, which is a
  statement about the machine and not about the probe. A third attempt was not affordable:
  the box went to load 134–181 with other agents on it, which is §8's over-parallelising
  note happening in real time. **The second half of the proof — that the coverage block
  also reports `screen "garage" is in the required set and the walk never opened it` — is
  therefore read off the code path rather than off a run, and is flagged here as such
  rather than being written up as if it had been measured.**
- **`regress:exit` was reporting a working pause menu as six failures — and the pause menu
  was never the defect.** Full account under issue #25 in §7.
- **The same defect was in `probe:smoke`'s own crash recovery, one level up, and it was
  found by this work rather than reasoned about.** `noteCrash` was one `await boot()`, and
  `boot()` starts by calling `page.url()` and `page.evaluate` on the tab that has just
  died — so when the tab was genuinely gone rather than merely reloading, the recovery
  threw `Attempted to use detached Frame` **from inside the catch block handling the first
  crash**, and the exception escaped every handler. At load average 40 that killed the
  break-verification run *after* it had printed its finding and *before* it could print
  the failure list. The tab is now a factory, so a dead one is replaced by one carrying
  the same viewport, error collectors, dialog handler and storage seed; and the top-level
  catch calls `process.exit` rather than only setting `exitCode`, because the vite server
  and the browser are both created inside `main` and neither is closed on the error path —
  so a crashed run **hung** instead of failing, and had to be killed by hand. **A harness
  that turns a result into a stack trace is the shape of bug this whole branch is about.**

### People (issues #18, #22)
- **Every team principal was "Pit wall".** `Hud.PRINCIPALS` was a table keyed on the ten
  **invented** team ids the game shipped with (`apex`, `scuderia-rosso`, `meridian`);
  career mode replaces the grid with the real 2026 roster (`mclaren`, `ferrari`,
  `red-bull`), so *every lookup a career player could ever make* missed and fell through
  to `?? 'Pit wall'` — behind `principalSvg`, one fixed pictogram whose only per-team
  variable was the disc colour. The user's "why does it seem like the same person as the
  team principal for all the teams" was literally true, in both halves.
- `src/ui/people/` now holds a **parametric look model** (21 fields), a planar face
  painter, a figure, and a cast with a principal for **42 teams** across F1/F2/F3 plus the
  ten legacy ids, which never returns a shared fallback: an id it has never seen still
  produces a specific named person off a hash.
- `probe:people`, **537 checks**. Measured: closest pair on the F1 grid **0.520** against
  a 0.30 bar; closest pair among all 42 **0.183** (ferrari / scuderia-rosso, which are
  authored as analogues) against a 0.12 bar; mean look distance between two random
  strangers **0.835**; **0** near-identical pairs in 44,850; all 3,300 categorical
  combinations produce a drawable path with no `NaN`.
- **Proved it can go red, three ways.** (a) Pointing Mercedes' cast entry at McLaren's
  look overrides: closest F1 pair 0.520 → **0.170**, 1 of 537 failed, exit 1 — note that
  identical authored overrides still leave 0.170 of id-hashed residual, so the 0.30 bar
  sits above what a duplicate can reach. (b) Reverting the two Italian renames: 2 checks
  failed on name uniqueness. (c) Reverting the `StrategyScreen` import: 3 checks failed on
  the wiring section.
- **The two Italian renames in `Cast.ts` were a NAME clash, not a look-distance clash.**
  `ferrari` was `Elena Brambilla`, which is also the legacy `scuderia-rosso` principal;
  `racing-bulls` was `Nino Carbone`, also legacy `brava`. The recovery commit's guess
  offered both possibilities; the probe settles it. The renames were necessary, and the
  look parameters were never touched.
- **Wired.** `StrategyScreen.ts` — on the path to every race — now draws
  `principalDiscSvg`. Measured at the real on-screen size (`.strat-portrait` is 68px
  desktop, 52px phone): apex draws Marco Vidal, brava draws Nino Carbone, visibly two
  people. `Hud.principalOf` re-exports the cast; the string `'Pit wall'` no longer exists
  as a fallback anywhere in `src/`.
- **IP boundary confirmed clean.** Every face in `people/` is SVG generated from a hash of
  an id. There is not one image file, one photograph, or one per-driver look override in
  the module — `grep` for any real driver surname across `src/ui/people/`,
  `PressConference.ts`, `Podium.ts` and `GarageScene.ts` returns nothing. Principals and
  journalists are invented people from invented name pools, deliberately so, because the
  press-conference system puts sentences in their mouths.

### My Team (issue #23, landed on merged `main` 2026-08-03)

The mode the user asked for in their own words: *"You act as both the team owner and the
lead driver. You design the car livery, sign sponsors, choose an engine supplier, hire a
teammate, and build a racing empire from the ground up."* Budget, a cost cap, a factory
with three departments, an engine contract, a second driver, a livery editor, a newsroom.

**The chain is `WorldTeam.upgrades` → `performanceOf` → `specForTeam` →
`getTeam().performance`, and `TeamPerformance` is still the only channel.** `VehicleSpec.ts`
is unmodified and `MyTeam.ts` imports nothing from `physics/` or `render/`. Every
commission moves a field the simulation integrates: one concept project each moved
`clBase 3.128 → 3.231`, `icePowerW 556644 → 570998`, `baseMu 1.6405 → 1.6927`.

**What the merge nearly shipped.** The branch was cut before `ProfileStore` existed and
founded careers by writing straight to `SaveManager`. On merged `main` that saves the
bytes and files them under nobody: **a My Team career would have been absent from
"Continue" and from the driver rack the moment you left the tab.** Re-plumbed by hand
through `ProfileStore.saveCareer`; `main.ts` now makes no direct career write at all.
`shoot:myteam` asserts it end-to-end and **goes red when the one-line textual resolution is
restored** — three failures per viewport, "it was saved to disk and filed under nobody".

**Three probes that could not fail, all found and fixed:**
- **`probe:myteam` invariant 7 passed on a build with the factory disconnected from the
  car.** `startProject` drew its quality-control roll from the world's RNG stream, so a
  developing career and an idle one stopped racing the same championship and the check was
  measuring RNG divergence. With upgrades hard-disabled it read "1.0 constructors' points
  against 0.3" and **passed**. `Career.factoryRng` is now a separate stream: 3.4 vs 0.3
  working, **0.3 vs 0.3 and RED** with the same break. Cost: `probe:news` moved
  5595 → 5525 stories, attributed by reverting that single line and getting 5595 back.
- **`probe:news` checked a superset it hardcoded itself.** `Decision.screen` declared
  `'market'` and `'livery'`; `openDecisions` emitted neither, and both had a button label
  and a route wired up for a decision that could not exist. `DECISION_SCREENS` is now a
  runtime constant the union derives from, the probe reads it instead of restating it, and
  asserts every entry was **actually emitted** across 100 career-years. `'market'` gained
  the team-mate-out-of-contract decision its own doc comment had always promised;
  `'livery'` was deleted.
- **`audit:livery` could not go red.** It commented that its control shot "must be
  identical to `audit:car`'s `day-high--hero`" and never compared them. It now sha256s all
  three views and fails on a difference — proved by repainting the default livery and
  watching all three go red.

**Two real bugs the new coverage found:**
- **The cost cap could be crossed without a confirmation.** `upgradeFacility` charged the
  new level's upkeep to `ledger.facilityUsd` *after* the gate had approved the capital cost
  alone. Approved at $28.0M of headroom, spent $31.4M: **$138.4M against a $135.0M cap.**
  Now gated on `cost + extraUpkeep`.
- **The cap fine left no ledger trace**, and neither it nor the prize was inside any
  measurement window — both land inside `endSeason`, after invariant 2 closes and before
  the ledger is emptied. `Ledger.fineUsd` added, `TeamSeasonReport.closingLedger` carries
  the books across the audit, and the whole season now reconciles including the settle.

**Dead code removed** (the pattern that shipped twice before as `TIER_INFO.carPace` and
`alongsideLeft/Right`): `Career.renameTeam`, no callers; and `engineBreakFeeUsd`, which had
no callers while `signPowerUnit` inlined the same formula **with a different one** —
`Math.max(1, yearsLeft)` against raw `yearsLeft`. The exported copy was the wrong one: it
charges 45% of a season for tearing up a contract that has already expired.

`probe:save` gained a My Team case — 21 named fields and all 8 ledger lines, proved red by
dropping `ledger` from the encoder — and `SaveCodec.backfill` now defends the My Team
block, because one missing ledger line turns the cost cap into `NaN`, which compares false
against every threshold and so stops binding silently rather than throwing.

### Tooling
- **`scripts/` is now typechecked.** `tsconfig.scripts.json` covers `scripts` and `audit`
  as a *separate* project — separate so `@types/node` cannot leak into `src/` and let
  browser code reach for `process`, `fs` and `Buffer` and still compile. Wired into both
  `npm run typecheck` and `npm run build`. **Proved it can fail** rather than assumed: a
  planted `const x: number = "string"` in `scripts/probeGamepad.ts` produced
  `TS2322 … Found 1 error` and a non-zero exit. The gap that let committed merge-conflict
  markers ship inside an audit script is closed; `check:conflicts` is no longer the only
  guard. (Issue #7, closed 2026-08-03.)
- **The `probe:hudtext` diagnosis in this document was wrong.** It was recorded here and in
  issue #5 as "an engine call site that never fires (`RaceEngine.ts` ~2525)". Issue #28
  establishes that the call site is working code: the probe builds a race with
  `playerIndex: 0` and never writes `engine.playerControls`, so its player car parks on the
  grid, the stopped-car bug freezes the whole field, and nothing happens that would file a
  bulletin. **An agent sent to that call site will find nothing wrong.** Confirmation that
  fixing #28 turns the probe green is pending on the #28 branch.
- **Two probes were passing a broken feature, and one of them still would be.** `probe:banking`
  computed the asphalt height as `elevation + bankHeight(lat) + ROAD_SURFACE_Y` and compared it
  against `bankedCarGroundY` — both sides of that comparison are the placement rule, so it was
  green with the banking taken out of the road *mesh*, green with every car placed by the flat
  rule, and green with `bankHeight` stubbed to return zero. It now raycasts the drawn triangles,
  reads the drawn cross-slope against the surveyed banking datum, and forbids the flat rule
  outside `TrackMesh.ts`; all three breaks were performed and all three now report. **When an
  item in §7 is closed, check the probe named in it can still fail** — a fix that lands with a
  tautological probe is a fix nothing is holding.

---

## 7. What is still wrong — the honest list

### In flight right now (agents running)
| Area | What |
|---|---|
| Pit stop | Crew, choreography, release light, the barrier/overshoot bug, crew quality as a career parameter |
| Front end | First-run, profiles, menu, settings, the whole visual language, making cinematics reachable. **It now has automated coverage for the first time — `probe:smoke`, issue #62. Everything merged before that was merged with a probe that had never opened any of it.** |
| Graphics tiers | Three tiers, four switches, an adaptive `auto` and `probe:graphics` **landed** (§6, issue #29); the one-way latch that made `auto` a ratchet **fixed and probed** (§6, issue #73). What remains: the menu's second GL context is still `high`-only (`Renderer.menuQuality`); what shadows actually cost is still unmeasured; the demotion notice names the route to the Video tab in text rather than offering a button, because a button would have to reach into `main.ts`'s screen router — see below |
| Radio/HUD | FIA banner, VSC/SC endings, post-session boards, tower row count, damage panel, tyre block to the right. **The retirement flow, the radio card and per-team principals have all landed — see §6.** |
| Radio content | **The writing pool, issue #61.** #21 took 13 authored exchanges to 41 and built the rotation that stops them repeating, but the pool is still small for a race distance and only the *situations the game already models* have lines at all. *"make the radios legit and smart think of it like a genuine interaction"* is a content model, not a string count |
| Safety car | A real vehicle leading the field; lap counter not advancing; the limiter fighting the player's steering |
| Race authenticity | Sparks/skid marks/brake lights/DRS flaps, remaining divots. **Car jitter (#9) and the world juddering vertically (#54) have both landed — see §6** |
| Crash & penalty rate | Measure it the way the player experiences it, then close whichever gap is real |
| People graphics | Parametric characters and per-team principals **landed** (§6). Press conference and garage are **routed and held by `probe:smoke` — #38 closed**; the press room's answers still have no consequences. Bodies below the neck unfinished |
| Career/story | Sponsors, rivalries, press conferences, the agencies — the rest of the world. **My Team, the facility, the livery editor and the newsroom have landed; see §6.** |

### `probe:smoke` had never opened the front end it claimed to cover — issue #62

The probe whose own header said *"the menus, the career screens and the settings pages had
no automated coverage whatsoever"* reported

```
15 screens walked
PASS — every reachable front-end screen renders and throws nothing.
```

having opened **the first-run driver screen and thirteen helmet colours**.
`grep -icE "setting|driver|career|garage|paddock"` over a full run's log returned **0**.
Every front-end change merged since it was written had counted it as cover, and at its
default depth it spent **over half an hour** re-photographing that one screen in
permutations — `Dark > Gold`, `Plain > Starburst`, and so on to ~197 of them. This is
PROJECT.md §3.2 in its worst form: not a probe that *would* pass a broken feature, a probe
that never looks at the code under test.

**Three causes, and each needed its own fix.**

- **It booted with EMPTY storage**, so it started *inside* the first-run flow rather than on
  the front page. There is one button out of that flow and every other button on it repaints
  a helmet. It is also why `Continue` and `Team HQ` were unreachable in principle — both are
  conditional on a saved career, and an empty browser has none. The walk now makes a driver
  and two careers **through the real buttons**, captures the storage they leave, and restores
  it before every later boot, so the walk starts on the front page of an established install.
- **It de-duplicated screens by NAME** — the label of the button that led to them. Identity
  is now what a screen *is*: the shell's own `Screen` id, plus the headings the page prints,
  plus the SET of buttons on it. The button that was clicked appears nowhere in the key.
  Thirteen colours collapse to one; the eight settings tabs stay eight; the five screens that
  all report `team-hq` (factory, paint shop, engine deal, driver market, preparation) stay
  five, because the heading separates them. **Asserted, not assumed:** the walk clicks all 61
  controls on the driver screen and fails if any one of them reads as a different screen.
- **Nothing said which screens it was supposed to reach**, so reaching none was
  indistinguishable from a pass. There is now a **required set of 28 routes**, each of which
  must open *and land on the screen id and heading it names* — the three `team-hq` rooms
  would otherwise all pass by falling back to the factory.

**Measured on merged `main`, same machine, same software rasteriser:**

| | old | new |
|---|---|---|
| distinct screens | **15**, of which 14 are one screen | **35** |
| screen ids reached, of 20 declared | **2** (`driver-create`, `menu`) | **15** |
| Settings / drivers / career / paddock / Team HQ | none | all |
| wall clock, default depth | **≥33.6 min** — 174 of its ~197 screens in 2015s before it was stopped to free the machine | **11.1 min** (665s, 53 cold boots) |
| wall clock at `SMOKE_DEPTH=1`, the issue's own configuration | 97s for 15 screens | — |
| the part that can go red, alone (`SMOKE_FREE_S=0`) | n/a | **240s** at load average 5 — and **567s** at load 48, which is the honest caveat on every figure in this table |

**Proved it goes red, and the contrast is the artefact.** `buildSettingsScreen` was made to
throw on entry — a screen the old crawl had never opened. The old probe: `15 screens walked`
/ `PASS — every reachable front-end screen renders and throws nothing`, **exit 0, 97s**. The
new probe on the same build: **exit 1**, twelve failures, naming the throw
(`"settings · Settings" threw: uncaught: TypeError`), all eight tabs and the controller page
as `UNREACHABLE`, and `screen "controller" is in the required set and the walk never opened
it`.

**What the walk found now that it looks:** nothing that throws. Thirty-five screens, zero
uncaught exceptions, zero `console.error`, no blank screens. It also **corroborates #38
independently** — `PressConference.ts` and `GarageScene.ts` have no import, no screen id and
no button in `src/main.ts`, so no walk of the front end can reach them — and it prints the
five declared screen ids it does **not** reach and why: `intro` (deliberately skipped,
`regress:career` clicks the real skip button), and `simulating`, `racing`, `results` and
`event`, which all require a session to be launched. That is other probes' ground
(`probe:framing`, `probe:hudtext`, `shoot:panels`, `probe:qualiretire`) and the boundary is
stated rather than silently crossed. **The retirement flow is on the same list**: it needs an
accident, and `probe:qualiretire` stages one.

### Measured, deferred, and still true
- **The tier-demotion notice tells the player the route to the Video tab; it does not offer
  a button.** The renderer owns a self-contained banner (issue #73, §6) that reads *"Set it
  in Menu ▸ Settings ▸ Video"*. That route works today with no wiring, and it was chosen
  over a button because a button has to reach the app shell's screen router, which lives in
  `main.ts` — a file three other issues (#25/#13/#38) were open in at the time. Wiring
  `Renderer.onTierNotice` into the HUD's own notice column, or adding a real button, is a
  small follow-up for whoever owns that file next; the hook exists and assigning to it
  replaces the default presenter entirely.
- **`auto` still cannot get back a tier it has latched without the player asking.** By
  design (a second failure is a verdict, and retrying costs a full-scene shader recompile),
  but it means a device that was *genuinely* throttled twice — a phone that got hot and then
  cooled down — stays reduced for the rest of the page load. A thermal-recovery relax, on
  the model of the resolution scaler's `CEILING_RELAX_S`, is the obvious extension and is
  **not built**. Nobody has measured how often that case actually occurs.
- **The post chain is what makes the picture, and it is also most of the frame.** Issue #29
  established the first half by measurement (§6). The second half is the reason `medium`
  exists and the reason it is not simply switched on for everyone. Paired A/B on an Apple
  M5, toggled inside one session so drift cancels — **but the machine's load average was
  17–52 on ten cores for the whole measurement window, so the absolute milliseconds are
  inflated and only the ratios should be read**:

  | factor, at DESKTOP 1600×1000 @ dpr 2 | Bahrain | Monaco | Spa |
  |---|---|---|---|
  | post chain on ÷ off | 1.5× *(spread 1.2–12.4 — unusable)* | **4.3×** (+21.4ms) | **5.1×** (+22.7ms) |
  | MSAA 4x ÷ 1x on the scene target | 2.7× (+15.7ms) | 2.6× (+17.1ms) | 2.8× (+17.6ms) |
  | shadow cascade re-render | 1.02× (+0.78ms) | 1.01× (+0.21ms) | 1.02× (+0.77ms) |
  | resolution 1.00 ÷ 0.75 | 3.5× | 3.5× | 3.6× |

  Three things follow. **(a)** The post chain is the most expensive item and its cost is very
  nearly linear in pixels — the same factor at phone geometry is 1.7–2.1× rather than
  4.3–5.1× (§6). Any budget derived from a desktop measurement overstates a phone's by about
  three times, which is why `PERF_VIEWPORT` now exists and why the tier decision above was
  taken at phone geometry. **(b)** The shadow cascade's *re-render* is free — 1–2% — so the
  expensive part of shadows is the per-material sampling and the extra shader variant, which
  this factor does not isolate and **nobody has measured**. `high` is defined on the
  assumption that shadows are expensive and **that assumption is currently unbacked.**
  **(c)** Resolution remains the best lever by a distance, which is why the tier only moves
  after the resolution scaler has run out of room.
- **The absolute frame times in this project have not been measured on a quiet machine in a
  long time.** Every run for issue #29 was taken at load average 17–52 on a ten-core box
  with other agents on it. Paired mode cancels drift that is *additive*; contention is
  *multiplicative*, so it inflates both arms and therefore the delta. Ratios survive it.
  **Anyone re-deriving a budget from a number in this document should re-measure at load
  under 8 first.**
- **AI pace ~1.43× reference.** The oldest open item in the project.
- **Stewards under-detect**: 0.4–1.6 penalties per race against a real 1–3. Cause located —
  most contact never reaches a guideline; braking-zone incidents need the subjective limbs of
  the rules, which are deliberately not modelled.
- **Suzuka's crossover draws two roads on top of each other.** Twelve sample points between
  s=2280–2298 and s=4649–4667 have two pieces of asphalt within 0.159m; neither leg of the
  figure-of-eight is a bridge, so a car on the lower one sinks into the upper one. Found by
  `probe:banking` while measuring something else, counted and printed there, issue #37.
- **`car.s` advances further than the car travels, on every circuit, hundreds of times a
  lap. Issue #66.** Found by the new `probe:framerate` "WORLD SMOOTHNESS" section while
  measuring #54, and it is a **simulation-side** discontinuity, not a drawing one: `s` is
  the projection of the car onto the centreline, so how far it may advance for a given
  metre travelled is fixed by geometry — between `plan × (1 − |lateral·κ|)` and
  `plan / (1 − |lateral·κ|)`. Outside that envelope the projection has moved without the
  car moving. Measured over one lap at 50fps: **Monza 602 frames, worst +1.30m at s=620m;
  Red Bull Ring 453, +1.10m; Suzuka 678, +0.89m; Bahrain 595, +0.72m** — every circuit,
  including the flat ones, so it is not the crossover case (#37) and not banking. Anything
  that reads a height, a sector, a gap or a marshal post off `s` inherits it. The probe
  **excludes those frames from both of its columns and prints them** rather than swallowing
  them, so the exclusion is visible and the count is the measurement. **Nobody is on this.**
- **EVERY CAR IS DRAWN LEVEL WITH THE WORLD, on a road that is neither flat nor level.
  Issue #71.** Found by `probe:crashrest` while measuring #58, and it is much the larger
  half of *"the wheels are in the ground"*. `Renderer.syncCars` sets the car root's
  `rotation.y` from the heading and its `rotation.x`/`rotation.z` from the car's own
  accelerations — **and from nothing about the surface under it.** The origin is placed
  correctly (`bankedCarGroundY`; `probe:banking` holds it to 2mm on eleven circuits) and the
  car is then drawn horizontal, so on any gradient the downhill axle goes under the asphalt
  and on any banking the low-side tyre does. It is pure geometry: a 3.6m wheelbase on Spa's
  18.7% gradient buries an axle **1.8 × 0.187 = 337mm**, and a 1.925m track on Zandvoort's
  18° buries a tyre **0.9625 × tan(18°) = 313mm**. Raycast against the drawn triangles at
  the racing offset, worst on the lap, with **no lean at all**: **Monaco 434mm, Zandvoort
  396mm, Spa 341mm, Monza 15mm** (Monza is flat, which is why a Monza-only check would
  report this as fine). This is #3 one level up — the placement rule is right *at the
  origin* and the car is rigid, so being right at one point is not being right.
  **Not fixed here, and the reason is contention rather than difficulty:** the fix is to
  give the car the road's own attitude, and `CameraDirector` carries a line-for-line copy of
  the same two expressions (`rigRoll`/`rigPitch`, with a comment saying the two must not
  disagree), the cockpit eye offset is rotated by them, and `probe:framing` — 56 known
  failures, owned by the HUD work — is laid out against where that puts the halo. It is one
  shared rule in `src/render/CarAttitude.ts` plus one line in each consumer, and it should
  be done with `probe:framing` and `probe:cameras` watching. **Nobody is on this.**
- **The car's pitch is applied about the WORLD x axis, so half the circuit gets it as
  roll.** `Renderer` writes the three angles onto an `Object3D`, whose Euler order is the
  default `'XYZ'` — that is `RX · RY · RZ`, so the yaw is applied *before* the pitch and the
  pitch axis is therefore world-x rather than the car's own lateral axis. A car heading
  along +x receives its braking pitch as pure roll; a car heading along +z receives it
  correctly. `CameraDirector.updateCockpit` builds the identical Euler in the identical
  order, so the camera and the car agree with each other and both are wrong together, which
  is why it has never shown as a mismatch. The correct order is `'YXZ'`. `CarAttitude
  .groundLift` deliberately computes against the rotation that is *actually applied* rather
  than the one that was meant, so #58's fix is exact either way — but the underlying
  ordering is still wrong. Same file boundary and same reviewers as the item above; **filed
  with it under #71. Nobody is on this.**
- **A car standing OFF the road is placed on the road's plane, and mostly that is fine.**
  Checked while working #58 because it was the obvious candidate for "a crashed car is on a
  different placement path", and **it is not**: the run-off strip is swept at
  `elevation + bankHeight`, which is the same surface `bankedCarGroundY` returns, so within
  the laterals a car can actually reach (bounded by `world.containment`) the car origin is
  within **42mm at Monza, 43mm at Spa, 39mm at Monaco and 310mm at Zandvoort** of the
  topmost drawn surface under it — the Zandvoort figure being the banking runout, where
  `bankHeight`'s exponential taper and the mesh's own taper disagree. An earlier sampling of
  this that ignored the containment line reported errors of **1.5m at Spa and 5.1m at
  Monaco**; those laterals are behind the barriers and no car can be there, and the numbers
  are recorded here only so nobody re-derives them and files a bug that is not one.
- **The safety car is drawn from stepped state in all three axes.** `Renderer.syncSafetyCar`
  takes its position from `toWorld(sc.s, sc.lateral)` and its height from
  `bankedCarGroundY(sc.s, sc.lateral)`, none of which is interpolated — so under a
  neutralisation the one vehicle everybody is looking at is the one still juddering. It
  needs a `prevS`/`prevLateral` on `SafetyCar` itself, which is race-side code the
  in-flight safety-car work owns; #54 deliberately did not reach into it.
- **The front wing still reads heavy** — dimensions are regulation-correct; the problem is
  1.35m² of near-black carbon. Livery on the endplate is the honest fix.
- `validate:flags` — safety-car form-up.
- **`probe:weather`: the dry line has no grip advantage.** Two failures — soaked track,
  rubbered line 0.830 against 0.830 beside it; drying track, slicks no faster on the line
  than off it. §6 says the fast line moving off the dry groove is the headline of the
  weather work, and the number that would make a driver move is currently **zero**.
  Verified pre-existing on pristine `main` while working issue #32 — the pit-wall fixes do
  not touch it. **Nobody is on this.**
- **The spoken radio is UNVERIFIED ON iOS SAFARI**, which is a stated target platform.
  WebKit requires user activation before `speechSynthesis.speak()` and every call in
  `TeamRadio` is from a `setTimeout`. `primeSpeech()` spends the Settings-toggle click on a
  silent utterance to unlock the engine — written from WebKit's documented rule and from
  the same pattern `main.ts` uses for the `AudioContext`, and **run on nothing but
  Chrome/macOS**. Nobody has put it on a phone. The failure mode if it is wrong is a silent
  radio with a working card, which is the default configuration anyway, so it is a low-cost
  gap — but it is a gap and it is not a claim.
- **On a platform with no voice on `MALE_VOICES`, the radio does not speak at all.**
  Deliberate — see §6 — but it means the feature is silently unavailable on any platform
  whose male voices are named something not on that list, and nobody has enumerated
  Android's or Windows' full sets on real hardware. `probe:radio` fails loudly with
  `certainty: 'none'` when it happens, and the fix is one line in the list.
- **`diag:pitchoice` is a diagnostic, not a probe.** It prints a table and always exits 0 —
  it cannot fail CI. That is correct for what it is (it answers *which of four arms*, not
  *is this right*), but do not count it as cover. The cover for issue #32 is
  `probe:pitstop` §1 and §6.
- **`probe:framing` now fails 56 assertions, and all 56 are new and true.** Correcting the
  probe's settling time from 20 frames to 2 seconds (§6) opened every onboard lens to where
  it actually sits in play, and that moved the picture:
  - **54 are `MIRROR_PANES` keep-out escapes** in `src/ui/Hud.ts`, on all eleven circuits
    in all three onboard modes. A wider lens carries a pane that sits below centre *up* the
    frame by 1–2 points, and the keep-out rectangles were measured against the narrow lens
    — the same rectangle 7f1f3da widened for banking. The HUD is laid out against it, and
    `shoot:panels` is laid out against the HUD, so this belongs to the HUD owner. **Not a
    reason to move the rectangle without re-running `shoot:panels`.**
  - **1 is a real framing defect:** at Suzuka on 16:9 the cockpit camera's left halo rail
    leaves through the **side** of the frame at 87% of frame height — the "black pipe
    running off the edge of the screen" complaint. Only a settled lens shows it. It is also
    the case that would have been *concealed* had the rails-exit threshold been moved from
    the bottom eighth to the bottom fifth, which is why it was not moved.
  - **1 is a driver's-eye pane reading 22.5% of frame width at Monaco** against a 22.0
    bound. A band question, not a geometry question, but it has not been re-derived.
- **A RACE that the player retires from is still classified from where it stood.
  Issue #56.** Found while fixing the same defect in qualifying (§6) and
  **deliberately not fixed there**. `Continue` on the race corner bar calls `finishSession`
  immediately, which records `engine.standings` for a race that is still being
  run — measured by `probe:qualiretire`, which prints the leader's lap against
  the race distance at that moment and does not assert on it. It is the same
  species of mistake as the qualifying truncation and the user's words cover it
  just as well, but it feeds `recordPlayerRound` and a career championship, so
  changing it is a career-data decision rather than a presentation one. The
  machinery to fix it exists — `Game.runOutToTheFlag` — and `runOutProgress`
  already declines to give a race an early exit, so a race would have to be run
  in full. **Nobody is on this.**
- **`regress:exit` (issue #25): the pause menu works. The harness was the bug, it
  reproduces on demand, and the six failures in the issue are ONE cascade with a
  stopwatch at the bottom of it. Closed.**

  The previous entry here left #25 open against a robustness problem it could not
  reproduce — 16 of 16 twice on a quiet box, one death on warm-up navigation at load 29.
  Five consecutive runs on 2026-08-03 settle it. **The distribution, in order:**

  | run | load average at start | outcome |
  |---|---|---|
  | 1 | 6.4 | **16 of 16** |
  | 2 | 8.9 | **16 of 16** |
  | 3 | 8.7 | died: `TypeError: Cannot read properties of undefined (reading 'screen')` |
  | 4 | 10.8 | died: `Execution context was destroyed, most likely because of a navigation` |
  | 5 | **27.6** | **the issue, verbatim: 6 failures, same wording, same order** |

  **Two independent harness defects, and neither of them is in `src/`.**

  **(a) The dev server was watching the files.** It spawned `npx vite` with the project's
  ordinary configuration, so HMR was live: runs 3 and 4 died because `src/main.ts` was
  edited *while they were running*, which full-reloaded the page under the test. They died
  on an **uncaught exception with no assertion output and exit 1** — indistinguishable, in
  a log, from a genuine regression. That is the mechanism most likely to have produced the
  original report. `probe:smoke` has built its server with `hmr: false, watch: null` since
  #62; this one now does the same, in-process, which also disposes of the free-port dance
  and the "vite did not start in 60s" timeout.

  **(b) Every wait was a fixed sleep sized for a quiet machine.** The probe drives Chrome
  under swiftshader, where a frame of this game costs a large fraction of a second, and a
  keyboard event is consumed on a frame boundary. Run 5 measured **the page painting 1
  frame per ~1.5s**; the harness waited 3000ms after `Escape` and asserted. So the key had
  not been through a frame — **not paused → no overlay → no Resume button → the click found
  nothing → the clock never stopped.** All six failures, from one missed frame. The issue's
  own `0.0666… → 0.0666…` is the same signature one notch worse: 0.0666s is exactly eight
  120Hz steps, i.e. **one frame in the whole sample window.**

  **The fix waits for the state it is about to assert on**, up to a deadline derived from
  the frame period the harness *measures* on the machine it is running on (`40 × frameMs`,
  floored at 8s, capped at 120s). **Nothing was loosened**: every assertion is the
  assertion it always was, and a build where Resume genuinely does not work still fails —
  at the deadline instead of instantly. One check got **stricter**: `paused time really
  stands still` used to sleep 1500ms and compare two clock readings, which at one frame a
  second is *less than one frame*, so it would have passed a build that had stopped
  painting altogether — the exact hang this regression exists to rule out. It now counts
  the frames the page painted during the window and requires several of them beside a
  clock that did not move. **17 assertions, up from 16.** The run also prints the frame
  rate it measured, so a log says what the machine was doing.

  **The pause menu itself was not touched.** `src/ui/PauseMenu.ts` and `Game.setPaused` are
  unmodified on this branch.
- **`probe:qualiretire` needs a quiet machine**, and unlike `regress:exit` it has *not*
  been rebuilt. It boots a dev server and drives Chrome under swiftshader, where the
  simulation runs at roughly a tenth of realtime, so the retirement delay alone is 20–40s
  of wall clock and the whole probe is minutes. **It is a `.mjs` of the same lineage as
  `regress:exit` was, so assume it has the same two defects — a watching dev server and
  fixed sleeps — until somebody looks.** Same for `regress:career`. **Nobody is on this.**
- **`probe:fieldsize`: 23 cars finish 8 laps of a 6-lap race.** Pre-existing on `main`,
  measured against a clean export of `main` on 2026-08-03 and byte-identical there. Not
  previously recorded as known-failing, so it went red without anybody noticing. Issue #44.

### Landed with My Team but deliberately not built
- **Sponsors are not a system.** `commercialIncomePerRound` is the team's baseline revenue
  and is labelled as such in the code. Named brands with minimum fan ratings, signing
  bonuses, contract objectives and their names painted down the car are Layer 4 of
  `docs/CAREER_MODE.md` and do not exist. The user asked for sponsors by name.
- **No press conferences, publicist, marketer, PA, manager or agencies.** The newsroom
  generates true statements about things that happened; nobody speaks to the player.
- **A team-mate's contract can run out and be re-signed, but there is no wider transfer
  negotiation** — no offers to the player, no rival teams bidding for their seat.
- `Career.spendPrepSlot` is reachable now, but the preparation screen is the only place
  the narrative layer is touched by the player.

### The swerving (#46): it is the INPUT PATH, not the gearbox (#45) and not the car
Reported in the same message as #45 — *"additionally, the car is swerving a lot I thought
this was fixed al?"* — so the first job was to find out whether it was one bug or two.
Two candidates were eliminated by measurement; the third is now located and **unfixed**.

- **The frame-rate steering fix has not regressed.** `probe:framerate`, the `catch gentle`
  case, on `main` today: peak steer input **0.6133 .. 0.6704 across 15–144fps, 9.3% spread**,
  off-line deviation at 15fps **0.132m**. §6 records the post-fix numbers as 9.3% and 0.13m.
  Identical. This was the cheapest candidate to check because it is the only one with a
  recorded before/after, and it is clean.
- **The gearbox lock does not cause the swerve.** `probe:gearbox` §9 flies the identical 2Hz
  pulsed slalom, 220 km/h entry, 6.0s, twice — once in automatic, once with `physics.gear`
  pinned to 4 every solver step (constructed directly, so the comparison survives the #45
  fix instead of quietly becoming two identical runs). Automatic **8.685m** lateral, peak
  rear slip 1.39°, peak yaw 0.4385 rad/s. Pinned in 4th: **7.572m**, 1.59°, 0.4797 rad/s —
  a **0.872×** lateral excursion ratio. The stranded car yaws about 9% harder and wanders
  **less**, not more. #45 is not what the player was feeling when they said "swerving".
- **Cars come to a standstill under a VSC on completely clear track.** Found while fixing
  #28 and *not* caused by it. At the #26 configuration (52 laps, Silverstone, F3, medium)
  on pre-#28 `main`, cars spent **3458 car-seconds stationary with nothing within 60m in
  front of them while the race was neutralised**, in a race that was 38% neutralised and
  took 14457 simulated seconds — four hours for a ninety-minute Grand Prix. The simulation
  counted every one of those cars as still running. #28's retirement drops that to **144
  car-seconds, 26% neutralised, 8438s**, because the stalled cars are now recovered — but
  it recovers them by *retiring* them, so what used to be an invisible stall is now 10.5
  retirements a race. **The cause is in the neutralised limiter, not in the recovery**, and
  it belongs with the safety-car work already in flight. Until it is fixed, full-distance
  retirement counts are measuring this and not attrition.
- **`validate:race` Spa spread is a one-seed sample of a high-variance quantity.** The
  assertion is `slowestCarBest - fastestLap < 70s` on seed 20260729, and at Spa that is
  dominated by how much of a five-lap race happens to be neutralised. Measured over five
  seeds: **74.4s mean and 2 of 5 seeds over the bar on pre-#28 `main`, 52.8s and 1 of 5
  after.** An intermediate build of #28 failed it at +118s on the sampled seed while being
  better on the mean; the landed build reads +25.4s. **If it ever goes red, do not raise
  the bar** — make it a distribution.

### The car has no over-wheel winglet, and putting one back needs the corner redesigned
Issue #47 closed by **removing** the 2022-style blade above each front tyre rather than
bolting it on, because it cannot be bolted on: the two upper wishbone legs block
[−29.0°, −7.0°] and [+4.3°, +25.9°] about the hub axis and a support swept through ±24.1°
of lock needs 48.1° of clear angle, at every radius. Full arithmetic in §6. **The car
therefore reads slightly pre-2022 from a three-quarter view**, which is the exact thing
§6's original entry added the winglet to fix — so this is a real regression in fidelity
traded for a real fix in assembly, deliberately and with the numbers written down.

What would actually solve it: a support with an aperture around the wishbone (which is how
the real part does it), which needs a loft primitive that can cut a hole, or a corner where
the upper wishbone's outboard end sits high enough that a support can pass under it. Both
are corner redesigns, not numbers. **Nobody is on this**, and it should not be reattempted
without `probe:carrig`'s steering-lock section watching, because a straight-ahead
measurement passes every version of it that is wrong.
- **The probes can now fail, and what they say is that the CAR is not the problem.** The
  four handling probes all exited 0 while the player could see the car swerving, and two of
  the four had no assertions at all. That is fixed — §6, "The handling probes could not
  fail" — and with the instruments able to go red, every open-loop measurement of the
  vehicle still passes: nothing spins under a steady input, turn-in is 0.025–0.083s against
  a 0.35s bar, the front axle saturates first at 90/150/220/300 km/h, and a lift at the
  limit settles at 3.4–3.7° of sideslip. What fails is the closed loop through the keyboard:
  **the same driver holding the same 2.0g corner at 200 km/h wanders 7.67m through the keys
  and 0.12m with a wheel — 62×** — because the wheel springs back to centre at 5.5 units/s
  against a 3.4 units/s ramp, so a steady mid-corner lock is a 0–0.71 sawtooth where 0.253
  was wanted. **The swerve is the input path.**
- ~~**What has NOT been done about it**~~ — **the three candidates have now been measured
  and one of them ships as the default.** See §6, "Three candidates for the swerve".
  `probe:handling` **7 ok / 4 failed → 10 ok / 1 failed**. **What is still open is the
  remaining failure**, and it is two lanes:
  - **the 280 km/h STRAIGHT, 2.6–3.3m of wander in every one of the fifteen configurations
    swept and at all three frame rates.** No candidate moves it and none of them is close;
    the wheel arm holds 0.02–0.11m on the same lane. This is a floor the return rate, the
    rack rate and the publish mode are all irrelevant to, and it has not been diagnosed.
    The prime suspect is the driver model rather than the car — `LOCK_BAND = 0.015` in
    `keyboardRig.ts` is a deadband the KEYBOARD arm has and the wheel arm does not, and
    0.015 of lock at 280 km/h is worth about 0.38g — but that is a hypothesis and nobody
    has measured it. **Do not touch it without checking the wheel arm first.**
  - **the 2.6g/280 km/h corner at 4.83m.** The old feel left the road here entirely; the
    default now holds it at every frame rate but still wanders more than a car's width.
- ~~**Also still open: the 30ms press that is worth nothing at 15fps.**~~ **Fixed**, by the
  mean-lock half of the default: **0.000m → 0.232m at 15fps**, frame spread **dead/182% →
  4.0%** against a 15% bar, and `probe:framerate`'s edge section goes from *"AND SOME
  PRESSES ARE STILL LOST"* to *"no press is ever lost"*. See §6.
- **Still unexamined:** the track-surface and centreline work that landed 2026-08-03
  (`TrackMesh.ts`, `TrackSpline.ts`) has not been tied to the swerve either way; #54's
  un-interpolated heights are somebody else's branch; and nothing here has been driven on a
  real circuit at race pace in traffic, which is the one thing the user actually does.
- **`probe:racingline` section 3 is now asserted and three circuits fail.** Monaco 1.042 at
  s=408m, Zandvoort 1.032 at s=3137m and COTA 1.032 at s=4995m ask a driver in the loop for
  102–104% of the grip his car has **while the road ahead is still reading GREEN**. Spa
  1.017, Suzuka 1.012 and Interlagos 1.001 also exceed the limit but had already turned
  amber, so the driver was warned; those are reported and not asserted. This is the user's
  *"if the racing line is green how did i go off the track?"* and it is a live bug in
  `src/render/RacingLine.ts` — **deliberately not touched here**, because `src/render/` was
  held by other agents for #54 and #47 while this work was in flight. **Nobody is on it.**

### Reported by the user and not yet addressed
- Lap times of cars that have completed a lap should show even when the player has not
  completed theirs. *"why are you waiting on me to display their times?"*
- The pit crew currently reads as blocky figures — the exact thing the user rejected
  ("forget about the lego people"). **Still here, and deliberately not removed.** The
  `people-graphics` work is 2D SVG for UI screens; the pit crew is 3D, in
  `src/render/CrewFigure.ts` and `src/render/PitCrew.ts`, and was neither touched nor
  photographed by it. Reading the source, the crew limbs are `CapsuleGeometry` and
  chamfered boxes rather than plain boxes, and the one `BoxGeometry` in `PitCrew.ts` is
  the light gantry's head, not a person's — so the line **may** already be stale. Nobody
  has measured it. `probe:pitcrew` and the pit-stop work own that question.
- ~~**`PressConference.ts` and `GarageScene.ts` are unreachable.**~~ **Routed — issue #38,
  closed.** Both have a screen id, a route and a button; `probe:smoke`'s required set holds
  them. See §6. **What #38 asked for and did NOT get: consequences.** The press room's
  `onAnswer` hook and its `effects` lists are display-only — nothing in the career reads an
  answer back. That is the publicist/agencies layer below, and it is still not built.
- **The figures are flat-vector illustrated people, not blocky — but the bodies are
  unfinished.** Heads read well and the eleven principals are plainly eleven people
  (`hud-out/people/desktop-principals.png`), and they survive down to 40px on hair colour,
  skin tone, glasses and beard. Below the neck: podium arms are stick rectangles with no
  elbow and no hand, with the trophy attached to the end; the garage crew are **armless**
  torsos. `phone-presser` (844×390) cuts the question and answer text off below the fold.

---

## 8. Process — what has and has not worked

**Worked:**
- Parallel agents with tight, measured briefs, each owning a file boundary.
- Making agents build a probe *before* fixing, and verifying the probe fails on a broken feature.
- Merging into `main` and re-verifying there rather than trusting branch reports.
- Agents that reverted their own work when the measurement did not support it.

**Did not work, and cost real time:**
- **Over-parallelising.** Nine agents on one machine took load average to 36–218. Every
  headless sweep runs Chrome under software rendering; a 2-minute probe becomes 20+ minutes.
  Agents are not stuck, they are queuing. **Keep concurrency to about 4–5.**

  **Re-learned the hard way on 2026-08-03, three times in one day, and the third time is
  the one that matters.** With seven agents the load average reached **209**, and at that
  point the failure is not slowness — it is that *measurement stops being possible*:
  - `regress:exit` produced **issue #25's exact six failures at load 27.6 and 16/16 at load
    6–9, on the same commit.** A whole issue existed because a probe was measuring the
    machine. Two more of its runs died outright.
  - The `probe:smoke` coverage work lost a 25-minute run and a second run to a 120s
    navigation timeout, so its break test could never print its failure list.
  - The asset-loader probe hit a 200 response with a valid PNG *and* an `onerror`, with a
    manual load of the same URL succeeding seconds later.
  - My own verification of a merge died with `TimeoutError` — on the merge that fixed the
    harness defect causing exactly that.

  **The distinction that costs the time: under load, probes do not fail, they TIME OUT**,
  and a timeout reads like a failure. Any red result taken above load ~8 must be re-run
  before it is believed, and any *green* one is equally suspect if it was a sweep that
  should have taken minutes and returned instantly.

  Also: the machine is not yours alone. On this box the user's own Chrome accounted for
  **84 of 94 Chrome processes** — so agent count is the part you control, not the whole
  of the load. Check `uptime` before quoting any number, and say plainly when a
  measurement was skipped rather than quoting one taken under load.
- **Trusting screenshots.** Repeatedly wrong.
- **Verifying on one circuit.** Repeatedly wrong.
- Truncating a search meant to prove absence (`grep | head -12`, importer on line 13).
- Deleting a branch one commit before its tip.
- **Writing "this does NOT close #N" in a commit message closes #N.** GitHub's keyword
  parser reads `close #35` straight out of a sentence asserting the opposite, and it does
  not care about the negation in front of it. On 2026-08-03 this silently closed **two
  issues that agents had deliberately kept open** and documented at length as unfinished:
  #35 (rival lap times withheld from the live tower — a *different* mechanism from the
  DNF-truncation bug that was fixed) and #22 (people bodies below the neck: podium arms
  are stick rectangles, the garage crew are armless torsos). Both were reopened.
  **Never put `close`, `closes`, `fixed` or `resolves` adjacent to an issue number unless
  you mean it** — say "left open: #35" or "#35 is a separate mechanism" instead. And when
  a merge lands, check `gh issue list --state closed` against what you intended to close;
  an issue wrongly marked done is how a known bug gets forgotten, which is exactly the
  failure this file exists to prevent.
- Completion notifications not always arriving — an agent finished and sat idle while
  counted as in-flight. **Check branch state directly rather than waiting.**
- **Killed agents leave their work on anonymous branches and nobody ever looks.** On
  2026-08-03 a sweep of `git worktree list` found `worktree-agent-aea9aeb446049f08b`
  holding ~4,000 lines of finished people-graphics work (issues #22 and #18) that had
  never been merged, **plus 299 lines of uncommitted probe** in its working tree — the
  single hardest artefact to reconstruct, one `git worktree remove` from being gone.
  A second branch held the full-distance retirement finding that issue #26 is built on.
  Neither branch was named for its work, so `git branch -a` gave no clue either carried
  anything. **Two rules out of this:** name the branch for the work, never
  `worktree-agent-<hash>`; and before removing any worktree, run
  `git status --porcelain` in it and read what comes back.

---

## 9. Reference material on disk

All under `reference/`, **gitignored** (~105MB+):

| Directory | What |
|---|---|
| `monoposto/` | 286 frames of Monoposto gameplay |
| `monoposto_ui/` | 110 frames: opening cinematic, main menu, every settings page |
| `real_f1/` | Real F1 photographs (all external views — **no driver's-eye onboard**) |
| `race_clip/` | (if present) frames from the user's own race recordings |

Regenerate with:
`ffmpeg -i <recording> -vf "fps=2,scale=1280:-1" -q:v 3 reference/<name>/f_%04d.jpg`

**Known gap:** there is no genuine F1 driver's-eye onboard still on disk, so the driver's-eye
camera targets are derived from the car's own geometry rather than measured from a frame.

---

## 10. If you are picking this up cold

1. Read this file. Then `docs/CAREER_MODE.md`.
2. `git log --oneline -30` and `npm run` to see the probe list.
3. Check what is running: `git worktree list` and `git branch -a`.
4. Start the dev server and **look at the game** before changing anything.
5. Before claiming anything is fixed, run the probe that proves it, on merged `main`.
6. The user is testing continuously. Expect screenshots. Treat them as bug reports from a
   reliable reporter, because that is what they have been.

---

## 11. Working practice — issues, branches, PRs, review

At the user's request (*"make sure you keep committed, doing issues, prs, code reviews
everything"*), work is tracked on GitHub rather than only in this file.

**Repo:** https://github.com/Preet37/F1Sim

- **Issues** are the backlog. Every outstanding item in §7 has one. Labels:
  `bug`, `feature`, `rendering`, `simulation`, `ui`, `career`, `qa`, `blocked`.
- **Branches**: one per piece of work, named for the work (`fix-corner-cliff`,
  `pit-stop-choreography`), cut from `main`.
- **Pull requests**: every branch opens a PR that references the issue it closes. The PR
  body states what was measured, before and after, and what was *not* done.
- **Review before merge.** The reviewer's job is not to read every line — it is to check
  the three things that have actually gone wrong on this project:
  1. Was it verified on merged `main`, or only on the branch?
  2. Does a probe exist that a *broken* version of this would fail?
  3. Was any tolerance loosened to make something pass?
- **Merge to `main`** only after the suite passes on the merged tree, not on the branch.

The full probe suite is the CI. There is no hosted CI runner; the equivalent is running
the probes listed in §4 on the merged tree before pushing.

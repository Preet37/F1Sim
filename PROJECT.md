# F1SIM — Project Bible

**Purpose of this file.** This is the context-recovery document. If the conversation is
cleared, or a new session starts with no history, **read this first and read it fully.**
It records what we are building, every decision taken and why, what has been done, what
is still wrong, and what the user has asked for in their own words.

Written by the assistant, for the assistant, at the user's request. Keep it current: when
something lands, move it from "outstanding" to "done" with the measurement that proves it.

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

  **How this is implemented in practice.** Every branded slot — team badge, sponsor decal,
  driver portrait — is an *asset slot* backed by a generated placeholder, loaded from
  `public/brand/<team-id>/` if a file is present and falling back to the generated mark if
  not. That means the user can drop real artwork in themselves at any time and it appears
  immediately, with no code change, and removing the directory returns the game to a
  shippable state. The assistant populates the generated marks and the slots; it does not
  commit reproductions of third-party trademarks into the repository. This is also simply
  the right architecture — it is the same swappable boundary that `src/data/roster/` gives
  the names.
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
docs/CAREER_MODE.md       Career design document
reference/                GITIGNORED. Extracted reference frames (see §9)
```

### The probes — this is the project's immune system

Run `npm run` to list. The important ones:

| Command | What it proves |
|---|---|
| `probe:renderperf` | Real GPU, headful Chrome, actual resolution and frame time |
| `probe:framing` | Halo/mirror/wheel positions in frame, 11 circuits × 2 aspects |
| `probe:carrig` | Every car part attached; wheels at y=0; nothing floating |
| `probe:shoulders` | Shoulder geometry, divot count by raycast |
| `probe:traffic` | Contacts per car-lap |
| `probe:stewards` | Staged incident scenarios + verdict distribution |
| `probe:strategy` | Strategist honesty; plan reaching the car |
| `probe:qualiboard` | Knockout qualifying: board and grid agree |
| `probe:identity` | Player's name reaches car, standings, save |
| `probe:season` | 100 career-years |
| `validate:world` | Nothing built on the racing surface |
| `audit:circuits` | Photographs 11 circuits, 7 camera modes each |
| `shoot:panels` | Measures HUD boxes; fails on overlap |
| `probe:people` | 42 principals: all named, all unique, none within a look distance |
| `shoot:people` | Contact sheet of the cast, plus the presser/podium/garage scenes |

**Known-failing, all pre-existing and documented:**
- `probe:hudtext` — "no team-owned bulletin was filed in a 20-minute race". **Do not go to
  `RaceEngine.ts` ~2525** — the earlier "call site that never fires" diagnosis is wrong and
  that code works. See §6 "Tooling" and issue #28: the probe never writes
  `engine.playerControls`, so its own car parks and the stopped-car bug freezes the field.
- `validate:flags` — safety-car form-up, three failures, stable numbers.
- `shoot:panels` — **5 rail + 2 mirror layout failures** (radio card off screen at desktop
  and portrait; `hud-neutral-cue` clipped by 4px; `.hud-notices` over `mirror[R1]` by
  26×72px on phone/pit-choice/cockpit). Confirmed pre-existing on `main` as of 2026-08-03
  by running it with an unrelated branch's changes stashed and getting identical output.

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

### The world
- **Corner "cliffs":** the ground beyond every circuit was one flat quad at y = −0.62
  while circuits climb to 58m at Spa. The vertical skirt was as tall as the circuit was
  elevated — mean 4.1m at Bahrain, 27.2m at Spa, 58.6m worst. Now 0.97m everywhere.
  New `Terrain.ts` samples the circuit's own elevation so ground and road meet by
  construction.
- **Banking** was applied with no limit on lateral distance: Zandvoort's run-off edge was
  drawn **7.4m above** the racing surface.
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
  reporting device at all.**
- Mirror housing was lofted **widest 30mm in front of the glass**. Pane 74×32mm →
  **150×46mm** (150 is the FIA minimum). Then the cap fix revealed the housing's rear cap
  was a solid disc the size of the aperture — once drawn, **it was the mirror.**
- **Driver's-eye view** added, held to `probe:framing` like the others.
- Reverse-camera jitter: slip angle measured against the car's nose, so a reversing car
  sat on ±π and the sign flipped every time the wheel moved — a **66° lurch per frame.**

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

### Career
- **`SessionConfig.playerIndex` was hard-coded to `0`.** `Career.grid()` is the championship
  in *team order*, and a rookie starts at the weakest team, which sorts last — so the player's
  entry was index 19 of 20 and **the human was driving the strongest team's first car under
  that driver's name**, while their own record sat at the back being driven by the AI.
- `TIER_INFO.carPace` was declared, documented as scaling power and downforce, and **read by
  no code at all** — an F3 race was driven in a 1000hp F1 car. Now F2 +13.3%, F3 +19.6%
  against real ~13% and ~19%.
- The **weekend itself was never saved** — qualify, close the tab, gone.
- Intro sequence and podium built. **The user has never seen either**: the intro is
  first-run-only via a flag set on their very first load, and the podium only fires after
  finishing a career *race*.

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

---

## 7. What is still wrong — the honest list

### In flight right now (agents running)
| Area | What |
|---|---|
| Pit stop | Crew, choreography, release light, the barrier/overshoot bug, crew quality as a career parameter |
| Front end | First-run, profiles, menu, settings, the whole visual language, making cinematics reachable |
| Radio/HUD | Square typewriter radio card, FIA banner, retirement flow, VSC/SC endings, post-session boards, tower row count, damage panel, tyre block to the right, per-team principals |
| Safety car | A real vehicle leading the field; lap counter not advancing; the limiter fighting the player's steering |
| Race authenticity | Car jitter (no interpolation between physics steps), sparks/skid marks/brake lights/DRS flaps, remaining divots, `carGroundY` banking |
| Crash & penalty rate | Measure it the way the player experiences it, then close whichever gap is real |
| People graphics | Parametric characters and per-team principals **landed** (§6). Press conference and garage built but **unreachable — #38**. Bodies below the neck unfinished |
| Radio audio | Radio-processed synthesised speech, shared clock with the typewriter |
| Career/story | My Team, facility, livery editor, press/morale/sponsors, rivalries, the full world |

### Measured, deferred, and still true
- **AI pace ~1.43× reference.** The oldest open item in the project.
- **Stewards under-detect**: 0.4–1.6 penalties per race against a real 1–3. Cause located —
  most contact never reaches a guideline; braking-zone incidents need the subjective limbs of
  the rules, which are deliberately not modelled.
- **`carGroundY` ignores banking**: 1.63m of error at Zandvoort, 0.42m at Spa. Cars float or
  sink through the road there.
- **10 nodes where the centreline turns tighter than the road is wide.** COTA s=3431 has a
  6.3m radius against a 7.5m half-width — the asphalt folds over itself. Fixing it means
  narrowing the road, which moves the speed solver, `validate:limits` and `probe:racingline`.
- **The front wing still reads heavy** — dimensions are regulation-correct; the problem is
  1.35m² of near-black carbon. Livery on the endplate is the honest fix.
- `probe:hudtext` — the team channel never files a bulletin in a real race. **Real bug**,
  but the *diagnosis* recorded here was wrong — see the correction in §6 under "Tooling".
- `validate:flags` — safety-car form-up.

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
- **`PressConference.ts` and `GarageScene.ts` are unreachable.** ~800 lines imported by
  `audit/people.ts` and by nothing in `src/`. `src/main.ts` has no screen id, no route and
  no key for either; the only way any human has seen them is `npm run shoot:people`. This
  is §6's intro-and-podium failure repeating. **Issue #38.**
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
- **Trusting screenshots.** Repeatedly wrong.
- **Verifying on one circuit.** Repeatedly wrong.
- Truncating a search meant to prove absence (`grep | head -12`, importer on line 13).
- Deleting a branch one commit before its tip.
- Completion notifications not always arriving — an agent finished and sat idle while
  counted as in-flight. **Check branch state directly rather than waiting.**

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

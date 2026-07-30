# F1Sim

A full-simulation Formula 1 career game that runs in the browser — desktop and iOS
Safari, one codebase, no install. Eleven circuits, twenty cars, a physics model
validated against published F1 performance figures, and a career from Formula 3 to a
world championship.

```bash
npm install
npm run dev          # http://localhost:5173
npm run validate     # tracks, physics and race simulation
```

Deep link straight into a session, which is also how the sim is verified:

```
/?circuit=monza&session=race&laps=5
/?circuit=silverstone&session=practice&duration=600
```

**Controls** — `W`/`A`/`S`/`D` or arrows, `Shift` for DRS, `E` cycles ERS mode,
`C` cycles camera, `L` requests a pit stop, `P` pauses, `1`–`8` for manual gears.
Gamepads work through the standard mapping. On a phone, the left half of the screen
is a floating steering joystick and the right side has throttle and brake pads;
tilt steering is available in Settings (iOS requires the permission prompt, so it is
behind a button rather than triggered on load).

---

## Presentation

Everything below is generated at runtime. There are no audio files, no texture
files, and no models — the entire download is code.

**Audio** (`src/audio/AudioEngine.ts`). The engine's firing frequency is computed
from the crankshaft speed the physics reports, so it tracks load and rpm exactly
rather than crossfading between recorded samples. Layers: harmonic engine voice with
throttle-dependent timbre, turbo spool, wastegate flutter, overrun crackle on a
closed throttle, rev-limiter chop, tyre squeal driven by contact-patch slip speed,
surface scrub, aero noise rising with v², and the nearest five rivals as
distance-attenuated, Doppler-shifted voices.

**Particles** (`src/render/ParticleSystem.ts`). Simulated entirely on the GPU: each
particle stores its birth state and the vertex shader evaluates a closed-form
trajectory with exponential drag, so the CPU touches a particle once, when it spawns.
Tyre smoke, dust, gravel, rain spray, sparks and exhaust flame.

**Skid marks** (`src/render/SkidMarks.ts`). A preallocated ring of quads stamped when
a tyre slips, drawn in one call, never rebuilt.

**Surface detail** (`src/render/SurfaceDetail.ts`). World-XZ projected grain, bump
and roughness break-up injected into the standard material, so it keeps real shadows,
the environment probe and fog. Two incommensurate tiling scales, so the texture's
repeat period is never visible down a straight.

**Sky** (`src/render/Renderer.ts`). A five-octave fbm cloud deck projected onto a
flat plane above the viewer, so the clouds foreshorten toward the horizon the way a
real deck does. Domain-warped for wispy shapes, shaded by the density gradient
toward the sun, and its coverage follows the weather — a wet race is genuinely
overcast.

**Racing line** (`src/render/RacingLine.ts`). Drawn from the same `lineOffset` and
`targetSpeed` the AI drives on, and coloured green-amber-red by whether the car is
arriving faster than each point ahead will take, given the road left to brake in.

**Post-processing** (`src/render/PostFX.ts`). Bloom before tone mapping — the order
matters, since scattering is proportional to real radiance and a tone-mapped spark is
indistinguishable from white bodywork. Then radial speed blur, chromatic aberration
and vignette in one pass. Disabled entirely on the low-quality tier.

Effects read quantities the physics already computes for its own purposes, so they
cannot disagree with the handling: the smoke that appears when you lock a front is
drawn from the same slip speed that is costing you braking distance.

---

## What makes it a simulation

The claim worth defending is that nothing important is faked. Specifically:

**Grip is load-sensitive, and load comes from downforce.** Cornering force is
`mu * (m*g + cl*v^2)`, so the car is planted at speed and nervous when slow. That
single term is why an F1 car takes a 500m-radius kink flat out and why the last
100 km/h of a braking zone is where it runs out of grip.

**The friction circle is enforced per axle.** You cannot brake at the limit and
turn at the limit at the same time. Front and rear slip angles are independent, so
understeer and oversteer are emergent states rather than flags.

**Exceeding the grip budget costs grip.** A sliding tyre delivers about 78% of
peak, which is why locking the fronts costs 8.8m of stopping distance in this model,
and why feeding the throttle in off the line (2.66s to 100 km/h) beats flooring it
(3.26s). Brake and throttle modulation are skills the sim actually rewards.

**Tyres have three separate degradation mechanisms**, because collapsing them into
one "tyre life" bar removes the strategy: temperature (responds within a corner,
peaks inside a window, falls away on both sides), wear (irreversible, nearly flat
to 40% then an exponential cliff), and surface condition (flat spots and graining).

**The AI drives the same car through the same physics.** Five inputs — throttle,
brake, steer, DRS, ERS — no grip bonus, no rubber-banding, no scripted lap times.
When an AI car is quicker it is because its driver's skill parameters let it commit
closer to the limit, and it computes that limit from its own live grip and
downforce. A car on worn tyres in dirty air on a damp track slows down because the
force balance says so, not because a difficulty slider said so.

**Physics runs at a fixed 120Hz** on an accumulator, decoupled from rendering. A
lap time is therefore identical on a 60Hz phone and a 144Hz monitor.

---

## Verification

Three harnesses, run by `npm run validate`. They exist because almost every
significant bug in this project was found by one of them rather than by playing.

### `validate:tracks`

Circuits are authored as segment lists — "1.1km straight, then a 60-degree right at
28m radius" — because corner *radius* determines corner speed and corner speed
determines lap time. Authoring coordinates by eye gets the shape roughly right and
the radii arbitrarily wrong.

An authored loop does not meet itself. Closing it exploits an asymmetry in what the
errors cost: a corner's radius sets its speed, but its *angle* does not — a 70 and
an 80 degree corner at the same radius are taken at the same speed. So closure error
is absorbed primarily by redistributing corner angles, secondarily by straight
lengths, and only as a last resort by radii. Because changing one angle rotates the
whole downstream chain, that is nonlinear, and it is solved by damped Gauss-Newton
against four constraints: endpoint x, endpoint z, total arclength, and total turn
(360° × turning number, which is **0** for Suzuka's figure-eight).

Result across all eleven circuits: exact closure, exact lap length, corner radii
within 1% of authored, and solved lap times within 8.1% of real pole times
(RMS 4.5%) on a single set of physical parameters.

```
CIRCUIT         OFFIC  BUILT   TURN  CLOSE  dANG  dSTR  dRAD     SOLVED      POLE
Monza            5793   5792    360   0.00   21°   11%    0%   1:19.630  1:19.000
Spa              7004   7002    360   0.00   10°   21%    0%   1:46.147  1:43.600
Suzuka           5807   5805     -5   0.00   37°   63%    1%   1:29.390  1:28.200
```

The racing line and the speed profile are solved, not authored. Braking points are a
*consequence* of the car's grip and downforce — change the aero package and the whole
profile moves.

### `validate:physics`

Runs the vehicle model through standard performance tests against published figures:
0–100 in 2.66s, 0–200 in 4.95s, top speed 343 km/h in Monza trim and 292 in Monaco
trim, peak braking 5.5g, lateral 2.3g at 100 km/h rising to 4.6g at 300, DRS worth
20 km/h. It also asserts that locking up costs stopping distance, that a flat spot
is applied, and that `step()` allocates ~3 bytes per call.

Twenty cars at realtime cost about 0.7ms per 60fps frame.

### `validate:race`

Runs whole races headlessly and asks whether the result is *racing*: does the field
finish, are lap times and the spread across the field credible, do overtakes and pit
stops happen, does the finishing order correlate with car and driver quality rather
than with grid position.

---

## Bugs these harnesses caught

Documented because each one is a trap worth knowing about, and each is commented at
its fix site.

| Bug | Symptom |
|---|---|
| Body-frame velocity integrated without the yaw-rate coupling terms | Velocity locked to the chassis, so the car could not slide; measured lateral acceleration 0.01g where it should have been 2.2g |
| `frictionCircleScale` returned a shared module-level scratch object to two callers | Front axle silently used the rear axle's scale factors |
| Lock-up flat-spotting applied per physics step instead of per second | Runaway: damage lowered grip, lower grip raised the lock-up ratio; front grip collapsed to 0.19 in 1.5s |
| AI braking scan window derived from the braking distance for the corner it was *already in* — zero on a straight | Looked 40m ahead while needing 99m; drove into the gravel every lap |
| Braking scan targeted the raw reference profile while the car held a margin-reduced speed | Braked for a speed 19% too high, arrived too fast, spun |
| Pure pursuit drives the chord, not the arc | Tighter path than the racing line through long corners; understeered wide |
| Cross-track error compared current position against the line's offset 40m ahead | Lead/lag error: turned in early and sat permanently inside the line |
| `requiredBrakingDistance` assumed full longitudinal grip | Braked late, then could not slow while already cornering |
| Tyre thermal model had almost no inertia | Sustained high-g cornering cooked the fronts 0.89 → 0.71 grip in 1.5s |
| Racing line by Laplacian smoothing | Minimises a quantity that shrinks when the path gets *shorter*, so it produced the shortest path and hugged the inside of long corners at a **tighter** radius than the centreline |
| `TrackSpline`'s "left normal" actually points right | Kerbs rendered and detected on the wrong side |
| Barriers rebuilt position from a stale along-track value | Any car touching a barrier was pinned there for the session |
| `targetPitLap` is -1 when no stops remain, and `lap >= -1` is always true | Every car pitted every lap — thousands of stops per race |
| A car retired by damage was never marked recovered | Held a yellow forever, safety car never came in, every lap ran at SC speed |
| Contact damage rewrote the spec and compounded unbounded | Cars left with no downforce after a few nudges |
| 20 cars × ~13 meshes | 271 draw calls; no phone renders that at 60fps |
| Chase camera smoothed position in world space toward a moving target | Steady-state lag of velocity/rate — 8m at 57 m/s, so the car shrank as it accelerated |
| `tractionLimitFraction` used the power-limited force while the gearbox is torque-limited at low speed | Overestimated available force 2.7×, making a modulated launch *slower* than flooring it |

---

## Known limitations

Stated plainly rather than buried.

**AI pace.** The AI runs about 16% off the solved theoretical reference, which is
slower than real race pace. The constraint is line-tracking accuracy, not the vehicle
model — `scripts/tuneAI.ts` sweeps how close the field runs to its computed limit and
finds the fastest setting at which it reliably stays on the road. At the shipped
setting, 6 of 11 circuits are completely clean over multiple laps and the rest see
occasional excursions, mostly at Monaco's hairpin and Suzuka's esses. Improving this
means a better path-tracking controller, which is the single highest-value piece of
remaining work.

**Circuit layouts are reconstructions, not survey data.** Corner sequence, corner
character, radius class, straight lengths and elevation profiles are faithful; the
geometry is not a GPS trace. No licensed circuit data is used, and the teams and
drivers are fictional.

**Braking is at the optimistic end** of published figures (300–0 in about 2.9s and
95m here, versus roughly 4s and 130m quoted) because peak brake force is applied
instantly with no pedal ramp.

**On a device too slow to keep up**, the fixed-step loop caps at 8 physics steps per
frame and drops the backlog, so the game runs in slow motion rather than skipping
simulation. Lap times stay correct because they are measured in simulation time.

**Qualifying is a single session**, not the Q1/Q2/Q3 elimination format.

**`npm run validate` currently fails.** Bahrain and Jeddah finish with zero
classified cars, Monaco's AI laps at 191% of the solved reference, and a 30-lap race
records no pit stops at all. These are simulation-layer faults, not rendering ones,
and they are the largest outstanding problem in the project — the presentation is
now well ahead of the racing it presents.

**Damage is repairable only in part.** A pit stop replaces the nose and the
bodywork the crew can reach; floor, suspension and power-unit damage stays with the
car for the rest of the race, because those are not parts anyone changes in three
seconds. A damaged nose adds 9-14s to the stop.

**Circuit geometry is still a reconstruction.** Corner sequence, character and
elevation are faithful; the geometry is not a survey trace, so a lap does not
overlay a real satellite image. Making the layouts genuinely accurate is a data
task, not a rendering one.

**Sessions still start on the grid or on track**, not from the garage down the pit
lane. Pit-lane procedure exists in the sim (speed limiter, box service, penalties)
but is not used for the session start.

**Sponsor text on the trackside hoardings renders mirrored.** The cause is not the
ribbon's UVs: negating them provably reaches the browser and changes nothing on
screen, so the flip happens elsewhere in that mesh's construction. Not yet found.

---

## Layout

```
src/
  core/         fixed-step clock, allocation-free math, seeded RNG
  data/         circuits (segment DSL), teams, drivers, tyre compounds
  track/        spline, solved racing line, solved speed profile
  physics/      slip-angle vehicle model, tyre thermal and wear model
  ai/           driver FSM: LINE_FOLLOWER / OVERTAKE / DEFEND / FOLLOW / RECOVER / PIT
  race/         race engine, race control, car entries, timing, component damage
  audio/        procedural engine, tyre, aero and rival-car synthesis (no audio files)
  render/       procedural track and car meshes, camera director, dynamic resolution
                GPU particles, skid marks, surface detail, post-processing chain
  input/        unified keyboard / gamepad / touch / tilt
  ui/           telemetry HUD, wheel display, damage panel, sector board, paddock
  career/       F3→F1 ladder, JSON narrative events, versioned saves
scripts/        validation and calibration harnesses
```

The simulation layer has no dependency on Three.js or the DOM. That is what lets the
validation scripts run entire race weekends in a few seconds with no browser, which
is the only practical way to test whether the AI can actually race.

## Licence

Code is provided as-is for personal use. Teams, drivers and circuit geometry are
original work; no Formula 1 or circuit-owner intellectual property is included.

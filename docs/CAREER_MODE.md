# Career mode — design

The game already has a race weekend that works: practice, a knockout qualifying,
a race with strategy, damage, flags, recovery and an AI field, all validated by
about twenty-five headless probes. This document describes the layer above it —
a career that runs from a Formula 3 rookie season to a Formula 1 world
championship, and a My Team mode where the player owns the outfit as well as
driving for it.

It is written before the code because the single thing that decides whether this
is worth building is **whether the management decisions reach the car**, and that
is an architecture question, not a UI question. Section 2 is therefore the most
important section in this document. Everything else is downstream of it.

---

## 0. Scope, and where the real world stops

### Names yes, marks no

The project's original rule was that nothing real appeared anywhere. That rule
has been relaxed by the person whose project it is, but only along one axis, and
the line is worth stating precisely because it is easy to drift across.

**Used, because it was asked for:** the real 2026 Formula 1 grid — eleven teams,
twenty-two drivers, their nationalities and car numbers; the real power-unit
manufacturers; the real FIA Formula 2 and Formula 3 ladders with their real teams
and drivers. Sources and provenance are in section 11.

**Not used, and not to be added later:**

- **No team logos, badges or wordmarks.** Naming a team is not the same act as
  reproducing its trademark, and an approximated badge would be both infringing
  and visibly fake. Teams are identified the way a broadcast timing screen
  identifies them: by their **real colours**, plus the **generated geometric team
  marks** that already exist on `main` (`t-mark` in `src/ui/TimingRow.ts`). That
  system is good; it is kept and keyed to the real teams.
- **No real sponsor artwork on the cars, and no real sponsors in the sponsorship
  system.** The brand set painted by `src/render/Livery.ts` (`VERTIGO`,
  `GOLDMINE`, `NEBULA`, `LUMINARE`, …) stays fictional, and the sponsor mechanic
  in section 6 signs fictional brands. Reproducing a real sponsor's wordmark down
  the side of a car is exactly the thing that was ruled out.
- **No likenesses.** Names and attributes only.

### One module, one boundary

All real-world data lives in **`src/data/roster/`** and nowhere else:

```
src/data/roster/
  f1-2026.ts        11 teams, 22 drivers, colours, numbers, nationalities
  f2-2026.ts        11 teams, 22 drivers
  f3-2026.ts        10 teams, 20 drivers
  powerUnits.ts     5 manufacturers
  index.ts          the only export surface: REAL_ROSTER
```

Nothing outside that directory names a real team or driver. Every system consumes
the roster through the generic `Team` / `Driver` / `PowerUnit` interfaces, so
replacing the whole thing with a fictional grid is a matter of writing a second
module with the same exports and changing one import — a data edit, not a
refactor. This matters: the real names are the one thing that would have to go if
this were ever published.

`src/data/teams.ts` keeps its existing fictional grid as the fallback roster and
as the grid every existing probe measures against, so nothing already validated
moves.

### What "done" means for each layer

| Layer | Contents | Target |
|---|---|---|
| 1 | Persistence | Complete and verified |
| 2 | Season and progression spine | Complete and verified |
| 3 | My Team | As far as is coherent |
| 4 | Narrative systems | As far as is coherent |

A career that saves, runs a season and promotes the player is worth more than a
complete set of stub screens. Layers 3 and 4 stop at a boundary that is whole,
not half of everything.

---

## 1. What is actually broken today

Career mode is not absent. `src/career/CareerEngine.ts` (769 lines) and
`src/career/SaveManager.ts` (330 lines) exist, `src/main.ts` has a career hub, a
create screen, a standings screen and a narrative-event screen, and a driven race
already feeds `recordResult`. What is wrong is more interesting than what is
missing.

**1. `TIER_INFO.carPace` is dead.** It is declared at `CareerEngine.ts:23-29`
with the comment *"carPace scales the vehicle spec's power and downforce for the
tier: an F3 car is meaningfully slower than an F1 car, so lap times differ
correctly."* Nothing reads it. Grep the whole repository: the only other
`carPace` is an unrelated local inside `simulateRace`. **An F3 race and an F1
race are driven in the same 1000-horsepower Formula 1 car.** The ladder has no
rungs.

**2. `carDevelopment` only affects races the player skips.** It is read at
`CareerEngine.ts:603`, inside `simulateRace` — the paper model. The driven race
goes through `CarEntry.ts:415`, `applySetup(specForTeam(team.performance))`,
which never sees it. Develop your car and the results you simulate improve while
the car you drive does not.

**3. `rivalSkill` never reaches a driven session either.** `main.ts:2182-2186`
passes the raw `Driver` records from `fieldForTier()` into `RaceEngine`. The
tier's `fieldSkill` scaling is applied only in the paper model, so the F3 field
you race is the F1 field at full strength.

**4. There are no junior formulae.** `fieldForTier()` returns
`DRIVERS.slice(0, 13)` for F3 and `.slice(0, 15)` for F2 — the top of the
Formula 1 grid, in Formula 1 cars, wearing Formula 1 team colours. There are no
F3 teams, no F2 teams and no junior drivers.

**5. Promotion is not the rule the player asked for.** F3 promotes on
`won || (pos <= 3 && reputation > 40)`, F2 on `won || (pos <= 2 && reputation >
60)`. The rule wanted is **top two, full stop**. And only the player is ever
promoted: no AI driver has ever moved between tiers, because no AI driver is in
a tier.

**6. The calendars are wrong.** `calendar` returns `CIRCUITS.slice(0, rounds)`.
There are eleven circuits and F2 asks for twelve rounds, so F2 silently races
eleven. All three tiers race the same circuits in the same order every year.

**7. The save cannot survive what comes next.** `saveVersion` is 1, `migrate()`
is empty, and a save from a newer build is rejected outright. More seriously, the
save stores `teamId` and driver ids as references into the *static* `TEAMS` and
`DRIVERS` arrays. The moment the world becomes dynamic — junior grids, rookies
entering, drivers transferring, per-save performance variance — those references
point at nothing.

These are not defects to be patched around. Items 1–4 are the *same* defect:
**the career layer and the simulation layer share no channel.** Fixing that is
Layer 0, and it is what section 2 is about.

---

## 2. Layer 0 — how a career decision reaches the car

This is the load-bearing section. Every management system below is judged by
whether it ends up here.

### The one place a car's performance is decided

```
CarEntry.ts:415    const spec = applySetup(specForTeam(team.performance), this.setup);
                                            ^^^^^^^^^^^^^^^^^^^^
```

`specForTeam` (`src/physics/VehicleSpec.ts:253`) multiplies the base F1 spec by a
`TeamPerformance` record:

```ts
icePowerW  = base.icePowerW  * perf.powerMult
ersPowerW  = base.ersPowerW  * perf.ersMult
clBase     = base.clBase     * perf.downforceMult
cdBase     = base.cdBase     * perf.dragMult
baseMu     = base.baseMu     * perf.mechanicalGripMult
```

and `tireWearMult`, `failureRate` and `pitCrewTimeS` are read directly by the
tyre model, the attrition model and the pit stop.

`team` arrives from one line: `RaceEngine.ts:361`, `const team =
getTeam(d.teamId)`. So **`TeamPerformance` is the entire bandwidth between the
career and the physics**, and `getTeam` is the entire plumbing.

That is a good thing. It means every system in this document has exactly one job
to justify itself: *what does it do to a `TeamPerformance` field?* If the answer
is "nothing", the system is a spreadsheet and should be cut.

### The grid overlay

The career needs `getTeam('novara-f3')` to work for a team that does not exist in
the static array, and it needs `getTeam('apex')` to return *this save's* Apex,
with its own re-rolled form and its own accumulated upgrades — not the constant
from the source file.

So `src/data/teams.ts` gains a small, documented overlay:

```ts
/** The career installs this season's grid; everything else sees the static one. */
export function installGrid(teams: readonly Team[], drivers: readonly Driver[]): void;
export function clearGrid(): void;
```

`getTeam` and `getDriver` consult the overlay first and fall through to the
static maps. Quick Race, the paddock screen and all twenty-five existing probes
never install an overlay, so they see exactly the grid they see today and their
results do not move by a millisecond.

This is a ~25-line change to a data file that no other agent owns. It is the only
change required outside new files, and it makes every downstream consumer correct
at once — the physics, the strategy planner, the AI's team lookups, the timing
tower, and the livery, because `CarMesh` colours the car from `team.colour`.

**Rejected alternatives.** Threading a tier through `SessionConfig` would have
touched `RaceEngine`, which another agent is working in, and would still not have
solved dynamic teams. Post-construction spec injection (the trick
`applyPlayerSetup` at `main.ts:2459` already uses) reaches only the player's car,
not the nineteen others.

### A tier is a set of teams, not a flag on the session

Because `TeamPerformance` is a set of multipliers on the base F1 car, a Formula 3
car *is expressible as a team*. The junior formulae therefore need no new concept
and no new code path: they are grids of teams whose multipliers describe a junior
car.

| | powerMult | ersMult | downforceMult | dragMult | gripMult | ref. lap vs F1 |
|---|---|---|---|---|---|---|
| F1 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| F2 | 0.62 | 0.00 | 0.60 | 0.80 | 0.93 | ~1.13 |
| F3 | 0.44 | 0.00 | 0.42 | 0.70 | 0.88 | ~1.21 |

The targets are the real ratios: an F2 car is about 13% off an F1 lap and an F3
car about 21%. The multipliers above are a starting point; **`probe:career`
measures actual headless lap times on all eleven circuits and the numbers are
tuned until they land**, exactly the way the physics was calibrated. This is the
first time in this codebase that a tier has meant anything to a lap time.

Junior formulae are spec series: every team runs the same chassis and engine. So
junior teams differ *only* in the fields that describe an operation rather than a
car — `failureRate`, `pitCrewTimeS`, `tireWearMult` — and in their drivers. That
is true of real junior racing and it makes the junior championships about driving
and race craft, which is the right feeling for the bottom of a career.

**One known gap.** `specForTeam` does not scale `dryMassKg`, and a real F3 car is
605kg against an F1 car's 798kg. The junior cars will therefore be correctly
underpowered and correctly low on downforce but too heavy, which flatters their
braking and hurts their traction. Adding `massMult?: number` to `TeamPerformance`
and one line to `specForTeam` fixes it — that is a two-line change in
`src/physics/VehicleSpec.ts`, which belongs to the vehicle-handling agent. **It
is a request, not something taken.** Version one tunes the other multipliers to
land the lap times and documents the compromise.

### The full connection table

Every system below, and the physical quantity it moves. Anything not in this
table does not ship.

| Decision | Reaches | Physics effect |
|---|---|---|
| Tier (F3/F2/F1) | team multipliers | power, downforce, drag, grip, no ERS in juniors |
| Engine supplier | `powerMult`, `ersMult`, `failureRate` | straight-line speed, deployment, retirements |
| Aero upgrade | `downforceMult`, `dragMult` | cornering vs top speed — the real trade |
| Chassis upgrade | `mechanicalGripMult`, `tireWearMult` | low-speed grip, stint length |
| Powertrain upgrade | `powerMult`, `ersMult`, `failureRate` | as engine, plus reliability |
| Facility level | project cost and duration | how fast the above accrue |
| Department morale | project cost ×, QC failure chance | whether an upgrade lands at all |
| Pit crew investment | `pitCrewTimeS` | stationary time, which `Strategy.ts` already prices |
| Sponsor income | budget | what can be developed at all |
| Cost cap | development ceiling | a hard bound on the above |
| Teammate signing | that car's `Driver` record | constructor points, development feedback |
| Player training | `PlayerDriver` attributes | the same fields the AI reads for its own drivers |
| Pressure | `consistency` (already wired, `CareerEngine.ts:514`) | mistakes |
| Livery | `team.colour`, `team.accent`, design | what `CarMesh` paints |

---

## 3. Layer 1 — persistence

Everything depends on the shape of the save, so it is built first.

### The world moves into the save

Today the save holds ids into static arrays. From now on the career **owns its
world**: three tiers of teams and drivers, generated at career creation, mutated
every off-season by transfers, retirements, rookie intake and development. That
world is the save.

```ts
interface CareerState {
  saveVersion: number;        // breaking shape changes
  saveMinor: number;          // additive changes; older builds still load these
  createdAt: string;
  seed: number;

  player: PlayerDriver;
  world: CareerWorld;         // ← the grid, all three tiers
  seasons: SeasonState;       // standings, calendar, results for the live season
  history: SeasonSummary[];   // one compact record per completed season
  team: MyTeamState | null;   // null unless My Team
  narrative: NarrativeState;  // fan rating, rivalries, morale, sponsors, flags
}
```

Size: three tiers × 20 drivers × ~16 numeric fields, plus 30 teams, plus a
history entry per season. A ten-season career is on the order of 150 KB of JSON —
comfortable for `localStorage`, which is what `SaveManager` already uses with an
in-memory fallback for Safari private browsing.

### Forward compatibility

The current `load()` rejects any save whose `saveVersion` exceeds the build's.
For a career meant to survive ten hours of play across many builds, that is the
wrong default. Two version numbers instead of one:

- **`saveVersion`** — incremented only when the shape changes incompatibly. A
  higher one is genuinely refused, because guessing would corrupt the career.
- **`saveMinor`** — incremented for additive changes. A save with a higher minor
  **loads**, and any keys this build does not recognise are **preserved
  verbatim** and written back out on the next save.

That last point is what makes a career survive going backwards through builds:
play on a newer build, open it on an older one, and the newer build's fields come
back intact rather than being silently deleted.

Loading is then: parse → structural check → run the migration ladder from the
save's version to the current one → deep-merge over defaults so every field
added since has a value → keep the unknown-key bag.

```ts
const MIGRATIONS: Record<number, (s: AnyRecord) => void> = {
  1: migrateV1toV2,   // the existing flat career → world/seasons/narrative
};
```

Each step is idempotent and each is exercised by the probe against a fixture of
the previous format, so a real v1 career in someone's browser walks forward
rather than being thrown away.

### Verified by `probe:save`

- A freshly created career round-trips byte-identically through
  save → load → save.
- A ten-season career round-trips, with standings, history and world intact.
- A v1 fixture migrates to the current version without losing its driver, its
  titles or its championship position.
- Unknown keys inserted into a save survive a load/save cycle.
- A save with a higher `saveVersion` is refused; a save with a higher `saveMinor`
  loads.
- Truncated, empty, non-JSON and foreign-JSON inputs all return `null` rather
  than throwing.
- The serialised size of a ten-season career is under 512 KB.

---

## 4. Layer 2 — the season and progression spine

The goal for this layer is a career that is **playable end to end with nothing
but racing**. No management, no press, no sponsors. If that is not enjoyable and
not correct, nothing built on top of it will be.

### The world

Three championships run **every season, simultaneously**, whether or not the
player is in them. This is the difference between a ladder and a backdrop: when
the player is promoted to F2, the two drivers who come up from F3 with them are
drivers who actually won an F3 season that was simulated.

| Tier | Real | In the game | Rounds |
|---|---|---|---|
| Formula 3 | 10 teams × 3 cars = 30 | 10 teams × 2 = **20** | 9 |
| Formula 2 | 11 teams × 2 cars = 22 | 11 teams × 2 = **22** | 12 |
| Formula 1 | 11 teams × 2 cars = 22 | 11 teams × 2 = **22** | 11 |

Formula 3 really runs three cars per team. It is cut to two here, because thirty
cars is a step change in cost on a phone for a tier the player leaves after one
or two seasons, and because two-per-team is what the pit geometry paints. The
third driver of each real F3 team is kept in the roster as a reserve who can be
promoted into a seat by the transfer market, so nobody is deleted.

**22 cars is outside the envelope every existing probe measures.** The race
engine, `pitLaneGeometry` and all twenty-five probes are built and validated at
20 (`PIT_GARAGE_COUNT = 20`, two boxes per garage across ten garages). This is
not a reason to run a fictional 20-car grid — the player asked for the real one —
but it is a reason to *measure* rather than assume. `probe:fieldsize` runs full
headless races at 20, 22 and 24 cars on all eleven circuits and asserts that
containment, pit entry, pit boxes, classification and lap counting all still
hold. If 22 passes, it ships. If the pit row needs to grow, the fix is an
optional `boxCount` argument on `pitLaneGeometry` defaulting to the current
constant, which leaves every existing caller bit-identical — a change in
`src/track/PitGeometry.ts` and one line in `RaceEngine`, both of which are
flagged rather than taken unilaterally.

Calendars are per tier, drawn from the eleven surveyed circuits, ordered to
approximate each real championship's shape. F1 races all eleven; F2 races twelve
rounds across them (one double-header, as the real calendar has); F3 races nine.
Each tier gets its own order, so a season has a shape rather than being the same
list three times.

### Promotion — the rule, exactly

> At the end of each season, the top two in the Formula 3 championship move to
> Formula 2, and the top two in Formula 2 move to Formula 1.

No reputation gate, no discretion, for the player or for anyone. If the player
finishes second in F3, they are in F2 next year. If they finish third, they are
not.

Two F2 graduates arriving in F1 displace two F1 drivers. The seats that open are
chosen by a valuation over the F1 field — the lowest-valued drivers whose
contracts have expired, with age and a poor season weighing against them — so the
grid renews itself the way a real one does rather than by deleting whoever is
last alphabetically.

Two seats open in F2 and are filled by the F3 graduates. Two seats open in F3 and
are filled by **generated rookies**: new drivers with invented names from a
weighted international pool and rolled attributes, aged 17–19. The pyramid keeps
its base, and by season five the F1 grid contains drivers the player raced in F3.

Where a promoted driver lands is decided by the same market that runs the rest of
the silly season (section 5): the champion tends to get the better seat, but a
team with money and a preference for experience may take the runner-up instead.

### Staying put

A player who finishes third or worse stays in the tier. That must have a cost or
the ladder is a formality. Teams have patience: a contract is one or two seasons,
and a driver who has not been promoted after **three seasons in F3** or **three
in F2** is dropped. Losing the seat is not the end of the career — there is a
free-agent year, at reduced pay, with one chance to get back on the grid — but a
second failure ends it, and the career screen says so plainly before it happens.

### The season loop

```
        ┌─ PRE-SEASON ──────────────────────────────────────────┐
        │  contract, objectives, (My Team: budget, engine,      │
        │  teammate, livery, sponsors)                          │
        └────────────────────────┬──────────────────────────────┘
                                 ▼
        ┌─ ROUND 1..N ──────────────────────────────────────────┐
        │  BETWEEN: preparation slots (train / simulator /       │
        │           media / factory / sponsor day)               │
        │  WEEKEND: practice → qualifying → race   ← existing    │
        │  AFTER:   press conference → standings → narrative     │
        └────────────────────────┬──────────────────────────────┘
                                 ▼
        ┌─ OFF-SEASON ──────────────────────────────────────────┐
        │  titles → promotions → retirements → silly season →    │
        │  rookie intake → form re-roll → ageing → new calendar  │
        └───────────────────────────────────────────────────────┘
```

**Between rounds** the player gets two preparation slots (three when the gap in
the calendar is long). This is the answer to *"what do you actually do between
races"*:

| Slot | Effect |
|---|---|
| Train | +0.004–0.010 on one driver attribute, permanent |
| Simulator | Next weekend starts from a tuned setup instead of the generic baseline |
| Media day | Fan rating up; department morale down slightly (you were not at the factory) |
| Factory visit | Department morale up |
| Sponsor day | Cash |

Starting an upgrade project or reassigning staff is free — it is a decision, not
a use of the player's time.

### Simulating the tiers the player is not in

The two championships the player is not racing in are resolved by the paper model
that already exists (`simulateRace`), reading the same `TeamPerformance` and
`Driver` records the physics reads. There is one model of how fast a car is, so a
simulated F3 season and a driven one produce the same kind of table. This is
already the stated design of `CareerEngine` and it is kept.

### Verified by `probe:season`

- Ten full careers, ten seasons each, simulated headless to the end.
- **Promotion is exactly top two**, every tier, every season, for AI and player
  alike; nobody is promoted twice, nobody is skipped.
- Grid integrity: every tier has exactly 20 drivers and 10 teams with 2 cars each
  after every off-season, for ten seasons. No driver holds two seats. No seat is
  empty.
- Points arithmetic: the sum of points awarded equals the sum in the standings;
  the constructors' table equals the sum of its drivers'.
- Calendars are the right length and contain only real circuit ids.
- A driver promoted from F3 to F2 appears in the F2 standings the following
  season with zero points.
- No driver's age, skill or attribute leaves its legal range across ten seasons.
- The champion of each tier is correlated with car and driver quality across many
  seeds, rather than being random or fixed by starting order.
- The player's career terminates cleanly on the drop rule and never wedges.

### Verified by `probe:tiers`

Headless qualifying at all eleven circuits in all three tiers, asserting that F2
laps land 11–16% off F1 and F3 laps 18–24% off, that the ordering is strictly
F1 < F2 < F3 everywhere, and that no junior car exceeds its tier's top speed
envelope. This is the probe that proves `carPace` is no longer a lie.

---

## 5. Layer 3 — My Team

The player is owner and lead driver. Everything here funnels into the connection
table in section 2.

### Creating the team

Name, short name, three-letter code, base country, colour palette, livery
(section 7). The team enters **Formula 1 directly** — a separate career type from
the ladder, chosen at the start, and the mode the brief describes as *"build a
racing empire from the ground up"*.

The real 2026 grid already has eleven teams. A My Team career therefore makes it
**twelve teams / 24 cars**, which is a further step outside the validated
envelope. This is the same question as the 22-car question in section 4 and it
gets the same treatment: `probe:fieldsize` measures 24 alongside 20 and 22, and
the answer decides. If 24 does not hold, the fallback is that My Team **takes
over an existing entry** — the player buys the weakest team on the grid and
renames it, inheriting its garage, pit box and constructor history. That is a
worse fit for "from the ground up" but it is a better game than one that breaks,
and it is arguably a better story: you inherit a failing operation with
demoralised staff and a bad engine deal.

### Budget and the cost cap

| | |
|---|---|
| Starting budget | $150M |
| Cost cap | $135M per season |
| Under the cap | development projects, facility upkeep, staff wages, pit crew |
| Outside the cap | driver salaries, the engine supply contract, marketing |
| Prize money | $70M for P1 in the constructors', sliding to $22M for P10 |

Income is prize money plus sponsorship. Expenditure is salaries plus the engine
contract plus everything under the cap. The cap is a **hard bound on
development**, not on cash: a team can be rich and still unable to spend, which is
the constraint that makes the real thing interesting.

Breaching it is not a warning dialog. A minor breach (<5%) costs a
constructors' points deduction; a major breach costs points, a development ban
for the following season's first three rounds, and a fine. The UI shows the
remaining cap headroom on every screen where money can be committed, and refuses
to commit past it without an explicit confirmation naming the penalty.

### Power units

The five real 2026 manufacturers, each a set of numbers rather than a label:

| Manufacturer | Works team | Customers (2026) | Character |
|---|---|---|---|
| Mercedes | Mercedes | McLaren, Williams, Alpine | strongest all-round, most expensive, hardest to get |
| Ferrari | Ferrari | Haas, Cadillac | highest peak power, thirstier, less reliable |
| Red Bull Ford Powertrains | Red Bull | Racing Bulls | new programme: strong deployment, poor early reliability |
| Honda | — | Aston Martin | most reliable, modest peak |
| Audi | Audi | — | works-only at first, opens to customers later in a career |

Each maps to `powerMult`, `ersMult` and a contribution to `failureRate`, and each
has a per-season cost and an availability rule — a works team is served first,
and a customer deal needs standing the player has to earn. Contracts are
multi-year and breaking one costs a fee. The manufacturers' numbers **drift
across a career** under the same form model that moves the teams (section 6), so
the right deal in season one is not the right deal in season six. That is what
makes the choice recur rather than being made once.

These are names and performance characteristics only. No manufacturer logo,
wordmark or badge appears anywhere.

These multiply into the team's `TeamPerformance` alongside the department
upgrades, so the engine deal is visible in a straight-line speed trap and in the
retirement rate, not in a menu.

### Departments

Three: **Aero**, **Chassis**, **Powertrain**. Each holds a facility level (1–5),
a headcount, and a morale (0–100).

An **upgrade project** targets one department at one of three ambitions:

| Ambition | Cost | Duration | Gain | Base QC failure |
|---|---|---|---|---|
| Refinement | low | 2 rounds | small, reliable | 4% |
| Development | mid | 4 rounds | moderate | 10% |
| Concept | high | 7 rounds | large | 22% |

On delivery the gain is applied to the corresponding `TeamPerformance` fields.
Aero gives downforce and costs drag unless the project is specifically an
efficiency one — the trade-off is preserved, because it is the trade-off the
physics models and the circuits already reward differently.

**Morale is the interesting variable**, and it is where Layer 4 plugs in:

```
cost   ×= 1.25 − 0.50 × (morale / 100)      // a proud department works cheap
p(QC failure) = base × (1.6 − 0.8 × morale / 100) × ambitionFactor / facilityLevel
```

A department at 100 morale delivers a project for 75% of list price and rarely
fails quality control. A department at 10, because the player blamed them on
camera after a bad race, charges 1.2× and fails a concept project nearly a third
of the time — the money is spent, the part does not appear. That is the mechanic
the brief asked for, expressed in the two numbers the player will actually feel.

### Signing a teammate

A free-agent pool with names, ages, attributes and asking salaries. Their
attributes go into a real `Driver` record in this save's world, so the teammate
drives the second car in every session with their own skill, aggression and tyre
management, scores constructors' points, and is beaten or not beaten in
qualifying. Salary is outside the cap; a fast teammate is expensive and will also
take points off you.

### Verified by `probe:myteam`

- Ten My Team careers, ten seasons each.
- The budget is never silently negative: every transaction is checked and the
  ledger balances against income minus expenditure, every season.
- **The cost cap binds**: a career that always spends maximally hits the cap and
  is stopped by it, and a career that deliberately breaches receives the penalty.
- Every delivered upgrade moves a `TeamPerformance` field, and the team's
  multipliers stay inside a sane envelope after fifty upgrades (no runaway).
- Morale at 0 measurably raises project cost and QC failures against morale at
  100, over many trials.
- Engine choice changes measured top speed at Monza in a headless session.
- A team that never develops falls down the constructors' table; one that
  develops well climbs it.

---

## 6. Layer 4 — the narrative systems

These are what make two careers different from each other. They are built last
because each one is only meaningful once the thing it modifies exists.

### Press conferences

After every race, in the **radio-card format already on screen** — the
team-principal card from `src/ui/Hud.ts`, with its portrait, its tone rail down
the leading edge, and its one real sentence in the prose face. This is what the
player asked for and it is already the best-looking thing in the game.

Two or three questions, drawn from a pool conditioned on what actually happened:
the result, whether you beat your teammate, whether you retired, whether a rival
beat you, whether the car failed. Each answer carries typed consequences:

```json
{ "type": "departmentMorale", "target": "chassis", "value": 8 }
{ "type": "fanRating",  "value": 4 }
{ "type": "rivalHeat",  "target": "rival", "value": 12 }
{ "type": "pressure",   "value": -6 }
```

Authored as data (`src/career/press.json`) in the same style as the existing
`events.json`, so adding a storyline is a content edit. Praising the chassis team
after a good result raises their morale, which cuts the cost of their next
upgrade. Blaming the powertrain team on camera drops theirs, which is felt six
rounds later when a concept project fails quality control and the money is gone.
The loop is: **what you say → morale → cost and reliability of parts → lap
time**.

### Fan rating

0–100, and the thing that gates sponsorship.

Inputs, per race: finishing position **relative to what the car deserved** (fans
reward over-delivery, not position), overtakes completed, wins, retirements
caused by your own mistakes, press answers, rivalries won, and a small
contribution from a bold livery. It decays slowly toward a baseline set by
championship position, so it cannot be farmed and cannot be permanently ruined.

### Sponsors

**The sponsors are fictional and stay fictional**, even though the teams and
drivers are real. A sponsor's name is painted down the side of a car at size, and
that is reproducing a wordmark rather than naming an entity — the one thing
section 0 rules out. The brand set already in `Livery.ts` is extended instead.

Four slots: one title, two primary, four secondary. Each sponsor has a minimum
fan rating before they will talk, a signing bonus, a per-race payment, and a
**contract objective** — finish in the top six in the constructors', score in
eight rounds, beat a named rival team, win a race. Meeting it pays a bonus;
missing it triggers a clawback that is deducted from next season's budget, which
is how a bad season compounds.

And they are painted on the car. `Livery.ts` already draws sponsor decals from an
invented brand list; from now on it draws **your signed sponsors**, at sizes that
follow their tier. The title sponsor gets the sidepod. That closes the loop
between the management screen and the thing on track, and it is the single
detail most likely to make the mode feel real.

### Rivalries

The player may **declare** a rivalry with a driver, or in My Team with a
constructor. A declared rivalry raises the stakes of every head-to-head: beating
them across a season pays acclaim (fan rating, reputation, sponsor interest);
losing costs morale and adds pressure, which already feeds `consistency` at
`CareerEngine.ts:514` and therefore already costs lap time.

AI drivers form rivalries with each other too, reported in the standings screen,
so the paddock has stories in it that are not about the player.

### Silly season

Between seasons, in this order:

1. **Promotions** resolve (section 4).
2. **Retirements**: drivers over 33 whose skill has begun to decline retire on a
   probability curve; a driver who loses a seat and finds none retires too.
3. **Contracts** expire.
4. **The market**: every team with an empty seat values every available driver by
   `skill`, `experience` weighted by that team's own `prefersExperience`, age, and
   asking price against budget. Teams choose in order of standing. Drivers accept
   or hold out for something better, and a driver may take a worse seat at a
   better team.
5. **Rookie intake** backfills F3.
6. **Form re-roll**: this is the mechanic the brief called *hidden per-team
   performance variance*. At career creation each team gets a `formBias` drawn
   from a normal distribution and folded into its multipliers, so **the pecking
   order is different in every save**. Each off-season, teams develop by their
   `developmentRate`, regress slightly toward the mean, and take a fresh shock —
   so the order also *drifts within* a career and a dominant team can be caught.

The player learns none of this from a table. They learn it in pre-season testing
and in the first qualifying session of the year, which is exactly where it should
be learned.

### Verified by `probe:narrative`

- Every press question has at least two answers and every consequence type is one
  the engine implements (the same validation the existing events file gets).
- Department morale stays in 0–100 across ten seasons of extreme answers.
- Low morale demonstrably raises upgrade cost and failure rate.
- Fan rating stays in range and responds to results in the right direction.
- Every sponsor is signable by some reachable fan rating; no sponsor is
  unreachable; objectives are all evaluable.
- Over ten careers: every seat is filled after every silly season, no driver holds
  two seats, no driver is lost, and the F1 grid's mean skill does not drift up or
  down without bound over ten seasons.
- The pecking order at season 1 differs between seeds (the form roll actually
  varies), and the season-10 order differs from the season-1 order (it drifts).

---

## 7. The livery designer

`src/render/Livery.ts` is much better than "colour sweeps" — it unwraps three
real panels, paints a swept nose flash, a deck spine, a flank flash, race
numbers, a driver code, sponsor decals, panel seams and painted-in occlusion,
into one texture and one draw call per car. What it does **not** have is any
variation: every car on the grid is the same design in different colours. That is
the gap.

Giving the player two colour pickers would produce exactly the same grid. So the
design is parameterised properly:

**Pattern families.** The painter is split into a family dispatch, each family a
different arrangement of the same drawing vocabulary the file already has
(`poly`, `band`, `carbon`, `shadeBand`, `text`, `decal`):

1. **Bolt** — the current design; a swept nose, a deck spine, a flank flash.
2. **Chevron** — a forward V repeated down the flank and over the airbox.
3. **Stripe** — twin full-length racing stripes over nose, deck and engine cover.
4. **Wave** — a curve rising from the floor, over the sidepod, into the airbox.
5. **Split** — hard diagonal colour block, front half against rear half.
6. **Halo** — accent confined to the shoulder line and the airbox crown, body
   otherwise plain; the restrained one, and it will be the best-looking one.

**A palette of three**, not two: base, accent and trim. Trim is currently
hardcoded and is what lets a livery read as designed rather than as two-tone.

**A finish**: gloss, satin or matte. The roughness/metalness map is shared across
all twenty cars today; three shared maps keyed by finish keeps that property
while letting a matte car exist. Matte black with a single accent is the look
players will reach for first and it is currently impossible.

**Sponsors** come from the signed set (section 6), so the car carries the deals.

The editor previews on the **real car**: `src/render/CarStage.ts` already mounts
a lit, rotating, reflected car on its own canvas and is already used by the
paddock screen. Family thumbnails are rendered by running the same painter into a
small canvas, so what is previewed is what is painted — there is no second
representation to fall out of sync.

`buildLivery` keeps its current signature and gains optional design fields, so
`CarMesh.ts` — which belongs to another agent — needs no change. The design is
resolved through a registry keyed the same way the material cache already is.

---

## 8. The opening sequence

Every racing game of this kind opens the same way, and it is worth being precise
about what that opening actually is before building one. In the official games it
is an attract montage cut to typography, then character creation, then a framing
scene that says *this is where you start and that is where you are going*. The
montage in those games is largely **rendered in-engine** — their own cars on
their own circuits — with licensed archive footage used sparingly if at all.

That is the version this game can build honestly. There is no archive footage to
license and none will be faked. What there is: eleven surveyed circuits, a
twenty-two car field, a renderer with seven camera modes, a night race, a wet
race, a pit lane, a full procedural audio engine, and a car that looks like a
car. That is a montage.

### The sequence

Five beats. The whole thing runs about fifty seconds and can be left at any
moment.

1. **Cold open.** Black. A single low frequency from the audio engine. One line
   of type, set in the display face at the size the game uses for nothing else.
2. **The montage.** Six shots, each two to four seconds, cut on the beat, each
   one a real camera on a real circuit with real cars: a standing start under
   the lights at Jeddah; an onboard through Monaco's Grand Hotel hairpin; a
   trackside pan at Spa with the field through Eau Rouge; a pit stop from the
   overhead; wheel-to-wheel into Monza's first chicane; a chequered flag. Title
   cards between them carry the framing — what the ladder is, what it costs, how
   few make it.
3. **The ladder.** The three tiers drawn as the sector rule the rest of the game
   already uses, F3 to F2 to F1, with the top-two rule stated in one sentence.
   This is the moment the player learns the only progression rule that matters.
4. **Creation.** Name, nationality, race number, and the choice of ladder
   (start in Formula 3) or My Team. Presented as a paddock pass being filled in,
   not as a settings form.
5. **The first seat.** Which team has signed you, which circuit is first, and
   the one line your principal says to you. It hands straight to the career hub.

### Rules it has to obey

- **Skippable from the first frame.** A persistent skip control, plus any key,
  tap or gamepad button. Skipping goes straight to creation. Once the sequence
  has been seen it never plays again unless asked for from the menu — the flag
  lives in `GameSettings`, not in a career, because it is a fact about the player
  and not about a championship.
- **It cannot block the boot path.** The menu must appear whether or not the
  sequence can be built. There is prior history here of start-up work throwing
  before the UI existed and leaving a blank screen, so the sequence is
  constructed inside a guard and any failure falls through to the plain menu.
- **Nothing plays sound before a gesture.** The audio graph is only created on
  the first user interaction, which is a hard browser constraint on iOS as well
  as a good manner. The cold open is therefore silent until the player touches
  the screen to begin, and the sequence is entered *from* a press rather than
  starting on load.
- **Reduced motion is respected.** With `prefers-reduced-motion` set, the montage
  becomes a held sequence of stills with the same typography and the same
  duration, rather than being deleted.
- **It reuses the renderer it already has.** The montage is a scripted camera
  over a headless race running in the background, not a second rendering path.

### Cost, and the order it gets built in

The sequence is the front door to a career that has to exist first, so it is
built after layers 1 and 2. If it is not reached, the career opens on the
existing create screen, which works. A beautiful opening in front of nothing is
the wrong trade and it is not taken.

---

## 9. Screens

The visual language is fixed and is not up for reinvention. Every screen below
goes through `Game.page()` so it inherits the status rail, the back chevron, the
sector rule and the pinned action bar; uses the five signal colours with their
existing meanings; sets figures in `--font-data` with tabular numerals and names
in `--font-display` at 108–122% stretch; and uses the three existing panel
recipes (gapless instrument plate / broadcast card / glass board) rather than a
fourth. Ranked orders are `timingBoard()` from `src/ui/TimingRow.ts`, not cards.

| Screen | Contents | Recipe |
|---|---|---|
| **Career hub** (rebuilt) | Next round with its circuit map, championship position, preparation slots, contract state, a live cap gauge in My Team | Glass board + instrument plates |
| **Championship** | Three tiers as tabs; drivers' and constructors' tables | `timingBoard` |
| **Calendar** | The season's rounds with `CircuitArt` outlines, results behind, next ahead | Circuit cards |
| **Team HQ** (My Team) | Departments, morale, active projects with delivery countdowns | Instrument plates |
| **Budget** | Ledger, cap headroom, sponsor income, salaries | Instrument plates |
| **Engine deal** | Five suppliers compared on real numbers | `timingBoard`, ranked |
| **Driver market** | Free agents ranked with attributes and asking price | `timingBoard` |
| **Livery** | `CarStage` preview, family thumbnails, three colours, finish | Glass board + stage |
| **Press conference** | The principal card, question, answers as choices | Broadcast card |
| **Off-season** | Promotions, transfers, retirements as a sequence of beats | Broadcast cards |

The **press conference is the signature screen** and the only one that gets the
lit stage (`.screen.lit`) outside a results moment: a face, a question, and three
answers whose consequences are stated plainly rather than hidden behind a hint.
It is the moment the career stops being a table.

---

## 10. Build order

1. **Persistence** — save v2, world in the save, migration ladder, unknown-key
   preservation, `probe:save`.
2. **Season spine** — the real roster module; grid overlay in `teams.ts`; per-tier
   car multipliers; per-tier calendars; top-two promotion for player and AI;
   retirements and rookie intake; off-season roll; `probe:season`,
   `probe:tiers`, `probe:fieldsize`.
3. **My Team** — creation, budget and cost cap, power-unit deals, departments and
   projects, teammate signing, livery designer; `probe:myteam`.
4. **Narrative** — press conferences and department morale, fan rating and
   sponsors, declared rivalries, the transfer market; `probe:narrative`.
5. **The opening sequence** — section 8.

Layers 1 and 2 are delivered and verified. Everything after goes as far as it can
go whole.

## 11. Provenance of the real-world data

Every real name in `src/data/roster/` came from these sources, gathered in
August 2026. Attributes (skill, aggression, consistency, tyre management, wet
skill, race craft) are **not** from any source — they are this project's own
estimates on the existing 0..1 scale, tuned so the simulated championship order
is plausible.

| Data | Source |
|---|---|
| F1 2026 teams, drivers, numbers | formula1.com driver and team listings |
| F1 2026 power-unit allocations | motorsport.com, planetf1.com supplier summaries |
| F2 2026 entry list and calendar | Wikipedia, *2026 Formula 2 Championship* |
| F3 2026 entry list and calendar | Wikipedia, *2026 FIA Formula 3 Championship* |
| Team colours | each team's published primary livery colour, as hex |

Swapping this for a fictional grid means writing one module with the same
exports. Nothing else in the codebase knows a real name.

## 12. What this does not do

- **No online, no accounts, no server.** Saves stay in `localStorage` with the
  existing in-memory fallback, and export/import stays the way a career moves
  between devices.
- **No mass scaling for junior cars** until `TeamPerformance` gains `massMult`
  (section 2). Flagged, not taken.
- **No 22-car F1 grid.** My Team takes over an existing entry instead
  (section 5).
- **No driver academies, no junior programme contracts, no reserve-driver
  seasons.** They are good ideas and they are not in this pass.

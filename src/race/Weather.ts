import { clamp, clamp01, damp, lerp, Rng, smoothstep } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import type { CompoundId } from '../data/tires';
import { getCompound } from '../data/tires';
import {
  ALL_COMPOUNDS, crossoverCandidates, forecastCrossoverCase, interToWetWetness,
  isWetCompound, slickToInterWetness, type CrossoverCase,
} from './Strategy';

/**
 * The weather, the water it leaves on the road, and the pit wall that can see
 * it coming.
 *
 * WHY THIS FILE EXISTS. `Weather` used to be forty lines inside `RaceEngine`
 * and it did exactly one thing: it drifted a single number called `wetness`
 * between 0 and 1. Everything downstream read that one number. The tyre model
 * scaled its grip by it, the AI scaled its target speed by it, race control
 * declared low visibility above it — and the ROAD did not change at all. A
 * screenshot of a race in what the HUD called HEAVY RAIN showed dry asphalt,
 * no spray, no reflections and no standing water, because there was nothing in
 * the simulation that a renderer could have drawn. The track was not wet. A
 * number was.
 *
 * Three things are modelled here that were not modelled before.
 *
 * 1. WATER IS SOMEWHERE. A wet track is not uniformly wet, and every
 *    interesting thing about wet running follows from that. It is deeper where
 *    the circuit drains badly, which is derivable rather than authorable
 *    because the circuits carry real elevation data. It is shallower on the
 *    line the cars have been pumping clear, which is why a drying track has a
 *    visible dry line and why that line is the place to be. `TrackSurface`
 *    owns both, as fields over the track's own nodes.
 *
 * 2. THE FAST LINE MOVES. Rubber laid into the asphalt over a dry weekend is
 *    slick under water in a way no tyre compound can do anything about. When
 *    it first rains, the rubbered-in racing line is the WORST part of the road,
 *    and the cars move off it — this is the single most characteristic sight in
 *    wet Formula 1, and it is not a special case anywhere in this file. It is
 *    what falls out of putting the rubber deposit and the water depth in the
 *    same grip calculation. When the track dries, the line dries first, the
 *    rubber comes back into play dry, and the fast line moves back. Also not a
 *    special case.
 *
 * 3. THE PIT WALL HAS THE RADAR AND THE DRIVER HAS A VISOR. The old code
 *    decided in its constructor whether it would rain and kept that roll
 *    private, and an earlier agent deliberately declined to surface it because
 *    the game had no concept of a forecast. That was the right call and this is
 *    the thing it was waiting for. `Forecast` is a NOISY reading of a schedule
 *    it does not own: it has a confidence, it is sometimes early, sometimes
 *    late, and sometimes simply wrong. `PitWall` reasons with it, reaches a
 *    recommendation, and asks the driver a question that can be answered yes or
 *    no — which is how the decision actually gets made in the sport, and the
 *    reason a strategist who is always right would be worth nothing.
 */

// ===========================================================================
// The sky
// ===========================================================================

/** What is falling out of the sky right now. */
export type Precipitation = 'dry' | 'drizzle' | 'rain' | 'downpour';

/** The label bands, shared by the HUD, the radio and the probes. */
export function precipitationOf(rainRate: number): Precipitation {
  if (rainRate < 0.04) return 'dry';
  if (rainRate < 0.3) return 'drizzle';
  if (rainRate < 0.7) return 'rain';
  return 'downpour';
}

/**
 * A change in the weather, scheduled before it happens.
 *
 * The old model rolled a coin every few minutes and applied the result
 * immediately, which made a forecast impossible to build honestly — there was
 * nothing to forecast, because the future did not exist until it was the
 * present. Committing the next change in advance is what creates a future for
 * the pit wall to be uncertain about, and the driver still cannot see it.
 */
interface WeatherEvent {
  /** Session time the change begins, seconds. */
  atS: number;
  /** Rain rate it moves to, 0..1. */
  intensity: number;
  /** How long the transition takes. A front takes longer than a shower. */
  rampS: number;
}

/**
 * How far ahead the next change is committed, seconds.
 *
 * The lower bound is the one that matters. Below about three minutes the wall
 * cannot give the driver a useful call — by the time the question is asked and
 * answered and the car has reached the pit entry, the weather has already
 * happened — and a strategist whose calls always arrive too late to act on is
 * indistinguishable from no strategist.
 */
const EVENT_LEAD_MIN_S = 210;
const EVENT_LEAD_MAX_S = 900;

export class Weather {
  /**
   * Mean water depth on the racing line, 0 dry .. 1 standing water.
   *
   * Kept under its old name and its old meaning because a great deal reads it —
   * the HUD, race control's low-visibility call, the AI's pace multiplier — and
   * because it is genuinely the right headline number. What changed is that it
   * is now DERIVED from the water field rather than being the whole model: it
   * is what the track average would be for a car sitting on the racing line.
   * Anything that needs to know what a particular car at a particular place is
   * driving through asks `surface.waterAt`.
   */
  wetness = 0;

  /** What is falling right now, 0..1. Distinct from what is lying on the road. */
  rainRate = 0;

  airTempC = 24;
  trackTempC = 38;

  /**
   * True once any rain has fallen — the flag 2025 Sporting Regs Art. 30.5(f)
   * turns on, which disapplies the two-compound requirement of Art. 30.5(e).
   */
  hasRained = false;

  /** The water on the road, where it is. */
  readonly surface: TrackSurface;

  /** What the pit wall's meteorologist believes. Never what is true. */
  readonly forecast: Forecast;

  /** Human-readable state for the HUD. Unchanged bands, unchanged wording. */
  get label(): string {
    if (this.wetness < 0.05) return 'Dry';
    if (this.wetness < 0.35) return 'Damp';
    if (this.wetness < 0.7) return 'Wet';
    return 'Heavy Rain';
  }

  /** What is coming out of the sky, as a word. */
  get precipitation(): Precipitation {
    return precipitationOf(this.rainRate);
  }

  private rng: Rng;
  /**
   * The dry-track temperature this circuit sits at, fixed for the session.
   *
   * The datum the rain cools DOWN FROM. See the temperature block in `update`
   * for what happened when there was no such datum.
   */
  private readonly baseTrackTempC: number;
  private timeS = 0;
  /**
   * The truth. Private, and it stays private: this is the roll the driver is
   * not entitled to see, and the whole design of `Forecast` is that it reads
   * this through a channel that adds error rather than being handed it.
   */
  private next: WeatherEvent | null = null;
  private targetRain = 0;
  private rampRate = 0.02;
  /** How many cars are circulating, for the drying model. */
  private trafficCars = 0;

  constructor(def: TrackDefinition, seed: number, track?: TrackSpline) {
    this.rng = new Rng(seed ^ 0x5bf03635);
    this.airTempC = def.baseAirTempC + this.rng.range(-3, 3);
    this.trackTempC = def.baseTrackTempC + this.rng.range(-4, 4);
    this.baseTrackTempC = this.trackTempC;
    this.surface = new TrackSurface(track ?? null);
    this.forecast = new Forecast(seed ^ 0x1d7ac09b);

    // THE ORDER OF THESE TWO DRAWS IS LOAD-BEARING and it is not aesthetic.
    //
    // The version of this constructor that lived in `RaceEngine` drew a timer
    // here — `nextEventIn = range(300, 1400)` — and then rolled for rain. This
    // rewrite initially dropped the timer, because the schedule below replaced
    // it, and that single missing draw shifted the whole stream: every seed in
    // the game got a different answer to "does it rain", every saved career
    // diverged, and `probeStrategy`'s Silverstone scenario — which has rained
    // from about lap fourteen since it was written, and whose assertions are
    // calibrated on that — went dry and started failing on a number that had
    // nothing to do with strategy.
    //
    // So the draw stays, and it is put to work as the lead time on the first
    // event, which is what it was always morally for.
    const firstLead = this.rng.range(300, 1400);
    if (this.rng.chance(def.rainChance)) {
      // A session that rolls rain STARTS with it arriving, exactly as the old
      // model did — it set `targetWetness` in the constructor and the track was
      // soaked inside a minute. Preserving that is the other half of keeping a
      // seed's meaning: it is not enough for the same seeds to rain, they have
      // to rain at the same point in the session, or `probeStrategy`'s wet
      // Silverstone race becomes a dry one.
      this.targetRain = this.rng.range(0.35, 1);
      this.rampRate = 1 / this.rng.range(35, 110);
    }
    // The next change is always scheduled, rain or no rain, which is what gives
    // a dry session something to forecast and a wet one an end to hope for.
    this.next = { atS: firstLead, intensity: 0, rampS: 0 };
    this.rollNextIntensity();
  }

  /**
   * Decides what the already-scheduled next event will do.
   *
   * Split from the scheduling so the two random draws stay in the order the old
   * model made them: it chose WHEN first and WHAT second.
   */
  private rollNextIntensity(): void {
    if (!this.next) return;
    const wet = this.targetRain > 0.1 || this.rainRate > 0.1;
    // The same two branches the old `update` had: rain that is falling either
    // clears or changes intensity, and a dry sky occasionally clouds over.
    const intensity = wet
      ? (this.rng.chance(0.55) ? 0 : this.rng.range(0.2, 1))
      : (this.rng.chance(0.35) ? this.rng.range(0.3, 0.9) : 0);
    this.next.intensity = intensity;
    // A shower comes on in under a minute; a front takes several. Faster
    // transitions for heavier rain, which is what a squall line does.
    this.next.rampS = this.rng.range(35, 110) * (1.4 - intensity * 0.5);
  }

  /**
   * Tells the drying model how many cars are running.
   *
   * Traffic is most of why a racing line dries first: twenty cars at 250 km/h
   * displace an enormous amount of water and pump the rest into the air behind
   * them. A red-flagged circuit with nobody on it dries at the rate the sun
   * dries it and no faster, which is why a stoppage in a drying race is such a
   * strategic mess.
   */
  setTraffic(carsRunning: number): void {
    this.trafficCars = carsRunning;
  }

  update(dt: number): void {
    this.timeS += dt;

    // --- The sky -----------------------------------------------------------
    if (this.next && this.timeS >= this.next.atS) {
      this.targetRain = this.next.intensity;
      this.rampRate = 1 / Math.max(this.next.rampS, 1);
      // The next change is committed the moment this one lands, so there is
      // always something for the forecast to be uncertain about.
      this.next = {
        atS: this.timeS + this.rng.range(EVENT_LEAD_MIN_S, EVENT_LEAD_MAX_S),
        intensity: 0, rampS: 0,
      };
      this.rollNextIntensity();
    }
    this.rainRate = damp(this.rainRate, this.targetRain, this.rampRate, dt);
    // IT NEVER RAINS AT THE RATE THE GAME ACTUALLY STEPS AT. THIS LINE IS WHY,
    // IT IS NOT FIXED HERE, AND SEE PROJECT.md §7 BEFORE TOUCHING IT.
    //
    // `damp` is `current + (target - current) * (1 - exp(-rate * dt))`. Starting
    // from a dry sky, one step moves `rainRate` from 0 by
    // `targetRain * (1 - exp(-rampRate * dt))`; `rampRate` is 1/35..1/110, so at
    // `PHYSICS_DT` that is at most 0.00024 — and the floor below then puts it
    // straight back to zero. Every step. Forever. `rainRate` cannot leave zero.
    //
    // Measured over 11 circuits x 40 seeds x 90 minutes: stepped at 1Hz, 343 of
    // 440 sessions reach damp or worse and the wettest gets to 0.848; stepped at
    // `PHYSICS_DT`, which is what `RaceEngine.step` passes, **0 of 440 and the
    // wettest gets to 0.0000.** Every race this game has ever simulated has been
    // dry. Nothing catches it because every weather probe and the URL parameter
    // in `main.ts` all reach the road through `forceRain`, which assigns
    // `rainRate` directly and skips the ramp — so the one path the player is on
    // is the one path nothing tests. `probeStrategy` has a comment recording
    // that its Silverstone race "went dry" with the rewrite and attributing it
    // to a shifted random stream; it went dry because they all did.
    //
    // WHY IT IS NOT A ONE-LINE FIX, and the reason it is reported rather than
    // patched on the #42 branch. The floor is right in intent — a dying drizzle
    // should snap to dry rather than asymptote — so the correction is to apply
    // it only while the sky is CLEARING (`targetRain` below the floor too).
    // But the 1Hz column above is what the model does with the floor out of the
    // way, and **78% of sessions wet is not a calendar**: a real season runs
    // perhaps one race in five in the wet. The event schedule rolls a fresh
    // chance every 210-900s and compounds `def.rainChance` into something far
    // larger over a race distance, and that has never been measured because the
    // floor has been hiding it. Landing the floor alone would take the game from
    // no weather to weather in three races out of four and re-baseline every
    // seeded race in the repository at the same time. It needs the schedule
    // calibrated with it, against a stated target for how often a Grand Prix is
    // wet, and that is its own piece of work.
    if (this.rainRate < 0.01) this.rainRate = 0;

    // --- The road ----------------------------------------------------------
    this.surface.update(dt, this.rainRate, this.trackTempC, this.trafficCars);
    this.wetness = this.surface.meanLineWater;
    if (this.wetness > 0.08) this.hasRained = true;

    // --- Temperature -------------------------------------------------------
    //
    // Rain cools the track sharply, and the track is cooled by the water lying
    // on it rather than by the rain falling on it — a track that stopped
    // raining a minute ago is still cold and still wet.
    //
    // AGAINST THE DRY BASELINE, not against itself. The line this replaces read
    // `tempTarget = this.trackTempC - this.wetness * 12` and damped toward it,
    // which is a target defined relative to the value being updated: every step
    // aimed twelve degrees below wherever it had already got to. On a track
    // that stayed wet it diverged without bound, and `probeWeather` section 10
    // caught it at MINUS 178 DEGREES twenty-four minutes into a wet race — which
    // then moved every temperature-dependent crossover in the strategy model and
    // had the field pitting fifty-seven times.
    //
    // It is a pre-existing bug, not one this work introduced; it needed a race
    // that stayed wet for a quarter of an hour to show itself, and nothing in
    // the old model produced one.
    const tempTarget = this.baseTrackTempC - this.wetness * 12;
    this.trackTempC = damp(this.trackTempC, tempTarget, 0.02, dt);

    // --- What the wall can see ---------------------------------------------
    this.forecast.observe(dt, this.timeS, this.next, this.rainRate, this.targetRain);
  }

  /**
   * What the track will look like in `seconds` if the forecast is right.
   *
   * The pit wall's own projection, and it is built out of the same drying model
   * the road runs on — so a wall that says "it will be dry in four laps" is
   * saying something the track can actually do, rather than something a
   * different curve invented.
   */
  projectedWetness(seconds: number): number {
    const reading = this.forecast.reading;
    // No reading: assume the sky holds and project the current rain forward.
    const futureRain = reading && reading.etaS < seconds ? reading.intensity : this.rainRate;
    return this.surface.projectLineWater(this.wetness, futureRain, this.trackTempC, this.trafficCars, seconds);
  }

  /**
   * Forces the weather to a state. FOR PROBES AND FOR NOTHING ELSE.
   *
   * A probe that wants to measure the crossover cannot wait for a seed that
   * happens to rain at the right moment, and one that hunts for such a seed is
   * measuring the seed. This sets the sky and lets the road respond to it
   * through the ordinary model, so what the probe measures is still the real
   * drying curve and the real grip.
   */
  forceRain(intensity: number, soakRoad = false): void {
    this.targetRain = intensity;
    this.rainRate = intensity;
    this.next = null;
    this.rampRate = 0.05;
    if (soakRoad) {
      this.surface.soak(intensity);
      this.wetness = this.surface.meanLineWater;
      if (this.wetness > 0.08) this.hasRained = true;
    }
  }
}

// ===========================================================================
// The road
// ===========================================================================

/**
 * How wide the rubbered-in band is, as a fraction of the road, and how the
 * water field samples across it.
 *
 * The band's half-width comes from `TrackSpline.rubberHalfWidthAt`, which is
 * the same rule the renderer rasterises its rubber map with. That shared source
 * is load-bearing: if the simulation thought the dry line was two metres wide
 * and the shader drew it four metres wide, the player would be told to aim at a
 * dark stripe that is not where the grip is.
 */
const BAND_FALLOFF = 1.35;

/**
 * Water depth the line reaches, as a fraction of what is falling.
 *
 * Below 1 because a racing line is the highest-trafficked, most polished and
 * usually best-drained strip of the circuit, and because the cars themselves
 * are moving water off it continuously. Off the line the figure is higher: the
 * water that leaves the line has to go somewhere, and until it reaches the
 * drains it is lying beside it.
 */
const LINE_CATCH = 0.82;
const OFFLINE_CATCH = 1.0;

/**
 * How fast water arrives, in depth units per second at full rain.
 *
 * 0.028 puts a dry track at full standing water in about 40 seconds of a
 * downpour once transport is accounted for, which is the right order — a heavy
 * cell soaks a circuit within a lap, and that suddenness is exactly what makes
 * the crossover call hard.
 */
const WETTING_RATE = 0.028;

/**
 * How fast water leaves, in depth units per second, on an empty track at the
 * reference track temperature.
 *
 * 0.0013 is about ten minutes from flooded to dry with nobody running, which is
 * the fast end of what real circuits take — between ten minutes and half an
 * hour depending on the sun. A full field circulating cuts that to about four
 * minutes on the racing line and nine off it, and that SPREAD is the number
 * that matters: it is the window in which a dry line exists, and if it is only
 * a minute wide nobody ever gets to race on one.
 *
 * The asymmetry between this and `WETTING_RATE` — a factor of twenty — is the
 * single most important number in the weather model, because it is what makes a
 * stop for intermediates a commitment rather than a recoverable mistake.
 */
const DRYING_RATE = 0.0013;

/** Track temperature the drying rate above is quoted at. */
const DRYING_REFERENCE_TEMP_C = 38;

/**
 * How much faster a fully attended racing line dries than an empty one.
 *
 * Twenty-two cars displacing water and dragging air over the surface, against
 * evaporation alone. The line gets all of it; off-line gets a small share,
 * because cars run wide, and because the air a passing car drags with it does
 * not stop at the edge of the groove.
 */
const TRAFFIC_DRYING_BOOST = 1.5;
const OFFLINE_TRAFFIC_SHARE = 0.18;
/** Field size the boost above is quoted for. */
const FULL_FIELD = 22;

/**
 * Grip lost to rubber under water, at full depth on the heaviest part of the
 * band.
 *
 * This is the number that moves the racing line, and it has to be large enough
 * to be worth a driver's while to act on. 0.22 makes the rubbered line about a
 * fifth worse than clean asphalt when soaked, which against a wet tyre's grip
 * of 0.79 is worth several seconds a lap — comfortably more than the couple of
 * tenths a car gives up by running a wider, longer line to avoid it. Below
 * about 0.12 the geometry wins and the cars stay on the dry line in a
 * monsoon, which is not what happens.
 */
const RUBBER_WET_LOSS = 0.22;

/*
 * THERE IS DELIBERATELY NO DRY-TRACK TERM HERE.
 *
 * An earlier revision had one: a few per cent of grip taken away off the racing
 * line, for the dust and the marbles that really are there. It is true, and it
 * was removed, because it made `surfaceGrip` differ from 1.0 on a bone-dry
 * circuit and that is a change to how every dry Grand Prix in this game is
 * raced — every overtake, every defensive line, every AI decision that was
 * calibrated against a uniform road. `probeStrategy` picked it up within
 * minutes as the field failing to complete its planned stops.
 *
 * The wet-track behaviour does not need it. When the line dries first it is
 * already the fastest place to be, because there is less water on it and the
 * tyre's own wet-grip curve says so. Adding a second reason was gratuitous, and
 * it cost a calibration this task had no business touching.
 *
 * So: on a dry track this function returns exactly 1.0 and the physics is what
 * it always was.
 */

/**
 * Water field over the circuit: how much is lying where, and what that does to
 * the grip of the surface itself.
 *
 * Two depths per node rather than a full 2-D field. The road is three metres of
 * node spacing by ten to fifteen metres of width, and the only lateral
 * structure that matters is "on the groove the cars have worn" versus "not on
 * it" — the transition between them is a metre or two wide and everything
 * outside the groove behaves the same. Two Float32Arrays and a smooth blend
 * between them is the whole model, it costs nothing, and it is enough to
 * produce a dry line that appears, widens and is fought over.
 */
export class TrackSurface {
  /** Water on the racing-line groove, per node, 0..1. */
  readonly lineWater: Float32Array;
  /** Water everywhere else on the road, per node, 0..1. */
  readonly offWater: Float32Array;
  /**
   * How badly each node pools, 0 (sheds instantly) .. 1 (a puddle forms).
   *
   * DERIVED FROM THE CIRCUIT'S OWN ELEVATION, not authored. A node that sits
   * below the road either side of it is where the water goes, and every circuit
   * in this game carries a real height profile. Eau Rouge drains; the bottom of
   * it does not.
   */
  readonly drainage: Float32Array;
  /** Rubber laid into the groove, 0..1, per node. */
  readonly rubber: Float32Array;

  /** Mean water on the racing line — the headline `wetness`. */
  meanLineWater = 0;
  /** Mean water off the line. Reported so a probe can see the two diverge. */
  meanOffWater = 0;
  /** The deepest standing water anywhere on the circuit. */
  peakWater = 0;

  private readonly track: TrackSpline | null;
  private readonly bandHalf: Float32Array;
  /** Accumulator, so the field integrates at a sane rate rather than at 120Hz. */
  private accum = 0;

  constructor(track: TrackSpline | null) {
    this.track = track;
    const n = track ? track.count : 1;
    this.lineWater = new Float32Array(n);
    this.offWater = new Float32Array(n);
    this.drainage = new Float32Array(n);
    this.rubber = new Float32Array(n);
    this.bandHalf = new Float32Array(n);
    if (track) this.buildFields(track);
  }

  /**
   * Precomputes the two static fields: where water collects, and where rubber
   * has been laid.
   */
  private buildFields(track: TrackSpline): void {
    const n = track.count;
    const { elevation, banking, dist } = track;

    // --- Drainage ----------------------------------------------------------
    // A node's tendency to pool is how far it sits below the local road either
    // side of it. Measured over a window rather than against its immediate
    // neighbours, because at three-metre node spacing the immediate neighbours
    // are at essentially the same height and the difference is all noise.
    const WINDOW_M = 90;
    const nodesEachWay = Math.max(2, Math.round(WINDOW_M / Math.max(1, dist[1] - dist[0])));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -nodesEachWay; k <= nodesEachWay; k++) {
        sum += elevation[(i + k + n * 2) % n];
      }
      const localMean = sum / (nodesEachWay * 2 + 1);
      // Half a metre below the surrounding road is a genuine dip and floods.
      const belowM = localMean - elevation[i];
      let d = clamp01(belowM / 0.5);
      // Banking sheds water sideways. A steeply banked corner does not hold a
      // puddle whatever its elevation says, which is why the banked circuits
      // are raceable in conditions that close a flat one.
      d *= 1 - clamp01(Math.abs(banking[i]) / 0.12) * 0.7;
      this.drainage[i] = d;
    }
    // Smoothed, because a puddle is a feature of the road several car lengths
    // long and an unsmoothed field gives a car a different water depth every
    // three metres, which reads as noise in the grip rather than as a puddle.
    smoothLoop(this.drainage, 6);

    // --- Rubber ------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      this.bandHalf[i] = track.rubberHalfWidthAt(i);
      // Same curvature proxy the renderer's rubber map uses for its stamp
      // weight: heaviest where the cars are hardest on the tyres.
      const tight = Math.min(1, Math.abs(track.lineCurvature[i]) * 90);
      this.rubber[i] = 0.55 + 0.35 * tight;
    }
  }

  /**
   * Integrates the water field.
   *
   * Runs at 5 Hz rather than at the physics rate. Water depth changes over tens
   * of seconds and there is nothing to be gained from stepping it at 120 Hz
   * across two thousand nodes twenty-two times a second — the accumulator
   * carries the exact elapsed time into the step, so the result is identical to
   * within the integrator's own error and the cost is a fortieth.
   */
  update(dt: number, rainRate: number, trackTempC: number, carsRunning: number): void {
    this.accum += dt;
    if (this.accum < 0.2) return;
    const step = this.accum;
    this.accum = 0;

    const n = this.lineWater.length;
    if (!this.track) {
      // No track (a probe testing the sky alone). One node stands in for the
      // whole circuit and behaves like a well-drained one.
      const target = rainRate * LINE_CATCH;
      const rate = target > this.lineWater[0] ? WETTING_RATE : dryingRate(trackTempC) * (1 + TRAFFIC_DRYING_BOOST * clamp01(carsRunning / FULL_FIELD));
      this.lineWater[0] = approach(this.lineWater[0], target, rate, step);
      this.offWater[0] = this.lineWater[0];
      this.meanLineWater = this.lineWater[0];
      this.meanOffWater = this.lineWater[0];
      this.peakWater = this.lineWater[0];
      return;
    }

    const baseDry = dryingRate(trackTempC);
    const traffic = clamp01(carsRunning / FULL_FIELD);
    const lineDry = baseDry * (1 + TRAFFIC_DRYING_BOOST * traffic);
    const offDry = baseDry * (1 + TRAFFIC_DRYING_BOOST * traffic * OFFLINE_TRAFFIC_SHARE);

    let lineSum = 0, offSum = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const pool = this.drainage[i];
      // A dip catches more of what falls and gives it up more slowly, which is
      // the same statement twice: the water has nowhere to go.
      const poolCatch = 1 + pool * 0.35;
      const poolDry = 1 / (1 + pool * 2.2);

      const lineTarget = clamp01(rainRate * LINE_CATCH * poolCatch);
      const offTarget = clamp01(rainRate * OFFLINE_CATCH * poolCatch);

      const lw = this.lineWater[i];
      const ow = this.offWater[i];
      this.lineWater[i] = approach(
        lw, lineTarget, lineTarget > lw ? WETTING_RATE : lineDry * poolDry, step,
      );
      this.offWater[i] = approach(
        ow, offTarget, offTarget > ow ? WETTING_RATE : offDry * poolDry, step,
      );

      lineSum += this.lineWater[i];
      offSum += this.offWater[i];
      if (this.lineWater[i] > peak) peak = this.lineWater[i];
      if (this.offWater[i] > peak) peak = this.offWater[i];
    }
    this.meanLineWater = lineSum / n;
    this.meanOffWater = offSum / n;
    this.peakWater = peak;
  }

  /**
   * Where the water field would be after `seconds`, without integrating it.
   *
   * The pit wall's projection. Deliberately the mean rather than the field: the
   * wall is answering "how wet will the track be", not "how deep will the
   * puddle at turn twelve be", and running the full field forward to answer a
   * question about its average would be an expensive way to get the same
   * number.
   */
  projectLineWater(
    from: number, rainRate: number, trackTempC: number, carsRunning: number, seconds: number,
  ): number {
    const target = clamp01(rainRate * LINE_CATCH);
    const traffic = clamp01(carsRunning / FULL_FIELD);
    const rate = target > from
      ? WETTING_RATE
      : dryingRate(trackTempC) * (1 + TRAFFIC_DRYING_BOOST * traffic);
    return approach(from, target, rate, seconds);
  }

  /** Puts water on the road immediately. For probes; see `Weather.forceRain`. */
  soak(depth: number): void {
    const n = this.lineWater.length;
    let sum = 0, offSum = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const pool = this.drainage[i];
      this.lineWater[i] = clamp01(depth * LINE_CATCH * (1 + pool * 0.35));
      this.offWater[i] = clamp01(depth * OFFLINE_CATCH * (1 + pool * 0.35));
      sum += this.lineWater[i];
      offSum += this.offWater[i];
      peak = Math.max(peak, this.offWater[i]);
    }
    this.meanLineWater = sum / n;
    this.meanOffWater = offSum / n;
    this.peakWater = peak;
  }

  /**
   * How much of the racing-line groove a car at this lateral offset is on,
   * 1 at the centre of it, falling to 0 outside.
   */
  onLineFraction(index: number, lateral: number): number {
    if (!this.track) return 1;
    const d = Math.abs(lateral - this.track.lineOffset[index]);
    const half = this.bandHalf[index] * BAND_FALLOFF;
    return 1 - smoothstep(half * 0.45, half, d);
  }

  /** Water depth a car at this position is driving through, 0..1. */
  waterAt(index: number, lateral: number): number {
    const f = this.onLineFraction(index, lateral);
    return lerp(this.offWater[index], this.lineWater[index], f);
  }

  /**
   * What the SURFACE does to grip here, as a multiplier. 1.0 is clean asphalt.
   *
   * This is not the tyre's wet-grip curve and must not be confused with it. The
   * tyre's curve answers "how much grip does this compound have on water this
   * deep"; this answers "what is this piece of road made of". Rubber under
   * water is slick; unrubbered asphalt when dry is dusty. Both are properties
   * of the road, both are invisible to the compound, and putting them in the
   * same function is what makes the fast line move when it rains and move back
   * when it dries.
   */
  surfaceGripAt(index: number, lateral: number): number {
    if (!this.track) return 1;
    const onLine = this.onLineFraction(index, lateral);
    const water = this.waterAt(index, lateral);
    const rub = this.rubber[index] * onLine;
    // Rubber costs grip in proportion to how wet it is and how much of it there
    // is. Dry, it costs nothing — it is the fastest surface on the circuit, and
    // this whole function returns exactly 1.0.
    return clamp(1 - rub * water * RUBBER_WET_LOSS, 0.4, 1);
  }

  /**
   * How far off the dry line the fast line has moved here, 0..1.
   *
   * 0 means the racing line is the place to be; 1 means get off it. Computed by
   * asking the grip function the same question the driver is asking — is it
   * better on the line or beside it — rather than by thresholding the wetness,
   * so the AI and the physics cannot disagree about where the grip is.
   */
  lineAvoidance(index: number, lateral: number): number {
    if (!this.track) return 0;
    const onLine = this.surfaceGripAt(index, this.track.lineOffset[index]);
    const off = this.surfaceGripAt(index, lateral);
    if (off <= onLine) return 0;
    // Normalised by the rubber penalty AVAILABLE AT THIS NODE, not by the
    // constant. The two differ by a factor of two — the band is heavier at an
    // apex than on a straight — and dividing by the constant asked the driver
    // to judge their move against a penalty that is not there. Against the
    // local figure, 1.0 means "this line escapes the rubber completely", which
    // is a thing a driver can act on and a thing this node's geometry either
    // does or does not permit.
    const available = this.rubber[index] * RUBBER_WET_LOSS;
    if (available <= 1e-6) return 0;
    return clamp01((off - onLine) / available);
  }
}

/** Evaporative drying rate at a given track temperature. */
function dryingRate(trackTempC: number): number {
  // Evaporation climbs steeply with surface temperature. A 50°C track in the
  // sun dries in a fraction of the time a 15°C one under cloud takes, and the
  // exponent is what makes a summer shower a five-minute event and an autumn
  // one an afternoon.
  const t = Math.max(trackTempC, 2) / DRYING_REFERENCE_TEMP_C;
  return DRYING_RATE * clamp(Math.pow(t, 1.6), 0.25, 2.6);
}

/** Exponential approach with an explicit rate, stable at any step size. */
function approach(current: number, target: number, rate: number, dt: number): number {
  const d = target - current;
  if (Math.abs(d) < 1e-5) return target;
  // Rate here is depth-per-second at full separation, so the time constant is
  // 1/rate scaled by how far there is to go.
  const move = rate * dt;
  return Math.abs(d) <= move ? target : current + Math.sign(d) * move;
}

/** In-place box smoothing of a looped field. */
function smoothLoop(a: Float32Array, radius: number): void {
  const n = a.length;
  const src = Float32Array.from(a);
  const span = radius * 2 + 1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[(i + k + n * 2) % n];
    a[i] = sum / span;
  }
}

// ===========================================================================
// The forecast
// ===========================================================================

/** What the pit wall's meteorologist currently believes. */
export interface ForecastReading {
  /** Seconds until the change the wall expects. Counts down; can go negative. */
  etaS: number;
  /** The rain rate it expects, 0..1. */
  intensity: number;
  /** The word for it. */
  precipitation: Precipitation;
  /** 0..1. Never 1: see `MAX_CONFIDENCE`. */
  confidence: number;
  /** True when the wall thinks it is getting wetter, false when drier. */
  worsening: boolean;
}

/**
 * The most certain a pit wall is ever allowed to be.
 *
 * A strategist who is always right is not a strategist, they are an oracle, and
 * an oracle turns the crossover call from a decision into an instruction. The
 * cap is what keeps "do you want to box" a real question. It is also true:
 * teams get radar and a meteorologist and they still get it wrong several times
 * a season, on live television.
 */
const MAX_CONFIDENCE = 0.9;

/** How often the radar is re-read, seconds. */
const RADAR_SWEEP_S = 40;

/**
 * A noisy reading of a schedule it cannot see.
 *
 * The error is deliberately BIASED rather than jittery. A fresh random number
 * every sweep would average out over a few minutes and the wall would converge
 * on the truth just by being asked repeatedly, which is not what a forecast is.
 * Instead each real event gets one persistent set of errors when it is first
 * detected, and the wall's reading tightens toward that biased answer as the
 * event approaches. So the wall can be confidently wrong, which is the only
 * interesting kind of wrong.
 */
export class Forecast {
  private rng: Rng;
  private sweepIn = 0;

  /** The event currently being tracked, and the errors attached to it. */
  private trackedAt = -1;
  private timingBias = 0;
  private intensityBias = 0;
  private undetected = false;
  /** A cell the wall can see that is going to miss the circuit entirely. */
  private phantomUntilS = -1;
  private phantomIntensity = 0;

  private current: ForecastReading | null = null;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** What the wall believes, or null when it expects no change. */
  get reading(): ForecastReading | null {
    return this.current;
  }

  /**
   * Reads the radar.
   *
   * `next` is the truth and this is the only place in the codebase that sees
   * it. Everything the wall knows leaves through `reading`.
   */
  observe(
    dt: number, timeS: number, next: { atS: number; intensity: number } | null,
    rainNow: number, targetRain: number,
  ): void {
    // The countdown runs continuously so the reading is live between sweeps.
    if (this.current) this.current.etaS -= dt;

    this.sweepIn -= dt;
    if (this.sweepIn > 0) return;
    this.sweepIn = RADAR_SWEEP_S;

    // A phantom that has run out of time was wrong, and the wall drops it.
    if (this.phantomUntilS > 0 && timeS > this.phantomUntilS) {
      this.phantomUntilS = -1;
      this.current = null;
    }

    if (!next) {
      // Nothing scheduled. The sky is doing what it is doing. The wall may
      // still be carrying a phantom, and if so it keeps reporting it.
      if (this.phantomUntilS < 0) this.current = null;
      else this.readPhantom(timeS, rainNow);
      return;
    }

    if (next.atS !== this.trackedAt) {
      // A new cell on the radar. Draw its errors ONCE.
      this.trackedAt = next.atS;
      const lead = next.atS - timeS;
      // Timing error grows with lead time: a cell four hundred seconds out can
      // be a minute and a half early or late, and a cell two hundred seconds
      // out cannot.
      this.timingBias = this.rng.range(-0.28, 0.28) * lead;
      this.intensityBias = this.rng.range(-0.3, 0.3);
      // One cell in eight develops too locally to be seen until it is close.
      this.undetected = this.rng.chance(0.12);
      // And one sweep in eight invents one that will miss. Kept separate from
      // the real event so the wall can be tracking a phantom and a real cell at
      // the same time, and report the wrong one.
      if (this.phantomUntilS < 0 && this.rng.chance(0.12)) {
        this.phantomUntilS = timeS + this.rng.range(200, 600);
        this.phantomIntensity = this.rng.range(0.25, 0.9);
      }
    }

    const trueLead = next.atS - timeS;
    if (this.undetected && trueLead > 150) {
      // Not on the radar yet. If a phantom is running, that is what the wall
      // reports — which is how a team ends up boxing for a shower that never
      // comes and then getting caught out by the one that does.
      if (this.phantomUntilS > 0) this.readPhantom(timeS, rainNow);
      else this.current = null;
      return;
    }

    // A phantom closer than the real cell wins the wall's attention.
    if (this.phantomUntilS > 0 && this.phantomUntilS - timeS < trueLead) {
      this.readPhantom(timeS, rainNow);
      return;
    }

    // The reading converges on the truth as the event approaches: the bias is
    // faded out over the last three minutes, because by then the cell is close
    // enough to see rather than to extrapolate.
    const settle = clamp01(trueLead / 200);
    const etaS = Math.max(0, trueLead + this.timingBias * settle);
    const intensity = clamp01(next.intensity + this.intensityBias * settle);
    this.current = {
      etaS,
      intensity,
      precipitation: precipitationOf(intensity),
      // Confidence is a function of how close the event is, capped short of
      // certainty, and knocked down while the wall is extrapolating rather
      // than watching.
      confidence: clamp(
        MAX_CONFIDENCE - settle * 0.5 - (this.undetected ? 0.1 : 0), 0.25, MAX_CONFIDENCE,
      ),
      worsening: intensity > Math.max(rainNow, targetRain * 0.5),
    };
  }

  private readPhantom(timeS: number, rainNow: number): void {
    const etaS = Math.max(0, this.phantomUntilS - timeS);
    this.current = {
      etaS,
      intensity: this.phantomIntensity,
      precipitation: precipitationOf(this.phantomIntensity),
      // A phantom reads exactly like a real cell. It has to: a forecast the
      // player could tell was wrong by looking at its confidence would not be
      // a forecast, it would be a label.
      confidence: clamp(MAX_CONFIDENCE - clamp01(etaS / 200) * 0.5, 0.25, MAX_CONFIDENCE),
      worsening: this.phantomIntensity > rainNow,
    };
  }
}

// ===========================================================================
// The pit wall
// ===========================================================================

/**
 * What the wall needs to know about a car to have an opinion about it.
 *
 * An interface rather than a `CarEntry` so that `PitWall` does not depend on
 * the race engine, which depends on this file. The engine fills it in; a probe
 * fills it in by hand and gets the same decisions.
 */
export interface PitWallContext {
  /** Session time, seconds. */
  timeS: number;
  /** The tyre the car is on. */
  compound: CompoundId;
  /**
   * The slick this car's strategy wants if the track is dry — its plan's next
   * stint. So a car called in for slicks is called in for the right slick.
   */
  dryPreference: CompoundId;
  /** Water depth the car is actually driving through. */
  wetness: number;
  /** Track surface temperature. */
  trackTempC: number;
  /** Laps of the race left to run. */
  lapsRemaining: number;
  /** This circuit's reference lap time, for turning pace into seconds. */
  refLapS: number;
  /** What a stop costs this team here. */
  pitCostS: number;
  /** Dry compounds the car has already used, for Art. 30.5(e). */
  usedDryCompounds: readonly CompoundId[];
  /** Whether the race has been rained on — Art. 30.5(f). */
  hasRained: boolean;
  /** False while the car is in the pit lane, retired, or not yet running. */
  racing: boolean;
  /** Where the wall expects the track to be by the end of its horizon. */
  projectedWetness: number;
  /** How many laps that projection covers. */
  horizonLaps: number;
  /** What the wall's meteorologist believes, if anything. */
  forecast: ForecastReading | null;
}

/** A message from the pit wall, which may or may not carry a question. */
export interface RadioCall {
  /** Identity, so an answer can be matched to the question that was asked. */
  id: number;
  /** What the engineer says. One or two sentences, in their voice. */
  message: string;
  /**
   * The question, if there is one. Absent means this is information and there
   * is nothing to answer — which most radio traffic is.
   */
  question: string | null;
  /** What YES means. */
  action: 'box' | 'stay';
  /** The tyre a YES fits. Null when the answer does not involve a stop. */
  compound: CompoundId | null;
  /** Why, in one line. The reasoning, attached, as the driver would want it. */
  reason: string;
  /** The wall's confidence in the recommendation, 0..1. */
  confidence: number;
  /** Seconds the offer stands before the wall assumes the answer is no. */
  expiresInS: number;
  /** Urgency, for whatever the HUD does with it. */
  priority: 'info' | 'advice' | 'urgent';
}

/** How the driver answered, for whoever is watching. */
export type RadioAnswer = 'yes' | 'no' | 'lapsed';

/**
 * Shortest gap between two calls on the same subject, seconds.
 *
 * A strategist who repeats the question every lap is not offering a choice, and
 * a driver who has said no once has said no. The wall will come back if the
 * situation changes materially — see `materialChange` — but not otherwise.
 */
const REASK_COOLDOWN_S = 75;

/** How long a box offer stands. About a lap at most circuits. */
const OFFER_WINDOW_S = 55;

/**
 * The pit wall, as the thing the player talks to.
 *
 * OWNS THE DECISION, NOT THE DISPLAY. It produces a `RadioCall` and consumes an
 * answer; it knows nothing about buttons, cards or radio audio. That boundary
 * is deliberate and load-bearing: the HUD is being built by somebody else, and
 * the only way both halves can be worked on at once is if the simulation half
 * can be driven and tested with no DOM at all. `probeWeather` does exactly
 * that.
 */
export class PitWall {
  /** The call awaiting an answer, or the last thing said. Null when silent. */
  private call: RadioCall | null = null;
  private nextId = 1;
  private cooldown = 0;
  private lastAdvisedCompound: CompoundId | null = null;
  private lastCase: CrossoverCase | null = null;

  /**
   * Set when the driver says yes to a box call. The engine reads it, brings the
   * car in, and clears it.
   */
  boxRequested = false;
  /** The tyre the driver agreed to. */
  requestedCompound: CompoundId | null = null;

  /** What the wall is saying, if anything. */
  get pending(): RadioCall | null {
    return this.call;
  }

  /** Whether there is a question outstanding. */
  get awaitingAnswer(): boolean {
    return this.call !== null && this.call.question !== null;
  }

  /** The arithmetic behind the current call, for a HUD that wants to show it. */
  get reasoning(): CrossoverCase | null {
    return this.lastCase;
  }

  /**
   * The driver's answer.
   *
   * Ignores an answer to a question that is no longer being asked, which is not
   * defensive programming — a button press and a call expiring are two
   * independent clocks and they will race.
   */
  answer(id: number, yes: boolean): RadioAnswer {
    const call = this.call;
    if (!call || call.id !== id || call.question === null) return 'lapsed';
    this.call = null;
    this.cooldown = REASK_COOLDOWN_S;
    if (!yes) return 'no';
    if (call.action === 'box') {
      this.boxRequested = true;
      this.requestedCompound = call.compound;
    } else {
      // "Stay out" answered yes is an instruction to cancel a stop, not to make
      // one. The engine reads `boxRequested` going false.
      this.boxRequested = false;
      this.requestedCompound = null;
    }
    return 'yes';
  }

  /** The engine calls this once it has actually served the stop. */
  onServed(): void {
    this.releaseStanding();
  }

  /**
   * The driver has waved off a stop they had already agreed to.
   *
   * `boxRequested` is a LATCH, not an event — it stands from the yes on the
   * radio until the stop is served — and the engine mirrors it onto
   * `car.pitRequested` on every physics step. So there has to be a way to let
   * the latch go that is not "the stop happened", or the PIT button cannot
   * cancel a stop the wall called: the mirror simply puts the request back on
   * the next step, along with the wall's tyre. That is exactly what it did.
   * See `RaceEngine.requestPit`.
   *
   * It takes the re-ask cooldown for the same reason a "no" does. A driver who
   * has just waved a stop off does not want to be asked again eight
   * milliseconds later, and without the cooldown that is precisely what the
   * next call to `update` would do.
   */
  withdraw(): void {
    this.releaseStanding();
  }

  /**
   * Lets the standing call go, and holds the radio for a while.
   *
   * The two ways a standing call ends — served, or waved off — leave the wall
   * in the same state, and they are kept as separate verbs because the CALLER
   * knows which happened and the wall does not. The cooldown is the part that
   * matters: without it the very next `update` would ask again, eight
   * milliseconds after the driver settled the question.
   */
  private releaseStanding(): void {
    this.boxRequested = false;
    this.requestedCompound = null;
    this.cooldown = REASK_COOLDOWN_S;
  }

  /** Clears everything. Session change, retirement, red flag. */
  reset(): void {
    this.call = null;
    this.boxRequested = false;
    this.requestedCompound = null;
    this.cooldown = 0;
    this.lastAdvisedCompound = null;
    this.lastCase = null;
  }

  /**
   * Decides whether there is anything worth saying.
   *
   * Called every physics step by the engine; almost every call returns having
   * done a countdown and nothing else.
   */
  update(dt: number, ctx: PitWallContext): void {
    this.cooldown -= dt;

    if (this.call) {
      this.call.expiresInS -= dt;
      if (this.call.expiresInS <= 0) {
        // Silence is an answer. The wall assumes the driver is busy and does
        // not ask again for a while.
        this.call = null;
        this.cooldown = REASK_COOLDOWN_S;
      }
      return;
    }
    if (!ctx.racing || this.cooldown > 0 || this.boxRequested) return;

    const available = availableTo(ctx);
    const horizonS = ctx.horizonLaps * ctx.refLapS;
    // The candidates are the tyre on the car and the tyre the conditions want —
    // evaluated at the PROJECTED wetness, because the wall is deciding what to
    // be on in three laps, not what it should have been on three laps ago. See
    // `crossoverCandidates` for why the set has to be restricted at all.
    const candidates = crossoverCandidates(
      ctx.compound, Math.max(ctx.wetness, ctx.projectedWetness), ctx.trackTempC,
      ctx.dryPreference, available,
    );
    const c = forecastCrossoverCase(
      ctx.compound, ctx.wetness, ctx.projectedWetness, ctx.horizonLaps,
      ctx.trackTempC, ctx.refLapS, ctx.pitCostS, ctx.lapsRemaining, candidates,
    );
    this.lastCase = c;

    if (c.worthIt && c.best !== this.lastAdvisedCompound) {
      this.call = this.buildBoxCall(ctx, c, horizonS);
      this.lastAdvisedCompound = c.best;
      return;
    }

    // Nothing to recommend, but a change the driver cannot see yet is worth
    // saying out loud. This is the call that makes the forecast a THING the
    // player experiences rather than a number the AI acts on privately.
    const f = ctx.forecast;
    if (f && f.confidence >= 0.5 && f.etaS > 20 && f.etaS < horizonS * 1.3) {
      const changing = Math.abs(f.intensity - clamp01(ctx.wetness)) > 0.25;
      if (changing) {
        this.call = this.buildInfoCall(f);
        this.cooldown = REASK_COOLDOWN_S;
      }
    }
  }

  private buildBoxCall(
    ctx: PitWallContext, c: CrossoverCase, horizonS: number,
  ): RadioCall {
    const name = getCompound(c.best).name.toUpperCase();
    const f = ctx.forecast;
    const laps = Math.max(1, Math.round(horizonS / Math.max(ctx.refLapS, 1)));

    // The reasoning, in the two quantities the decision actually turns on.
    const reason =
      `${c.lossPerLapS.toFixed(1)}s a lap on this tyre, ${c.pitCostS.toFixed(1)}s for the stop — ` +
      `pays back in ${Math.ceil(c.breakEvenLaps)} laps, ${c.lapsRemaining} to go.`;

    let message: string;
    if (isWetCompound(c.best) && !isWetCompound(ctx.compound)) {
      message = f && f.etaS > 20
        ? `Rain reaching us in about ${Math.round(f.etaS / 60)} minutes. We want ${name}.`
        : `Track's going away from you out there. We want ${name}.`;
    } else if (!isWetCompound(c.best) && isWetCompound(ctx.compound)) {
      message = `Line's drying, ${name} is the tyre now. Crossover's here.`;
    } else {
      message = `We think ${name} is the tyre for the next ${laps} laps.`;
    }

    return {
      id: this.nextId++,
      message,
      question: 'Box this lap?',
      action: 'box',
      compound: c.best,
      reason,
      confidence: f ? f.confidence : 0.75,
      expiresInS: OFFER_WINDOW_S,
      priority: c.lossPerLapS > 3 ? 'urgent' : 'advice',
    };
  }

  private buildInfoCall(f: ForecastReading): RadioCall {
    const mins = Math.max(1, Math.round(f.etaS / 60));
    const sure = f.confidence > 0.75 ? '' : ' Not certain on it.';
    const message = f.worsening
      ? `Radar has ${f.precipitation} reaching us in about ${mins} minute${mins === 1 ? '' : 's'}.${sure}`
      : `Cell's moving through. Should start drying in about ${mins} minute${mins === 1 ? '' : 's'}.${sure}`;
    return {
      id: this.nextId++,
      message,
      question: null,
      action: 'stay',
      compound: null,
      reason: `Confidence ${Math.round(f.confidence * 100)}%. Staying out for now.`,
      confidence: f.confidence,
      expiresInS: 12,
      priority: 'info',
    };
  }
}

/** Compounds this car may fit, given the two-compound rule. */
function availableTo(ctx: PitWallContext): CompoundId[] {
  if (ctx.hasRained) return [...ALL_COMPOUNDS];
  // The margin is generous here on purpose: the wall thinks about the second
  // compound well before it becomes urgent, which is why a real team's tyre
  // plan is never a surprise to them.
  if (ctx.lapsRemaining > 30) return [...ALL_COMPOUNDS];
  const used = new Set(ctx.usedDryCompounds);
  if (used.size >= 2) return [...ALL_COMPOUNDS];
  return ALL_COMPOUNDS.filter((c) => getCompound(c).isWetWeather || !used.has(c));
}

/**
 * The wet-weather tyre the conditions call for, or null when they call for a
 * slick.
 *
 * A thin reading of `conditionsCompound` in the form the engine's
 * `compoundForStint` wants — it has its own answer for which slick, from the
 * car's plan, and only needs to know whether the weather overrides it.
 */
export function wetCompoundFor(wetness: number, trackTempC: number): CompoundId | null {
  if (wetness >= interToWetWetness(trackTempC)) return 'wet';
  if (wetness >= slickToInterWetness(trackTempC)) return 'intermediate';
  return null;
}

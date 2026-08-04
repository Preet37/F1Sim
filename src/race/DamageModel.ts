import { clamp, clamp01 } from '../core/MathUtils';
import type { VehicleSpec } from '../physics/VehicleSpec';

/**
 * Per-component car damage.
 *
 * This replaces a single `aeroDamage` scalar. One number could say the car was
 * hurt but not *how*, so every incident produced the same symptom — a bit less
 * downforce — regardless of whether the driver clipped a wall with the left
 * front or dropped two wheels onto a kerb at 300 km/h. Splitting it into
 * components means damage has a shape: a front-left hit understeers away from
 * the corner it was carrying speed into, a floor strike costs the ground effect
 * that the whole car depends on, and a broken gearbox costs time on every
 * upshift for the rest of the race.
 *
 * Every component feeds a real term in the vehicle spec, so damage is never
 * cosmetic — the HUD's readout is the same number the physics is using.
 *
 * Health runs 1 (perfect) to 0 (destroyed). Components have floors below which
 * they cannot fall without the car retiring, because a car with literally zero
 * downforce cannot take a corner at all and simply spears off, taking others
 * with it. That was the failure mode of the unbounded version.
 */

export type ComponentId =
  | 'frontWingL' | 'frontWingR'
  | 'rearWing'
  | 'floor'
  | 'sidepodL' | 'sidepodR'
  | 'suspFL' | 'suspFR' | 'suspRL' | 'suspRR'
  | 'engine'
  | 'gearbox';

export const COMPONENT_IDS: readonly ComponentId[] = [
  'frontWingL', 'frontWingR', 'rearWing', 'floor',
  'sidepodL', 'sidepodR',
  'suspFL', 'suspFR', 'suspRL', 'suspRR',
  'engine', 'gearbox',
];

/** Human-readable names, for the HUD and race control messages. */
export const COMPONENT_NAMES: Record<ComponentId, string> = {
  frontWingL: 'Front wing (L)',
  frontWingR: 'Front wing (R)',
  rearWing: 'Rear wing',
  floor: 'Floor',
  sidepodL: 'Sidepod (L)',
  sidepodR: 'Sidepod (R)',
  suspFL: 'Suspension (FL)',
  suspFR: 'Suspension (FR)',
  suspRL: 'Suspension (RL)',
  suspRR: 'Suspension (RR)',
  engine: 'Power unit',
  gearbox: 'Gearbox',
};

/** Where on the car an impact landed, so damage lands on the right parts. */
export type ImpactZone = 'front' | 'rear' | 'left' | 'right' | 'floor';

/**
 * WHAT took the health off — the ledger, not the physics.
 *
 * Issue #26 was closed twice on a mechanism that turned out to be wrong, and
 * the third diagnosis ("a damage cascade") arrived as a CORRELATION: 20 of 26
 * retiring cars were already carrying a component below 0.70 the last time
 * they were racing. A correlation has two directions and the fix is different
 * for each of them. If a car is broken by RACING CONTACT and then cannot hold
 * the road, the leverage is on the contact rate. If it is broken by the
 * BARRIER during excursions it was going to have anyway, the damage is a
 * symptom and cutting the contact rate moves nothing.
 *
 * So every loss is booked against its cause and the diagnostic prints the
 * split. Costs one addition per component per event; nothing reads it in the
 * game.
 */
export type DamageSource = 'contact' | 'solid' | 'wear';

/**
 * The four pieces of bodywork that can leave the car whole.
 *
 * Distinct from `ComponentId`, which is what the damage model tracks: the front
 * wing is two components because each half can be damaged separately, and one
 * PART because it is one assembly on two mounts and losing either side takes
 * the whole thing off.
 */
export type BodyPartId = 'frontWing' | 'rearWing' | 'sidepodL' | 'sidepodR';

export const BODY_PART_IDS: readonly BodyPartId[] = [
  'frontWing', 'rearWing', 'sidepodL', 'sidepodR',
];

/**
 * Health below which a part is no longer on the car.
 *
 * This used to be a private constant in `Renderer`, which is where the decision
 * that a part had come off was made — so the SIMULATION did not know a wing had
 * left the car, and could not put its carbon in the ledger that raises a flag
 * for it. Here, both halves read the same number.
 */
export const PART_DETACH_HEALTH = 0.3;
/** Health above which a part has been refitted in the pits. */
export const PART_REPAIR_HEALTH = 0.85;

/**
 * Roughly what each part measures, metres, as (across, up, along).
 *
 * Real dimensions of the object, not of the mesh that stands in for it: the
 * ledger is part of the simulation and the simulation has no mesh. A 2026 front
 * wing spans the full 2.0m regulation width, a rear wing assembly is about a
 * metre across and half a metre tall, and a sidepod is a long, deep, shallow
 * thing running most of the length of the car's midsection.
 */
export const PART_SIZE_M: Record<BodyPartId, readonly [number, number, number]> = {
  frontWing: [2.0, 0.28, 0.85],
  rearWing: [1.05, 0.5, 0.55],
  sidepodL: [0.62, 0.55, 2.1],
  sidepodR: [0.62, 0.55, 2.1],
};

export class CarDamage {
  /** Health per component, 1 = pristine. */
  readonly health: Record<ComponentId, number> = {
    frontWingL: 1, frontWingR: 1, rearWing: 1, floor: 1,
    sidepodL: 1, sidepodR: 1,
    suspFL: 1, suspFR: 1, suspRL: 1, suspRR: 1,
    engine: 1, gearbox: 1,
  };

  /** True once any component has been hurt at all — cheap check for the HUD. */
  anyDamage = false;

  /**
   * Total health lost, by cause, over the session. Diagnostic only.
   *
   * Never reset by `repair()`: this is the ledger of what happened to the car,
   * not its current condition, and a stop that refits a nose does not un-hit
   * the barrier. `reset()` clears it because that is a new session.
   */
  readonly lostBy: Record<DamageSource, number> = { contact: 0, solid: 0, wear: 0 };

  /** How many separate impacts of each kind the car has taken. */
  readonly hitsBy: Record<DamageSource, number> = { contact: 0, solid: 0, wear: 0 };

  /**
   * Health lost since the spec was last rebuilt.
   *
   * `applyTo` allocates a new spec object, and wear accrues on every one of the
   * 120 physics steps per second for all twenty cars. Rebuilding unconditionally
   * would allocate 2,400 specs a second and hand the garbage collector a pause
   * at exactly the wrong moment. Instead the change is accumulated and the spec
   * is rebuilt only once it is large enough to matter, which for gradual wear
   * is a few times a lap.
   */
  private pendingChange = 0;

  /** True when accrued damage is worth rebuilding the vehicle spec for. */
  get specDirty(): boolean {
    return this.pendingChange > 0.004;
  }

  /**
   * Applies an impact.
   *
   * @param zone     which face took the hit
   * @param severity 0..1, already normalised from closing speed by the caller
   * @param writeOff true when this impact ended the car's session, which is a
   *                 decision only the race engine can make — see the note on
   *                 the destruction term below
   * @returns the components that crossed into a visibly worse state, so race
   *          control can report the specific failure rather than "damage"
   */
  applyImpact(
    zone: ImpactZone, severity: number, writeOff = false, source: DamageSource = 'contact',
  ): ComponentId[] {
    const s = clamp01(severity);
    if (s <= 0.001) return [];
    this.hitsBy[source]++;

    // Spread per zone. A front impact destroys wing endplates first; a side
    // impact takes the sidepod and the suspension on that side; anything hard
    // enough shakes the gearbox and the power unit a little regardless.
    //
    // THE SIDE ZONE'S SUSPENSION WEIGHT WAS 0.6 AND IT WAS THE LARGEST SINGLE
    // WEIGHT ON AN UNREPAIRABLE COMPONENT ANYWHERE IN THIS TABLE — larger than
    // the 0.35 a square nose-first impact puts on the same corner, which cannot
    // be right in either direction. A nose-first hit loads the front uprights
    // through the wheels and the pushrods; a sidepod-to-sidepod rub loads the
    // bodywork and reaches the suspension only through whatever the wheels did,
    // which is less. It mattered because `applyTo` weights the WORST corner
    // (`0.2 * suspMin`) and because a pit stop replaces the nose and the sidepod
    // panels and cannot touch a suspension corner — so this one number turned
    // every side rub into a permanent mechanical-grip penalty for the rest of
    // the race. Measured: twenty ordinary side contacts left `baseMu` at 88.3%
    // of pristine, against the 0.90 the AI's own `commitmentScale` leaves
    // itself, so the car was asking a corner for more grip than it had on every
    // lap. At the front zone's 0.35 the same twenty leave it at 93.2%.
    // Issue #26.
    const spread: Partial<Record<ComponentId, number>> =
      zone === 'front' ? { frontWingL: 1.0, frontWingR: 1.0, suspFL: 0.35, suspFR: 0.35, floor: 0.2 }
      : zone === 'rear' ? { rearWing: 1.0, suspRL: 0.4, suspRR: 0.4, gearbox: 0.3, engine: 0.15 }
      : zone === 'left' ? { sidepodL: 1.0, suspFL: 0.35, suspRL: 0.35, frontWingL: 0.5, floor: 0.3 }
      : zone === 'right' ? { sidepodR: 1.0, suspFR: 0.35, suspRR: 0.35, frontWingR: 0.5, floor: 0.3 }
      : { floor: 1.0, sidepodL: 0.2, sidepodR: 0.2 };

    // How much of a component a full-weight hit takes off.
    //
    // Two terms, because "an impact" covers two things that are not the same
    // event. The linear term is RACING CONTACT: wheels touched, a car was
    // nudged into a wall on the exit of a corner, somebody was optimistic into
    // turn one. Those accumulate — roughly three of them to the same corner
    // before the part is beyond use — and that is the right feel for them.
    //
    // The second term is DESTRUCTION, and it applies only when the caller has
    // already decided this impact ends the car's session. Without it a written
    // off car kept immaculate bodywork: a 200 km/h square-on hit produced a
    // severity of 1.0, retired the car on the spot, and left the front wing at
    // 68% health — undamaged enough to still be attached. The car was destroyed
    // with nothing to show for it, so nothing fell off, and the wreck was a
    // pristine car standing still. That is half of the "it just poof gone"
    // report: even when the crash was drawn, it did not look like one.
    //
    // Why it is gated on `writeOff` rather than on severity crossing a
    // threshold: severity saturates at 1.0 far too easily for it to stand in
    // for "this was an accident". An AI car running wide and touching a barrier
    // at 120 km/h and 45 degrees reads 1.0, and it happens constantly. Scaling
    // destruction off severity alone therefore tore the bodywork off cars that
    // were still racing, which cost them grip, which made them run wide again —
    // a feedback loop that took Silverstone from thirteen finishers out of
    // twenty to eight. Tying it to the retirement decision instead means the
    // extra damage can only ever land on a car whose session is already over,
    // where by construction it cannot affect anybody's race.
    const rate = writeOff ? s * 0.32 + 0.85 : s * 0.32;

    const broken: ComponentId[] = [];
    for (const id of COMPONENT_IDS) {
      const w = spread[id];
      if (!w) continue;
      const before = this.health[id];
      const loss = rate * w;
      // WHAT ONE IMPACT MAY EVENTUALLY DO, however many times it is repeated —
      // issue #26's third cause, and the link this closes.
      //
      // The linear term above is a RATCHET: it takes `rate * w` off whatever is
      // left, every time, with no reference to how hard the hit was. So a
      // sequence of ordinary racing touches walks a component all the way to
      // `COMPONENT_FLOORS[id]` — and `COMPONENT_FLOORS` is not a survivable condition, it is the
      // last value before the car cannot corner at all. Measured on merged
      // `main` at issue #26's own configuration: the field's worst component
      // falls 0.94 -> 0.50 over a Grand Prix and its minimum is 0.10, which is
      // the front wing's floor exactly; 72% of all the health the field loses
      // is car-to-car contact, over 113.5 damaging impacts a race; and the rate
      // at which a car leaves the road rises monotonically with how broken it
      // is — x1.0, x1.4, x1.6, x1.9 and x3.8 per car-second on the road as the
      // worst component falls through 0.95, 0.85, 0.70 and 0.50. Eleven cars a
      // race then end up in the gravel with nobody near them.
      //
      // The missing statement is that damage is a function of the ENERGY of the
      // impact and not only of what is still intact. A 25 km/h wheel rub does
      // not become a broken upright because it is the fourth one: each hit
      // finds the part further back from the edge, less exposed and better
      // supported, and the same blow does progressively less. So a
      // non-terminal impact may wear a component down to the damage ONE such
      // impact would do at full rate — `1 - s * w` — and no further.
      //
      // Derived, not chosen: `s * w` is exactly the loss the linear term would
      // produce with `rate = 1`, so the bound is the model's own worst case for
      // a single hit of this severity on this component. It leaves the
      // three-hits-to-strip-a-wing ladder that `probe:damage` asserts intact —
      // a 0.8 hit still bottoms the front wing at 0.20, under the 0.30 detach
      // threshold — while a race of 0.5 and 0.6 severity touches can no longer
      // walk a suspension corner to 0.25.
      //
      // `writeOff` bypasses it entirely. An impact the engine has already
      // judged terminal is not racing contact and must still destroy the car,
      // which is the other half of this and is asserted in both directions by
      // `probe:cascade` and `probe:damage`.
      const bound = writeOff ? COMPONENT_FLOORS[id] : Math.max(COMPONENT_FLOORS[id], 1 - s * w);
      const after = clamp(before - loss, Math.min(bound, before), 1);
      this.health[id] = after;
      // Report only when a component crosses a threshold, so a graze does not
      // spam the radio.
      if (bandOf(before) !== bandOf(after)) broken.push(id);
      this.pendingChange += before - after;
      this.lostBy[source] += before - after;
    }
    this.anyDamage = true;
    return broken;
  }

  /**
   * Slow attrition: kerbs, gravel and simply running the car hard.
   *
   * Small per-second rates, so this matters over a race distance rather than
   * over a corner. It is what makes a long stint of riding the kerbs cost
   * something, which is the whole point of a track-limits rule having teeth.
   */
  applyWear(dt: number, surface: string, speedMs: number, rpmFraction: number): void {
    const fast = clamp01(speedMs / 80);
    if (surface === 'curb') {
      this.wear('floor', 0.00045 * fast * dt);
      this.wear('suspFL', 0.0003 * fast * dt);
      this.wear('suspFR', 0.0003 * fast * dt);
    } else if (surface === 'gravel' || surface === 'grass') {
      // An excursion is rarer but much harsher than a kerb: a few seconds in
      // the gravel should cost a few percent of the floor.
      this.wear('floor', 0.004 * fast * dt);
      this.wear('sidepodL', 0.0012 * fast * dt);
      this.wear('sidepodR', 0.0012 * fast * dt);
    }
    // Sustained high rpm is what actually kills an engine over a season.
    //
    // Sized so a full race distance driven hard costs a few percent. The first
    // version of this ran at 0.0016/s, which sounds negligible and is not: a
    // car spends roughly a third of a race above this threshold, so over 5,000
    // seconds it drove every engine on the grid into its floor and quietly took
    // 31% of everyone's power away. The validation harness caught it as "AI is
    // far too slow" on six circuits.
    if (rpmFraction > 0.93) this.wear('engine', 0.00002 * dt);
  }

  private wear(id: ComponentId, amount: number): void {
    if (amount <= 0) return;
    const before = this.health[id];
    this.health[id] = clamp(before - amount, COMPONENT_FLOORS[id], 1);
    if (this.health[id] < before) {
      this.anyDamage = true;
      this.pendingChange += before - this.health[id];
      this.lostBy.wear += before - this.health[id];
    }
  }

  /** Repairs everything, for a pit stop that fits a new wing or a new session. */
  repair(...ids: ComponentId[]): void {
    const list = ids.length > 0 ? ids : COMPONENT_IDS;
    for (const id of list) this.health[id] = 1;
    this.anyDamage = COMPONENT_IDS.some((id) => this.health[id] < 0.999);
    // Force a rebuild: the car just got its performance back.
    this.pendingChange = 1;
  }

  /** Worst component, for the HUD's summary line. */
  worst(): { id: ComponentId; health: number } {
    let id: ComponentId = 'engine';
    let health = 2;
    for (const c of COMPONENT_IDS) {
      if (this.health[c] < health) { health = this.health[c]; id = c; }
    }
    return { id, health };
  }

  /** Overall condition 0..1, weighted toward whatever is worst. */
  get overall(): number {
    let sum = 0;
    for (const id of COMPONENT_IDS) sum += this.health[id];
    const mean = sum / COMPONENT_IDS.length;
    // Bias to the worst part: a car with one destroyed wing is not "92% fine".
    return clamp01(mean * 0.45 + this.worst().health * 0.55);
  }

  /**
   * Derives the damaged spec from the pristine one.
   *
   * Always computed from `base`, never from the current spec. Applying a
   * multiplier to an already-multiplied spec compounds every frame, and the
   * car silently decays to zero performance while the health numbers look fine.
   */
  applyTo(base: VehicleSpec): VehicleSpec {
    this.pendingChange = 0;
    const h = this.health;

    // Aero. The floor carries most of a ground-effect car's downforce, so it is
    // weighted hardest; the wings trim the balance around it.
    const frontAero = (h.frontWingL + h.frontWingR) * 0.5;
    const aero = clamp(
      0.42 * h.floor + 0.2 * frontAero + 0.2 * h.rearWing + 0.09 * h.sidepodL + 0.09 * h.sidepodR,
      0.5, 1,
    );

    // Aero balance shifts toward whichever end still has its wing. A damaged
    // front wing understeers, a damaged rear wing is loose — the two failures
    // feel completely different from the driver's seat, which is the point.
    const balanceShift = (frontAero - h.rearWing) * 0.06;

    // Mechanical grip from suspension integrity, worst-corner weighted.
    const suspMin = Math.min(h.suspFL, h.suspFR, h.suspRL, h.suspRR);
    const suspMean = (h.suspFL + h.suspFR + h.suspRL + h.suspRR) * 0.25;
    const grip = clamp(0.55 + 0.25 * suspMean + 0.2 * suspMin, 0.62, 1);

    return {
      ...base,
      clBase: base.clBase * aero,
      // A broken wing is also a broken *shape*: it sheds downforce without
      // shedding the drag that came with it.
      cdBase: base.cdBase * (1 + (1 - aero) * 0.35),
      aeroBalanceFront: clamp(base.aeroBalanceFront + balanceShift, 0.3, 0.6),
      baseMu: base.baseMu * grip,
      icePowerW: base.icePowerW * clamp(0.55 + 0.45 * h.engine, 0.55, 1),
      // A damaged gearbox lengthens every shift for the rest of the race.
      driveEfficiency: base.driveEfficiency * clamp(0.8 + 0.2 * h.gearbox, 0.8, 1),
    };
  }

  reset(): void {
    for (const id of COMPONENT_IDS) this.health[id] = 1;
    this.anyDamage = false;
    this.pendingChange = 0;
    this.lostBy.contact = 0; this.lostBy.solid = 0; this.lostBy.wear = 0;
    this.hitsBy.contact = 0; this.hitsBy.solid = 0; this.hitsBy.wear = 0;
  }
}

/**
 * Minimum health per component.
 *
 * Nothing may reach zero. A car with no downforce or no grip cannot negotiate a
 * corner at any speed, so it leaves the circuit immediately and usually takes
 * someone with it; the race engine retires a car long before this matters, and
 * these floors exist so the few frames in between stay survivable.
 */
export const COMPONENT_FLOORS: Record<ComponentId, number> = {
  frontWingL: 0.1, frontWingR: 0.1, rearWing: 0.15, floor: 0.2,
  sidepodL: 0.1, sidepodR: 0.1,
  suspFL: 0.25, suspFR: 0.25, suspRL: 0.25, suspRR: 0.25,
  engine: 0.3, gearbox: 0.35,
};

/** Condition bands, used for colour and for deciding when to report a failure. */
export function bandOf(health: number): 'ok' | 'worn' | 'damaged' | 'critical' {
  if (health > 0.85) return 'ok';
  if (health > 0.6) return 'worn';
  if (health > 0.3) return 'damaged';
  return 'critical';
}

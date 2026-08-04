/**
 * WHEN THE LIGHT ON THE BACK OF THE CAR IS ON, AND WHEN IT FLASHES.
 *
 * No THREE, no DOM, no renderer state — the same reason `RenderPose.ts` and
 * `AutoTierPolicy` exist. The rule lives here so `probe:effects` can drive THE
 * REAL RULE rather than a probe-side copy of it, and so the one place that
 * decides "lit or not" is readable next to the articles it is quoting.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO BRAKE LIGHT ON A FORMULA 1 CAR, AND ISSUE #19 ASKED FOR ONE
 * ---------------------------------------------------------------------------
 *
 * The request was *"brake lights do not respond to braking"*, and the honest
 * answer is that they cannot, because there are none. The phrase "brake light"
 * does not appear anywhere in the 2025 or 2026 Formula 1 Technical or Sporting
 * Regulations. What is on the back of the car is a RAIN LIGHT — three of them,
 * since 2026 — governed by:
 *
 *   Technical C14.3.1  "All cars must have three rear lights which... b. Are
 *                      clearly visible from the rear. c. Can be switched on by
 *                      the driver when seated normally in the car."
 *   Technical C14.3.2  the central light: rear face at least 750mm behind
 *                      XDIF=0, centre on Y=0, between Z=295 and Z=305.
 *   Technical C14.3.3  "Two further lights must be fitted, one on each side of
 *                      the car", inside the rear wing endplate body, lying "in
 *                      its entirety between Z=700 and Z=870".
 *   Sporting  B1.5.5(a) (2025: Art. 26.11) — the lights described in C14.3
 *                      "must be illuminated at all times when using
 *                      intermediate or wet-weather tyres".
 *
 * So the only MANDATORY illumination rule keys off the TYRE, and that is the
 * first term below. Fitting a brake light to satisfy the issue literally would
 * have been inventing a part that no Formula 1 car has ever carried, on a
 * project whose standing instruction is that the reference images are the
 * specification. Reference `90.png` is a night frame at Bahrain on slicks and
 * there is no light of any kind lit on either car in it.
 *
 * WHAT THE ISSUE IS ACTUALLY DESCRIBING, AND WHAT IS NOW MODELLED. Watch an
 * onboard from behind a car in the wet and the rain light visibly FLASHES as
 * the car brakes and goes steady again on the throttle. That is real, and it is
 * not a brake light: the standard rear-light unit flashes while the MGU-K is
 * recovering energy, and the MGU-K recovers under braking. The two are the same
 * event seen from two ends. So the light responds to the brake pedal, via the
 * mechanism that actually causes it.
 *
 * THE FLASH IS NOT CITED TO AN ARTICLE AND MUST NOT BE. The rear light is a
 * Standard Supply Component (C14.3.4) whose specification is FIA-F1-DOC-025,
 * which is not published, and the words "flash" and "flashing" appear nowhere
 * in either regulation set in connection with it. This is modelled on what the
 * units visibly do on track. Saying so is the point: §3.6 of PROJECT.md asks
 * for articles, and an article that does not exist must not be manufactured to
 * fill the slot.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY IT WAS BACKWARDS
 * ---------------------------------------------------------------------------
 *
 * `Renderer.syncCars` used to compute one boolean — is an intermediate or wet
 * tyre fitted — and hand it to `setRainLight` together with a free-running 2Hz
 * sine that was applied WHENEVER THE LIGHT WAS ON. That is exactly inverted
 * against the real unit, which is STEADY when switched on and flashes only
 * under recovery. The consequence on screen was that the light pulsed for the
 * whole of every wet lap and did nothing whatsoever when the car braked, so it
 * carried no information at all: the one thing a driver reads a light ahead of
 * them for — that the car in the spray is slowing down — was the one state it
 * could not show.
 */

/** Everything the decision depends on. One car, one frame. */
export interface RearLightInputs {
  /** An intermediate or wet-weather tyre is fitted. Sporting B1.5.5(a). */
  wetTyre: boolean;
  /**
   * The Race Director has declared low visibility.
   *
   * NOT a Technical or Sporting article: the instruction to run with lights on
   * in poor visibility lives in the Event Notes, which are per-event documents.
   * C14.3.1(c) is what makes it possible — the driver can switch them on — and
   * `RaceControlManager.lowVisibility` is this game's model of the call being
   * made. Reference `77.png` is that case: a red flag in the wet with the car
   * ahead lit up.
   */
  lowVisibility: boolean;
  /**
   * MGU-K recovery right now, as a fraction of the unit's peak. `ersHarvestW /
   * spec.maxHarvestW`.
   *
   * This field existed on `VehiclePhysics` and was read by NOTHING before this
   * module. It is set every step and reset every step; the recovery was being
   * simulated and thrown away.
   */
  harvestFrac: number;
  /** False for a car that has been recovered off the circuit. */
  running: boolean;
}

export interface RearLightState {
  /** The lamp is switched on at all. */
  on: boolean;
  /** It is in its flashing mode rather than steady. */
  flashing: boolean;
}

/**
 * Recovery above this fraction of the MGU-K's peak puts the unit into flash.
 *
 * Not a published figure — see the header. It is set from what the model
 * produces rather than chosen: `VehiclePhysics` computes recovery as
 * `maxHarvestW * mode.harvest * brake` clamped by the battery's remaining
 * headroom, and `mode.harvest` runs 0.6 (overtake) to 1.4 (harvest), so a third
 * of peak is roughly a quarter to a half of the brake pedal in every mode. That
 * is a genuine braking event and not a trailed brake into a fast corner, which
 * is the distinction the flash is supposed to draw.
 */
export const HARVEST_FLASH_FRAC = 0.33;

/**
 * Flash rate, Hz.
 *
 * NOT a regulation figure, for the reason in the header. 4Hz is what the units
 * visibly do under recovery, and it is deliberately twice the 2Hz the old
 * always-on pulse ran at so that the two states cannot be confused: steady is
 * steady, and a flash is unmistakably a flash.
 */
export const REAR_LIGHT_FLASH_HZ = 4;

/** The lamp's state for one car, this frame. */
export function rearLightState(i: RearLightInputs): RearLightState {
  if (!i.running) return { on: false, flashing: false };
  const on = i.wetTyre || i.lowVisibility;
  // The flash is a property of the lamp, so it can only happen while the lamp
  // is on. A car on slicks in the dry recovering hard under braking shows
  // nothing, which is what a dry race looks like.
  return { on, flashing: on && i.harvestFrac >= HARVEST_FLASH_FRAC };
}

/**
 * Drawn brightness, 0..1, from the state and a wall-clock phase in seconds.
 *
 * Steady is 1. The flash is a SQUARE wave rather than a sine: the unit is an
 * LED array being switched, not a filament cooling down, and a sine reads as a
 * slow breathing pulse — which is precisely what the old code did and what made
 * a wet lap look like the car was idling rather than braking. The off half is
 * 0.18 rather than 0, because an LED array photographed at 4Hz through spray
 * never fully disappears between flashes and a hard 0 strobes unpleasantly.
 */
export function rearLightLevel(state: RearLightState, timeS: number): number {
  if (!state.on) return 0;
  if (!state.flashing) return 1;
  const phase = (timeS * REAR_LIGHT_FLASH_HZ) % 1;
  return phase < 0.5 ? 1 : 0.18;
}

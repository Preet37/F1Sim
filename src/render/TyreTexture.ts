import * as THREE from 'three';
import { TIRE_COMPOUNDS, type CompoundId } from '../data/tires';
import { tyreSurfaceMap } from './DetailMaps';

/**
 * Tyres.
 *
 * An open-wheel car shows more tyre than bodywork from most angles. Four black
 * cylinders is therefore not a small omission — it is the single largest flat
 * area in almost every frame, and until it has structure in it nothing else on
 * the car matters much.
 *
 * A real Formula 1 tyre, in the order the eye picks the features out:
 *
 *  1. THE COMPOUND STRIPE. A coloured band around the outer sidewall — red for
 *     the soft, yellow medium, white hard, green intermediate, blue wet. It is
 *     the most saturated thing on an otherwise black object and it is what
 *     makes a wheel read as a racing tyre rather than as a wheel.
 *  2. SIDEWALL LETTERING, repeating four or five times around. Raised, so it
 *     catches light differently from the wall it sits on.
 *  3. THE SHOULDER. The tread does not meet the sidewall at a corner; it turns
 *     over a radius, and that turn is where the surface goes from the scuffed
 *     matte of the contact patch to the smoother, glossier moulded sidewall.
 *     Getting the roughness split right across that turn is most of what makes
 *     the tyre look like rubber.
 *  4. TREAD SURFACE. A slick is not smooth: it is faintly striated around its
 *     circumference from the moulding and from being dragged across asphalt,
 *     and it picks up a broad graining across the middle where it works.
 *
 * All four are graphics, so they are painted into a canvas, and the tyre's
 * surface of revolution is given a real parameterisation to carry them: u runs
 * once around the circumference, v runs across the profile from the inboard
 * bead to the outboard one.
 *
 * ONE TEXTURE PER COMPOUND, SHARED BY THE WHOLE FIELD. There are five
 * compounds, so five textures serve twenty cars — and because the wheels were
 * already separate meshes from the shell, moving them onto their own material
 * costs exactly zero additional draw calls.
 *
 * The atlas also carries the wheel's hard parts — rim face, spokes, brake disc,
 * caliper — as flat swatches, so a whole wheel stays a single draw call.
 *
 * ONE THING IS NOT PAINT. The compound stripe is ALSO built as a thin shell
 * standing 6mm proud of the carcass — see `buildSidewallBands` at the bottom of
 * this file — because the compound is the one piece of state a spectator has to
 * be able to read at chase distance and at night, and flat paint on the widest
 * part of a black object does not survive either. That is a second draw call per
 * wheel and it is the only one on the car that has to be argued for; the case is
 * made where the shell is built.
 */

/** Where the tyre profile lives in the atlas. v0 at the bottom, v1 at the top. */
export const TYRE_BAND = { v0: 0.46, v1: 1.0 };

export type WheelSwatch =
  | 'rimFace' | 'rimSpoke' | 'rimLip' | 'hub'
  | 'disc' | 'discFace' | 'caliper' | 'inner';

const SWATCHES: WheelSwatch[] = [
  'rimFace', 'rimSpoke', 'rimLip', 'hub',
  'disc', 'discFace', 'caliper', 'inner',
];

/**
 * Base colour and [roughness, metalness] for each hard part.
 *
 * METALNESS WAS THE PROBLEM, and it was not obvious by eye. A metal in a PBR
 * renderer has no diffuse term at all: everything it shows is a reflection of
 * its surroundings, tinted by its own colour. The wheel cover was set at 0.55
 * metal, the flange ring at 0.95 and the hub at 0.80, under a blue sky and
 * beside a painted car — so the entire face of every wheel came back as a blue
 * mirror. A radial saturation profile put the cover region at 0.41 mean
 * saturation against 0.09 on the reference photograph, which is most of why the
 * wheels read as "wrong" even in shots where the compound band was out of frame.
 *
 * A current wheel cover is not alloy. It is a mandated aerodynamic fairing,
 * moulded in carbon composite and finished satin dark grey — a DIELECTRIC. The
 * only genuinely metallic things on the corner are the centre-lock nut and the
 * caliper, and both are small.
 *
 * AND THEN THE TABLE DID NOT SAY THAT. The paragraph above is the one this file
 * has carried since the blue-mirror fix, and every value under it was a
 * half-metal anyway: the cover a "dielectric" at 0.10, the spokes at 0.25, the
 * carbon-carbon disc — which the comment calls "not remotely metallic" — at
 * 0.05, and the two parts the comment names as the only real metals at 0.55 and
 * 0.60, which is neither. Metalness is a SWITCH between two different BRDFs, not
 * a dial: 0.60 deletes 60% of the diffuse term and tints 60% of the specular
 * with the base colour, and no material behaves that way. This is exactly the
 * defect §6 of PROJECT.md records on painted bodywork at 0.26, one component
 * over, and it survived the fix that named it.
 *
 * SO THE TABLE NOW SAYS WHAT THE PARAGRAPH SAYS. Everything moulded, coated or
 * carbon goes to the 0.02 Fresnel floor `Livery.ts` already uses; the three
 * genuine metals go to 1.0.
 *
 * THE ALBEDOS MOVED WITH THEM, AND THEY HAD TO. Under metalness 1 the base
 * colour stops being a diffuse albedo and becomes the specular REFLECTANCE at
 * normal incidence, so leaving `hub` at #4a4f57 while switching it to metal
 * would have made a 30%-reflective centre nut — darker than the dielectric it
 * replaced, not brighter. The three new values are measured reflectances rather
 * than picked: anodised aluminium ~0.72 (#b9bec4), machined steel ~0.69
 * (#b0b4b8), and the bronze anodising an F1 caliper carries ~0.62/0.49/0.27
 * (#9d7c46). Roughness is UNCHANGED on every row: this is a correction to the
 * BRDF, not a restyle, and the gloss of each part was decided separately and is
 * not in question.
 */
const SWATCH_LOOK: Record<WheelSwatch, { colour: string; rough: number; metal: number }> = {
  // The wheel face on a current car is a moulded composite cover, not chrome.
  rimFace: { colour: '#232529', rough: 0.62, metal: 0.02 },
  rimSpoke: { colour: '#3c4149', rough: 0.44, metal: 0.02 },
  // The machined ring between the cover and the bead. Still the brightest thing
  // on the corner, but a brushed one rather than a mirror — which at metalness
  // 1 is what roughness 0.42 says, and it says it honestly now.
  rimLip: { colour: '#b9bec4', rough: 0.42, metal: 1.0 },
  // The centre-lock nut and flange. Steel.
  hub: { colour: '#b0b4b8', rough: 0.34, metal: 1.0 },
  // Carbon-carbon brake discs are matte grey-black and not remotely metallic.
  disc: { colour: '#2e2b28', rough: 0.72, metal: 0.02 },
  discFace: { colour: '#3a3632', rough: 0.66, metal: 0.02 },
  // Anodised aluminium. The other one the comment above names as a real metal.
  caliper: { colour: '#9d7c46', rough: 0.45, metal: 1.0 },
  inner: { colour: '#101216', rough: 0.80, metal: 0.02 },
};

/** UV of the centre of a swatch cell, for `setFlatUV`. */
export function wheelSwatchUV(name: WheelSwatch): [number, number] {
  const i = SWATCHES.indexOf(name);
  const cols = 4;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const w = 1 / cols;
  const h = TYRE_BAND.v0 / 2;
  return [(col + 0.5) * w, (row + 0.5) * h];
}

function swatchRectPx(name: WheelSwatch, size: number): [number, number, number, number] {
  const i = SWATCHES.indexOf(name);
  const cols = 4;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const w = size / cols;
  const h = (TYRE_BAND.v0 / 2) * size;
  // Canvas y is measured from the top; atlas v from the bottom.
  return [col * w, size - (row + 1) * h, w, h];
}

/**
 * A point on the tyre's surface of revolution.
 *
 * `v` is the station's coordinate across the painted tyre band: 0 at the
 * inboard bead, 0.5 at the tread crown, 1 at the outboard bead. It is carried
 * on the point rather than held in a parallel array because the number of
 * stations now varies with the detail tier, and a parallel array would have to
 * be regenerated in lockstep by every caller.
 */
export interface TyreProfilePoint {
  r: number;
  x: number;
  v: number;
}

/**
 * Anchors for the v mapping, and the only numbers the paint below is tuned
 * against.
 *
 * The paint places the tread between 0.30 and 0.70, the shoulder turn from 0.24,
 * and the moulded lettering at 0.045 and 0.955. Those constants only mean
 * anything if a given v lands on the same PART of the tyre regardless of how
 * finely it happens to be tessellated, so the two arcs below are parameterised
 * by their own generating angle and pinned at the ends: inboard bead at 0,
 * maximum width at 0.10 and 0.90, crown at 0.5, outboard bead at 1. Tessellate
 * harder and the stations get denser; every one of them keeps the v it would
 * have had, and the paint does not move.
 *
 * These are the values the previous hand-placed seven-station profile used, so
 * the paint above needed no retuning when the section became a real curve.
 */
const V_MAX_WIDTH = 0.10;

/**
 * Angular offset that puts a VERTEX at the bottom of the wheel, radians.
 *
 * A wheel is a prism with `radial` sides, so its true lowest point is a vertex
 * if one happens to fall at the bottom and the middle of a facet if one does
 * not — and a facet sits `r(1 - cos(pi/radial))` ABOVE where the tyre says its
 * contact patch is. At the expensive tier `radial` is 36 and 27/36 lands
 * exactly on three quarters of a turn, so it was free and nobody noticed. At
 * the cheap tier it is 14, three quarters of a turn falls between two vertices,
 * and the whole car floated NINE MILLIMETRES off the road — invisible at the
 * LOD distance the tier was designed for and two or three pixels of daylight
 * under every tyre on a phone, which runs the cheap tier at every distance.
 * `probe:carrig` measures it as the lowest vertex on each wheel.
 *
 * A rotation, not a subdivision: it costs nothing, and the tyre is a solid of
 * revolution so turning it changes nothing else. The carcass and the raised
 * compound band MUST use the same phase — they are two prisms 6mm apart and
 * staying in phase is the entire reason the band does not poke through — which
 * is why this lives here, next to the profile they share, rather than in either
 * of them.
 */
export function wheelPhase(radial: number): number {
  const step = (Math.PI * 2) / radial;
  const bottom = Math.PI * 1.5;
  return bottom - Math.round(bottom / step) * step;
}

/**
 * The tyre's cross-section in metres, from inboard bead to outboard bead.
 *
 * Two arcs rather than hand-placed control points, because the shoulder is the
 * one part of a tyre that is unambiguously a radius and skinning straight
 * between control points turned it into a single flat chamfer:
 *
 *  - crown to maximum width is a quadrant of a SUPERELLIPSE. The exponent
 *    controls how square the shoulder is — on a slick, quite square but never a
 *    corner — and sampling it in the generating angle puts the points where the
 *    curvature is;
 *  - maximum width to bead is a quarter ellipse tucking back in under the rim.
 *
 * Maximum width is outboard of the nominal half-width, because a tyre bulges.
 *
 * It lives HERE rather than in CarMesh for two reasons. The paint has to know
 * the shape it is landing on, and — more sharply — the raised compound band is a
 * separate shell that has to sit exactly on this surface. Two independent copies
 * of these numbers would drift the moment either was tuned, and the failure mode
 * is the band z-fighting through the carcass, which reads as the tyre flickering
 * rather than as a mis-set constant.
 *
 * `crownRings` is the tier's tyre tessellation: stations from crown to maximum
 * width, with half as many again closing the bead tuck.
 */
export function tyreProfile(
  width: number, tyreR: number, rimR: number, crownRings: number,
): TyreProfilePoint[] {
  const half = width * 0.5;
  // 0.845, not 0.80. A current slick on an 18-inch rim is a SQUAT object: the
  // tread crown runs almost flat across the full width and only turns down over
  // the last part of the shoulder. Carrying the widest point at 80 per cent of
  // the outside radius put the turn a third of the way down the tyre, which
  // gave a fat, round, high-sidewall section — the profile of a 13-inch tyre,
  // and one of the reasons the wheels read as the wrong generation.
  const rMaxW = tyreR * 0.845;
  const xMaxW = half * 1.012;
  const rBead = rimR + 0.004;
  /** Superellipse exponent. Higher is squarer in the shoulder. */
  const N = 6.2;
  const p = 2 / N;

  // Outboard half, crown first: v runs 0.5 at the crown to 1.0 at the bead.
  const vMaxW = 1 - V_MAX_WIDTH;
  const out: TyreProfilePoint[] = [];
  for (let i = 0; i <= crownRings; i++) {
    const f = i / crownRings;
    const th = f * Math.PI * 0.5;
    out.push({
      x: xMaxW * Math.pow(Math.sin(th), p),
      r: rMaxW + (tyreR - rMaxW) * Math.pow(Math.cos(th), p),
      v: 0.5 + (vMaxW - 0.5) * f,
    });
  }
  const beadRings = Math.max(2, Math.round(crownRings * 0.5));
  for (let i = 1; i <= beadRings; i++) {
    const f = i / beadRings;
    const th = f * Math.PI * 0.5;
    out.push({
      x: xMaxW - (xMaxW - half) * (1 - Math.cos(th)),
      r: rMaxW - (rMaxW - rBead) * Math.sin(th),
      v: vMaxW + (1 - vMaxW) * f,
    });
  }

  // The section is symmetric, so the inboard half is the outboard one mirrored
  // in x with v reflected about the crown. Ordered inboard bead -> crown ->
  // outboard bead, which is the order `buildWheel` skins and the order the
  // paint's v runs in.
  const inboard = out.slice(1).reverse().map((q) => ({ x: -q.x, r: q.r, v: 1 - q.v }));
  return [...inboard, ...out];
}

/** Canvas y for a profile station, within the tyre band. */
function bandY(t: number, size: number): number {
  const y0 = size * (1 - TYRE_BAND.v1);
  const y1 = size * (1 - TYRE_BAND.v0);
  return y0 + t * (y1 - y0);
}

interface TyreLook {
  /** Base colour map. */
  map: THREE.CanvasTexture;
  /** Green = roughness, blue = metalness. */
  surface: THREE.CanvasTexture;
}

const cache = new Map<string, TyreLook>();

/**
 * Paints one compound's tyre and the shared wheel hardware.
 *
 * @param size texture edge in pixels
 */
function paint(compound: CompoundId, size: number): TyreLook {
  const colourCanvas = document.createElement('canvas');
  colourCanvas.width = colourCanvas.height = size;
  const c = colourCanvas.getContext('2d')!;

  const surfCanvas = document.createElement('canvas');
  surfCanvas.width = surfCanvas.height = size;
  const s = surfCanvas.getContext('2d')!;

  const set = (rough: number, metal: number) =>
    `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // --- Backgrounds ---------------------------------------------------------
  c.fillStyle = '#0d0e10';
  c.fillRect(0, 0, size, size);
  s.fillStyle = set(0.9, 0.02);
  s.fillRect(0, 0, size, size);

  // --- Hard parts ----------------------------------------------------------
  for (const name of SWATCHES) {
    const look = SWATCH_LOOK[name];
    const [x, y, w, h] = swatchRectPx(name, size);
    c.fillStyle = look.colour;
    c.fillRect(x, y, w, h);
    s.fillStyle = set(look.rough, look.metal);
    s.fillRect(x, y, w, h);

    // The brake disc gets its drilled face drawn in rather than left flat: it
    // is the one hard part with a pattern the camera ever gets close enough to
    // resolve, and a plain grey circle behind a spoked wheel is conspicuous.
    if (name === 'discFace') {
      c.fillStyle = 'rgba(0,0,0,0.55)';
      for (let i = 0; i < 90; i++) {
        const px = x + ((i * 37) % 100) / 100 * w;
        const py = y + ((i * 61) % 100) / 100 * h;
        c.beginPath();
        c.arc(px, py, Math.max(1, size * 0.004), 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  // --- Tyre ---------------------------------------------------------------
  const yTop = bandY(0, size);
  const yBot = bandY(1, size);
  const bandH = yBot - yTop;

  /** Fills between two profile stations across the full circumference. */
  const across = (t0: number, t1: number, fill: string, ctx: CanvasRenderingContext2D) => {
    const a = bandY(t0, size);
    ctx.fillStyle = fill;
    ctx.fillRect(0, a, size, bandY(t1, size) - a);
  };

  // Sidewalls are a touch lighter and considerably glossier than the tread.
  // Moulded rubber has a sheen; a scrubbed contact patch does not. That
  // difference across the shoulder is the main thing that reads as "rubber".
  // Rubber is not black. Photographed under any real light a tyre sits around
  // an eight to ten per cent reflectance — sRGB 0x28 or so — and painting it at
  // 0x0d turns every wheel into a hole punched in the image with a coloured
  // ring round it. It only LOOKS black next to white bodywork.
  across(0.0, 1.0, '#232529', c);
  across(0.0, 1.0, set(0.52, 0.02), s);

  // Tread: darker, matte, and slightly warmer from laid-down rubber.
  const treadA = 0.30, treadB = 0.70;
  across(treadA, treadB, '#191a1d', c);
  across(treadA, treadB, set(0.88, 0.02), s);

  // Shoulders: the turn from tread to sidewall. Glossier than the tread
  // because it only touches the road under load.
  across(0.24, treadA, '#1e2023', c);
  across(0.24, treadA, set(0.70, 0.02), s);
  across(treadB, 0.76, '#1e2023', c);
  across(treadB, 0.76, set(0.70, 0.02), s);

  // NO TREAD PATTERN. A dry Formula 1 tyre is a slick: the tread is a smooth,
  // uninterrupted band of rubber from shoulder to shoulder, and the only tyres
  // in the sport that carry moulded grooves are the intermediate and the full
  // wet. What used to be here was twenty-eight white lines drawn round the
  // circumference — "fine circumferential striation", which is a description of
  // a road tyre — and between them and the matching sine wave in the normal map
  // (see `tyreSurface` in scripts/generateTextures.mjs) every wheel on the car
  // was visibly ribbed. That is the fault the user reported in as many words:
  // "the tires are clean and smooth, yours have lines on them and its wrong."
  //
  // Nothing replaces them. The tread's character comes from the graining below,
  // which is aperiodic, and from the roughness split across the shoulder above,
  // which is what actually makes rubber read as rubber.

  // Graining: a broad, irregular mottling across the working part of the tread.
  // Real tyres are never uniform across the contact patch.
  //
  // MUCH FAINTER AND MUCH MORE SMEARED THAN IT WAS, and this is the second
  // thing that was putting marks on a tyre the user had asked to be clean. At
  // 4.5 per cent alpha these blobs sound invisible, and on a mid-grey they
  // would be — but the tread is painted 0x19, so a 200-grey blob at 4.5 per
  // cent lifts it by nearly a third of its own value, and 220 of them overlap.
  // Straight astern, where the whole rear tyre faces the camera, the result was
  // a field of soft dark and light patches that reads as blistering. It
  // survived two rounds of blaming the normal map for it.
  //
  // 1.8 per cent, and stretched eight times as far around the circumference as
  // across the tread — because that is the direction rubber actually smears.
  // At that aspect it can only ever read as a faint banding in the shading,
  // which is what graining looks like, rather than as spots.
  for (let i = 0; i < 150; i++) {
    const t = treadA + (((i * 89) % 97) / 97) * (treadB - treadA);
    const x = (((i * 53) % 101) / 101) * size;
    const r = size * (0.008 + ((i * 29) % 17) / 17 * 0.018);
    c.fillStyle = `rgba(${i % 3 ? 190 : 60},${i % 3 ? 186 : 60},${i % 3 ? 182 : 62},0.018)`;
    c.beginPath();
    c.ellipse(x, bandY(t, size), r * 8.0, r * 0.42, 0, 0, Math.PI * 2);
    c.fill();
  }

  // --- Compound stripe -----------------------------------------------------
  // On the outer sidewall, just inboard of the shoulder, where it is visible
  // from the side and from three-quarters but not from directly above.
  //
  // The width is measured in PROFILE space, not in pixels, and it is narrow on
  // purpose. The band sits at the largest radius on the tyre, so a stripe that
  // looks reasonable in the texture wraps a very long way around the wheel and
  // turns into a solid coloured ring — which is what the first version did, and
  // it made every car look like it was running on toy wheels.
  //
  // The raised band built by `buildSidewallBands` stands on top of this, in the
  // same colour from the same table. This is the moulded ring; that is the same
  // ring in geometry, wrapped further round the shoulder and carrying a little
  // emission so it survives a night race. Painting it here as well means the
  // compound still reads if the shell is ever dropped, and means the two can
  // never disagree about what colour a soft is.
  const stripe = '#' + TIRE_COMPOUNDS[compound].colour.toString(16).padStart(6, '0');
  // Directly under the raised band, so the geometry and the paint agree. See
  // BAND_V_FROM / BAND_V_TO at the bottom of this file for where the numbers
  // come from. Quoted from those constants rather than repeated as literals:
  // they disagreed once already, and a painted stripe that is not under the
  // raised ring shows as a second, differently-placed stripe.
  for (const [a, b] of [
    [1 - BAND_V_TO, 1 - BAND_V_FROM], [BAND_V_FROM, BAND_V_TO],
  ] as const) {
    const y = bandY(a, size);
    const h = bandY(b, size) - y;
    c.fillStyle = stripe;
    c.fillRect(0, y, size, h);
    // Knocked back toward the rubber under it. The compound colours are chosen
    // to be legible as HUD swatches, and used at full strength on a sidewall
    // they are brighter than any paint on the car — the band stops reading as
    // a marking on a tyre and starts reading as a glowing hoop.
    c.fillStyle = 'rgba(24,26,30,0.30)';
    c.fillRect(0, y, size, h);
    // Painted-on rubber: brighter than the wall, and glossier.
    s.fillStyle = set(0.38, 0.02);
    s.fillRect(0, y, size, h);
    // A dark edge on each side stops the band looking like a decal floating
    // above the tyre.
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, y, size, Math.max(1, h * 0.14));
    c.fillRect(0, y + h - Math.max(1, h * 0.14), size, Math.max(1, h * 0.14));
  }

  // --- Sidewall lettering --------------------------------------------------
  // Repeated five times round, which is roughly what a real tyre carries, and
  // enough that at least one instance is in view from any angle.
  //
  // SIZE. The cap height is a fraction of the whole cross-section band, and the
  // sidewall is only about a tenth of that band, so anything above five percent
  // is taller than the wall it is written on. The first version used thirteen
  // percent in near-white and produced a bright ring that read as a whitewall
  // tyre off a nineteen-fifties saloon. Real sidewall lettering is small, and
  // it is grey — moulded rubber that is slightly glossier than its
  // surroundings, not paint.
  const REPEATS = 5;
  const drawText = (
    t: number, str: string, heightFrac: number, colour: string, weight: number,
  ) => {
    const y = bandY(t, size);
    const fontPx = Math.max(5, bandH * heightFrac);
    c.save();
    c.font = `${weight} ${fontPx}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = colour;
    for (let i = 0; i < REPEATS; i++) {
      c.fillText(str, ((i + 0.5) / REPEATS) * size, y);
    }
    c.restore();
  };

  // ONE row, in GREY, in the strip of sidewall between the raised band and the
  // bead at 0.965.
  //
  // It was printed in the COMPOUND COLOUR, and that was a second full coloured
  // ring on the tyre — at a larger radius than the band itself, so it swept a
  // bigger area of every frame than the marking it was supporting. Two
  // concentric yellow rings on a medium is what made the tyre read as
  // predominantly yellow however narrow the band above it got.
  //
  // Moulded sidewall lettering is grey. It is rubber, very slightly glossier
  // than the wall it stands on, and the only reason it is legible at all is the
  // relief — which is why the surface map below matters more than the ink does.
  //
  // KNOCKED BACK AGAIN. At 0.55 alpha over near-black rubber the type came out
  // as light grey capitals legible from six metres, which put a second bright
  // ring of writing on a wheel that already carries a coloured one. On the
  // reference car the moulded name is barely separable from the rubber except
  // where the light happens to rake across it — it is relief, not ink — so the
  // ink drops to a third and the surface map below does the work.
  drawText(0.950, 'PROTOTIPO', 0.020, 'rgba(120,124,132,0.30)', 700);
  drawText(0.050, 'PROTOTIPO', 0.020, 'rgba(120,124,132,0.30)', 700);

  // Raised lettering catches light: give the text rows a glossier surface so
  // the letters flare as the wheel turns past a floodlight.
  for (const t of [0.950, 0.050] as const) {
    const y = bandY(t, size) - bandH * 0.020;
    s.fillStyle = set(0.34, 0.02);
    s.fillRect(0, y, size, bandH * 0.040);
  }

  // --- Bead ---------------------------------------------------------------
  // The dark, hard rim where the tyre grips the wheel. Without it the tyre and
  // the rim merge into one object.
  across(0.0, 0.035, '#0c0d0f', c);
  across(0.965, 1.0, '#0c0d0f', c);

  const map = new THREE.CanvasTexture(colourCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  map.needsUpdate = true;

  const surface = new THREE.CanvasTexture(surfCanvas);
  surface.colorSpace = THREE.NoColorSpace;
  surface.wrapS = THREE.RepeatWrapping;
  // Matched to the colour map's 8. It was 4 on the reasoning that a roughness
  // map matters less than an albedo — which is backwards on a tyre. The tyre is
  // a very dark, very smooth object, so almost everything the eye gets from it
  // arrives through the specular lobe, and the specular lobe is what this map
  // controls. Under-filtering it is under-filtering the only channel doing work.
  surface.anisotropy = 8;
  surface.needsUpdate = true;

  return { map, surface };
}

/** Builds (or returns a cached) tyre look for one compound. */
export function buildTyreTexture(compound: CompoundId, size = 512): TyreLook {
  const key = `${compound}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = paint(compound, size);
  cache.set(key, built);
  return built;
}

const materials = new Map<string, THREE.MeshStandardMaterial>();

/**
 * The material for a whole wheel — tyre, rim and disc.
 *
 * Shared across every car running that compound, so twenty cars on two
 * compounds cost two materials.
 */
export function wheelMaterial(compound: CompoundId, size = 512): THREE.MeshStandardMaterial {
  const key = `${compound}:${size}`;
  const hit = materials.get(key);
  if (hit) return hit;
  const tex = buildTyreTexture(compound, size);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    roughnessMap: tex.surface,
    metalnessMap: tex.surface,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.0,
  });
  // Moulded relief: circumferential striation across the tread, graining over
  // the working part of it, radial ribs on the sidewall.
  //
  // This is the one place on the car where a normal map is doing something a
  // colour map genuinely cannot. A tyre is a very large, very dark, almost
  // perfectly smooth object, so essentially everything the eye gets from it is
  // in the specular — and painting striation into the albedo of a black object
  // changes almost nothing, which is why the painted version of these lines
  // has never read at any distance. Perturbing the normal makes the highlight
  // itself break into fine circumferential lines that travel as the wheel
  // turns, and that is what rubber looks like.
  //
  // Sampled through uv, not uv1: the wheel already has a real parameterisation
  // and the map is laid out to match it exactly. Only the high tier gets it.
  const relief = size > 256 ? tyreSurfaceMap() : null;
  if (relief) {
    mat.normalMap = relief;
    // 0.30, not 0.42.
    //
    // The map used to carry a periodic striation across the tread, and this
    // scale was tuned to make that striation catch a travelling highlight
    // without crawling. There is no striation any more — a slick is smooth —
    // so all this multiplies now is the sidewall's radial ribs and a little
    // graining across the contact patch, and both want less of it than a
    // moulded pattern did.
    mat.normalScale = new THREE.Vector2(0.30, 0.30);
  }
  materials.set(key, mat);
  return mat;
}

// ===========================================================================
// The raised compound band
// ===========================================================================

/**
 * The coloured band on the tyre sidewall, as geometry.
 *
 * The stripe painted above already puts the compound colour on the sidewall.
 * This is the same ring standing 6mm proud of the carcass, and it exists for one
 * reason: READABILITY. The compound is the single most important piece of state
 * a spectator can read off a car — without it every car in the field is on the
 * same anonymous black doughnut and a pit stop is invisible — and a flat painted
 * stripe on the widest part of the tyre does not survive the two conditions this
 * game is mostly played in.
 *
 *   - IT WRAPS THE SHOULDER, starting a quarter of the way up the tread turn, so
 *     it is visible from directly astern — which is where the chase and onboard
 *     cameras spend all their time — and not only from abeam.
 *   - IT CARRIES A LITTLE EMISSION. Most of this game runs under floodlights,
 *     and a purely diffuse band lit by a dim key reads as dark grey whatever
 *     colour it is: soft and hard become indistinguishable at ten metres.
 *   - IT CARRIES THE COMPOUND NAME in type large enough to read, which the
 *     14mm-tall grey lettering in the texture is not.
 *
 * WHY GEOMETRY AND NOT MORE TEXTURE. The paint is already per-compound, so that
 * much would work; what it cannot do is stand proud, and a band that stands
 * proud catches a rim light along its outer edge. That edge is most of what
 * makes it legible in a dark frame.
 *
 * COST. One geometry shared by the whole field per wheel size, one material per
 * compound. A pit stop is a material reference assignment.
 */

/**
 * Where the band sits, in the profile's own v coordinate.
 *
 * Given as v — not as a station index — because the number of stations now
 * varies with the detail tier, so "station 4.25" would put the band in a
 * different physical place on the high and low tiers and the two would not line
 * up across an LOD swap.
 *
 * THE BAND WAS FOUR TIMES TOO WIDE, and it was the loudest single fault on the
 * whole car. It ran from 0.78 — a quarter of the way up the SHOULDER — down to
 * 0.905, so it covered the entire visible turn of the tyre from every angle
 * that matters. On a yellow medium the result was a wheel that was more yellow
 * than black: not a racing tyre with a compound marking on it, but a toy wheel
 * with a coloured tyre, and it dated the car harder than any piece of geometry
 * on it did.
 *
 * On the reference car the marking is a THIN ring painted flat on the sidewall
 * annulus, at about 79 per cent of the tyre's outside radius — well inboard of
 * the widest point, with plain black rubber above it all the way over the
 * shoulder. Measured against `tyreProfile`, the widest point is r = 0.80 R at
 * v = 0.90 and the bead is 0.647 R at v = 1.0, so 0.893 to 0.936 puts the ring
 * between 0.80 R and 0.75 R. That is the reference, to within the width of the
 * line.
 *
 * READABILITY SURVIVES THIS. The argument for the wide band was that it had to
 * be visible from astern, and it still is — both sidewalls carry a ring, and it
 * is the INBOARD one that the chase and onboard cameras see, edge-on at the
 * tyre's widest point. What is lost is only the part of the band that was
 * wrapped over the tread shoulder, which no camera needs and which was doing
 * all of the damage.
 */
/**
 * NARROWED TWICE, AND ONCE TOO OFTEN.
 *
 * The band began at 0.78-0.905, which wrapped a quarter of the way up the tread
 * shoulder and made a medium-shod car look like it was running yellow tyres.
 * Narrowing it to 0.906-0.921 fixed that and overshot: 0.906-0.921 works out at
 * a 16mm ring on a 720mm tyre, and a 16mm ring seen from three metres is one or
 * two pixels of colour. That is what "a thin red ring that reads as a drawn line
 * rather than the broad coloured sidewall band real compounds carry" is.
 *
 * WHERE THE NUMBERS COME FROM. The band sits on the sidewall ANNULUS — the flat
 * face between the tyre's widest point and the bead — with its outer edge just
 * inboard of maximum width and plain black rubber above it all the way over the
 * shoulder. In this profile's own v that annulus is exactly 0.90 to 1.00, and
 * the radius across it runs 0.845 R at v = 0.90 down to 0.647 R at the bead. So:
 *
 *   v = 0.902  ->  r = 0.839 R  =  302mm on a 720mm tyre
 *   v = 0.928  ->  r = 0.761 R  =  274mm
 *
 * a 28mm ring occupying a little over a quarter of the sidewall's height, which
 * is what the reference photographs measure. It is 1.75x the width of the ring
 * it replaces and still less than half the width of the one before that.
 *
 * WHAT KEEPS IT FROM DOMINATING AGAIN is not its width, and that was the error
 * the second time round. It is the CHROMA: the colour is knocked 56 per cent
 * back toward the rubber under it in `bandTexture`, and a quarter of the band's
 * height at each edge is a gradient into black. Those two together are why a
 * band nearly twice as wide costs the frame less colour than the original did.
 */
const BAND_V_FROM = 0.902;
const BAND_V_TO = 0.928;
/** Rows across the band. Enough to follow the shoulder's curve without faceting. */
const BAND_ROWS = 6;
/**
 * How far the shell stands proud of the carcass, metres.
 *
 * Small, because the band and the tyre are sampled at the SAME angles: parallel
 * facets separated by a near-constant gap, so 6mm is plenty even though the
 * facet sagitta on a sixteen-sided wheel is larger than that. This only holds
 * while the two stay in phase, which is why the band is parented to the wheel's
 * SPIN group and not to its steer group — see the note in CarMesh.
 */
const BAND_LIFT = 0.006;

/** The profile point at a given v, interpolated between the stations either side. */
function sampleProfile(profile: readonly TyreProfilePoint[], v: number): TyreProfilePoint {
  // v increases monotonically along the profile, inboard bead to outboard.
  let i = 0;
  while (i < profile.length - 2 && profile[i + 1].v < v) i++;
  const a = profile[i];
  const b = profile[i + 1];
  const span = b.v - a.v;
  const f = span > 1e-9 ? (v - a.v) / span : 0;
  return { r: a.r + (b.r - a.r) * f, x: a.x + (b.x - a.x) * f, v };
}

/** Outward normal of the profile at v, in the (x, r) plane. */
function profileNormalAt(
  profile: readonly TyreProfilePoint[], v: number,
): { nx: number; nr: number } {
  const e = 0.004;
  const a = sampleProfile(profile, Math.max(0, v - e));
  const b = sampleProfile(profile, Math.min(1, v + e));
  // Tangent (dx, dr); the outward perpendicular is (-dr, dx) with the profile
  // running inboard-to-outboard.
  const dx = b.x - a.x;
  const dr = b.r - a.r;
  const len = Math.hypot(dr, dx) || 1;
  return { nx: -dr / len, nr: dx / len };
}

/**
 * The band shell for one wheel: two rings, one on each sidewall.
 *
 * Both sides are built. The inboard band faces the chassis and is half hidden by
 * bodywork, but it is the side the onboard camera looks at — from the driver's
 * seat you see the inner face of both front tyres, and in the reference footage
 * that is precisely where the compound reads from.
 *
 * The band's u runs once around the circumference and v across the band from its
 * inner edge to its outer one, so the strip texture below lands upright.
 */
export function buildSidewallBands(
  width: number, tyreR: number, rimR: number, radial: number, crownRings: number,
): THREE.BufferGeometry {
  // Sampled by v, so the same `crownRings` the carcass was built with is passed
  // in and the band's rows land on the surface the carcass actually has. Build
  // the band against a coarser section than the tyre and the two curves diverge
  // between stations by more than BAND_LIFT, which is the z-fight all over
  // again.
  const profile = tyreProfile(width, tyreR, rimR, crownRings);
  const positions: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  for (const side of [1, -1] as const) {
    const base = positions.length / 3;
    for (let k = 0; k <= BAND_ROWS; k++) {
      const f = k / BAND_ROWS;
      // The section is symmetric about v = 0.5, so the inboard band is the
      // outboard one reflected — no second set of constants.
      const vOut = BAND_V_FROM + (BAND_V_TO - BAND_V_FROM) * f;
      const v = side > 0 ? vOut : 1 - vOut;
      const p = sampleProfile(profile, v);
      const n = profileNormalAt(profile, v);
      // The normal is already outward on BOTH sides — the profile is traversed
      // inboard-to-outboard, so its perpendicular flips sign along with the
      // sidewall it belongs to. Negating the axial term for the inboard ring
      // (which looks like the obvious mirror) pushes that ring 4mm INTO the
      // carcass, and the compound colour half-disappears on exactly the face the
      // driver looks at from the cockpit.
      const px = p.x + n.nx * BAND_LIFT;
      const pr = p.r + n.nr * BAND_LIFT;
      const phase = wheelPhase(radial);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2 + phase;
        positions.push(px, Math.sin(a) * pr, Math.cos(a) * pr);
        // Reversed to match the carcass under it — see the note in
        // `buildWheel`. The compound name was mirrored too.
        uvs.push(1 - i / radial, f);
      }
    }
    const stride = radial + 1;
    for (let k = 0; k < BAND_ROWS; k++) {
      for (let i = 0; i < radial; i++) {
        const a0 = base + k * stride + i;
        const a1 = a0 + 1;
        const b0 = a0 + stride;
        const b1 = b0 + 1;
        // The inboard ring is a mirror image, so its winding has to be reversed
        // or it renders inside-out and vanishes under backface culling.
        if (side > 0) {
          idx.push(a0, b0, b1, a0, b1, a1);
        } else {
          idx.push(a0, b1, b0, a0, a1, b1);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Ink for the compound name printed on the band.
 *
 * Dark on the light compounds, white on the dark ones, and deliberately low
 * contrast either way: the lettering is a close-up detail, and cranking it up
 * turns the band into a dithered mid-tone at the distance that actually matters.
 */
const INK: Record<CompoundId, string> = {
  soft: 'rgba(255,255,255,0.50)',
  medium: 'rgba(40,32,0,0.50)',
  hard: 'rgba(45,48,54,0.55)',
  intermediate: 'rgba(255,255,255,0.50)',
  wet: 'rgba(255,255,255,0.50)',
};

const bandTextures = new Map<CompoundId, THREE.CanvasTexture>();
const bandMaterials = new Map<CompoundId, THREE.MeshStandardMaterial>();

function bandTexture(id: CompoundId): THREE.CanvasTexture {
  const hit = bandTextures.get(id);
  if (hit) return hit;

  const compound = TIRE_COMPOUNDS[id];
  const W = 1024;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const hex = '#' + compound.colour.toString(16).padStart(6, '0');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, W, H);
  // Knocked back the same amount the painted stripe is, and for the same
  // reason: the compound colours are picked to be legible as HUD swatches, and
  // at full strength on a sidewall they are brighter than any paint on the car.
  ctx.fillStyle = 'rgba(24,26,30,0.56)';
  ctx.fillRect(0, 0, W, H);

  // The compound name, repeated around the tyre the way a real sidewall carries
  // it. v runs across the band and u around the circumference, so text drawn
  // straight in canvas space reads the right way up on the wheel.
  ctx.fillStyle = INK[id];
  ctx.font = `700 ${Math.round(H * 0.52)}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = compound.name.toUpperCase();
  const repeats = 6;
  for (let i = 0; i < repeats; i++) {
    ctx.fillText(label, ((i + 0.5) / repeats) * W, H * 0.5);
  }

  // Feather both edges to the rubber under them. A band that stops dead in the
  // middle of the sidewall looks like a decal that has been slapped on; fading
  // it out reads as the moulded-in ring it is meant to be, and hides the 6mm
  // step at the shell's edge.
  const fade = (from: number, to: number) => {
    const g = ctx.createLinearGradient(0, from, 0, to);
    g.addColorStop(0, 'rgba(20,22,25,1)');
    g.addColorStop(1, 'rgba(20,22,25,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.min(from, to), W, Math.abs(to - from));
  };
  // Wide, because the fade is doing double duty: it hides the 6mm step at the
  // shell's edge AND it is where a third of the ring's chroma budget goes. A
  // ring that reaches full saturation at its own boundary reads as a decal
  // stuck to the tyre; one that comes up out of the rubber over a quarter of
  // its width reads as moulded in, and costs much less of the frame.
  fade(0, H * 0.26);
  fade(H, H * 0.74);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  bandTextures.set(id, tex);
  return tex;
}

/**
 * The band material for a compound, shared by every car running it.
 *
 * The emissive term is not stylistic. Most of this game is run under floodlights
 * at night, and a band lit only by a dim key light reads as dark grey whatever
 * colour it is. A quarter of the texture added back as emission keeps the hue
 * alive in shadow without making the tyre glow.
 */
export function sidewallMaterial(id: CompoundId): THREE.MeshStandardMaterial {
  const hit = bandMaterials.get(id);
  if (hit) return hit;
  const tex = bandTexture(id);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: tex,
    // 0.07, not 0.26. A quarter of the texture added back as light was enough
    // to make the ring self-luminous in daylight: it read as a neon hoop
    // clipped to the wheel rather than as a marking moulded into rubber, and
    // the bloom pass picked it up as an emitter. What the night case actually
    // needs is only enough to stop the hue collapsing to grey under a dim key,
    // and that is a much smaller number than it sounds.
    emissiveIntensity: 0.045,
    roughness: 0.62,
    metalness: 0.0,
    envMapIntensity: 1.0,
  });
  bandMaterials.set(id, mat);
  return mat;
}

export function disposeTyreCache(): void {
  for (const t of cache.values()) {
    t.map.dispose();
    t.surface.dispose();
  }
  cache.clear();
  for (const m of materials.values()) m.dispose();
  materials.clear();
  for (const m of bandMaterials.values()) m.dispose();
  bandMaterials.clear();
  for (const t of bandTextures.values()) t.dispose();
  bandTextures.clear();
}

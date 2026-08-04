import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';

/**
 * How much of each lap is kerbed, and how tight the corners actually are.
 *
 * Kerbing is derived from curvature — every node tighter than a threshold
 * radius gets a kerb on the inside of the corner — which saves authoring about
 * nineteen hundred flags per circuit and is right in principle. What it is not
 * is self-checking: the threshold was 400m, nobody had measured what fraction
 * of a lap that produces, and the answer turned out to be between a third and
 * two thirds. A real circuit kerbs its apexes and its exits, which is nothing
 * like two thirds of the lap, and a lap that is more kerb than road is a large
 * part of why the corners looked wrong.
 *
 * This prints the number, per circuit, so the threshold is a measurement rather
 * than a guess. `runs` is the count of separate stretches of kerb around the
 * lap: a real circuit has roughly one or two per corner (an apex kerb, an exit
 * kerb) and the figure should land near twice the corner count, not near ten
 * times it.
 *
 * Run: npm run probe:kerbs
 */

console.log('circuit        length  kerbL kerbR kerbAny   R<400 R<250 R<150  R<80   runs  corners');
const totals = { any: 0, n: 0 };
for (const def of CIRCUITS) {
  const t = new TrackSpline(def);
  const n = t.count;
  let kl = 0, kr = 0, ke = 0, a400 = 0, a250 = 0, a150 = 0, a80 = 0;
  for (let i = 0; i < n; i++) {
    if (t.isCurbLeft[i]) kl++;
    if (t.isCurbRight[i]) kr++;
    if (t.isCurbLeft[i] || t.isCurbRight[i]) ke++;
    const r = t.curvature[i] !== 0 ? 1 / Math.abs(t.curvature[i]) : Infinity;
    if (r < 400) a400++;
    if (r < 250) a250++;
    if (r < 150) a150++;
    if (r < 80) a80++;
  }
  let runs = 0;
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const cur = t.isCurbLeft[i] || t.isCurbRight[i];
    const prev = t.isCurbLeft[p] || t.isCurbRight[p];
    if (cur && !prev) runs++;
  }
  const named = new Set<string>();
  for (let i = 0; i < n; i++) {
    const name = t.cornerNameAt(t.dist[i]);
    if (name) named.add(name);
  }
  const pct = (x: number) => (100 * x / n).toFixed(0).padStart(5) + '%';
  console.log(
    def.id.padEnd(13) + (t.length / 1000).toFixed(2) + 'km' +
    pct(kl) + pct(kr) + pct(ke) + '  ' + pct(a400) + pct(a250) + pct(a150) + pct(a80) +
    String(runs).padStart(7) + String(named.size).padStart(9),
  );
  totals.any += ke / n;
  totals.n++;
}
console.log('\nmean kerbed fraction of a lap: ' + (100 * totals.any / totals.n).toFixed(1) + '%');

// ===========================================================================
// SURFACE RELIEF — what the shared bump map still carries, per surface (#86)
// ===========================================================================
//
// Issue #48 band-limited the normal map: it is differentiated from a LOW-PASSED
// copy of the height field, so that no relief is drawn at a wavelength the
// pixel grid cannot resolve. That was measured, on the road, by `probe:grain`.
//
// THE HEIGHT FIELD IS SHARED BY EVERY SURFACE IN THE SCENE. Kerbs, grass,
// run-off and paint read the same two textures as the asphalt, at their own
// tiling scale — so the low pass reached all of them, `probe:grain` masks to
// `ROAD_MESH_NAME`, and nothing in the project measured any of the others at
// all. That is issue #86.
//
// A KERB'S RELIEF IS NOT SUB-PIXEL AND IS NOT SUPPOSED TO BE. Its crown stands
// 55mm proud of the run-off (`Y_KERB` in `TrackMesh.ts`) and the bump on top of
// that is meant to read as worn, scuffed concrete from a car's height. If the
// low pass had flattened it, that is a straight loss with nothing to catch it.
//
// SO THIS ASSERTS IN BOTH DIRECTIONS, and the first direction is the one that
// matters. PROJECT.md §3.2: a probe a broken feature passes is worse than no
// probe — and "the kerb is not noisy" is passed with flying colours by a kerb
// flattened to a mirror. The floor is therefore the load-bearing half:
//
//   RETAINED  the RMS facet slope the surface still carries at wavelengths a
//             pixel CAN hold — longer than ALIAS_MM — must be at least
//             RELIEF_FLOOR_DEG. Turn the low pass up, or take a surface's
//             `normalStrength` away, and this goes red.
//   RESOLVED  the RMS facet slope at wavelengths SHORTER than ALIAS_MM must be
//             at most ALIAS_CEILING_DEG. Take the low pass out and this goes
//             red — #48's own defect, restated per surface rather than for the
//             road alone.
//
// THE BOUND IS AT THE RESOLVABLE LIMIT AND NOT AT THE KERB'S OWN 55mm, and that
// is a deliberate choice with a measurement behind it. `RELIEF_KEEP_MM` — the
// column headed `>=40mm` — is REPORTED and not asserted, because 40mm is read
// off `Y_KERB`, and `Y_KERB` is the kerb's extruded SECTION: mesh geometry,
// which the low pass never touched and cannot touch. What the low pass owns is
// the bump, and the physical line for a bump is whether a pixel can carry it.
// The 40mm column is printed anyway because it says something real and
// uncomfortable — see PROJECT.md §7.
//
// WHAT THIS MEASURES AND WHAT IT DOES NOT. It reads the REAL texture the
// renderer binds — `makeGrain(256)`, the same call `SurfaceDetail`'s
// constructor makes — and the REAL `normalStrength` each surface is built with,
// and reports facet slope in degrees at stated WORLD wavelengths, which is what
// each surface's own tiling scale turns texels into. It does NOT draw anything,
// so it cannot see `detailResolve` fading a band out with distance; that is a
// screen-space question, it belongs in `probe:grain` masked to the kerb the way
// it is masked to the road today, and **that half is not built.**

const { makeGrain, SURFACES } = await import('../src/render/SurfaceDetail');

/**
 * Wavelength above which relief has to SURVIVE, millimetres.
 *
 * 40mm, read off the object rather than chosen: a kerb's crown is 55mm and the
 * section either side of it runs over about 100mm of profile, so the relief a
 * kerb is supposed to have is tens of millimetres. It is also comfortably
 * resolvable — the along-view pixel footprint from the cockpit is 6.5e-4 * z^2
 * metres, 2.8mm at two metres and 23mm at six, so a 40mm feature is several
 * pixels across everywhere a kerb is in view.
 */
const RELIEF_KEEP_MM = 40;
/**
 * Wavelength below which relief must have gone, millimetres.
 *
 * 12mm, just above the 11mm band issue #48 identifies as the one that could
 * only ever alias on the road. The physical argument is the same on every
 * surface: a feature under two pixels wide cannot be drawn, only sampled at
 * random.
 */
const ALIAS_MM = 12;
/**
 * Floor on the retained facet slope, degrees RMS.
 *
 * A Lambertian term moves about 1.2% per degree of facet tilt at a 45-degree
 * sun, which is one display level in 128 — so a surface under about a degree
 * of RMS slope is a painted plane and not a surface. 1.0 degree is that floor,
 * and it is a physical limit rather than a number read off the output.
 *
 * NEVER RAISE OR LOWER EITHER BOUND TO FIT — PROJECT.md §3.3.
 */
const RELIEF_FLOOR_DEG = 1.0;
/**
 * Ceiling on the un-resolvable facet slope, degrees RMS.
 *
 * 1.5. The separation this is set from is printed by the run and recorded in
 * PROJECT.md §6: on the shipped build the worst surface is well under it, and
 * with the low pass removed entirely every surface is several times over it.
 */
const ALIAS_CEILING_DEG = 1.5;

/**
 * Surfaces whose relief is load-bearing, and therefore floored.
 *
 * The rule is about the OBJECT, not about the number: a surface meant to read
 * as a granular material has to carry relief, and a surface that is a smooth
 * film or a flat face does not. Asphalt, kerbing, gravel run-off and grass are
 * granular; `wall` declares `normalStrength: 0` in its own profile because the
 * projection is planar and a bump on a vertical face is meaningless; and track
 * `paint` is a thermoplastic FILM laid over the aggregate — it is smoother than
 * the road beside it in reality, which is the whole reason its profile carries
 * 0.15 against the asphalt's 0.42.
 *
 * PAINT'S EXEMPTION IS NOW A DECISION RATHER THAN AN OPEN QUESTION — issue #86,
 * closed. This entry used to say that whether a white line should read as a film
 * or as painted aggregate "is a LOOK question and needs a look review". The
 * review was done the way this project is supposed to do them: against the
 * user's own reference frames, with a number.
 *
 * MEASURED OFF `reference/target/90.png` — Bahrain at night, the frame INDEX.md
 * names as the kerb and surface target. Relative high-frequency luma modulation
 * (RMS of luma minus a sigma-2 Gaussian of luma, over the patch's own mean, so a
 * white surface and a dark one are comparable), on colour-classified regions
 * eroded by more than the blur radius so no measurement contains a paint/asphalt
 * boundary:
 *
 *   near asphalt, same distance band as the kerb   5.62%   (79,599 px)
 *   mid asphalt, further up the straight           3.92%   (10,214 px)
 *   kerb WHITE paint                               2.83%   (16,288 px)
 *   kerb RED paint                                 1.80%   (22,266 px)
 *
 * So in the specification, painted kerb blocks carry **0.32 to 0.50 of the
 * asphalt's fine relief**, and the 0.50 is the generous end because the white
 * mask also contains the fluted drainage grooves cut into the kerb, which are
 * geometry rather than surface. Ours measures **0.66 / 1.86 = 0.355**, inside
 * that range and nearer the red blocks than the white. **The paint is right as
 * it is, #48 did not take anything from it that the reference frame has, and
 * the answer to the look question is that a white line IS a smooth film.**
 *
 * `76.png`'s own white lines could not be measured: at that frame's resolution
 * the edge line and the grid markings are a few pixels across, so every pixel of
 * them is within the blur radius of their own edge. Reported rather than
 * fudged — 90.png's kerb blocks are hundreds of pixels wide and are the right
 * instrument.
 *
 * THE EXEMPTION IS THEREFORE FROM THE FLOOR AND NOT FROM MEASUREMENT. Paint now
 * carries a CEILING instead, `PAINT_RELIEF_CEILING`, which is the property the
 * reference actually shows and which the floor could never have expressed.
 */
const RELIEF_FLOORED = new Set(['asphalt', 'kerb', 'runoff', 'grass']);

/**
 * How much of the asphalt's retained relief `paint` may carry — issue #86's
 * decision, as a bound.
 *
 * 0.50, read off `reference/target/90.png` and not off our own output: it is the
 * ratio the reference's WHITE kerb blocks measure against the asphalt beside
 * them at the same distance (2.83% / 5.62%), and it is the most generous of the
 * three paint samples in that frame — the red blocks are 0.32 and the white ones
 * are inflated by the kerb's fluted grooves.
 *
 * WHY A CEILING AND NOT A FLOOR, and this is the part that matters. #86 was
 * opened because a low pass might have flattened a surface that needs relief,
 * and for the kerb, the grass and the run-off that is what `RELIEF_FLOOR_DEG`
 * guards. For PAINT the finding went the other way: smooth is correct, so the
 * thing worth guarding is that nobody later "fixes" the 0.66 by winding
 * `paint.normalStrength` back up until a white line reads as aggregate. Raise it
 * past 0.21 — half the asphalt's 0.42 — and this goes red.
 *
 * NEVER RAISE THIS TO FIT — PROJECT.md §3.3. It came off the specification.
 */
const PAINT_RELIEF_CEILING = 0.50;

/** Separable Gaussian blur with wrapping edges, on a two-channel field. */
function blurWrapped(
  fx: Float64Array, fy: Float64Array, size: number, sigma: number,
): [Float64Array, Float64Array] {
  if (sigma <= 0) return [fx.slice(), fy.slice()];
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + radius];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const pass = (src: Float64Array, horizontal: boolean): Float64Array => {
    const out = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let acc = 0;
        for (let d = -radius; d <= radius; d++) {
          acc += k[d + radius] * (horizontal
            ? src[y * size + ((x + d + size) % size)]
            : src[((y + d + size) % size) * size + x]);
        }
        out[y * size + x] = acc;
      }
    }
    return out;
  };
  return [pass(pass(fx, true), false), pass(pass(fy, true), false)];
}

/** RMS magnitude of a two-channel field. */
function rmsMag(fx: Float64Array, fy: Float64Array): number {
  let s = 0;
  for (let i = 0; i < fx.length; i++) s += fx[i] * fx[i] + fy[i] * fy[i];
  return Math.sqrt(s / fx.length);
}

{
  const SIZE = 256;
  const { normal } = makeGrain(SIZE);
  const data = normal.image.data as Uint8Array;
  // The tangent-space perturbation the shader adds, straight out of the texture
  // it will sample: `bump = vec3(n.x, 0.0, n.y) * uNormalStrength`, added to a
  // unit normal — so `hypot(n.x, n.y) * strength` is the tangent of the facet
  // tilt it produces, before `detailResolve` fades it with distance.
  const sx = new Float64Array(SIZE * SIZE);
  const sy = new Float64Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    sx[i] = (data[i * 4] / 255) * 2 - 1;
    sy[i] = (data[i * 4 + 1] / 255) * 2 - 1;
  }

  console.log('\n' + '='.repeat(96));
  console.log('SURFACE RELIEF — what the SHARED bump map still carries, per surface (issue #86)');
  console.log('='.repeat(96));
  console.log(`Facet slope in degrees RMS, off the real ${SIZE}px normal map and each surface's own`);
  console.log(`tiling scale and normalStrength. "kept" is relief a pixel can hold — coarser than`);
  console.log(`${ALIAS_MM}mm — and has to SURVIVE. "fine" is finer than ${ALIAS_MM}mm and has to be GONE. Both`);
  console.log(`asserted. ">=${RELIEF_KEEP_MM}mm" is reported only: see the note above on why it is not a bound.\n`);
  console.log(
    'surface'.padEnd(10) + 'cycles/m'.padStart(10) + 'mm/texel'.padStart(10) +
    'strength'.padStart(10) + 'kept'.padStart(12) + 'fine'.padStart(12) +
    (`>=${RELIEF_KEEP_MM}mm`).padStart(11) + '  verdict',
  );

  /**
   * Sigma, in texels, whose half-power period is `mm` of world.
   *
   * A Gaussian attenuates a sinusoid of period P by exp(-2*pi^2*sigma^2/P^2),
   * which is a half at P = 2*pi*sigma/sqrt(2 ln 2) = 5.336*sigma. So a blur at
   * this sigma keeps what is longer than `mm` and drops what is shorter, with
   * the crossover at `mm` itself.
   */
  const sigmaFor = (mm: number, mmPerTexel: number): number =>
    Math.max(0, mm / mmPerTexel / 5.336);

  const reliefFailures: string[] = [];
  /** Retained slope per surface, so the paint/asphalt ratio can be asserted. */
  const keptDeg = new Map<string, number>();
  for (const [name, profile] of Object.entries(SURFACES)) {
    const strength = profile.normalStrength;
    const mmPerTexel = 1000 / (profile.scaleA * SIZE);
    const [kx, ky] = blurWrapped(sx, sy, SIZE, sigmaFor(RELIEF_KEEP_MM, mmPerTexel));
    const [ax, ay] = blurWrapped(sx, sy, SIZE, sigmaFor(ALIAS_MM, mmPerTexel));
    const fineX = new Float64Array(SIZE * SIZE);
    const fineY = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) { fineX[i] = sx[i] - ax[i]; fineY[i] = sy[i] - ay[i]; }
    const deg = (v: number) => (Math.atan(v * strength) * 180) / Math.PI;
    const coarse = deg(rmsMag(kx, ky));
    const kept = deg(rmsMag(ax, ay));
    const fine = deg(rmsMag(fineX, fineY));
    keptDeg.set(name, kept);

    // A surface that declares no bump at all is not a failure — the wall says so
    // in its own profile, and a planar projection on a vertical face is
    // meaningless. Excluded by its own declaration, not by its numbers.
    const claims = strength > 0 && RELIEF_FLOORED.has(name);
    let verdict = strength > 0
      ? (claims ? 'ok' : 'smooth by design')
      : 'no bump declared';
    if (claims && kept < RELIEF_FLOOR_DEG) {
      verdict = 'FLAT';
      reliefFailures.push(
        `${name}: relief coarser than ${ALIAS_MM}mm is ${kept.toFixed(2)} degrees RMS, ` +
        `floor ${RELIEF_FLOOR_DEG.toFixed(2)} — the surface has been flattened away`,
      );
    }
    if (strength > 0 && fine > ALIAS_CEILING_DEG) {
      verdict = verdict === 'FLAT' ? 'FLAT+ALIASING' : 'ALIASING';
      reliefFailures.push(
        `${name}: relief finer than ${ALIAS_MM}mm is ${fine.toFixed(2)} degrees RMS, ` +
        `ceiling ${ALIAS_CEILING_DEG.toFixed(2)} — it cannot be drawn, only sampled at random`,
      );
    }
    console.log(
      name.padEnd(10) + profile.scaleA.toFixed(2).padStart(10) +
      mmPerTexel.toFixed(2).padStart(10) + strength.toFixed(2).padStart(10) +
      (kept.toFixed(2) + 'deg').padStart(12) + (fine.toFixed(2) + 'deg').padStart(12) +
      (coarse.toFixed(2) + 'deg').padStart(11) + '  ' + verdict,
    );
  }

  // --- PAINT IS A FILM, AND THAT IS NOW ASSERTED — issue #86, closed --------
  //
  // See `PAINT_RELIEF_CEILING`: the bound is the ratio the user's own reference
  // frame shows between painted kerb blocks and the asphalt beside them, so this
  // is the specification and not a ring drawn round our output.
  {
    const paint = keptDeg.get('paint') ?? 0;
    const asphalt = keptDeg.get('asphalt') ?? 0;
    const ratio = asphalt > 0 ? paint / asphalt : Infinity;
    console.log(
      `\npaint vs asphalt: ${paint.toFixed(2)}deg / ${asphalt.toFixed(2)}deg = ${ratio.toFixed(3)}, ` +
      `ceiling ${PAINT_RELIEF_CEILING.toFixed(2)}`,
    );
    console.log(
      '  measured off reference/target/90.png: the reference\'s own painted kerb blocks carry\n' +
      '  0.32 (red) to 0.50 (white) of the asphalt beside them at the same distance. Track paint\n' +
      '  is a thermoplastic FILM and the reference agrees; #86\'s look question is answered.',
    );
    if (ratio > PAINT_RELIEF_CEILING) {
      reliefFailures.push(
        `paint: relief is ${ratio.toFixed(3)} of the asphalt's, ceiling ${PAINT_RELIEF_CEILING.toFixed(2)} — ` +
        'a white line is a smooth film and this one is reading as aggregate (issue #86)',
      );
    }
  }

  console.log(
    `\nbounds: kept >= ${RELIEF_FLOOR_DEG.toFixed(2)}deg, fine <= ${ALIAS_CEILING_DEG.toFixed(2)}deg, ` +
    `paint <= ${PAINT_RELIEF_CEILING.toFixed(2)} x asphalt. The FLOOR is the half that matters: a surface`,
  );
  console.log('flattened to a plane passes any "is it noisy" test, which is why there are two.');
  console.log('This measures the MAP. What a frame DRAWS of it is `probe:grain`, and `probe:grain`');
  console.log('still masks to the road alone — see the note at the head of this section.\n');

  if (reliefFailures.length > 0) {
    for (const f of reliefFailures) console.log('FAIL — ' + f);
    process.exitCode = 1;
  } else {
    console.log(`PASS — every surface that claims relief still carries it at wavelengths a pixel`);
    console.log(`can hold, and none carries anything below ${ALIAS_MM}mm that a pixel could not.`);
  }
}

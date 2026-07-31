import * as THREE from 'three';
import { getCompound, type CompoundId } from '../data/tires';

/**
 * The coloured band on the tyre sidewall.
 *
 * This is the only way a driver — or a spectator — can tell what anyone is
 * running. Without it every car in the field is on the same anonymous black
 * doughnut and a pit stop is invisible, which was exactly the complaint: "you
 * have to know what colour the wheels are".
 *
 * WHY THIS IS GEOMETRY AND NOT A SWATCH. Every other flat-coloured part of the
 * car pins its UVs to a square in the livery atlas, so the whole car is one draw
 * call. The band cannot: the atlas is baked per LIVERY and shared across the
 * field, whereas the compound changes per CAR and changes again at every pit
 * stop. So the band is a separate thin shell with its own material — one
 * material per compound, shared by every car running it, so swapping compound is
 * a material reference assignment and costs nothing.
 *
 * READABILITY. The band has to work at chase-camera distance and at night, which
 * is most of what this game looks like. Three things buy that:
 *   - it wraps the SHOULDER as well as the sidewall, so it is visible from
 *     behind (chase, T-cam) and not only from directly abeam;
 *   - it is wide — a fifth of the tyre radius — rather than the thin hoop a real
 *     Pirelli carries, which disappears past about ten metres;
 *   - it carries a little emissive, so it does not sink to black under night
 *     lighting the way a purely diffuse band does.
 */

/** A point on the tyre's surface of revolution: radius, and position along the axle. */
export interface TyreProfilePoint {
  r: number;
  x: number;
}

/**
 * The tyre's cross-section, from inboard bead to outboard bead.
 *
 * Lives here rather than in CarMesh because the band has to sit exactly on this
 * surface. Two independent copies of these numbers would drift the moment either
 * was tuned, and the failure mode is the band z-fighting through the carcass —
 * which reads as the tyre flickering, not as a mis-set constant.
 */
export function tyreProfile(width: number, tyreR: number, rimR: number): TyreProfilePoint[] {
  const half = width * 0.5;
  return [
    { r: rimR + 0.004, x: -half },
    { r: tyreR * 0.895, x: -half * 1.015 },
    { r: tyreR * 0.995, x: -half * 0.74 },
    { r: tyreR * 1.002, x: 0 },
    { r: tyreR * 0.995, x: half * 0.74 },
    { r: tyreR * 0.895, x: half * 1.015 },
    { r: rimR + 0.004, x: half },
  ];
}

/**
 * Where the band sits, as a position along the profile above.
 *
 * 4.30 is up on the tread shoulder and 5.62 is most of the way down the sidewall
 * to the bead. Starting on the shoulder rather than at the widest point is what
 * makes the band visible from directly astern, which is the one angle the chase
 * and onboard cameras spend all their time at.
 */
const BAND_FROM = 4.30;
const BAND_TO = 5.62;
/** Rows across the band. Enough to follow the shoulder's curve without faceting. */
const BAND_ROWS = 5;
/**
 * How far the shell stands proud of the carcass, metres.
 *
 * Small, because the band and the tyre share a vertex ring and are built at the
 * same angles: parallel facets separated by a constant gap. This only holds
 * while the two stay in phase, which is why the band is parented to the wheel's
 * SPIN group and not to its steer group — see the note in CarMesh.
 */
const BAND_LIFT = 0.006;

function sample(profile: readonly TyreProfilePoint[], t: number): TyreProfilePoint {
  const i = Math.min(Math.floor(t), profile.length - 2);
  const f = t - i;
  const a = profile[i];
  const b = profile[i + 1];
  return { r: a.r + (b.r - a.r) * f, x: a.x + (b.x - a.x) * f };
}

/** Outward normal of the profile at t, in the (x, r) plane. */
function normalAt(profile: readonly TyreProfilePoint[], t: number): { nx: number; nr: number } {
  const e = 0.02;
  const a = sample(profile, Math.max(0, t - e));
  const b = sample(profile, Math.min(profile.length - 1, t + e));
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
 */
export function buildSidewallBands(
  width: number, tyreR: number, rimR: number, radial: number,
): THREE.BufferGeometry {
  const profile = tyreProfile(width, tyreR, rimR);
  const positions: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  for (const side of [1, -1] as const) {
    const base = positions.length / 3;
    for (let k = 0; k <= BAND_ROWS; k++) {
      const f = k / BAND_ROWS;
      // The profile is symmetric, so the inboard band is the outboard one
      // sampled from the far end — no second set of constants.
      const t = side > 0
        ? BAND_FROM + (BAND_TO - BAND_FROM) * f
        : (profile.length - 1) - (BAND_FROM + (BAND_TO - BAND_FROM) * f);
      const p = sample(profile, t);
      const n = normalAt(profile, t);
      // The normal is already outward on BOTH sides — the profile is traversed
      // inboard-to-outboard, so its perpendicular flips sign along with the
      // sidewall it belongs to. Negating the axial term for the inboard ring
      // (which looks like the obvious mirror) pushes that ring 4mm INTO the
      // carcass, and the compound colour half-disappears on exactly the face the
      // driver looks at from the cockpit.
      const px = p.x + n.nx * BAND_LIFT;
      const pr = p.r + n.nr * BAND_LIFT;
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        positions.push(px, Math.sin(a) * pr, Math.cos(a) * pr);
        uvs.push(i / radial, f);
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

// ===========================================================================
// Per-compound material
// ===========================================================================

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

const textureCache = new Map<CompoundId, THREE.CanvasTexture>();
const materialCache = new Map<CompoundId, THREE.MeshStandardMaterial>();

function bandTexture(id: CompoundId): THREE.CanvasTexture {
  const hit = textureCache.get(id);
  if (hit) return hit;

  const compound = getCompound(id);
  const W = 1024;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const hex = '#' + compound.colour.toString(16).padStart(6, '0');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, W, H);

  // The compound name, repeated around the tyre the way a real sidewall carries
  // it. v runs across the band and u around the circumference, so text drawn
  // straight in canvas space reads the right way up on the wheel.
  ctx.fillStyle = INK[id];
  ctx.font = `700 ${Math.round(H * 0.52)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = compound.name.toUpperCase();
  const repeats = 6;
  for (let i = 0; i < repeats; i++) {
    ctx.fillText(label, ((i + 0.5) / repeats) * W, H * 0.5);
  }

  // Feather both edges to black. A band that stops dead in the middle of the
  // rubber looks like a decal that has been slapped on; fading it out reads as
  // the moulded-in ring it is meant to be, and hides the 5mm step.
  const fade = (from: number, to: number) => {
    const g = ctx.createLinearGradient(0, from, 0, to);
    g.addColorStop(0, 'rgba(14,15,18,1)');
    g.addColorStop(1, 'rgba(14,15,18,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.min(from, to), W, Math.abs(to - from));
  };
  fade(0, H * 0.16);
  fade(H, H * 0.82);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  textureCache.set(id, tex);
  return tex;
}

/**
 * The material for a compound, shared by every car running it.
 *
 * The emissive term is not stylistic. Most of this game is run under floodlights
 * at night, and a band lit only by a dim key light reads as dark grey whatever
 * colour it is — soft and hard become indistinguishable at ten metres. A quarter
 * of the texture added back as emission keeps the hue alive in shadow without
 * making the tyre glow.
 */
export function sidewallMaterial(id: CompoundId): THREE.MeshStandardMaterial {
  const hit = materialCache.get(id);
  if (hit) return hit;
  const tex = bandTexture(id);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: tex,
    emissiveIntensity: 0.26,
    roughness: 0.62,
    metalness: 0.0,
  });
  materialCache.set(id, mat);
  return mat;
}

export function disposeTyreTextureCache(): void {
  for (const m of materialCache.values()) m.dispose();
  for (const t of textureCache.values()) t.dispose();
  materialCache.clear();
  textureCache.clear();
}

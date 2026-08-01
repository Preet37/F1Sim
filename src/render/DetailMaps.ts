import * as THREE from 'three';

/**
 * The car's two committed image textures, loaded once and shared by the field.
 *
 * These are the only assets on the car that are LOADED rather than drawn.
 * Everything else — the livery, the tyre paint, the surface map, the contact
 * shadow — is painted into a canvas at startup, and rightly so: those vary per
 * team and per compound, so a file per variation would be twenty files that
 * still could not cover a renumbered car. These two vary not at all, and they
 * are far too fine to draw with 2D canvas primitives at any sane cost. See
 * scripts/generateTextures.mjs, which computes both from first principles.
 *
 * They live in their own module rather than in CarMesh because the wheel
 * material is built in TyreTexture, and TyreTexture must not import CarMesh —
 * CarMesh already imports it.
 *
 * DEGRADING GRACEFULLY. Materials are built and returned with no normal map
 * attached; three.js fills it in when the file arrives and recompiles the
 * program. A car therefore appears on the first frame whether the texture has
 * loaded, is still in flight, or has failed outright, and the only difference
 * is how its surfaces catch the light. Nothing waits on a download.
 *
 * NODE. The validation scripts import the render layer for its geometry, and
 * there is no `document` there. Returning null is how that stays true.
 */

const cache = new Map<string, THREE.Texture>();

function load(file: string, repeat: boolean): THREE.Texture | null {
  const hit = cache.get(file);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const tex = new THREE.TextureLoader().load(`${base}textures/${file}`);
  // A normal map is a vector field, not a colour: it must not be sRGB-decoded.
  // Getting this wrong tilts every normal toward the surface and the relief
  // comes out looking like a photograph of relief.
  tex.colorSpace = THREE.NoColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  cache.set(file, tex);
  return tex;
}

/**
 * Carbon 2/2 twill, tileable, sampled through the car's SECOND uv set.
 *
 * That second set is box-projected in metres — see `addDetailUV` in CarMesh —
 * so this lands at the same physical scale on a wishbone and on a floor.
 */
export function carbonWeaveMap(): THREE.Texture | null {
  return load('carbon_weave_normal.png', true);
}

/**
 * The moulded relief of a tyre, laid out to match the wheel atlas exactly.
 *
 * Sampled through the FIRST uv set, because the wheel already has a real
 * parameterisation there: u once around the circumference, v across the
 * profile. The bottom 46 per cent of the map is flat, which is the part of the
 * atlas the rim, disc and caliper swatches occupy.
 */
export function tyreSurfaceMap(): THREE.Texture | null {
  return load('tyre_surface_normal.png', true);
}

export function disposeDetailMaps(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

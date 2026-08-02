import { installCanvasStub } from './lib/domStub';

installCanvasStub();

import * as THREE from 'three';
import { carPartsForProbe } from '../src/render/CarMesh';

const parts = carPartsForProbe('high');
// Everything that could stand between an eye in front and the roll hoop.
const blockers = parts.filter((p) => !p.name.includes('throat') && !p.name.includes('side inlet'));
const group = new THREE.Group();
for (const b of blockers) {
  group.add(new THREE.Mesh(b.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
}
group.updateMatrixWorld(true);

function hiddenFrom(name: string, eye: THREE.Vector3): void {
  const part = parts.find((p) => p.name === name);
  if (!part) { console.log(name, 'MISSING'); return; }
  const pos = part.geometry.attributes.position as THREE.BufferAttribute;
  const ray = new THREE.Raycaster();
  const v = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let hidden = 0, total = 0;
  const seen = new THREE.Box3().makeEmpty();
  const by = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    dir.copy(v).sub(eye);
    const d = dir.length();
    dir.divideScalar(d);
    ray.set(eye, dir);
    ray.far = d + 1;
    const hits = ray.intersectObject(group, true);
    total++;
    if (hits.length && hits[0].distance < d - 0.0005) {
      hidden++;
      const nm = blockers[group.children.indexOf(hits[0].object as THREE.Mesh)]?.name ?? '?';
      by.set(nm, (by.get(nm) ?? 0) + 1);
    } else seen.expandByPoint(v);
  }
  const vis = total - hidden;
  console.log(
    name.padEnd(22),
    `${String(vis).padStart(4)}/${total} visible`,
    vis
      ? `x ${seen.min.x.toFixed(3)}..${seen.max.x.toFixed(3)} y ${seen.min.y.toFixed(3)}..${seen.max.y.toFixed(3)} z ${seen.min.z.toFixed(3)}..${seen.max.z.toFixed(3)}`
      : '',
    '| blocked by',
    [...by].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}:${n}`).join(' '),
  );
}

for (const [label, eye] of [
  ['the tmpHoop camera', new THREE.Vector3(0.30, 1.02, 1.55)],
  ['front three-quarter, high', new THREE.Vector3(2.0, 1.5, 3.0)],
] as const) {
  console.log(`-- ${label} --`);
  for (const n of ['airbox throat', 'airbox side inlet R']) hiddenFrom(n, eye as THREE.Vector3);
}

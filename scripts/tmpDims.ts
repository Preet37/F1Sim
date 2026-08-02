import { installCanvasStub } from './lib/domStub';

installCanvasStub();

import * as THREE from 'three';
import { carPartsForProbe } from '../src/render/CarMesh';

const parts = carPartsForProbe('high');

function box(pred: (n: string) => boolean): THREE.Box3 {
  const b = new THREE.Box3().makeEmpty();
  for (const p of parts) {
    if (!pred(p.name)) continue;
    b.union(new THREE.Box3().setFromBufferAttribute(
      p.geometry.attributes.position as THREE.BufferAttribute,
    ));
  }
  return b;
}

function show(label: string, b: THREE.Box3): void {
  if (b.isEmpty()) { console.log(label.padEnd(34), 'EMPTY'); return; }
  const s = b.getSize(new THREE.Vector3());
  console.log(
    label.padEnd(34),
    `span ${(s.x * 1000).toFixed(0)}mm  chord ${(s.z * 1000).toFixed(0)}mm  height ${(s.y * 1000).toFixed(0)}mm`,
    `| z ${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}  y ${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}`,
  );
}

console.log('=== FRONT WING ===');
show('whole assembly', box((n) => n.startsWith('front wing') || n.startsWith('footplate') || n.startsWith('upper flick') || n.startsWith('diveplane')));
for (const p of parts) {
  if (/front wing|footplate|upper flick|diveplane|nose/.test(p.name)) {
    show('  ' + p.name, new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position as THREE.BufferAttribute));
  }
}

console.log('\n=== REAR WING ===');
show('whole assembly', box((n) => /rear wing|DRS|beam wing|swan|pylon/.test(n)));
for (const p of parts) {
  if (/rear wing|DRS|beam wing|pylon/.test(p.name)) {
    show('  ' + p.name, new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position as THREE.BufferAttribute));
  }
}

console.log('\n=== WHEELS AND BODY ===');
for (const p of parts) {
  if (/wheel|tyre|cover|winglet|upright/.test(p.name)) {
    show('  ' + p.name, new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position as THREE.BufferAttribute));
  }
}
show('everything', box(() => true));

import { installCanvasStub } from './lib/domStub';
installCanvasStub();
import * as THREE from 'three';
import { carPartsForProbe } from '../src/render/CarMesh';
for (const p of carPartsForProbe('high')) {
  const b = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position as THREE.BufferAttribute);
  console.log(p.name.padEnd(28),
    `x ${b.min.x.toFixed(3)}..${b.max.x.toFixed(3)}`,
    `y ${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}`,
    `z ${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}`);
}

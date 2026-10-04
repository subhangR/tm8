/**
 * THE KIT'S SOLIDS — the whole geometry vocabulary of the diorama.
 *
 * Every building, prop and robot is composed from these twelve unit solids,
 * each drawn as ONE instanced batch (scene-batch.tsx). A new asset type adds
 * parts, never a draw call. Unit conventions, all centred on the origin unless
 * noted, so builders can reason about sizes as plain scale factors:
 *
 *  box       1×1×1 cube.
 *  cone      4-sided pyramid, radius 1, height 1 (rotate π/4 for a square hip roof).
 *  spire     round cone, radius 1, height 1 (towers and finials).
 *  cylinder  radius 1, height 1, 12 sides.
 *  orb       icosphere radius 1.
 *  gem       octahedron radius 1.
 *  ring      torus radius 1, thin tube; lies in XY.
 *  paving    flat 1×1 quad on the ground.
 *  disc      flat circle radius 1 on the ground.
 *  prism     triangular gable: ridge along X (length 1), base 1 deep (Z), 1 tall,
 *            base at y = -.5. `ry = π/2` turns the gable to face the door (+Z).
 *  dome      hemisphere radius 1, BASE AT y = 0.
 *  arch      half torus radius 1 in XY, feet at y = 0, chunky tube.
 */
import * as THREE from 'three';

export type KitSolid = 'box' | 'cone' | 'spire' | 'cylinder' | 'orb' | 'gem' | 'ring' | 'paving' | 'disc' | 'prism' | 'dome' | 'arch';

function prism(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-.5, -.5); shape.lineTo(.5, -.5); shape.lineTo(0, .5); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  // Extrusion runs along +Z; turn it to run along X and centre it.
  g.rotateY(Math.PI / 2).translate(-.5, 0, 0);
  return g;
}

export const KIT_GEOMETRIES: Readonly<Record<KitSolid, () => THREE.BufferGeometry>> = {
  paving: () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  disc: () => new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2),
  box: () => new THREE.BoxGeometry(),
  cone: () => new THREE.ConeGeometry(1, 1, 4),
  spire: () => new THREE.ConeGeometry(1, 1, 12),
  cylinder: () => new THREE.CylinderGeometry(1, 1, 1, 12),
  orb: () => new THREE.IcosahedronGeometry(1, 1),
  gem: () => new THREE.OctahedronGeometry(1),
  ring: () => new THREE.TorusGeometry(1, .055, 5, 32),
  prism,
  dome: () => new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  arch: () => new THREE.TorusGeometry(1, .12, 5, 14, Math.PI),
};

export const KIT_SOLIDS = Object.keys(KIT_GEOMETRIES) as KitSolid[];

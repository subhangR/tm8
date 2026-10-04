/**
 * The robots on the map: one per live session, drawn through INSTANCING.
 * Every body part is ONE InstancedMesh holding that part for every robot, so
 * the draw-call count is a constant (one per part) however many sessions run.
 * Placement comes from `robots.ts` (the swappable seam); this file only draws.
 *
 * PLACEHOLDER LOOK. The asset lane owns `assets/**` and will swap the robot's
 * appearance; the seam for that is `ROBOT_PARTS` below — a part is a geometry,
 * a tint role and the local offsets it takes on one robot. Nothing else in the
 * scene knows the robot's shape.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { StoryView } from '../model';
import type { Palette } from './palette';
import { seedOf, tint } from './scenery';
import type { World } from './world';
import { robotsFor, type Robot } from './robots';
import './story-game-robots.css';

type Tint = 'body' | 'dark' | 'accent' | 'shade' | 'orb';
interface RobotPart {
  key: string;
  geometry: () => THREE.BufferGeometry;
  tint: Tint;
  /** Local [x, y, z] of each copy on one robot (legs and arms have two). */
  offsets: ReadonlyArray<readonly [number, number, number]>;
  /** Takes part in picking (clicking a robot). */
  pick?: boolean;
}

/** THE LOOK SEAM — chibi proportions borrowed from scene-character.tsx, boxier head, antenna. */
export const ROBOT_PARTS: readonly RobotPart[] = [
  { key: 'shade', geometry: () => new THREE.CircleGeometry(.46, 20).rotateX(-Math.PI / 2), tint: 'shade', offsets: [[0, .025, 0]] },
  { key: 'leg', geometry: () => new THREE.CapsuleGeometry(.12, .22, 3, 6), tint: 'dark', offsets: [[-.17, .26, .045], [.17, .26, .045]], pick: true },
  { key: 'torso', geometry: () => new THREE.CapsuleGeometry(.27, .28, 4, 8), tint: 'body', offsets: [[0, .7, 0]], pick: true },
  { key: 'arm', geometry: () => new THREE.CapsuleGeometry(.1, .23, 3, 6), tint: 'body', offsets: [[-.33, .72, 0], [.33, .72, 0]], pick: true },
  { key: 'head', geometry: () => new THREE.BoxGeometry(.56, .5, .52), tint: 'body', offsets: [[0, 1.26, 0]], pick: true },
  { key: 'visor', geometry: () => new THREE.BoxGeometry(.38, .13, .06), tint: 'dark', offsets: [[0, 1.28, .27]] },
  { key: 'antenna', geometry: () => new THREE.CylinderGeometry(.03, .03, .3, 6), tint: 'dark', offsets: [[0, 1.66, 0]] },
  { key: 'tip', geometry: () => new THREE.IcosahedronGeometry(.07, 0), tint: 'accent', offsets: [[0, 1.84, 0]] },
  /** The attention orb: scaled to nothing unless the robot carries attention. */
  { key: 'orb', geometry: () => new THREE.IcosahedronGeometry(.16, 1), tint: 'orb', offsets: [[0, 2.3, 0]] },
];
const ORB = ROBOT_PARTS.findIndex((p) => p.key === 'orb');
/** Idle motion is refreshed at most this often; reduced motion refreshes once. */
const TICK = 1 / 30;
/** Screen anchor of the DOM pip, above the orb. */
const PIP_HEIGHT = 2.75;

export interface RobotsProps {
  view: StoryView;
  world: World;
  palette: Palette;
  reduced: boolean;
  /** A duel is up: the DOM pips step aside like the place labels do. */
  hidden?: boolean;
  onPlaceClick: (placeId: string, open: boolean) => void;
}

/** Hue slot for a session id. seedOf is FNV-1a, whose high bits barely move between
 * neighbouring ids (sibling sessions share a prefix), so finish with a murmur3 avalanche
 * before taking the modulo. */
export function robotHue(id: string, slots: number): number {
  let h = Math.floor(seedOf(id) * 4294967296);
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) % slots;
}

/** A session's tint: one of four palette hues chosen by a hash of its id, softened toward the card colour. */
export function robotTint(id: string, palette: Palette): string {
  const hues = [palette.info, palette.merged, palette.run, palette.brand];
  return tint(hues[robotHue(id, hues.length)]!, palette.card, .12);
}

export function Robots({ view, world, palette, reduced, hidden = false, onPlaceClick }: RobotsProps) {
  const robots = useMemo(() => robotsFor(view, world), [view, world]);
  const meshes = useRef<Array<THREE.InstancedMesh | null>>([]);
  const last = useRef(-1);
  const laidOut = useRef(false);
  const { camera, gl } = useThree();
  const scratch = useMemo(() => ({ root: new THREE.Object3D(), local: new THREE.Matrix4(), out: new THREE.Matrix4(), v: new THREE.Vector3(), color: new THREE.Color() }), []);

  const geometries = useMemo(() => ROBOT_PARTS.map((p) => p.geometry()), []);
  useEffect(() => () => { for (const g of geometries) g.dispose(); }, [geometries]);
  const materials = useMemo(() => {
    const toon = () => new THREE.MeshToonMaterial();
    const by: Record<Tint, THREE.Material> = {
      body: toon(), dark: toon(), accent: toon(),
      shade: new THREE.MeshBasicMaterial({ color: palette.ink, transparent: true, opacity: .2, depthWrite: false }),
      orb: new THREE.MeshStandardMaterial({ color: palette.wait, emissive: palette.wait, emissiveIntensity: .9, roughness: .4 }),
    };
    return by;
  }, [palette]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);

  // Colours are static per robot; set them whenever the robots or the palette change.
  useEffect(() => {
    ROBOT_PARTS.forEach((part, pi) => {
      const mesh = meshes.current[pi];
      if (!mesh) return;
      robots.forEach((r, ri) => {
        const c = part.tint === 'body' ? robotTint(r.id, palette) : part.tint === 'dark' || part.tint === 'shade' ? palette.ink : palette.wait;
        for (let k = 0; k < part.offsets.length; k++) mesh.setColorAt(ri * part.offsets.length + k, scratch.color.set(c));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    laidOut.current = false;
  }, [robots, palette, scratch]);

  // DOM pips live in the scene's label layer; created imperatively like the place labels.
  const pips = useRef<Map<string, HTMLSpanElement>>(new Map());
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The label layer is the Canvas's sibling inside the stage; the canvas sits two wrappers down.
    let labels: HTMLElement | null = null;
    for (let node = gl.domElement.parentElement; node && !labels; node = node.parentElement) labels = node.querySelector<HTMLElement>(':scope > .sgm-labels');
    if (!labels) return;
    const container = labels.ownerDocument.createElement('div');
    container.className = 'sgm-robot-pips';
    labels.appendChild(container);
    host.current = container;
    return () => { container.remove(); host.current = null; pips.current.clear(); };
  }, [gl]);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    container.classList.toggle('sgm-robot-pips--still', reduced);
    const wanted = new Set(robots.filter((r) => r.attention).map((r) => r.id));
    for (const [id, node] of pips.current) if (!wanted.has(id)) { node.remove(); pips.current.delete(id); }
    for (const id of wanted) if (!pips.current.has(id)) {
      const node = container.ownerDocument.createElement('span');
      node.className = 'sgm-robot-pip sgm-world-label';
      node.textContent = '!';
      node.style.display = 'none';
      container.appendChild(node);
      pips.current.set(id, node);
    }
  }, [robots, reduced]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const width = gl.domElement.clientWidth, height = gl.domElement.clientHeight;
    for (const r of robots) {
      const pip = pips.current.get(r.id);
      if (!pip) continue;
      if (hidden) { pip.style.display = 'none'; continue; }
      scratch.v.set(r.stand.x, PIP_HEIGHT, r.stand.z).project(camera);
      pip.style.display = 'grid';
      pip.style.transform = `translate(${(scratch.v.x * .5 + .5) * width}px, ${(-scratch.v.y * .5 + .5) * height}px) translate(-50%, -100%)`;
    }
    // Reduced motion: lay the robots out once and leave them still.
    if (reduced && laidOut.current) return;
    if (!reduced && t - last.current < TICK && laidOut.current) return;
    last.current = t;
    laidOut.current = true;
    const amount = reduced ? 0 : 1;
    robots.forEach((r, ri) => {
      const phase = seedOf(r.id) * Math.PI * 2;
      scratch.root.position.set(r.stand.x, Math.sin(t * 2.2 + phase) * .035 * amount, r.stand.z);
      scratch.root.rotation.set(0, r.stand.facing, Math.sin(t * 1.3 + phase) * .03 * amount);
      scratch.root.updateMatrix();
      ROBOT_PARTS.forEach((part, pi) => {
        const mesh = meshes.current[pi];
        if (!mesh) return;
        const orbScale = pi === ORB ? (r.attention ? 1 + Math.sin(t * 3 + phase) * .18 * amount : 0) : 1;
        const lift = pi === ORB && r.attention ? Math.sin(t * 1.7 + phase) * .08 * amount : 0;
        part.offsets.forEach(([x, y, z], k) => {
          scratch.local.makeScale(orbScale, orbScale, orbScale).setPosition(x, y + lift, z);
          scratch.out.multiplyMatrices(scratch.root.matrix, scratch.local);
          mesh.setMatrixAt(ri * part.offsets.length + k, scratch.out);
        });
      });
    });
    for (const mesh of meshes.current) if (mesh) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
  });

  const pick = (part: RobotPart) => (e: ThreeEvent<MouseEvent>) => {
    const robot: Robot | undefined = e.instanceId === undefined ? undefined : robots[Math.floor(e.instanceId / part.offsets.length)];
    if (robot?.stand.placeId) { e.stopPropagation(); onPlaceClick(robot.stand.placeId, false); }
  };

  if (!robots.length) return null;
  return <group>
    {ROBOT_PARTS.map((part, pi) => <instancedMesh
      key={`${part.key}/${robots.length}`}
      ref={(m) => { meshes.current[pi] = m; }}
      args={[geometries[pi]!, materials[part.tint], robots.length * part.offsets.length]}
      castShadow={part.tint === 'body' || part.tint === 'dark'}
      frustumCulled={false}
      onClick={part.pick ? pick(part) : undefined}
    />)}
  </group>;
}

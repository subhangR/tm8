/**
 * The robots on the map: one per RUNNING session, drawn through INSTANCING on
 * the asset kit's robot (`assets/kit.ts` robotBody/robotArms, posed by
 * `buildAsset('session-robot')`). Every kit solid the robot uses is ONE
 * InstancedMesh holding that solid for every robot, so the draw-call count is
 * a constant (one per solid) however many sessions run. Placement comes from
 * `robots.ts` (the swappable seam); this file only draws.
 *
 * POSES. The kit's four robot states are the poses: `working` at a task,
 * `blocked` at a blocked task, `waiting` (head tilted, thought bubbles) when
 * the robot carries pending attention, `planned` (idle visor) at the depot.
 * A robot never draws `done`: a finished session is not a robot (W2's rule).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { StoryView } from '../model';
import { KIT_GEOMETRIES, type KitSolid } from './assets/geometry';
import { MOTION, materialsOf } from './assets/kit';
import { assetMetrics, buildAsset } from './assets/prototypes';
import type { AssetState } from './assets/registry';
import type { Palette } from './palette';
import { seedOf, tint } from './scenery';
import type { World } from './world';
import { robotsFor, type Robot } from './robots';
import './story-game-robots.css';

/** The kit's robot poses, in the order this file indexes them. */
export const ROBOT_POSES = ['planned', 'working', 'waiting', 'blocked'] as const satisfies readonly AssetState[];
export type RobotPose = (typeof ROBOT_POSES)[number];

/** The pose a robot takes: attention → waiting; a blocked task → blocked; at a task → working; the depot → idle. */
export function robotPose(robot: Robot, world: Pick<World, 'byId'>): RobotPose {
  if (robot.attention) return 'waiting';
  const place = robot.stand.placeId ? world.byId.get(robot.stand.placeId) : undefined;
  if (!place) return 'planned';
  return place.tone === 'blocked' ? 'blocked' : 'working';
}

interface PosedPart {
  position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3;
  color: string;
  /** Kit metal: takes the session's own tint. */
  tinted: boolean;
  motion: number;
}
export interface RobotBucket {
  geo: KitSolid;
  /** Instances reserved per robot: the most parts of this solid any pose uses. */
  capacity: number;
  byPose: Record<RobotPose, PosedPart[]>;
}

/** The kit's robot in every pose, bucketed by solid. One bucket is one InstancedMesh. */
export function robotBuckets(palette: Palette): RobotBucket[] {
  const metal = materialsOf(palette).metal;
  const byGeo = new Map<KitSolid, RobotBucket>();
  for (const pose of ROBOT_POSES) {
    for (const p of buildAsset('session-robot', palette, { state: pose }).parts) {
      let b = byGeo.get(p.geo);
      if (!b) { b = { geo: p.geo, capacity: 0, byPose: { planned: [], working: [], waiting: [], blocked: [] } }; byGeo.set(p.geo, b); }
      b.byPose[pose].push({
        position: new THREE.Vector3(p.x, p.y, p.z), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rx, p.ry, p.rz)), scale: new THREE.Vector3(p.sx, p.sy, p.sz),
        color: p.color, tinted: p.color === metal, motion: p.motion,
      });
    }
  }
  for (const b of byGeo.values()) b.capacity = Math.max(...ROBOT_POSES.map((pose) => b.byPose[pose].length));
  return [...byGeo.values()];
}

/** Idle motion is refreshed at most this often; reduced motion refreshes once. */
const TICK = 1 / 30;
/** Screen anchor of the DOM pip: the kit's badge socket, a little higher. */
const PIP_HEIGHT = (assetMetrics('session-robot').badgeAnchor?.y ?? 2.1) + .25;

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
  const poses = useMemo(() => robots.map((r) => robotPose(r, world)), [robots, world]);
  const buckets = useMemo(() => robotBuckets(palette), [palette]);
  const meshes = useRef<Array<THREE.InstancedMesh | null>>([]);
  const last = useRef(-1);
  const laidOut = useRef(false);
  const { camera, gl } = useThree();
  const scratch = useMemo(() => ({
    root: new THREE.Object3D(), local: new THREE.Matrix4(), out: new THREE.Matrix4(), none: new THREE.Matrix4().makeScale(0, 0, 0),
    pos: new THREE.Vector3(), v: new THREE.Vector3(), color: new THREE.Color(),
  }), []);

  // One geometry per bucket, carrying the per-instance glow flag for the visor and lamps.
  const geometries = useMemo(() => buckets.map((b) => {
    const g = KIT_GEOMETRIES[b.geo]();
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, robots.length * b.capacity)), 1));
    return g;
  }), [buckets, robots.length]);
  useEffect(() => () => { for (const g of geometries) g.dispose(); }, [geometries]);
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: .62, metalness: .12, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute float aGlow; varying float vGlow;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = `varying float vGlow;\n${shader.fragmentShader}`.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * .7;');
    };
    mat.customProgramCacheKey = () => 'story-robots-kit-v1';
    return mat;
  }, []);
  useEffect(() => () => { material.dispose(); }, [material]);

  // Colours and glow are static per robot and pose; set them whenever the robots or the palette change.
  useEffect(() => {
    buckets.forEach((b, bi) => {
      const mesh = meshes.current[bi];
      if (!mesh) return;
      const glow = mesh.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
      robots.forEach((r, ri) => {
        const parts = b.byPose[poses[ri]!], own = robotTint(r.id, palette);
        for (let k = 0; k < b.capacity; k++) {
          const part = parts[k], i = ri * b.capacity + k;
          mesh.setColorAt(i, scratch.color.set(part ? (part.tinted ? own : part.color) : palette.ink));
          glow.setX(i, part && part.motion === MOTION.glow ? 1 : 0);
        }
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      glow.needsUpdate = true;
    });
    laidOut.current = false;
  }, [robots, poses, buckets, palette, scratch]);

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
      const phase = seedOf(r.id) * Math.PI * 2, pose = poses[ri]!;
      scratch.root.position.set(r.stand.x, Math.sin(t * 2.2 + phase) * .035 * amount, r.stand.z);
      scratch.root.rotation.set(0, r.stand.facing, Math.sin(t * 1.3 + phase) * .03 * amount);
      scratch.root.updateMatrix();
      buckets.forEach((b, bi) => {
        const mesh = meshes.current[bi];
        if (!mesh) return;
        const parts = b.byPose[pose];
        for (let k = 0; k < b.capacity; k++) {
          const part = parts[k], i = ri * b.capacity + k;
          if (!part) { mesh.setMatrixAt(i, scratch.none); continue; }
          // Kit "bob" parts (thought bubbles, the block gem) float; the ground ring is pinned to the floor.
          const lift = part.motion === MOTION.bob ? Math.sin(t * 1.8 + phase + k) * .08 * amount : 0;
          scratch.pos.copy(part.position);
          scratch.pos.y += lift - (part.position.y < .05 ? scratch.root.position.y : 0);
          scratch.local.compose(scratch.pos, part.quaternion, part.scale);
          scratch.out.multiplyMatrices(scratch.root.matrix, scratch.local);
          mesh.setMatrixAt(i, scratch.out);
        }
      });
    });
    for (const mesh of meshes.current) if (mesh) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
  });

  const pick = (b: RobotBucket) => (e: ThreeEvent<MouseEvent>) => {
    const robot: Robot | undefined = e.instanceId === undefined ? undefined : robots[Math.floor(e.instanceId / b.capacity)];
    if (robot?.stand.placeId) { e.stopPropagation(); onPlaceClick(robot.stand.placeId, false); }
  };

  if (!robots.length) return null;
  return <group>
    {buckets.map((b, bi) => <instancedMesh
      key={`${b.geo}/${robots.length}`}
      ref={(m) => { meshes.current[bi] = m; }}
      args={[geometries[bi]!, material, robots.length * b.capacity]}
      castShadow
      frustumCulled={false}
      onClick={pick(b)}
    />)}
  </group>;
}

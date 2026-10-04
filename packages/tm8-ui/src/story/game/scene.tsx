/**
 * THE 3D SCENE — low-poly isometric, drawn with react-three-fiber. Loaded
 * lazily by StoryGame (three.js is ~600 kB; a story that never opens the game
 * never pays for it).
 *
 * The world is a disc. The PLAYER walks it (keys, or a walk order from a
 * click or the quest log — along the roads when both ends are places). The
 * camera is a fixed isometric offset that follows the player. Every place is
 * one of three things: UNSEEN (nothing, or a flat silhouette once it is near
 * or a landmark), REVEALED (it RISES out of the ground the moment the player
 * walks within reach, and stands dimmed until opened), or VISITED (full
 * colour). Live sessions breathe; a landed update bumps; progress is a glow
 * and an arc on the hub, the roots and the portals; a place active in the last
 * hour raises a beacon so "what is happening now" reads from across the map.
 *
 * All colour comes from `Palette` (tokens read at runtime — §14), all shape
 * from `Place.shape` (model.ts tables — §15.2).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { GameControl, WalkOrder } from './control';
import { keyDirection } from './control';
import type { Palette } from './palette';
import { nearestPlace, roadPath, type Place, type PlaceShape, type Road, type World } from './world';

export interface SceneProps {
  world: World;
  palette: Palette;
  control: GameControl;
  revealed: ReadonlySet<string>;
  visited: ReadonlySet<string>;
  landed: ReadonlySet<string>;
  start: { x: number; z: number };
  onReveal: (ids: string[]) => void;
  onNear: (placeId: string | null) => void;
  onArrive: (placeId: string, open: boolean) => void;
  onPosition: (x: number, z: number) => void;
  onGround: (x: number, z: number) => void;
  onPlaceClick: (placeId: string, open: boolean) => void;
}

/* ---- the rules of the land ---- */
export const REVEAL_RADIUS = 4.2;
export const NEAR_RADIUS = 2.1;
const SILHOUETTE_RADIUS = 10;
const LABEL_RADIUS = 9;
const WALK_SPEED = 7;
const ARRIVE_EPS = 0.18;
/** Stop this short of a place, on the near side, so the player stands at its door. */
const DOORSTEP = 1.35;
const CAMERA_OFFSET = new THREE.Vector3(22, 26, 22);
const TAU = Math.PI * 2;

/* Geometry is shared across every place of a shape. */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  roof: new THREE.ConeGeometry(0.8, 0.6, 4),
  cone: new THREE.ConeGeometry(0.75, 1.2, 4),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
  pole: new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6),
  octa: new THREE.OctahedronGeometry(0.55),
  dodeca: new THREE.DodecahedronGeometry(0.45),
  torus: new THREE.TorusGeometry(0.95, 0.13, 8, 24),
  capsule: new THREE.CapsuleGeometry(0.32, 0.55, 4, 8),
  disc: new THREE.CircleGeometry(1, 28),
  pad: new THREE.CircleGeometry(0.9, 20),
};

const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

function colourOf(place: Place, palette: Palette): string {
  if (place.shape === 'hub' || place.shape === 'portal') return palette.brand;
  if (place.shape === 'building') {
    switch (place.tone) {
      case 'done': return palette.run;
      case 'working': return palette.info;
      case 'blocked': return palette.block;
      case 'todo': return palette.line2;
      default: return palette.ink3;
    }
  }
  if (place.shape === 'tent') return place.live ? palette.run : palette.wait;
  if (place.shape === 'library') return palette.merged;
  if (place.shape === 'signpost') return palette.info;
  if (place.shape === 'crystal') return palette.brand;
  if (place.shape === 'camp') return palette.wait;
  return palette.line2;
}

function roadColour(road: Road, palette: Palette): string {
  switch (road.family) {
    case 'blocks': return palette.block;
    case 'story': return palette.brand;
    case 'runs': return palette.run;
    case 'made': return palette.merged;
    case 'code': return palette.info;
    case 'team': return palette.wait;
    default: return palette.line2;
  }
}

/* ------------------------------------------------------------------------- */

export default function StoryGameScene(props: SceneProps) {
  const playerPos = useRef(new THREE.Vector3(props.start.x, 0, props.start.z));
  return (
    <Canvas
      orthographic
      camera={{ position: [CAMERA_OFFSET.x + props.start.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z + props.start.z], zoom: 30, near: 0.1, far: 400 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      frameloop="always"
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={1.7} />
      <directionalLight position={[10, 18, 6]} intensity={2.2} />
      <directionalLight position={[-8, 10, -10]} intensity={0.6} />
      <Island world={props.world} palette={props.palette} onGround={props.onGround} />
      <Roads world={props.world} palette={props.palette} revealed={props.revealed} />
      {props.world.places.map((p) => (
        <PlaceMesh
          key={p.id}
          place={p}
          palette={props.palette}
          revealed={props.revealed.has(p.id)}
          visited={props.visited.has(p.id)}
          landed={props.landed.has(p.id)}
          playerPos={playerPos}
          onClick={props.onPlaceClick}
        />
      ))}
      <Labels world={props.world} revealed={props.revealed} visited={props.visited} playerPos={playerPos} />
      <Player
        world={props.world}
        palette={props.palette}
        control={props.control}
        revealed={props.revealed}
        playerPos={playerPos}
        onReveal={props.onReveal}
        onNear={props.onNear}
        onArrive={props.onArrive}
        onPosition={props.onPosition}
      />
    </Canvas>
  );
}

/* ---- the ground ---- */
function Island({ world, palette, onGround }: { world: World; palette: Palette; onGround: (x: number, z: number) => void }) {
  const r = world.extent;
  const onClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    onGround(e.point.x, e.point.z);
  };
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.3} scale={[r + 0.8, r + 0.8, 1]}>
        <primitive object={GEO.disc} attach="geometry" />
        <meshStandardMaterial color={palette.line2} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} scale={[r, r, 1]} onClick={onClick}>
        <primitive object={GEO.disc} attach="geometry" />
        <meshStandardMaterial color={palette.card} roughness={1} />
      </mesh>
    </group>
  );
}

/* ---- the roads ---- */
function Roads({ world, palette, revealed }: { world: World; palette: Palette; revealed: ReadonlySet<string> }) {
  return (
    <group>
      {world.roads.map((road) => {
        const a = world.byId.get(road.fromId);
        const b = world.byId.get(road.toId);
        if (!a || !b) return null;
        const ends = (revealed.has(a.id) ? 1 : 0) + (revealed.has(b.id) ? 1 : 0);
        if (ends === 0 && !(a.ring <= 1 && b.ring <= 1)) return null;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        const bridge = road.family === 'blocks';
        return (
          <mesh
            key={road.id}
            position={[(a.x + b.x) / 2, bridge ? 0.08 : 0.01, (a.z + b.z) / 2]}
            rotation-y={-Math.atan2(dz, dx)}
            scale={[len, bridge ? 0.16 : 0.04, bridge ? 0.5 : 0.3]}
          >
            <primitive object={GEO.box} attach="geometry" />
            <meshStandardMaterial
              color={roadColour(road, palette)}
              roughness={1}
              transparent
              opacity={ends === 2 ? (bridge ? 0.95 : 0.8) : 0.3}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---- a place ---- */
interface PlaceMeshProps {
  place: Place;
  palette: Palette;
  revealed: boolean;
  visited: boolean;
  landed: boolean;
  playerPos: React.MutableRefObject<THREE.Vector3>;
  onClick: (placeId: string, open: boolean) => void;
}

function PlaceMesh({ place, palette, revealed, visited, landed, playerPos, onClick }: PlaceMeshProps) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const silhouette = useRef<THREE.Mesh>(null);
  const rise = useRef(revealed ? 1 : 0);
  const landedAt = useRef<number | null>(null);
  useEffect(() => { if (landed) landedAt.current = performance.now(); }, [landed]);
  const landmark = place.ring <= 1;

  useFrame((state, delta) => {
    const g = group.current;
    const b = body.current;
    const s = silhouette.current;
    if (!g || !b || !s) return;
    const d = Math.hypot(place.x - playerPos.current.x, place.z - playerPos.current.z);
    if (revealed) {
      rise.current = Math.min(1, rise.current + delta / 0.7);
      const t = ease(rise.current);
      b.visible = true;
      s.visible = false;
      let bump = 1;
      if (landedAt.current !== null) {
        const age = (performance.now() - landedAt.current) / 1000;
        if (age < 1.2) bump = 1 + Math.sin(age * Math.PI * 3) * 0.12 * (1 - age / 1.2);
        else landedAt.current = null;
      }
      const breathe = place.live ? 1 + Math.sin(state.clock.elapsedTime * 3) * 0.03 : 1;
      b.scale.set(bump * breathe, t * bump * breathe, bump * breathe);
      b.position.y = (t - 1) * 0.6;
      if (place.shape === 'crystal' || place.shape === 'hub') b.rotation.y = state.clock.elapsedTime * 0.4;
      if (place.shape === 'portal') b.rotation.y = -Math.atan2(place.z, place.x) + Math.PI / 2;
    } else {
      b.visible = false;
      s.visible = landmark || d < SILHOUETTE_RADIUS;
    }
  });

  const colour = colourOf(place, palette);
  const dim = revealed && !visited;
  const mat = useMemo(() => ({ color: colour, roughness: 0.85, flatShading: true, transparent: true, opacity: dim ? 0.72 : 1 }), [colour, dim]);
  const glow = place.progress !== null ? place.progress : 0;
  const stop = (e: ThreeEvent<MouseEvent>): void => { e.stopPropagation(); onClick(place.id, false); };
  const stopOpen = (e: ThreeEvent<MouseEvent>): void => { e.stopPropagation(); onClick(place.id, true); };
  const size = place.root ? 1.45 : 1;

  return (
    <group ref={group} position={[place.x, 0, place.z]}>
      <mesh ref={silhouette} rotation-x={-Math.PI / 2} position-y={0.005} scale={place.root || place.portal ? 1.3 : 0.8} onClick={stop}>
        <primitive object={GEO.pad} attach="geometry" />
        <meshStandardMaterial color={palette.ink3} transparent opacity={0.22} roughness={1} />
      </mesh>
      <group ref={body} onClick={stop} onDoubleClick={stopOpen}>
        <mesh rotation-x={-Math.PI / 2} position-y={0.01} scale={size}>
          <primitive object={GEO.pad} attach="geometry" />
          <meshStandardMaterial color={visited ? colour : palette.line} transparent opacity={visited ? 0.35 : 0.5} roughness={1} />
        </mesh>
        <Shape shape={place.shape} size={size} mat={mat} glow={glow} palette={palette} live={place.live} />
        {place.progress !== null ? (
          <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
            <ringGeometry args={[size * 1.05, size * 1.25, 48, 1, Math.PI / 2, -Math.max(0.001, glow * TAU)]} />
            <meshStandardMaterial color={palette.run} transparent opacity={0.9} roughness={1} side={THREE.DoubleSide} />
          </mesh>
        ) : null}
        {place.recent ? (
          <mesh position-y={2.2 * size + 1.4} scale={[0.05, 2.8, 0.05]}>
            <primitive object={GEO.cyl} attach="geometry" />
            <meshStandardMaterial color={palette.brand} emissive={palette.brand} emissiveIntensity={1.2} transparent opacity={0.55} />
          </mesh>
        ) : null}
        {visited ? (
          <mesh position={[size * 0.75, 1.9 * size, -size * 0.6]} scale={0.16}>
            <primitive object={GEO.octa} attach="geometry" />
            <meshStandardMaterial color={palette.brand} emissive={palette.brand} emissiveIntensity={0.6} />
          </mesh>
        ) : null}
      </group>
    </group>
  );
}

interface ShapeProps {
  shape: PlaceShape;
  size: number;
  mat: { color: string; roughness: number; flatShading: boolean; transparent: boolean; opacity: number };
  glow: number;
  palette: Palette;
  live: boolean;
}

function Shape({ shape, size, mat, glow, palette, live }: ShapeProps) {
  const emissive = live ? mat.color : palette.brand;
  switch (shape) {
    case 'hub':
      return (
        <group>
          <mesh position-y={0.25} scale={[1.7, 0.5, 1.7]}>
            <primitive object={GEO.cyl} attach="geometry" />
            <meshStandardMaterial color={palette.line2} roughness={1} flatShading />
          </mesh>
          <mesh position-y={1.35} scale={1.3}>
            <primitive object={GEO.octa} attach="geometry" />
            <meshStandardMaterial color={mat.color} emissive={mat.color} emissiveIntensity={0.25 + glow * 1.1} roughness={0.4} flatShading />
          </mesh>
        </group>
      );
    case 'building':
      return (
        <group scale={size}>
          <mesh position-y={0.5} scale={[1, 1, 1]}>
            <primitive object={GEO.box} attach="geometry" />
            <meshStandardMaterial {...mat} emissive={emissive} emissiveIntensity={live ? 0.35 : glow * 0.8} />
          </mesh>
          <mesh position-y={1.3} rotation-y={Math.PI / 4}>
            <primitive object={GEO.roof} attach="geometry" />
            <meshStandardMaterial color={palette.ink} roughness={1} flatShading transparent opacity={mat.opacity} />
          </mesh>
        </group>
      );
    case 'tent':
      return (
        <mesh position-y={0.6} rotation-y={Math.PI / 4}>
          <primitive object={GEO.cone} attach="geometry" />
          <meshStandardMaterial {...mat} emissive={emissive} emissiveIntensity={live ? 0.5 : 0} />
        </mesh>
      );
    case 'library':
      return (
        <group>
          <mesh position-y={0.35} scale={[1.3, 0.7, 0.9]}>
            <primitive object={GEO.box} attach="geometry" />
            <meshStandardMaterial {...mat} />
          </mesh>
          <mesh position-y={0.78} scale={[1.45, 0.14, 1.05]}>
            <primitive object={GEO.box} attach="geometry" />
            <meshStandardMaterial color={palette.ink} roughness={1} flatShading transparent opacity={mat.opacity} />
          </mesh>
        </group>
      );
    case 'signpost':
      return (
        <group>
          <mesh position-y={0.75}>
            <primitive object={GEO.pole} attach="geometry" />
            <meshStandardMaterial color={palette.ink3} roughness={1} transparent opacity={mat.opacity} />
          </mesh>
          <mesh position={[0.25, 1.2, 0]} scale={[0.95, 0.42, 0.1]}>
            <primitive object={GEO.box} attach="geometry" />
            <meshStandardMaterial {...mat} />
          </mesh>
        </group>
      );
    case 'crystal':
      return (
        <mesh position-y={0.8}>
          <primitive object={GEO.octa} attach="geometry" />
          <meshStandardMaterial {...mat} emissive={mat.color} emissiveIntensity={0.45} roughness={0.3} />
        </mesh>
      );
    case 'camp':
      return (
        <group>
          <mesh position-y={0.7}>
            <primitive object={GEO.capsule} attach="geometry" />
            <meshStandardMaterial {...mat} emissive={emissive} emissiveIntensity={live ? 0.4 : 0} />
          </mesh>
          <mesh position-y={0.08} scale={[0.75, 0.16, 0.75]}>
            <primitive object={GEO.cyl} attach="geometry" />
            <meshStandardMaterial color={palette.line2} roughness={1} />
          </mesh>
        </group>
      );
    case 'portal':
      return (
        <group>
          <mesh position-y={1.15}>
            <primitive object={GEO.torus} attach="geometry" />
            <meshStandardMaterial {...mat} emissive={mat.color} emissiveIntensity={0.3 + glow} roughness={0.5} />
          </mesh>
          <mesh position-y={0.1} scale={[1.2, 0.2, 1.2]}>
            <primitive object={GEO.cyl} attach="geometry" />
            <meshStandardMaterial color={palette.line2} roughness={1} />
          </mesh>
        </group>
      );
    default:
      return (
        <mesh position-y={0.4}>
          <primitive object={GEO.dodeca} attach="geometry" />
          <meshStandardMaterial {...mat} />
        </mesh>
      );
  }
}

/* ---- the names over the near places ---- */
function Labels({ world, revealed, visited, playerPos }: { world: World; revealed: ReadonlySet<string>; visited: ReadonlySet<string>; playerPos: React.MutableRefObject<THREE.Vector3> }) {
  const [near, setNear] = useState<string[]>([]);
  const tick = useRef(0);
  useFrame((_, delta) => {
    tick.current += delta;
    if (tick.current < 0.25) return;
    tick.current = 0;
    const ids: string[] = [];
    for (const p of world.places) {
      if (!revealed.has(p.id)) continue;
      if (Math.hypot(p.x - playerPos.current.x, p.z - playerPos.current.z) < LABEL_RADIUS) ids.push(p.id);
    }
    setNear((cur) => (cur.length === ids.length && cur.every((id, i) => id === ids[i]) ? cur : ids));
  });
  return (
    <group>
      {near.map((id) => {
        const p = world.byId.get(id);
        if (!p) return null;
        const h = p.shape === 'hub' ? 2.6 : p.root ? 2.6 : p.shape === 'portal' ? 2.4 : 1.8;
        return (
          <Html key={id} position={[p.x, h, p.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div className={`sgm-tag${visited.has(id) ? ' sgm-tag--seen' : ''}${p.ring <= 1 ? ' sgm-tag--big' : ''}`}>{p.title}</div>
          </Html>
        );
      })}
    </group>
  );
}

/* ---- the player, the camera and the walk ---- */
interface PlayerProps {
  world: World;
  palette: Palette;
  control: GameControl;
  revealed: ReadonlySet<string>;
  playerPos: React.MutableRefObject<THREE.Vector3>;
  onReveal: (ids: string[]) => void;
  onNear: (placeId: string | null) => void;
  onArrive: (placeId: string, open: boolean) => void;
  onPosition: (x: number, z: number) => void;
}

function Player({ world, palette, control, revealed, playerPos, onReveal, onNear, onArrive, onPosition }: PlayerProps) {
  const mesh = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const follow = useRef(playerPos.current.clone());
  const waypoints = useRef<Array<{ x: number; z: number }>>([]);
  const arrive = useRef<{ placeId: string | null; open: boolean } | null>(null);
  const seenOrder = useRef<WalkOrder | null>(null);
  const known = useRef(new Set<string>());
  const nearId = useRef<string | null>(null);
  const saveTick = useRef(0);
  const revealTick = useRef(0);
  const heading = useRef(0);

  useEffect(() => { for (const id of revealed) known.current.add(id); }, [revealed]);

  useEffect(() => {
    camera.position.copy(playerPos.current).add(CAMERA_OFFSET);
    camera.lookAt(playerPos.current);
  }, [camera, playerPos]);

  const plan = (order: WalkOrder): void => {
    const pos = playerPos.current;
    const target = order.placeId ? world.byId.get(order.placeId) ?? null : nearestPlace(world, order.x, order.z, 1.4);
    arrive.current = target ? { placeId: target.id, open: order.open } : { placeId: null, open: false };
    const from = nearestPlace(world, pos.x, pos.z, 3.2);
    const path = target && from ? roadPath(world, from.id, target.id) : null;
    if (target && path && path.length > 1) {
      const pts = path.map((id) => world.byId.get(id)!).map((p) => ({ x: p.x, z: p.z }));
      // Skip the first node when we already stand past it on the way.
      const head = pts[0]!;
      const next = pts[1]!;
      const toHead = Math.hypot(head.x - pos.x, head.z - pos.z);
      const toNext = Math.hypot(next.x - pos.x, next.z - pos.z);
      const headToNext = Math.hypot(next.x - head.x, next.z - head.z);
      waypoints.current = toNext < headToNext && toHead < 2.5 ? pts.slice(1) : pts;
    } else {
      waypoints.current = [target ? { x: target.x, z: target.z } : { x: order.x, z: order.z }];
    }
    if (target && waypoints.current.length) {
      // The last step ends at the doorstep, pulled back toward where we come from.
      const last = waypoints.current[waypoints.current.length - 1]!;
      const before = waypoints.current.length > 1 ? waypoints.current[waypoints.current.length - 2]! : { x: pos.x, z: pos.z };
      const dx = before.x - last.x;
      const dz = before.z - last.z;
      const d = Math.hypot(dx, dz);
      if (d > DOORSTEP) waypoints.current[waypoints.current.length - 1] = { x: last.x + (dx / d) * DOORSTEP, z: last.z + (dz / d) * DOORSTEP };
    }
  };

  useFrame((state, delta) => {
    const pos = playerPos.current;
    const m = mesh.current;
    if (!m) return;
    const dt = Math.min(delta, 0.05);

    if (control.order !== seenOrder.current) {
      seenOrder.current = control.order;
      if (control.order) plan(control.order);
    }

    const dir = keyDirection(control.keys);
    let moving = false;
    if (dir) {
      waypoints.current = [];
      arrive.current = null;
      pos.x += dir[0] * WALK_SPEED * dt;
      pos.z += dir[1] * WALK_SPEED * dt;
      heading.current = Math.atan2(dir[0], dir[1]);
      moving = true;
    } else if (waypoints.current.length) {
      const w = waypoints.current[0]!;
      const dx = w.x - pos.x;
      const dz = w.z - pos.z;
      const d = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (d <= Math.max(step, ARRIVE_EPS)) {
        pos.x = w.x;
        pos.z = w.z;
        waypoints.current.shift();
        if (!waypoints.current.length && arrive.current?.placeId) {
          const a = arrive.current;
          arrive.current = null;
          onArrive(a.placeId!, a.open);
        }
      } else {
        pos.x += (dx / d) * step;
        pos.z += (dz / d) * step;
        heading.current = Math.atan2(dx, dz);
      }
      moving = true;
    }
    // Stay on the island.
    const r = Math.hypot(pos.x, pos.z);
    if (r > world.extent - 0.6) {
      pos.x *= (world.extent - 0.6) / r;
      pos.z *= (world.extent - 0.6) / r;
    }

    m.position.set(pos.x, 0, pos.z);
    m.rotation.y = heading.current;
    const bob = moving ? Math.abs(Math.sin(state.clock.elapsedTime * 12)) * 0.12 : 0;
    m.children[0]!.position.y = 0.75 + bob;

    follow.current.lerp(pos, 1 - Math.pow(0.001, dt));
    camera.position.copy(follow.current).add(CAMERA_OFFSET);
    camera.lookAt(follow.current);

    // Reveal what is within reach (a few times a second, not every frame).
    revealTick.current += dt;
    if (revealTick.current > 0.15) {
      revealTick.current = 0;
      const fresh: string[] = [];
      for (const p of world.places) {
        if (known.current.has(p.id)) continue;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) <= REVEAL_RADIUS) { known.current.add(p.id); fresh.push(p.id); }
      }
      if (fresh.length) onReveal(fresh);
      const near = nearestPlace(world, pos.x, pos.z, NEAR_RADIUS);
      const id = near?.id ?? null;
      if (id !== nearId.current) { nearId.current = id; onNear(id); }
    }
    saveTick.current += dt;
    if (saveTick.current > 1) { saveTick.current = 0; onPosition(pos.x, pos.z); }
  });

  return (
    <group ref={mesh} position={[playerPos.current.x, 0, playerPos.current.z]}>
      <mesh position-y={0.75}>
        <primitive object={GEO.capsule} attach="geometry" />
        <meshStandardMaterial color={palette.ink} roughness={0.6} flatShading />
      </mesh>
      <mesh position={[0, 1.05, 0.28]} scale={[0.26, 0.12, 0.1]}>
        <primitive object={GEO.box} attach="geometry" />
        <meshStandardMaterial color={palette.card} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.02} scale={0.45}>
        <primitive object={GEO.disc} attach="geometry" />
        <meshStandardMaterial color={palette.ink} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

/** Lazy-loaded diorama. Palette-only colour; graph-kind decisions stay in world.ts. */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameControl, WalkOrder } from './control';
import { keyDirection } from './control';
import type { Palette } from './palette';
import { nearestPlace, roadPath, doorstep, roadObstacles, type Place, type World, type WorldEncounter } from './world';
import { daylightColor, landscapeColors, makeScenery, placeColor, seedOf } from './scenery';
import { SceneryBatch } from './scene-batch';
import { Island, Atmosphere, GroundShadows } from './scene-nature';
import { Character, type CharacterMotion } from './scene-character';
import { DioramaFinish } from './scene-effects';
import { routeRoad, pathLength, type Point } from './roads';

export interface SceneProps {
  world: World; palette: Palette; control: GameControl;
  revealed: ReadonlySet<string>; visited: ReadonlySet<string>; landed: ReadonlySet<string>;
  start: { x: number; z: number }; reduced: boolean;
  duel: { placeId: string; encounter: WorldEncounter } | null;
  onUnavailable: () => void;
  onReveal: (ids: string[]) => void; onNear: (placeId: string | null) => void;
  onArrive: (placeId: string, open: boolean) => void; onPosition: (x: number, z: number) => void;
  onGround: (x: number, z: number) => void; onPlaceClick: (placeId: string, open: boolean) => void;
}
export const REVEAL_RADIUS = 12;
export const NEAR_RADIUS = 3.4;
const LABEL_RADIUS = 14;
const WALK_SPEED = 9;
const ARRIVE_EPS = .18;
const CAMERA_OFFSET = new THREE.Vector3(24, 23, 24);

export default function StoryGameScene(props: SceneProps) {
  const playerPos = useRef(new THREE.Vector3(props.start.x, 0, props.start.z));
  const labelNodes = useRef(new Map<string, HTMLDivElement>());
  const alertNode = useRef<HTMLSpanElement>(null);
  const parts = useMemo(() => makeScenery(props.world, props.palette), [props.world, props.palette]);
  const colors = useMemo(() => landscapeColors(props.palette), [props.palette]);
  return <><Canvas shadows orthographic camera={{ position: [22, 26, 22], zoom: 26, near: .1, far: Math.max(450, props.world.extent * 8) }} dpr={[1, 1.5]}
    gl={{ antialias: false, alpha: false, powerPreference: 'low-power' }}>
    <color attach="background" args={[colors.sea]} />
    <hemisphereLight args={[daylightColor(props.palette), props.palette.info, 1.35]} />
    <Sun world={props.world} palette={props.palette} />
    <ShadowCache world={props.world} revealed={props.revealed} />
    <directionalLight position={[10, 5, -10]} color={props.palette.wait} intensity={.7} />
    <Island world={props.world} palette={props.palette} reduced={props.reduced} onGround={props.onGround} />
    <GroundShadows parts={parts} palette={props.palette} />
    <SceneryBatch parts={parts} revealed={props.revealed} palette={props.palette} reduced={props.reduced} onPlaceClick={props.onPlaceClick} />
    <Atmosphere world={props.world} palette={props.palette} reduced={props.reduced} />
    <PlaceEffects {...props} />
    <Labels control={props.control} world={props.world} revealed={props.revealed} visited={props.visited} playerPos={playerPos} hidden={!!props.duel} nodes={labelNodes} />
    <Player {...props} playerPos={playerPos} alertNode={alertNode} />
    {props.duel && <DuelStage key={props.duel.encounter.id} place={props.world.byId.get(props.duel.placeId)!} encounter={props.duel.encounter} palette={props.palette} reduced={props.reduced} />}
    <FrameBudget />
    <ContextGuard onUnavailable={props.onUnavailable} />
    <DioramaFinish />
  </Canvas>
    <div className="sgm-labels" aria-hidden>
      {props.world.places.map((p) => <div key={p.id} ref={(node) => { if (node) labelNodes.current.set(p.id, node); else labelNodes.current.delete(p.id); }} className="sgm-world-label" style={{ display: 'none' }}>
        <div className={`sgm-tag${props.visited.has(p.id) ? ' sgm-tag--seen' : ''}${p.ring <= 1 ? ' sgm-tag--big' : ''}`}>{p.live && <i />}{p.title}</div>
      </div>)}
      <span ref={alertNode} className="sgm-alert sgm-world-label" style={{ display: 'none' }}>!</span>
    </div>
  </>;
}

function Labels({ control, world, revealed, playerPos, hidden, nodes }: { control: GameControl; world: World; revealed: ReadonlySet<string>; visited: ReadonlySet<string>; playerPos: MutableRefObject<THREE.Vector3>; hidden: boolean; nodes: MutableRefObject<Map<string, HTMLDivElement>> }) {
  const projected = useRef(new THREE.Vector3());
  const { camera, gl } = useThree();
  const ordered = useMemo(() => [...world.places].sort((a, b) => a.ring - b.ring), [world]);
  useFrame(() => {
    const occupied: Array<{ x: number; y: number }> = [];
    const width = gl.domElement.clientWidth, height = gl.domElement.clientHeight;
    for (const p of ordered) {
      const node = nodes.current.get(p.id);
      if (!node) continue;
      const show = !hidden && (control.overview ? p.ring <= 1 : revealed.has(p.id) && Math.hypot(p.x - playerPos.current.x, p.z - playerPos.current.z) < LABEL_RADIUS);
      node.style.display = show ? 'block' : 'none';
      if (!show) continue;
      projected.current.set(p.x, p.shape === 'hub' ? 4.5 : p.root ? 3.4 : 2.7, p.z).project(camera);
      const x = (projected.current.x * .5 + .5) * width, y = (-projected.current.y * .5 + .5) * height;
      if (control.overview && occupied.some((q) => Math.abs(q.x - x) < 175 && Math.abs(q.y - y) < 30)) { node.style.display = 'none'; continue; }
      occupied.push({ x, y });
      node.style.transform = `translate(${(projected.current.x * .5 + .5) * width}px, ${(-projected.current.y * .5 + .5) * height}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

function PlaceEffects(props: SceneProps) {
  return <group>{props.world.places.map((p) => <Discovery key={p.id} place={p} palette={props.palette} revealed={props.revealed.has(p.id)} visited={props.visited.has(p.id)} landed={props.landed.has(p.id)} reduced={props.reduced} />)}</group>;
}
function Discovery({ place, palette, revealed, visited, landed, reduced }: { place: Place; palette: Palette; revealed: boolean; visited: boolean; landed: boolean; reduced: boolean }) {
  const ring = useRef<THREE.Mesh>(null), spark = useRef<THREE.Points>(null), beam = useRef<THREE.Mesh>(null);
  const revealAt = useRef(-100), visitAt = useRef(-100), was = useRef({ revealed, visited, landed });
  const pending = useRef({ reveal: false, visit: false });
  useEffect(() => {
    if (revealed && !was.current.revealed) pending.current.reveal = true;
    if ((visited && !was.current.visited) || (landed && !was.current.landed)) pending.current.visit = true;
    was.current = { revealed, visited, landed };
  }, [revealed, visited, landed]);
  const vertices = useMemo(() => {
    const array = new Float32Array(18 * 3);
    for (let i = 0; i < 18; i++) { const a = i * 2.4; array[i * 3] = Math.cos(a); array[i * 3 + 1] = seedOf(`${place.id}/${i}`) * 1.2; array[i * 3 + 2] = Math.sin(a); }
    return array;
  }, [place.id]);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (pending.current.reveal) { revealAt.current = t; pending.current.reveal = false; }
    if (pending.current.visit) { visitAt.current = t; pending.current.visit = false; }
    const r = t - revealAt.current, v = t - visitAt.current;
    if (ring.current) {
      ring.current.visible = r < 1.5;
      ring.current.scale.setScalar(1 + r * (reduced ? .6 : 2.7));
      (ring.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - r / 1.5) * .65;
    }
    if (spark.current) { spark.current.visible = v < 1.7; spark.current.position.y = .7 + v * .65; spark.current.scale.setScalar(1 + v * (reduced ? .2 : .8)); (spark.current.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - v / 1.7); }
    if (beam.current) { beam.current.visible = revealed && place.recent; (beam.current.material as THREE.MeshBasicMaterial).opacity = .045 + Math.sin(t * (reduced ? .3 : 1.4)) * .018; }
  });
  return <group position={[place.x, 0, place.z]}>
    <mesh ref={ring} visible={false} rotation-x={-Math.PI / 2} position-y={.07}><ringGeometry args={[.92, 1, 40]} /><meshBasicMaterial color={palette.card} transparent depthWrite={false} /></mesh>
    <points ref={spark} visible={false}><bufferGeometry><bufferAttribute attach="attributes-position" args={[vertices, 3]} /></bufferGeometry><pointsMaterial color={placeColor(place, palette)} size={.09} transparent depthWrite={false} /></points>
    {place.recent && <mesh ref={beam} position-y={5.2}><cylinderGeometry args={[.11, .5, 8, 10, 1, true]} /><meshBasicMaterial color={palette.wait} transparent opacity={.055} side={THREE.DoubleSide} depthWrite={false} /></mesh>}
  </group>;
}
function Sun({ world, palette }: { world: World; palette: Palette }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  useEffect(() => { const light = sun.current; return () => { light?.shadow.dispose(); }; }, []);
  return <directionalLight ref={sun} position={[-world.extent * .7, world.extent * 1.5, world.extent * .6]} color={daylightColor(palette)} intensity={2.8} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-world.extent - 5} shadow-camera-right={world.extent + 5} shadow-camera-top={world.extent + 5} shadow-camera-bottom={-world.extent - 5} shadow-camera-near={1} shadow-camera-far={world.extent * 4 + 30} shadow-bias={-.0005} shadow-normalBias={.025} />;
}
/** Lower pixel cost on constrained devices; geometry, motion and interaction stay intact. */
function FrameBudget() {
  const elapsed = useRef(0), frames = useRef(0);
  const { setDpr, viewport } = useThree();
  useFrame((_, delta) => {
    elapsed.current += delta; frames.current++;
    if (elapsed.current < 3 || frames.current < 8) return;
    const fps = frames.current / elapsed.current;
    if (fps < 40 && viewport.dpr > .7) setDpr(Math.max(.7, viewport.dpr * .8));
    elapsed.current = 0; frames.current = 0;
  });
  return null;
}
function ContextGuard({ onUnavailable }: { onUnavailable: () => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const lost = (event: Event) => { event.preventDefault(); onUnavailable(); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    return () => gl.domElement.removeEventListener('webglcontextlost', lost);
  }, [gl, onUnavailable]);
  return null;
}
function ShadowCache({ world, revealed }: { world: World; revealed: ReadonlySet<string> }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => { gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true; }, [gl, world, revealed]);
  return null;
}
function DuelStage({ place, encounter, palette, reduced }: { place: Place; encounter: WorldEncounter; palette: Palette; reduced: boolean }) {
  const stage = useRef<THREE.Group>(null), full = useRef(new THREE.Vector3(1, 1, 1));
  useFrame((_, dt) => { if (stage.current) { if (reduced) stage.current.scale.copy(full.current); else stage.current.scale.lerp(full.current, 1 - Math.exp(-8 * dt)); } });
  return <group ref={stage} position={[place.x, 5.2, place.z]} scale={reduced ? 1 : .1}>
    <mesh position-y={-.2}><cylinderGeometry args={[4.1, 3.6, .35, 48]} /><meshToonMaterial color={palette.line2} /></mesh>
    <mesh position-y={.01} rotation-x={-Math.PI / 2}><circleGeometry args={[3.94, 48]} /><meshToonMaterial color={palette.surface} /></mesh>
    <mesh position-y={.03} rotation-x={-Math.PI / 2}><ringGeometry args={[3.75, 3.82, 48]} /><meshBasicMaterial color={palette.wait} /></mesh>
    {[[-1.65, -1.05], [1.65, 1.05]].map(([x, z], i) => <group key={i} position={[x!, .06, z!]}>
      <mesh><cylinderGeometry args={[1.13, 1.27, .12, 32]} /><meshToonMaterial color={i ? palette.info : palette.merged} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={.075}><ringGeometry args={[.93, 1, 32]} /><meshBasicMaterial color={palette.card} /></mesh>
      <group position-y={.1} scale={1.35} rotation-y={i ? Math.PI : 0}><Character palette={palette} reduced={reduced} trainer={!i} phase={i ? 'active' : encounter.phase} /></group>
    </group>)}
    {[-1, 1].map((side) => <mesh key={side} position={[side * 2.8, .4, -side * 1.65]}><octahedronGeometry args={[.22]} /><meshStandardMaterial color={palette.wait} emissive={palette.wait} emissiveIntensity={.7} /></mesh>)}
  </group>;
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
  reduced: boolean;
  duel: SceneProps['duel'];
  alertNode: React.RefObject<HTMLSpanElement | null>;
}

function Player({ world, palette, control, revealed, playerPos, onReveal, onNear, onArrive, onPosition, reduced, duel, alertNode }: PlayerProps) {
  const mesh = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const { gl, size: viewportSize } = useThree();
  const motion = useRef<CharacterMotion>({ moving: false, heading: 0, arrival: -100 });
  const zoom = useRef(1), intro = useRef(0), target = useRef(new THREE.Vector3()), look = useRef(new THREE.Vector3());
  const alertPosition = useRef(new THREE.Vector3());
  const dust = useRef<THREE.Mesh>(null), dustAt = useRef(-100), dustPos = useRef(new THREE.Vector3());
  useEffect(() => {
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom.current = Math.max(.2, Math.min(1.7, zoom.current * Math.exp(-event.deltaY * .001))); };
    gl.domElement.addEventListener('wheel', wheel, { passive: false });
    return () => gl.domElement.removeEventListener('wheel', wheel);
  }, [gl]);
  const follow = useRef(playerPos.current.clone());
  const waypoints = useRef<Point[]>([]);
  const travelSpeed = useRef(WALK_SPEED);
  const obstacles = useMemo(() => roadObstacles(world.places), [world]);
  const arrive = useRef<{ placeId: string | null; open: boolean } | null>(null);
  const seenOrder = useRef<WalkOrder | null>(null);
  const known = useRef(new Set<string>());
  const nearId = useRef<string | null>(null);
  const saveTick = useRef(0);
  const revealTick = useRef(0);
  const heading = useRef(0);
  const direction = useRef<[number, number]>([0, 0]);

  useEffect(() => { known.current = new Set(revealed); }, [revealed]);

  useEffect(() => {
    camera.position.copy(playerPos.current).add(CAMERA_OFFSET);
    if (!reduced) camera.position.y += 35;
    camera.lookAt(playerPos.current);
  }, [camera, playerPos, reduced]);

  const plan = (order: WalkOrder): void => {
    const pos = playerPos.current;
    const target = order.placeId ? world.byId.get(order.placeId) ?? null : nearestPlace(world, order.x, order.z, 1.4);
    arrive.current = target ? { placeId: target.id, open: order.open } : { placeId: null, open: false };
    const from = nearestPlace(world, pos.x, pos.z, 4);
    const path = target && from ? roadPath(world, from.id, target.id) : null;
    const pts: Point[] = [];
    if (target && path && path.length > 1) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!, b = path[i]!;
        const road = world.roads.find((r) => r.fromId === a && r.toId === b || r.fromId === b && r.toId === a)!;
        const segment = road.fromId === a ? road.points : [...road.points].reverse();
        pts.push(...(i === 1 ? segment : segment.slice(1)));
      }
    } else if (target) pts.push(doorstep(target));
    else {
      // A ground click stays within the safe coast and outside occupied buildings.
      const r = Math.hypot(order.x, order.z), scale = Math.min(1, (world.extent * .959 - 1) / (r || 1));
      const point = { x: order.x * scale, z: order.z * scale };
      for (const o of obstacles) { const d = Math.hypot(point.x - o.x, point.z - o.z); if (d < o.radius + .1) { point.x = o.x; point.z = o.z + o.radius + .2; } }
      pts.push(point);
    }
    // Old saves and keyboard walking can start inside a footprint; leave that
    // footprint first, while all other occupied land still constrains the route.
    const start = { x: pos.x, z: pos.z };
    const clear = obstacles.filter((o) => Math.hypot(start.x - o.x, start.z - o.z) >= o.radius);
    waypoints.current = [...routeRoad(start, pts[0]!, clear).slice(1), ...pts.slice(1)];
    // A selected destination takes at most about eight seconds of travel.
    travelSpeed.current = Math.max(WALK_SPEED, pathLength([start, ...waypoints.current]) / 8);

  };

  useFrame((state, delta) => {
    const pos = playerPos.current;
    const m = mesh.current;
    if (!m) return;
    const dt = Math.min(delta, .25);

    if (control.order !== seenOrder.current) {
      seenOrder.current = control.order;
      if (control.order) plan(control.order);
    }

    const dir = keyDirection(control.keys, direction.current);
    let moving = false;
    if (dir) {
      control.order = null; seenOrder.current = null;
      waypoints.current = [];
      arrive.current = null;
      pos.x += dir[0] * WALK_SPEED * dt;
      pos.z += dir[1] * WALK_SPEED * dt;
      heading.current = Math.atan2(dir[0], dir[1]);
      moving = true;
    } else if (waypoints.current.length) {
      let remaining = travelSpeed.current * Math.min(delta, 1);
      while (remaining > 0 && waypoints.current.length) {
        const w = waypoints.current[0]!, dx = w.x - pos.x, dz = w.z - pos.z, d = Math.hypot(dx, dz);
        if (d > 1e-6) heading.current = Math.atan2(dx, dz);
        if (d <= Math.max(remaining, ARRIVE_EPS)) {
          pos.x = w.x; pos.z = w.z; remaining -= d;
          waypoints.current.shift();
          if (!waypoints.current.length && arrive.current?.placeId) {
            const a = arrive.current; arrive.current = null;
            motion.current.arrival = state.clock.elapsedTime; onArrive(a.placeId!, a.open);
          }
        } else {
          pos.x += dx / d * remaining; pos.z += dz / d * remaining; remaining = 0;
        }
      }
      moving = true;
    }
    // Stay on the island.
    const r = Math.hypot(pos.x, pos.z);
    if (r > world.extent * .959 - 0.6) {
      pos.x *= (world.extent * .959 - 0.6) / r;
      pos.z *= (world.extent * .959 - 0.6) / r;
    }

    m.position.set(pos.x, 0, pos.z);
    if (moving && (!motion.current.moving || state.clock.elapsedTime - dustAt.current > .34)) { dustAt.current = state.clock.elapsedTime; dustPos.current.copy(pos); }
    motion.current.moving = moving; motion.current.heading = heading.current;
    if (dust.current) {
      const age = state.clock.elapsedTime - dustAt.current;
      dust.current.visible = age < .6; dust.current.position.set(dustPos.current.x, .04, dustPos.current.z);
      dust.current.scale.setScalar(.16 + age * (reduced ? .2 : .8));
      (dust.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, .3 - age * .5);
    }
    if (alertNode.current) {
      alertNode.current.style.display = nearId.current && nearId.current !== world.hubId && !duel ? 'grid' : 'none';
      alertPosition.current.set(pos.x, 2.1, pos.z).project(camera);
      alertNode.current.style.transform = `translate(${(alertPosition.current.x * .5 + .5) * gl.domElement.clientWidth}px, ${(-alertPosition.current.y * .5 + .5) * gl.domElement.clientHeight}px) translate(-50%, -100%)`;
    }
    intro.current += dt;
    const entering = reduced ? 0 : Math.max(0, 1 - intro.current / 2.8);
    target.current.copy(pos);
    if (moving) { target.current.x += Math.sin(heading.current) * 1.1; target.current.z += Math.cos(heading.current) * 1.1; }
    const overview = control.overview && !duel;
    if (overview) target.current.set(0, 0, 0);
    const arena = duel ? world.byId.get(duel.placeId) : null;
    if (arena) target.current.set(arena.x, 5.2, arena.z);
    if (reduced) follow.current.copy(target.current);
    else follow.current.lerp(target.current, 1 - Math.exp(-3.5 * dt));
    target.current.copy(follow.current).addScaledVector(CAMERA_OFFSET, overview ? Math.max(1, world.extent / 20) : 1);
    target.current.y += entering * entering * 35;
    if (arena) { target.current.x += 8; target.current.y -= 10; target.current.z -= 9; }
    camera.position.lerp(target.current, reduced ? 1 : 1 - Math.exp(-3.5 * dt));
    look.current.copy(follow.current); look.current.y = arena ? 5.8 : .3;
    camera.lookAt(look.current);
    const baseZoom = Math.max(22, Math.min(43, viewportSize.height / 18));
    const overviewZoom = Math.min(viewportSize.width, viewportSize.height) / (world.extent * 2.5);
    const desired = overview ? overviewZoom : baseZoom * zoom.current * (arena ? 1.55 : nearId.current && nearId.current !== world.hubId ? 1.09 : 1) * (1 - entering * .35);
    camera.zoom = reduced ? desired : THREE.MathUtils.damp(camera.zoom, desired, 3, dt); camera.updateProjectionMatrix();

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
      const ordered = control.order?.placeId ? world.byId.get(control.order.placeId) : null;
      const near = waypoints.current.length ? null : ordered && Math.hypot(ordered.x - pos.x, ordered.z - pos.z) <= NEAR_RADIUS ? ordered : nearestPlace(world, pos.x, pos.z, NEAR_RADIUS);
      const id = near?.id ?? null;
      if (id !== nearId.current) { nearId.current = id; onNear(id); }
    }
    saveTick.current += delta;
    if (saveTick.current > 1) { saveTick.current = 0; onPosition(pos.x, pos.z); }
  });

  return <group>
    <group ref={mesh} visible={!duel} position={[playerPos.current.x, 0, playerPos.current.z]}>
      <Character palette={palette} motion={motion} reduced={reduced} />

    </group>
    <mesh ref={dust} rotation-x={-Math.PI / 2} visible={false}><ringGeometry args={[.66, 1, 16]} /><meshBasicMaterial color={palette.card} transparent depthWrite={false} /></mesh>
  </group>;
}

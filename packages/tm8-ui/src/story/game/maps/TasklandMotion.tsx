import { Suspense, useCallback, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { readStudioPalette } from '../studioPalette';
import { MapAsset } from './MapAsset';
import { emptyTasklandMotion, reconcileTasklandMotion, sampleTasklandTransition, suppressedTasklandPlaces,
  type TasklandMotionInput, type TasklandTransition } from '../taskland-motion';

const colors = readStudioPalette();
const motionNow = () => performance.now();
/** No private model snapshot: the event controller supplies both authoritative builds. */
export function useTasklandMotion(input: TasklandMotionInput & { now?: () => number }) {
  const [record, setRecord] = useState(() => ({ input, state: reconcileTasklandMotion(emptyTasklandMotion(input), input, (input.now ?? motionNow)()) }));
  let current = record;
  if (record.input.model !== input.model || record.input.previousModel !== input.previousModel || record.input.effect !== input.effect ||
      record.input.reducedMotion !== input.reducedMotion || record.input.resetKey !== input.resetKey || record.input.now !== input.now) {
    current = { input, state: reconcileTasklandMotion(record.state, input, (input.now ?? motionNow)()) };
    // Reconcile before commit so suppression and cargo appear in the same frame.
    setRecord(current);
  }
  const finishTransition = useCallback((key: string) => setRecord(previous => ({ ...previous,
    state: { ...previous.state, transitions: previous.state.transitions.filter(t => t.key !== key) } })), []);
  return { transitions: current.state.transitions, suppressedPlaceIds: suppressedTasklandPlaces(current.state.transitions), finishTransition };
}

function CargoFallback() {
  return <mesh position-y={.45}><boxGeometry args={[.65,.9,.65]}/><meshStandardMaterial color={colors.cargo}/></mesh>;
}
function Cart({ width, depth }: { width: number; depth: number }) {
  return <group name="taskland-cart">
    <mesh position-y={.27} castShadow receiveShadow><boxGeometry args={[width,.18,depth]}/><meshStandardMaterial color={colors.cart} roughness={.9}/></mesh>
    {[-1,1].flatMap(x => [-1,1].map(z => <mesh key={`${x}:${z}`} position={[x*(width/2-.16),.16,z*(depth/2-.2)]} rotation-z={Math.PI/2} castShadow>
      <cylinderGeometry args={[.18,.18,.15,10]}/><meshStandardMaterial color={colors.cartWheel} roughness={.8}/>
    </mesh>))}
    <mesh position={[width/2+.35,.26,0]} castShadow><boxGeometry args={[.7,.1,.12]}/><meshStandardMaterial color={colors.cart}/></mesh>
  </group>;
}
export interface TasklandMotionProps {
  transitions: readonly TasklandTransition[]; onComplete: (key: string) => void;
  /** Inject only in a synthetic frame harness. Uses the planner's monotonic ms origin. */
  now?: () => number;
}
export interface TasklandFrameObjects {
  root: Group; cargo: Group | null; dust: Group | null; members: ReadonlyMap<string, Group>;
}
/** Apply one frame to Three objects; shared by the renderer and deterministic frame tests. */
export function applyTasklandFrame(transition: TasklandTransition, now: number, objects: TasklandFrameObjects): boolean {
  const sample = sampleTasklandTransition(transition, now);
  objects.root.position.set(sample.anchor.x, 0, sample.anchor.z);
  if (objects.cargo) objects.cargo.scale.y = sample.height;
  sample.members.forEach(member => objects.members.get(member.entityId)?.position.set(member.position.x-sample.anchor.x,
    transition.kind === 'collapse' ? .18 : .44, member.position.z-sample.anchor.z));
  if (objects.dust) {
    objects.dust.visible = sample.progress > .25 && sample.progress < 1;
    objects.dust.scale.setScalar(.5+sample.progress*1.5);
  }
  objects.root.visible = sample.progress < 1;
  return sample.progress === 1;
}
function MotionCompound({ transition, onComplete, now = motionNow }: { transition: TasklandTransition } & Pick<TasklandMotionProps, 'onComplete' | 'now'>) {
  const root = useRef<Group>(null), cargo = useRef<Group>(null), dust = useRef<Group>(null);
  const members = useRef(new Map<string, Group>()), finished = useRef(false);
  const frame = sampleTasklandTransition(transition, transition.startedAt);
  const minX = Math.min(...transition.members.map(m => m.from.x-transition.from.x-m.place.radius));
  const maxX = Math.max(...transition.members.map(m => m.from.x-transition.from.x+m.place.radius));
  const minZ = Math.min(...transition.members.map(m => m.from.z-transition.from.z-m.place.radius));
  const maxZ = Math.max(...transition.members.map(m => m.from.z-transition.from.z+m.place.radius));
  useFrame(() => {
    if (!root.current || finished.current) return;
    if (applyTasklandFrame(transition, now(), { root:root.current, cargo:cargo.current, dust:dust.current, members:members.current })) {
      finished.current = true; onComplete(transition.key);
    }
  });
  return <group ref={root} name={`taskland-motion:${transition.kind}:${transition.entityId}`} position={[frame.anchor.x,0,frame.anchor.z]}>
    {transition.kind !== 'collapse' && <group position={[(minX+maxX)/2,0,(minZ+maxZ)/2]}><Cart width={Math.max(1.5,maxX-minX+.4)} depth={Math.max(1.5,maxZ-minZ+.4)}/></group>}
    <group ref={cargo} name="taskland-cargo">{transition.members.map(member => <group key={member.place.entityId}
      ref={node => { if (node) members.current.set(member.place.entityId,node); else members.current.delete(member.place.entityId); }}
      position={[member.from.x-frame.anchor.x,transition.kind === 'collapse' ? .18 : .44,member.from.z-frame.anchor.z]}>
      <Suspense fallback={<CargoFallback/>}><MapAsset assetKey={member.place.assetKey} stage={member.place.constructionStage}
        status={member.place.status} size={Math.max(1.6,member.place.radius*1.9)}/></Suspense>
    </group>)}</group>
    {transition.kind === 'collapse' && <group ref={dust} visible={false} name="taskland-collapse-dust">{[-1,0,1].map(x =>
      <mesh key={x} position={[x*.65,.2,.35]}><sphereGeometry args={[.38,8,5]}/><meshStandardMaterial color={colors.collapseDust} transparent opacity={.45} depthWrite={false}/></mesh>)}</group>}
  </group>;
}
/** Frame positions are applied to Three objects; React updates only on transition boundaries. */
export function TasklandMotion({ transitions, onComplete, now }: TasklandMotionProps) {
  return <group name="taskland-transient-layer">{transitions.map(transition => <MotionCompound key={transition.key}
    transition={transition} onComplete={onComplete} now={now}/>)}</group>;
}

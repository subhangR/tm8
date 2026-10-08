import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { MapModel, MapRobot } from '../map-model';
import { LoadedGameAsset, WORKER_POSES } from '../imported-assets';
import { advanceWorker, reconcileWorkers, sessionColor, type WorkerMotion } from './worker-motion';

function Worker({ motion, reduced }: { motion: WorkerMotion; reduced: boolean }) {
  const group = useRef<Group>(null);
  const color = sessionColor(motion.robot.sessionId);
  const [moving, setMoving] = useState(!motion.arrived);
  const movingRef = useRef(moving);
  useEffect(() => { movingRef.current = !motion.arrived; setMoving(!motion.arrived); }, [motion]);
  useFrame((_, delta) => {
    advanceWorker(motion, delta, reduced);
    if (movingRef.current === motion.arrived) { movingRef.current = !motion.arrived; setMoving(!motion.arrived); }
    if (!group.current) return;
    group.current.position.set(motion.position.x, .2, motion.position.z);
    group.current.rotation.y = motion.heading;
    group.current.visible = !motion.returning || !motion.arrived;
  });
  const fallback = <group><mesh position-y={.65} castShadow><boxGeometry args={[.5, .7, .35]}/><meshStandardMaterial color={color}/></mesh><mesh position-y={1.2}><sphereGeometry args={[.25, 8, 8]}/><meshStandardMaterial color={color}/></mesh></group>;
  return <group ref={group} position={[motion.position.x, .2, motion.position.z]} name={motion.robot.id} userData={{ sessionId: motion.robot.sessionId, claimId: motion.robot.claimId }}>
    <LoadedGameAsset assetId="worker" scale={1.2} clip={moving ? 'Walking_A' : WORKER_POSES[motion.returning ? 'idle' : motion.robot.pose]} reducedMotion={reduced} fallback={fallback}/>
    <mesh rotation-x={-Math.PI / 2} position-y={.025}><ringGeometry args={[.46, .6, 24]}/><meshBasicMaterial color={color}/></mesh>
  </group>;
}
/** The same layer renders every shared map; each edge gets an independent moving worker. */
export function WorkerLayer({ model, departures = [], reduced = false }: { model: MapModel; departures?: readonly MapRobot[]; reduced?: boolean }) {
  const previous = useRef(new Map<string, WorkerMotion>());
  const lastSeen = useRef(new Map<string, number>());
  const workers = useMemo(() => reconcileWorkers(previous.current, model, departures), [model, departures]);
  useLayoutEffect(() => {
    const time = Date.now();
    for (const [id, worker] of workers) { previous.current.set(id, worker); lastSeen.current.set(id, time); }
    for (const [id, at] of lastSeen.current) if (time - at > 60_000) { previous.current.delete(id); lastSeen.current.delete(id); }
  }, [workers]);
  return <group name="live-workers">{[...workers.values()].map(motion => <Worker key={motion.robot.id} motion={motion} reduced={reduced}/>)}</group>;
}

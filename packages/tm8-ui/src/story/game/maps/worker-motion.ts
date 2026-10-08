import type { MapModel, MapRobot, Point } from '../map-model';
import { walkingEntrance } from '../map-model/walking-world';

export interface WorkerMotion {
  robot: MapRobot; position: Point; target: Point; heading: number; returning: boolean; arrived: boolean;
}
/** Office is home; maps without an Office portal use the shared entrance/exit. */
export function workerHome(model: MapModel): Point {
  const office = model.portals.find(portal => portal.target.type === 'office');
  return office ? { x: office.x, z: office.z } : walkingEntrance(model);
}
export function sessionColor(sessionId: string): string {
  let hash = 2166136261;
  for (const char of sessionId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360}, 70%, 60%)`;
}
/** Reconcile by claim, retaining the actual interpolated position during a task move. */
export function reconcileWorkers(previous: ReadonlyMap<string, WorkerMotion>, model: MapModel, departures: readonly MapRobot[] = []): Map<string, WorkerMotion> {
  const result = new Map<string, WorkerMotion>(), home = workerHome(model);
  for (const [robot, returning] of [...model.robots.map(robot => [robot, false] as const), ...departures.filter(robot => !model.robots.some(active => active.id === robot.id)).map(robot => [robot, true] as const)]) {
    const old = previous.get(robot.id);
    const moved = !old && !returning ? [...previous.values()].reverse().find(worker => worker.robot.sessionId === robot.sessionId && !model.robots.some(active => active.id === worker.robot.id)) : undefined;
    const target = returning ? home : { x: robot.x, z: robot.z };
    result.set(robot.id, { robot, position: old?.position ?? (moved ? { ...moved.position } : returning ? { x: robot.x, z: robot.z } : { ...home }),
      target, heading: old?.heading ?? moved?.heading ?? 0, returning,
      arrived: !!old?.arrived && old.target.x === target.x && old.target.z === target.z });
  }
  return result;
}
export function advanceWorker(worker: WorkerMotion, seconds: number, reduced: boolean): void {
  const dx = worker.target.x - worker.position.x, dz = worker.target.z - worker.position.z;
  const distance = Math.hypot(dx, dz), step = Math.min(distance, Math.max(0, Math.min(seconds, .1)) * 7);
  if (distance > .001) worker.heading = Math.atan2(dx, dz);
  if (reduced || distance <= step || distance <= .001) {
    worker.position.x = worker.target.x; worker.position.z = worker.target.z; worker.arrived = true;
  } else {
    worker.position.x += dx / distance * step; worker.position.z += dz / distance * step; worker.arrived = false;
  }
}

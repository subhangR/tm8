/**
 * ROBOTS — one per live work session on the story, standing where it works.
 *
 * THIS FILE IS THE SWAPPABLE SEAM. `robotStand` decides WHERE a session's robot
 * stands and `robotsFor` decides WHICH sessions get one; both are pure
 * functions of the page data and the laid-out world, with no three.js in them.
 * The scene (`scene-robots.tsx`) only draws what these return, so a better
 * placement rule — a real "current task" field on StorySession, a per-node
 * pending-attention count, an asset-registry look — replaces this file's
 * internals without touching the renderer.
 *
 * Graph data is the source of truth. The page does NOT say which of several
 * tasks a session is working on right now, nor which node an attention request
 * sits on; wherever this module fills that gap with a heuristic the reason is
 * labelled PROVISIONAL below, both in the returned `reason` and in comments.
 */
import type { StoryPage, StorySession, StoryView, StoryNode } from '../model';
import { ATTENTION_KIND } from '../model';
import { doorstep, type Place, type World } from './world';

/** Why the robot stands where it does. `task` is the only non-provisional reason. */
export type RobotReason = 'task' | 'recent-task' | 'stable' | 'depot';

export interface RobotStand {
  x: number;
  z: number;
  /** Heading, in the Character convention: `atan2(dx, dz)`; a robot faces its place. */
  facing: number;
  /** The place the robot stands at; null for the depot ring. */
  placeId: string | null;
  reason: RobotReason;
}

export interface Robot {
  /** The work session id. */
  id: string;
  callSign: string;
  title: string;
  model: string | null;
  teamMemberId: string | null;
  stand: RobotStand;
  /** Pending attention applies to this robot's task (interim rule, see `robotAttention`). */
  attention: boolean;
}

export interface RobotStandOptions {
  /** The page, for the per-task recency signal (activity and messages). Without it several tasks fall to `stable`. */
  page?: Pick<StoryPage, 'activity' | 'recentMessages'>;
  /** Position in the depot ring when the session has no in-world task. */
  depotIndex?: number;
  /** How many robots share the depot ring (spacing). */
  depotCount?: number;
  /** Position among the robots sharing the same doorstep, so they stand side by side. */
  shareIndex?: number;
  shareCount?: number;
}

/** PROVISIONAL depot geometry: a short arc on the north side of the hub, clear of its doorstep roads. */
const DEPOT_GAP = .7;
const DEPOT_STEP = .5;
/** Robots sharing one doorstep stand this far apart along the apron. */
const SHARE_STEP = 1;

const heading = (fromX: number, fromZ: number, toX: number, toZ: number): number => Math.atan2(toX - fromX, toZ - fromZ);

function standAt(place: Place, reason: RobotReason, shareIndex: number, shareCount: number): RobotStand {
  const door = doorstep(place);
  const x = door.x + (shareIndex - (shareCount - 1) / 2) * SHARE_STEP;
  return { x, z: door.z, facing: heading(x, door.z, place.x, place.z), placeId: place.id, reason };
}

/** The session's tasks that are places in this world, in `taskIds` order (which is NOT recency). */
export function inWorldTasks(session: Pick<StorySession, 'taskIds'>, world: World): Place[] {
  return session.taskIds.map((id) => world.byId.get(id)).filter((p): p is Place => p !== undefined);
}

/**
 * PROVISIONAL heuristic — the newest REAL per-task signal by this session: an
 * activity row whose actor is the session (or its team member) on one of the
 * given tasks, or a message by it anchored on one of them. Null when there is
 * none. This is evidence of recent work, not of a current task.
 */
export function latestTaskSignal(
  session: Pick<StorySession, 'id' | 'teamMemberId'>,
  taskIds: ReadonlySet<string>,
  page: Pick<StoryPage, 'activity' | 'recentMessages'>,
): { taskId: string; at: string } | null {
  const actors = new Set([session.id, session.teamMemberId].filter((id): id is string => !!id));
  let best: { taskId: string; at: string } | null = null;
  const consider = (taskId: string, at: string): void => {
    if (!best || at > best.at || (at === best.at && taskId < best.taskId)) best = { taskId, at };
  };
  for (const a of page.activity) if (a.actorId && actors.has(a.actorId) && taskIds.has(a.entityId)) consider(a.entityId, a.at);
  for (const m of page.recentMessages) if (m.authorId && actors.has(m.authorId) && taskIds.has(m.anchorId)) consider(m.anchorId, m.at);
  return best;
}

/**
 * Where a session's robot stands. Pure; the same inputs always give the same stand.
 *
 * - one in-world task          → its doorstep                          (`task`)
 * - several in-world tasks     → the one with the newest real signal    (`recent-task`, PROVISIONAL)
 *                                none → the lowest task id             (`stable`, PROVISIONAL)
 * - no in-world task           → the depot ring beside the hub          (`depot`, PROVISIONAL)
 *
 * `now` is accepted for parity with the world builders and for future
 * age-based rules; the current rules do not read the clock.
 */
export function robotStand(session: StorySession, world: World, now: number = Date.now(), options: RobotStandOptions = {}): RobotStand {
  void now;
  const tasks = inWorldTasks(session, world);
  const share = options.shareIndex ?? 0, shareCount = Math.max(1, options.shareCount ?? 1);
  if (tasks.length === 1) return standAt(tasks[0]!, 'task', share, shareCount);
  if (tasks.length > 1) {
    // PROVISIONAL: sessions carry no current-task field; recency comes from a real per-task signal.
    const signal = options.page ? latestTaskSignal(session, new Set(tasks.map((t) => t.id)), options.page) : null;
    if (signal) return standAt(world.byId.get(signal.taskId)!, 'recent-task', share, shareCount);
    // PROVISIONAL: no signal → deterministic choice so the robot never jumps between snapshots.
    const stable = [...tasks].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    return standAt(stable, 'stable', share, shareCount);
  }
  // PROVISIONAL: taskless sessions wait in a depot arc north of the hub, spaced by index.
  const hub = world.byId.get(world.hubId);
  const hx = hub?.x ?? 0, hz = hub?.z ?? 0, radius = (hub?.footprint ?? 2) + DEPOT_GAP;
  const index = options.depotIndex ?? 0, count = Math.max(1, options.depotCount ?? 1);
  const angle = Math.PI * 1.5 + (index - (count - 1) / 2) * DEPOT_STEP;
  const x = hx + Math.cos(angle) * radius, z = hz + Math.sin(angle) * radius;
  return { x, z, facing: heading(x, z, hx, hz), placeId: null, reason: 'depot' };
}


/**
 * The node's own pending-attention count (`StoryNode.counts`, PR 1040). The
 * running server may not send it yet: absent means UNKNOWN, never zero, and
 * the caller falls back to the provisional rule.
 */
function pendingAttentionOf(node: StoryNode | undefined): number | null {
  const pending = node?.counts?.pendingAttention;
  return typeof pending === 'number' ? pending : null;
}

/**
 * INTERIM attention rule, until a per-node pending count exists on the page:
 * the story must have pending attention at all, and then
 *  - a node-level count decides when present (not provisional), else
 *  - PROVISIONAL: the robot's task place is adjacent (by road) to an attention-kind node.
 * Depot robots have no task place and never carry the indicator.
 */
export function robotAttention(view: StoryView, stand: RobotStand, world: World, nodes: ReadonlyMap<string, StoryNode>): boolean {
  if (view.state.pendingAttentionCount <= 0 || !stand.placeId) return false;
  const direct = pendingAttentionOf(nodes.get(stand.placeId));
  if (direct !== null) return direct > 0;
  // PROVISIONAL adjacency branch.
  const neighbours = world.adjacency.get(stand.placeId) ?? [];
  return neighbours.some((id) => {
    const kind = nodes.get(id)?.kind ?? world.byId.get(id)?.kind;
    return kind === ATTENTION_KIND;
  });
}

/** Exactly one robot per live session, in `page.sessions` order. Completed sessions get none. */
export function robotsFor(view: StoryView, world: World, now: number = Date.now()): Robot[] {
  const live = view.page.sessions.filter((s) => s.live === true);
  const nodes = new Map(view.page.nodes.map((n) => [n.id, n]));
  // Share counts: sessions at the same doorstep stand side by side; taskless ones fill the depot arc.
  const firstPass = live.map((s) => robotStand(s, world, now, { page: view.page }));
  const byPlace = new Map<string, string[]>();
  const depot: string[] = [];
  live.forEach((s, i) => {
    const stand = firstPass[i]!;
    if (stand.placeId) byPlace.set(stand.placeId, [...(byPlace.get(stand.placeId) ?? []), s.id]);
    else depot.push(s.id);
  });
  return live.map((s, i) => {
    const first = firstPass[i]!;
    const group = first.placeId ? byPlace.get(first.placeId)! : depot;
    const options: RobotStandOptions = first.placeId
      ? { page: view.page, shareIndex: group.indexOf(s.id), shareCount: group.length }
      : { page: view.page, depotIndex: group.indexOf(s.id), depotCount: group.length };
    const stand = robotStand(s, world, now, options);
    return {
      id: s.id, callSign: s.callSign, title: s.title, model: s.model ?? null, teamMemberId: s.teamMemberId,
      stand, attention: robotAttention(view, stand, world, nodes),
    };
  });
}

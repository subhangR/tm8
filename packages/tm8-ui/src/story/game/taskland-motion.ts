import type { MapModel, MapPlace, Point } from './map-model';

/** Structural subset of the authoritative durable task events. */
export type TaskMotionEvent =
  | { type: 'task.status_changed'; taskId: string; from: string; to: string; seq?: number }
  | { type: 'task.criterion_changed'; taskId: string; criterionId: string; criterionText: string; isDone: boolean; done: number; total: number; seq?: number };
export interface TasklandMotionEffect { id: number; taskEvents: readonly TaskMotionEvent[]; count?: number; combined?: boolean }
export type TasklandMotionKind = 'move' | 'ship-out' | 'ship-in' | 'collapse';
export interface TasklandMotionMember {
  place: MapPlace;
  from: Point;
  to: Point;
  /** Exact current snapshot used to invalidate obsolete destinations. Null for departures. */
  target: MapPlace | null;
}
export interface TasklandTransition {
  key: string; entityId: string; kind: TasklandMotionKind;
  startedAt: number; duration: number;
  from: Point; to: Point;
  members: readonly TasklandMotionMember[];
  suppressedPlaceIds: readonly string[];
}
export interface TasklandMotionState {
  modelId: string; lastEffectId: number | null; transitions: readonly TasklandTransition[];
  lastEffectSignature: string | null; lastTaskSeq: number | null; effectRevision: number;
}
export interface TasklandMotionInput {
  model: MapModel; previousModel?: MapModel | null; effect?: TasklandMotionEffect | null;
  reducedMotion?: boolean; resetKey?: string;
}
const point = (p: Point): Point => ({ x: p.x, z: p.z });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x-a.x)*t, z: a.z + (b.z-a.z)*t });
const moved = (a: Point, b: Point) => Math.hypot(a.x-b.x, a.z-b.z) > .01;
const done = (s: string | null) => s === 'done' || s === 'complete' || s === 'completed';
const modelKey = (input: TasklandMotionInput) => `${input.resetKey ?? input.model.id}:${input.model.type}:${input.model.scope.kind}:${input.model.scope.id}`;
export function emptyTasklandMotion(input: TasklandMotionInput): TasklandMotionState {
  return { modelId: modelKey(input), lastEffectId: null, transitions: [], lastEffectSignature:null, lastTaskSeq:null, effectRevision:0 };
}
export function sampleTasklandTransition(transition: TasklandTransition, now: number) {
  const progress = Math.min(1, Math.max(0, (now-transition.startedAt)/transition.duration));
  const eased = progress*progress*(3-2*progress);
  return { progress, anchor: lerp(transition.from, transition.to, eased),
    members: transition.members.map(member => ({ entityId: member.place.entityId, position: lerp(member.from, member.to, eased) })),
    height: transition.kind === 'collapse' ? Math.max(.02, 1-eased) : 1 };
}
function sameTarget(a: MapPlace, b: MapPlace) {
  return a.id === b.id && a.entityId === b.entityId && a.x === b.x && a.z === b.z && a.role === b.role &&
    a.parentId === b.parentId && a.groupId === b.groupId;
}
function stationaryMarker(place: { role: string }) {
  return place.role === 'shipped-marker' || place.role === 'hierarchy-marker';
}
function validTransition(transition: TasklandTransition, places: Map<string, MapPlace>) {
  return transition.members.every(member => {
    const current = places.get(member.place.entityId);
    return member.target ? !!current && sameTarget(member.target, current)
      : !current || stationaryMarker(current);
  });
}
function refreshCargo(transition: TasklandTransition, places: Map<string, MapPlace>): TasklandTransition {
  if (transition.kind !== 'move' && transition.kind !== 'ship-in') return transition;
  return { ...transition, members: transition.members.map(member => {
    const current = places.get(member.place.entityId);
    return current && member.target && sameTarget(member.target, current) ? { ...member, place: current, target: current } : member;
  }) };
}
function family(root: MapPlace, places: readonly MapPlace[]) {
  const ids = new Set([root.entityId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of places) if (p.parentId && ids.has(p.parentId) && !ids.has(p.entityId)) {
      ids.add(p.entityId); changed = true;
    }
  }
  return ids;
}

/**
 * Pure reconciliation: models are inputs, never a persisted animation store.
 * Expired rubble disappears with the lifecycle projection, without a fade.
 * Town admissions without a task completion fact appear directly from the snapshot.
 */
export function reconcileTasklandMotion(state: TasklandMotionState, input: TasklandMotionInput, now: number): TasklandMotionState {
  const { model, previousModel: previous, effect } = input;
  const key = modelKey(input);
  const current = new Map(model.places.map(p => [p.entityId, p]));
  const signature = effect ? JSON.stringify(effect.taskEvents.map(event => event.type === 'task.status_changed'
    ? [event.type,event.taskId,event.seq ?? null,event.from,event.to]
    : [event.type,event.taskId,event.seq ?? null,event.criterionId,event.criterionText,event.isDone,event.done,event.total])) : null;
  const sequences = effect?.taskEvents.flatMap(event => event.seq === undefined ? [] : [event.seq]) ?? [];
  const previousTaskSeq = key === state.modelId ? state.lastTaskSeq : null;
  const lastTaskSeq = sequences.length ? Math.max(previousTaskSeq ?? -Infinity,...sequences) : previousTaskSeq;
  const reset = key !== state.modelId || !previous || previous.id !== model.id || previous.type !== model.type ||
    previous.scope.id !== model.scope.id || previous.scope.kind !== model.scope.kind || input.reducedMotion ||
    (model.type !== 'taskland' && model.type !== 'town');
  if (reset) return { modelId:key,lastEffectId:effect?.id ?? null,transitions:[],lastEffectSignature:signature,lastTaskSeq,effectRevision:0 };
  const prior = new Map(previous.places.map(p => [p.entityId, p]));
  const live = state.transitions.filter(t => sampleTasklandTransition(t, now).progress < 1).map(t => refreshCargo(t, current));
  if (!effect || (effect.id === state.lastEffectId && signature === state.lastEffectSignature)) return { ...state, transitions:live.filter(t => validTransition(t,current)) };
  if (state.lastEffectId !== null && effect.id < state.lastEffectId) return { ...state, transitions:[] };
  const revision = state.effectRevision+1;

  // Keep only the final status fact per task in a combined burst; snapshots own the route.
  const statuses = new Map<string, Extract<TaskMotionEvent, { type: 'task.status_changed' }>>();
  for (const event of effect.taskEvents) if (event.type === 'task.status_changed' &&
      (event.seq === undefined || state.lastTaskSeq === null || event.seq > state.lastTaskSeq)) {
    const existing = statuses.get(event.taskId);
    if (!existing || event.seq === undefined || existing.seq === undefined || event.seq >= existing.seq) statuses.set(event.taskId,event);
  }
  const samples = new Map<string, { place: MapPlace; position: Point }>();
  for (const transition of live) {
    const frame = sampleTasklandTransition(transition, now);
    transition.members.forEach((member, i) => samples.set(member.place.entityId, { place: member.place, position: frame.members[i]!.position }));
  }
  const planned: TasklandTransition[] = [];
  const claimed = new Set<string>();
  function add(kind: TasklandMotionKind, root: MapPlace, members: TasklandMotionMember[], from: Point, to: Point) {
    if (!members.length) return;
    const distance = Math.hypot(from.x-to.x, from.z-to.z);
    const duration = kind === 'collapse' ? 900 : Math.min(3200, Math.max(1200, 900+distance*38));
    planned.push({ key: `${effect!.id}:${revision}:${root.entityId}`, entityId: root.entityId, kind, startedAt: now, duration,
      from, to, members, suppressedPlaceIds: members.filter(m => m.target?.role === 'entity' && kind !== 'collapse').map(m => m.target!.id) });
    members.forEach(m => claimed.add(m.place.entityId));
  }
  const source = (p: MapPlace) => samples.get(p.entityId)?.position ?? point(p);
  const visual = (p: MapPlace) => samples.get(p.entityId)?.place ?? p;
  if (model.type === 'town') {
    if ([...statuses.values()].some(event => done(event.to))) {
      const yard = (model as MapModel & { shippingYard?: { position: Point } }).shippingYard?.position ?? { x: 0, z: -12 };
      for (const p of model.places) if (!prior.has(p.entityId) && p.role === 'entity' && p.constructionStage !== 'rubble' && p.status !== 'cancelled') {
        add('ship-in', p, [{ place: p, from: point(yard), to: point(p), target: p }], point(yard), point(p));
      }
    }
  } else {
    // Terminal changes are independent, even when a parent completes in the same burst.
    for (const [id, event] of statuses) {
      const before = prior.get(id), after = current.get(id);
      if (!before || before.kind !== 'task' || before.role !== 'entity' || before.constructionStage === 'rubble') continue;
      if (done(event.to) && (!after || stationaryMarker(after))) {
        const from = source(before);
        const to = { x: Math.max(model.bounds.maxX, previous.bounds.maxX)+before.radius+10, z: from.z };
        add('ship-out', before, [{ place: visual(before), from, to, target: null }], from, to);
      } else if (event.to === 'cancelled' && after?.role === 'entity' && after.constructionStage === 'rubble') {
        const from = source(before);
        add('collapse', before, [{ place: visual(before), from, to: point(after), target: after }], from, point(after));
      }
    }
    const moving = [...statuses.keys()].map(id => prior.get(id)).filter((p): p is MapPlace => !!p).sort((a,b) => a.depth-b.depth);
    for (const before of moving) {
      const after = current.get(before.entityId), event = statuses.get(before.entityId)!;
      if (claimed.has(before.entityId) || before.kind !== 'task' || before.role !== 'entity' || before.constructionStage === 'rubble' || !after || after.role !== 'entity' ||
          after.constructionStage === 'rubble' || done(event.to) || event.to === 'cancelled' || before.status === after.status || after.status !== event.to) continue;
      const ids = family(before, previous.places);
      const members = previous.places.filter(p => p.role === 'entity' && ids.has(p.entityId) && !claimed.has(p.entityId)).flatMap(p => {
        const target = current.get(p.entityId);
        return target?.role === 'entity' && target.constructionStage !== 'rubble'
          ? [{ place: target, from: source(p), to: point(target), target }] : [];
      });
      if (!members.some(m => moved(m.from, m.to))) continue;
      add('move', before, members, source(before), point(after));
    }
  }
  // A nested interruption replaces only its cargo. The rest of a moving family continues.
  const retained = live.flatMap(t => {
    const members = t.members.filter(m => !claimed.has(m.place.entityId) && validTransition({ ...t, members: [m] }, current));
    return members.length ? [{ ...t, members, suppressedPlaceIds: t.suppressedPlaceIds.filter(id => members.some(m => m.target?.id === id)) }] : [];
  });
  return { modelId:key,lastEffectId:effect.id,lastEffectSignature:signature,lastTaskSeq,effectRevision:revision,transitions:[...retained,...planned] };
}
export function suppressedTasklandPlaces(transitions: readonly TasklandTransition[]): ReadonlySet<string> {
  return new Set(transitions.flatMap(t => [...t.suppressedPlaceIds]));
}
/** Worker layer samples the same site route while retaining its own robot pose/identity. */
export function sampleTasklandPlace(transitions: readonly TasklandTransition[], entityId: string, now: number): Point | null {
  const transition = transitions.find(t => t.kind === 'move' && t.members.some(m => m.place.entityId === entityId));
  return transition ? sampleTasklandTransition(transition, now).members.find(m => m.entityId === entityId)?.position ?? null : null;
}

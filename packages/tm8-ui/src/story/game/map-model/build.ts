import { layoutForest, unionBounds } from './layout';
import { isCancelledTask, isDoneTask as done, taskConstructionProgress } from './progress';
import { isActiveMapEdge, isCompletedSession as completedSession, rubbleLifetime, shippingAncestors } from './lifecycle';
import { placeShippedEntities } from './shipping';
import type { BuildMapOptions, ConstructionStage, MapEntity, MapGroup, MapInput, MapModel, MapPlace, MapRobot, MapType } from './types';
export const MAP_LABELS: Record<MapType, string> = { hub: 'Hub', taskland: 'Taskland', office: 'Office', library: 'Library', factory: 'Code Factory', town: 'Completed Town' };
const TASK_GROUPS = ['to_do', 'in_progress', 'review', 'blocked'];
const OFFICE_GROUPS = ['staff', 'active', 'waiting', 'ended', 'academy'];
const LIBRARY = new Set(['doc', 'drawing', 'artifact', 'file']);
const FACTORY = new Set(['project', 'pull_request', 'commit', 'worktree']);
const OFFICE = new Set(['work_session', 'team_member', 'member', 'skill']);
const ended = new Set(['completed', 'stopped', 'failed', 'lost', 'exited']);
/** An open outcome is not a process state; terminal evidence cannot be masked by it. */
function sessionLifecycle(n: MapEntity): string | null {
  if (completedSession(n)) return 'completed';
  for (const state of [n.outcome, !n.outcome ? n.endedKind : null, n.processState, n.status]) if (state && ended.has(state)) return state;
  return n.processState ?? n.status ?? null;
}
function taskGroup(n: MapEntity): string {
  if (isCancelledTask(n)) return 'cancelled';
  if (done(n)) return 'shipped';
  if (n.status === 'blocked') return 'blocked';
  if (n.status === 'in_review') return 'review';
  if (n.status === 'working' || n.statusCategory === 'in_progress') return 'in_progress';
  return 'to_do';
}
function groupOf(n: MapEntity, type: MapType): string {
  if (type === 'taskland') return taskGroup(n);
  if (type !== 'office') return type === 'town' ? 'shipping-yard' : 'collection';
  if (n.kind === 'team_member' || n.kind === 'member') return 'staff';
  if (n.kind === 'skill') return 'academy';
  const status = sessionLifecycle(n);
  if (ended.has(status ?? '')) return 'ended';
  return status === 'running' || status === 'spawning' ? 'active' : 'waiting';
}
function stage(n: MapEntity, marker: boolean): ConstructionStage {
  if (marker) return 'shipped-marker';
  if (isCancelledTask(n)) return 'rubble';
  if (done(n) || completedSession(n)) return 'complete';
  const p = n.progress ?? 0;
  return p >= 1 ? 'topped-out' : p >= 0.67 ? 'walls' : p >= 0.34 ? 'scaffolding' : p > 0 ? 'foundation' : 'lot';
}
function assetOf(n: MapEntity, construction: ConstructionStage): string {
  if (construction === 'rubble' || construction === 'shipped-marker') return `task.${construction}`;
  if (n.kind === 'task') return `task.${construction}`;
  if (completedSession(n)) return 'town.session-monument';
  if (n.kind === 'work_session' && ended.has(sessionLifecycle(n) ?? '')) return 'office.plaque';
  return ({ work_session: 'office.desk', team_member: 'office.staff', member: 'office.staff', skill: 'office.academy', doc: 'library.book', drawing: 'library.drawing', artifact: 'library.artifact', file: 'library.file', project: 'factory.project', pull_request: 'factory.pull-request', commit: 'factory.commit', worktree: 'factory.worktree' } as Record<string, string>)[n.kind] ?? 'entity.generic';
}
function scopeEntities(input: MapInput, options: BuildMapOptions): MapEntity[] {
  if (input.scope?.kind === options.scope.kind && input.scope.id === options.scope.id) return [...input.entities];
  if (options.scope.kind === 'space') return input.entities.filter(n => !n.spaceId || n.spaceId === options.scope.id);
  return input.entities.filter(n => n.id === options.scope.id || n.storyIds?.includes(options.scope.id));
}

export function buildMapModel(input: MapInput, options: BuildMapOptions): MapModel {
  const { type } = options;
  // A pre-filtered story snapshot cannot become a whole-space projection by relabelling it.
  const scope = input.scope ?? options.scope;
  const warnings = [...(input.warnings ?? [])];
  if (input.scope && (input.scope.kind !== options.scope.kind || input.scope.id !== options.scope.id)) warnings.push(`Snapshot contains only ${input.scope.kind} ${input.scope.id}; requested ${options.scope.kind} ${options.scope.id} is unavailable`);
  const previous = options.previous?.type === type && options.previous.scope.kind === scope.kind && options.previous.scope.id === scope.id ? options.previous : undefined;
  const scoped = scopeEntities(input, { ...options, scope });
  const construction = taskConstructionProgress(scoped, input.taskHierarchyComplete);
  const all = scoped.map(n => n.kind === 'task' ? {
    ...n, parentId: construction.parentIds.get(n.id) ?? null,
    progress: construction.byId.get(n.id)!.progress, subtreeWeight: construction.byId.get(n.id)!.subtreeWeight,
  } : n);
  const byId = new Map(all.map(n => [n.id, n]));
  warnings.push(...construction.warnings);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Map clock must be a finite epoch timestamp');
  const previousPlaces = new Map(previous?.places.map(n => [n.id, n]) ?? []);
  const rubble = new Map(all.filter(isCancelledTask).map(n => [n.id, rubbleLifetime(n, now, previousPlaces.get(n.id))]));
  const retained = new Set(all.filter(n => n.kind === 'task' && !done(n) && !rubble.get(n.id)?.expired).map(n => n.id));
  const liveAncestors = shippingAncestors(all, retained);
  const deadlines = [...rubble.values()].filter(n => !n.expired && n.expiresAt !== null).map(n => n.expiresAt!);
  const nextLifecycleAt = type === 'taskland' && deadlines.length ? Math.min(...deadlines) : null;
  if (type === 'taskland') {
    const unknown = [...rubble.values()].filter(n => n.expiresAt === null).length;
    if (unknown) warnings.push(`${unknown} cancelled task(s) lack an authoritative cancellation timestamp; rubble expiry is unknown`);
  }
  const shipped = new Set(all.filter(n => done(n) || completedSession(n)).map(n => n.id));
  for (const edge of input.edges) if (edge.type === 'produces' && isActiveMapEdge(edge) &&
    byId.get(edge.fromId) && done(byId.get(edge.fromId)!) && LIBRARY.has(byId.get(edge.toId)?.kind ?? '')) shipped.add(edge.toId);
  const selected = all.filter(n => type === 'taskland' ? n.kind === 'task' && (retained.has(n.id) || liveAncestors.has(n.id))
    : type === 'office' ? OFFICE.has(n.kind) && !completedSession(n)
      : type === 'library' ? LIBRARY.has(n.kind)
        : type === 'factory' ? FACTORY.has(n.kind)
          : type === 'town' ? shipped.has(n.id) && !isCancelledTask(n) : false);
  const selectedIds = new Set(selected.map(n => n.id));
  const previousGroups = new Map(previous?.groups.map(n => [n.id, n.key]) ?? []);
  const layout = layoutForest(selected.map(n => {
    let group = groupOf(n, type);
    const old = previousPlaces.get(n.id);
    if (type === 'taskland' && (isCancelledTask(n) || done(n))) {
      const terminalGroup = n.terminalFromStatus && !['done', 'cancelled'].includes(n.terminalFromStatus)
        ? taskGroup({ ...n, status: n.terminalFromStatus, statusCategory: null }) : 'to_do';
      group = old ? previousGroups.get(old.groupId) ?? terminalGroup : terminalGroup;
    }
    return { id: n.id, parentId: type !== 'town' && n.parentId && selectedIds.has(n.parentId) && byId.get(n.parentId)?.kind === n.kind ? n.parentId : null,
      radius: 1.8 + Math.sqrt(n.kind === 'task' ? construction.byId.get(n.id)!.sizeBucket : Math.min(13, Math.max(1, n.subtreeWeight ?? n.pointsEstimate ?? 1))) * 0.4,
      group, title: n.title, order: n.createdAt ?? '' };
  }), { previous: previous?.layout, groups: type === 'taskland' ? TASK_GROUPS : type === 'office' ? OFFICE_GROUPS : undefined });
  const places: MapPlace[] = layout.nodes.map(n => {
    const entity = byId.get(n.id)!, marker = type === 'taskland' && done(entity), constructionStage = stage(entity, marker);
    const isRoot = !n.parentId;
    return {
      id: n.id, entityId: n.id, kind: entity.kind, title: entity.title, parentId: n.parentId, depth: n.depth,
      x: n.x, z: n.z, radius: n.radius, footprint: n.footprint, compoundBounds: n.compoundBounds, groupId: `group:${n.parentId ?? '@roots'}:${n.group}`,
      status: entity.status ?? null, progress: entity.progress ?? null, constructionStage, workStatus: entity.status ?? null, processState: entity.processState ?? null, outcome: entity.outcome ?? null, endedKind: entity.endedKind ?? null,
      ...(entity.kind === 'task' ? {
        subtreeWeight: entity.subtreeWeight, sizeBucket: construction.byId.get(n.id)!.sizeBucket,
        estimateMissing: construction.byId.get(n.id)!.estimateMissing,
        cancelledAt: rubble.get(n.id)?.cancelledAt ?? null, rubbleExpiresAt: rubble.get(n.id)?.expiresAt ?? null,
      } : {}),
      role: marker ? 'shipped-marker' : 'entity', assetKey: assetOf(entity, constructionStage), label: entity.title,
      badges: [...(entity.kind === 'task' && construction.byId.get(n.id)!.estimateMissing ? ['estimate-missing'] : []), ...(marker ? ['shipped', 'children-open'] : []), ...(isCancelledTask(entity) && !rubble.get(n.id)?.expiresAt ? ['cancellation-time-unknown'] : [])],
      mailbox: isRoot ? entity.mailbox ?? null : null, attention: entity.pendingAttention ?? 0,
    };
  });
  const placesById = new Map(places.map(n => [n.id, n]));
  let placedTownIds: ReadonlySet<string> = new Set();
  if (type === 'town' && input.townPlacements?.length) {
    const shipping = placeShippedEntities(places, input.townPlacements);
    warnings.push(...shipping.warnings);
    placedTownIds = new Set(shipping.fixed.keys());
    for (const p of places) {
      const slot = layout.cache.containers['@roots']?.slots[p.id];
      if (slot) { slot.x = p.x; slot.z = p.z; slot.group = shipping.fixed.has(p.id) ? 'town' : 'shipping-yard'; }
    }
  }
  // Taskland roots include shipped children in their admitted same-kind subtree.
  const mailSources = type === 'taskland' ? all.filter(n => n.kind === 'task') : selected;
  const mail = new Map(mailSources.map(n => [n.id, { count: n.mailbox?.count ?? 0, approx: n.mailbox?.approx ?? false,
    known: n.mailbox !== undefined, basis: n.mailbox?.basis ?? 'messages', attention: n.pendingAttention ?? 0 }]));
  const mailOrder = type === 'taskland' ? [...construction.byId.keys()].map(id => byId.get(id)!) : [...places].sort((a, b) => b.depth - a.depth);
  if (type !== 'town') for (const n of mailOrder) {
    if (!n.parentId || !mail.has(n.parentId)) continue;
    const own = mail.get(n.id)!, parent = mail.get(n.parentId)!;
    if (parent.known && own.known && own.basis !== parent.basis) { parent.basis = 'messages'; parent.approx = true; }
    else if (!parent.known) parent.basis = own.basis;
    parent.count += own.count;
    parent.approx ||= own.approx || !own.known; parent.known ||= own.known; parent.attention += own.attention;
  }
  for (const p of places) {
    const tally = mail.get(p.id)!;
    p.mailbox = p.parentId || !tally.known ? null : { count: tally.count, approx: tally.approx, basis: tally.basis };
    if (!p.parentId) p.attention = tally.attention;
  }
  for (const p of places) {
    const enrichment = options.adapters?.[p.kind]?.(byId.get(p.id)!, { type, isRoot: !p.parentId });
    if (enrichment) {
      if (enrichment.assetKey !== undefined) p.assetKey = enrichment.assetKey;
      if (enrichment.label !== undefined) p.label = enrichment.label;
      if (enrichment.badges !== undefined) p.badges = [...new Set([...p.badges, ...enrichment.badges])];
      if (enrichment.attention !== undefined) p.attention += enrichment.attention - (byId.get(p.id)?.pendingAttention ?? 0);
      if (!p.parentId && enrichment.mailbox !== undefined) {
        const own = byId.get(p.id)?.mailbox;
        const descendants = (p.mailbox?.count ?? 0) - (own?.count ?? 0);
        p.mailbox = enrichment.mailbox === null ? p.mailbox : {
          ...enrichment.mailbox, count: enrichment.mailbox.count + descendants,
          approx: p.mailbox?.approx || enrichment.mailbox.approx,
          basis: p.mailbox?.basis === 'messages' || enrichment.mailbox.basis !== 'unread' ? 'messages' : 'unread',
        };
      }
    }
  }
  const grouped = new Map<string, MapPlace[]>();
  for (const p of places) { const group = grouped.get(p.groupId) ?? []; group.push(p); grouped.set(p.groupId, group); }
  const layoutById = new Map(layout.nodes.map(n => [n.id, n]));
  const groups: MapGroup[] = [...grouped.entries()].map(([id, members]) => {
    const first = members[0]!, key = type === 'town' && id === 'group:@roots:town' ? 'town' : layoutById.get(first.id)!.group;
    const labels: Record<string, string> = { to_do: 'To do', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', cancelled: 'Cancelled rubble', shipped: 'Shipped foundations', 'shipping-yard': 'Shipping Yard', town: 'Town', collection: MAP_LABELS[type], staff: 'Staff', active: 'Active sessions', waiting: 'Waiting / idle sessions', ended: 'Ended sessions', academy: 'Academy' };
    return { id, key, label: `${labels[key] ?? key}${type === 'office' ? ' (proposed)' : ''}`, parentId: first.parentId, depth: first.depth, bounds: unionBounds(members.map(p => p.compoundBounds)), placeIds: members.map(p => p.id), proposed: type === 'office' };
  });
  const robots: MapRobot[] = [];
  const claims = new Set<string>();
  const robotCounts = new Map<string, number>();
  for (const edge of input.edges) {
    if (edge.type !== 'working_on' || !isActiveMapEdge(edge) ||
      (edge.status != null && !['working', 'waiting', 'blocked'].includes(edge.status)) || claims.has(edge.id)) continue;
    const session = byId.get(edge.fromId), task = byId.get(edge.toId), place = placesById.get(edge.toId);
    if (!session || session.kind !== 'work_session' || session.live === false || ended.has(sessionLifecycle(session) ?? '') ||
      ((session.processState ?? session.status) != null && !['spawning', 'running', 'idle', 'waiting'].includes(session.processState ?? session.status!)) ||
      !task || task.kind !== 'task' || done(task) || isCancelledTask(task) || !place) continue;
    claims.add(edge.id);
    const count = robotCounts.get(task.id) ?? 0;
    robotCounts.set(task.id, count + 1);
    const angle = count * 2.399963;
    robots.push({ id: `robot:${edge.id}`, claimId: edge.id, sessionId: session.id, taskId: task.id, label: session.title, assetKey: 'worker.robot',
      x: place.x + Math.cos(angle) * (place.radius + 0.6), z: place.z + Math.sin(angle) * (place.radius + 0.6),
      pose: session.pendingAttention ? 'attention' : edge.status === 'blocked' || task.status === 'blocked' ? 'blocked' : edge.status === 'waiting' || session.processState === 'waiting' ? 'waiting' : session.processState === 'idle' || session.status === 'idle' ? 'idle' : 'working' });
  }
  const roads = input.edges.filter(e => e.type === 'depends_on' && isActiveMapEdge(e) && placesById.has(e.fromId) && placesById.has(e.toId)).map(e => {
    const from = placesById.get(e.fromId)!, to = placesById.get(e.toId)!;
    return { id: `road:${e.id}`, edgeId: e.id, type: 'depends_on' as const, fromId: e.fromId, toId: e.toId, points: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }] };
  });
  const portals: MapModel['portals'] = [], decor: MapModel['decor'] = [];
  if (type === 'hub') {
    const destinations: MapType[] = ['taskland', 'office', 'library', 'factory', 'town'];
    destinations.forEach((destination, i) => {
      const angle = i * Math.PI / 3, x = Math.cos(angle) * 18, z = Math.sin(angle) * 18;
      portals.push({ id: `portal:${scope.kind}:${scope.id}:${destination}`, label: MAP_LABELS[destination], target: { type: destination, scope }, x, z, radius: 3, assetKey: `portal.${destination}` });
      decor.push({ id: `decor:${scope.id}:${destination}`, role: 'decor', label: MAP_LABELS[destination], assetKey: `landmark.${destination}`, x, z, radius: 3 });
    });
    all.filter(n => n.kind === 'story' && n.id !== scope.id && (scope.kind === 'story' ? n.parentId === scope.id : !n.parentId || !byId.has(n.parentId))).sort((a, b) => a.id.localeCompare(b.id)).forEach((n, i) => {
      portals.push({ id: `portal:story:${n.id}`, entityId: n.id, label: n.title, target: { type: 'hub', scope: { kind: 'story', id: n.id } }, x: (i - 1) * 9, z: -27, radius: 3, assetKey: 'portal.story' });
    });
  }
  const shippingYard = type === 'town' ? { position: { x: 0, z: -12 }, waitingIds: places.filter(p => !placedTownIds.has(p.id)).map(p => p.id) } : undefined;
  const bounds = unionBounds([...places.filter(p => !p.parentId).map(p => p.compoundBounds),
    ...(shippingYard ? [{ minX: shippingYard.position.x - 4, maxX: shippingYard.position.x + 4, minZ: shippingYard.position.z - 4, maxZ: shippingYard.position.z + 4 }] : []),
    ...portals.map(p => ({ minX: p.x - p.radius, maxX: p.x + p.radius, minZ: p.z - p.radius, maxZ: p.z + p.radius }))]);
  return { id: `map:${scope.kind}:${scope.id}:${type}`, type, scope, places, groups, roads,
    paths: type === 'hub' ? portals.map(p => ({ id: `path:${p.id}`, role: 'decorative-path', points: [{ x: 0, z: 0 }, { x: p.x, z: p.z }] })) : [],
    robots, decor, portals, bounds, layout: layout.cache, nextLifecycleAt, shippingYard, warnings: [...warnings, ...layout.warnings] };
}

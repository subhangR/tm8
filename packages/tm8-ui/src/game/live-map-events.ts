import type { DurableWorkspaceEvent, EntitySummary, StatusCategory, WorkStatus } from '@tm8/contract';
import { fromProjection } from '../story/game/map-model';
import type { MapEntity, MapInput, MapScope, MapType } from '../story/game/map-model';
import type { GameMapEvents } from './types';
import { admitsMapKind } from './map-admission';

type Versioned = { version?: number };
// Mirrors the ruled mapping in domain/registry.ts TASK_STATE_CONTROL and the server.
const workCategories: Record<WorkStatus, StatusCategory> = { open: 'to_do', pulled: 'to_do', working: 'in_progress',
  in_review: 'in_progress', blocked: 'in_progress', done: 'done', cancelled: 'cancelled' };
function older(candidate: Versioned, current?: Versioned): boolean {
  if (!current) return false;
  return candidate.version !== undefined && current.version !== undefined && candidate.version < current.version;
}
export function sessionLiveness(row: MapEntity, events?: GameMapEvents): MapEntity {
  if (!events || row.kind !== 'work_session') return row;
  const status = row.processState ?? row.status;
  const recorded = status === 'spawning' || status === 'running' || status === 'idle' || status === 'failed' || status === 'exited' ? status : null;
  const state = events.liveness.statusOf({ id: row.id, status: recorded });
  return { ...row, live: state === 'unknown' ? undefined : state === 'live' };
}

export type GameTaskEvent = Extract<DurableWorkspaceEvent, { type: 'task.criterion_changed' | 'task.status_changed' }>;
export type GameMapEvent = DurableWorkspaceEvent;

export function liveMapEntity(row: EntitySummary, events?: GameMapEvents): MapEntity {
  const mapped = fromProjection({ entities: [row], edges: [] }).entities[0]!;
  const session = row.state.kind === 'work_session' ? row.state : null;
  const liveness = session && events ? events.liveness.statusOf({ id: row.id, status: session.status }) : null;
  const metadata = { version: row.version, updatedAt: row.updatedAt };
  return { ...mapped, ...metadata, statusCategory: row.category ?? null,
    pendingAttention: row.badges.attention?.pendingCount ?? 0,
    mailbox: { count: row.counters.messages },
    ...(session ? { processState: session.status, outcome: session.outcome ?? null,
      live: liveness === 'unknown' ? undefined : liveness ? liveness === 'live' : mapped.live } : {}),
  };
}

export interface MapEventResult { input: MapInput; changed: boolean; refresh: boolean; staleEndpoints?: boolean; touched: string[]; completed: string[] }
/** Full event payloads are authoritative. Story membership is only inferred for contained children and claims. */
export function applyMapEvent(input: MapInput, scope: MapScope, event: GameMapEvent, events?: GameMapEvents, type: MapType = 'town', canAdd = true): MapEventResult {
  const entities = new Map(input.entities.map(row => [row.id, row]));
  const edges = new Map(input.edges.map(row => [row.id, row]));
  const result: MapEventResult = { input, changed: false, refresh: false, touched: [], completed: [] };
  const put = (row: MapEntity) => { entities.set(row.id, row); result.changed = true; result.touched.push(row.id); };
  const remove = (id: string) => {
    if (!entities.delete(id)) return;
    for (const [key, edge] of edges) if (edge.fromId === id || edge.toId === id) edges.delete(key);
    result.changed = true; result.touched.push(id);
  };
  switch (event.type) {
    case 'task.criterion_changed': {
      const row = entities.get(event.taskId);
      // Criteria counts are kept distinct from an authoritative weighted subtree fraction.
      if (row?.kind === 'task') put({ ...row, acceptance: { total: event.total, completed: event.done } });
      break;
    }
    case 'task.status_changed': {
      const row = entities.get(event.taskId);
      if (row?.kind === 'task') {
        const category = workCategories[event.to as WorkStatus];
        if (!category) result.refresh = true;
        put({ ...row, status: event.to, statusCategory: category ?? null,
          terminalFromStatus: ['done', 'cancelled'].includes(event.to) ? row.terminalFromStatus ?? event.from : null,
          cancelledAt: event.to === 'cancelled' ? (row.status === 'cancelled' && row.cancelledAt ? row.cancelledAt : event.occurredAt) : null });
      }
      break;
    }
    case 'entity.upsert':
    case 'entity.deleted': {
      const row = event.entity;
      if (row.spaceId !== event.spaceId) break;
      if (scope.kind === 'story' && row.id === scope.id) result.refresh = true;
      const known = entities.get(row.id);
      if (older(row, known as Versioned | undefined)) break;
      const parent = row.parentId ? entities.get(row.parentId) : null;
      const admitted = scope.kind === 'space' || !!known || parent?.kind === row.kind;
      if (!admitted || !admitsMapKind(type, row.kind)) break;
      if (!known && !canAdd) { result.refresh = true; break; }
      if (event.type === 'entity.deleted') remove(row.id);
      else {
        let mapped = liveMapEntity(row, events);
        if (mapped.kind === 'task' && mapped.status === known?.status) mapped = { ...mapped,
          terminalFromStatus: known?.terminalFromStatus ?? mapped.terminalFromStatus,
          cancelledAt: mapped.status === 'cancelled' ? mapped.cancelledAt ?? known?.cancelledAt : null };
        if (mapped.kind === 'work_session' && mapped.outcome === 'completed' && known?.outcome !== 'completed') result.completed.push(row.id);
        put(mapped);
        if (scope.kind === 'story' && known && known.parentId !== mapped.parentId) result.refresh = true;
      }
      break;
    }
    case 'edge.upsert':
    case 'edge.deleted': {
      const edge = event.edge, source = edge.source, target = edge.target;
      if (source.spaceId !== event.spaceId || target.spaceId !== event.spaceId) break;
      const known = edges.has(edge.id);
      const touches = scope.kind === 'space' || known || entities.has(source.id) || entities.has(target.id) || source.id === scope.id || target.id === scope.id;
      if (!touches) break;
      if (!admitsMapKind(type, source.kind) || !admitsMapKind(type, target.kind)) break;
      result.staleEndpoints = older(source, entities.get(source.id)) || older(target, entities.get(target.id));
      if (event.type === 'edge.upsert' && ((!known && edges.size >= 1_000) || (!canAdd && (!entities.has(source.id) || !entities.has(target.id))))) { result.refresh = true; break; }
      if (event.type === 'edge.deleted') {
        result.changed = edges.delete(edge.id);
        if (edge.type === 'working_on' && (edge.props.endReason === 'session_completed' || (source.state.kind === 'work_session' && source.state.outcome === 'completed'))) result.completed.push(source.id);
      }
      else if (edge.type === 'working_on' && source.kind === 'work_session' && entities.get(target.id)?.kind === 'task') {
        if (!older(source, entities.get(source.id) as Versioned | undefined)) put(liveMapEntity(source, events));
        if (!older(target, entities.get(target.id) as Versioned | undefined)) put(liveMapEntity(target, events));
        const metadata = { updatedAt: edge.updatedAt };
        edges.set(edge.id, { id: edge.id, type: edge.type, fromId: source.id, toId: target.id,
          ...metadata,
          endedAt: typeof edge.props.endedAt === 'string' ? edge.props.endedAt : null,
          status: typeof edge.props.status === 'string' ? edge.props.status : null });
        result.changed = true;
      } else if (entities.has(source.id) && entities.has(target.id)) {
        const metadata = { updatedAt: edge.updatedAt };
        edges.set(edge.id, { id: edge.id, type: edge.type, fromId: source.id, toId: target.id,
          ...metadata,
          endedAt: typeof edge.props.endedAt === 'string' ? edge.props.endedAt : null,
          status: typeof edge.props.status === 'string' ? edge.props.status : null }); result.changed = true;
      } else result.refresh = true;
      if (scope.kind === 'story' && !['working_on', 'depends_on'].includes(edge.type)) result.refresh = true;
      result.touched.push(source.id, target.id);
      break;
    }
    case 'edge.ended': {
      const edge = edges.get(event.edgeId);
      if (edge) {
        edges.set(edge.id, { ...edge, endedAt: event.endedAt }); result.changed = true;
        result.touched.push(event.sourceId, event.targetId);
        if (event.endReason === 'session_completed') result.completed.push(event.sourceId);
      }
      break;
    }
    case 'session.outcome_changed': {
      const row = entities.get(event.sessionId);
      if (row) { put({ ...row, outcome: event.to }); if (event.to === 'completed') result.completed.push(row.id); }
      break;
    }
    case 'session.process_changed': {
      const row = entities.get(event.sessionId);
      const state = events?.liveness.statusOf({ id: event.sessionId, status: event.to });
      if (row) put({ ...row, processState: event.to, status: event.to,
        live: state === 'unknown' ? undefined : state ? state === 'live' : row.live });
      break;
    }
    case 'counter.changed': {
      const row = entities.get(event.entityId);
      if (row && row.mailbox?.basis !== 'unread') put({ ...row, mailbox: { count: event.counters.messages, basis: 'messages' } });
      break;
    }
    default: break;
  }
  if (result.changed) result.input = { ...input, entities: [...entities.values()], edges: [...edges.values()] };
  return result;
}

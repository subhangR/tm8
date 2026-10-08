import type { StoryView } from '../../model';
import type { MapEdge, MapEntity, MapInput, MapScope } from './types';
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => typeof v === 'boolean' ? v : undefined;
function progressOf(n: Record<string, unknown>): number | null {
  const weighted = record(n.weighted ?? n.taskProgress ?? n.progress);
  const percent = num(weighted.percent);
  if (percent !== undefined) return Math.max(0, Math.min(1, percent / 100));
  const progress = num(n.progress);
  return progress === undefined ? null : Math.max(0, Math.min(1, progress));
}
function entityOf(value: unknown): MapEntity | null {
  const raw = record(value), n = { ...record(raw.content), ...record(raw.props), ...record(raw.state), ...raw };
  const id = str(n.id), kind = str(n.kind);
  if (!id || !kind) return null;
  const weighted = record(n.weighted ?? n.taskProgress ?? n.progress), counts = record(n.counts), mailbox = record(n.mailbox);
  const count = num(mailbox.count) ?? num(counts.messages);
  return {
    id, kind, title: str(n.title) ?? str(n.name) ?? id,
    parentId: str(n.parentId) ?? str(n.parent_id) ?? null,
    status: str(n.status) ?? str(record(n.status).key) ?? null,
    statusCategory: str(n.statusCategory) ?? null, createdAt: str(n.createdAt) ?? null,
    progress: progressOf(n), pointsEstimate: num(n.pointsEstimate) ?? null,
    subtreeWeight: num(n.subtreeWeight) ?? num(weighted.size) ?? null,
    pendingAttention: num(n.pendingAttention) ?? num(counts.pendingAttention) ?? 0,
    mailbox: count === undefined ? undefined : { count, approx: bool(mailbox.approx) ?? false },
    processState: str(n.processState) ?? str(n.runtimeStatus) ?? null,
    outcome: str(n.outcome) ?? null, endedKind: str(n.endedKind) ?? null, live: bool(n.live),
    storyIds: rows(n.storyIds).filter((v): v is string => typeof v === 'string'), spaceId: str(n.spaceId),
  };
}
function edgeOf(value: unknown): MapEdge | null {
  const raw = record(value), n = { ...record(raw.props), ...raw };
  const type = str(n.type), fromId = str(n.fromId), toId = str(n.toId);
  if (!type || !fromId || !toId) return null;
  return { id: str(n.id) ?? `${type}:${fromId}:${toId}`, type, fromId, toId, endedAt: str(n.endedAt) ?? null, status: str(n.status) ?? null };
}

/** Accepts MapInput, a graph projection {nodes,edges}, or {id,kind:'story',page:StoryPage}. */
export function fromProjection(snapshot: unknown, scope?: MapScope): MapInput {
  const root = record(snapshot), page = record(root.page);
  const source = root.page ? page : root;
  if (!Array.isArray(source.entities) && !Array.isArray(source.nodes)) throw new Error('Map snapshot requires entities or nodes');
  const entities = new Map<string, MapEntity>();
  for (const value of rows(source.entities ?? source.nodes)) { const n = entityOf(value); if (n) entities.set(n.id, n); }
  const edges = rows(source.edges).map(edgeOf).filter((e): e is MapEdge => e !== null);
  // StoryPage's hierarchy edges are parent -> child, unlike parentId's child -> parent field.
  for (const edge of edges) if (edge.type === 'parent' && !edge.endedAt) {
    const child = entities.get(edge.toId), parent = entities.get(edge.fromId);
    if (child && parent && child.kind === parent.kind) child.parentId = parent.id;
  }
  for (const value of rows(source.roots)) {
    const raw = record(value), n = entityOf(value); if (!n) continue;
    const existing = entities.get(n.id);
    entities.set(n.id, existing ? { ...existing, progress: raw.weighted !== undefined || typeof raw.progress === 'number' ? progressOf(raw) : existing.progress, subtreeWeight: n.subtreeWeight ?? existing.subtreeWeight } : n);
  }
  for (const value of rows(source.sessions)) {
    const raw = record(value), n = entityOf({ ...raw, kind: 'work_session', status: raw.runtimeStatus, parentId: raw.dispatchedById });
    if (n) {
      const existing = entities.get(n.id);
      entities.set(n.id, { ...existing, ...n, outcome: n.outcome ?? existing?.outcome, endedKind: n.endedKind ?? existing?.endedKind, parentId: n.parentId ?? existing?.parentId });
    }
  }
  for (const value of rows(source.team)) {
    const raw = record(value), n = entityOf({ ...raw, kind: raw.kind ?? 'team_member', title: raw.name });
    if (n) entities.set(n.id, { ...entities.get(n.id), ...n });
  }
  for (const value of rows(source.childStories)) {
    const n = entityOf({ ...record(value), kind: 'story', parentId: root.id }); if (n) entities.set(n.id, { ...entities.get(n.id), ...n });
  }
  const rawScope = record(root.scope);
  const inferred = (rawScope.kind === 'space' || rawScope.kind === 'story') && str(rawScope.id)
    ? { kind: rawScope.kind, id: rawScope.id as string } as MapScope
    : root.kind === 'story' && str(root.id) ? { kind: 'story' as const, id: root.id as string } : undefined;
  const follow = record(source.follow);
  if (num(follow.depth) !== undefined) for (const entity of entities.values()) if (entity.mailbox) entity.mailbox = { ...entity.mailbox, approx: true };
  const warnings = rows(root.warnings).filter((v): v is string => typeof v === 'string');
  if (num(follow.depth) !== undefined) warnings.push(`Snapshot follows at most depth ${follow.depth}; deeper descendants may be absent`);
  if (follow.truncated === true) warnings.push('Snapshot was truncated; counts and map contents are incomplete');
  if (scope && inferred && (scope.kind !== inferred.kind || scope.id !== inferred.id)) warnings.push(`Snapshot contains only ${inferred.kind} ${inferred.id}; requested scope ${scope.kind} ${scope.id} is not a complete projection`);
  return { entities: [...entities.values()], edges, scope: inferred ?? scope, warnings };
}

export function fromStoryView(view: StoryView): MapInput {
  return fromProjection({ id: view.id, kind: 'story', page: view.page }, { kind: 'story', id: view.id });
}

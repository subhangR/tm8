/**
 * The workspace's task data — one query, one poll, one tree.
 *
 * WHY ONE QUERY RATHER THAN ONE PER EXPANDED NODE. The obvious shape for a task
 * tree is "query children when a row expands": `collections.query` supports
 * `parentId`, so each caret would be its own request. Written that way, an
 * expanded tree is N polls at 4s forever — and every one of them re-asks a
 * question the space-wide query already answered, because a task's `parentId`
 * comes back on the summary. So this reads the space's tasks ONCE and assembles
 * the hierarchy client-side. Expansion becomes free, cannot storm the node, and
 * the panel can never show a parent and a child that disagree about status.
 *
 * The cost is a cap: `limit` rows. That is stated in the UI (see `truncated`)
 * rather than silently swallowed — a tree that quietly stops at 200 is the same
 * class of lie as a fabricated row.
 *
 * WHY THE STATUS FILTER STILL GOES TO THE SERVER. `filters.workStatus` is
 * executed server-side (verified by live call), so filtering there is both
 * cheaper and the documented path. It does mean a filtered result can contain a
 * child whose parent was filtered out — `buildTaskTree` promotes those orphans
 * to the root instead of dropping them, so a filter never makes a matching task
 * invisible.
 *
 * Polling rather than push is the node's actual story: `RealFacade.subscribe`
 * is an `EventPoller` and says so. This hook rides `usePolledCollection` so the
 * task query shares one interval and one snapshot with any other consumer of the
 * same question.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  ActorSummary, CollectionQuery, EntityId, EntitySummary, WorkStatus,
} from '../../collab-v2/types/contract';
import type { RealFacade } from '../RealFacade';
import { usePolledCollection } from './usePolledCollection';

/** Matches the sessions list cadence — tasks change no faster than agents do. */
export const TASK_POLL_MS = 4000;

/** The page the panel reads. Truncation past this is reported, never hidden. */
export const TASK_LIMIT = 200;

/**
 * The sorts this panel offers, and the reason `position` is absent.
 *
 * `sort:'position'` reads perfectly well server-side — but position can only be
 * WRITTEN through `entities.move`, which is 501 on this node. Offering an order
 * the user cannot influence, beside a drag handle that cannot move anything,
 * reads as a broken feature rather than an absent one. So the panel sorts by
 * things that are real today and says why drag is off (blueprint §11 ruling 2).
 */
export const TASK_SORTS = [
  { id: 'priority', label: 'Priority' },
  { id: 'dueDate', label: 'Due date' },
  { id: 'activityAt_desc', label: 'Activity' },
] as const;

export type TaskSort = typeof TASK_SORTS[number]['id'];

export const WORK_STATUSES: readonly WorkStatus[] = [
  'open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled',
];

/** The `task` arm of `EntityState`, narrowed without a cast at every call site. */
export interface TaskState {
  workStatus: WorkStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  axes: Record<string, string>;
  dueDate?: string | null;
  assignees: ActorSummary[];
  acceptance: { total: number; completed: number };
}

const EMPTY_STATE: TaskState = {
  workStatus: 'open', priority: 'medium', axes: {}, dueDate: null,
  assignees: [], acceptance: { total: 0, completed: 0 },
};

/**
 * A task's state, defaulted field-by-field rather than trusted.
 *
 * The server always sends the full arm today, but this panel renders a status
 * pill and a priority dot off it — and a `undefined` reaching either one is a
 * blank chip that looks like a real answer. Defaulting to `open`/`medium` is
 * only ever visible if the server changed shape, which is loud in the UI rather
 * than a crash.
 */
export function taskState(task: EntitySummary): TaskState {
  const raw = (task.state ?? {}) as Partial<TaskState>;
  return {
    workStatus: raw.workStatus ?? EMPTY_STATE.workStatus,
    priority: raw.priority ?? EMPTY_STATE.priority,
    axes: raw.axes ?? {},
    dueDate: raw.dueDate ?? null,
    assignees: raw.assignees ?? [],
    acceptance: raw.acceptance ?? { total: 0, completed: 0 },
  };
}

/** A task is finished when the graph says so — not when the UI feels it is. */
export function isFinished(task: EntitySummary): boolean {
  const s = taskState(task).workStatus;
  return s === 'done' || s === 'cancelled';
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/**
 * Built by a factory, not inline at the call site: `usePolledCollection` keys
 * its subscription on the SERIALIZED query, so two callers that build "the same"
 * query with keys in a different order silently open two polls. One factory
 * makes the sharing structural. (Same reasoning as `./queries.ts`, which owns
 * the Lane B queries; this one is here so Lane A does not edit that file.)
 */
export function tasksQuery(
  spaceId: string,
  sort: TaskSort,
  statuses: readonly WorkStatus[],
  assigneeIds: readonly EntityId[] = [],
): CollectionQuery {
  const query: CollectionQuery = { spaceId, kinds: ['task'], sort, limit: TASK_LIMIT };
  // `collections.query` is `.strict()` server-side — an empty `filters` object
  // is accepted but pointless, and a `workStatus: []` would filter everything
  // out rather than nothing. Omit the key entirely when nothing is selected.
  const filters: NonNullable<CollectionQuery['filters']> = {};
  if (statuses.length > 0) filters.workStatus = [...statuses];
  // `assigneeIds` is an `assigned_to` EDGE server-side, not a column, and the
  // SQL is `dst_id = any(...)` — OR across the selection, which is the semantics
  // this filter needs. Doing it here rather than over the fetched page also
  // keeps the hierarchy honest: a task whose PARENT does not match is promoted
  // to a root by `buildTaskTree`, so it is still reachable. A client-side
  // predicate cannot do that — a match inside a collapsed parent is simply not
  // in the flattened list, and the panel would report zero while holding the row.
  if (assigneeIds.length > 0) filters.assigneeIds = [...assigneeIds];
  if (Object.keys(filters).length > 0) query.filters = filters;
  return query;
}

/**
 * The space's people, for the assignee filter's menu.
 *
 * `member` and `team_member` are ordinary rows in `public.entities`
 * (`db/migrations/007_rpc_catalog.sql:459`) and `collections.query` applies
 * `kinds` with no allowlist, so this is a real roster read today — the same
 * shape `queries.ts` documents and `agentsQuery` already ships. Both kinds,
 * because an agent is assignable exactly like a person and a menu that omitted
 * them would hide real work.
 *
 * Deliberately NOT derived from the loaded tasks: options read off the page can
 * only ever offer people who already appear on it, and pairing that with a
 * server-side filter is circular — narrowing to one person removes everyone
 * else from the menu you picked them in.
 */
export const ACTOR_KINDS = ['member', 'team_member'] as unknown as EntitySummary['kind'][];

/** People change far more slowly than tasks; polling them at task cadence is waste. */
export const ACTOR_POLL_MS = 30_000;

export function spaceActorsQuery(spaceId: string): CollectionQuery {
  return { spaceId, kinds: ACTOR_KINDS, limit: 200, sort: 'activityAt_desc' };
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface TaskNode {
  task: EntitySummary;
  children: TaskNode[];
}

/**
 * Assemble the hierarchy from a flat page, preserving the SERVER's order.
 *
 * Sibling order is inherited from the response rather than re-sorted here, so
 * "sort by priority" means the server's priority ordering at every depth and the
 * client never invents a second opinion about it.
 *
 * ORPHAN PROMOTION is the load-bearing part. A row whose `parentId` is not in
 * this page — because the parent failed the status filter, or fell past the
 * limit, or is a non-task — would otherwise be attached to nothing and never
 * rendered. It is promoted to the root instead: a task that matched the query
 * always appears somewhere.
 */
export function buildTaskTree(items: readonly EntitySummary[]): TaskNode[] {
  const nodes = new Map<EntityId, TaskNode>();
  for (const task of items) nodes.set(task.id, { task, children: [] });

  const roots: TaskNode[] = [];
  for (const task of items) {
    const node = nodes.get(task.id) as TaskNode;
    const parent = task.parentId ? nodes.get(task.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface TaskRow {
  task: EntitySummary;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Depth-first flatten to the rows actually rendered. Collapsed subtrees are
 * skipped entirely — the panel renders a list, so a hidden child must not cost
 * a DOM node.
 */
export function flattenTree(
  roots: readonly TaskNode[],
  expanded: ReadonlySet<EntityId>,
  depth = 0,
): TaskRow[] {
  const out: TaskRow[] = [];
  for (const node of roots) {
    const hasChildren = node.children.length > 0;
    const isOpen = hasChildren && expanded.has(node.task.id);
    out.push({ task: node.task, depth, hasChildren, expanded: isOpen });
    if (isOpen) out.push(...flattenTree(node.children, expanded, depth + 1));
  }
  return out;
}

/** Every descendant id of a task, for expand-all and for cascade collapse. */
export function descendantIds(node: TaskNode): EntityId[] {
  return node.children.flatMap((c) => [c.task.id, ...descendantIds(c)]);
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export interface UseTasksResult {
  /** Null until the first read lands — distinct from "the space has no tasks". */
  rows: EntitySummary[] | null;
  tree: TaskNode[] | null;
  error: string | null;
  /** True when the page filled to `TASK_LIMIT`, so rows may be missing. */
  truncated: boolean;
  reload: () => void;
}

export function useTasks(
  facade: RealFacade,
  spaceId: string,
  sort: TaskSort,
  statuses: readonly WorkStatus[],
  assigneeIds: readonly EntityId[] = [],
): UseTasksResult {
  const { items, error, reload } = usePolledCollection(
    facade, tasksQuery(spaceId, sort, statuses, assigneeIds), TASK_POLL_MS,
  );
  return {
    rows: items,
    tree: items ? buildTaskTree(items) : null,
    error,
    truncated: (items?.length ?? 0) >= TASK_LIMIT,
    reload,
  };
}

/**
 * The viewer's member id — required, not optional, for two commands.
 *
 * `completeTask` refuses without at least one `completerId` (the facade fails
 * early rather than letting the server 400), and every write carries `actorId`.
 * `spaces.navigation` is the only read on this node that names the caller, so it
 * is fetched once per space and shared: a promise cache rather than a value
 * cache, so N components mounting together make ONE request rather than N.
 */
const viewerCache = new Map<string, Promise<EntityId | null>>();

export function loadViewerId(facade: RealFacade, spaceId: string): Promise<EntityId | null> {
  let pending = viewerCache.get(spaceId);
  if (!pending) {
    pending = facade.getNavigation(spaceId).then(
      (nav) => nav.viewer?.id ?? null,
      // A failure here must not break the panel: it disables the two commands
      // that need an actor and leaves everything else working. Not cached as a
      // rejection, so a transient failure is retried on the next mount.
      () => { viewerCache.delete(spaceId); return null; },
    );
    viewerCache.set(spaceId, pending);
  }
  return pending;
}

export function useViewerId(facade: RealFacade, spaceId: string): EntityId | null {
  const [id, setId] = useState<EntityId | null>(null);
  useEffect(() => {
    let alive = true;
    loadViewerId(facade, spaceId).then((v) => { if (alive) setId(v); });
    return () => { alive = false; };
  }, [facade, spaceId]);
  return id;
}

/** Test seam — the promise cache outlives a component tree by design. */
export function __resetViewerCache(): void {
  viewerCache.clear();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Every write goes through the facade (never a hand-built body) and every one
 * of them carries `expectedVersion` read off the row the user was looking at.
 * That is what makes a stale panel fail loudly with a conflict instead of
 * overwriting a change it never rendered.
 */
export interface TaskWrites {
  create(title: string, parentId?: EntityId | null): Promise<void>;
  rename(task: EntitySummary, title: string): Promise<void>;
  setStatus(task: EntitySummary, workStatus: WorkStatus): Promise<void>;
  complete(task: EntitySummary): Promise<void>;
}

export function useTaskWrites(
  facade: RealFacade,
  spaceId: string,
  viewerId: EntityId | null,
  onDone: () => void,
): TaskWrites & { busy: boolean; error: string | null; clearError: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setError(null); onDone(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(false); }
  }, [onDone]);

  const create = useCallback((title: string, parentId?: EntityId | null) => run(
    () => facade.createEntity({
      spaceId, kind: 'task', title, parentId: parentId ?? null,
      content: { description: '' },
      ...(viewerId ? { actorId: viewerId } : {}),
    }),
  ), [facade, spaceId, viewerId, run]);

  const rename = useCallback((task: EntitySummary, title: string) => run(
    () => facade.patchEntity(task.id, {
      expectedVersion: task.version, title, ...(viewerId ? { actorId: viewerId } : {}),
    }),
  ), [facade, viewerId, run]);

  // `content.workStatus` is a supported patch key (handlers/entities.ts) — the
  // status control is a real write, not a client-side label.
  const setStatus = useCallback((task: EntitySummary, workStatus: WorkStatus) => run(
    () => facade.patchEntity(task.id, {
      expectedVersion: task.version, content: { workStatus },
      ...(viewerId ? { actorId: viewerId } : {}),
    }),
  ), [facade, viewerId, run]);

  const complete = useCallback((task: EntitySummary) => run(
    () => {
      if (!viewerId) {
        // The facade would throw the same refusal; saying it here names the
        // missing thing (who is completing this) rather than the symptom.
        throw new Error('cannot complete: this node did not report who you are');
      }
      return facade.completeTask(task.id, {
        expectedVersion: task.version, completerIds: [viewerId], actorId: viewerId,
      });
    },
  ), [facade, viewerId, run]);

  return { create, rename, setStatus, complete, busy, error, clearError: () => setError(null) };
}

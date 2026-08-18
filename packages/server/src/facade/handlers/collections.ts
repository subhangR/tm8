/**
 * `collections.query` — the one query executor behind every list in the
 * product: boards, channel tabs, the home presets, search-less browsing.
 *
 * TWO THINGS ARE LOAD-BEARING HERE.
 *
 * **Keyset, never OFFSET (DEV-5).** Every page is ordered by `(sortValue, id)`
 * and the cursor carries that pair. OFFSET paging silently skips or repeats
 * rows whenever anything is inserted between two page fetches — which, in a
 * live workspace, is always. The cursor is the contract's opaque
 * `{v:2,k:[...]}` base64url form, so a stale or foreign cursor is rejected as
 * `invalid_cursor` rather than reinterpreted as page 1.
 *
 * **The filters are executed, not approximated.** `readyToPull` reproduces
 * `ready_to_work`'s dependency rule (007:2337) rather than merely filtering on
 * `work_status`, because a task blocked on an unfinished hard dependency is not
 * ready no matter what its status column says.
 *
 * The `query` echoed back in the result is the query as RESOLVED, so a client
 * (or a channel auto-tab) can re-run it verbatim and get the same rows.
 */
import { createHash } from 'node:crypto';
import {
  CollabError,
  decodeCursor,
  encodeCursor,
  type CollectionGroup,
  type CollectionAddItemInput,
  type CollectionQuery,
  type CollectionResult,
  type EntitySummary,
  type Page,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, limitOf, MAX_LIMIT, requireUuidParam } from '../context.js';
import {
  assembleSummaries, ENTITY_COLUMNS, ENTITY_FROM, MICROS, type EntityRow,
} from '../entity-read.js';
import { toCommandResult, type RpcCommandResult } from './entities.js';

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortName = NonNullable<CollectionQuery['sort']>;

interface SortSpec {
  /** SQL expression the page is ordered by. */
  readonly expr: string;
  readonly dir: 'asc' | 'desc';
  /** Cast applied to the cursor's sort value so the row comparison type-checks. */
  readonly cast: string;
  /**
   * The SAME value rendered so the cursor can carry it EXACTLY.
   *
   * Never let a temporal sort key reach the cursor as a JavaScript `Date`.
   * `timestamptz` carries MICROSECONDS and a `Date` keeps only milliseconds, so
   * the encoded key lands strictly before the row it came from; both temporal
   * sorts here are DESC, where that does not loop but SILENTLY SKIPS every row
   * sharing the lost millisecond — and `activityAt_desc` is the DEFAULT sort.
   * `date` is worse in a quieter way: node-pg parses it at LOCAL midnight, so
   * `toISOString()` can move a due date to the previous day west of UTC.
   * Rendering in SQL removes both hazards; numeric sorts need no rendering.
   */
  readonly cursorExpr: string;
}

/**
 * `dueDate` sorts NULLs last by coalescing to a sentinel rather than using
 * `NULLS LAST`: a keyset comparison over a nullable column cannot express
 * "nulls last" as a simple row comparison, and getting that subtly wrong loses
 * rows at a page boundary. A sentinel makes the column total-ordered.
 */
const SORTS: Record<SortName, SortSpec> = {
  activityAt_desc: {
    expr: 'e.activity_at', dir: 'desc', cast: 'timestamptz', cursorExpr: MICROS('e.activity_at'),
  },
  updatedAt_desc: {
    expr: 'e.updated_at', dir: 'desc', cast: 'timestamptz', cursorExpr: MICROS('e.updated_at'),
  },
  createdAt_desc: {
    expr: 'e.created_at', dir: 'desc', cast: 'timestamptz', cursorExpr: MICROS('e.created_at'),
  },
  position: {
    expr: 'e.position', dir: 'asc', cast: 'double precision', cursorExpr: 'e.position',
  },
  dueDate: {
    expr: "coalesce(t.due_date, '9999-12-31'::date)",
    dir: 'asc',
    cast: 'date',
    cursorExpr: "to_char(coalesce(t.due_date, '9999-12-31'::date), 'YYYY-MM-DD')",
  },
  priority: {
    expr: "case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end",
    dir: 'asc',
    cast: 'integer',
    cursorExpr: "case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end",
  },
};

const DEFAULT_SORT: SortName = 'activityAt_desc';

/**
 * Bind an opaque keyset to the complete semantic query that minted it.
 *
 * A syntactically valid `(sortValue,id)` from another filter is more dangerous
 * than a malformed cursor: Postgres can execute it and return a plausible but
 * incorrect page. The first cursor key is therefore a stable digest of the
 * normalized query plus the operation scope. `cursor` and `limit` are excluded
 * because they control traversal rather than membership/order; changing any
 * filter, hierarchy, grouping, layout, graph lens, or sort invalidates it.
 */
function cursorFingerprint(
  query: CollectionQuery,
  sort: SortName,
  scope: string,
): string {
  const { cursor: _cursor, limit: _limit, ...shape } = query;

  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      );
    }
    return value;
  };

  const canonical = JSON.stringify(stable({ ...shape, sort, scope }));
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

/**
 * A cursor must fail CLOSED.
 *
 * A cursor minted for one sort is meaningless under another — `encodeCursor
 * (['zzz-not-a-real-sort-value', 'ent_foreign'])` aimed at an `activityAt_desc`
 * page is not a timestamp. Bound straight into `$n::timestamptz` it raises
 * SQLSTATE 22007 from deep inside the query, which surfaces as a 503 and reads
 * like the database is unwell.
 *
 * Worse than the wrong status is the failure mode this prevents: if a foreign
 * key were ever coerced into something castable, the page would silently
 * resume from the WRONG POSITION — a wrong-page-of-results bug that presents
 * as data loss. So the key is checked against the sort's own type before it
 * goes anywhere near SQL, and a mismatch is `invalid_cursor` (400), which is
 * exactly what it is: the client's cursor is not usable here.
 */
function assertCursorKey(value: unknown, cast: string): string | number {
  const fail = (why: string): never => {
    throw new CollabError('invalid_cursor', `invalid cursor: ${why}`);
  };
  if (value === null || value === undefined) return fail('missing sort key');

  switch (cast) {
    case 'timestamptz':
    case 'date': {
      const s = String(value);
      if (Number.isNaN(Date.parse(s))) return fail(`sort key ${JSON.stringify(s)} is not a timestamp`);
      return s;
    }
    case 'double precision':
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) return fail(`sort key ${JSON.stringify(value)} is not a number`);
      return n;
    }
    default:
      return String(value);
  }
}

/** The last row's id, which is always a uuid. */
function assertCursorId(value: unknown): string {
  const s = String(value ?? '');
  if (!UUID_RE.test(s)) {
    throw new CollabError('invalid_cursor', `invalid cursor: ${JSON.stringify(s)} is not an entity id`);
  }
  return s;
}

/** The raw sort value for the last row of a page, as it goes into the cursor. */
/**
 * The cursor's sort key, taken from `__sort_cursor` — rendered by Postgres, so
 * it is already exact. A `Date` reaching here at all means some sort forgot its
 * `cursorExpr`, which is the truncation bug returning; it is refused rather
 * than silently converted.
 */
function sortKeyOf(row: { __sort_cursor?: unknown }, sort: SortName): string | number {
  const raw = row.__sort_cursor;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) {
    throw new CollabError('upstream_unavailable', `sort key missing for ${sort}`);
  }
  throw new CollabError(
    'upstream_unavailable',
    `sort key for ${sort} is not exact text — a Date here would truncate the cursor`,
  );
}

// ---------------------------------------------------------------------------
// WHERE assembly
// ---------------------------------------------------------------------------

class Params {
  readonly values: unknown[] = [];
  /** Bind a value and return its placeholder. Nothing reaches SQL by concatenation. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) throw new CollabError('invalid_input', `${field} must be a uuid`);
  return value;
}

function assertUuids(values: readonly string[], field: string): string[] {
  return values.map((v) => assertUuid(v, field));
}

/**
 * The unresolved-hard-dependency predicate, shared by `readyToPull` and by the
 * blocked badge. `internal.is_resolved` decides what "resolved" means — since
 * phase 5 (migration 152) that is `status_category = 'done'` for EVERY kind,
 * with `pull_request` overridden to the forge's merged state. Asking it here
 * keeps one definition, which is what let that widening reach this predicate
 * without a line changing.
 */
const UNBLOCKED_PREDICATE = `not exists (
  select 1 from public.edges dep
   where dep.src_id = e.id
     and dep.type = 'depends_on'
     and coalesce((dep.props ->> 'hard')::boolean, true)
     and not internal.is_resolved(dep.dst_id)
)`;

function buildWhere(query: CollectionQuery, p: Params): string[] {
  const where: string[] = [`e.space_id = ${p.add(assertUuid(query.spaceId, 'spaceId'))}`];
  const f = query.filters ?? {};

  // Soft-delete posture. Default EXCLUDE: a tombstone is a graph-shape record,
  // not a list row.
  switch (f.deleted ?? 'exclude') {
    case 'only':
      where.push('e.deleted_at is not null');
      break;
    case 'include':
      break;
    default:
      where.push('e.deleted_at is null');
  }

  // The lifecycle bucket, beside the soft-delete posture on purpose: these are
  // the two envelope-level dispositions a list row has, and the four category
  // tabs run this predicate on every read. It sits on `e`, not on `t`, which is
  // the whole reason the column was denormalized — a category filter that
  // needed the task join could never serve the kinds that gain a status later.
  //
  // Kind-narrowing, by the same mechanism `status` uses: an entity with no
  // status has a NULL `status_category`, and `NULL = any(...)` is never true.
  // So the filter's PRESENCE restricts the page to entities that have a status,
  // which in this phase means tasks — no `kinds` clause required, and no
  // silently-included doc claiming to be To Do.
  //
  // Indexed by `entities(space_id, status_category) where deleted_at is null`
  // (147), which is the shape this actually runs in: space predicate first,
  // category second, tombstones already excluded by the default posture above.
  if (f.category && f.category.length > 0) {
    where.push(`e.status_category = any(${p.add(f.category)}::text[])`);
  }

  if (query.kinds && query.kinds.length > 0) {
    // 153: A KIND FILTER SELECTS A FAMILY, not a literal.
    //
    // This is a CONTINUITY requirement, not a feature. Before phase 6 a task
    // tagged `type=epic` was a `task` and every list filtering `kinds:['task']`
    // showed it. Phase 6 makes it a `c:epic`, so a literal comparison would
    // have silently emptied the Work tab, the home presets and both boards of
    // every epic, bug and story in the graph on migration day — a
    // data-visibility regression with no error anywhere.
    //
    // A kind matches by its own name OR by what it extends, which is the same
    // rule `internal.base_kind_of` states everywhere else. The EXISTS is
    // correlated on the row's own space so one space's `c:epic` cannot be
    // pulled in by another's.
    const kindsParam = p.add(query.kinds);
    where.push(`(e.kind = any(${kindsParam}::text[]) or exists (
      select 1 from public.entity_kinds k
       where k.kind = e.kind and k.space_id = e.space_id
         and k.base_kind = any(${kindsParam}::text[])
    ))`);
  }

  if (query.subtreeOf) {
    // Descendants, NOT the root: "the subtree of X" is the things under X.
    // `entity_tree` is depth-capped so a pathological hierarchy cannot turn
    // one list request into an unbounded scan.
    where.push(
      `e.id in (select id from public.entity_tree(${p.add(assertUuid(query.subtreeOf, 'subtreeOf'))}, 32) where depth > 0)`,
    );
  }

  if (query.parentId !== undefined) {
    where.push(
      query.parentId === null
        ? 'e.parent_id is null'
        : `e.parent_id = ${p.add(assertUuid(query.parentId, 'parentId'))}`,
    );
  }

  if (f.status && f.status.length > 0) {
    where.push(`t.work_status = any(${p.add(f.status)}::text[])`);
  }

  // Board tab wave (2026-08-16): same kind-narrowing semantics as status —
  // t.priority is NULL for every non-task row, so presence restricts to tasks.
  if (f.priority && f.priority.length > 0) {
    where.push(`t.priority = any(${p.add(f.priority)}::text[])`);
  }

  // A22: same kind-narrowing semantics as status — ws.status is NULL for
  // every non-work_session row, and NULL = any(...) is never true, so the
  // filter's presence restricts the result to work_sessions in these statuses.
  if (f.sessionStatus && f.sessionStatus.length > 0) {
    where.push(`ws.status = any(${p.add(f.sessionStatus)}::text[])`);
  }

  if (f.axes) {
    for (const [axis, values] of Object.entries(f.axes)) {
      if (!values || values.length === 0) continue;
      // `axes` is jsonb; `->>` keeps this on the GIN-indexed column's semantics
      // without needing a containment expression per value.
      where.push(`t.axes ->> ${p.add(axis)} = any(${p.add(values)}::text[])`);
    }
  }

  if (f.assigneeIds && f.assigneeIds.length > 0) {
    where.push(`exists (
      select 1 from public.edges a
       where a.src_id = e.id and a.type = 'assigned_to'
         and a.dst_id = any(${p.add(assertUuids(f.assigneeIds, 'assigneeIds'))}::uuid[])
    )`);
  }

  if (f.assignedByIds && f.assignedByIds.length > 0) {
    where.push(`exists (
      select 1 from public.edges a
       where a.src_id = e.id and a.type = 'assigned_to'
         and a.assigned_by = any(${p.add(assertUuids(f.assignedByIds, 'assignedByIds'))}::uuid[])
    )`);
  }

  if (f.edge) {
    const { type, direction, entityId } = f.edge;
    const self = direction === 'outgoing' ? 'src_id' : 'dst_id';
    const other = direction === 'outgoing' ? 'dst_id' : 'src_id';
    where.push(`exists (
      select 1 from public.edges g
       where g.${self} = e.id and g.type = ${p.add(type)}
         and g.${other} = ${p.add(assertUuid(entityId, 'filters.edge.entityId'))}
    )`);
  }

  if (f.activeSince) {
    // The clock window. `activity_at` is the same column `activityAt_desc`
    // orders by, so a windowed read is the default ordering with a floor under
    // it rather than a second notion of recency the client has to reconcile.
    where.push(`e.activity_at >= ${p.add(f.activeSince)}::timestamptz`);
  }

  if (f.readyToPull) {
    // Phase 5 (152): the category, not the two literals it used to enumerate.
    // `open` and `pulled` were exactly the `to_do` literals, so this is the same
    // set said once — and it now follows a space that renamed its states, which
    // the literal list could not. `t.entity_id is not null` keeps the preset
    // TASK-SHAPED: every kind carries a category from 152 onward, so dropping
    // the literal without saying "and it is a task" would have widened
    // "what can I pull" to every doc and channel in the space.
    where.push(`t.entity_id is not null`);
    where.push(`e.status_category = 'to_do'`);
    where.push(UNBLOCKED_PREDICATE);
  }

  if (f.workedByActorId) {
    // "Worked by {person}" with the SECOND HOP (doc 06 §3.2): a plain edge
    // filter on `working_on` matches only person-sourced edges (~15% of live
    // data) and silently misses the rest. The honest form matches an edge
    // whose source IS the actor, or is a work_session the actor
    // `participates_in` — the same hop `loadActors` resolves attribution by.
    const actor = p.add(assertUuid(f.workedByActorId, 'filters.workedByActorId'));
    where.push(`exists (
      select 1 from public.edges w
       where w.dst_id = e.id and w.type = 'working_on'
         and (w.src_id = ${actor}
           or exists (
                select 1 from public.edges pe
                 where pe.type = 'participates_in'
                   and pe.dst_id = w.src_id
                   and pe.src_id = ${actor}
              ))
    )`);
  }

  if (f.inFlightForActorId) {
    // "In flight for me" = pulled or being worked on by an actor in my scope,
    // and not finished. Actor scope is the member row plus the personas it
    // owns, so an agent's work shows up on its owner's home.
    const actor = p.add(assertUuid(f.inFlightForActorId, 'filters.inFlightForActorId'));
    where.push(`t.work_status not in ('done','cancelled')`);
    where.push(`exists (
      select 1 from public.edges w
       join public.entities we on we.id = w.src_id
       left join public.team_members wtm on wtm.entity_id = we.id
       where w.dst_id = e.id and w.type in ('working_on','pulled')
         and (w.src_id = ${actor} or wtm.owner_member_id = ${actor})
    )`);
  }

  if (f.inReviewForActorId) {
    const actor = p.add(assertUuid(f.inReviewForActorId, 'filters.inReviewForActorId'));
    where.push(`t.work_status = 'in_review'`);
    where.push(`exists (
      select 1 from public.edges r
       where r.src_id = e.id and r.type in ('assigned_to','approval_requested_from')
         and r.dst_id = ${actor}
    )`);
  }

  if (f.mentionedActorId) {
    const actor = p.add(assertUuid(f.mentionedActorId, 'filters.mentionedActorId'));
    where.push(`exists (
      select 1 from public.messages mm
       where mm.anchor_id = e.id
         and mm.mentions @> jsonb_build_array(jsonb_build_object('entityId', ${actor}))
    )`);
  }

  if (f.needsActorId) {
    // The union of the two "wants my attention" senses, as one predicate:
    // awaiting my review, or mentioning me.
    const actor = p.add(assertUuid(f.needsActorId, 'filters.needsActorId'));
    where.push(`(
      (t.work_status = 'in_review' and exists (
         select 1 from public.edges r
          where r.src_id = e.id and r.type in ('assigned_to','approval_requested_from')
            and r.dst_id = ${actor}))
      or exists (
         select 1 from public.messages mm
          where mm.anchor_id = e.id
            and mm.mentions @> jsonb_build_array(jsonb_build_object('entityId', ${actor}))))`);
  }

  return where;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const WORK_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  pulled: 'Pulled',
  working: 'Working',
  in_review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Groups partition the PAGE that was fetched, not the whole result set.
 *
 * Stated plainly because it is a real limit: per-group keyset paging (each
 * `CollectionGroup` carrying its own `nextCursor`) is not built, so a board
 * whose column is longer than one page shows one page of that column. The
 * groups are otherwise real — computed server-side from the same rows the page
 * returned, so the client never groups anything itself (L3).
 */
function groupItems(items: EntitySummary[], groupBy: NonNullable<CollectionQuery['groupBy']>): CollectionGroup[] {
  const buckets = new Map<string, { label: string; items: EntitySummary[] }>();

  const put = (key: string, label: string, item: EntitySummary): void => {
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(item);
    else buckets.set(key, { label, items: [item] });
  };

  for (const item of items) {
    if (groupBy === 'status') {
      const status = item.state.kind === 'task' ? item.state.status : 'open';
      put(status, WORK_STATUS_LABELS[status] ?? status, item);
      continue;
    }
    if (groupBy === 'priority') {
      // Non-task rows have no priority; 'medium' mirrors the status arm's
      // 'open' default so the bucket and the SQL total cannot disagree.
      const priority = item.state.kind === 'task' ? item.state.priority : 'medium';
      put(priority, PRIORITY_LABELS[priority] ?? priority, item);
      continue;
    }
    if (groupBy === 'kind') {
      // 153: what `axis:type` used to be. The type values ARE kinds now, so
      // grouping epics from bugs from stories is grouping by the entity's own
      // kind — and it works for every family rather than for the one axis a
      // space happened to name `type`.
      //
      // The label is the raw kind string, and deliberately so: the server has
      // no display registry, `entity_kinds.label` may be null for every core
      // kind until phase 10 serves it, and inventing 'Epic' from 'c:epic' here
      // would put a second, worse labelling authority beside the client's.
      put(item.kind, item.kind, item);
      continue;
    }
    if (groupBy === 'assignee') {
      const assignees = item.state.kind === 'task' ? item.state.assignees : [];
      if (assignees.length === 0) {
        put('', 'Unassigned', item);
        continue;
      }
      // A task with two assignees belongs in both columns. Duplicating it is
      // the honest rendering; picking one would hide the task from someone.
      for (const actor of assignees) put(actor.id, actor.displayName, item);
      continue;
    }
    // `axis:<name>`
    const axis = groupBy.slice('axis:'.length);
    const value = item.state.kind === 'task' ? (item.state.axes[axis] ?? '') : '';
    put(value, value === '' ? 'Unset' : value, item);
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: bucket.label,
    items: bucket.items,
  }));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a resolved collection query inside an existing transaction.
 *
 * Exported as a plain function so `spaces.home`'s presets run through the SAME
 * executor as a client-issued `collections.query`. A preset with its own query
 * path is a preset that drifts from the query it claims to be.
 */
export async function queryCollection(
  q: Querier,
  query: CollectionQuery,
  viewerIdentityId: string,
  cursorScope = 'collections.query',
): Promise<CollectionResult> {
  const sortName: SortName = query.sort ?? DEFAULT_SORT;
  const sort = SORTS[sortName];
  if (!sort) throw new CollabError('invalid_input', `unsupported sort: ${String(query.sort)}`);

  if (query.groupBy && !['status', 'assignee', 'priority', 'kind'].includes(query.groupBy) && !query.groupBy.startsWith('axis:')) {
    throw new CollabError('invalid_input', `unsupported groupBy: ${query.groupBy}`);
  }

  const limit = limitOf(query.limit);
  const fingerprint = cursorFingerprint(query, sortName, cursorScope);
  const p = new Params();
  const where = buildWhere(query, p);
  // The cursor clause below narrows to "after this row" — a PAGE fact. Group
  // totals are a QUERY fact, so they are computed against the where/params as
  // they stand here, before the cursor narrows them.
  const baseWhere = [...where];
  const baseParamCount = p.values.length;

  if (query.cursor) {
    const { k } = decodeCursor(query.cursor);
    if (k.length !== 3) {
      throw new CollabError('invalid_cursor', 'invalid cursor: expected [fingerprint, sortValue, id]');
    }
    if (k[0] !== fingerprint) {
      throw new CollabError('invalid_cursor', 'invalid cursor: query fingerprint does not match');
    }
    // Validated against THIS sort's type before binding — see assertCursorKey.
    const sortValue = assertCursorKey(k[1], sort.cast);
    const lastId = assertCursorId(k[2]);
    // A row comparison, not two ORed predicates: `(a, b) < (x, y)` is exactly
    // the "everything after this row in this ordering" the keyset needs, and
    // Postgres can use the composite index for it.
    const op = sort.dir === 'desc' ? '<' : '>';
    where.push(
      `(${sort.expr}, e.id) ${op} (${p.add(sortValue)}::${sort.cast}, ${p.add(lastId)}::uuid)`,
    );
  }

  // Fetch one extra row: its existence is what says "there is another page",
  // without a second COUNT query that could disagree with the page itself.
  const fetchLimit = Math.min(limit, MAX_LIMIT) + 1;
  const rows = await q.query<EntityRow & { __sort: unknown; __sort_cursor: string | number }>(
    `select ${ENTITY_COLUMNS}, ${sort.expr} as __sort, ${sort.cursorExpr} as __sort_cursor
     ${ENTITY_FROM}
      where ${where.join('\n        and ')}
      order by ${sort.expr} ${sort.dir}, e.id ${sort.dir}
      limit ${fetchLimit}`,
    p.values,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await assembleSummaries(q, pageRows, viewerIdentityId);

  const last = pageRows[pageRows.length - 1];
  const page: Page<EntitySummary> = {
    items,
    nextCursor: hasMore && last
      ? encodeCursor([fingerprint, sortKeyOf(last, sortName), last.id])
      : null,
    // THE TRUE SIZE OF THE MATCH — phase 7's counts ruling. See `queryTotal`.
    total: await queryTotal(q, baseWhere, p.values.slice(0, baseParamCount)),
  };

  // The query as resolved, so re-running it is reproducible.
  const resolved: CollectionQuery = { ...query, sort: sortName, limit };
  if (!query.groupBy) return { query: resolved, page };

  // The groups stay page-scoped (per-group paging is not built), but each
  // carries its TRUE size under the query's filters — the number that lets a
  // board header say "12" instead of hedging "{n} shown" (doc 06 §1.4).
  const groups = groupItems(items, query.groupBy);
  const totals = await groupTotals(q, query.groupBy, baseWhere, p.values.slice(0, baseParamCount));
  for (const group of groups) {
    const total = totals.get(group.key);
    if (total !== undefined) {
      group.total = total;
      totals.delete(group.key);
    }
  }
  // A group with rows but none ON THIS PAGE still exists — append it empty
  // with its count, so a column can honestly read "0 shown of 12". Assignee
  // keys are actor ids whose display names only page items carry, so those
  // stay attached-only rather than appended with an id for a label.
  if (query.groupBy !== 'assignee') {
    for (const [key, total] of totals) {
      if (total === 0) continue;
      groups.push({
        key,
        label:
          query.groupBy === 'status'
            ? (WORK_STATUS_LABELS[key] ?? key)
            : query.groupBy === 'priority'
              ? (PRIORITY_LABELS[key] ?? key)
              : key === ''
                ? 'Unset'
                : key,
        items: [],
        total,
      });
    }
  }
  return { query: resolved, page, groups };
}

/**
 * THE TRUE SIZE OF THE MATCH, from a server aggregate — `Page.total`.
 *
 * ## What this fixes
 *
 * `Page.total` has been a contract member all along and the facade never
 * populated it, so every count in the product was `rows.length` over the rows
 * that happened to be LOADED. A 601-row Done tab read `50` because the first
 * page was full; the honest workaround (`countLabel`'s `50+`) is a hedge, not
 * a number. The four category tabs, the footer line and the kind-selector
 * total all read that one source, so they could never disagree with each
 * other — they under-counted TOGETHER, which is the failure mode that looks
 * like a working feature.
 *
 * ## Why it is affordable now
 *
 * `entities.status_category` is a real column with a partial index
 * (`(space_id, status_category) where deleted_at is null`, migration 147), so
 * the tab reads — the highest-frequency counted query in the product — are an
 * index-only aggregate. The joins in `ENTITY_FROM` are `entity_id`-unique
 * LEFT JOINs, which Postgres eliminates outright for a count that names none
 * of their columns, so the plan is usually just the entity index.
 *
 * ## Query-scoped, not page-scoped
 *
 * Computed against `baseWhere` — the WHERE with the CURSOR CLAUSE EXCLUDED,
 * the same base `groupTotals` uses. A total that shrank as you paged would be
 * describing the page, and the page already describes itself.
 *
 * `count(*)`, not `count(distinct e.id)`: every predicate `buildWhere`
 * produces is either a scalar comparison on `e`/`t`/`ws` or an `exists (…)`
 * subquery, and neither multiplies rows. `groupTotals` needs the `distinct`
 * because it adds a real `left join` on `public.edges` for the assignee key.
 */
async function queryTotal(
  q: Querier,
  where: readonly string[],
  params: readonly unknown[],
): Promise<number> {
  const rows = await q.query<{ total: number }>(
    `select count(*)::int as total
     ${ENTITY_FROM}
      where ${where.join('\n        and ')}`,
    [...params],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * True group sizes for a grouped query, from ONE aggregate over the same
 * WHERE the page used (cursor clause excluded — totals are query-scoped).
 * Key expressions mirror `groupItems` exactly: a non-task row lands where the
 * in-page grouping would put it, so the count and the bucket cannot disagree.
 */
async function groupTotals(
  q: Querier,
  groupBy: NonNullable<CollectionQuery['groupBy']>,
  where: readonly string[],
  params: readonly unknown[],
): Promise<Map<string, number>> {
  const values = [...params];
  let keyExpr: string;
  let extraJoin = '';
  if (groupBy === 'status') {
    keyExpr = `coalesce(t.work_status, 'open')`;
  } else if (groupBy === 'priority') {
    keyExpr = `coalesce(t.priority, 'medium')`;
  } else if (groupBy === 'assignee') {
    keyExpr = `coalesce(ag.dst_id::text, '')`;
    extraJoin = `left join public.edges ag on ag.src_id = e.id and ag.type = 'assigned_to'`;
  } else {
    values.push(groupBy.slice('axis:'.length));
    keyExpr = `coalesce(t.axes ->> $${values.length}, '')`;
  }
  const rows = await q.query<{ key: string; total: number }>(
    `select ${keyExpr} as key, count(distinct e.id)::int as total
     ${ENTITY_FROM}
     ${extraJoin}
      where ${where.join('\n        and ')}
      group by 1`,
    values,
  );
  return new Map(rows.map((r) => [r.key, Number(r.total)]));
}

export function collectionsQuery(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const query = ctx.body as CollectionQuery;
    return deps.db.tx(claimsFor(owner, ctx), (q) => queryCollection(q, query, owner.identityId));
  };
}

/**
 * Membership writes are sugar over the `contains` edge, not a parallel store:
 * both RPCs ledger under the `edges.*` family, and the 003 edge trigger emits
 * `edge.upsert`/`edge.deleted` so live collection views refresh with no new
 * event plumbing. Add without a `position` appends after the current maximum;
 * re-adding an existing member re-positions it instead of duplicating.
 */
export function collectionsAddItem(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const collectionId = requireUuidParam(ctx, 'id');
    const input = ctx.body as CollectionAddItemInput;
    const envelope = commandEnvelope(ctx);
    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('set_collection_item', [
        collectionId,
        input.entityId,
        input.position ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return toCommandResult(q, raw, owner.identityId);
    });
  };
}

export function collectionsRemoveItem(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const collectionId = requireUuidParam(ctx, 'id');
    const entityId = requireUuidParam(ctx, 'entityId');
    const envelope = commandEnvelope(ctx);
    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('remove_collection_item', [
        collectionId,
        entityId,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return toCommandResult(q, raw, owner.identityId);
    });
  };
}

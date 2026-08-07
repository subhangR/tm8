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
  type AddCollectionItemInput,
  type CollectionGroup,
  type CollectionQuery,
  type CollectionResult,
  type EntitySummary,
  type Page,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, limitOf, MAX_LIMIT, requireUuidParam } from '../context.js';
import { toCommandResult, type RpcCommandResult } from './entities.js';
import {
  assembleSummaries, ENTITY_COLUMNS, ENTITY_FROM, MICROS, type EntityRow,
} from '../entity-read.js';

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
 * Sentinel for a `contains` edge carrying no readable `props.position`.
 *
 * Same trick, and the same reason, as `dueDate`'s `'9999-12-31'`: a keyset
 * comparison over a nullable column cannot express "nulls last" as one row
 * comparison, so an unpositioned member would be lost at a page boundary
 * rather than merely misplaced. Coalescing makes the column total-ordered.
 * `set_collection_item` always writes a position, so this covers only rows
 * written straight through `edges.create` with bare props.
 */
const UNPOSITIONED = '1e308';

/**
 * Resolve `sort` against the query, because ONE sort name means two different
 * columns depending on what is being listed.
 *
 * `position` on a hierarchy listing means `e.position` — where the entity sits
 * among its siblings under a shared parent. `position` on a COLLECTION's
 * membership means `props.position` on the `contains` edge, which is a
 * completely different number about a completely different tree. Until this
 * existed only the first was implemented, so asking a collection for its items
 * in curated order returned them in hierarchy order: a confident, stable,
 * wrong answer, and the reason a curated list could be written but never read
 * back as curated. Nothing surfaced it because both orderings are plausible
 * lists of the right rows.
 *
 * The trigger is the membership filter itself — `filters.edge` naming
 * `contains` INCOMING from a collection is exactly "the items of that
 * collection", so the sort follows the filter rather than needing a new
 * caller-supplied sort name that every existing client would have to learn.
 * An OUTGOING `contains` filter is not membership (it asks "which collections
 * is this in"), so it keeps hierarchy position.
 *
 * The correlated subquery is safe against duplicates: `edges` is unique on
 * `(src_id, dst_id, type)`, so at most one row can match and the scalar can
 * never raise 21000.
 */
function resolveSort(query: CollectionQuery, sortName: SortName, p: Params): SortSpec {
  const base = SORTS[sortName];
  const f = query.filters;
  if (
    sortName !== 'position'
    || !f?.edge
    || f.edge.type !== 'contains'
    || f.edge.direction !== 'incoming'
  ) {
    return base;
  }
  const collection = p.add(assertUuid(f.edge.entityId, 'filters.edge.entityId'));
  const expr = `coalesce((
      select (g.props ->> 'position')::double precision
        from public.edges g
       where g.src_id = ${collection} and g.dst_id = e.id and g.type = 'contains'
     ), ${UNPOSITIONED}::double precision)`;
  // `cursorExpr` is the same expression, not a rendered form: the value is a
  // float8 the cursor carries verbatim, so there is no precision to lose the
  // way a timestamptz or a date has (see SortSpec.cursorExpr).
  return { expr, dir: 'asc', cast: 'double precision', cursorExpr: expr };
}

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
 * blocked badge. `internal.is_resolved` decides what "resolved" means per kind
 * (a task when done, a PR when merged) — asking it here keeps one definition.
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

  if (query.kinds && query.kinds.length > 0) {
    where.push(`e.kind = any(${p.add(query.kinds)}::text[])`);
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

  if (f.workStatus && f.workStatus.length > 0) {
    where.push(`t.work_status = any(${p.add(f.workStatus)}::text[])`);
  }

  // A22: same kind-narrowing semantics as workStatus — ws.status is NULL for
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

  if (f.readyToPull) {
    where.push(`t.work_status in ('open','pulled')`);
    where.push(UNBLOCKED_PREDICATE);
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
    if (groupBy === 'workStatus') {
      const status = item.state.kind === 'task' ? item.state.workStatus : 'open';
      put(status, WORK_STATUS_LABELS[status] ?? status, item);
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
  if (!SORTS[sortName]) throw new CollabError('invalid_input', `unsupported sort: ${String(query.sort)}`);

  if (query.groupBy && !['workStatus', 'assignee'].includes(query.groupBy) && !query.groupBy.startsWith('axis:')) {
    throw new CollabError('invalid_input', `unsupported groupBy: ${query.groupBy}`);
  }

  const limit = limitOf(query.limit);
  const fingerprint = cursorFingerprint(query, sortName, cursorScope);
  const p = new Params();
  // Resolved BEFORE the predicates so the collection id it may bind is added
  // to the same `Params`. Placeholders carry their own index, so the order of
  // `p.add` calls does not have to match the order they appear in the SQL.
  const sort = resolveSort(query, sortName, p);
  const where = buildWhere(query, p);

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
  };

  // The query as resolved, so re-running it is reproducible.
  const resolved: CollectionQuery = { ...query, sort: sortName, limit };
  return query.groupBy
    ? { query: resolved, page, groups: groupItems(items, query.groupBy) }
    : { query: resolved, page };
}

export function collectionsQuery(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const query = ctx.body as CollectionQuery;
    return deps.db.tx(claimsFor(owner, ctx), (q) => queryCollection(q, query, owner.identityId));
  };
}

// ---------------------------------------------------------------------------
// Membership writes
// ---------------------------------------------------------------------------

/**
 * `collections.addItem` — put an entity in a collection, or move it within one.
 *
 * Thin by design: every rule lives in `set_collection_item` (007:1160), which
 * resolves the actor, appends at `max(position)+1` when none is given, upserts
 * on the unique `(src,dst,type)` so a re-add is a move, and — since 077 made
 * `contains` acyclic — refuses a nesting cycle. Re-implementing the append
 * here would put the max-and-insert in two statements the way a client would
 * have to, which is the race the RPC exists to avoid.
 *
 * 200, not 201: an upsert cannot honestly claim to have created something. The
 * same call is both "add" and "reorder", and the second one creates nothing.
 */
export function collectionsAddItem(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const collectionId = requireUuidParam(ctx, 'id');
    const envelope = commandEnvelope(ctx);
    const input = ctx.body as AddCollectionItemInput;

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

/**
 * `collections.removeItem` — take an entity back out.
 *
 * Path-addressed by the PAIR, which is the point: `edges.delete` already does
 * this but needs the edge's id, and nothing on the read side hands one out for
 * a collection member — `content.items` is a list of entity summaries. The
 * caller who wants "take this out of that list" knows exactly two ids, and
 * these are they.
 *
 * Removing something that is not in the collection is a 200 reporting
 * `removed:false`, not a 404. The caller asked for a state ("not in this
 * list") that already holds, and a retry after a dropped response must not
 * become an error. The RPC records no activity in that case, so a repeated
 * remove does not fill the collection's timeline with `unlinked` noise.
 */
export function collectionsRemoveItem(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const collectionId = requireUuidParam(ctx, 'id');
    const entityId = requireUuidParam(ctx, 'entityId');
    const envelope = commandEnvelope(ctx);

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult & { removed?: boolean }>('unset_collection_item', [
        collectionId,
        entityId,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      const result = await toCommandResult(q, raw, owner.identityId);
      return { ...result, removed: raw?.removed ?? false };
    });
  };
}

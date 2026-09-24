/**
 * `events.changes` — the scoped change feed (`GET /v2/spaces/:spaceId/events/changes`,
 * spec doc 01a0cf35 §3, §5).
 *
 * `events.poll` answers "give me every event after seq N, with full bodies".
 * A coordinator asking "did anything I care about change?" does not want that:
 * it replays the whole Space and re-hydrates every entity on every event. This
 * operation answers the question actually asked — one digest line per changed
 * entity in a scope, naming WHAT moved (`changes[]`) and WHO moved it
 * (`actors[]`), with the current state one `tm8 entity context` away.
 *
 * ## One query path
 *
 * A scoped request reads `workspace_events` through `subject_ids && $ids`
 * (migration 204's GIN index) with the space/seq predicates, and nothing else.
 * There is no jsonb fallback: a window reaching below the backfill watermark is
 * refused with `index_incomplete` (`subject-index.ts`), never answered from a
 * second path that could disagree with the first.
 *
 * ## Visibility is the mapper's
 *
 * Every examined row goes through `WorkspaceEventMapper.mapRows` under the
 * caller's claims, as a poll page does. A row it skips (unreadable under RLS,
 * hard-deleted, failed hydration) is EXAMINED — it advances `through` — and is
 * never emitted. The one exception is a hard-deleted entity the caller NAMED:
 * its `entity.deleted` row is reported from the captured spine, and only when
 * the caller could read that row under event RLS (§5).
 *
 * ## Pages never skip
 *
 * Entities are emitted in ascending first-changed seq, in atomic groups (the
 * entities one event first changed). A cap stops BEFORE the group that would
 * cross it, and `through` is then the omitted group's seq − 1, so the next
 * page re-reads that group rather than stepping over it. See `assembleDigest`.
 */
import {
  CollabError,
  EVENT_CHANGES_CHAT_MESSAGE_CAP,
  EVENT_CHANGES_DEFAULT_TOTAL_BYTES,
  EVENT_CHANGES_EXCERPT_CHARS,
  EVENT_CHANGES_MAX_ENTITIES,
  EVENT_CHANGES_MAX_EXAMINED,
  EVENT_CHANGES_MAX_SCOPE_IDS,
  EVENT_CHANGES_MAX_TOTAL_BYTES,
  EVENT_CHANGES_MESSAGE_CAP,
  EVENT_CHANGES_MIN_TOTAL_BYTES,
  EVENT_CHANGES_TITLE_CHARS,
  plainExcerpt,
  type DurableWorkspaceEvent,
  type EntitySummary,
  type EventChangeEntry,
  type EventChangeMessage,
  type EventChangesGap,
  type EventChangesScope,
  type EventChangesView,
  type EventChangeThinRow,
} from '@tm8/contract';

import type { Db, DbClaims, Querier } from '../db/types.js';
import { MICROS } from '../facade/entity-read.js';
import { newestFeedCursorAfter } from '../facade/services/w2/feed-context.js';
import { WorkspaceEventMapper, WORKSPACE_EVENT_COLUMNS, type WorkspaceEventRow } from './mapper.js';
import { PgEntityProjector, type EntityProjector } from './projector.js';
import { gateSubjectIndex } from './subject-index.js';

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface ChangesRequest {
  after: number;
  entity: string[];
  anchor: string[];
  subtree: string[];
  kind: string[];
  change: string[];
  events: boolean;
  totalBytes: number;
}

/** The roots of the closed change vocabulary (§3.2). A `--change` value names one, optionally with its `:detail`. */
export const CHANGE_CLASS_ROOTS = [
  'created', 'updated', 'status', 'deleted', 'message',
  'edge+', 'edge-', 'assigned', 'unassigned', 'pr', 'commit', 'notified',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every value of a repeatable query key, repeated (`?entity=a&entity=b`) or comma-joined (`?entity=a,b`). */
function listParam(query: URLSearchParams, key: string): string[] {
  return [...new Set(
    query.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== ''),
  )];
}

function idsParam(query: URLSearchParams, key: string): string[] {
  const ids = listParam(query, key);
  for (const id of ids) {
    // A malformed id could never match, and an always-empty digest would read
    // as "nothing changed" — refused, as `events.poll ?entity=` refuses it.
    if (!UUID_RE.test(id)) throw new CollabError('invalid_input', `${key} must be an entity id (uuid), got '${id}'`);
  }
  return ids.map((id) => id.toLowerCase());
}

/** `status:done` → `status`; `edge+:tracks` → `edge+`; `message` → `message`. */
export function changeRoot(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/** Does change class `cls` satisfy the `--change` filter value `filter`? */
export function changeMatches(cls: string, filter: string): boolean {
  return cls === filter || cls.startsWith(`${filter}:`) || cls.startsWith(`${filter}→`);
}

export function parseChangesQuery(query: URLSearchParams): ChangesRequest {
  const rawAfter = query.get('after') ?? query.get('since');
  let after = 0;
  if (rawAfter !== null && rawAfter !== '') {
    if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter))) {
      throw new CollabError('invalid_cursor', `after must be a non-negative integer seq, got '${rawAfter}'`);
    }
    after = Number(rawAfter);
  }

  let totalBytes = EVENT_CHANGES_DEFAULT_TOTAL_BYTES;
  const rawBytes = query.get('totalBytes');
  if (rawBytes !== null && rawBytes !== '') {
    const n = Number(rawBytes);
    // Out of range is a refusal, never an over-budget (or silently clamped) answer.
    if (!/^\d+$/.test(rawBytes) || n < EVENT_CHANGES_MIN_TOTAL_BYTES || n > EVENT_CHANGES_MAX_TOTAL_BYTES) {
      throw new CollabError(
        'invalid_input',
        `totalBytes must be an integer in ${String(EVENT_CHANGES_MIN_TOTAL_BYTES)}..${String(EVENT_CHANGES_MAX_TOTAL_BYTES)}, got '${rawBytes}'`,
      );
    }
    totalBytes = n;
  }

  const change = listParam(query, 'change');
  for (const value of change) {
    if (!(CHANGE_CLASS_ROOTS as readonly string[]).includes(changeRoot(value))) {
      throw new CollabError(
        'invalid_input',
        `change '${value}' is not in the change vocabulary (${CHANGE_CLASS_ROOTS.join(', ')})`,
      );
    }
  }

  const rawEvents = query.get('events');
  return {
    after,
    entity: idsParam(query, 'entity'),
    anchor: idsParam(query, 'anchor'),
    subtree: idsParam(query, 'subtree'),
    kind: listParam(query, 'kind'),
    change,
    events: rawEvents === 'true' || rawEvents === '1',
    totalBytes,
  };
}

/** The scope as echoed back: only the selectors that were given. */
function scopeOf(req: ChangesRequest): EventChangesScope {
  const scope: EventChangesScope = {};
  if (req.entity.length > 0) scope.entity = req.entity;
  if (req.anchor.length > 0) scope.anchor = req.anchor;
  if (req.subtree.length > 0) scope.subtree = req.subtree;
  if (req.kind.length > 0) scope.kind = req.kind;
  if (req.change.length > 0) scope.change = req.change;
  return scope;
}

/** `next`, spelled as the command that continues this exact request. */
export function nextCommand(req: ChangesRequest, through: number): string {
  const parts = ['tm8 event changes'];
  for (const id of req.entity) parts.push(`--entity ${id}`);
  for (const id of req.anchor) parts.push(`--anchor ${id}`);
  for (const id of req.subtree) parts.push(`--subtree ${id}`);
  for (const k of req.kind) parts.push(`--kind ${k}`);
  for (const c of req.change) parts.push(`--change ${c}`);
  if (req.events) parts.push('--events');
  if (req.totalBytes !== EVENT_CHANGES_DEFAULT_TOTAL_BYTES) parts.push(`--total-bytes ${String(req.totalBytes)}`);
  parts.push(`--after ${String(through)}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Attribution — which (entity, change) pairs one examined row produces
// ---------------------------------------------------------------------------

/**
 * How an entity came to be touched by a row. It decides which selectors see it:
 * `--entity` is exact ids — the entity's own rows, edges on it, its PR/commit
 * facts and notifications about it — while `--anchor` and `--subtree` also roll
 * up the messages anchored to it.
 */
type Via = 'self' | 'edge' | 'message' | 'git' | 'notified';

interface Attribution {
  entityId: string;
  via: Via;
  /** A change class, or null when the row only contributes an actor / a created marker. */
  change: string | null;
  actor: string | null;
}

/** Activity verbs that report a status transition rather than a content edit. */
const STATUS_VERBS: ReadonlySet<string> = new Set(['work.changed', 'completed', 'pulled', 'unblocked', 'restored']);

const CHAT_KINDS: ReadonlySet<string> = new Set(['channel', 'chat', 'work_session']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The fields of one examined row the digest needs — raw payload plus its readable projection. */
export interface ExaminedRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  /** The mapper's projection, or null when the caller cannot read the row. */
  event: DurableWorkspaceEvent | null;
}

interface AttributionContext {
  /** PR/commit entity id → the tasks that `tracks` it. */
  trackedBy: Map<string, string[]>;
  /** The caller's member / team-member ids — whose notifications count. */
  callerIds: ReadonlySet<string>;
}

function displayName(actor: unknown): string | null {
  if (actor === null || typeof actor !== 'object') return null;
  return str((actor as { displayName?: unknown }).displayName);
}

/**
 * The (entity, change) pairs a READABLE row produces. Dropped outright (§3.2):
 * `entity.activity_touched`, `counter.changed`, notifications to anyone else,
 * and anything about a message entity itself — a message rolls up under its
 * anchor instead.
 */
export function attribute(row: ExaminedRow, ctx: AttributionContext): Attribution[] {
  const e = row.event as unknown as Record<string, unknown> | null;
  if (e === null) return [];
  const p = row.payload;
  switch (row.type) {
    case 'entity.upsert':
    case 'entity.deleted': {
      const entity = e['entity'] as EntitySummary;
      if (entity.kind === 'message') return [];
      // The class of an upsert is decided per entity once all its spine rows
      // are known (`spineChanges`); here it only marks the entity touched.
      return [{ entityId: entity.id, via: 'self', change: row.type === 'entity.deleted' ? 'deleted' : null, actor: null }];
    }
    case 'edge.upsert':
    case 'edge.deleted': {
      const edge = e['edge'] as { type: string; source: EntitySummary; target: EntitySummary; createdBy: unknown };
      const sign = row.type === 'edge.upsert' ? '+' : '-';
      const actor = displayName(edge.createdBy);
      // An edge on a message (`anchored_to`, `authored_from`, …) is how the
      // message was recorded, and the message already rolls up under its
      // anchor as `message`. Reporting it again as an edge on every post
      // would bury the line in bookkeeping.
      if (edge.source.kind === 'message' || edge.target.kind === 'message') return [];
      if (edge.type === 'assigned_to') {
        return [
          {
            entityId: edge.source.id, via: 'edge', actor,
            change: `${sign === '+' ? 'assigned' : 'unassigned'}:${edge.target.title}`,
          },
          { entityId: edge.target.id, via: 'edge', actor, change: `edge${sign}:${edge.type}` },
        ];
      }
      return [edge.source, edge.target].map((end) => ({
        entityId: end.id, via: 'edge' as const, actor, change: `edge${sign}:${edge.type}`,
      }));
    }
    case 'message.created': {
      const anchorId = str(e['anchorId']);
      if (anchorId === null) return [];
      const message = e['message'] as { state: { author?: unknown } };
      return [{ entityId: anchorId, via: 'message', change: 'message', actor: displayName(message.state.author) }];
    }
    case 'activity.created': {
      const activity = e['activity'] as { entityId: string | null; actor: unknown; verb: string };
      if (activity.entityId === null) return [];
      return [{
        entityId: activity.entityId,
        via: 'self',
        change: activity.verb === 'created' ? 'created' : null,
        actor: displayName(activity.actor),
      }];
    }
    case 'notification.created': {
      const recipient = str(p['recipient_team_member_id']) ?? str(p['recipient_member_id']);
      const target = str(p['target_entity_id']);
      if (recipient === null || target === null || !ctx.callerIds.has(recipient)) return [];
      return [{ entityId: target, via: 'notified', change: 'notified', actor: displayName((e['notification'] as { actor?: unknown }).actor) }];
    }
    case 'git.pr_state_changed':
    case 'git.commit_recorded': {
      const factId = str(row.type === 'git.pr_state_changed' ? p['prEntityId'] : p['commitEntityId']);
      if (factId === null) return [];
      const change = row.type === 'git.pr_state_changed' ? 'pr' : 'commit';
      // Git facts name ONLY the PR/commit entity. Its task is found through the
      // task's `tracks` edge, resolved at request time.
      return [factId, ...(ctx.trackedBy.get(factId) ?? [])].map((entityId) => ({
        entityId, via: 'git' as const, change, actor: null,
      }));
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Per-entity accumulation
// ---------------------------------------------------------------------------

interface SpineRow {
  seq: number;
  /** The row's transaction time: rows one transaction wrote share it. */
  at: string;
  version: number | null;
  category: string | null;
  deleted: boolean;
}

interface MessageRef {
  seq: number;
  id: string;
  author: string | null;
  replyTo: string | null;
  body: string;
  mentions: string[];
}

export interface Accumulator {
  id: string;
  kind: string | null;
  firstSeq: number;
  lastSeq: number;
  firstAt: string;
  changes: string[];
  actors: string[];
  spine: SpineRow[];
  statusVerb: boolean;
  created: boolean;
  messages: MessageRef[];
}

function pushUnique(list: string[], value: string | null): void {
  if (value !== null && !list.includes(value)) list.push(value);
}

/** Does this attribution reach the requested scope? `null` scope = space-wide. */
export interface ResolvedScope {
  entity: ReadonlySet<string>;
  anchorLike: ReadonlySet<string>;
}

function inScope(a: Attribution, scope: ResolvedScope | null): boolean {
  if (scope === null) return true;
  if (scope.anchorLike.has(a.entityId)) return true;
  return scope.entity.has(a.entityId) && a.via !== 'message';
}

/**
 * Fold the examined rows into one accumulator per in-scope entity. Pure: the
 * differential oracle suite drives the same function the handler does only
 * through its inputs, never its internals.
 */
export function accumulate(
  rows: readonly ExaminedRow[],
  ctx: AttributionContext,
  scope: ResolvedScope | null,
): Map<string, Accumulator> {
  const acc = new Map<string, Accumulator>();
  const get = (id: string, row: ExaminedRow): Accumulator => {
    let a = acc.get(id);
    if (a === undefined) {
      a = {
        id, kind: null, firstSeq: row.seq, lastSeq: row.seq, firstAt: row.occurredAt,
        changes: [], actors: [], spine: [], statusVerb: false, created: false, messages: [],
      };
      acc.set(id, a);
    }
    a.lastSeq = row.seq;
    return a;
  };

  for (const row of rows) {
    for (const at of attribute(row, ctx)) {
      if (!inScope(at, scope)) continue;
      const a = get(at.entityId, row);
      pushUnique(a.actors, at.actor);
      if (row.type === 'entity.upsert' || row.type === 'entity.deleted') {
        const entity = (row.event as unknown as { entity: EntitySummary }).entity;
        a.kind = entity.kind;
        a.spine.push({
          seq: row.seq,
          at: row.occurredAt,
          version: num(row.payload['version']),
          category: str(row.payload['status_category']),
          deleted: row.type === 'entity.deleted',
        });
      }
      if (row.type === 'activity.created') {
        const verb = (row.event as unknown as { activity: { verb: string } }).activity.verb;
        if (STATUS_VERBS.has(verb)) a.statusVerb = true;
        if (verb === 'created') a.created = true;
        continue;
      }
      if (at.change === 'message') {
        const m = (row.event as unknown as {
          message: { id: string; state: { author?: unknown; rootMessageId?: string | null };
            content: { body: string; mentions: Array<{ entityId: string }> } };
        }).message;
        a.messages.push({
          seq: row.seq,
          id: m.id,
          author: displayName(m.state.author),
          replyTo: m.state.rootMessageId ?? null,
          body: m.content.body,
          mentions: m.content.mentions.map((x) => x.entityId),
        });
      }
      if (at.change !== null && at.change !== 'deleted') pushUnique(a.changes, at.change);
      if (at.change === 'deleted') pushUnique(a.changes, 'deleted');
    }
  }

  for (const a of acc.values()) {
    const spine = spineChanges(a);
    // Spine classes lead: created / status / updated read first on the line.
    a.changes = [...spine, ...a.changes.filter((c) => !spine.includes(c))];
  }
  return acc;
}

/**
 * The classes an entity's own spine rows imply (§3.2): `created`, `updated`,
 * `status:<from>→<to>` / `status:<to>`. A spine row carries the entity's
 * version and status_category but not its predecessor, so `from` is named only
 * when both rows are in the window — never looked up.
 */
export function spineChanges(a: Accumulator): string[] {
  const out: string[] = [];
  const rows = a.spine.filter((r) => !r.deleted);
  if (a.created || rows[0]?.version === 1) out.push('created');
  let statusSeen = false;
  const bumps: string[] = [];
  const statusTx = new Set<string>();
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    if (prev === undefined) {
      if (row.version === 1) return;
      // A status move writes the spine row (status only, version unchanged)
      // and, in the same transaction, the detail snapshot's version bump. A
      // content edit writes only the bump. So a first row followed in its own
      // transaction by `version + 1` moved status — read from the window, not
      // looked up. Its `from` is outside the window and is not named.
      const next = rows[1];
      const sameTxBump = next !== undefined && next.at === row.at
        && row.version !== null && next.version === row.version + 1;
      if ((a.statusVerb || sameTxBump) && row.category !== null) {
        out.push(`status:${row.category}`);
        statusSeen = true;
        statusTx.add(row.at);
      } else {
        bumps.push(row.at);
      }
      return;
    }
    if (prev.category !== row.category && row.category !== null) {
      out.push(prev.category === null ? `status:${row.category}` : `status:${prev.category}→${row.category}`);
      statusSeen = true;
      statusTx.add(row.at);
    } else if (row.version !== prev.version) {
      // The version bumps that CREATING an entity writes (detail rows inserted
      // in the same transaction) are part of `created`, not an edit.
      const createdTx = out[0] === 'created' && rows[0]!.at === row.at;
      if (!createdTx) bumps.push(row.at);
    }
  });
  if (!statusSeen && a.statusVerb && rows.length === 0) {
    // A status activity with no spine row in the window — the move is real, its
    // target unknown here. Reported without a guessed value.
    out.push('status');
  }
  // A bump written in the same transaction as a status move is that move's
  // own snapshot (the status lives in a detail row), not a separate edit.
  if (bumps.some((at) => !statusTx.has(at))) out.push('updated');
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Assembly — groups, caps, `through`
// ---------------------------------------------------------------------------

/** One entity ready to emit, with the two message-count spellings resolved later. */
export interface ReadyEntry {
  firstSeq: number;
  entry: EventChangeEntry;
  /** Exact count of new messages examined; spelled `messagesTotal` or `messagesTotalAtLeast`. */
  messagesCount?: number;
}

export interface AssembleInput {
  req: ChangesRequest;
  since: number;
  gap: EventChangesGap | null;
  unresolved: string[];
  /** Sorted by (firstSeq, id). */
  entries: ReadyEntry[];
  /** The last seq examined, and whether the examine cap stopped the scan there. */
  examinedThrough: number;
  examineCapHit: boolean;
  maxEntities?: number;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function finalEntry(r: ReadyEntry, more: boolean): EventChangeEntry {
  if (r.messagesCount === undefined) return r.entry;
  const { messagesTotal: _t, messagesTotalAtLeast: _l, ...rest } = r.entry;
  return more ? { ...rest, messagesTotalAtLeast: r.messagesCount } : { ...rest, messagesTotal: r.messagesCount };
}

function view(input: AssembleInput, emitted: ReadyEntry[], through: number, more: boolean): EventChangesView {
  const changed = emitted.map((r) => finalEntry(r, more));
  const quiet = changed.length === 0 && !more && input.gap === null;
  const out: EventChangesView = {
    ...(quiet ? {} : { scope: scopeOf(input.req) }),
    since: input.since,
    through,
    more,
    gap: input.gap,
    unresolved: input.unresolved,
    changed,
  };
  if (!quiet) out.next = nextCommand(input.req, through);
  return out;
}

/**
 * Emit whole groups in ascending first-changed seq until a cap would be crossed.
 *
 * The byte check measures the page with `more:true` and the largest `through`
 * it could carry — the worst case of every field that is decided only after the
 * stop — so the final page can never be larger than the page that was measured.
 */
export function assembleDigest(input: AssembleInput): EventChangesView {
  const maxEntities = input.maxEntities ?? EVENT_CHANGES_MAX_ENTITIES;
  const groups: ReadyEntry[][] = [];
  for (const r of input.entries) {
    const last = groups.at(-1);
    if (last !== undefined && last[0]!.firstSeq === r.firstSeq) last.push(r);
    else groups.push([r]);
  }

  const emitted: ReadyEntry[] = [];
  let stopAt: number | null = null;
  for (const group of groups) {
    if (emitted.length + group.length > maxEntities) {
      stopAt = group[0]!.firstSeq;
      break;
    }
    const size = byteLength(view(input, [...emitted, ...group], input.examinedThrough, true));
    if (size > input.req.totalBytes) {
      if (emitted.length === 0) {
        // The floor is sized so this cannot happen (§3.3). If it ever does, the
        // honest answer is a refusal: never over budget, never a stalled
        // cursor, never a skipped group.
        throw new CollabError(
          'payload_too_large',
          `the first change group (seq ${String(group[0]!.firstSeq)}, ${String(group.length)} entities) needs ` +
            `${String(size)} bytes, over the ${String(input.req.totalBytes)}-byte budget`,
          {
            details: {
              reason: 'digest_group_too_large',
              seq: group[0]!.firstSeq,
              bytes: size,
              hint: `retry with a larger --total-bytes (max ${String(EVENT_CHANGES_MAX_TOTAL_BYTES)}), or --events`,
            },
            retryable: false,
          },
        );
      }
      stopAt = group[0]!.firstSeq;
      break;
    }
    emitted.push(...group);
  }

  const through = stopAt === null ? input.examinedThrough : Math.min(stopAt - 1, input.examinedThrough);
  const more = input.examineCapHit || stopAt !== null;
  return view(input, emitted, through, more);
}

/**
 * `--events`: thin rows, stopped at an EVENT boundary (§3.5). On a byte or
 * entity stop `through` is the last emitted seq.
 */
export function assembleThin(
  input: Omit<AssembleInput, 'entries'> & { rows: Array<{ row: EventChangeThinRow; entities: string[] }> },
): EventChangesView {
  const maxEntities = input.maxEntities ?? EVENT_CHANGES_MAX_ENTITIES;
  const events: EventChangeThinRow[] = [];
  const seen = new Set<string>();
  let stopped = false;
  const shape = (through: number, more: boolean, list: EventChangeThinRow[]): EventChangesView => {
    const quiet = list.length === 0 && !more && input.gap === null;
    return {
      ...(quiet ? {} : { scope: scopeOf(input.req) }),
      since: input.since, through, more, gap: input.gap, unresolved: input.unresolved, events: list,
      ...(quiet ? {} : { next: nextCommand(input.req, through) }),
    };
  };
  for (const { row, entities } of input.rows) {
    const fresh = entities.filter((id) => !seen.has(id));
    if (seen.size + fresh.length > maxEntities
      || byteLength(shape(input.examinedThrough, true, [...events, row])) > input.req.totalBytes) {
      if (events.length === 0) {
        throw new CollabError('payload_too_large', `event seq ${String(row.seq)} does not fit the byte budget`, {
          details: { reason: 'digest_group_too_large', seq: row.seq, hint: 'retry with a larger --total-bytes' },
          retryable: false,
        });
      }
      stopped = true;
      break;
    }
    for (const id of fresh) seen.add(id);
    events.push(row);
  }
  const through = stopped ? events.at(-1)!.seq : input.examinedThrough;
  return shape(through, input.examineCapHit || stopped, events);
}

/** The thin row for one examined, readable row. */
export function thinRow(row: ExaminedRow, attributions: Attribution[]): EventChangeThinRow {
  const e = row.event as unknown as Record<string, unknown>;
  const p = row.payload;
  const base = { seq: row.seq, type: row.type };
  switch (row.type) {
    case 'entity.upsert':
    case 'entity.deleted': {
      const entity = e['entity'] as EntitySummary;
      const v = num(p['version']);
      const status = str(p['status_category']);
      return { ...base, id: entity.id, kind: entity.kind, ...(v === null ? {} : { v }), ...(status === null ? {} : { status }) };
    }
    case 'edge.upsert':
    case 'edge.deleted': {
      const edge = e['edge'] as { id: string; type: string; source: EntitySummary; target: EntitySummary; createdBy: unknown };
      return { ...base, id: edge.id, edge: edge.type, src: edge.source.id, dst: edge.target.id, actor: displayName(edge.createdBy) };
    }
    case 'message.created': {
      const m = e['message'] as { id: string; state: { author?: unknown } };
      return { ...base, id: m.id, anchor: String(e['anchorId']), actor: displayName(m.state.author) };
    }
    case 'activity.created': {
      const a = e['activity'] as { id: string; entityId: string | null; verb: string; actor: unknown };
      return { ...base, id: a.id, ...(a.entityId === null ? {} : { entity: a.entityId }), verb: a.verb, actor: displayName(a.actor) };
    }
    case 'notification.created': {
      const n = e['notification'] as { id: string; actor?: unknown };
      return { ...base, id: n.id, entity: String(p['target_entity_id']), actor: displayName(n.actor) };
    }
    default: {
      const id = str(p['prEntityId']) ?? str(p['commitEntityId']) ?? attributions[0]?.entityId ?? '';
      return { ...base, id, ...(attributions.length > 1 ? { entity: attributions[1]!.entityId } : {}) };
    }
  }
}

// ---------------------------------------------------------------------------
// The Postgres read
// ---------------------------------------------------------------------------

export interface ChangeFeedOptions {
  projector?: EntityProjector;
  onSkip?: (message: string) => void;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class PgChangeFeed {
  private readonly db: Db;
  private readonly mapper: WorkspaceEventMapper;
  private readonly projector: EntityProjector;
  private readonly onSkip: ((message: string) => void) | undefined;

  constructor(db: Db, opts: ChangeFeedOptions = {}) {
    this.db = db;
    this.projector = opts.projector ?? new PgEntityProjector();
    this.mapper = new WorkspaceEventMapper(this.projector);
    this.onSkip = opts.onSkip;
  }

  async read(spaceId: string, req: ChangesRequest, claims: DbClaims): Promise<EventChangesView> {
    const scoped = req.entity.length + req.anchor.length + req.subtree.length > 0;

    // Retention first: a cursor below the oldest retained row reads from that
    // row, and says so (`gap`), rather than returning the oldest page as if it
    // followed the caller's cursor. Read as the connection role, not tm8_app:
    // the oldest row may be one addressed to another member, and the bound is
    // a seq number, not content.
    const bounds = await this.db.tx(claims, (q) =>
      q.query<{ oldest: string | null; head: string | null }>(
        'select min(seq)::text oldest, max(seq)::text head from public.workspace_events where space_id = $1',
        [spaceId],
      ),
    );
    const oldest = bounds[0]?.oldest == null ? null : Number(bounds[0].oldest);
    const head = bounds[0]?.head == null ? req.after : Math.max(Number(bounds[0].head), req.after);
    const gap: EventChangesGap | null =
      oldest !== null && req.after < oldest - 1 ? { after: req.after, oldestRetained: oldest } : null;
    const from = gap === null ? req.after : gap.oldestRetained - 1;

    // One query path, gated: a window below the backfill watermark is refused.
    if (scoped) await gateSubjectIndex(this.db, claims, spaceId, from);

    return this.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const caller = await q.query<{ member: string | null; actor: string | null }>(
        `select internal.current_member_id($1)::text member, nullif(current_setting('tm8.actor_id', true), '') actor`,
        [spaceId],
      );
      const callerIds = new Set([caller[0]?.member, caller[0]?.actor].filter((v): v is string => typeof v === 'string'));

      const resolved = scoped ? await resolveScope(q, req) : null;

      const rows = await q.query<WorkspaceEventRow>(
        resolved === null
          ? `select ${WORKSPACE_EVENT_COLUMNS} from public.workspace_events
              where space_id = $1 and seq > $2 and seq <= $3
              order by seq asc limit $4`
          : `select ${WORKSPACE_EVENT_COLUMNS} from public.workspace_events
              where space_id = $1 and seq > $2 and seq <= $3 and subject_ids && $5::uuid[]
              order by seq asc limit $4`,
        resolved === null
          ? [spaceId, from, head, EVENT_CHANGES_MAX_EXAMINED]
          : [spaceId, from, head, EVENT_CHANGES_MAX_EXAMINED, resolved.queryIds],
      );
      const examineCapHit = rows.length === EVENT_CHANGES_MAX_EXAMINED;
      const examinedThrough = examineCapHit ? Number(rows.at(-1)!.seq) : head;

      const mapped = await this.mapper.mapRows(q, rows, (err) => this.onSkip?.(err.message));
      const bySeq = new Map(mapped.map((ev) => [ev.seq, ev]));
      const examined: ExaminedRow[] = rows.map((r) => ({
        seq: Number(r.seq),
        type: r.event_type,
        payload: r.payload,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
        event: bySeq.get(Number(r.seq)) ?? null,
      }));

      const ctx: AttributionContext = { trackedBy: await trackedBy(q, examined), callerIds };
      const scope = resolved === null ? null : resolved.scope;
      const unresolved = resolved === null ? [] : resolved.unresolved;

      if (req.events) {
        const thin: Array<{ row: EventChangeThinRow; entities: string[] }> = [];
        const kindOf = await kindsOf(q, examined, ctx, scope);
        for (const row of examined) {
          const ats = attribute(row, ctx).filter((a) => inScope(a, scope))
            .filter((a) => req.kind.length === 0 || req.kind.includes(kindOf.get(a.entityId) ?? ''))
            .filter((a) => req.change.length === 0
              || (a.change !== null && req.change.some((f) => changeMatches(a.change!, f))));
          if (ats.length === 0) continue;
          thin.push({ row: thinRow(row, ats), entities: [...new Set(ats.map((a) => a.entityId))] });
        }
        return assembleThin({
          req, since: req.after, gap, unresolved, rows: thin, examinedThrough, examineCapHit,
        });
      }

      const acc = accumulate(examined, ctx, scope);
      const hardDeleted = scoped ? hardDeletedNamed(examined, resolved!) : [];
      const entries = await this.ready(q, acc, req, callerIds);
      for (const d of hardDeleted) {
        if (req.kind.length > 0 && !req.kind.includes(d.entry.kind)) continue;
        if (req.change.length > 0 && !req.change.some((f) => changeMatches('deleted', f))) continue;
        entries.push(d);
      }
      entries.sort((a, b) => a.firstSeq - b.firstSeq || a.entry.id.localeCompare(b.entry.id));

      // An id named but unreadable is `unresolved` — unless it was reported as
      // hard-deleted from a row the caller could read.
      const reported = new Set(hardDeleted.map((d) => d.entry.id));
      const stillUnresolved = unresolved.filter((id) => !reported.has(id));
      if (resolved !== null && resolved.named.length > 0 && stillUnresolved.length === resolved.named.length) {
        throw new CollabError('not_found', `no readable entity among ${resolved.named.join(', ')}`);
      }

      return assembleDigest({
        req, since: req.after, gap, unresolved: stillUnresolved, entries, examinedThrough, examineCapHit,
      });
    });
  }

  /** Narrow, hydrate current state, attach messages. Entities no longer readable are dropped. */
  private async ready(
    q: Querier,
    acc: Map<string, Accumulator>,
    req: ChangesRequest,
    callerIds: ReadonlySet<string>,
  ): Promise<ReadyEntry[]> {
    const candidates = [...acc.values()].filter((a) => a.changes.length > 0);
    if (candidates.length === 0) return [];
    const summaries = await this.projector.entitySummaries(q, candidates.map((a) => a.id));

    // Work sessions that ENDED inside the window — a crashed worker must be
    // visible, and its ending is not always a spine status move (174).
    const sessionIds = candidates.filter((a) => summaries.get(a.id)?.kind === 'work_session').map((a) => a.id);
    const ended = new Map<string, string>();
    if (sessionIds.length > 0) {
      const rows = await q.query<{ entity_id: string; ended_at: Date | string | null }>(
        `select entity_id::text entity_id, coalesce(exited_at, status_changed_at) ended_at
           from public.work_sessions where entity_id = any($1::uuid[])`,
        [sessionIds],
      );
      for (const r of rows) if (r.ended_at !== null) ended.set(r.entity_id, new Date(r.ended_at).toISOString());
    }

    const out: ReadyEntry[] = [];
    const needCursor: Array<{ entry: EventChangeEntry; anchorKind: string; lastShown: string }> = [];
    for (const a of candidates) {
      const s = summaries.get(a.id);
      // Gone or unreadable now: omitted (a NAMED hard delete is reported
      // separately). A message never stands alone — it rolls up under its anchor.
      if (s === undefined || s.kind === 'message') continue;
      let changes = a.changes;
      const state = s.state as { kind: string; status?: string; endedKind?: string | null; endedReason?: string | null };
      if (s.kind === 'work_session' && (state.status === 'exited' || state.status === 'failed')) {
        const at = ended.get(a.id);
        if (at !== undefined && at >= a.firstAt) {
          const reason = state.endedReason ? `: ${truncate(state.endedReason, EVENT_CHANGES_TITLE_CHARS)}` : '';
          const label = `status:running→${state.status}(${state.endedKind ?? 'unknown'}${reason})`;
          changes = [label, ...changes.filter((c) => c !== 'updated' && !c.startsWith('status'))];
        }
      }
      if (req.kind.length > 0 && !req.kind.includes(s.kind)) continue;
      if (req.change.length > 0 && !changes.some((c) => req.change.some((f) => changeMatches(c, f)))) continue;

      const entry: EventChangeEntry = {
        id: s.id,
        kind: s.kind,
        title: truncate(s.title, EVENT_CHANGES_TITLE_CHARS),
        parentId: s.parentId,
        v: s.version,
        ...(typeof state.status === 'string' && (s.kind === 'task' || s.kind === 'work_session')
          ? { status: state.status }
          : {}),
        lastSeq: a.lastSeq,
        changes,
        actors: a.actors,
      };
      let messagesCount: number | undefined;
      if (a.messages.length > 0) {
        const cap = CHAT_KINDS.has(s.kind) ? EVENT_CHANGES_CHAT_MESSAGE_CAP : EVENT_CHANGES_MESSAGE_CAP;
        const newest = [...a.messages].sort((x, y) => y.seq - x.seq);
        const shown = newest.slice(0, cap);
        entry.messages = shown.map((m): EventChangeMessage => {
          const excerpt = plainExcerpt(m.body, EVENT_CHANGES_EXCERPT_CHARS);
          return {
            id: m.id,
            author: m.author,
            replyTo: m.replyTo,
            toMe: m.mentions.some((id) => callerIds.has(id)),
            excerpt,
            truncated: excerpt !== plainExcerpt(m.body, Number.MAX_SAFE_INTEGER),
          };
        });
        messagesCount = a.messages.length;
        entry.messagesTotal = messagesCount;
        if (newest.length > cap) {
          entry.messagesMore = true;
          needCursor.push({ entry, anchorKind: s.kind, lastShown: shown.at(-1)!.id });
        }
      }
      out.push({ firstSeq: a.firstSeq, entry, ...(messagesCount === undefined ? {} : { messagesCount }) });
    }

    if (needCursor.length > 0) {
      const rows = await q.query<{ entity_id: string; c: string }>(
        `select entity_id, ${MICROS('created_at')} c from public.messages where entity_id = any($1::uuid[])`,
        [needCursor.map((n) => n.lastShown)],
      );
      const at = new Map(rows.map((r) => [r.entity_id, r.c]));
      for (const n of needCursor) {
        const c = at.get(n.lastShown);
        n.entry.messagesNext = c === undefined
          ? `tm8 entity feed ${n.entry.id} --order newest`
          : `tm8 entity feed ${n.entry.id} --order newest --cursor ${newestFeedCursorAfter(n.entry.id, n.anchorKind, c, n.lastShown)}`;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

interface Resolution {
  scope: ResolvedScope;
  /** Every id the scan must match — scope ids plus the PR/commit ids their tasks track. */
  queryIds: string[];
  named: string[];
  unresolved: string[];
}

/**
 * Resolve the selectors AT REQUEST TIME, under the caller's claims: a child
 * created inside the window is in the subtree, and nothing the caller cannot
 * read is. Refused, never truncated, past `EVENT_CHANGES_MAX_SCOPE_IDS`.
 */
export async function resolveScope(q: Querier, req: ChangesRequest): Promise<Resolution> {
  const named = [...new Set([...req.entity, ...req.anchor, ...req.subtree])];
  const visible = new Set(
    (await q.query<{ id: string }>('select id::text id from public.entities where id = any($1::uuid[])', [named]))
      .map((r) => r.id),
  );
  const unresolved = named.filter((id) => !visible.has(id));

  const entity = new Set(req.entity.filter((id) => visible.has(id)));
  const anchorLike = new Set(req.anchor.filter((id) => visible.has(id)));
  const roots = req.subtree.filter((id) => visible.has(id));
  if (roots.length > 0) {
    const limit = EVENT_CHANGES_MAX_SCOPE_IDS + 1;
    const tree = await q.query<{ id: string }>(
      `with recursive tree(id) as (
         select id from public.entities where id = any($1::uuid[])
         union
         select e.id from public.entities e join tree t on e.parent_id = t.id
       )
       select id::text id from tree
       union
       select ed.src_id::text from public.edges ed
         join public.entities s on s.id = ed.src_id and s.kind = 'work_session'
        where ed.type = 'working_on' and ed.dst_id in (select id from tree)
       limit ${String(limit)}`,
      [roots],
    );
    for (const r of tree) anchorLike.add(r.id);
  }

  const scopeIds = new Set([...entity, ...anchorLike]);
  tooLarge(scopeIds.size);
  // PR and commit facts name only themselves: add the ids the in-scope tasks
  // track so their git events are examined, and are attributed to the task.
  const tracked = scopeIds.size === 0 ? [] : await q.query<{ id: string }>(
    `select ed.dst_id::text id from public.edges ed
       join public.entities d on d.id = ed.dst_id and d.kind in ('pull_request', 'commit')
      where ed.type = 'tracks' and ed.src_id = any($1::uuid[])`,
    [[...scopeIds]],
  );
  const queryIds = new Set([...scopeIds, ...tracked.map((r) => r.id), ...named]);
  tooLarge(queryIds.size);
  return { scope: { entity, anchorLike }, queryIds: [...queryIds], named, unresolved };
}

function tooLarge(n: number): void {
  if (n <= EVENT_CHANGES_MAX_SCOPE_IDS) return;
  throw new CollabError(
    'invalid_input',
    `the scope resolves to more than ${String(EVENT_CHANGES_MAX_SCOPE_IDS)} entity ids`,
    {
      details: {
        reason: 'scope_too_large',
        limit: EVENT_CHANGES_MAX_SCOPE_IDS,
        hint: 'narrow the scope: name a smaller --subtree, or several --anchor/--entity ids',
      },
      retryable: false,
    },
  );
}

/** PR/commit id → the tasks tracking it, for every git fact in the window. */
async function trackedBy(q: Querier, rows: readonly ExaminedRow[]): Promise<Map<string, string[]>> {
  const facts = [...new Set(rows
    .filter((r) => r.event !== null && (r.type === 'git.pr_state_changed' || r.type === 'git.commit_recorded'))
    .map((r) => str(r.payload['prEntityId']) ?? str(r.payload['commitEntityId']))
    .filter((v): v is string => v !== null))];
  const out = new Map<string, string[]>();
  if (facts.length === 0) return out;
  const edges = await q.query<{ src: string; dst: string }>(
    `select src_id::text src, dst_id::text dst from public.edges where type = 'tracks' and dst_id = any($1::uuid[])`,
    [facts],
  );
  for (const e of edges) out.set(e.dst, [...(out.get(e.dst) ?? []), e.src]);
  return out;
}

/** The kind of every entity a thin row may be attributed to (for `--kind`). */
async function kindsOf(
  q: Querier,
  rows: readonly ExaminedRow[],
  ctx: AttributionContext,
  scope: ResolvedScope | null,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => attribute(r, ctx).filter((a) => inScope(a, scope)).map((a) => a.entityId)))];
  if (ids.length === 0) return new Map();
  const found = await q.query<{ id: string; kind: string }>(
    'select id::text id, kind from public.entities where id = any($1::uuid[])',
    [ids],
  );
  return new Map(found.map((r) => [r.id, r.kind]));
}

/**
 * A NAMED id that is gone (hard-deleted) is reported as `deleted` from its
 * captured `entity.deleted` row — which the caller could read, because the scan
 * returned it under event RLS. Unnamed ids that no longer resolve are omitted.
 */
function hardDeletedNamed(rows: readonly ExaminedRow[], resolved: Resolution): ReadyEntry[] {
  const out = new Map<string, ReadyEntry>();
  const unresolved = new Set(resolved.unresolved);
  for (const row of rows) {
    if (row.type !== 'entity.deleted' || row.event !== null) continue;
    const id = str(row.payload['id']);
    if (id === null || !unresolved.has(id)) continue;
    const prior = out.get(id);
    out.set(id, {
      firstSeq: prior?.firstSeq ?? row.seq,
      entry: {
        id,
        kind: str(row.payload['kind']) ?? 'unknown',
        title: null,
        parentId: str(row.payload['parent_id']),
        v: null,
        lastSeq: row.seq,
        changes: ['deleted'],
        actors: [],
      },
    });
  }
  return [...out.values()];
}

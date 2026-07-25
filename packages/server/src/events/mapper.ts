/**
 * The event mapper — `workspace_events` rows → contract `WorkspaceEvent`s.
 *
 * ## The one source of events
 *
 * Every mutation is captured into `workspace_events` by the trigger in
 * db/migrations/003, inside the mutating transaction, with a per-space monotonic
 * `seq` from `internal.next_event_seq`. That log is THE event stream. This file
 * projects it; it does not add to it. Concretely, that means:
 *
 * - `seq`, `occurredAt`, `schemaVersion` and `clientMutationId` are read off the
 *   row. They are facts, not decisions. Nothing here computes a seq.
 * - There is no code path from a handler to an event. A handler that wants an
 *   event emits it by MUTATING, and the trigger does the rest. If a mutation
 *   produces no event, the bug is in the trigger's table coverage, not here.
 *
 * The trigger stores `to_jsonb(row)` — the raw table row — because assembling
 * derived truth in a trigger would put it in a second place (L3). So the row's
 * `payload` is a raw record and this mapper's job is to turn it into the
 * contract's rich shape, hydrating entities through the `EntityProjector` seam.
 *
 * ## Every event goes through the tripwire
 *
 * `assertWorkspaceEvent` runs on every projection, unconditionally. This is the
 * check that catches an off-contract projection server-side, in our own stack,
 * rather than as a variant the UI silently ignores. If it fires, the mapper is
 * wrong — not the tripwire.
 */
import type {
  ActivityItem,
  DurableWorkspaceEvent,
  EdgeView,
  EntitySummary,
  MessageView,
  NotificationItem,
  WorkspaceEvent,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';
import { assertWorkspaceEvent } from './emitter.js';
import type { EntityProjector } from './projector.js';

/**
 * A row of `public.workspace_events`, exactly as node-postgres returns it.
 *
 * `seq` is typed `string | number` because it is a `bigint` in the DDL and
 * node-postgres returns bigints as STRINGS to avoid silent precision loss. This
 * is the single most likely place for a subtle bug in this file: `'10' < '9'` is
 * true for strings, so a seq left as a string would sort and compare wrongly
 * while looking fine in a log line. It is converted exactly once, in `mapRow`.
 */
export interface WorkspaceEventRow {
  id: string;
  space_id: string;
  seq: string | number;
  event_type: string;
  payload: Record<string, unknown>;
  client_mutation_id: string | null;
  recipient_member_id: string | null;
  occurred_at: Date | string;
  schema_version: number;
}

/** The columns `mapRows` needs, in the order the poll query selects them. */
export const WORKSPACE_EVENT_COLUMNS =
  'id, space_id, seq, event_type, payload, client_mutation_id, recipient_member_id, occurred_at, schema_version';

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Normalize a captured timestamp to an ISO-8601 **UTC** string.
 *
 * The re-parse is not defensive noise — it is required. Timestamps inside a
 * captured `payload` went through `to_jsonb(row)`, which renders a `timestamptz`
 * in the SESSION's time zone with an offset: `2026-07-25T14:53:52.583962+05:30`.
 * The contract's schemas require UTC (`…Z`), so passing the payload string
 * through unchanged fails the tripwire — which is exactly how this was found.
 * Columns read directly by the driver arrive as `Date` and are already fine;
 * both paths are funnelled through here so neither can regress.
 */
function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || v === '') return null;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * A projection that could not be completed, with the reason.
 *
 * Distinct from `OffContractEventError`: that means "we built something invalid"
 * (a bug in this file). This means "the row referenced an entity we cannot see
 * or that no longer exists" (a legitimate runtime condition — see
 * `mapRows`'s skip policy).
 */
export class UnprojectableEventError extends Error {
  readonly seq: number;

  constructor(seq: number, message: string) {
    super(message);
    this.name = 'UnprojectableEventError';
    this.seq = seq;
  }
}

/** Which entity ids a row's projection will need hydrated. */
function referencedEntityIds(row: WorkspaceEventRow): string[] {
  const p = row.payload;
  switch (row.event_type) {
    case 'entity.upsert':
    case 'entity.deleted':
      return [str(p['id'])].filter((v): v is string => v !== null);
    case 'edge.upsert':
    case 'edge.deleted':
      return [str(p['src_id']), str(p['dst_id'])].filter((v): v is string => v !== null);
    case 'message.created':
    case 'message.updated':
    case 'message.deleted':
      return [str(p['entity_id']), str(p['anchor_id'])].filter((v): v is string => v !== null);
    case 'counter.changed':
      return [];
    case 'activity.created':
      return [];
    case 'notification.created':
    case 'notification.read':
      return [str(p['target_entity_id']), str(p['actor_id'])].filter((v): v is string => v !== null);
    default:
      return [];
  }
}

export class WorkspaceEventMapper {
  private readonly projector: EntityProjector;

  constructor(projector: EntityProjector) {
    this.projector = projector;
  }

  /**
   * Project a page of rows, hydrating every entity they reference in ONE batch.
   *
   * Rows that cannot be projected are SKIPPED rather than failing the page.
   * That policy needs justifying, because silently dropping events is normally
   * exactly the data-loss bug this lane exists to prevent. Two things make it
   * correct here:
   *
   * - The reason a row is unprojectable is that an entity it names is gone or is
   *   invisible to this caller under RLS. In the invisible case, dropping it is
   *   not data loss — it is the access-control outcome, and returning it would
   *   be the bug.
   * - `seq` continuity is not a promise the contract makes. AM-2 §3 says gaps
   *   are allowed and ORDER is authoritative, precisely so that a filtered feed
   *   stays correct. The cursor still advances past skipped rows, so a client
   *   never re-fetches them forever.
   *
   * What would be a real bug is skipping SILENTLY, so every skip is reported
   * through `onSkip` for the caller to log.
   */
  async mapRows(
    q: Querier,
    rows: readonly WorkspaceEventRow[],
    onSkip?: (err: UnprojectableEventError) => void,
  ): Promise<DurableWorkspaceEvent[]> {
    if (rows.length === 0) return [];

    const ids = new Set<string>();
    for (const row of rows) for (const id of referencedEntityIds(row)) ids.add(id);
    const entities = await this.projector.entitySummaries(q, [...ids]);

    const out: DurableWorkspaceEvent[] = [];
    for (const row of rows) {
      try {
        out.push(this.mapRow(row, entities));
      } catch (err) {
        if (err instanceof UnprojectableEventError) {
          onSkip?.(err);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /**
   * Project one row. Throws `UnprojectableEventError` if a needed entity is not
   * in `entities`, `OffContractEventError` if the result is off-contract.
   */
  mapRow(row: WorkspaceEventRow, entities: Map<string, EntitySummary>): DurableWorkspaceEvent {
    const seq = Number(row.seq);
    const body = this.bodyOf(row, entities, seq);

    // The envelope is the ROW's, verbatim. `schema_version` comes from the row
    // rather than the current constant on purpose: an event captured under an
    // older schema version must keep saying so, or a client's version check is
    // meaningless.
    const candidate: unknown = {
      ...body,
      spaceId: row.space_id,
      seq,
      occurredAt: iso(row.occurred_at) ?? new Date(0).toISOString(),
      schemaVersion: row.schema_version,
      ...(row.client_mutation_id === null ? {} : { clientMutationId: row.client_mutation_id }),
    };

    const event = assertWorkspaceEvent(candidate, `'${row.event_type}' on space ${row.space_id} (seq ${String(seq)})`);
    return event as Exclude<WorkspaceEvent, { type: 'presence.changed' | 'typing.changed' }>;
  }

  private need(entities: Map<string, EntitySummary>, id: string | null, seq: number, what: string): EntitySummary {
    if (id === null) throw new UnprojectableEventError(seq, `${what} is missing from the captured payload`);
    const found = entities.get(id);
    if (found === undefined) {
      throw new UnprojectableEventError(seq, `${what} ${id} is not readable (deleted, or filtered by RLS)`);
    }
    return found;
  }

  /** The discriminated-union arm for a row, minus the envelope. */
  private bodyOf(
    row: WorkspaceEventRow,
    entities: Map<string, EntitySummary>,
    seq: number,
  ): Record<string, unknown> {
    const p = row.payload;

    switch (row.event_type) {
      case 'entity.upsert':
      case 'entity.deleted':
        return {
          type: row.event_type,
          entity: this.need(entities, str(p['id']), seq, 'event entity'),
        };

      case 'edge.upsert':
      case 'edge.deleted': {
        const source = this.need(entities, str(p['src_id']), seq, 'edge source');
        const target = this.need(entities, str(p['dst_id']), seq, 'edge target');
        const edge: EdgeView = {
          id: str(p['id']) ?? '',
          type: str(p['type']) ?? '',
          source,
          target,
          props: record(p['props']),
          // The edge's author is an entity id in the row; if it did not come
          // back from the projector we still have a valid EdgeView by using the
          // source's author, which is wrong-but-typed. Prefer honesty: require
          // it, and let the row be skipped rather than misattributed.
          createdBy: this.need(entities, str(p['created_by']), seq, 'edge author').createdBy,
          createdAt: iso(p['created_at']) ?? source.createdAt,
        };
        return { type: row.event_type, edge };
      }

      case 'message.created':
      case 'message.updated':
      case 'message.deleted': {
        const summary = this.need(entities, str(p['entity_id']), seq, 'message entity');
        if (summary.state.kind !== 'message') {
          throw new UnprojectableEventError(seq, `entity ${summary.id} is not a message (kind ${summary.kind})`);
        }
        const anchorId = str(p['anchor_id']) ?? summary.state.anchorId;
        // MessageView extends EntitySummary with the message's own content and
        // reply count. `replyCount` is 0 here — see projector KNOWN_GAPS; the
        // thread view gets it from the read path, and an event consumer that
        // needs it re-reads the anchor.
        const message: MessageView = {
          ...summary,
          state: summary.state,
          content: {
            kind: 'message',
            body: str(p['body']) ?? '',
            mentions: Array.isArray(p['mentions']) ? (p['mentions'] as MessageView['content']['mentions']) : [],
            attachments: Array.isArray(p['attachments'])
              ? (p['attachments'] as MessageView['content']['attachments'])
              : [],
          },
          replyCount: 0,
        };
        return { type: row.event_type, anchorId, message };
      }

      case 'counter.changed': {
        const entityId = str(p['entity_id']);
        if (entityId === null) {
          throw new UnprojectableEventError(seq, 'counter event has no entity_id');
        }
        // Counters come straight off the captured `entity_counters` row — no
        // hydration needed, which is why counter events survive even when the
        // entity itself is not readable... except that they should NOT: a
        // counter for an invisible entity is a (small) leak. The poll query
        // already filters by space membership; entity-level visibility for
        // counters is deferred with the rest of `restricted` (01 §S4, inert v1).
        const counters = {
          likes: Number(p['likes'] ?? 0),
          dislikes: Number(p['dislikes'] ?? 0),
          stars: Number(p['stars'] ?? 0),
          points: Number(p['points'] ?? 0),
          messages: Number(p['messages'] ?? 0),
          // Viewer-scoped and absent from the counters row. `null` is the
          // contract's "no reaction from this viewer", which is the correct
          // answer whenever we have not resolved one.
          viewerReaction: null,
        };
        return { type: 'counter.changed', entityId, counters };
      }

      case 'activity.created': {
        const activity: ActivityItem = {
          id: str(p['id']) ?? '',
          entityId: str(p['entity_id']),
          actor: null,
          verb: str(p['verb']) ?? '',
          summary: record(p['summary']),
          createdAt: iso(p['created_at']) ?? new Date(0).toISOString(),
          refId: str(p['ref_id']),
        };
        return { type: 'activity.created', activity };
      }

      case 'notification.created':
      case 'notification.read': {
        const target = entities.get(str(p['target_entity_id']) ?? '') ?? null;
        const actorEntity = entities.get(str(p['actor_id']) ?? '');
        const notification: NotificationItem = {
          id: str(p['id']) ?? '',
          spaceId: row.space_id,
          kind: str(p['kind']) ?? 'mention',
          actor: actorEntity === undefined ? null : actorEntity.createdBy,
          target,
          readAt: iso(p['read_at']),
          createdAt: iso(p['created_at']) ?? new Date(0).toISOString(),
        };
        const message = str(record(p['payload'])['message']);
        return {
          type: row.event_type,
          notification: message === null ? notification : { ...notification, message },
        };
      }

      default:
        // The trigger emits a closed set of event_type values. A new one means
        // a migration added a capture case without a projection — fail loudly
        // rather than dropping a whole class of events silently.
        throw new UnprojectableEventError(
          seq,
          `no projection for captured event_type '${row.event_type}' — a migration added a capture case ` +
            `without a mapper arm`,
        );
    }
  }
}

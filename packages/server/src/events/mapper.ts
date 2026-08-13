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
  ActorSummary,
  ActivityItem,
  DurableWorkspaceEvent,
  EdgeView,
  EntitySummary,
  MessageView,
  NotificationItem,
  WorkspaceEvent,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';
import { OffContractEventError, assertWorkspaceEvent } from './emitter.js';
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

/**
 * RPC-authored event types projected by PASSTHROUGH: the stored payload IS the
 * contract event body, verbatim.
 *
 * Unlike every arm in `bodyOf`, these rows are not trigger captures of a table
 * row (003's trigger covers only entities / edges / messages / entity_counters /
 * activity / notifications). Their authoring RPC builds the payload
 * contract-shaped at write time, `type` discriminant included, so projection is
 * identity and validation is the shared `assertWorkspaceEvent` tripwire in
 * `mapRow` — no parallel validator.
 *
 * Membership rules — every entry must satisfy ALL of:
 *  - the stored payload validates against its STRICT contract arm (checked at
 *    runtime on every row; an off-contract stored row is skipped and reported,
 *    see `mapRow`);
 *  - leak-safe for the space-wide feed: written with `recipient_member_id`
 *    NULL and containing only data every member of the space may read.
 *    Recipient-targeted rows keep their targeted semantics regardless — RLS
 *    (008:156-161) and the pump's per-connection claims decide visibility;
 *    passthrough changes projection, never routing;
 *  - the authoring mutation is NOT captured by the 003 trigger, so membership
 *    cannot double-deliver an entity-backed change.
 *
 * Members:
 *  - 'menu.updated' (author 031_w2_sec1_replay_principal_resource_binding.sql:822):
 *    payload {type, menu, clientMutationId?}. The menu is space-level config
 *    every member already reads via the menu read path; mutation table
 *    space_menu_configs is not trigger-covered. Space-wide safe.
 *  - 'space.default_channel.updated' (author 031:665): payload
 *    {type, channelId|null, settingsRevision, clientMutationId?}. Space-level
 *    setting; mutation table public.spaces is not trigger-covered. Space-wide
 *    safe.
 *  - 'git.commit_recorded' / 'git.pr_state_changed' /
 *    'git.worktree_status_changed' (authors: 082's capture triggers on
 *    public.commits / public.pull_requests / public.worktrees): payloads are
 *    built contract-shaped in the trigger, `type` included. The facts tables
 *    are NOT 003-trigger-covered (only the entities-row version bump is, which
 *    is a different mutation on a different table — no double delivery of THIS
 *    payload). Space-wide safe: repo/sha/PR state are the same facts every
 *    member reads via the entity views; recipient_member_id is NULL.
 *
 * NOT members (verified against every insert site, 2026-07-28 — do not add
 * without a write-side fix): handoff.*, message.delivery_reserved/_settled,
 * message.attachments.updated, interaction_profile.*,
 * project.association.corrected, work_session.profile_* — their authors store
 * bare off-contract payloads (no `type`, fields not nested per the contract
 * arm), so passthrough would validate-fail every row.
 */
export const RPC_AUTHORED_PASSTHROUGH: ReadonlySet<string> = new Set([
  'menu.updated',
  'space.default_channel.updated',
  'git.commit_recorded',
  'git.pr_state_changed',
  'git.worktree_status_changed',
]);

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

/**
 * A message's content as it stands NOW, with redaction already applied.
 *
 * @see WorkspaceEventMapper.messageContents for why this is read live.
 */
interface LiveMessageContent {
  body: string;
  mentions: unknown[];
  attachments: unknown[];
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
      // `created_by` MUST be here. It is required by the projection below, and
      // omitting it made edge events survive only when their author happened to
      // also be an endpoint of some other event in the SAME page — so an edge
      // was delivered at limit=500 and silently skipped at limit=2. Page-size-
      // dependent delivery is the worst shape of this bug: it passes every test
      // that reads the whole log at once.
      return [str(p['src_id']), str(p['dst_id']), str(p['created_by'])].filter(
        (v): v is string => v !== null,
      );
    case 'message.created':
    case 'message.updated':
    case 'message.deleted':
      return [str(p['entity_id']), str(p['anchor_id'])].filter((v): v is string => v !== null);
    case 'counter.changed':
      return [];
    case 'activity.created':
      return [str(p['actor_id'])].filter((v): v is string => v !== null);
    case 'notification.created':
    case 'notification.read':
      return [
        str(p['target_entity_id']),
        str(p['actor_id']),
        str(p['recipient_team_member_id']),
        str(p['recipient_member_id']),
        // The message the notification is ABOUT. `target_entity_id` is the
        // ANCHOR (003:152 passes `new.anchor_id`), so the target's excerpt is
        // the channel topic or task description — not the body that mentioned
        // you. The preview has to come from the message entity itself.
        str(record(p['payload'])['messageId']),
      ].filter((v): v is string => v !== null);
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
    const actors =
      this.projector.actorSummaries === undefined
        ? new Map<string, ActorSummary>()
        : await this.projector.actorSummaries(q, [...ids]);
    const contents = await this.messageContents(q, rows);
    const sourceSessions = await this.messageSourceSessions(q, rows);

    const out: DurableWorkspaceEvent[] = [];
    for (const row of rows) {
      try {
        out.push(this.mapRow(row, entities, actors, contents, sourceSessions));
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
  /**
   * Message bodies read LIVE, not from the captured payload — a privacy fix, and
   * the root of it.
   *
   * `public.redact_message` (007:1790) overwrites the row: `body = '[redacted]'`,
   * mentions and attachments emptied. But the `message.created` event captured at
   * INSERT time keeps the original text in its `payload` forever, so a client
   * polling from `since=0` after a redaction would still be handed the words the
   * author asked to unsay. Reading the current row instead means redaction
   * propagates to history for free, because the RPC already did the erasing.
   *
   * Done here rather than behind the `EntityProjector` seam deliberately: an
   * injected assembler that did not implement it would silently reintroduce the
   * leak, and a privacy guarantee must not depend on which implementation is
   * wired. One extra query per page, and only when the page contains message
   * events.
   *
   * Runs on the caller's `Querier`, so an unreadable message simply does not come
   * back and the event is skipped by the normal policy.
   */
  private async messageContents(
    q: Querier,
    rows: readonly WorkspaceEventRow[],
  ): Promise<Map<string, LiveMessageContent>> {
    const out = new Map<string, LiveMessageContent>();
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.event_type.startsWith('message.'))
          .map((r) => str(r.payload['entity_id']))
          .filter((v): v is string => v !== null),
      ),
    ];
    if (ids.length === 0) return out;

    const live = await q.query<{
      entity_id: string;
      body: string | null;
      mentions: unknown;
      attachments: unknown;
      redacted_at: Date | string | null;
    }>(
      `select entity_id, body, mentions, attachments, redacted_at
         from public.messages where entity_id = any($1::uuid[])`,
      [ids],
    );

    for (const m of live) {
      // Belt and braces: the RPC already replaced the body, but forcing the
      // suppression here means a future write path that forgets to cannot leak
      // through this file. Matches entity-read.ts:792.
      const redacted = m.redacted_at !== null;
      out.set(m.entity_id, {
        body: redacted ? '' : (m.body ?? ''),
        mentions: redacted || !Array.isArray(m.mentions) ? [] : m.mentions,
        attachments: redacted || !Array.isArray(m.attachments) ? [] : m.attachments,
      });
    }
    return out;
  }

  /**
   * ENVELOPE provenance: for each message event on the page, the SENDER work
   * session the message was authored FROM. Read LIVE from the `authored_from`
   * edge (`dst_id`), never from the captured payload — the payload has no such
   * field, because the correlation is recorded by a separate recorder-gated edge
   * write (`authored_from` is writer-gated to `message_recorder`, see
   * feed-context.ts:511), not by the message insert that produced the event row.
   *
   * Batched exactly like `messageContents`: one query per page, only when the
   * page contains message events. A message with NO `authored_from` edge is
   * human-authored provenance and yields `null` — that is normal, not an error,
   * so the arm must not throw. Read-only: this file never writes the edge.
   */
  private async messageSourceSessions(
    q: Querier,
    rows: readonly WorkspaceEventRow[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.event_type.startsWith('message.'))
          .map((r) => str(r.payload['entity_id']))
          .filter((v): v is string => v !== null),
      ),
    ];
    if (ids.length === 0) return out;

    const provenance = await q.query<{ src_id: string; dst_id: string }>(
      `select src_id, dst_id
         from public.edges
        where type = 'authored_from' and src_id = any($1::uuid[])`,
      [ids],
    );
    for (const row of provenance) out.set(row.src_id, row.dst_id);
    return out;
  }

  mapRow(
    row: WorkspaceEventRow,
    entities: Map<string, EntitySummary>,
    actors: Map<string, ActorSummary> = new Map(),
    contents: Map<string, LiveMessageContent> = new Map(),
    sourceSessions: Map<string, string> = new Map(),
  ): DurableWorkspaceEvent {
    const seq = Number(row.seq);
    const body = this.bodyOf(row, entities, actors, contents, sourceSessions, seq);

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

    let event: WorkspaceEvent;
    try {
      event = assertWorkspaceEvent(candidate, `'${row.event_type}' on space ${row.space_id} (seq ${String(seq)})`);
    } catch (err) {
      // A passthrough row's shape is STORED data, not something this file
      // built. An off-contract payload (e.g. a surviving 015-era
      // 'menu.updated' row with no `type` key) is a bad row, not a mapper
      // bug: skip and report it (mapRows policy) rather than 500 every
      // replay page containing it, forever. Bespoke arms keep throwing
      // OffContractEventError — there, an invalid event IS a mapper bug.
      if (err instanceof OffContractEventError && RPC_AUTHORED_PASSTHROUGH.has(row.event_type)) {
        throw new UnprojectableEventError(
          seq,
          `stored payload for '${row.event_type}' is off-contract — ${err.message}`,
        );
      }
      throw err;
    }
    // `DurableWorkspaceEvent`, not a hand-written exclusion of the two
    // ephemeral types. The hand-written form was already stale: the contract
    // added `voice.participants.changed` to `PresenceWorkspaceEvent`, and a
    // copied list cannot learn that. Naming the contract's own alias means the
    // next ephemeral type narrows this cast automatically instead of silently
    // widening it to admit an event that must never ride the durable stream.
    return event as DurableWorkspaceEvent;
  }

  private need(entities: Map<string, EntitySummary>, id: string | null, seq: number, what: string): EntitySummary {
    if (id === null) throw new UnprojectableEventError(seq, `${what} is missing from the captured payload`);
    const found = entities.get(id);
    if (found === undefined) {
      throw new UnprojectableEventError(seq, `${what} ${id} is not readable (deleted, or filtered by RLS)`);
    }
    return found;
  }

  /**
   * The `ActorSummary` for an actor entity id.
   *
   * Prefers the projector's own answer (which has `avatar`); otherwise derives
   * one from the entity summary, whose title IS the display name and whose state
   * carries the role. Returns null when the id is not an actor or is unreadable.
   *
   * This exists because the previous code read `.createdBy` off the AUTHOR's
   * entity summary — which is the actor who created that member, not the member.
   * An edge authored by Alice was attributed to whoever created Alice's row.
   */
  private actorOf(
    id: string | null,
    entities: Map<string, EntitySummary>,
    actors: Map<string, ActorSummary>,
  ): ActorSummary | null {
    if (id === null) return null;
    const direct = actors.get(id);
    if (direct !== undefined) return direct;

    const summary = entities.get(id);
    if (summary === undefined) return null;
    if (summary.state.kind === 'member') {
      return {
        id: summary.id,
        kind: 'member',
        displayName: summary.title,
        avatar: null,
        role: summary.state.role,
        isAgent: false,
      };
    }
    if (summary.state.kind === 'team_member') {
      return {
        id: summary.id,
        kind: 'team_member',
        displayName: summary.title,
        avatar: null,
        role: null,
        isAgent: true,
      };
    }
    return null;
  }

  /** The discriminated-union arm for a row, minus the envelope. */
  private bodyOf(
    row: WorkspaceEventRow,
    entities: Map<string, EntitySummary>,
    actors: Map<string, ActorSummary>,
    contents: Map<string, LiveMessageContent>,
    sourceSessions: Map<string, string>,
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
        const createdAt = iso(p['created_at']);
        const updatedAt = iso(p['updated_at']);
        if (createdAt === null || updatedAt === null) {
          throw new UnprojectableEventError(seq, 'edge timestamps are missing from the captured payload');
        }
        const edge: EdgeView = {
          id: str(p['id']) ?? '',
          type: str(p['type']) ?? '',
          source,
          target,
          props: record(p['props']),
          // The edge's author, resolved as an ACTOR. Requiring it (rather than
          // substituting the source's author) means a misattributed edge is
          // impossible: either we know who made it or the row is skipped and
          // reported.
          createdBy:
            this.actorOf(str(p['created_by']), entities, actors) ??
            (() => {
              throw new UnprojectableEventError(
                seq,
                `edge author ${String(p['created_by'])} is not a readable actor`,
              );
            })(),
          createdAt,
          updatedAt,
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
        // LIVE content, not `p['body']`. The captured payload froze the original
        // text at insert time and would keep serving it after a redaction — see
        // `messageContents`. A message with no live row was deleted or is
        // unreadable, so it is skipped rather than served from the payload.
        const live = contents.get(summary.id);
        if (live === undefined) {
          throw new UnprojectableEventError(
            seq,
            `message ${summary.id} has no readable live row — refusing to serve its captured payload`,
          );
        }
        const legacyCompatibleState = summary.state as Omit<MessageView['state'], 'messageBatchId'> & {
          messageBatchId?: string | null;
        };
        const messageState: MessageView['state'] = Object.prototype.hasOwnProperty.call(
          legacyCompatibleState,
          'messageBatchId',
        )
          ? (legacyCompatibleState as MessageView['state'])
          : { ...legacyCompatibleState, messageBatchId: str(p['message_batch_id']) };
        const message: MessageView = {
          ...summary,
          // A pre-W1 projector/row has no correlation field. `null` is the
          // migration's truthful backfill for those messages; a captured value
          // is used only when the injected summary predates the contract field.
          state: messageState,
          content: {
            kind: 'message',
            body: live.body,
            mentions: live.mentions as MessageView['content']['mentions'],
            attachments: live.attachments as MessageView['content']['attachments'],
          },
          replyCount: 0,
        };
        // Envelope-level SENDER provenance, hydrated live from the `authored_from`
        // edge rather than read from the captured payload (the payload has no such
        // field — the correlation is a separate recorder-gated edge write). A
        // human-authored message has no edge and yields `null`, which is normal,
        // not an UnprojectableEventError.
        const sourceWorkSessionId = sourceSessions.get(summary.id) ?? null;
        return { type: row.event_type, anchorId, sourceWorkSessionId, message };
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
          ...(p['human_messages'] === undefined ? {} : { humanMessages: Number(p['human_messages'] ?? 0) }),
          ...(p['agent_messages'] === undefined ? {} : { agentMessages: Number(p['agent_messages'] ?? 0) }),
          // 108's link counters, SPREAD-WHEN-PRESENT rather than defaulted:
          // the durable log replays payloads captured BEFORE the columns
          // existed, and inventing 0 for those would turn "never counted"
          // into a claim of emptiness. The contract marks both optional.
          ...(p['docs'] === undefined ? {} : { docs: Number(p['docs'] ?? 0) }),
          ...(p['memories'] === undefined ? {} : { memories: Number(p['memories'] ?? 0) }),
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
          // WHO did it. `activity.created` is how completion reaches the client,
          // and an activity feed that cannot name its actor is not a feed.
          actor: this.actorOf(str(p['actor_id']), entities, actors),
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
        const recipientId = str(p['recipient_team_member_id']) ?? str(p['recipient_member_id']);
        const recipient = this.actorOf(recipientId, entities, actors);
        if (recipient === null) {
          throw new UnprojectableEventError(
            seq,
            `notification recipient ${String(recipientId)} is not a readable actor`,
          );
        }
        const notification: NotificationItem = {
          id: str(p['id']) ?? '',
          spaceId: row.space_id,
          kind: str(p['kind']) ?? 'mention',
          actor: this.actorOf(str(p['actor_id']), entities, actors),
          target,
          recipient,
          readAt: iso(p['read_at']),
          createdAt: iso(p['created_at']) ?? new Date(0).toISOString(),
        };
        // The inbox preview line.
        //
        // This read `payload.message`, a key NO producer has ever written, so
        // the preview rendered for no notification of any kind, ever. The
        // payload DOES carry `excerpt` (003:155, 019:267, 077:156) but wiring
        // that to a renderer is forbidden: it is a raw `left(body, 280)` cut in
        // plpgsql with no markdown strip and no whitespace flatten, and a
        // fourth independent excerpt cap is exactly what the one-helper rule
        // exists to prevent (Messaging Format §3.5.1).
        //
        // So the preview is derived from the MESSAGE entity's own summary,
        // which comes from `entity-read.ts`'s single `excerpt()` helper and
        // therefore inherits its markdown handling for free. `messageId` is
        // requested in `referencedEntityIds` above; NOT `target_entity_id`,
        // which is the anchor, not the message.
        //
        // A message the viewer cannot read is absent from `entities`, so it
        // yields no preview — strictly better than the payload copy, which
        // would have handed out the body regardless of readability.
        //
        // MUST stay in step with the facade reader in
        // `facade/services/w2/inbox-read-marks.ts` — same two assemblers, same
        // NotificationItem.
        const messageId = str(record(p['payload'])['messageId']);
        const message = messageId === null ? null : entities.get(messageId)?.excerpt ?? null;
        return {
          type: row.event_type,
          notification: message === null ? notification : { ...notification, message },
        };
      }

      default:
        // RPC-authored rows: the payload already is the contract body,
        // discriminant included (see RPC_AUTHORED_PASSTHROUGH). Copied, not
        // aliased, so envelope assembly cannot reach back into the row.
        if (RPC_AUTHORED_PASSTHROUGH.has(row.event_type)) {
          return { ...p };
        }
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

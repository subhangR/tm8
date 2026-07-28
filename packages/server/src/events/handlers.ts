/**
 * The events lane's mount point.
 *
 * `registerEventHandlers` is the ONLY thing main.ts needs from this directory.
 * The composition root calls it; this file never calls itself, never constructs
 * a `Db`, and never reads config beyond what it is handed — so the lane is
 * testable by handing it a fake `Db` and a bare `HandlerRegistry`.
 *
 * Exactly one operation is registered here today: `events.poll`. `events.subscribe`
 * is WS-only (catalog line 128, method `WS`) and is served by the upgrade path in
 * ws-server.ts, not by an HTTP handler — which is also why /health reports 80
 * mounted HTTP routes for an 81-entry catalog.
 */
import { CollabError, type ActorSummary, type PresenceSnapshot } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { claimsFor } from '../facade/context.js';
import { loadActors } from '../facade/entity-read.js';
import type { HandlerRegistry } from '../facade/index.js';
import type { ServerConfig } from '../http/config.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import { json } from '../http/types.js';
import { DEFAULT_POLL_LIMIT, PgDurableEventLog, type DurableEventLog } from './poll.js';
import { emptyPresence, type PresenceStore } from './presence.js';

export interface EventHandlerDeps {
  readonly db: Db;
  readonly config: ServerConfig;
  /** The v1 loopback auto-owner, resolved once per process. */
  readonly owner?: () => Promise<LoopbackOwner>;
  /**
   * Override the log implementation. Tests inject a fake; production leaves it
   * undefined and gets `PgDurableEventLog` over `deps.db`.
   */
  readonly log?: DurableEventLog;
  /**
   * The ephemeral presence source (DEV-4). ABSENT MEANS `presence.get` IS NOT
   * MOUNTED, and the router keeps answering 501 — see the registration below.
   */
  readonly presence?: PresenceStore;
}

/**
 * Parse a `?since=` value into a seq.
 *
 * `since` is the per-space `seq` (AM-2 §3), so it is a non-negative integer and
 * nothing else. It is validated rather than coerced because `Number('abc')` is
 * `NaN` and `seq > NaN` is false for every row — a typo in a client's cursor
 * would silently return an empty page, which reads as "you are fully caught up".
 * That is the precise data-loss-wearing-a-green-badge failure this operation
 * exists to avoid, so a malformed cursor is a loud 400 instead.
 */
function parseSince(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new CollabError(
      'invalid_cursor',
      `since must be a non-negative integer seq (AM-2 §3), got '${raw}'`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CollabError('invalid_cursor', `since is out of range: '${raw}'`);
  }
  return value;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_POLL_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new CollabError('invalid_input', `limit must be a positive integer, got '${raw}'`);
  }
  const value = Number(raw);
  if (value < 1) throw new CollabError('invalid_input', 'limit must be at least 1');
  // Clamped, not rejected, above the cap — see MAX_POLL_LIMIT in poll.ts.
  return value;
}

export function registerEventHandlers(registry: HandlerRegistry, deps: EventHandlerDeps): void {
  // One identity path (see test/one-identity-path.test.ts). Claims come from
  // facade/context.ts's `claimsFor` and nowhere else — this file used to define
  // its own copy, which bound `actorId` globally. A member row belongs to ONE
  // space and `internal.resolve_actor` coalesces to it, so a globally-bound
  // actor from space A on a poll of space B raises 42501 for the space's own
  // owner. `events.poll` is a read with no command envelope, so it passes no
  // actor at all and lets `current_member_id(space)` resolve the right one.
  const owner = deps.owner ?? createLoopbackOwnerResolver(deps.db);
  const log = deps.log ?? new PgDurableEventLog(deps.db, {
    // A skipped row is a real (if legitimate) loss of a delivery, so it must
    // never be silent. See WorkspaceEventMapper.mapRows for the skip policy.
    onSkip: (message) => console.warn(`events.poll skipped an event: ${message}`),
  });

  registry.register('events.poll', async (ctx) => {
    const spaceId = ctx.params['spaceId'];
    if (spaceId === undefined || spaceId === '') {
      throw new CollabError('invalid_input', 'spaceId is required');
    }

    const page = await log.since(
      spaceId,
      parseSince(ctx.query.get('since')),
      parseLimit(ctx.query.get('limit')),
      claimsFor(await owner(), ctx),
    );

    return json(page);
  });

  // `presence.get` is only mounted when this node actually has a presence
  // source. Without one the honest answer is the 501 the router already gives,
  // NOT an empty snapshot: a client cannot tell "nobody is viewing" from "we do
  // not track viewing", and the second dressed as the first is the same
  // green-badge-over-an-absence this file's `NotImplementedEventLog` exists to
  // refuse for `events.poll`.
  const presence = deps.presence;
  if (presence !== undefined) {
    registry.register('presence.get', async (ctx) => {
      const entityId = ctx.params['id'];
      if (entityId === undefined || entityId === '') {
        throw new CollabError('invalid_input', 'entity id is required');
      }
      return json(await readPresence(deps.db, presence, entityId, claimsFor(await owner(), ctx)));
    });
  }
}

/** Postgres raises 22P02 on a non-uuid; a bad id is `not_found`, not a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read one entity's ephemeral presence.
 *
 * ORDER IS THE WHOLE POINT. The entity is resolved under the CALLER's claims
 * first, and the presence store is not touched until that read has returned a
 * row. Consulting the store first — even to decide whether to bother with the
 * database — would disclose who is viewing an entity to a caller who may not
 * see the entity at all, and no RLS policy would catch it because the leak
 * happens outside the database entirely.
 *
 * It also means the store is keyed by the entity's REAL `space_id`, taken from
 * the row, never from anything the presence writer claimed. A `presence.set`
 * that named the wrong Space wrote into a bucket this read never looks in.
 *
 * One transaction for the whole read, as `events.poll` does: hydrating actors
 * in a second, separately-authorized read is how a name leaks past a policy
 * that already ran.
 */
async function readPresence(
  db: Db,
  store: PresenceStore,
  entityId: string,
  claims: DbClaims,
): Promise<PresenceSnapshot> {
  if (!UUID_RE.test(entityId)) throw new CollabError('not_found', `no entity ${entityId}`);

  return db.tx(claims, async (q) => {
    const rows = await q.query<{ space_id: string }>(
      'select space_id from public.entities where id = $1',
      [entityId],
    );
    const entity = rows[0];
    // RLS already filtered this. An entity the caller may not read is reported
    // exactly as one that does not exist — anything else confirms it exists.
    if (entity === undefined) throw new CollabError('not_found', `no entity ${entityId}`);

    const at = store.at(entity.space_id, entityId);
    const identityIds = [...new Set([...at.viewerIdentityIds, ...at.typingIdentityIds])];
    if (identityIds.length === 0) return emptyPresence(at.updatedAt);

    // identity → the member row for THIS Space. A member row belongs to one
    // Space, so this cannot pull in an actor from somewhere the caller cannot
    // see, and RLS filters it again anyway.
    const members = await q.query<{ entity_id: string; identity_id: string }>(
      `select entity_id, identity_id from public.members
        where space_id = $1 and identity_id = any($2::text[])`,
      [entity.space_id, identityIds],
    );
    const memberOf = new Map(members.map((m) => [m.identity_id, m.entity_id]));
    const actors = await loadActors(q, members.map((m) => m.entity_id));

    const viewers = at.viewerIdentityIds
      .map((id) => memberOf.get(id))
      .filter((id): id is string => id !== undefined)
      .map((id) => actors.get(id))
      .filter((a): a is ActorSummary => a !== undefined);

    const typingActorIds = at.typingIdentityIds
      .map((id) => memberOf.get(id))
      .filter((id): id is string => id !== undefined);

    return { viewers, typingActorIds, updatedAt: at.updatedAt };
  });
}

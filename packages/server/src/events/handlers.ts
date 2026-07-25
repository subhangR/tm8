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
import { CollabError } from '@tm8/contract';

import type { Db } from '../db/types.js';
import { claimsFor } from '../facade/context.js';
import type { HandlerRegistry } from '../facade/index.js';
import type { ServerConfig } from '../http/config.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import { json } from '../http/types.js';
import { DEFAULT_POLL_LIMIT, PgDurableEventLog, type DurableEventLog } from './poll.js';

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
}

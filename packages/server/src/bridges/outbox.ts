/**
 * The bridge outbox from the server's side (BRIDGE-ENTITY-DESIGN §2.3, §2.7,
 * §6, D23, D28): the notice and reaction API the command executor (B1b-4) and
 * the watchdog post through, and the reader of delivery badges.
 *
 * Every row is written by ONE SQL function, `internal.bridge_outbox_enqueue`
 * (migration 398), which holds the hard checks — live, not paused,
 * `direction` not `in`, `workerPosting` for workers, the conversation is on
 * the connection's allowlist — and the buckets: (teammate, bridge) 20/min
 * with at most 6 un-directed per 10 min, 30/min per conversation, 60/min per
 * number. A refusal never fails the post: the message stays in tm8 and its
 * `bridge.delivery` badge says why (`rate_limited` carries `retryAfterMs`).
 *
 * The functions here run as the in-process bridges worker: the closed-list
 * background-job claim `bridges.runtime`, which no request can bind.
 */
import { randomUUID } from 'node:crypto';
import { CollabError } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';

export type BridgeRefusalReason =
  | 'bridge_paused'
  | 'bridge_ended'
  | 'direction_in'
  | 'worker_posting_off'
  | 'rate_limited'
  | 'not_connected';

export type BridgeDeliveryResult =
  | { status: 'pending'; outboxId: string }
  | { status: 'refused'; reason: BridgeRefusalReason; retryAfterMs?: number };

/** The claims every in-process bridges job runs under (398's `internal.is_bridges_worker()`). */
export function bridgesWorkerClaims(requestId: string = `bridges:${randomUUID()}`): DbClaims {
  return { requestId, backgroundJob: 'bridges.runtime' };
}

function deliveryOf(raw: unknown): BridgeDeliveryResult {
  const r = raw as { status?: string; outboxId?: string; reason?: string; retryAfterMs?: number } | null;
  if (r?.status === 'pending' && typeof r.outboxId === 'string') return { status: 'pending', outboxId: r.outboxId };
  if (r?.status === 'refused' && typeof r.reason === 'string') {
    return {
      status: 'refused',
      reason: r.reason as BridgeRefusalReason,
      ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {}),
    };
  }
  throw new CollabError('upstream_unavailable', 'bridge outbox answered an unknown delivery');
}

/**
 * A bridge notice: authored by the bridge, signed `tm8: …`, posted on the log
 * anchor (as a thread reply to `replyToMessageId` when given, quoting it on the
 * provider) and queued through the outbox. Idempotent on `idempotencyKey`: a
 * second call answers the first call's message and delivery.
 */
export async function postBridgeNotice(
  db: Db,
  input: { bridgeId: string; text: string; replyToMessageId?: string | null; idempotencyKey: string },
): Promise<{ messageId: string; delivery: BridgeDeliveryResult }> {
  const result = await db.rpc<{ messageId: string; delivery: unknown }>(
    bridgesWorkerClaims(),
    'internal.bridge_post_notice',
    [input.bridgeId, input.text, input.replyToMessageId ?? null, input.idempotencyKey],
  );
  return { messageId: result.messageId, delivery: deliveryOf(result.delivery) };
}

/**
 * React to a message on the bridge (an inbound one, or one tm8 sent) with one
 * emoji, through the outbox. Idempotent per (message, emoji) unless a key is given.
 */
export async function reactBridgeMessage(
  db: Db,
  input: { bridgeId: string; messageId: string; emoji: string; idempotencyKey?: string },
): Promise<BridgeDeliveryResult> {
  const result = await db.rpc<unknown>(
    bridgesWorkerClaims(),
    'internal.bridge_react_message',
    [input.bridgeId, input.messageId, input.emoji, input.idempotencyKey ?? null],
  );
  return deliveryOf(result);
}

/**
 * `events.poll` — the catch-up fallback for clients that lost the socket
 * (`GET /v2/spaces/:spaceId/events`, catalog line 129, status `v1`).
 *
 * READ THIS BEFORE WIRING ANYTHING: no handler is registered for
 * `events.poll` in the skeleton, and that is deliberate. The operation is v1,
 * so it must exist in the catalog and it must answer honestly — and the honest
 * answer, with no durable event log behind it, is `501 not_implemented`
 * (DEV-13; the conformance acceptance profile asserts exactly this). Anything
 * else — an empty page, a 200 with `[]` — would tell a reconnecting client
 * "you have missed nothing", which is a data-loss bug wearing a green badge.
 * So the frame's unregistered-operation path answers 501 and this file only
 * declares the shape W2 will satisfy.
 *
 * The `since` cursor is the per-space `seq` from the AM-2 §3 envelope, not a
 * timestamp and not an opaque keyset cursor: the client replays from the last
 * seq it durably applied. Presence/typing are never returned here — they are
 * ephemeral (DEV-4) and there is nothing to catch up on.
 */
import { CollabError, type DurableWorkspaceEvent } from '@tm8/contract';

/**
 * The durable event log, as `events.poll` needs to see it. At W2 this is a
 * read of `workspace_events` under the caller's identity.
 */
export interface DurableEventLog {
  /**
   * Events for `spaceId` with `seq > sinceSeq`, in ascending seq order,
   * at most `limit` of them.
   */
  since(spaceId: string, sinceSeq: number, limit: number): Promise<DurableWorkspaceEvent[]>;
}

/**
 * Used by nothing. It exists so that the day someone DOES wire a poll handler,
 * the default binding refuses in the contract's own error vocabulary instead of
 * returning a plausible empty result.
 */
export class NotImplementedEventLog implements DurableEventLog {
  since(spaceId: string): Promise<DurableWorkspaceEvent[]> {
    return Promise.reject(
      new CollabError('not_implemented', `no durable event log: cannot replay events for space ${spaceId}`),
    );
  }
}

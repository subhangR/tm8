/**
 * Close the open event sockets of specific auth sessions (plan 01a0d9eb W4).
 *
 * `auth.sessions.revoke` ends one session (plus the pinned sessions entered
 * from it). Subscription admission is checked only at subscribe time, so a
 * socket opened with a revoked token keeps receiving events until it is
 * closed. This closes exactly the sockets whose verified session is in the
 * revoked set, and no other: revoking your phone's session must not drop the
 * tab you revoked it from, though both belong to one identity.
 *
 * The session-keyed sibling of W1's identity-keyed `closeSockets` (#841,
 * `membership/handlers.ts`), over the same port and with the same rules:
 * 1008, and a failed close is logged, never thrown — the revocation already
 * committed. Fold the two together once #841 merges.
 */
import type { EventSink } from '../events/ws-connection.js';
import { CLOSE_CODE } from '../events/ws-frame.js';

/** The live event sockets (`SubscriptionRegistry`). */
export interface SessionSocketPort {
  sinks(): EventSink[];
}

export const SESSION_REVOKED_CLOSE_REASON = 'session revoked';

/** Close every open socket opened with one of `sessionIds`. Returns how many. */
export function closeSessionSockets(
  sockets: SessionSocketPort | undefined,
  sessionIds: ReadonlySet<string>,
  log?: (message: string, fields: Record<string, unknown>) => void,
): number {
  if (!sockets || sessionIds.size === 0) return 0;
  let closed = 0;
  for (const sink of sockets.sinks()) {
    const sessionId = sink.identity.sessionId;
    if (!sink.isOpen || !sessionId || !sessionIds.has(sessionId)) continue;
    try {
      sink.close(CLOSE_CODE.policyViolation, SESSION_REVOKED_CLOSE_REASON);
      closed += 1;
    } catch (error) {
      log?.('closing a socket after a session was revoked failed', {
        connId: sink.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return closed;
}

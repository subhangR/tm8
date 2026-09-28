/**
 * Close the open event sockets of specific auth sessions (plan 01a0d9eb W4,
 * widened by P7).
 *
 * Subscription admission is checked only at subscribe time, so a socket opened
 * with a session that has since ended keeps receiving events until it is
 * closed. Two things close it, both keyed by session and never by identity —
 * logging out on your phone must not drop the tab you are reading this in,
 * though both belong to one identity:
 *
 *   - `closeSessionSockets`, called where the server itself just ended known
 *     sessions (`auth.logout`, `auth.sessions.revoke`, W5's space-password
 *     admin ops). Immediate.
 *   - `createSessionLivenessSweep`, run once per event-pump tick: one SQL call
 *     (`ended_auth_sessions`, migration auth_session_liveness) over every open socket's session id, then
 *     close whatever it names. This is what covers every revoke path that
 *     happens in SQL with no server call site to hang a close on — the 249
 *     cascade to pinned children, W1 membership end and account disable, the
 *     W6 link revokes and their members trigger, expiry — and any path added
 *     later. The pump interval (1s) bounds how long such a socket outlives its
 *     session.
 *
 * Both close with `WS_CLOSE_SESSION_ENDED` (4401), not 1008: the credential is
 * dead and the client must not reconnect with it. A failed close is logged,
 * never thrown — the revocation already committed.
 *
 * The session-keyed sibling of W1's identity-keyed `closeSockets`
 * (`membership/handlers.ts`), over the same port.
 */
import { WS_CLOSE_SESSION_ENDED } from '@tm8/contract';

import type { EventSink } from '../events/ws-connection.js';

/** The live event sockets (`SubscriptionRegistry`). */
export interface SessionSocketPort {
  sinks(): EventSink[];
}

type Log = (message: string, fields: Record<string, unknown>) => void;

/** A session the server itself just revoked. */
export const SESSION_REVOKED_CLOSE_REASON = 'session revoked';
/** A session the liveness sweep found ended (revoked elsewhere, expired, disabled, left). */
export const SESSION_ENDED_CLOSE_REASON = 'session ended';

/** Close every open socket opened with one of `sessionIds`. Returns how many. */
export function closeSessionSockets(
  sockets: SessionSocketPort | undefined,
  sessionIds: ReadonlySet<string>,
  log?: Log,
  reason: string = SESSION_REVOKED_CLOSE_REASON,
): number {
  if (!sockets || sessionIds.size === 0) return 0;
  let closed = 0;
  for (const sink of sockets.sinks()) {
    const sessionId = sink.identity.sessionId;
    if (!sink.isOpen || !sessionId || !sessionIds.has(sessionId)) continue;
    try {
      sink.close(WS_CLOSE_SESSION_ENDED, reason);
      closed += 1;
    } catch (error) {
      log?.('closing a socket after its session ended failed', {
        connId: sink.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return closed;
}

/** Which of `sessionIds` have ended: `public.ended_auth_sessions` (migration auth_session_liveness). */
export type EndedSessionsReader = (sessionIds: readonly string[]) => Promise<readonly string[]>;

export interface SessionLivenessSweep {
  /** Re-verify every open socket's session; close the ended ones. Returns how many closed. */
  sweep(): Promise<number>;
}

export function createSessionLivenessSweep(deps: {
  readonly sockets: SessionSocketPort;
  readonly ended: EndedSessionsReader;
  readonly log?: Log;
}): SessionLivenessSweep {
  return {
    async sweep(): Promise<number> {
      const live = new Set<string>();
      for (const sink of deps.sockets.sinks()) {
        // The loopback auto-owner has no session row, so nothing can end it here.
        if (sink.isOpen && sink.identity.sessionId) live.add(sink.identity.sessionId);
      }
      if (live.size === 0) return 0;
      const ended = await deps.ended([...live]);
      return closeSessionSockets(deps.sockets, new Set(ended), deps.log, SESSION_ENDED_CLOSE_REASON);
    },
  };
}

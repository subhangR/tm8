/**
 * Closing PTY sockets that a private credential no longer admits (doc 13 §3h,
 * threat review R9, migration 997).
 *
 * A PTY attach is decided ONCE, when the socket opens: `grant_stream_attach`
 * mints the grant and `consume_stream_attach` spends it. A member who attached
 * while the session's credential was public keeps watching after the owner
 * switches it private unless something re-asks. This file is that re-ask: for
 * each open socket it evaluates `public.session_stream_credential_allowed`
 * under the SOCKET SUBJECT's own claims — the same predicate the journal and
 * transcript reads use — and the server closes the sockets it refuses.
 *
 * Two callers, one answer:
 *   - W10b's switch-to-private and revoke paths, after their commit and kill
 *     loop, through `CredentialStreamPort` (declared structurally on their
 *     side, so neither lane imports the other);
 *   - a periodic sweep in main.ts over every open socket, the backstop for a
 *     crash between that commit and that call, and for any other path that
 *     leaves a card private (account disable revokes, 239 §9).
 *
 * The policy is not restated here: this only asks SQL.
 */
import type { Db } from '../db/types.js';
import type { JobOutcome, ScheduledJob } from '../scheduler/types.js';

/** What W10b's catalog calls after a switch to private or a revoke commits. */
export interface CredentialStreamPort {
  /** Re-check every open socket on these sessions; returns how many were closed. */
  closeUnpermittedStreams(sessionIds: readonly string[]): Promise<number>;
}

/** Is `subjectIdentity` still admitted to `sessionId` by the credential rule? */
export type PtyCredentialRecheck = (sessionId: string, subjectIdentity: string) => Promise<boolean>;

/** How often main.ts sweeps every open PTY socket. */
export const CREDENTIAL_STREAM_SWEEP_MS = 15_000;

export function createPtyCredentialRecheck(db: Pick<Db, 'query'>): PtyCredentialRecheck {
  return async (sessionId, subjectIdentity) => {
    const rows = await db.query<{ allowed: boolean }>(
      { identityId: subjectIdentity },
      'select public.session_stream_credential_allowed($1::uuid) as allowed',
      [sessionId],
    );
    return rows[0]?.allowed === true;
  };
}

/**
 * The backstop sweep: every open PTY socket, every `CREDENTIAL_STREAM_SWEEP_MS`.
 * Cheap when idle — no open sockets means no query.
 */
export function createCredentialStreamSweepJob(options: {
  readonly streams: { recheckCredentialStreams(sessionIds?: readonly string[]): Promise<number> };
  readonly intervalMs?: number;
}): ScheduledJob {
  return {
    name: 'pty-credential-stream-sweep',
    intervalMs: options.intervalMs ?? CREDENTIAL_STREAM_SWEEP_MS,
    jitterRatio: 0.1,
    runOnStart: false,
    timeoutMs: 60_000,
    async run(): Promise<JobOutcome> {
      const closed = await options.streams.recheckCredentialStreams();
      return closed === 0
        ? { skipped: true, reason: 'no open stream refused by a private credential' }
        : { affected: closed };
    },
  };
}

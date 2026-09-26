/**
 * The space-credential session sweep (W10b, R8 / threat review N8).
 *
 * Revoke and switch-to-private kill their sessions inline, but an inline kill
 * can miss one: the PTY host was down, the node restarted between the row
 * write and the kill, or a session reached `running` through a path that
 * never saw the change. This job is the backstop, and it runs once right
 * after boot (`runOnStart`) as the post-boot re-check:
 *
 *   1. `public.sweep_unusable_space_credential_sessions` (255) returns a
 *      bounded batch of live sessions (spawning included) whose space
 *      credential is revoked, or private and launched by someone other than
 *      its owner. Node admin only.
 *   2. Each one is killed through `containCredentialSession`, which records
 *      the session's ending the same way the inline kill does.
 *
 * Per-session failure isolation: a kill that fails is logged and offered
 * again next tick (the row still reads live); it never abandons the batch.
 */

import type { DbClaims } from '../../db/types.js';
import type {
  AgentSessionContainmentPort,
  CredentialContainmentCause,
} from '../../credentials/agent-session-containment.js';
import { containmentFailureOf } from '../../credentials/agent-session-containment.js';
import type { SpaceCredentialUnusableSession } from '../../credentials/space-credential-store.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const SPACE_CREDENTIAL_SWEEP_JOB_NAME = 'credentials.space-session-sweep';

export interface SpaceCredentialSweepOptions {
  store: {
    unusableSessions(claims: DbClaims, limit?: number): Promise<SpaceCredentialUnusableSession[]>;
  };
  agentSessions: AgentSessionContainmentPort;
  /** Node-owner claims — the sweep door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** Sessions per tick. */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

const CAUSE_BY_REASON: Record<SpaceCredentialUnusableSession['reason'], CredentialContainmentCause> = {
  revoked: 'space_credential_deleted',
  private: 'space_credential_made_private',
};

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runSpaceCredentialSweepTick(
  options: SpaceCredentialSweepOptions,
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const sessions = await options.store.unusableSessions(claims, options.batchSize ?? 200);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { skipped: true, reason: 'no live session on a revoked or private space credential' };
  }

  // One session can hold two providers' credentials; kill it once.
  const causes = new Map<string, CredentialContainmentCause>();
  for (const row of sessions) {
    // A revoked credential outranks a private one for the recorded ending.
    if (causes.get(row.workSessionId) === 'space_credential_deleted') continue;
    causes.set(row.workSessionId, CAUSE_BY_REASON[row.reason]);
  }

  let contained = 0;
  const problems: string[] = [];
  for (const [sessionId, cause] of causes) {
    if (signal?.aborted) break;
    try {
      const failure = containmentFailureOf(
        await options.agentSessions.containCredentialSession(sessionId, cause),
      );
      if (failure) problems.push(`${sessionId}: ${failure}`);
      else contained += 1;
    } catch (error) {
      problems.push(`${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    log?.(`${SPACE_CREDENTIAL_SWEEP_JOB_NAME}: ${problems.length} session(s) could not be contained: ${
      problems.slice(0, 5).join('; ')}`);
  }
  return {
    affected: contained,
    detail: { found: causes.size, contained, failed: problems.length },
  };
}

export function createSpaceCredentialSweepJob(options: SpaceCredentialSweepOptions): ScheduledJob {
  return {
    name: SPACE_CREDENTIAL_SWEEP_JOB_NAME,
    // The inline kill is the primary path; a minute bounds how long a missed
    // session keeps running on a credential it may no longer use.
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runSpaceCredentialSweepTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}

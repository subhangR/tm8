/**
 * The credential-session ending sweep (migration 367).
 *
 * A credential work session — a vendor login terminal — is minted `spawning`
 * with NO node_id (D5), so the boot ghost reconciliation and the lost-session
 * reaper, which both list candidates by node_id, never see it. The server now
 * records its ending on every close (`W2CredentialSessionsService.recordEnding`);
 * this job is the backstop for the rest: rows from before that shipped, an
 * ending write that failed, a node that died holding a terminal.
 *
 * `public.credential_session_ending_sweep` (node admin) ends, as `failed /
 * lost`, a credential work session still recorded live whose login lease
 * (`credential_sessions.expires_at`) ran out more than the grace ago — past it
 * no node can still be running the terminal. A login inside its lease is never
 * touched, whichever node holds it.
 *
 * Runs on start, so a boot clears what the last run left, then every 5 min.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const CREDENTIAL_SESSION_ENDING_SWEEP_JOB_NAME = 'credentials.session-ending-sweep';

export interface CredentialSessionEndingSweepResult {
  reaped: string[];
}

export interface CredentialSessionEndingSweepOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the sweep door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** How long past its lease a login terminal's work session may stay live. */
  graceSeconds?: number;
  /** Sessions per tick. */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runCredentialSessionEndingSweepTick(
  options: CredentialSessionEndingSweepOptions,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const result = await options.db.rpc<CredentialSessionEndingSweepResult>(
    claims,
    'public.credential_session_ending_sweep',
    [`${String(options.graceSeconds ?? 600)} seconds`, options.batchSize ?? 200],
  );
  const reaped = Array.isArray(result?.reaped) ? result.reaped : [];
  if (reaped.length === 0) {
    return { skipped: true, reason: 'no credential session left live past its login lease' };
  }
  return { affected: reaped.length, detail: { reaped: reaped.length } };
}

export function createCredentialSessionEndingSweepJob(
  options: CredentialSessionEndingSweepOptions,
): ScheduledJob {
  return {
    name: CREDENTIAL_SESSION_ENDING_SWEEP_JOB_NAME,
    intervalMs: options.intervalMs ?? 5 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runCredentialSessionEndingSweepTick(options);
    },
  };
}

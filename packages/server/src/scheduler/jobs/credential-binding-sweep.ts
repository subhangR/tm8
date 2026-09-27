/**
 * The credential-binding sweep (R2 gate 2; migration session_credential_binding).
 *
 * Every agent session is minted `pending` and records which credential it
 * runs on before it may go `running`: spawn in `record_session_manifest`,
 * resume in `record_session_credential_binding`. A session still `pending`
 * after the grace never recorded it — its launch died between the mint and the
 * record, or an older server binary resumed it — and the guard will never let
 * it run. `public.credential_binding_sweep` (node admin) ends those as
 * `failed` in SQL, the way `work_session_transition` writes an ending. None of
 * them holds a PTY: the PTY starts only after the binding is recorded, and a
 * launch that fails the `running` transition tears its PTY down itself.
 *
 * Release 1 is additive, so every other gate-1 violation the sweep finds — a
 * `bound` session without a session_space_credentials row per provider, a row
 * without its `runs_on` edge, a `pending` session somehow running — is
 * REPORTED here, never killed.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const CREDENTIAL_BINDING_SWEEP_JOB_NAME = 'credentials.binding-sweep';

export interface CredentialBindingViolation {
  workSessionId: string;
  status: string;
  credentialBinding: string;
  problem: 'pending' | 'bound_without_row' | 'bound_without_any_row' | 'row_without_edge';
  provider?: string;
  credentialId?: string;
}

export interface CredentialBindingSweepResult {
  reaped: string[];
  violations: CredentialBindingViolation[];
}

export interface CredentialBindingSweepOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the sweep door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** How long a session may sit `pending` before it is reaped. */
  graceSeconds?: number;
  /** Sessions per tick, for the reap and for the report. */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runCredentialBindingSweepTick(
  options: CredentialBindingSweepOptions,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const result = await options.db.rpc<CredentialBindingSweepResult>(claims, 'public.credential_binding_sweep', [
    `${String(options.graceSeconds ?? 600)} seconds`,
    options.batchSize ?? 200,
  ]);
  const reaped = Array.isArray(result?.reaped) ? result.reaped : [];
  const violations = Array.isArray(result?.violations) ? result.violations : [];
  if (violations.length > 0) {
    log?.(`${CREDENTIAL_BINDING_SWEEP_JOB_NAME}: ${violations.length} credential binding violation(s), ` +
      `reported and left running: ${violations.slice(0, 5)
        .map((v) => `${v.workSessionId} ${v.problem}${v.provider ? `(${v.provider})` : ''}`).join('; ')}`);
  }
  if (reaped.length === 0 && violations.length === 0) {
    return { skipped: true, reason: 'no pending session past its grace and no binding violation' };
  }
  return { affected: reaped.length, detail: { reaped: reaped.length, violations: violations.length } };
}

export function createCredentialBindingSweepJob(options: CredentialBindingSweepOptions): ScheduledJob {
  return {
    name: CREDENTIAL_BINDING_SWEEP_JOB_NAME,
    intervalMs: options.intervalMs ?? 5 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runCredentialBindingSweepTick(options, (m) => { ctx.logger.warn(m); });
    },
  };
}

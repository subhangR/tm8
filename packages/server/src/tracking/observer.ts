/**
 * The tracking observer — the worker 006 wrote its queue for.
 *
 * `public.tracking_refresh_requests` was created in 006 for "a worker with
 * provider credentials", and 017/034 shipped the enqueue door. Nothing has ever
 * consumed it: `tracking.refresh` answered 202 and the row sat there forever.
 * A 202 for work that no process will do is worse than a 501 — it tells the
 * caller their request was accepted.
 *
 * This drains it. The shape, and why:
 *
 *   * CLAIM, THEN FETCH, THEN APPLY, THEN COMPLETE. Four steps, so a node that
 *     dies mid-fetch leaves a `running` row with a `started_at`, which the next
 *     claim returns to the queue after a bounded stale window. A single
 *     transaction spanning the network call would hold a database connection
 *     open across the internet.
 *   * PARTIAL SUCCESS IS SUCCESS. A request naming ten PRs where one 404s
 *     completes, and the 404 is recorded per-target rather than failing the
 *     other nine. A refresh is an attempt to learn, and learning nine things
 *     out of ten is not a failure.
 *   * A RATE LIMIT DOES NOT MARK ANYTHING FAILED. It stops the tick. The
 *     request stays claimable and the next tick tries again — because "GitHub
 *     asked us to slow down" is not evidence about a pull request.
 *
 * S15: the credential lives in the environment and never in Postgres. The queue
 * carries intent only, which is exactly what 006's comment said it would.
 */

import type { Db, DbClaims } from '../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../scheduler/types.js';
import { GithubClient, resolveGithubToken } from './github.js';

export const TRACKING_OBSERVER_JOB_NAME = 'tracking.observer';

interface ClaimedTarget {
  entityId: string;
  kind: 'pull_request' | 'commit';
  provider: string | null;
  repo: string | null;
  number: number | null;
  sha: string | null;
}

interface ClaimedRequest {
  requestId: string;
  spaceId: string;
  attempts: number;
  targets: ClaimedTarget[];
}

export interface TrackingObserverOptions {
  db: Db;
  /**
   * The identity every write runs as. The doors go through
   * `require_space_member`, which has no node-admin bypass, so the observer
   * needs a real one — the node's loopback owner is the honest choice: it is
   * their node holding the queue.
   */
  claims: () => Promise<DbClaims>;
  client?: GithubClient;
  /** Requests per tick. Small on purpose — this is a poller, not a backfill. */
  batchSize?: number;
  /**
   * TARGETS per tick, which is the bound that corresponds to wall-clock.
   * `batchSize` counts requests, and one request can name every tracked entity
   * in a space, so it alone does not keep a tick inside its timeout.
   */
  targetBudget?: number;
  /** Retirement budget — a request that keeps failing is retired, not retried forever. */
  maxAttempts?: number;
  /** How long a `running` row may sit before the next claim reclaims it. */
  staleAfterSeconds?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

/**
 * One tick: claim a batch, refresh every target in it, complete each request.
 *
 * Exported separately from the job wrapper so it can be driven directly by a
 * test (and by `scheduler.runNow`) without a timer in the way.
 */
export async function runTrackingObserverTick(
  options: TrackingObserverOptions,
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const ctxLogger = log;
  const client = options.client ?? new GithubClient({ token: resolveGithubToken() });
  const claims = await options.claims();

  const claimed = await options.db.rpc<{ claimed?: unknown }>(
    claims,
    'public.claim_tracking_refresh',
    [options.batchSize ?? 5, options.staleAfterSeconds ?? 600, options.maxAttempts ?? 5],
  );
  const requests = normalizeClaimed(claimed?.claimed);
  if (requests.length === 0) {
    return { skipped: true, reason: 'no queued tracking refresh requests' };
  }

  let refreshed = 0;
  let unresolved = 0;
  let rateLimited = false;
  let abandoned = 0;
  // Targets, not requests. `batchSize` bounds how many REQUESTS are claimed, and
  // a single request with absent entityIds means "every tracked entity in this
  // space" (081's claim door, matching what 034:145 enqueues) — so a space with
  // a few hundred PRs blows the job timeout on one request. This is the bound
  // that actually corresponds to wall-clock.
  const targetBudget = options.targetBudget ?? 100;
  let attempted = 0;

  for (const request of requests) {
    const problems: string[] = [];
    let succeeded = 0;
    // Distinguish "I stopped early" from "I finished". Completing a request
    // whose targets were never fetched is the exact defect this file's header
    // opens by naming, and it is only avoidable if the loop records WHY it ended.
    let stoppedEarly = false;

    for (const target of request.targets) {
      if (signal?.aborted || attempted >= targetBudget) {
        stoppedEarly = true;
        break;
      }
      attempted += 1;
      // Only GitHub is implemented. A row naming another provider is recorded
      // as unresolved rather than silently completed — a queue that reports
      // success for work it cannot do is the defect this file exists to fix.
      if ((target.provider ?? 'github') !== 'github') {
        problems.push(`${target.entityId}: provider ${String(target.provider)} is not implemented`);
        unresolved += 1;
        continue;
      }

      // PER-TARGET, and this catch is load-bearing. `Db.rpc` throws on any
      // Postgres error, so without it a single 42501 or statement timeout on
      // one apply propagates out of the tick and abandons every OTHER request
      // already claimed in this batch, leaving them `running` until the stale
      // window. One bad row would take the batch down with it, every tick.
      let outcome: string;
      try {
        outcome = await refreshOne(options.db, claims, client, target, signal);
      } catch (error) {
        outcome = `apply failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      if (outcome === 'refreshed') {
        refreshed += 1;
        succeeded += 1;
      } else if (outcome === 'rate_limited') {
        rateLimited = true;
        stoppedEarly = true;
        break;
      } else {
        problems.push(`${target.entityId}: ${outcome}`);
        unresolved += 1;
      }
    }

    if (stoppedEarly) {
      // LEAVE IT CLAIMED AND UNFINISHED — do not complete it.
      //
      // `started_at` is set, so 081's stale window returns it to the queue and a
      // later tick resumes it. Completing here is what would write a success
      // receipt for work no process did; the abort signal fires on every
      // shutdown and every job timeout, so this is an ordinary path, not an
      // exotic one.
      abandoned += 1;
      if (rateLimited) break;
      continue;
    }

    // PARTIAL SUCCESS IS SUCCESS, and now actually is: `failed` only when
    // nothing was learned. The problems ride along in `error` either way, so a
    // nine-of-ten result is visible rather than averaged into a lie.
    const status = succeeded > 0 || problems.length === 0 ? 'completed' : 'failed';
    try {
      await options.db.rpc(claims, 'public.complete_tracking_refresh', [
        request.requestId,
        problems.length > 0 ? problems.slice(0, 10).join('; ') : null,
        status,
      ]);
    } catch (error) {
      // Swallowing this silently is how you get an invisible loop: the row stays
      // `running`, the stale window hands it back, and the next tick re-fetches
      // every target from scratch and fails the same way — burning provider
      // quota with nothing in the log to explain it.
      ctxLogger?.(
        `tracking.observer: could not complete request ${request.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    affected: refreshed,
    detail: {
      requests: requests.length,
      refreshed,
      unresolved,
      abandoned,
      rateLimited,
      authenticated: client.authenticated,
    },
  };
}

async function refreshOne(
  db: Db,
  claims: DbClaims,
  client: GithubClient,
  target: ClaimedTarget,
  signal: AbortSignal | undefined,
): Promise<'refreshed' | 'rate_limited' | string> {
  if (!target.repo) return 'no repo recorded';

  if (target.kind === 'pull_request') {
    if (target.number === null) return 'no pull request number recorded';
    const res = await client.pullRequest(target.repo, target.number, signal);
    if (!res.ok) return res.reason === 'rate_limited' ? 'rate_limited' : `${res.reason}: ${res.detail}`;
    // This door sends no `if-none-match` (an explicit refresh REQUEST means
    // someone wants the facts re-read), so a 304 here would be the provider
    // answering a question we did not ask. Treated as "learned nothing" rather
    // than asserted as a refresh.
    if (res.notModified === true) return 'provider answered 304 to an unconditional request';
    await db.rpc(claims, 'public.apply_pull_request_facts', [
      target.entityId,
      res.value.title,
      res.value.state,
      res.value.headSha,
      null,
      res.value.headRef,
      res.value.baseRef,
      res.value.mergeableState,
    ]);
    return 'refreshed';
  }

  if (target.sha === null) return 'no commit sha recorded';
  const res = await client.commit(target.repo, target.sha, signal);
  if (!res.ok) return res.reason === 'rate_limited' ? 'rate_limited' : `${res.reason}: ${res.detail}`;
  if (res.notModified === true) return 'provider answered 304 to an unconditional request';
  await db.rpc(claims, 'public.apply_commit_facts', [
    target.entityId,
    res.value.message,
    res.value.author,
    res.value.committedAt,
    res.value.url,
  ]);
  return 'refreshed';
}

/** The door returns jsonb; parse it defensively rather than casting and hoping. */
function normalizeClaimed(raw: unknown): ClaimedRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimedRequest[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.requestId !== 'string' || typeof row.spaceId !== 'string') continue;
    const targets: ClaimedTarget[] = [];
    for (const t of Array.isArray(row.targets) ? row.targets : []) {
      if (typeof t !== 'object' || t === null) continue;
      const target = t as Record<string, unknown>;
      if (typeof target.entityId !== 'string') continue;
      if (target.kind !== 'pull_request' && target.kind !== 'commit') continue;
      targets.push({
        entityId: target.entityId,
        kind: target.kind,
        provider: typeof target.provider === 'string' ? target.provider : null,
        repo: typeof target.repo === 'string' ? target.repo : null,
        number: typeof target.number === 'number' ? target.number : null,
        sha: typeof target.sha === 'string' ? target.sha : null,
      });
    }
    out.push({
      requestId: row.requestId,
      spaceId: row.spaceId,
      attempts: typeof row.attempts === 'number' ? row.attempts : 0,
      targets,
    });
  }
  return out;
}

export function createTrackingObserverJob(options: TrackingObserverOptions): ScheduledJob {
  return {
    name: TRACKING_OBSERVER_JOB_NAME,
    // A minute is short enough that `tracking.refresh`'s 202 becomes true
    // quickly, and long enough that an idle node is not polling Postgres for
    // nothing. The claim is indexed on `(created_at) where status='queued'`, so
    // an empty queue costs one index probe.
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runTrackingObserverTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}

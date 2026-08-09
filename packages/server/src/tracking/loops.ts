/**
 * The forge WATCHER — one tick of "did anything happen to the PRs we own".
 *
 * 081's observer drains a queue: somebody asked, so it looked. That is a
 * state-fetcher, and a state-fetcher cannot close a loop, because nobody is
 * asking. This tick is the complement: it decides for itself what to look at
 * (084 §G's watch list — open PRs a task tracks), computes a SEMANTIC DIFF
 * against stored facts, and turns the diff into messages in the owning
 * session's inbox.
 *
 * The shape, and the reasoning behind each part:
 *
 *   * CONDITIONAL EVERY TIME. Every REST read carries the stored ETag and a 304
 *     is a first-class answer meaning "leave the row alone". Without it a
 *     one-minute interval over twenty PRs is 1200 requests an hour against a
 *     5000 budget, spent almost entirely re-downloading identical JSON.
 *
 *   * THE DIFF IS COMPUTED IN POSTGRES, not here. `apply_pr_check_facts` and
 *     `apply_pr_review_thread_facts` compare against the previous observation
 *     in the same statement that overwrites it (084 §H). Doing it here would
 *     mean reading the old facts, comparing, then writing — three round trips
 *     with a window in the middle where two observer nodes both decide the same
 *     check "just went red" and both nudge.
 *
 *   * PER-TARGET FAILURE IS PER-TARGET, exactly as 081's tick already insisted.
 *     A PR that 404s does not end the tick for the nineteen behind it.
 *
 *   * A RATE LIMIT STOPS THE TICK AND MARKS NOTHING. "GitHub asked us to slow
 *     down" is not evidence about a pull request — 081's rule, unchanged,
 *     because it is right.
 *
 * Ledger events are 082's and are not re-authored here: writing state through
 * `apply_pull_request_facts` is what fires `git.pr_state_changed`, so a merge
 * observed by this watcher is watchable by `tm8 event watch` through exactly
 * the same door as a merge observed any other way.
 */

import type { Db, DbClaims } from '../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../scheduler/types.js';
import { GithubClient, resolveGithubToken, type CheckRunFacts, type ReviewThreadFacts } from './github.js';
import { decideNudges, deliverNudges, type PendingNudge, type WatchTarget } from './nudges.js';

export const FORGE_WATCHER_JOB_NAME = 'tracking.forge-watcher';

export interface ForgeWatcherOptions {
  db: Db;
  /** Same identity story as 081's observer: the doors have no node-admin bypass. */
  claims: () => Promise<DbClaims>;
  client?: GithubClient;
  /** PRs per tick. Small: this is a watcher, not a backfill. */
  targetBudget?: number;
  /**
   * A floor on how often ONE pull request may be re-polled, independent of how
   * often the tick runs. Without it, shortening the interval to make the loop
   * feel responsive multiplies provider traffic by the same factor.
   */
  minAgeSeconds?: number;
  /** Log lines inlined into a CI failure nudge. */
  logTailLines?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

export interface ForgeWatchTickDetail extends Record<string, unknown> {
  targets: number;
  notModified: number;
  nudgesDelivered: number;
  nudgesDeduped: number;
  nudgesCapped: number;
  suppressed: number;
  rateLimited: boolean;
  problems: string[];
}

/**
 * One tick. Exported separately from the job wrapper so a test (and
 * `scheduler.runNow`) can drive it with no timer in the way — the same
 * affordance 081 gave `runTrackingObserverTick`, for the same reason.
 */
export async function runForgeWatchTick(
  options: ForgeWatcherOptions,
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const client = options.client ?? new GithubClient({ token: resolveGithubToken() });
  const claims = await options.claims();
  const budget = options.targetBudget ?? 25;

  const listed = await options.db.rpc<{ targets?: unknown }>(
    claims,
    'public.observer_watch_targets',
    [budget, options.minAgeSeconds ?? 0],
  );
  const targets = normalizeTargets(listed?.targets);
  if (targets.length === 0) {
    return { skipped: true, reason: 'no watched pull requests' };
  }

  const detail: ForgeWatchTickDetail = {
    targets: targets.length,
    notModified: 0,
    nudgesDelivered: 0,
    nudgesDeduped: 0,
    nudgesCapped: 0,
    suppressed: 0,
    rateLimited: false,
    problems: [],
  };

  for (const target of targets) {
    if (signal?.aborted) break;
    try {
      const stopped = await watchOne(options, claims, client, target, detail, signal);
      if (stopped === 'rate_limited') {
        detail.rateLimited = true;
        break;
      }
    } catch (error) {
      // Load-bearing, for 081's reason: `Db.rpc` throws on any Postgres error,
      // and one 42501 must not abandon the other twenty-four PRs in the tick.
      detail.problems.push(`${target.repo}#${String(target.number)}: ${describe(error)}`);
      log?.(`tracking.forge-watcher: ${target.repo}#${String(target.number)}: ${describe(error)}`);
    }
  }

  // Bounded: this rides in a job outcome that gets logged, and an unbounded
  // list of provider errors is how a log becomes unreadable.
  detail.problems = detail.problems.slice(0, 10);
  return { affected: detail.nudgesDelivered, detail };
}

async function watchOne(
  options: ForgeWatcherOptions,
  claims: DbClaims,
  client: GithubClient,
  target: WatchTarget,
  detail: ForgeWatchTickDetail,
  signal: AbortSignal | undefined,
): Promise<'ok' | 'rate_limited'> {
  if (target.provider !== 'github') {
    detail.problems.push(`${target.repo}#${String(target.number)}: provider ${target.provider} is not implemented`);
    return 'ok';
  }

  // The sha the watch list carried. Kept because `target.headSha` is updated
  // below when the pull request read reports a push, and the ETag batched here
  // was keyed on the OLD one.
  const listedSha = target.headSha;
  const prKey = `gh:pr:${target.repo}#${String(target.number)}`;
  const etags = await options.db.rpc<Record<string, string>>(
    claims,
    'public.provider_etag_lookup',
    [target.spaceId, [prKey, checksKey(target, listedSha)]],
  );

  // ---- 1. The pull request itself.
  const pr = await client.pullRequest(target.repo, target.number, signal, etags[prKey] ?? null);
  if (!pr.ok) {
    if (pr.reason === 'rate_limited') return 'rate_limited';
    detail.problems.push(`${target.repo}#${String(target.number)}: ${pr.reason}: ${pr.detail}`);
    return 'ok';
  }

  let headSha = target.headSha;
  let previousMergeable = null as string | null;
  let mergeable = null as string | null;

  if (pr.notModified === true) {
    detail.notModified += 1;
    await options.db.rpc(claims, 'public.provider_etag_record', [target.spaceId, prKey, null, true]);
    // 304 means the stored row IS current. Carrying the stored mergeable state
    // forward on both sides of the comparison is what stops an unchanged PR
    // from looking like a transition into conflict on every tick.
    previousMergeable = target.mergeableState;
    mergeable = target.mergeableState;
  } else {
    const applied = await options.db.rpc<{
      previousMergeableState?: string | null;
      mergeableState?: string | null;
      headSha?: string | null;
    }>(claims, 'public.apply_pull_request_facts', [
      target.prEntityId,
      pr.value.title,
      pr.value.state,
      pr.value.headSha,
      // ci_status is NOT written here: the check-run rollup below is the only
      // honest source for it, and writing a guess first would flap the column
      // (and 082's completion gate with it) twice per tick.
      null,
      pr.value.headRef,
      pr.value.baseRef,
      pr.value.mergeableState,
    ]);
    await options.db.rpc(claims, 'public.provider_etag_record', [
      target.spaceId,
      prKey,
      pr.etag,
      false,
    ]);
    headSha = pr.value.headSha ?? headSha;
    previousMergeable = applied.previousMergeableState ?? null;
    mergeable = applied.mergeableState ?? null;
    target.headRef = pr.value.headRef ?? target.headRef;
    target.baseRef = pr.value.baseRef ?? target.baseRef;
    target.state = pr.value.state;
  }
  target.headSha = headSha;

  // ---- 2. CI checks for the head commit.
  //
  // The ETag is looked up AFTER the pull request read, because the read is what
  // tells us the sha. Looking it up in the batch above — keyed on the sha the
  // watch list carried — misses on the exact tick a push landed, which is the
  // one tick where the checks matter most, and turns that fetch unconditional.
  // One extra cheap round trip buys a conditional request on every tick.
  let newlyFailing: CheckRunFacts[] = [];
  if (headSha !== null) {
    const key = checksKey(target, headSha);
    const checkEtags = headSha === listedSha
      ? etags
      : await options.db.rpc<Record<string, string>>(
          claims,
          'public.provider_etag_lookup',
          [target.spaceId, [key]],
        );
    const runs = await client.checkRuns(target.repo, headSha, signal, checkEtags[key] ?? null);
    if (!runs.ok) {
      if (runs.reason === 'rate_limited') return 'rate_limited';
      detail.problems.push(`${target.repo}#${String(target.number)} checks: ${runs.reason}: ${runs.detail}`);
    } else if (runs.notModified === true) {
      detail.notModified += 1;
      await options.db.rpc(claims, 'public.provider_etag_record', [target.spaceId, key, null, true]);
    } else {
      const applied = await options.db.rpc<{ newlyFailing?: unknown; ciStatus?: string | null }>(
        claims,
        'public.apply_pr_check_facts',
        [target.prEntityId, headSha, JSON.stringify(runs.value)],
      );
      await options.db.rpc(claims, 'public.provider_etag_record', [
        target.spaceId,
        key,
        runs.etag,
        false,
      ]);
      // The rollup comes back from the same door that stored the rows, so the
      // column and the facts behind it cannot disagree.
      if (applied.ciStatus !== null && applied.ciStatus !== undefined) {
        await options.db.rpc(claims, 'public.apply_pull_request_facts', [
          target.prEntityId, null, null, null, applied.ciStatus, null, null, null,
        ]);
      }
      newlyFailing = normalizeChecks(applied.newlyFailing);
    }
  }

  // ---- 3. Review threads. GraphQL, unconditional (github.ts explains why).
  let newlyUnresolved: ReviewThreadFacts[] = [];
  const threads = await client.reviewThreads(target.repo, target.number, signal);
  if (!threads.ok) {
    if (threads.reason === 'rate_limited') return 'rate_limited';
    // An unauthenticated node cannot read review threads at all. That is a
    // known, permanent condition rather than a per-PR incident, so it is not
    // worth a problem line per pull request per tick.
    if (threads.reason !== 'unauthorized') {
      detail.problems.push(`${target.repo}#${String(target.number)} threads: ${threads.reason}: ${threads.detail}`);
    }
  } else if (threads.notModified !== true) {
    const applied = await options.db.rpc<{ newlyUnresolved?: unknown }>(
      claims,
      'public.apply_pr_review_thread_facts',
      [target.prEntityId, JSON.stringify(threads.value.map(toThreadFact))],
    );
    const keys = new Set(normalizeThreadKeys(applied.newlyUnresolved));
    // The door reports WHICH threads are new; the comment bodies to inline come
    // from the response we already hold, so the nudge needs no extra fetch.
    newlyUnresolved = threads.value.filter((t) => keys.has(t.threadKey));
  }

  // ---- 4. Decide, fetch only the logs a decision actually needs, deliver.
  const diff = {
    newlyFailing,
    newlyUnresolved,
    previousMergeableState: previousMergeable,
    mergeableState: mergeable,
  };

  // TWO PASSES, and the order is the saving. The first decides with no logs,
  // which is enough to know WHICH nudges survive suppression and dedup shape;
  // the log fetch — the most expensive call in the tick — then happens only for
  // those, and the second pass folds the tails into the bodies. Fetching first
  // would spend a log download on every red check of every exited session.
  const decision = decideNudges(target, diff, new Map());
  detail.suppressed += decision.suppressed.length;
  if (decision.nudges.length === 0) return 'ok';

  const tails = await fetchLogTails(client, target, newlyFailing, decision.nudges, options, signal);
  const finalDecision = tails.size === 0 ? decision : decideNudges(target, diff, tails);

  const delivery = await deliverNudges(options.db, claims, finalDecision.nudges);
  detail.nudgesDelivered += delivery.delivered;
  detail.nudgesDeduped += delivery.duplicates;
  detail.nudgesCapped += delivery.capped;
  for (const problem of delivery.failed) detail.problems.push(problem);
  return 'ok';
}

async function fetchLogTails(
  client: GithubClient,
  target: WatchTarget,
  checks: readonly CheckRunFacts[],
  nudges: readonly PendingNudge[],
  options: ForgeWatcherOptions,
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  const wanted = new Set(nudges.filter((n) => n.loop === 'ci_failure').map((n) => n.scopeKey));
  const tails = new Map<string, string>();
  for (const check of checks) {
    if (check.externalId === null) continue;
    if (!wanted.has(`${check.name}@${target.headSha ?? 'unknown'}`)) continue;
    const res = await client.jobLogTail(
      target.repo,
      check.externalId,
      options.logTailLines ?? 100,
      signal,
    );
    // A missing log is not a reason to withhold the nudge — the agent still
    // needs to know the check went red. `decideNudges` says so in the body.
    if (res.ok && res.notModified !== true) tails.set(check.name, res.value);
  }
  return tails;
}

function checksKey(target: { repo: string }, sha: string | null): string {
  return `gh:checks:${target.repo}@${sha ?? 'unknown'}`;
}

function toThreadFact(thread: ReviewThreadFacts): Record<string, unknown> {
  return {
    threadKey: thread.threadKey,
    path: thread.path,
    line: thread.line,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    commentCount: thread.comments.length,
    author: thread.comments[0]?.author ?? null,
    bodyExcerpt: thread.comments[0]?.body ?? '',
  };
}

/** The doors return jsonb; parse defensively rather than casting and hoping. */
export function normalizeTargets(raw: unknown): WatchTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.prEntityId !== 'string' || typeof row.spaceId !== 'string') continue;
    if (typeof row.repo !== 'string' || typeof row.number !== 'number') continue;
    out.push({
      prEntityId: row.prEntityId,
      spaceId: row.spaceId,
      provider: typeof row.provider === 'string' ? row.provider : 'github',
      repo: row.repo,
      number: row.number,
      state: typeof row.state === 'string' ? row.state : 'open',
      headSha: typeof row.headSha === 'string' ? row.headSha : null,
      headRef: typeof row.headRef === 'string' ? row.headRef : null,
      baseRef: typeof row.baseRef === 'string' ? row.baseRef : null,
      taskId: typeof row.taskId === 'string' ? row.taskId : null,
      owningSessionId: typeof row.owningSessionId === 'string' ? row.owningSessionId : null,
      owningSessionStatus: typeof row.owningSessionStatus === 'string' ? row.owningSessionStatus : null,
      owningSessionLive: row.owningSessionLive === true,
      stackedOnOpenParent: row.stackedOnOpenParent === true,
      mergeableState: typeof row.mergeableState === 'string' ? row.mergeableState : null,
    });
  }
  return out;
}

function normalizeChecks(raw: unknown): CheckRunFacts[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckRunFacts[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string') continue;
    out.push({
      name: row.name,
      status: typeof row.status === 'string' ? row.status : 'completed',
      conclusion: typeof row.conclusion === 'string' ? row.conclusion : null,
      externalId: typeof row.externalId === 'string' ? row.externalId : null,
      detailsUrl: typeof row.detailsUrl === 'string' ? row.detailsUrl : null,
      startedAt: null,
      completedAt: null,
    });
  }
  return out;
}

function normalizeThreadKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const key = (entry as Record<string, unknown>).threadKey;
    if (typeof key === 'string') out.push(key);
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createForgeWatcherJob(options: ForgeWatcherOptions): ScheduledJob {
  return {
    name: FORGE_WATCHER_JOB_NAME,
    // Ninety seconds, with `minAgeSeconds` as the real throttle. The interval
    // governs how quickly a NEW pull request enters the watch list; how often
    // any one of them is re-read is 084 §G's floor, and separating the two is
    // what lets the loop feel responsive without multiplying provider traffic.
    intervalMs: options.intervalMs ?? 90_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? false,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runForgeWatchTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}

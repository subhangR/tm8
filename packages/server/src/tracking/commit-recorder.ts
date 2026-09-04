/**
 * The commit recorder — session → commit provenance, observed locally.
 *
 * The 081 observer answers "what does GitHub say about artifacts someone
 * already linked". This job answers the question nobody was answering: WHICH
 * SESSION PRODUCED WHICH COMMIT, before anything is pushed or linked. It
 * walks every ACTIVE worktree that has a session (`in_worktree` edge), lists
 * the commits the lane produced beyond its recorded base (argv git, local,
 * read-only), and records each through `public.record_session_commit` (082)
 * — which find-or-creates the commit mirror entity and stamps the
 * `created_in` edge commit → work_session.
 *
 * From there provenance is ordinary graph data: "which session produced
 * commit X" is an edge read, and the 082 capture trigger has already put a
 * `git.commit_recorded` event on the ledger for every new mirror.
 *
 * Idempotence lives in the DOOR (dedupe on space+provider+repo+sha; edge
 * insert is `on conflict do nothing`), so this job may observe the same
 * commit forever without harm. The in-process `seen` set only keeps the
 * steady state from re-calling the door for every known sha every tick.
 */
import type { Db, DbClaims } from '../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../scheduler/types.js';
import { commitsAhead, repoFromUrl } from './git-local.js';

export const COMMIT_RECORDER_JOB_NAME = 'tracking.commit_recorder';

export interface CommitRecorderOptions {
  db: Db;
  /** Same posture as the tracking observer: the node's loopback owner. */
  claims: () => Promise<DbClaims>;
  /** Worktrees per tick — a poller, not a backfill. */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

interface LaneRow {
  worktree_id: string;
  path: string;
  base_commit_oid: string;
  session_id: string;
  repo_url: string | null;
  project_name: string;
}

/**
 * The prefix that says "this is not a forge repository, and no join against a
 * pull request mirror's `repo` should ever succeed against it".
 *
 * A project with no remote url still produces commits worth recording — the
 * session→commit provenance edge is the whole point of this job, and it is
 * useful whether or not the code was ever pushed. But the value written into
 * `public.commits.repo` used to be the bare PROJECT NAME, and that is wrong in
 * both directions:
 *
 *   - It can never match. `internal.pr_owning_session` tier 2 (103:359) joins
 *     `c.repo = pr.repo`, where `pr.repo` is always a forge `owner/name`. A
 *     project called "tm8" never equals that, so tier 2 silently never fired
 *     for local-only projects — a dead code path that reads as working.
 *   - It can match the WRONG thing. Nothing stops a project being NAMED
 *     `acme/forge`, at which point its purely local commits join an unrelated
 *     pull request mirror and hand that PR's session an addressee it never
 *     produced. Same failure class as the 148 branch-name leak.
 *
 * `local:` cannot be either, because a forge slug is `owner/name` and this is
 * not. One-time cost of the change: a repo_url-less project whose commits were
 * already recorded under the bare name gets a second mirror entity for the same
 * sha (the dedupe key in `record_session_commit` is space+provider+repo+sha).
 * That is a cosmetic duplicate on a path that was already producing an
 * unjoinable value, not a regression.
 */
const LOCAL_REPO_PREFIX = 'local:';

/**
 * The `repo` a lane's commits are recorded under: the forge slug when the
 * project has a remote we can read one from, and an explicitly non-forge
 * marker when it does not. Never a value that merely LOOKS like a slug.
 */
export function laneRepo(repoUrl: string | null, projectName: string): string {
  return repoFromUrl(repoUrl) ?? `${LOCAL_REPO_PREFIX}${projectName}`;
}

/** Cap the memo so a long-lived node cannot grow it unbounded. */
const SEEN_CAP = 20_000;
const seen = new Set<string>();

function remember(key: string): void {
  if (seen.size >= SEEN_CAP) seen.clear();
  seen.add(key);
}

export async function runCommitRecorderTick(
  options: CommitRecorderOptions,
  signal?: AbortSignal,
): Promise<JobOutcome> {
  const claims = await options.claims();

  const lanes = await options.db.query<LaneRow>(
    claims,
    `select w.entity_id as worktree_id, w.path, w.base_commit_oid,
            e.src_id as session_id, p.repo_url, p.name as project_name
       from public.worktrees w
       join public.edges e on e.dst_id = w.entity_id and e.type = 'in_worktree'
       join public.projects p on p.id = w.project_id
      where w.status = 'active'
      order by w.updated_at desc
      limit $1`,
    [options.batchSize ?? 20],
  );
  if (lanes.length === 0) {
    return { skipped: true, reason: 'no active worktrees with a session' };
  }

  let recorded = 0;
  let unreadable = 0;
  for (const lane of lanes) {
    if (signal?.aborted) break;
    const commits = await commitsAhead(lane.path, lane.base_commit_oid, 100, signal);
    if (commits === null) {
      unreadable += 1;
      continue;
    }
    const repo = laneRepo(lane.repo_url, lane.project_name);
    for (const commit of commits) {
      const key = `${lane.worktree_id}:${commit.sha}`;
      if (seen.has(key)) continue;
      try {
        await options.db.rpc(claims, 'public.record_session_commit', [
          lane.session_id,
          repo,
          commit.sha,
          commit.subject === '' ? null : commit.subject,
          commit.author,
          commit.committedAt,
        ]);
        remember(key);
        recorded += 1;
      } catch {
        // A dead session entity or a race with lane teardown: skip, retry
        // next tick. The door is idempotent, so retrying is free.
      }
    }
  }

  return {
    affected: recorded,
    detail: { lanes: lanes.length, recorded, unreadable },
  };
}

export function createCommitRecorderJob(options: CommitRecorderOptions): ScheduledJob {
  return {
    name: COMMIT_RECORDER_JOB_NAME,
    // A minute matches the tracking observer: provenance is durable truth, not
    // a live feed, and the ledger event fires the moment the door records.
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runCommitRecorderTick(options, ctx.signal);
    },
  };
}

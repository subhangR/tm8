import { useCallback, useEffect, useState } from 'react';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { Pill } from '../kit';
import {
  LinkedPullRequestChips,
  pullRequestFactsOf,
  type LinkedPullRequestFacts,
} from '../pull-requests';
import './session-git.css';

/**
 * THE SESSION'S GIT GRAPH FACTS — what the graph already knows about this
 * session's git life, answerable with or WITHOUT an operable worktree:
 *
 *   · commits this session produced (`created_in` edges, recorder-stamped);
 *   · pull requests its work tracks (session → `working_on` → task →
 *     `tracks` → PR), rendered through Lane B's chips — consumed, not forked;
 *   · the lane entity itself (`in_worktree`), with its branch and status.
 *
 * WHY THIS IS A SEPARATE BLOCK FROM THE RAIL'S STATUS/VERBS: those read the
 * CHECKOUT through `execution.gitStatus`/`gitDiff`, which honestly refuse
 * when the session has no worktree — and before this block existed that
 * refusal took the whole Git tab with it, hiding graph facts that never
 * depended on a checkout. The reason card stays; the history does not vanish
 * behind it. (Raised live on the running node: a scratch session's Git tab
 * was a dead end even while its commits and PR links sat in the graph.)
 *
 * SELF-FETCHING over `seam.connections`, the same read the Connections tab
 * and TaskGitSection use. One read per mount — the rail's status poll is the
 * live half; this is the durable-graph half.
 *
 * RENDERS NOTHING when every fact set is empty: on a fresh scratch session
 * the unavailable card is already the whole honest answer, and an empty
 * "history" frame under it would be noise claiming to be information.
 */

const COMMIT_DISPLAY_CAP = 20;
/** working_on fan-out guard — a session working five tasks is already odd. */
const TASK_FANOUT_CAP = 5;

export interface SessionGitFactsProps {
  seam: Seam;
  sessionId: EntityId;
}

interface CommitRow {
  id: string;
  sha: string;
  message: string;
}

interface LaneRow {
  id: string;
  title: string;
  branch: string | null;
  status: string | null;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; lane: LaneRow | null; prs: LinkedPullRequestFacts[]; commits: CommitRow[] };

function peerOf(edge: EdgeView, anchorId: string): EntitySummary {
  return edge.source.id === anchorId ? edge.target : edge.source;
}

/** Structural, like `pullRequestFactsOf` — no kind literals beyond the state's own. */
function commitRowOf(row: EntitySummary): CommitRow | null {
  const state = row.state as unknown as Record<string, unknown>;
  if (state.kind !== 'commit') return null;
  return {
    id: row.id,
    sha: typeof state.sha === 'string' ? state.sha : '',
    message: typeof state.message === 'string' ? state.message : row.title,
  };
}

function laneRowOf(row: EntitySummary): LaneRow | null {
  const state = row.state as unknown as Record<string, unknown>;
  if (state.kind !== 'worktree') return null;
  return {
    id: row.id,
    title: row.title,
    branch: typeof state.branch === 'string' ? state.branch : null,
    status: typeof state.status === 'string' ? state.status : null,
  };
}

export function SessionGitFacts({ seam, sessionId }: SessionGitFactsProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    try {
      const [createdIn, inWorktree, workingOn] = await Promise.all([
        seam.connections(sessionId, { types: ['created_in'], limit: 100 }),
        seam.connections(sessionId, { types: ['in_worktree'], limit: 5 }),
        seam.connections(sessionId, { types: ['working_on'], limit: 10 }),
      ]);

      const commits: CommitRow[] = [];
      for (const edge of createdIn.items) {
        const row = commitRowOf(peerOf(edge, sessionId));
        if (row !== null) commits.push(row);
      }

      let lane: LaneRow | null = null;
      for (const edge of inWorktree.items) {
        lane = laneRowOf(peerOf(edge, sessionId));
        if (lane !== null) break;
      }

      // PRs arrive through the session's task(s): the `tracks` edge lives on
      // the task, and that indirection is the truth — the session works the
      // task, the task tracks the PR.
      const prs: LinkedPullRequestFacts[] = [];
      const prSeen = new Set<string>();
      const tasks = workingOn.items.map((e) => peerOf(e, sessionId)).slice(0, TASK_FANOUT_CAP);
      await Promise.all(
        tasks.map(async (task) => {
          try {
            const tracked = await seam.connections(task.id as EntityId, { types: ['tracks'], limit: 100 });
            for (const edge of tracked.items) {
              const facts = pullRequestFactsOf(peerOf(edge, task.id));
              if (facts !== null && !prSeen.has(facts.id)) {
                prSeen.add(facts.id);
                prs.push(facts);
              }
            }
          } catch {
            // One task's tracks read failing must not hide the others' PRs —
            // an absent row is an absent claim, not a wrong one.
          }
        }),
      );

      setState({ phase: 'ready', lane, prs, commits });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Git graph read failed',
      });
    }
  }, [seam, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') return null;
  if (state.phase === 'error') {
    return (
      <p className="pn-git__note" data-testid="session-git-facts-error">
        Git graph facts unavailable: {state.message}
      </p>
    );
  }

  const { lane, prs, commits } = state;
  if (lane === null && prs.length === 0 && commits.length === 0) return null;

  const shown = commits.slice(0, COMMIT_DISPLAY_CAP);

  return (
    <div className="pn-git__facts" data-testid="session-git-facts">
      {lane !== null ? (
        <div className="pn-git__facts-row" data-testid="session-git-lane">
          <span className="pn-git__facts-label">Lane</span>
          <span className="pn-git__lane-title" title={lane.title}>
            <span aria-hidden className="pn-git__branch-glyph">⎇</span>
            {lane.branch ?? lane.title}
          </span>
          {lane.status !== null ? <Pill tone={lane.status === 'active' ? 'run' : 'idle'}>{lane.status}</Pill> : null}
        </div>
      ) : null}

      {prs.length > 0 ? (
        <div className="pn-git__facts-row" data-testid="session-git-prs">
          <span className="pn-git__facts-label">Pull requests</span>
          <LinkedPullRequestChips pullRequests={prs} placement="detail" />
        </div>
      ) : null}

      {commits.length > 0 ? (
        <div className="pn-git__facts-row pn-git__facts-row--commits">
          <span className="pn-git__facts-label">Commits from this session</span>
          <ul className="pn-git__commit-list" data-testid="session-git-commits">
            {shown.map((c) => (
              <li key={c.id}>
                <code className="pn-git__commit-sha">{c.sha ? c.sha.slice(0, 10) : '—'}</code>
                <span className="pn-git__commit-message" title={c.message}>{c.message}</span>
              </li>
            ))}
            {commits.length > shown.length ? (
              <li className="pn-git__note">…{commits.length - shown.length} more recorded</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

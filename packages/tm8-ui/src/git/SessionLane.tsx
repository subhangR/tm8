import { Pill, type PillTone } from '../kit';
import './session-git.css';

/**
 * THE ONE LANE LINE (107, user ruling 2026-08-13): `⎇ branch · [mode]`,
 * rendered identically wherever a session shows its git identity — the
 * session tile (beside the PR chips) and the session Git tab. A session must
 * always answer "what am I working on, git-wise" without requiring a
 * worktree, and this line is that answer.
 *
 * THE BADGE CARRIES THE HONESTY:
 *   · `worktree` — the session's own attributable lane; the branch is yours.
 *   · `shared`   — a shared project checkout; the branch is NOT exclusively
 *                  this session's, and any terminal can move it.
 *   · (scratch)  — no repo, no branch, and therefore NO LANE LINE AT ALL:
 *                  honest absence renders no claim, never a placeholder.
 *
 * READS THE SUMMARY STATE STRUCTURALLY (like `pullRequestFactsOf`): the lane
 * facts are `checkoutBranch` + `workdirMode`, both additive-and-optional —
 * a summary from a pre-107 server carries neither and gets `null` here,
 * which renders nothing. The mode comes from the projected FACT rather than
 * the `in_worktree` edge because the bounded graph page can miss an edge;
 * the DB fact rides on every summary read and cannot.
 */

export type SessionLaneMode = 'worktree' | 'shared' | 'scratch';

export interface SessionLaneFacts {
  branch: string;
  /** `null` when the summary predates the workdirMode fact — no badge. */
  mode: SessionLaneMode | null;
}

const MODE_TONE: Record<SessionLaneMode, PillTone> = {
  worktree: 'run',
  shared: 'wait',
  scratch: 'idle',
};

const MODE_TITLE: Record<SessionLaneMode, string> = {
  worktree: 'This session’s own isolated worktree — the branch is attributable to it.',
  shared: 'A shared project checkout — this branch is not exclusively this session’s.',
  scratch: 'A scratch directory with no project repository.',
};

/**
 * The session's lane facts from a work_session summary `state`, or `null`
 * when there is no claim to render: no branch fact (scratch, detached HEAD,
 * never captured) or a pre-107 summary.
 */
export function sessionLaneOf(state: unknown): SessionLaneFacts | null {
  if (typeof state !== 'object' || state === null) return null;
  const record = state as Record<string, unknown>;
  if (record.kind !== 'work_session') return null;
  const branch = typeof record.checkoutBranch === 'string' ? record.checkoutBranch : null;
  if (branch === null || branch === '') return null;
  const mode =
    record.workdirMode === 'worktree'
      ? 'worktree'
      : record.workdirMode === 'project'
        ? 'shared'
        : record.workdirMode === 'scratch'
          ? 'scratch'
          : null;
  return { branch, mode };
}

/** The mode badge alone — the Git tab's ready header already draws the live
 *  branch, so it composes this beside it rather than a second branch name. */
export function SessionLaneModeBadge({ mode }: { mode: SessionLaneMode | null }) {
  if (mode === null) return null;
  return (
    <Pill tone={MODE_TONE[mode]} title={MODE_TITLE[mode]}>
      {mode}
    </Pill>
  );
}

/** `⎇ branch · [mode]` — pass `null` to render nothing (honest absence). */
export function SessionLaneLine({ lane }: { lane: SessionLaneFacts | null }) {
  if (lane === null) return null;
  return (
    <span className="pn-lane" data-testid="session-lane-line">
      <span className="pn-lane__branch" title={`branch ${lane.branch}`}>
        <span aria-hidden className="pn-git__branch-glyph">⎇</span>
        {lane.branch}
      </span>
      <SessionLaneModeBadge mode={lane.mode} />
    </span>
  );
}

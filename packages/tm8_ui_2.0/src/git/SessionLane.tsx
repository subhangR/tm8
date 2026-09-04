import { Pill, type PillTone, VectorIcon } from '../kit';
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
 *                  Drawn as the official worktree symbol, not the word.
 *   · `shared`   — a shared project checkout; the branch is NOT exclusively
 *                  this session's, and any terminal can move it. Drawn as a
 *                  link mark (same quiet ink as the worktree symbol), not a
 *                  word — every reader learns "not exclusive" from ONE glyph.
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

/**
 * THE OFFICIAL WORKTREE MARK — VS Code's `worktree` codicon
 * (microsoft/vscode-codicons, `src/icons/worktree.svg`, MIT), verbatim.
 *
 * The mode used to render as the WORD "worktree" in a green pill, which is
 * the loudest token on a session tile spent saying the ordinary case. There
 * is a real, official symbol for this concept, so we draw it instead of
 * naming it — and we take the one the wider tooling already ships rather
 * than invent a house glyph a reader would have to learn.
 *
 * A SOLID silhouette, hence `filled`: it is authored as a filled path and
 * must not be stroked (see `VectorIcon`). It is also why the house artwork
 * in `domain/kind-art.ts` is untouched — that grid is a stroked set and this
 * badge is not a kind mark.
 */
const WORKTREE_MARK = [
  'M12.854 14.8542L14.854 12.8542C15.049 12.6592 15.049 12.3422 14.854 12.1472L12.854 10.1472C12.659 9.95223 12.342 9.95223 12.147 10.1472C11.952 10.3422 11.952 10.6592 12.147 10.8542L13.293 12.0002H8.5C8.225 12.0002 8 11.7752 8 11.5002V5.50023C8 5.22523 8.225 5.00023 8.5 5.00023H13.293L12.147 6.14623C12.049 6.24423 12.001 6.37223 12.001 6.50023C12.001 6.62823 12.05 6.75623 12.147 6.85423C12.342 7.04923 12.659 7.04923 12.854 6.85423L14.854 4.85423C15.049 4.65923 15.049 4.34223 14.854 4.14723L12.854 2.14723C12.659 1.95223 12.342 1.95223 12.147 2.14723C11.952 2.34223 11.952 2.65923 12.147 2.85423L13.293 4.00023H8.5C7.673 4.00023 7 4.67323 7 5.50023V8.00023H1.5C1.224 8.00023 1 8.22423 1 8.50023C1 8.77623 1.224 9.00023 1.5 9.00023H7V11.5002C7 12.3272 7.673 13.0002 8.5 13.0002H13.293L12.147 14.1462C12.049 14.2442 12.001 14.3722 12.001 14.5002C12.001 14.6282 12.05 14.7562 12.147 14.8542C12.342 15.0492 12.659 15.0492 12.854 14.8542Z',
];

/**
 * THE SHARED MARK — a chain link, the familiar Feather/Lucide `link` glyph
 * (MIT), coordinates rescaled from its 24×24 source grid onto this kit's
 * fixed 16×16 `VectorIcon` viewBox. Two open, interlocking hooks read as
 * "linked to something else" at a glance — the same job `shared` used to do
 * as a word, now done as a mark so it costs the same quiet attention as the
 * worktree symbol beside it, per the same house rule.
 *
 * Left stroked (not `filled`): unlike the worktree mark this is a house
 * rendering of a well-known glyph rather than a borrowed solid silhouette,
 * so it draws in the same outline style as the rest of this kit's artwork.
 */
const LINK_MARK = [
  'M6.667 8.667a3.333 3.333 0 0 0 5.027 0.36l2 -2a3.333 3.333 0 0 0 -4.713 -4.713l-1.147 1.14',
  'M9.333 7.333a3.333 3.333 0 0 0 -5.027 -0.36l-2 2a3.333 3.333 0 0 0 4.713 4.713l1.14 -1.14',
];

/** The one mode that stays a WORD. `worktree` and `shared` draw symbols instead. */
const MODE_TONE: Record<Extract<SessionLaneMode, 'scratch'>, PillTone> = {
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
  // `worktree` and `shared` both have a symbol now, so both draw quiet marks
  // in the branch's own ink. Only `scratch` — a caveat with no symbol of its
  // own — keeps the toned WORD, which is the honesty the badge exists to carry.
  if (mode === 'worktree') {
    return (
      <VectorIcon
        paths={WORKTREE_MARK}
        filled
        size={13}
        className="pn-lane__worktree-mark"
        title={MODE_TITLE.worktree}
      />
    );
  }
  if (mode === 'shared') {
    return (
      <VectorIcon
        paths={LINK_MARK}
        size={13}
        className="pn-lane__shared-mark"
        title={MODE_TITLE.shared}
      />
    );
  }
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

// @vitest-environment jsdom
/**
 * THE CHANGES SURFACE, DRIVEN THROUGH A SCRIPTED SEAM.
 *
 * This file is not a render smoke test. It exists for the three things that
 * are invisible in a screenshot and wrong in a way a reviewer would trust:
 *
 *  1. WHICH COMPARISON WAS ASKED FOR. The chips are not decoration — `Staged`
 *     means `git diff --cached` and `Unstaged` means `git diff`, and a pane
 *     that renders the session diff under a "staged" heading is telling a
 *     reviewer that bytes they deliberately left out of the index are in the
 *     commit they are about to make.
 *
 *  2. WHICH ANSWER WINS WHEN TWO ARE IN FLIGHT. Chips, row clicks and the
 *     post-mutation refresh all fire reads, none of them are ordered by the
 *     network, and a late answer here is not merely stale — it is the answer
 *     to a DIFFERENT QUESTION rendered under the current question's heading.
 *     Both orderings are proven below, including the one where the late read
 *     is the component's own refresh.
 *
 *  3. THAT COMMIT NEVER SILENTLY WIDENS. `git commit` writes the whole index.
 *     A file staged outside the selection would ride along, so the surface
 *     refuses BY NAME before the click rather than discovering it after.
 *
 * The seam is scripted rather than the fixture seam because every one of
 * those is a statement about ORDER, and order is exactly what a fixture that
 * resolves immediately cannot express.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  EntityId,
  ExecutionGitCommitInput,
  ExecutionGitStageInput,
  SessionGitCommitResult,
  SessionGitDiff,
  SessionGitDiffScope,
  SessionGitFile,
  SessionGitStageResult,
  SessionGitStatus,
} from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import type { GitDiffOpts, Seam } from '../data/seam.js';
import { SessionChangesBody } from './SessionChangesBody.js';

const SESSION = '01900000-0000-7000-8000-0000000000c0' as EntityId;
const WORKTREE = '01900000-0000-7000-8000-0000000000c1' as EntityId;

/**
 * FOUR FILES, FOUR STATES — including the one a bucketing surface lies about.
 * `src/a.ts` is `MM`: staged AND unstaged, the same path with two different
 * pending changes. It must appear under both chips, and each chip must show a
 * different diff.
 */
const FILES: SessionGitFile[] = [
  { status: 'MM', path: 'src/a.ts' },
  { status: 'M ', path: 'src/b.ts' },
  { status: ' M', path: 'notes.md' },
  { status: '??', path: 'new.txt' },
];

function statusOf(files: SessionGitFile[]): SessionGitStatus {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    worktreeId: WORKTREE,
    branch: 'tm8/changes-lane',
    baseRef: 'origin/main',
    baseOid: 'b'.repeat(40),
    headOid: 'h'.repeat(40),
    ahead: 1,
    behind: 0,
    dirty: {
      staged: files.filter((f) => f.status[0] !== ' ' && f.status[0] !== '?').length,
      unstaged: files.filter((f) => f.status[1] !== ' ' && f.status[1] !== '?').length,
      untracked: files.filter((f) => f.status === '??').length,
      total: files.length,
    },
    files,
    filesTruncated: false,
    checkedAt: '2026-09-19T00:00:00Z',
  };
}

/** A diff whose BODY names the scope it came from, so a swap is visible. */
function diffOf(path: string, scope: SessionGitDiffScope): SessionGitDiff {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    branch: 'tm8/changes-lane',
    baseRef: 'origin/main',
    baseOid: 'b'.repeat(40),
    mergeBaseOid: 'b'.repeat(40),
    headOid: 'h'.repeat(40),
    stat: { filesChanged: 1, additions: 1, deletions: 0 },
    files: [{ path, additions: 1, deletions: 0 }],
    filesTruncated: false,
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${scope} body for ${path}\n`,
    diffTruncated: false,
    scope,
    path,
    untracked: false,
    checkedAt: '2026-09-19T00:00:00Z',
  };
}

type Deferred = {
  readonly path: string;
  readonly scope: SessionGitDiffScope;
  settle: () => void;
};

type Harness = {
  seam: Seam;
  /** Every gitDiff request, in the order the component made them. */
  readonly diffCalls: { path: string; scope: SessionGitDiffScope }[];
  /** Every gitStage request. */
  readonly stageCalls: ExecutionGitStageInput[];
  readonly commitCalls: ExecutionGitCommitInput[];
  /** Pending diff reads, when `holdDiffs` is on — settle them by hand. */
  readonly pending: Deferred[];
  holdDiffs: boolean;
  /** Pending stage mutation, when `holdStage` is on. */
  settleStage: (() => void) | null;
  holdStage: boolean;
  /**
   * What the NEXT status read will answer. Reassign it to move the repository
   * under the component the way a real mutation does.
   */
  files: SessionGitFile[];
  /**
   * Pending status reads, when `holdStatus` is on. Each one captured `files`
   * as they were WHEN IT WAS ISSUED, which is the whole point: settling them
   * out of order replays a slow poll answering about a repository that has
   * since moved on.
   */
  readonly pendingStatus: (() => void)[];
  holdStatus: boolean;
};

function harness(files: SessionGitFile[] = FILES, over: Partial<SessionGitStatus> = {}): Harness {
  const base = createFixtureSeam();
  const h: Harness = {
    seam: base,
    diffCalls: [],
    stageCalls: [],
    commitCalls: [],
    pending: [],
    holdDiffs: false,
    settleStage: null,
    holdStage: false,
    files,
    pendingStatus: [],
    holdStatus: false,
  };

  const stageResult = (input: ExecutionGitStageInput): SessionGitStageResult => ({
    sessionId: SESSION,
    worktreeId: WORKTREE,
    action: input.action,
    branch: 'tm8/changes-lane',
    paths: input.paths ?? [],
    all: input.all ?? false,
    staged: h.files.filter((f) => f.status[0] !== ' ' && f.status[0] !== '?'),
    files: h.files,
    filesTruncated: false,
    dirty: statusOf(h.files).dirty,
    checkedAt: '2026-09-19T00:00:00Z',
  });

  h.seam = {
    ...base,
    async gitStatus(): Promise<SessionGitStatus> {
      const answer = { ...statusOf(h.files), ...over };
      if (!h.holdStatus) return answer;
      return await new Promise<SessionGitStatus>((resolve) => {
        h.pendingStatus.push(() => resolve(answer));
      });
    },
    async gitDiff(_id: EntityId, opts?: GitDiffOpts): Promise<SessionGitDiff> {
      const path = opts?.path ?? '';
      const scope = opts?.scope ?? 'session';
      h.diffCalls.push({ path, scope });
      if (!h.holdDiffs) return diffOf(path, scope);
      return await new Promise<SessionGitDiff>((resolve) => {
        h.pending.push({ path, scope, settle: () => resolve(diffOf(path, scope)) });
      });
    },
    commands: {
      ...base.commands,
      async gitStage(_id: EntityId, input: ExecutionGitStageInput): Promise<SessionGitStageResult> {
        h.stageCalls.push(input);
        if (!h.holdStage) return stageResult(input);
        return await new Promise<SessionGitStageResult>((resolve) => {
          h.settleStage = () => resolve(stageResult(input));
        });
      },
      async gitCommit(_id: EntityId, input: ExecutionGitCommitInput): Promise<SessionGitCommitResult> {
        h.commitCalls.push(input);
        return {
          sessionId: SESSION,
          worktreeId: WORKTREE,
          oid: 'c'.repeat(40),
          branch: 'tm8/changes-lane',
          files: (input.paths ?? []).map((path) => ({ status: 'M ', path })),
        };
      },
    },
  };
  return h;
}

function mount(h: Harness) {
  return render(<SessionChangesBody seam={h.seam} sessionId={SESSION} live={false} />);
}

const openRow = (path: string) =>
  fireEvent.click(
    [...screen.getAllByTestId('session-changes-open')].find((b) => b.dataset.path === path)!,
  );
const chip = (name: string) => screen.getByTestId(`session-changes-filter-${name}`);
const check = (path: string) =>
  fireEvent.click(
    [...screen.getAllByTestId('session-changes-check')].find((b) => b.dataset.path === path)!,
  );
const shownPaths = () =>
  [...screen.getAllByTestId('session-changes-file')].map((li) => li.dataset.path);

describe('the four states, counted and filtered', () => {
  it('shows every dirty file with its XY status and counts each chip', async () => {
    mount(harness());
    await screen.findByTestId('session-changes-files');

    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts', 'notes.md', 'new.txt']);
    expect(chip('all').textContent).toContain('4');
    // `src/a.ts` is counted TWICE across staged and unstaged, on purpose: it
    // has a pending change in both halves and a count that picked one would
    // disagree with the list the chip opens.
    expect(chip('staged').textContent).toContain('2');
    expect(chip('unstaged').textContent).toContain('2');
    expect(chip('untracked').textContent).toContain('1');
  });

  it('puts the MM file under BOTH the staged and unstaged chips', async () => {
    mount(harness());
    await screen.findByTestId('session-changes-files');

    fireEvent.click(chip('staged'));
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts']);

    fireEvent.click(chip('unstaged'));
    expect(shownPaths()).toEqual(['src/a.ts', 'notes.md']);
  });

  it('counts the chips from the whole-worktree tally, not from the capped rows', async () => {
    // The server cut the list at two rows; the worktree has ninety changed
    // files. Counting the ROWS would make the chips agree with a list that is
    // admittedly incomplete, and be quietly wrong by 88.
    mount(
      harness([FILES[0]!, FILES[1]!], {
        filesTruncated: true,
        dirty: { staged: 40, unstaged: 30, untracked: 20, total: 90 },
      }),
    );
    await screen.findByTestId('session-changes-files');

    expect(chip('all').textContent).toContain('90');
    expect(chip('staged').textContent).toContain('40');
    expect(chip('unstaged').textContent).toContain('30');
    expect(chip('untracked').textContent).toContain('20');
    // …and the list says out loud that it is short, so the gap is not a puzzle.
    expect(screen.getByTestId('session-changes-truncated').textContent).toContain(
      'more files changed than are shown',
    );
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('says what porcelain actually measured when the worktree is clean', async () => {
    mount(harness([]));
    const empty = await screen.findByTestId('session-changes-empty');
    // NOT "nothing has changed since the lane branched" — status is porcelain,
    // and a lane with ten commits and a clean tree would read that as loss.
    expect(empty.textContent).toBe('No uncommitted changes in this worktree.');
  });

  /**
   * They LOOK like tabs and they are not. A tab shows and hides a `tabpanel`,
   * moves under the arrow keys, and is announced as one of N. These four
   * narrow one list that is always on screen, own no panel, and answer to Tab
   * like ordinary buttons — so they are pressed toggles inside a labelled
   * group, and nothing here promises keyboard behaviour that is not written.
   */
  it('declares the filters as pressed toggles, not as tabs it does not implement', async () => {
    mount(harness());
    await screen.findByTestId('session-changes-filter-all');

    const strip = chip('all').parentElement;
    expect(strip?.getAttribute('role')).toBe('group');
    expect(strip?.getAttribute('aria-label')).toBe('Filter changed files');

    for (const name of ['all', 'staged', 'unstaged', 'untracked']) {
      // No tab role anywhere, and no `aria-selected` standing in for pressed.
      expect(chip(name).getAttribute('role')).toBeNull();
      expect(chip(name).getAttribute('aria-selected')).toBeNull();
    }
    // Exactly one is on, and it is the one that is actually filtering.
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');
    expect(chip('staged').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(chip('staged'));
    expect(chip('staged').getAttribute('aria-pressed')).toBe('true');
    expect(chip('all').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the chip picks the git comparison', () => {
  it('opens a file in the session scope and re-reads it when the chip changes', async () => {
    const h = harness();
    mount(h);
    await screen.findByTestId('session-changes-files');

    openRow('src/a.ts');
    await screen.findByTestId('session-changes-diff-head');
    expect(h.diffCalls).toEqual([{ path: 'src/a.ts', scope: 'session' }]);
    expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('session');

    fireEvent.click(chip('staged'));
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('staged'),
    );
    expect(h.diffCalls).toEqual([
      { path: 'src/a.ts', scope: 'session' },
      // The SAME file, re-asked — the chip changed the question, not the row.
      { path: 'src/a.ts', scope: 'staged' },
    ]);
    expect(screen.getByTestId('session-changes-diff-pane').textContent).toContain(
      'index vs HEAD — exactly what a commit would write',
    );

    fireEvent.click(chip('unstaged'));
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('unstaged'),
    );
    // Same path, different bytes: the two halves of an MM file are not the
    // same diff, and the pane shows the one the chip asked for.
    expect(screen.getByTestId('session-changes-diff-pane').textContent).toContain(
      'unstaged body for src/a.ts',
    );
  });
});

describe('the newest question wins', () => {
  it('a late session answer never overwrites the newer staged one', async () => {
    const h = harness();
    h.holdDiffs = true;
    mount(h);
    await screen.findByTestId('session-changes-files');

    openRow('src/a.ts');                    // request 1: session
    await waitFor(() => expect(h.pending).toHaveLength(1));
    fireEvent.click(chip('staged'));        // request 2: staged
    await waitFor(() => expect(h.pending).toHaveLength(2));

    // OUT OF ORDER, which is the whole point: the newer one comes back first
    // and the older one lands after it.
    h.pending[1]!.settle();
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('staged'),
    );
    h.pending[0]!.settle();
    await Promise.resolve();

    await waitFor(() =>
      expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('staged'),
    );
    expect(screen.getByTestId('session-changes-diff-pane').textContent).toContain(
      'staged body for src/a.ts',
    );
    expect(screen.getByTestId('session-changes-diff-pane').textContent).not.toContain(
      'session body for src/a.ts',
    );
  });

  /**
   * THE ONE THIS BLOCK EXISTS FOR.
   *
   * `runVerb` re-reads the open diff after a mutation. If it reads the filter
   * out of the closure it was created with, a chip pressed WHILE the mutation
   * is in flight loses: the refresh takes a newer ticket and paints the old
   * comparison under the new chip. It is the worst version of the bug, because
   * the surface looks settled and the heading is confidently wrong.
   */
  it('the post-mutation refresh asks for the chip that is selected NOW', async () => {
    const h = harness();
    h.holdStage = true;
    mount(h);
    await screen.findByTestId('session-changes-files');

    openRow('src/a.ts');
    await screen.findByTestId('session-changes-diff-head');
    expect(h.diffCalls).toHaveLength(1);

    // Stage it, and hold the mutation open.
    fireEvent.click(
      [...screen.getAllByTestId('session-changes-row-stage')].find(
        (b) => b.dataset.path === 'src/a.ts',
      )!,
    );
    await waitFor(() => expect(h.settleStage).not.toBeNull());

    // …then change the question while it is in flight.
    fireEvent.click(chip('unstaged'));
    await waitFor(() => expect(h.diffCalls).toHaveLength(2));
    expect(h.diffCalls[1]).toEqual({ path: 'src/a.ts', scope: 'unstaged' });

    h.settleStage!();
    await waitFor(() => expect(h.diffCalls).toHaveLength(3));
    // The refresh asks UNSTAGED — the chip on screen — not `session`, which is
    // what was selected when the button was pressed.
    expect(h.diffCalls[2]).toEqual({ path: 'src/a.ts', scope: 'unstaged' });
    await waitFor(() =>
      expect(screen.getByTestId('session-changes-diff-scope').dataset.scope).toBe('unstaged'),
    );
  });

  /**
   * THE SAME RACE ON STATUS — the read the COMMIT GATE is computed from, so
   * losing it is worse than a stale list.
   *
   * A live poll overlaps every click: one can leave before Stage, the
   * post-action read can answer, and the pre-action poll can land last. If the
   * late one were allowed to write, the surface would redraw the index as it
   * was BEFORE the button was pressed — and "Commit selected" would refuse by
   * name over a file that is no longer staged, or offer a commit the server
   * would refuse. Only the newest read may write.
   */
  it('a late status answer never redraws the index a newer one already replaced', async () => {
    const h = harness();
    mount(h);
    await screen.findByTestId('session-changes-files');
    expect(chip('staged').textContent).toContain('2');

    h.holdStatus = true;
    // Read A leaves while `src/b.ts` is still staged.
    fireEvent.click(screen.getByTestId('session-changes-refresh'));
    await waitFor(() => expect(h.pendingStatus).toHaveLength(1));

    // The index moves under it: `src/b.ts` is unstaged now.
    h.files = [
      { status: 'MM', path: 'src/a.ts' },
      { status: ' M', path: 'src/b.ts' },
      { status: ' M', path: 'notes.md' },
      { status: '??', path: 'new.txt' },
    ];
    // Read B leaves with the new index.
    fireEvent.click(screen.getByTestId('session-changes-refresh'));
    await waitFor(() => expect(h.pendingStatus).toHaveLength(2));

    // B answers first and is the newest question, so it renders.
    h.pendingStatus[1]!();
    await waitFor(() => expect(chip('staged').textContent).toContain('1'));

    // A lands LAST, carrying the old index. It must be dropped on the floor.
    h.pendingStatus[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chip('staged').textContent).toContain('1');
    expect(chip('unstaged').textContent).toContain('3');

    // …and the gate agrees. `src/a.ts` is still `MM`, so a selection of
    // `notes.md` is still refused — but BY NAME, and the name is only
    // `src/a.ts` now. Had the stale read won, `src/b.ts` would be in that
    // sentence too: a refusal citing a file the reviewer already unstaged.
    h.holdStatus = false;
    check('notes.md');
    fireEvent.change(screen.getByTestId('session-changes-commit-message'), {
      target: { value: 'notes only' },
    });
    const gate = screen.getByTestId('session-changes-outside-gate');
    expect(gate.textContent).toContain('src/a.ts');
    expect(gate.textContent).not.toContain('src/b.ts');
  });
});

describe('commit never silently widens', () => {
  it('refuses Commit selected BY NAME while a staged file sits outside the selection', async () => {
    const h = harness();
    mount(h);
    await screen.findByTestId('session-changes-files');

    check('src/a.ts');
    fireEvent.change(screen.getByTestId('session-changes-commit-message'), {
      target: { value: 'only a' },
    });

    // `src/b.ts` is staged and NOT selected. git commits the whole index, so
    // the commit button is not offered — and the refusal names the file.
    const gate = screen.getByTestId('session-changes-outside-gate');
    expect(gate.textContent).toContain('src/b.ts');
    expect(gate.textContent).toContain('1 staged file(s) are outside this selection');
    expect(gate.textContent).toContain('unstage them, or select them too');
    expect(screen.queryByTestId('session-changes-commit')).toBeNull();
    expect(h.commitCalls).toEqual([]);
  });

  it('“Unstage the others” moves exactly the outside paths, and nothing else', async () => {
    const h = harness();
    mount(h);
    await screen.findByTestId('session-changes-files');

    check('src/a.ts');
    fireEvent.change(screen.getByTestId('session-changes-commit-message'), {
      target: { value: 'only a' },
    });
    fireEvent.click(screen.getByTestId('session-changes-unstage-outside'));

    await waitFor(() => expect(h.stageCalls).toHaveLength(1));
    expect(h.stageCalls[0]).toEqual({ action: 'unstage', paths: ['src/b.ts'] });
    // The SELECTION is untouched: the escape hatch narrows the index to match
    // the selection, it does not re-decide what the reviewer chose.
    await screen.findByTestId('session-changes-receipt');
    expect(screen.getByTestId('session-changes-selection-count').textContent).toBe('1 selected');
  });

  it('commits exactly the selected paths once nothing is staged outside it', async () => {
    const h = harness([
      { status: 'M ', path: 'src/a.ts' },
      { status: ' M', path: 'notes.md' },
    ]);
    mount(h);
    await screen.findByTestId('session-changes-files');

    check('src/a.ts');
    fireEvent.change(screen.getByTestId('session-changes-commit-message'), {
      target: { value: 'the slice' },
    });
    expect(screen.queryByTestId('session-changes-outside-gate')).toBeNull();

    fireEvent.click(screen.getByTestId('session-changes-commit'));
    await waitFor(() => expect(h.commitCalls).toHaveLength(1));
    expect(h.commitCalls[0]).toMatchObject({ message: 'the slice', paths: ['src/a.ts'] });
    const receipt = await screen.findByTestId('session-changes-receipt');
    expect(receipt.textContent).toContain('cccccccc');
  });
});

/**
 * A CONFLICT REFUSES THE WORKTREE, NOT THE SELECTION.
 *
 * `stage`, `unstage` and `commit` each call `refuseMidMerge` server-side
 * before touching the index, and it asks only whether `MERGE_HEAD` exists.
 * Before this, an unmerged row (`UU`, `AA`, `DD`, …) answered true to BOTH
 * `isStaged` and `isUnstaged` — the two columns are non-blank — so the row
 * drew a Stage button and an Unstage button, the bar drew Commit selected,
 * and the only thing any of the three could produce was a `merge_in_progress`
 * string in the error line after the click.
 *
 * WHAT THESE WOULD HAVE DONE HAD THE DEFECT BEEN ABSENT: nothing different.
 * Both were written against the broken component and both were red — the
 * first because `session-changes-row-stage` and `-row-unstage` were rendered
 * for `src/conflict.ts`, the second because `session-changes-commit` was
 * rendered and clickable.
 */
describe('a merge conflict is stated once, not discovered three times', () => {
  const CONFLICTED: SessionGitFile[] = [
    { status: 'UU', path: 'src/conflict.ts' },
    { status: 'M ', path: 'src/b.ts' },
  ];

  it('names the conflicted paths in a banner and offers the row no verb', async () => {
    mount(harness(CONFLICTED));
    await screen.findByTestId('session-changes-files');

    const banner = screen.getByTestId('session-changes-conflict');
    expect(banner.textContent).toContain('src/conflict.ts');
    expect(banner.textContent).toContain('resolve or abort the merge');
    expect(banner.getAttribute('role')).toBe('alert');

    // The conflicted row says what it is and offers nothing to press. Its
    // neighbour is an ordinary staged file and keeps its Unstage.
    expect(screen.getByTestId('session-changes-row-conflict')).toBeTruthy();
    const stageRows = screen
      .queryAllByTestId('session-changes-row-stage')
      .map((b) => (b as HTMLElement).dataset.path);
    const unstageRows = screen
      .queryAllByTestId('session-changes-row-unstage')
      .map((b) => (b as HTMLElement).dataset.path);
    expect(stageRows).not.toContain('src/conflict.ts');
    expect(unstageRows).not.toContain('src/conflict.ts');
    expect(unstageRows).toContain('src/b.ts');
  });

  it('refuses all three bar verbs even for a selection that excludes the conflict', async () => {
    const h = harness(CONFLICTED);
    mount(h);
    await screen.findByTestId('session-changes-files');

    // `src/b.ts` is a clean staged file. Selecting only it does NOT make the
    // verbs available, because the server refuses on `MERGE_HEAD`, not on the
    // paths it was handed — a bar that re-enabled here would be promising a
    // narrowing that does not exist.
    check('src/b.ts');
    fireEvent.change(screen.getByTestId('session-changes-commit-message'), {
      target: { value: 'sneak past the merge' },
    });

    expect(screen.queryByTestId('session-changes-stage')).toBeNull();
    expect(screen.queryByTestId('session-changes-unstage')).toBeNull();
    expect(screen.queryByTestId('session-changes-commit')).toBeNull();

    const gate = screen.getByTestId('session-changes-conflict-gate');
    expect(gate.textContent).toContain('1 path(s) are unresolved in a merge');
    expect(gate.textContent).toContain('src/conflict.ts');
    expect(h.stageCalls).toEqual([]);
    expect(h.commitCalls).toEqual([]);
  });

  it('shows the banner under a chip whose filtered list is empty', async () => {
    // The conflicted row answers no chip — it is neither staged nor unstaged
    // — so under `untracked` the list is empty. The banner is outside the
    // filtered list precisely so the reason the buttons are dead is still on
    // screen when the rows are not.
    mount(harness([{ status: 'UU', path: 'src/conflict.ts' }]));
    await screen.findByTestId('session-changes-files');

    fireEvent.click(chip('untracked'));
    expect(screen.queryByTestId('session-changes-files')).toBeNull();
    expect(screen.getByTestId('session-changes-conflict').textContent).toContain('src/conflict.ts');
  });
});

describe('no checkout, and no borrowed attribution', () => {
  /**
   * A LANE-SAFETY CONTROL. Phase 1 deliberately ships no branch switch — this
   * worktree is an agent's lane and a checkout under a running agent is how
   * you lose its work — and it does not claim which turn wrote a line, because
   * porcelain status carries no such fact. Both are absences, and absences
   * measure as health unless something asserts them.
   */
  it('offers no checkout control and claims no per-turn authorship', async () => {
    mount(harness());
    const body = await screen.findByTestId('session-changes-body');

    for (const word of ['Checkout', 'Check out', 'Switch branch', 'Last Agent Turn', 'Last agent turn']) {
      expect(body.textContent).not.toContain(word);
    }
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
  });
});

describe('a read that fails says so', () => {
  it('names a failed diff read in the pane instead of leaving the old one up', async () => {
    const h = harness();
    const seam: Seam = {
      ...h.seam,
      async gitDiff() {
        throw new Error('worktree vanished mid-read');
      },
    };
    render(<SessionChangesBody seam={seam} sessionId={SESSION} live={false} />);
    await screen.findByTestId('session-changes-files');

    openRow('src/a.ts');
    const err = await screen.findByTestId('session-changes-diff-error');
    expect(err.textContent).toContain('src/a.ts');
    expect(err.textContent).toContain('worktree vanished mid-read');
  });
});

describe('the surface does not poll a session that is not running', () => {
  it('reads once and then stops when the session is not live', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const reads = vi.fn();
      const seam: Seam = {
        ...h.seam,
        async gitStatus() {
          reads();
          return statusOf(FILES);
        },
      };
      render(<SessionChangesBody seam={seam} sessionId={SESSION} live={false} />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

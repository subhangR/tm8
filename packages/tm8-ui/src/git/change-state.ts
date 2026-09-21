/**
 * THE XY STATUS, READ ONCE.
 *
 * `git status --porcelain` describes every dirty path with two columns: the
 * INDEX column (what a commit would write) and the WORKTREE column (what is on
 * disk but not in the index). `MM` means both — the same file, two different
 * pending changes, and a surface that can only put a file in one bucket will
 * lie about that file.
 *
 * So these are predicates, not a partition: a path can answer true to both
 * `isStaged` and `isUnstaged`, and the Changes filters are written to let it
 * appear under both rather than picking a winner.
 *
 * UNTRACKED IS ITS OWN THING and is NOT unstaged. `git diff` — the unstaged
 * comparison — cannot see a file git has never been told about; it has no
 * index entry to compare against. Counting it as unstaged would make the chip
 * counts disagree with the diff the chip opens, which is exactly the kind of
 * small lie that teaches a wrong model of git.
 */
import type { SessionGitFile } from '@tm8/contract';

export function isUntracked(file: SessionGitFile): boolean {
  return file.status === '??';
}

/**
 * UNMERGED IS NOT A POSITION ON THE STAGED/UNSTAGED AXIS — it is the absence
 * of one, and reading the columns positionally gets it exactly backwards.
 *
 * During a conflict git puts the path in the index at stages 1/2/3 instead of
 * stage 0, and reports it with one of seven pairs: `DD AU UD UA DU AA UU`.
 * Every one of those has a non-blank letter in BOTH columns, so the
 * predicates below — which only ask "is this column blank" — answered true to
 * both, and the row rendered a Stage button and an Unstage button over a path
 * that has neither a resolved index entry nor a meaningful working-tree
 * delta. The server refuses all three verbs here (`refuseMidMerge`), so the
 * only thing those buttons could produce was a `merge_in_progress` error
 * string in place of the banner the reviewer needed.
 *
 * THE SET IS ENUMERATED RATHER THAN DERIVED, because the two rules that look
 * equivalent are not: "either column is `U`" misses `AA` and `DD`, and "both
 * columns non-blank" swallows `MM`, which is the ordinary both-halves-pending
 * row this surface is built to show under two chips at once.
 */
const UNMERGED_XY: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** A conflicted path: git holds it at stages 1/2/3, so no verb applies. */
export function isUnmerged(file: SessionGitFile): boolean {
  return UNMERGED_XY.has(file.status);
}

/** The index differs from HEAD for this path: a commit would write it. */
export function isStaged(file: SessionGitFile): boolean {
  const x = file.status[0];
  return !isUntracked(file) && !isUnmerged(file) && x !== ' ' && x !== '?' && x !== undefined;
}

/** The working tree differs from the index for this path. */
export function isUnstaged(file: SessionGitFile): boolean {
  const y = file.status[1];
  return !isUntracked(file) && !isUnmerged(file) && y !== ' ' && y !== '?' && y !== undefined;
}

/** Both halves pending — the case that must appear in two filters at once. */
export function isPartlyStaged(file: SessionGitFile): boolean {
  return isStaged(file) && isUnstaged(file);
}

export type ChangeFilter = 'all' | 'staged' | 'unstaged' | 'untracked';

export const CHANGE_FILTERS: readonly ChangeFilter[] = ['all', 'staged', 'unstaged', 'untracked'];

export const CHANGE_FILTER_LABEL: Readonly<Record<ChangeFilter, string>> = {
  all: 'All',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};

export function matchesFilter(file: SessionGitFile, filter: ChangeFilter): boolean {
  switch (filter) {
    case 'staged':
      return isStaged(file);
    case 'unstaged':
      return isUnstaged(file);
    case 'untracked':
      return isUntracked(file);
    default:
      return true;
  }
}

/**
 * WHICH COMPARISON a filter implies, and the word for it on screen.
 *
 * The filter is not decoration: asking for the staged list and then rendering
 * the working-tree diff would show the reviewer bytes that are not in the
 * commit they are about to make. So the chip picks the git comparison, and the
 * diff header says which one is on screen in plain words.
 */
export const FILTER_SCOPE: Readonly<Record<ChangeFilter, 'session' | 'staged' | 'unstaged'>> = {
  all: 'session',
  staged: 'staged',
  unstaged: 'unstaged',
  untracked: 'session',
};

export const SCOPE_CAPTION: Readonly<Record<'session' | 'staged' | 'unstaged', string>> = {
  session: 'working tree vs where this lane branched',
  staged: 'index vs HEAD — exactly what a commit would write',
  unstaged: 'working tree vs index — what a commit would leave behind',
};

/** Plain-language gloss of an XY pair, for the row's title and its badge. */
export function statusTitle(file: SessionGitFile): string {
  if (isUntracked(file)) return 'untracked — git has no record of this file yet';
  if (isUnmerged(file)) return 'conflicted — resolve the merge before staging or committing this';
  const parts: string[] = [];
  if (isStaged(file)) parts.push(`staged (${file.status[0] ?? '?'})`);
  if (isUnstaged(file)) parts.push(`unstaged (${file.status[1] ?? '?'})`);
  if (parts.length === 0) parts.push('unchanged');
  return parts.join(' · ');
}

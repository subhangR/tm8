// @tm8/execution — branch topology: what branches exist, who is ahead or
// behind the default branch, and what has gone stale.
//
// WHY IT LIVES BESIDE THE WORKTREE MANAGER. Every Git invocation in this
// product goes through `runGit`, argv-only, for the reason that file states:
// `execFile` without `shell: true` hands argv to the OS, so a branch name
// containing `;` or `$(…)` is inert bytes. Putting a SECOND git caller in
// another package is how that invariant gets forgotten — the next author
// copies whatever is nearest, and if the nearest thing is a server service
// reaching for `execSync` the rule is gone. So all git lives here.
//
// THIS IS A READ AND ONLY A READ. Every command below is a query:
// `rev-parse`, `for-each-ref`, `rev-list`, `symbolic-ref`. None writes a ref,
// none checks anything out, none touches the index. A topology read that
// mutated the working tree of a project a user is actively editing would be
// an outstanding way to lose someone's work.

import { runGit, type GitResult, WorktreeError } from '../worktree/git-invoker.js';

export interface BranchTopologyEntry {
  /** Short branch name, e.g. `feat/x`. */
  name: string;
  /** Commit oid at the tip. */
  head: string;
  /** Tip commit date, ISO-8601. */
  lastCommitAt: string;
  /** Tip commit subject — the cheapest way to recognise a branch. */
  subject: string;
  /** Configured upstream (`origin/feat/x`), or null when there is none. */
  upstream: string | null;
  /** Commits on this branch that the default branch does not have. */
  ahead: number;
  /** Commits on the default branch that this branch does not have. */
  behind: number;
  /** True for the default branch itself. */
  isDefault: boolean;
  /** True for the branch currently checked out in this working directory. */
  isCurrent: boolean;
  /** ahead === 0: everything here is already in the default branch. */
  merged: boolean;
  /** Tip older than `staleAfterDays`. */
  stale: boolean;
}

export interface BranchTopology {
  /** The branch everything else is measured against. */
  defaultBranch: string;
  /** How `defaultBranch` was decided — never guess silently. */
  defaultBranchSource: 'origin_head' | 'local_conventional' | 'current_branch';
  branches: BranchTopologyEntry[];
  /** True when `maxBranches` cut the list short. */
  truncated: boolean;
  staleAfterDays: number;
}

export interface BranchTopologyOptions {
  /** A branch with no commit newer than this is stale. Default 30. */
  staleAfterDays?: number;
  /**
   * Ahead/behind costs one `rev-list` per branch, so a repo with a thousand
   * refs would be a thousand processes on one read. Default 200.
   */
  maxBranches?: number;
  /** Injected for tests; defaults to the real argv-only invoker. */
  run?: (args: readonly string[], cwd: string) => Promise<GitResult>;
  /** Injected for tests so `stale` is decidable without a clock. */
  now?: () => Date;
}

const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_MAX_BRANCHES = 200;
const DAY_MS = 86_400_000;

/** Field separator: 0x1f, a byte no ref name or commit subject may contain. */
const FS = '\u001f';
const FORMAT = [
  '%(refname:short)',
  '%(objectname)',
  '%(committerdate:iso-strict)',
  '%(upstream:short)',
  '%(HEAD)',
  '%(contents:subject)',
].join('%1f');

function fail(message: string, reason: string): never {
  throw new WorktreeError(message, 'invalid_input', reason);
}

/**
 * WHY THE DEFAULT BRANCH IS DISCOVERED RATHER THAN ASSUMED. `main` is a
 * convention, not a rule: this repo has `main`, plenty have `master`, and a
 * fork can have neither. Reporting "40 commits behind main" against a branch
 * that is not the trunk is worse than reporting nothing, so the source of the
 * answer travels WITH the answer and the caller can see which rung was used.
 */
async function resolveDefaultBranch(
  run: (args: readonly string[], cwd: string) => Promise<GitResult>,
  cwd: string,
): Promise<{ branch: string; source: BranchTopology['defaultBranchSource'] }> {
  // 1. What the remote itself says its HEAD is.
  const originHead = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (originHead.code === 0) {
    const short = originHead.stdout.trim().replace(/^origin\//, '');
    if (short) return { branch: short, source: 'origin_head' };
  }
  // 2. The two conventional names, but only if the ref actually exists.
  for (const candidate of ['main', 'master']) {
    const probe = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd);
    if (probe.code === 0 && probe.stdout.trim()) {
      return { branch: candidate, source: 'local_conventional' };
    }
  }
  // 3. Whatever is checked out. Honest, and labelled as the fallback it is.
  const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const name = current.stdout.trim();
  if (current.code !== 0 || !name || name === 'HEAD') {
    fail(`cannot determine a default branch in ${JSON.stringify(cwd)}`, 'no_default_branch');
  }
  return { branch: name, source: 'current_branch' };
}

/**
 * `rev-list --left-right --count A...B` counts each side of the symmetric
 * difference: left is on A and not B (how far B is BEHIND), right is on B and
 * not A (how far B is AHEAD). Both refs are passed as argv slots, never
 * interpolated into a string.
 */
async function aheadBehind(
  run: (args: readonly string[], cwd: string) => Promise<GitResult>,
  cwd: string,
  defaultBranch: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const result = await run(
    ['rev-list', '--left-right', '--count', `${defaultBranch}...${branch}`],
    cwd,
  );
  if (result.code !== 0) return { ahead: 0, behind: 0 };
  const [left, right] = result.stdout.trim().split(/\s+/);
  return { ahead: Number(right) || 0, behind: Number(left) || 0 };
}

export async function readBranchTopology(
  workingDir: string,
  options: BranchTopologyOptions = {},
): Promise<BranchTopology> {
  const run = options.run ?? ((args, cwd) => runGit(args, { cwd }));
  const now = options.now ?? (() => new Date());
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const maxBranches = options.maxBranches ?? DEFAULT_MAX_BRANCHES;

  // Refuse a non-repository by NAME rather than returning an empty list: "no
  // branches" and "this is not a git repository" are different answers, and
  // collapsing them tells the user their project is fine when it is not.
  const inside = await run(['rev-parse', '--is-inside-work-tree'], workingDir);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    fail(`not a git repository: ${JSON.stringify(workingDir)}`, 'not_a_git_repository');
  }

  const { branch: defaultBranch, source } = await resolveDefaultBranch(run, workingDir);

  const listed = await run(
    [
      'for-each-ref',
      `--format=${FORMAT}`,
      '--sort=-committerdate',
      `--count=${maxBranches + 1}`,
      'refs/heads',
    ],
    workingDir,
  );
  if (listed.code !== 0) {
    fail(`git for-each-ref failed in ${JSON.stringify(workingDir)}`, 'for_each_ref_failed');
  }

  const rows = listed.stdout.split('\n').filter((line) => line.length > 0);
  const truncated = rows.length > maxBranches;
  const kept = truncated ? rows.slice(0, maxBranches) : rows;

  const staleBefore = now().getTime() - staleAfterDays * DAY_MS;
  const branches: BranchTopologyEntry[] = [];
  for (const row of kept) {
    const [name, head, date, upstream, headMark, ...rest] = row.split(FS);
    if (!name) continue;
    const isDefault = name === defaultBranch;
    const { ahead, behind } = isDefault
      ? { ahead: 0, behind: 0 }
      : await aheadBehind(run, workingDir, defaultBranch, name);
    const raw = date ?? '';
    const at = new Date(raw);
    branches.push({
      name,
      head: head ?? '',
      lastCommitAt: Number.isNaN(at.getTime()) ? raw : at.toISOString(),
      subject: rest.join(FS),
      upstream: upstream ? upstream : null,
      ahead,
      behind,
      isDefault,
      isCurrent: headMark === '*',
      // The default branch is trivially "merged into itself"; saying so would
      // put a misleading badge on the trunk, so it is excluded.
      merged: !isDefault && ahead === 0,
      stale: !Number.isNaN(at.getTime()) && at.getTime() < staleBefore,
    });
  }

  return { defaultBranch, defaultBranchSource: source, branches, truncated, staleAfterDays };
}

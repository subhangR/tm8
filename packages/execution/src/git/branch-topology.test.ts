// Branch topology against REAL git repositories in throwaway temp directories.
//
// NO MOCK FOR GIT ITSELF, for the same reason the worktree gate gives: what is
// under test is largely whether the real binary ACCEPTS the argv this module
// builds. A fake runner returning canned stdout would pass happily while
// `--format=%1f…`, `--count=`, `iso-strict` or the `A...B` range spelling were
// wrong — every one of which is a defect only the real binary can report.
//
// The fake runner is used for exactly the two things a real repo cannot make
// deterministic: which rung of the default-branch ladder was taken, and a
// clock old enough to make a branch stale.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runGit, WorktreeError } from '../worktree/git-invoker.js';
import { readBranchTopology } from './branch-topology.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let base: string;
let repo: string;

const AUTHOR = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function commit(message: string, file: string): Promise<void> {
  await writeFile(join(repo, file), `${message}\n`);
  await git(['add', '.'], repo);
  await git([...AUTHOR, 'commit', '-m', message], repo);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-branch-topology-'));
  repo = join(base, 'repo');
  await git(['init', '-b', 'main', repo], base);
  await commit('initial', 'README.md');

  // ahead 2, behind 0 — pure feature work off the current trunk.
  await git(['checkout', '-b', 'feat/ahead'], repo);
  await commit('ahead one', 'a.txt');
  await commit('ahead two', 'b.txt');

  // ahead 0, behind 1 — branched, then trunk moved on. Fully merged.
  await git(['checkout', '-b', 'chore/merged', 'main'], repo);
  await git(['checkout', 'main'], repo);
  await commit('trunk moves', 'c.txt');

  // ahead 1, behind 1 — genuinely diverged.
  await git(['checkout', '-b', 'feat/diverged', 'HEAD~1'], repo);
  await commit('diverged', 'd.txt');

  await git(['checkout', 'main'], repo);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('readBranchTopology — against real git', () => {
  it('finds every local branch and names the trunk it measured against', async () => {
    const topology = await readBranchTopology(repo);
    expect(topology.defaultBranch).toBe('main');
    // No remote in a fresh `git init`, so the conventional rung answers.
    expect(topology.defaultBranchSource).toBe('local_conventional');
    expect([...topology.branches.map((b) => b.name)].sort()).toEqual([
      'chore/merged',
      'feat/ahead',
      'feat/diverged',
      'main',
    ]);
    expect(topology.truncated).toBe(false);
  });

  it('counts ahead and behind in the right direction', async () => {
    // The direction is the whole value of this read and it is easy to invert:
    // `rev-list --left-right A...B` puts BEHIND on the left.
    const by = Object.fromEntries(
      (await readBranchTopology(repo)).branches.map((b) => [b.name, b]),
    );
    expect(by['feat/ahead']).toMatchObject({ ahead: 2, behind: 1 });
    expect(by['chore/merged']).toMatchObject({ ahead: 0, behind: 1 });
    expect(by['feat/diverged']).toMatchObject({ ahead: 1, behind: 1 });
  });

  it('reports the trunk as the trunk, at zero distance from itself', async () => {
    const main = (await readBranchTopology(repo)).branches.find((b) => b.name === 'main');
    expect(main).toMatchObject({ isDefault: true, isCurrent: true, ahead: 0, behind: 0 });
    // "merged into itself" is true but useless; a badge on the trunk misleads.
    expect(main?.merged).toBe(false);
  });

  it('calls a branch merged when the trunk already contains all of it', async () => {
    const by = Object.fromEntries(
      (await readBranchTopology(repo)).branches.map((b) => [b.name, b.merged]),
    );
    expect(by['chore/merged']).toBe(true);
    expect(by['feat/ahead']).toBe(false);
    expect(by['feat/diverged']).toBe(false);
  });

  it('carries the tip oid, an ISO date and the subject line', async () => {
    const ahead = (await readBranchTopology(repo)).branches.find((b) => b.name === 'feat/ahead')!;
    expect(ahead.head).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(ahead.lastCommitAt).getTime()).not.toBeNaN();
    expect(ahead.subject).toBe('ahead two');
    expect(ahead.upstream).toBeNull();
  });

  it('is stale only relative to the stated window, never a hidden clock', async () => {
    const fresh = await readBranchTopology(repo, { staleAfterDays: 30 });
    expect(fresh.branches.every((b) => b.stale === false)).toBe(true);
    expect(fresh.staleAfterDays).toBe(30);

    const future = new Date(Date.now() + 400 * 86_400_000);
    const aged = await readBranchTopology(repo, { staleAfterDays: 30, now: () => future });
    expect(aged.branches.every((b) => b.stale === true)).toBe(true);
  });

  it('bounds the branch list and SAYS it bounded it', async () => {
    // Ahead/behind is one process per branch; an unbounded repo is an
    // unbounded number of processes on a single read.
    const capped = await readBranchTopology(repo, { maxBranches: 2 });
    expect(capped.branches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('refuses a directory that is not a repository, by name', async () => {
    // "no branches" and "not a repository" are different answers; collapsing
    // them tells the user their project is fine when it is not.
    await expect(readBranchTopology(base)).rejects.toThrow(WorktreeError);
    await expect(readBranchTopology(base)).rejects.toMatchObject({
      reason: 'not_a_git_repository',
    });
  });

  it('treats a branch name containing a shell substitution as inert bytes', async () => {
    // NOT a hypothetical: git's ref rules ban `~ ^ : ? * [ \` and whitespace,
    // but PERMIT `$ ( ) ; & > |` — so a branch really can be named
    // `feat/x;echo>pwned`, and that name reaches this module's argv as data.
    // Under a shell, `rev-list main...feat/x;echo>pwned` would run `echo` and
    // create the file. `execFile` with no shell never interprets it. A
    // `git -C dir …` built by string interpolation fails this test by
    // creating `pwned`, which is precisely why that spelling is banned here.
    const hostile = 'feat/x;echo>pwned';
    await git(['branch', hostile, 'main'], repo);
    try {
      const topology = await readBranchTopology(repo);
      const entry = topology.branches.find((b) => b.name === hostile);
      // It is listed under its literal name — not dropped, not mangled.
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ ahead: 0, behind: 0, merged: true });
      // ...and the substitution never ran.
      await expect(stat(join(repo, 'pwned'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await git(['branch', '-D', hostile], repo);
    }
  });
});

describe('readBranchTopology — the default-branch ladder', () => {
  /** A fake runner is the only way to fix which rung answers. */
  const runnerFor = (
    table: Record<string, { code: number; stdout: string }>,
  ): ((args: readonly string[], cwd: string) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>) => {
    return async (args) => {
      const key = args.join(' ');
      const hit = table[key];
      return { code: hit?.code ?? 1, stdout: hit?.stdout ?? '', stderr: '' };
    };
  };

  const INSIDE = { 'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' } };
  const NO_BRANCHES = {
    'for-each-ref --format=%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(upstream:short)%1f%(HEAD)%1f%(contents:subject) --sort=-committerdate --count=201 refs/heads':
      { code: 0, stdout: '' },
  };

  it('prefers what the remote says its own HEAD is', async () => {
    const topology = await readBranchTopology('/x', {
      run: runnerFor({
        ...INSIDE,
        ...NO_BRANCHES,
        'symbolic-ref --quiet --short refs/remotes/origin/HEAD': {
          code: 0,
          stdout: 'origin/develop\n',
        },
      }),
    });
    expect(topology).toMatchObject({
      defaultBranch: 'develop',
      defaultBranchSource: 'origin_head',
    });
  });

  it('falls back to master when there is no origin/HEAD and no main', async () => {
    const topology = await readBranchTopology('/x', {
      run: runnerFor({
        ...INSIDE,
        ...NO_BRANCHES,
        'rev-parse --verify --quiet refs/heads/master': { code: 0, stdout: 'abc\n' },
      }),
    });
    expect(topology).toMatchObject({
      defaultBranch: 'master',
      defaultBranchSource: 'local_conventional',
    });
  });

  it('falls back to the checked-out branch and LABELS that as the fallback', async () => {
    // `main` is a convention, not a rule. Reporting "40 behind main" against a
    // repo whose trunk is not main is worse than reporting nothing, so the
    // source of the answer travels with the answer.
    const topology = await readBranchTopology('/x', {
      run: runnerFor({
        ...INSIDE,
        ...NO_BRANCHES,
        'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'trunk\n' },
      }),
    });
    expect(topology).toMatchObject({
      defaultBranch: 'trunk',
      defaultBranchSource: 'current_branch',
    });
  });

  it('refuses rather than guessing when even HEAD is detached', async () => {
    await expect(
      readBranchTopology('/x', {
        run: runnerFor({
          ...INSIDE,
          ...NO_BRANCHES,
          'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'HEAD\n' },
        }),
      }),
    ).rejects.toMatchObject({ reason: 'no_default_branch' });
  });
});

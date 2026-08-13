// Tier 2 COMPLETION verbs against REAL git repositories in throwaway temp
// directories — the same discipline as git-mutations.test.ts: no mocks for
// git, because the abort-verify and refusal claims are about what the real
// binary receives and what state it leaves on disk.
//
//   T1  cherry-pick — a commit lands on the session branch; a REAL conflict
//       returns conflicted paths as data with the worktree VERIFIABLY clean
//       (no CHERRY_PICK_HEAD, clean status, HEAD unmoved — asserted by
//       reading git state); multi-commit sequences abort whole; dirty tree
//       and mid-merge refusals fire before anything runs
//   T2  branch create/rename/delete — checked-out-anywhere refusal (primary
//       tree included), protected-branch refusal, unmerged delete gates on
//       force and NAMES what unmerged was measured against, forced delete
//       returns the tip oid
//   T3  stash push/list/pop/drop — push stores untracked without a force
//       gate (the safe direction of the asymmetry); a conflicted pop obeys
//       the abort-verify-surface law AND retains the entry; drop gates on
//       force and returns the destroyed oid
//   T4  hostile names — `feat/x;echo>pwned` is a LEGAL git branch name and
//       must ride argv as inert data: create/rename/delete it in a real repo
//       and prove no file was ever spawned by a shell
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit } from './git-invoker.js';
import {
  assertGitLegalBranchName,
  branchCreate,
  branchDelete,
  branchRename,
  changedFiles,
  checkpoint,
  cherryPick,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from './git-mutations.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let base: string;
let repoRoot: string;
/** The session worktree under test — a REAL `git worktree add` checkout. */
let wt: string;
let counter = 0;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-git-tier2-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  counter += 1;
  repoRoot = join(base, `repo-${counter}`);
  wt = join(base, `wt-${counter}`);
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'hello\n');
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1\nline-2\nline-3\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  await git(['worktree', 'add', '-b', 'tm8/session', wt, 'HEAD'], repoRoot);
});

/** A commit on main that edits shared.txt so a session-side edit conflicts. */
async function mainEditsShared(): Promise<string> {
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN EDIT\nline-2\nline-3\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main edits shared'], repoRoot);
  return git(['rev-parse', 'HEAD'], repoRoot);
}

/** A commit on main touching a file the session never touches. */
async function mainAddsFile(name: string): Promise<string> {
  await writeFile(join(repoRoot, name), `content of ${name}\n`);
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', `add ${name}`], repoRoot);
  return git(['rev-parse', 'HEAD'], repoRoot);
}

describe('T1 — cherry-pick', () => {
  it('applies a commit from main onto the session branch', async () => {
    const oid = await mainAddsFile('picked.txt');
    const result = await cherryPick({ worktreePath: wt, commits: [oid], expectedBranch: 'tm8/session' });
    expect(result.status).toBe('picked');
    if (result.status !== 'picked') return;
    expect(result.fromOids).toEqual([oid]);
    expect(result.newOids).toHaveLength(1);
    expect(result.branch).toBe('tm8/session');
    await stat(join(wt, 'picked.txt')); // the content actually landed
    expect(await changedFiles(wt)).toEqual([]);
  });

  it('a conflicted pick aborts, and the abort is VERIFIED by reading git state', async () => {
    // Session edits shared.txt; main's edit of the same lines conflicts.
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION EDIT\nline-2\nline-3\n');
    await checkpoint({ worktreePath: wt, message: 'tm8 session edit' });
    const before = await git(['rev-parse', 'HEAD'], wt);
    const oid = await mainEditsShared();

    const result = await cherryPick({ worktreePath: wt, commits: [oid] });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.conflictedPaths).toEqual(['shared.txt']);
    // The abort took — asserted from git state, not from an exit code.
    const cph = await runGit(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd: wt });
    expect(cph.code).not.toBe(0);
    expect(await changedFiles(wt)).toEqual([]);
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(before);
  });

  it('a multi-commit sequence with a conflict aborts the WHOLE sequence', async () => {
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION EDIT\nline-2\nline-3\n');
    await checkpoint({ worktreePath: wt, message: 'tm8 session edit' });
    const before = await git(['rev-parse', 'HEAD'], wt);
    const ok = await mainAddsFile('fine.txt'); // would apply cleanly
    const bad = await mainEditsShared(); // conflicts

    const result = await cherryPick({ worktreePath: wt, commits: [ok, bad] });
    expect(result.status).toBe('conflict');
    // No partial application: HEAD is back where it started, fine.txt absent.
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(before);
    await expect(stat(join(wt, 'fine.txt'))).rejects.toThrow();
    expect(await changedFiles(wt)).toEqual([]);
  });

  it('refuses a dirty worktree before anything runs', async () => {
    const oid = await mainAddsFile('x.txt');
    await writeFile(join(wt, 'wip.txt'), 'uncommitted\n');
    await expect(cherryPick({ worktreePath: wt, commits: [oid] }))
      .rejects.toMatchObject({ reason: 'dirty_worktree' });
  });

  it('refuses hostile commitish shapes before an argv slot sees them', async () => {
    await expect(cherryPick({ worktreePath: wt, commits: ['--exec=touch pwned'] }))
      .rejects.toMatchObject({ reason: 'unsafe_ref' });
    await expect(cherryPick({ worktreePath: wt, commits: [] }))
      .rejects.toMatchObject({ reason: 'no_commits' });
  });
});

describe('T2 — branch create / rename / delete', () => {
  it('creates a branch at HEAD without checking it out', async () => {
    const result = await branchCreate({ worktreePath: wt, name: 'feat/new-lane' });
    expect(result.oid).toBe(await git(['rev-parse', 'HEAD'], wt));
    expect(await git(['rev-parse', 'refs/heads/feat/new-lane'], wt)).toBe(result.oid);
    // Still on the session branch.
    expect(await git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe('tm8/session');
  });

  it('never deletes or renames a branch checked out in ANY worktree — primary tree included', async () => {
    // `main` is checked out in the PRIMARY tree, not in the session worktree.
    await expect(branchDelete({ worktreePath: wt, name: 'main', force: true }))
      .rejects.toMatchObject({ reason: 'branch_checked_out' });
    await expect(branchRename({ worktreePath: wt, from: 'main', to: 'moved' }))
      .rejects.toMatchObject({ reason: 'branch_checked_out' });
    // The session's own checked-out branch refuses too.
    await expect(branchDelete({ worktreePath: wt, name: 'tm8/session', force: true }))
      .rejects.toMatchObject({ reason: 'branch_checked_out' });
  });

  it('never touches a protected (default/base) branch', async () => {
    await branchCreate({ worktreePath: wt, name: 'release' });
    await expect(branchDelete({ worktreePath: wt, name: 'release', protectedBranches: ['release'], force: true }))
      .rejects.toMatchObject({ reason: 'branch_protected' });
    await expect(branchRename({ worktreePath: wt, from: 'release', to: 'r2', protectedBranches: ['release'] }))
      .rejects.toMatchObject({ reason: 'branch_protected' });
  });

  it('an unmerged delete refuses without force and NAMES the measurement', async () => {
    // A branch with a commit HEAD does not have = unmerged relative to HEAD.
    await git(['branch', 'stray', 'HEAD'], wt);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit',
      '--allow-empty', '-m', 'stray-only'], repoRoot); // moves main, not stray… make stray move:
    await git(['update-ref', 'refs/heads/stray', await git(['rev-parse', 'main'], wt)], wt);

    const err = await branchDelete({ worktreePath: wt, name: 'stray' }).catch((e) => e);
    expect(err).toMatchObject({ reason: 'branch_unmerged' });
    expect(err.detail.measuredAgainst).toBe('tm8/session');

    const tip = await git(['rev-parse', 'refs/heads/stray'], wt);
    const forced = await branchDelete({ worktreePath: wt, name: 'stray', force: true });
    expect(forced.forced).toBe(true);
    expect(forced.deletedOid).toBe(tip); // still reachable by oid — the receipt says so
    const gone = await runGit(['rev-parse', '-q', '--verify', 'refs/heads/stray'], { cwd: wt });
    expect(gone.code).not.toBe(0);
  });

  it('a merged delete needs no force', async () => {
    await branchCreate({ worktreePath: wt, name: 'merged-lane' });
    const result = await branchDelete({ worktreePath: wt, name: 'merged-lane' });
    expect(result.forced).toBe(false);
  });

  it('rename moves the ref and nothing else', async () => {
    await branchCreate({ worktreePath: wt, name: 'old-name' });
    const result = await branchRename({ worktreePath: wt, from: 'old-name', to: 'new-name' });
    expect(result.oid).toBe(await git(['rev-parse', 'refs/heads/new-name'], wt));
    const old = await runGit(['rev-parse', '-q', '--verify', 'refs/heads/old-name'], { cwd: wt });
    expect(old.code).not.toBe(0);
  });

  it('refuses a create that collides and a rename onto an existing branch', async () => {
    await branchCreate({ worktreePath: wt, name: 'taken' });
    await expect(branchCreate({ worktreePath: wt, name: 'taken' }))
      .rejects.toMatchObject({ reason: 'branch_exists' });
    await branchCreate({ worktreePath: wt, name: 'src' });
    await expect(branchRename({ worktreePath: wt, from: 'src', to: 'taken' }))
      .rejects.toMatchObject({ reason: 'branch_exists' });
  });
});

describe('T3 — stash', () => {
  it('push stores tracked AND untracked; list shows it; pop restores it', async () => {
    await writeFile(join(wt, 'README.md'), 'edited\n');
    await writeFile(join(wt, 'untracked.txt'), 'wip\n');
    const pushed = await stashPush({ worktreePath: wt, message: 'tm8 wip', expectedBranch: 'tm8/session' });
    expect(pushed.status).toBe('stashed');
    expect(await changedFiles(wt)).toEqual([]); // untracked swept INTO the stash — stored, not lost
    await expect(stat(join(wt, 'untracked.txt'))).rejects.toThrow();

    const entries = await stashList(wt);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toContain('tm8 wip');

    const popped = await stashPop({ worktreePath: wt });
    expect(popped.status).toBe('popped');
    await stat(join(wt, 'untracked.txt'));
    expect(await stashList(wt)).toHaveLength(0);
  });

  it('a clean tree is a push that stores nothing', async () => {
    const result = await stashPush({ worktreePath: wt });
    expect(result.status).toBe('clean');
    expect(await stashList(wt)).toHaveLength(0);
  });

  it('a conflicted pop aborts, verifies clean, and RETAINS the entry', async () => {
    // Stash an edit of shared.txt, then move the branch so the pop conflicts.
    await writeFile(join(wt, 'shared.txt'), 'line-1 STASHED EDIT\nline-2\nline-3\n');
    const pushed = await stashPush({ worktreePath: wt, message: 'tm8 conflicting wip' });
    expect(pushed.status).toBe('stashed');
    await writeFile(join(wt, 'shared.txt'), 'line-1 COMMITTED EDIT\nline-2\nline-3\n');
    await checkpoint({ worktreePath: wt, message: 'tm8 moves shared' });
    const head = await git(['rev-parse', 'HEAD'], wt);

    const result = await stashPop({ worktreePath: wt });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.conflictedPaths).toEqual(['shared.txt']);
    // Abort verified from git state: clean tree, HEAD unmoved, entry retained.
    expect(await changedFiles(wt)).toEqual([]);
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(head);
    const entries = await stashList(wt);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.oid).toBe(result.oid);
  });

  it('pop refuses a dirty tree and a missing index', async () => {
    await writeFile(join(wt, 'x.txt'), 'wip\n');
    await stashPush({ worktreePath: wt });
    await writeFile(join(wt, 'y.txt'), 'other wip\n');
    await expect(stashPop({ worktreePath: wt })).rejects.toMatchObject({ reason: 'dirty_worktree' });
    await expect(stashDrop({ worktreePath: wt, index: 7, force: true }))
      .rejects.toMatchObject({ reason: 'stash_not_found' });
  });

  it('drop gates on force and returns the destroyed oid', async () => {
    await writeFile(join(wt, 'x.txt'), 'wip\n');
    const pushed = await stashPush({ worktreePath: wt });
    expect(pushed.status).toBe('stashed');
    await expect(stashDrop({ worktreePath: wt, index: 0 }))
      .rejects.toMatchObject({ reason: 'stash_drop_needs_force' });
    const dropped = await stashDrop({ worktreePath: wt, index: 0, force: true });
    expect(dropped.droppedOid).toMatch(/^[0-9a-f]{40}$/);
    expect(await stashList(wt)).toHaveLength(0);
  });
});

describe('T4 — hostile branch names ride argv as inert data', () => {
  // Git's ref rules ban `~ ^ : ? *` but PERMIT `$ ( ) ; & >` — this name is
  // LEGAL, and a shell would treat it as three commands and a redirect.
  const HOSTILE = 'feat/x;echo>pwned';

  it('create → rename → delete the hostile name in a real repo; no shell ever runs it', async () => {
    const created = await branchCreate({ worktreePath: wt, name: HOSTILE });
    expect(await git(['rev-parse', `refs/heads/${HOSTILE}`], wt)).toBe(created.oid);
    // The proof of inertness: had a shell seen the name, `pwned` would exist.
    await expect(stat(join(wt, 'pwned'))).rejects.toThrow();
    await expect(stat(join(repoRoot, 'pwned'))).rejects.toThrow();

    const renamed = await branchRename({ worktreePath: wt, from: HOSTILE, to: 'feat/x;still$(hostile)&' });
    expect(renamed.to).toBe('feat/x;still$(hostile)&');
    const deleted = await branchDelete({ worktreePath: wt, name: 'feat/x;still$(hostile)&' });
    expect(deleted.deletedOid).toMatch(/^[0-9a-f]{40}$/);
    await expect(stat(join(wt, 'pwned'))).rejects.toThrow();
  });

  it('what git itself bans stays banned, and option shapes refuse', () => {
    expect(() => assertGitLegalBranchName('feat/x;echo>pwned')).not.toThrow();
    for (const bad of ['-D', '--force', 'a..b', 'a b', 'has~tilde', 'has^caret', 'has:colon',
      'has?q', 'has*glob', 'has[bracket', 'back\\slash', 'ends.lock', '.leading-dot', 'a//b', 'HEAD', '']) {
      expect(() => assertGitLegalBranchName(bad), bad).toThrow();
    }
  });
});

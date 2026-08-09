// Tier 2 mutating verbs against REAL git repositories in throwaway temp
// directories — same discipline as worktree-manager.test.ts: no mocks for git,
// because the injection and never-mid-merge claims are about what the real
// binary receives and what state it leaves on disk.
//
//   M1  checkpoint — WIP (tracked + untracked) becomes a commit on the
//       worktree branch; a clean tree returns created:false, no empty commit;
//       a half-done merge is refused
//   M2  rollback — reset to a checkpoint; untracked files refuse without
//       force; force cleans them; a rollback is reversible via the newer oid
//   M3  stage/commit — pathspec guards, `--` discipline, empty-index refusal
//   M4  merge — fast-forward/true-merge succeed; a REAL conflict returns
//       conflicted paths as data with the worktree verifiably clean and no
//       MERGE_HEAD left behind; dirty tree refused before any merge starts
//   M5  hostile inputs — messages/pathspecs/refs that look like options or
//       carry shell bytes are refused before an argv slot sees them
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorktreeError, runGit } from './git-invoker.js';
import {
  assertSafeMessage,
  assertSafePathspec,
  changedFiles,
  checkpoint,
  commit,
  mergeFromRef,
  rollback,
  stage,
  stagedFiles,
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
  base = await mkdtemp(join(tmpdir(), 'tm8-git-mutations-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Fresh repo + one session worktree per test group, so state never leaks. */
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

describe('M1 — checkpoint', () => {
  it('captures tracked edits AND untracked files as one commit on the branch', async () => {
    await writeFile(join(wt, 'README.md'), 'edited\n');
    await writeFile(join(wt, 'brand-new.txt'), 'wip\n');
    const result = await checkpoint({ worktreePath: wt, expectedBranch: 'tm8/session' });
    expect(result.created).toBe(true);
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe('tm8/session');
    expect(result.files.map((f) => f.path).sort()).toEqual(['README.md', 'brand-new.txt']);
    // The tree is clean afterwards and the branch tip IS the checkpoint.
    expect(await changedFiles(wt)).toEqual([]);
    expect(await git(['rev-parse', 'tm8/session'], wt)).toBe(result.oid);
  });

  it('a clean tree is a success that creates nothing', async () => {
    const head = await git(['rev-parse', 'HEAD'], wt);
    const result = await checkpoint({ worktreePath: wt });
    expect(result.created).toBe(false);
    expect(result.oid).toBe(head);
    expect(result.files).toEqual([]);
  });

  it('refuses when the graph-recorded branch does not match the checkout', async () => {
    await expect(checkpoint({ worktreePath: wt, expectedBranch: 'tm8/other' }))
      .rejects.toMatchObject({ name: 'WorktreeError', reason: 'branch_mismatch' });
  });

  it('refuses mid-merge rather than completing the merge silently', async () => {
    await makeConflict();
    await runGit(['merge', 'main'], { cwd: wt }); // leaves MERGE_HEAD + conflict
    await expect(checkpoint({ worktreePath: wt }))
      .rejects.toMatchObject({ reason: 'merge_in_progress' });
    await git(['merge', '--abort'], wt);
  });

  it('missing directory → worktree_not_local, a legible wrong-host refusal', async () => {
    await expect(checkpoint({ worktreePath: join(base, 'no-such-dir') }))
      .rejects.toMatchObject({ reason: 'worktree_not_local' });
  });
});

describe('M2 — rollback', () => {
  it('restores a checkpoint, and the reflog keeps the rolled-over commit reachable', async () => {
    await writeFile(join(wt, 'a.txt'), 'v1\n');
    const cp = await checkpoint({ worktreePath: wt, message: 'tm8 checkpoint v1' });
    await writeFile(join(wt, 'a.txt'), 'v2\n');
    const cp2 = await checkpoint({ worktreePath: wt, message: 'tm8 checkpoint v2' });

    const back = await rollback({ worktreePath: wt, to: cp.oid });
    expect(back.oid).toBe(cp.oid);
    expect(back.previousOid).toBe(cp2.oid);
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('v1\n');

    // Reversible: the newer commit object still exists, so roll forward.
    const forward = await rollback({ worktreePath: wt, to: cp2.oid });
    expect(forward.oid).toBe(cp2.oid);
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('refuses to delete untracked files without force, then deletes them with it', async () => {
    await writeFile(join(wt, 'tracked.txt'), 'v1\n');
    const cp = await checkpoint({ worktreePath: wt });
    await writeFile(join(wt, 'precious-untracked.txt'), 'never committed\n');

    await expect(rollback({ worktreePath: wt, to: cp.oid })).rejects.toMatchObject({
      reason: 'untracked_files_present',
      detail: { untracked: ['precious-untracked.txt'] },
    });
    // The refusal left everything alone.
    expect(await readFile(join(wt, 'precious-untracked.txt'), 'utf8')).toBe('never committed\n');

    const forced = await rollback({ worktreePath: wt, to: cp.oid, force: true });
    expect(forced.deletedUntracked).toEqual(['precious-untracked.txt']);
    await expect(stat(join(wt, 'precious-untracked.txt'))).rejects.toThrow();
    expect(await changedFiles(wt)).toEqual([]);
  });

  it('unknown checkpoint ref → commit_not_found, never a guess', async () => {
    await expect(rollback({ worktreePath: wt, to: 'f'.repeat(40) }))
      .rejects.toMatchObject({ reason: 'commit_not_found' });
  });

  it('hostile ref shapes are refused before any argv slot', async () => {
    for (const evil of ['main; rm -rf /', '--hard', 'a..b', 'x`y`']) {
      await expect(rollback({ worktreePath: wt, to: evil }))
        .rejects.toMatchObject({ name: 'WorktreeError', code: 'invalid_input' });
    }
  });
});

describe('M3 — stage and commit (the rail)', () => {
  it('stages named paths behind `--` and commits exactly the index', async () => {
    await writeFile(join(wt, 'one.txt'), '1\n');
    await writeFile(join(wt, 'two.txt'), '2\n');
    const { staged } = await stage({ worktreePath: wt, paths: ['one.txt'] });
    expect(staged.map((f) => f.path)).toEqual(['one.txt']);

    const done = await commit({ worktreePath: wt, message: 'rail: one only' });
    expect(done.files.map((f) => f.path)).toEqual(['one.txt']);
    // two.txt is still uncommitted WIP.
    expect((await changedFiles(wt)).map((f) => f.path)).toEqual(['two.txt']);
    expect(await git(['log', '-1', '--pretty=%s'], wt)).toBe('rail: one only');
  });

  it('stage --all sweeps everything; commit with an empty index refuses', async () => {
    await expect(commit({ worktreePath: wt, message: 'nothing here' }))
      .rejects.toMatchObject({ reason: 'nothing_staged' });
    await writeFile(join(wt, 'three.txt'), '3\n');
    const { staged } = await stage({ worktreePath: wt, all: true });
    expect(staged.map((f) => f.path)).toEqual(['three.txt']);
    expect(await stagedFiles(wt)).toHaveLength(1);
  });

  it('hostile pathspecs are refused: options, absolute, traversal, NUL', () => {
    for (const evil of ['-rf', '/etc/passwd', '../outside.txt', 'a/../../b', 'x\u0000y', ':(top)secret', '']) {
      expect(() => assertSafePathspec(evil)).toThrow(WorktreeError);
    }
    expect(() => assertSafePathspec('src/ok-file.ts')).not.toThrow();
  });

  it('hostile messages are refused: leading dash, NUL, empty', () => {
    for (const evil of ['--amend', '-m', '', '   ', 'x\u0000y']) {
      expect(() => assertSafeMessage(evil)).toThrow(WorktreeError);
    }
    expect(() => assertSafeMessage('feat: a perfectly normal; message `with` $(bytes)')).not.toThrow();
  });
});

/** Diverge main and the session branch on the same lines of shared.txt. */
async function makeConflict(): Promise<void> {
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN EDIT\nline-2\nline-3\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main moves'], repoRoot);
  await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION EDIT\nline-2\nline-3\n');
  await checkpoint({ worktreePath: wt, message: 'tm8 checkpoint session edit' });
}

describe('M4 — merge with conflict surfacing', () => {
  it('cleanly merges base into the session branch when histories agree', async () => {
    // main gains a commit the session branch does not have, no overlap.
    await writeFile(join(repoRoot, 'main-only.txt'), 'from main\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main advances'], repoRoot);

    const result = await mergeFromRef({ worktreePath: wt, fromRef: 'main' });
    expect(result.status).toBe('merged');
    expect(await readFile(join(wt, 'main-only.txt'), 'utf8')).toBe('from main\n');
  });

  it('an already-merged ref answers up_to_date, not a new commit', async () => {
    const result = await mergeFromRef({ worktreePath: wt, fromRef: 'main' });
    expect(result.status).toBe('up_to_date');
  });

  it('a REAL conflict returns the conflicted paths and leaves the worktree CLEAN', async () => {
    await makeConflict();
    const headBefore = await git(['rev-parse', 'HEAD'], wt);

    const result = await mergeFromRef({ worktreePath: wt, fromRef: 'main' });
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') throw new Error('unreachable');
    expect(result.conflictedPaths).toEqual(['shared.txt']);

    // THE contract: no MERGE_HEAD, clean status, HEAD unmoved, no markers.
    expect((await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt })).code).not.toBe(0);
    expect(await changedFiles(wt)).toEqual([]);
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(headBefore);
    expect(await readFile(join(wt, 'shared.txt'), 'utf8')).not.toContain('<<<<<<<');
  });

  it('a dirty worktree is refused BEFORE any merge starts', async () => {
    await writeFile(join(wt, 'shared.txt'), 'uncommitted local edit\n');
    await expect(mergeFromRef({ worktreePath: wt, fromRef: 'main' }))
      .rejects.toMatchObject({ reason: 'dirty_worktree' });
    // Refusal touched nothing.
    expect(await readFile(join(wt, 'shared.txt'), 'utf8')).toBe('uncommitted local edit\n');
  });

  it('an unknown fromRef is commit_not_found, and hostile refs are inert', async () => {
    await expect(mergeFromRef({ worktreePath: wt, fromRef: 'no-such-branch' }))
      .rejects.toMatchObject({ reason: 'commit_not_found' });
    await expect(mergeFromRef({ worktreePath: wt, fromRef: '--squash' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

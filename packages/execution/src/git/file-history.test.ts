// File history and blame against REAL git repositories in throwaway temp
// directories — no mock for git itself, for branch-topology.test.ts's reason:
// what is under test is largely whether the real binary ACCEPTS the argv this
// module builds (`--follow` with one pathspec behind `--`, `--porcelain`,
// `-L 1,N` and its "has only N lines" refusal). Canned stdout would pass while
// every one of those spellings was wrong.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runGit, WorktreeError } from '../worktree/git-invoker.js';
import { UNCOMMITTED_OID, readFileBlame, readFileHistory, readFileRevisionDiff } from './file-history.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let base: string;
let repo: string;
let notARepo: string;

const AUTHOR = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

// Legal on POSIX, hostile to a shell: `;` command separator, `>` redirection.
// Argv-only invocation must carry it as inert bytes.
const HOSTILE = 'feat-x;echo>pwned.txt';

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function commitFile(file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, file), content);
  await git(['add', '--', file], repo);
  await git([...AUTHOR, 'commit', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

let oid1 = '';
let oid2 = '';
let oid3 = '';

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-file-history-'));
  repo = join(base, 'repo');
  notARepo = join(base, 'plain');
  await git(['init', '-b', 'main', repo], base);
  await runGit(['init', '-b', 'main', notARepo], { cwd: base }); // created…
  await rm(join(notARepo, '.git'), { recursive: true, force: true }); // …then de-gitted

  oid1 = await commitFile('story.txt', 'one\ntwo\nthree\n', 'first: three lines');
  oid2 = await commitFile('story.txt', 'one\nTWO\nthree\nfour\n', 'second: edit + append');
  // A rename `--follow` must walk through.
  await git(['mv', 'story.txt', 'tale.txt'], repo);
  await git([...AUTHOR, 'commit', '-m', 'third: rename'], repo);
  oid3 = await git(['rev-parse', 'HEAD'], repo);

  await commitFile(HOSTILE, 'inert\n', 'hostile name');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('readFileHistory — against real git', () => {
  it('walks revisions through a rename, newest first, with per-revision stats', async () => {
    const history = await readFileHistory(repo, 'tale.txt');
    expect(history.truncated).toBe(false);
    expect(history.revisions.map((r) => r.oid)).toEqual([oid3, oid2, oid1]);
    const first = history.revisions[2];
    expect(first?.subject).toBe('first: three lines');
    expect(first?.author).toBe('t');
    expect(first?.additions).toBe(3);
    expect(first?.deletions).toBe(0);
    expect(first?.path).toBe('story.txt'); // the path AT that revision
    expect(history.revisions[1]?.additions).toBe(2);
    expect(history.revisions[1]?.deletions).toBe(1);
    expect(Date.parse(first?.committedAt ?? '')).not.toBeNaN();
  });

  it('honours maxRevisions and reports the cut', async () => {
    const history = await readFileHistory(repo, 'tale.txt', { maxRevisions: 2 });
    expect(history.revisions).toHaveLength(2);
    expect(history.truncated).toBe(true);
    expect(history.revisions.map((r) => r.oid)).toEqual([oid3, oid2]);
  });

  it('a path with no revisions answers an empty list, not an error', async () => {
    const history = await readFileHistory(repo, 'never-existed.txt');
    expect(history.revisions).toEqual([]);
    expect(history.truncated).toBe(false);
  });

  it('a hostile filename reaches argv as inert data', async () => {
    const history = await readFileHistory(repo, HOSTILE);
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]?.subject).toBe('hostile name');
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['../outside.txt', 'traversal'],
    ['--help', 'option-looking'],
  ])('refuses %s (%s) as invalid_input before git runs', async (path) => {
    await expect(readFileHistory(repo, path)).rejects.toMatchObject({
      code: 'invalid_input',
      reason: 'unsafe_pathspec',
    });
  });

  it('a directory that is not a repository answers invalid_input, not internal', async () => {
    const err = await readFileHistory(notARepo, 'a.txt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).code).toBe('invalid_input');
    expect((err as WorktreeError).reason).toBe('not_a_git_repository');
  });
});

describe('readFileRevisionDiff — against real git', () => {
  it('answers the patch one revision applied to the path', async () => {
    const result = await readFileRevisionDiff(repo, 'story.txt', oid2);
    expect(result.oid).toBe(oid2);
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain('+TWO');
    expect(result.diff).toContain('+four');
    expect(result.diff).toContain('-two');
  });

  it('the initial commit diffs against the empty tree', async () => {
    const result = await readFileRevisionDiff(repo, 'story.txt', oid1);
    expect(result.diff).toContain('+one');
  });

  it('honours maxBytes and says so', async () => {
    const result = await readFileRevisionDiff(repo, 'story.txt', oid2, { maxBytes: 16 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff, 'utf8')).toBeLessThanOrEqual(16);
  });

  it('refuses a non-oid by name before git runs', async () => {
    await expect(readFileRevisionDiff(repo, 'story.txt', 'HEAD')).rejects.toMatchObject({
      code: 'invalid_input',
      reason: 'invalid_oid',
    });
  });
});

describe('readFileBlame — against real git', () => {
  it('groups contiguous lines into hunks with their commit oid and metadata', async () => {
    const blame = await readFileBlame(repo, 'tale.txt');
    expect(blame.truncated).toBe(false);
    expect(blame.totalLines).toBe(4);
    expect(blame.blamedLines).toBe(4);
    // one/three from oid1, TWO/four from oid2 (rename commit touched no line)
    expect(blame.hunks).toHaveLength(4);
    expect(blame.hunks.map((h) => h.oid)).toEqual([oid1, oid2, oid1, oid2]);
    expect(blame.hunks.map((h) => h.startLine)).toEqual([1, 2, 3, 4]);
    expect(blame.hunks[1]?.summary).toBe('second: edit + append');
    expect(blame.hunks[1]?.author).toBe('t');
    expect(Date.parse(blame.hunks[1]?.committedAt ?? '')).not.toBeNaN();
  });

  it('merges contiguous same-commit lines into one hunk', async () => {
    const blame = await readFileBlame(repo, HOSTILE);
    expect(blame.hunks).toHaveLength(1);
    expect(blame.hunks[0]).toMatchObject({ startLine: 1, lineCount: 1, summary: 'hostile name' });
  });

  it('honours maxLines, and the cut says how many lines it holds back', async () => {
    const blame = await readFileBlame(repo, 'tale.txt', { maxLines: 2 });
    expect(blame.blamedLines).toBe(2);
    expect(blame.totalLines).toBe(4);
    expect(blame.truncated).toBe(true);
    expect(blame.hunks.map((h) => h.startLine)).toEqual([1, 2]);
  });

  it('uncommitted working-tree lines blame to the all-zero oid, by name', async () => {
    await writeFile(join(repo, 'tale.txt'), 'one\nTWO\nthree\nfour\nfive-uncommitted\n');
    try {
      const blame = await readFileBlame(repo, 'tale.txt');
      const last = blame.hunks[blame.hunks.length - 1];
      expect(last?.oid).toBe(UNCOMMITTED_OID);
      expect(last?.author).toBe('not yet committed');
      expect(last?.startLine).toBe(5);
    } finally {
      await git(['checkout', '--', 'tale.txt'], repo);
    }
  });

  it('a missing path refuses by name', async () => {
    await expect(readFileBlame(repo, 'never-existed.txt')).rejects.toMatchObject({
      code: 'invalid_input',
      reason: 'no_such_path',
    });
  });

  it('refuses unsafe pathspecs before git runs', async () => {
    await expect(readFileBlame(repo, '../outside.txt')).rejects.toMatchObject({
      code: 'invalid_input',
      reason: 'unsafe_pathspec',
    });
  });

  it('a directory that is not a repository answers invalid_input', async () => {
    await expect(readFileBlame(notARepo, 'a.txt')).rejects.toMatchObject({
      code: 'invalid_input',
      reason: 'not_a_git_repository',
    });
  });
});

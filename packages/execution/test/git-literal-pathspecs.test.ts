/**
 * A PATHSPEC IS A GLOB, AND `--` DOES NOT CHANGE THAT.
 *
 * The two are constantly conflated. Argv separation (`--`) stops a filename
 * being read as an OPTION; it says nothing about wildcards. So a repository
 * that holds a file literally named `a*.txt` — a perfectly legal name on every
 * platform tm8 runs on — turns an exact request into a pattern match:
 *
 *   git reset -q HEAD -- 'a*.txt'   unstages a*.txt, abc.txt AND axz.txt
 *   git diff --numstat -- 'a*.txt'  answers for all three
 *   git add -- 'a*.txt'             stages every match when no exact one exists
 *
 * Every pathspec the Changes surface sends is an EXACT name it read out of a
 * status listing. Glob semantics are never wanted, and when a name happens to
 * contain `*`, `?` or `[` they silently widen the operation past what the
 * reviewer ticked. `--literal-pathspecs` before the subcommand turns them off;
 * `GIT_LITERAL_PATHSPECS` in `git-invoker` is the same guarantee at the choke
 * point, for any call site that forgets.
 *
 * Measured against git 2.43.0. Each case below asserts the NEIGHBOUR — the
 * ordinary file the wildcard would have matched — because that is the file a
 * widened pathspec touches without being asked to.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stage, unstage } from '../src/worktree/index.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

/** Porcelain UNTRIMMED: the index/worktree column is the whole claim here. */
function porcelain(cwd: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: ENV })
    .split('\n')
    .filter((line) => line !== '');
}

/** The literal-asterisk name, and the two ordinary names it would match. */
const STAR = 'a*.txt';
const NEIGHBOURS = ['abc.txt', 'axz.txt'];

describe('literal pathspecs', () => {
  const made: string[] = [];

  /** A repo with `a*.txt`, `abc.txt` and `axz.txt` committed and then edited. */
  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-literal-'));
    made.push(dir);
    git(dir, 'init', '-b', 'main');
    for (const name of [STAR, ...NEIGHBOURS]) await writeFile(join(dir, name), `${name} v1\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    for (const name of [STAR, ...NEIGHBOURS]) await writeFile(join(dir, name), `${name} v2\n`);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('the premise: git really does hold a file whose name is a wildcard', async () => {
    const dir = await repo();
    // Sorted by byte, and `*` (0x2A) sorts before any letter. If git ever
    // started C-quoting this name the rest of the file would be asserting
    // against the wrong string, so prove the plain form here once.
    expect(porcelain(dir)).toEqual([' M a*.txt', ' M abc.txt', ' M axz.txt']);
  });

  it('stages only the wildcard-NAMED file, leaving the files it would match alone', async () => {
    const dir = await repo();

    const { staged } = await stage({ worktreePath: dir, paths: [STAR] });

    expect(staged.map((f) => f.path)).toEqual([STAR]);
    expect(porcelain(dir)).toEqual(['M  a*.txt', ' M abc.txt', ' M axz.txt']);
  });

  it('unstages only the wildcard-NAMED file — the neighbours keep their staged edits', async () => {
    const dir = await repo();
    git(dir, 'add', '-A');
    expect(porcelain(dir)).toEqual(['M  a*.txt', 'M  abc.txt', 'M  axz.txt']);

    const { staged, paths } = await unstage({ worktreePath: dir, paths: [STAR] });

    // The echoed paths are exactly what was asked for: nothing expanded.
    expect(paths).toEqual([STAR]);
    // …and the two neighbours are STILL STAGED. Without a literal pathspec
    // this list is empty: one tick unstaged three files.
    expect(staged.map((f) => f.path)).toEqual(NEIGHBOURS);
    expect(porcelain(dir)).toEqual([' M a*.txt', 'M  abc.txt', 'M  axz.txt']);
  });

  /**
   * The pattern-match case pointed the other way: a name with no exact match
   * left on disk. Plain `git add` would glob and stage both neighbours here.
   * Literal, git says the pathspec matched nothing and `stage` REFUSES BY
   * NAME — an honest failure beats staging two files nobody selected.
   */
  it('refuses a wildcard name that matches nothing rather than staging what it would match', async () => {
    const dir = await repo();
    // The name leaves the index, HEAD and the worktree, so git has no exact
    // entry to prefer — the situation a stale status row produces when the
    // agent deletes a file between the read and the click.
    git(dir, '--literal-pathspecs', 'rm', '-q', '-f', STAR);
    git(dir, 'commit', '-m', 'the wildcard-named file is gone');
    expect(porcelain(dir)).toEqual([' M abc.txt', ' M axz.txt']);

    await expect(stage({ worktreePath: dir, paths: [STAR] })).rejects.toMatchObject({
      reason: 'add_failed',
    });
    // Neither neighbour moved. Plain `git add -- 'a*.txt'` stages BOTH here.
    expect(porcelain(dir)).toEqual([' M abc.txt', ' M axz.txt']);
    expect(await readFile(join(dir, 'abc.txt'), 'utf8')).toBe('abc.txt v2\n');
  });
});

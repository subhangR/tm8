/**
 * `unstage` — the index verb the Changes surface needs, and the two refusals
 * that keep it honest.
 *
 * It is a MIXED reset scoped to pathspecs (`git reset -q HEAD -- <paths>`),
 * which is the only reset git allows with pathspecs at all. The whole point is
 * that it moves the INDEX and nothing else, so the first case here reads the
 * bytes back off disk afterwards rather than trusting the porcelain: a
 * `--hard` slip would satisfy every status assertion and silently destroy the
 * reviewer's uncommitted work.
 *
 * The facade suite (`server/test/facade/execution-git-changes.test.ts`) covers
 * the ordinary path against a lane repo. These two cases cannot be reached
 * from there — a lane always has a base commit, and a mid-merge worktree is
 * not a state that suite leaves behind.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstage } from '../src/worktree/index.js';

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

/**
 * Porcelain UNTRIMMED. ` M a.txt` and `M  a.txt` differ only in which column
 * the letter sits in — index or worktree — which is the entire claim this file
 * makes, and `.trim()` eats exactly that byte.
 */
function porcelain(cwd: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: ENV })
    .split('\n')
    .filter((line) => line !== '');
}

/** `git merge` is expected to FAIL here; its exit code is the point. */
function tryGit(cwd: string, ...args: string[]): void {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: 'pipe' });
  } catch {
    /* the conflict is the state under test */
  }
}

describe('worktree unstage', () => {
  const made: string[] = [];

  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-unstage-'));
    made.push(dir);
    git(dir, 'init', '-b', 'main');
    return dir;
  }

  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('moves the index and leaves the working tree byte-for-byte alone', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.txt'), 'committed\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    await writeFile(join(dir, 'a.txt'), 'edited\n');
    await writeFile(join(dir, 'b.txt'), 'brand new\n');
    git(dir, 'add', '-A');

    const { staged } = await unstage({ worktreePath: dir, paths: ['a.txt', 'b.txt'] });

    expect(staged).toEqual([]);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('edited\n');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('brand new\n');
    // `b.txt` goes back to untracked, `a.txt` to modified-not-staged.
    expect(porcelain(dir)).toEqual([' M a.txt', '?? b.txt']);
  });

  it('names the unborn-HEAD case instead of leaking a raw git failure', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.txt'), 'first ever\n');
    git(dir, 'add', '-A');

    await expect(unstage({ worktreePath: dir, paths: ['a.txt'] })).rejects.toMatchObject({
      reason: 'no_head',
    });
    // Refused, so the index is untouched — the file is still staged.
    expect(porcelain(dir)).toEqual(['A  a.txt']);
  });

  it('refuses mid-merge: an unstage there would strip the resolution from the index', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.txt'), 'base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'checkout', '-b', 'other');
    await writeFile(join(dir, 'a.txt'), 'theirs\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'theirs');
    git(dir, 'checkout', 'main');
    await writeFile(join(dir, 'a.txt'), 'ours\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'ours');
    tryGit(dir, 'merge', 'other');

    await expect(unstage({ worktreePath: dir, paths: ['a.txt'] })).rejects.toMatchObject({
      reason: 'merge_in_progress',
    });
  });

  it('refuses with no pathspecs rather than resetting the whole index by accident', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    await writeFile(join(dir, 'a.txt'), 'y\n');
    git(dir, 'add', '-A');

    await expect(unstage({ worktreePath: dir })).rejects.toMatchObject({
      reason: 'nothing_to_unstage',
    });
    expect(porcelain(dir)).toEqual(['M  a.txt']);
  });

  /**
   * THE RENAME LEAK.
   *
   * `git mv old new` puts TWO entries in the index — a deletion of `old` and
   * an addition of `new` — and reports them as ONE row: `R  old -> new`, which
   * every surface above this holds as a single file with a `path` and an
   * `origPath`. A reviewer who ticks that one row and presses Unstage is
   * asking for the rename to leave the index.
   *
   * `git reset HEAD -- new` gives them half of it: the deletion of `old` stays
   * STAGED and `new` becomes untracked — an index that now says "delete this
   * file", which nobody asked for, reached by pressing a button labelled
   * Unstage. This asserts the whole rename leaves, both files stay on disk,
   * and the caller is TOLD the second path moved.
   */
  it('unstages BOTH halves of a staged rename, and says it did', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'old.txt'), 'content that survives the move\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'mv', 'old.txt', 'new.txt');
    // The premise, asserted rather than assumed: git really does score this as
    // a rename, one row, both paths.
    expect(porcelain(dir)).toEqual(['R  old.txt -> new.txt']);

    const { staged, paths } = await unstage({ worktreePath: dir, paths: ['new.txt'] });

    // THE INDEX IS EMPTY. Not "half reset" — nothing staged at all.
    expect(staged).toEqual([]);
    // …and the caller is told what actually moved, `old.txt` included.
    expect([...paths].sort()).toEqual(['new.txt', 'old.txt']);
    // BOTH worktree paths survive: the rename is still there on disk, it is
    // simply no longer in the index. ` D` + `??`, never a deletion staged.
    expect(porcelain(dir)).toEqual([' D old.txt', '?? new.txt']);
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('content that survives the move\n');
  });

  it('expands the rename from EITHER half — the old path reaches the new one too', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'old.txt'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'mv', 'old.txt', 'new.txt');

    const { staged, paths } = await unstage({ worktreePath: dir, paths: ['old.txt'] });

    expect(staged).toEqual([]);
    expect([...paths].sort()).toEqual(['new.txt', 'old.txt']);
    expect(porcelain(dir)).toEqual([' D old.txt', '?? new.txt']);
  });

  /**
   * THE EXPANSION POINTED THE OTHER WAY, which would be the same bug.
   *
   * `git diff --cached` also reports COPIES (`C100 old new`), and there the
   * source is untouched by the copy: it may carry a genuine, wholly unrelated
   * staged change of its own. Expanding a copy would reset that change — a
   * silent widening dressed up as a fix for a silent narrowing.
   */
  it('does not drag an unrelated staged file along with a copied one', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'src.txt'), 'shared body\n');
    await writeFile(join(dir, 'other.txt'), 'untouched\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    // A copy AND an independent staged edit to the source.
    await writeFile(join(dir, 'copy.txt'), 'shared body\n');
    await writeFile(join(dir, 'src.txt'), 'shared body\nplus an edit nobody asked to revert\n');
    git(dir, 'add', '-A');

    const { paths } = await unstage({ worktreePath: dir, paths: ['copy.txt'] });

    expect(paths).toEqual(['copy.txt']);
    // `src.txt` keeps its own staged edit; only the copy left the index.
    expect(porcelain(dir)).toEqual(['M  src.txt', '?? copy.txt']);
  });

  it('all: true is the explicit way to clear the index, and still moves no bytes', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    await writeFile(join(dir, 'a.txt'), 'y\n');
    await writeFile(join(dir, 'b.txt'), 'z\n');
    git(dir, 'add', '-A');

    const { staged } = await unstage({ worktreePath: dir, all: true });
    expect(staged).toEqual([]);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('y\n');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('z\n');
  });
});

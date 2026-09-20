/**
 * `stageHunks` against REAL git — the half `hunks.test.ts` cannot prove.
 *
 * The parser suite proves the patch text is what we intended. Only `git apply
 * --cached` can prove it is what GIT accepts, and the two are not the same
 * claim: a subset patch whose `@@` header disagrees with its body by even one
 * line is well-formed text that git rejects outright. Deliberately NO
 * `--recount` in the verb, so that disagreement surfaces here as a failure
 * rather than being silently repaired into a wrong index.
 *
 * Every content assertion reads the INDEX blob (`git show :path`), never the
 * porcelain. A hunk-staging bug that stages too much still produces a tidy
 * `MM` line; only the staged bytes tell the truth.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHunks, stageHunks } from '../src/worktree/index.js';
import { digestHunks, parseUnifiedDiff } from '../src/worktree/hunks.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV });
}

/** The staged bytes. The only witness that says which hunk actually landed. */
function indexBlob(cwd: string, path: string): string {
  return git(cwd, 'show', `:${path}`);
}

const BASE = Array.from({ length: 30 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';

/**
 * Two changes far enough apart to be two hunks, and the FIRST one INSERTS.
 * That asymmetry is the whole point: hunk 2's post-image start (24) differs
 * from its pre-image start (22) only because hunk 1 added two lines ahead of
 * it. Stage hunk 2 alone and 24 becomes a lie git will reject.
 */
const EDITED = BASE.replace('L03\n', 'L03\nINSERTED-A\nINSERTED-B\n').replace('L25\n', 'CHANGED-25\n');

describe('stageHunks against real git', () => {
  const made: string[] = [];

  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-hunks-'));
    made.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'f.txt'), BASE, 'utf8');
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'base');
    await writeFile(join(dir, 'f.txt'), EDITED, 'utf8');
    return dir;
  }

  afterEach(async () => {
    while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true });
  });

  it('sees exactly two hunks in the fixture', async () => {
    const dir = await repo();
    const parsed = parseUnifiedDiff(git(dir, 'diff', '--no-color', '--', 'f.txt'));
    expect(parsed.hunks).toHaveLength(2);
    // Guards the fixture itself: if git's context rules ever merge these into
    // one hunk, every offset claim below becomes vacuous instead of failing.
    expect(parsed.hunks[1]!.oldStart).not.toBe(parsed.hunks[1]!.newStart);
  });

  it('stages the FIRST hunk alone, leaving the second only in the worktree', async () => {
    const dir = await repo();
    const res = await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [1] });
    expect(res.appliedHunks).toBe(1);
    expect(res.totalHunks).toBe(2);

    const staged = indexBlob(dir, 'f.txt');
    expect(staged).toContain('INSERTED-A');
    expect(staged).toContain('INSERTED-B');
    expect(staged).toContain('L25');          // the second change did NOT land
    expect(staged).not.toContain('CHANGED-25');
    // and the worktree still holds everything the reviewer wrote
    expect(git(dir, 'status', '--porcelain')).toContain('MM f.txt');
  });

  it('stages the SECOND hunk alone — the offset git would reject if miscomputed', async () => {
    const dir = await repo();
    const res = await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [2] });
    expect(res.appliedHunks).toBe(1);

    const staged = indexBlob(dir, 'f.txt');
    expect(staged).toContain('CHANGED-25');
    expect(staged).not.toContain('INSERTED-A');
    expect(staged).not.toContain('INSERTED-B');
    // Staged file is the base with ONE line substituted: still 30 lines.
    expect(staged.trimEnd().split('\n')).toHaveLength(30);
  });

  it('stages both hunks when both are named, reproducing a whole-file stage', async () => {
    const dir = await repo();
    await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [1, 2] });
    expect(indexBlob(dir, 'f.txt')).toBe(EDITED);
    // Nothing left unstaged: the worktree and index agree.
    expect(git(dir, 'status', '--porcelain')).toContain('M  f.txt');
  });

  it('unstages a single hunk back out of a fully-staged file', async () => {
    const dir = await repo();
    git(dir, 'add', 'f.txt');
    expect(indexBlob(dir, 'f.txt')).toBe(EDITED);

    const res = await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [1], reverse: true });
    expect(res.appliedHunks).toBe(1);

    const staged = indexBlob(dir, 'f.txt');
    expect(staged).not.toContain('INSERTED-A');   // hunk 1 backed out of the index
    expect(staged).toContain('CHANGED-25');       // hunk 2 still staged
    // THE CLAIM THAT MATTERS: the working tree is untouched by an unstage.
    expect(git(dir, 'diff', '--no-color', '--', 'f.txt')).toContain('INSERTED-A');
  });

  it('refuses a stale selection when the digest no longer matches', async () => {
    const dir = await repo();
    const digest = digestHunks(parseUnifiedDiff(git(dir, 'diff', '--no-color', '--', 'f.txt')).hunks);
    // Somebody — an agent lane, say — edits the file under the reviewer.
    await writeFile(join(dir, 'f.txt'), EDITED.replace('CHANGED-25', 'CHANGED-25-AGAIN'), 'utf8');

    await expect(stageHunks({ worktreePath: dir, path: 'f.txt', indices: [2], digest }))
      .rejects.toMatchObject({ reason: 'hunks_stale', code: 'conflict' });
    // and refusing means refusing: nothing was staged on the way to the throw.
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('accepts a digest that survived a pure line-number shift elsewhere in the file', async () => {
    const dir = await repo();
    const digest = digestHunks(parseUnifiedDiff(git(dir, 'diff', '--no-color', '--', 'f.txt')).hunks);
    // Re-derived from the same content: the digest is over hunk bodies, so it
    // is stable across reads. (The shift case itself is covered in hunks.test.)
    const res = await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [2], digest });
    expect(res.appliedHunks).toBe(1);
  });

  it('names an untracked file rather than reporting an empty diff', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'new.txt'), 'hello\n', 'utf8');
    await expect(stageHunks({ worktreePath: dir, path: 'new.txt', indices: [1] }))
      .rejects.toMatchObject({ reason: 'no_hunks_available' });
  });

  it('refuses an out-of-range hunk index instead of staging what it can', async () => {
    const dir = await repo();
    await expect(stageHunks({ worktreePath: dir, path: 'f.txt', indices: [1, 9] }))
      .rejects.toThrow(/out of range/);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses a path that reads as an option before git ever sees it', async () => {
    const dir = await repo();
    await expect(stageHunks({ worktreePath: dir, path: '--output=/tmp/pwn', indices: [1] }))
      .rejects.toMatchObject({ reason: 'unsafe_pathspec' });
  });

  it('refuses a binary file by name', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git(dir, 'add', 'b.bin');
    git(dir, 'commit', '-q', '-m', 'bin');
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
    await expect(stageHunks({ worktreePath: dir, path: 'b.bin', indices: [1] }))
      .rejects.toMatchObject({ reason: 'binary_file' });
  });

  /**
   * `readHunks` is the listing a client selects FROM, and `stageHunks` is what
   * verifies the selection. If their digests could ever disagree, every
   * selection would be refused as stale with no edit to explain it — so the
   * agreement is asserted, not assumed, and both go through one derivation.
   */
  it('produces a digest stageHunks accepts, with no edit in between', async () => {
    const dir = await repo();
    const listing = await readHunks({ worktreePath: dir, path: 'f.txt' });
    expect(listing).not.toBeNull();
    expect(listing!.count).toBe(2);
    expect(listing!.hunks.map((h) => h.index)).toEqual([1, 2]);
    const res = await stageHunks({
      worktreePath: dir, path: 'f.txt', indices: [1], digest: listing!.digest,
    });
    expect(res.appliedHunks).toBe(1);
  });

  it('reads the staged side separately, and it is a different digest', async () => {
    const dir = await repo();
    await stageHunks({ worktreePath: dir, path: 'f.txt', indices: [1] });
    const unstaged = await readHunks({ worktreePath: dir, path: 'f.txt' });
    const staged = await readHunks({ worktreePath: dir, path: 'f.txt', staged: true });
    expect(unstaged!.count).toBe(1);   // hunk 2 is still only in the worktree
    expect(staged!.count).toBe(1);     // hunk 1 is now in the index
    expect(staged!.digest).not.toBe(unstaged!.digest);
  });

  it('answers null — not an exception — for a file that cannot be split', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'new.txt'), 'hello\n', 'utf8');
    expect(await readHunks({ worktreePath: dir, path: 'new.txt' })).toBeNull();
    // The same state THROWS from stageHunks, where a selection was made
    // against something that cannot honour it. Both are covered above.
  });

  it('refuses an empty selection', async () => {
    const dir = await repo();
    await expect(stageHunks({ worktreePath: dir, path: 'f.txt', indices: [] }))
      .rejects.toMatchObject({ reason: 'no_hunks_selected' });
  });
});

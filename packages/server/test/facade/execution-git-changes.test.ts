/**
 * THE CHANGES SLICE behind the facade: `execution.gitStage`, the path- and
 * scope-scoped `execution.gitDiff`, and the commit refusal that keeps
 * "Commit selected" honest.
 *
 * Same posture as `execution-git.test.ts` — registered handlers driven as
 * functions against a REAL temp repository, because every claim here is a
 * claim about git: that `reset` moves the index and not the working tree,
 * that a file with both halves pending shows a DIFFERENT diff in each scope,
 * that `--no-index` exits 1 on a difference, and that a commit writes the
 * whole index whatever paths it was handed. A mocked git would let all four
 * pass while false.
 *
 * A SEPARATE FILE, and a separate repo, on purpose: the suite next door runs
 * its cases in order against one shared worktree, so a case inserted there
 * would silently change the state every later case reads.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionGitCommitResult, SessionGitDiff, SessionGitStageResult, SessionGitStatus } from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionGitHandlers } from '../../src/facade/services/execution-git.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const WORKTREE_ID = '55555555-5555-4555-8555-555555555555';

interface LaneRow {
  session_id: string;
  workdir_mode: string | null;
  base_ref: string | null;
  worktree_id: string | null;
  path: string | null;
  branch: string | null;
  base_commit_oid: string | null;
  worktree_status: string | null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function buildRegistry(rows: () => LaneRow[]): HandlerRegistry {
  const db: Db = { query: async () => rows() as never } as unknown as Db;
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 8 * 1024 * 1024,
    databaseUrl: 'unused',
  } as unknown as ServerConfig;
  const registry = new HandlerRegistry();
  registerExecutionGitHandlers(registry, {
    db,
    config,
    owner: async () => ({ identityId: 'ident', accountId: 'acct', isNodeAdmin: false }) as never,
  });
  return registry;
}

function handlerFor(registry: HandlerRegistry, name: string): OperationHandler {
  const handler = registry.get(name as never);
  if (!handler) throw new Error(`${name} not registered`);
  return handler;
}

function ctxFor(query: Record<string, string> = {}, body?: unknown): RequestContext {
  return {
    params: { workSessionId: SESSION_ID },
    query: new URLSearchParams(query),
    body,
    requestId: 'req-1',
  } as unknown as RequestContext;
}

describe('execution.gitStage / scoped gitDiff / exact gitCommit', () => {
  let repo: string;
  let baseOid: string;
  let registry: HandlerRegistry;

  const lane = (): LaneRow => ({
    session_id: SESSION_ID,
    workdir_mode: 'worktree',
    base_ref: 'main',
    worktree_id: WORKTREE_ID,
    path: repo,
    branch: 'tm8/lane',
    base_commit_oid: baseOid,
    worktree_status: 'active',
  });

  const status = async (): Promise<SessionGitStatus> =>
    (await handlerFor(registry, 'execution.gitStatus')(ctxFor())) as SessionGitStatus;
  const diff = async (query: Record<string, string>): Promise<SessionGitDiff> =>
    (await handlerFor(registry, 'execution.gitDiff')(ctxFor(query))) as SessionGitDiff;
  const stage = async (body: unknown): Promise<SessionGitStageResult> =>
    (await handlerFor(registry, 'execution.gitStage')(ctxFor({}, body))) as SessionGitStageResult;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tm8-git-changes-'));
    git(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await writeFile(join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    baseOid = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'tm8/lane');
    registry = buildRegistry(() => [lane()]);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Back to the base commit with an empty index and no stray files. */
  beforeEach(() => {
    git(repo, 'reset', '--hard', baseOid);
    git(repo, 'clean', '-fdq');
  });

  it('stages named paths, and unstage walks the index back without moving a byte on disk', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    await writeFile(join(repo, 'fresh.txt'), 'new file\n');

    const staged = await stage({ action: 'stage', paths: ['a.txt', 'fresh.txt'] });
    expect(staged.action).toBe('stage');
    expect(staged.branch).toBe('tm8/lane');
    expect(staged.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'fresh.txt']);
    expect(staged.dirty.staged).toBe(2);
    expect(staged.dirty.untracked).toBe(0); // it is tracked now: `A`, not `??`

    const back = await stage({ action: 'unstage', paths: ['a.txt', 'fresh.txt'] });
    expect(back.action).toBe('unstage');
    expect(back.staged).toEqual([]);

    // THE CLAIM UNSTAGE MAKES: the index moved, the working tree did not.
    // A `--hard` reset would pass every assertion above and destroy the work.
    expect(await readFileText(join(repo, 'a.txt'))).toBe('two\n');
    expect(await readFileText(join(repo, 'fresh.txt'))).toBe('new file\n');
    const after = await status();
    expect(after.dirty.unstaged).toBe(1);
    expect(after.dirty.untracked).toBe(1);
  });

  /**
   * THE RENAME, THROUGH THE FACADE.
   *
   * `git mv` is one porcelain row and two index entries, and the reviewer's
   * row carries both paths. The execution suite proves the expansion against
   * real git; this proves the FACADE contract on top of it — that `paths` on
   * the answer is what actually moved rather than what was asked for, because
   * a client that echoed the request would render "unstaged 1 file" over an
   * index that had two entries removed.
   */
  it('unstages a rename whole, and reports the second path it had to touch', async () => {
    git(repo, 'mv', 'a.txt', 'renamed.txt');
    const before = await status();
    expect(before.files).toEqual([
      { status: 'R ', path: 'renamed.txt', origPath: 'a.txt' },
    ]);

    const back = await stage({ action: 'unstage', paths: ['renamed.txt'] });

    // Nothing staged at all — not a staged deletion of `a.txt` left behind.
    expect(back.staged).toEqual([]);
    expect(back.dirty.staged).toBe(0);
    // The answer names BOTH paths, including the one the client never sent.
    expect([...back.paths].sort()).toEqual(['a.txt', 'renamed.txt']);
    // Both worktree paths survive: the file is still moved on disk.
    expect(await readFileText(join(repo, 'renamed.txt'))).toBe('one\n');
    expect(back.files).toEqual([
      { status: ' D', path: 'a.txt' },
      { status: '??', path: 'renamed.txt' },
    ]);
  });

  it('a stage echoes exactly the request — the expansion is unstage-only', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    const staged = await stage({ action: 'stage', paths: ['a.txt'] });
    expect(staged.paths).toEqual(['a.txt']);
  });

  /**
   * `paths` REPORTS ARGV, NOT INTENT. `all: true` runs `git add -A`, which is
   * given no pathspecs at all, so echoing the request's `paths` here would
   * claim the server scoped an operation it deliberately did not scope — one
   * field meaning two different things depending on a flag beside it.
   */
  it('reports NO paths for an all:true stage, even when the request carried one', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    await writeFile(join(repo, 'c.txt'), 'brand new\n');

    const everything = await stage({ action: 'stage', all: true, paths: ['a.txt'] });

    expect(everything.all).toBe(true);
    expect(everything.paths).toEqual([]);
    // …and it really did stage everything, `c.txt` included.
    expect(everything.staged.map((f) => f.path)).toEqual(['a.txt', 'c.txt']);
  });

  it('refuses an unstage with no pathspecs rather than quietly resetting everything', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    await stage({ action: 'stage', paths: ['a.txt'] });
    await expect(stage({ action: 'unstage', paths: [] })).rejects.toMatchObject({
      details: { reason: 'nothing_to_unstage' },
    });
    expect((await status()).dirty.staged).toBe(1);
  });

  /**
   * THE `MM` CASE — one file, both halves pending, and the two scopes must
   * disagree. This is the case a single-bucket surface cannot represent: the
   * staged diff is the answer to "what will this commit write", the unstaged
   * diff to "what will it leave behind", and they are different bytes.
   */
  it('a file staged and then edited again reports both halves, each with its own diff', async () => {
    await writeFile(join(repo, 'a.txt'), 'staged line\n');
    await stage({ action: 'stage', paths: ['a.txt'] });
    await writeFile(join(repo, 'a.txt'), 'staged line\nworking line\n');

    const st = await status();
    const row = st.files.find((f) => f.path === 'a.txt');
    expect(row?.status).toBe('MM');
    expect(st.dirty.staged).toBe(1);
    expect(st.dirty.unstaged).toBe(1);

    const stagedDiff = await diff({ path: 'a.txt', scope: 'staged' });
    expect(stagedDiff.scope).toBe('staged');
    expect(stagedDiff.path).toBe('a.txt');
    expect(stagedDiff.untracked).toBe(false);
    expect(stagedDiff.diff).toContain('+staged line');
    expect(stagedDiff.diff).not.toContain('+working line');

    const unstagedDiff = await diff({ path: 'a.txt', scope: 'unstaged' });
    expect(unstagedDiff.scope).toBe('unstaged');
    expect(unstagedDiff.diff).toContain('+working line');
    expect(unstagedDiff.diff).not.toContain('+staged line');

    // And the session scope still answers the third question: everything since
    // the lane branched, both halves together.
    const sessionDiff = await diff({ path: 'a.txt' });
    expect(sessionDiff.scope).toBe('session');
    expect(sessionDiff.diff).toContain('+staged line');
    expect(sessionDiff.diff).toContain('+working line');
  });

  it('narrows to one path: a second changed file is absent from the answer', async () => {
    await writeFile(join(repo, 'a.txt'), 'edited a\n');
    await writeFile(join(repo, 'b.txt'), 'edited b\n');
    const only = await diff({ path: 'a.txt' });
    expect(only.stat.filesChanged).toBe(1);
    expect(only.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(only.diff).not.toContain('b.txt');
  });

  /**
   * A PATHSPEC IS A GLOB, AND `--` DOES NOT CHANGE THAT — `--` keeps a name
   * from being read as an OPTION, nothing more. A repository holding a file
   * literally named `a*.txt` makes plain `git diff --numstat -- 'a*.txt'`
   * answer for `a*.txt` AND `axz.txt`: three files under a request for one,
   * which is the opposite of a bounded diff. The path here came out of a
   * status listing, so it is an exact name and never a pattern.
   * `--literal-pathspecs` is what says so; see `git-literal-pathspecs.test.ts`
   * for the stage/unstage half.
   */
  it('a wildcard in a FILENAME does not widen a scoped diff to the names it would match', async () => {
    await writeFile(join(repo, 'a*.txt'), 'star\n');
    await writeFile(join(repo, 'axz.txt'), 'ordinary\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'a wildcard-named file beside one it would match');
    await writeFile(join(repo, 'a*.txt'), 'star edited\n');
    await writeFile(join(repo, 'axz.txt'), 'ordinary edited\n');

    const one = await diff({ path: 'a*.txt' });

    expect(one.files.map((f) => f.path)).toEqual(['a*.txt']);
    expect(one.stat.filesChanged).toBe(1);
    expect(one.diff).not.toContain('axz.txt');
  });

  /**
   * The same hazard on the OTHER read in this path. `ls-files --error-unmatch`
   * is how the server decides tracked-vs-untracked, and globbing makes it
   * answer about a neighbour: `a*.txt` is brand new, `axz.txt` is committed,
   * and a pattern match reports the new file as tracked. The reader would then
   * get `untracked: false` and an EMPTY diff for a file that is plainly new.
   */
  it('a wildcard filename is still untracked when a name it would match is tracked', async () => {
    await writeFile(join(repo, 'axz.txt'), 'committed neighbour\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'only the neighbour is tracked');
    await writeFile(join(repo, 'a*.txt'), 'brand new\n');

    const fresh = await diff({ path: 'a*.txt' });

    expect(fresh.untracked).toBe(true);
    expect(fresh.diff).toContain('+brand new');
    expect(fresh.files.map((f) => f.path)).toEqual(['a*.txt']);
  });

  it('rejects a scope it does not implement instead of silently answering another one', async () => {
    await expect(diff({ path: 'a.txt', scope: 'everything' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  /**
   * UNTRACKED — git's ordinary `diff` cannot see a file it has no index entry
   * for, so the server falls back to `--no-index` against /dev/null. Three
   * things must hold, and all three are easy to get wrong:
   *   · exit code 1 means "a difference was found" — the SUCCESS case here,
   *     not a failure;
   *   · the same byte cap and `diffTruncated` flag as the tracked path;
   *   · the path stays inside the worktree (see the symlink case below).
   */
  it('diffs an untracked file against /dev/null and reports exit-1 as the answer, not a failure', async () => {
    await writeFile(join(repo, 'fresh.txt'), 'alpha\nbeta\n');
    const answer = await diff({ path: 'fresh.txt' });
    expect(answer.available).toBe(true);
    expect(answer.unavailableReason).toBeNull();
    expect(answer.untracked).toBe(true);
    expect(answer.path).toBe('fresh.txt');
    expect(answer.diff).toContain('+alpha');
    expect(answer.diff).toContain('+beta');
    expect(answer.diffTruncated).toBe(false);
    // The numstat row is named for the REQUESTED path, not git's
    // `/dev/null => fresh.txt` pair name.
    expect(answer.files.map((f) => f.path)).toEqual(['fresh.txt']);
    expect(answer.files[0]?.additions).toBe(2);
    expect(answer.stat.additions).toBe(2);
  });

  /**
   * SCOPE TRUTH FOR AN UNTRACKED FILE.
   *
   * The whole-file `--no-index` answer above is the SESSION answer: an
   * untracked file is entirely new since the lane branched. It is not the
   * staged answer — the index holds none of it — and the UI captions the
   * staged scope "index vs HEAD, exactly what a commit would write". Handing
   * back the whole file there would put a diff under a caption that is false
   * about it, and it is reachable by opening an untracked file under All and
   * pressing the Staged chip.
   *
   * Empty, available, and still flagged `untracked` so a client can tell this
   * apart from a tracked file with nothing staged.
   */
  it('answers an untracked file EMPTY in the staged and unstaged scopes, not as a whole-file addition', async () => {
    await writeFile(join(repo, 'fresh.txt'), 'alpha\nbeta\n');

    for (const scope of ['staged', 'unstaged']) {
      const answer = await diff({ path: 'fresh.txt', scope });
      expect(answer.available).toBe(true);
      expect(answer.unavailableReason).toBeNull();
      expect(answer.scope).toBe(scope);
      expect(answer.diff).toBe('');
      expect(answer.files).toEqual([]);
      expect(answer.stat).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
      // Empty BECAUSE untracked, and the flag says which kind of empty it is.
      expect(answer.untracked).toBe(true);
    }

    // …and the session scope, which the chip actually uses, is unchanged.
    const session = await diff({ path: 'fresh.txt', scope: 'session' });
    expect(session.untracked).toBe(true);
    expect(session.diff).toContain('+alpha');
  });

  it('applies the same byte cap to an untracked diff, and keeps the digest complete', async () => {
    await writeFile(join(repo, 'fresh.txt'), 'x\n'.repeat(400));
    const capped = await diff({ path: 'fresh.txt', maxBytes: '64' });
    expect(capped.untracked).toBe(true);
    expect(capped.diffTruncated).toBe(true);
    expect(Buffer.byteLength(capped.diff, 'utf8')).toBeLessThanOrEqual(64);
    // digest+partial: the counts are complete even though the text is not.
    expect(capped.files[0]?.additions).toBe(400);
  });

  it('answers an untracked path that no longer exists without inventing a diff', async () => {
    const gone = await diff({ path: 'never-written.txt' });
    expect(gone.untracked).toBe(true);
    expect(gone.diff).toBe('');
    expect(gone.stat.filesChanged).toBe(0);
  });

  /**
   * PATH CONTAINMENT. The pathspec guard rejects `..` and absolute paths, but
   * `--no-index` arguments are FILESYSTEM paths, so a symlink inside the
   * worktree pointing out of it passes every lexical check and still reads a
   * file the session was never given. It is refused by name.
   */
  /**
   * A STAGED DELETION IS NOT AN UNTRACKED PATH, and the index alone cannot
   * tell them apart. `git rm b.txt` REMOVES the index entry, so
   * `ls-files --error-unmatch` exits 1 exactly as it does for a brand-new
   * file — but HEAD still holds the blob, `git diff --cached` renders the
   * whole deletion, and a commit would write it. Classifying it untracked
   * sends it to `--no-index`, which finds nothing on disk and answers with an
   * EMPTY diff: the most consequential change in a review, reported as
   * nothing to see. HEAD is the second question that separates the two.
   */
  it('renders a staged deletion as a tracked diff rather than an empty untracked one', async () => {
    git(repo, 'rm', '-q', 'b.txt');
    // The premise: the index really has forgotten this path.
    expect(git(repo, 'status', '--porcelain')).toContain('D  b.txt');

    const staged = await diff({ path: 'b.txt', scope: 'staged' });

    expect(staged.untracked).toBe(false);
    expect(staged.available).toBe(true);
    expect(staged.diff).toContain('-bee');
    expect(staged.files.map((f) => f.path)).toEqual(['b.txt']);
    expect(staged.files[0]?.deletions).toBe(1);
    expect(staged.stat.deletions).toBe(1);

    // …and the same through the default comparison the surface opens with.
    const session = await diff({ path: 'b.txt' });
    expect(session.untracked).toBe(false);
    expect(session.diff).toContain('-bee');
  });

  /**
   * A FILENAME IS BYTES. `'   '` is a legal path on every platform tm8 runs
   * on, and the HEAD probe above must not `.trim()` git's answer about it —
   * doing so turns a found file into an empty string and puts a real staged
   * deletion back on the untracked branch this block exists to keep it off.
   * Hence `ls-tree -z` and a length check.
   */
  it('finds a staged deletion whose filename is nothing but spaces', async () => {
    const spaces = '   ';
    await writeFile(join(repo, spaces), 'spaced content\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'a file named with spaces');
    git(repo, '--literal-pathspecs', 'rm', '-q', spaces);

    const gone = await diff({ path: spaces, scope: 'staged' });

    expect(gone.untracked).toBe(false);
    expect(gone.diff).toContain('-spaced content');
  });

  it('an unstaged deletion keeps its index entry and diffs as tracked too', async () => {
    await rm(join(repo, 'b.txt'));
    // The premise, stated without leaning on porcelain's leading column (the
    // helper trims): the deletion is in the WORKTREE only. The index still
    // holds the entry, which is why this path never reaches the HEAD probe.
    expect(git(repo, 'diff', '--name-only')).toBe('b.txt');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');

    const gone = await diff({ path: 'b.txt', scope: 'unstaged' });

    expect(gone.untracked).toBe(false);
    expect(gone.diff).toContain('-bee');
    expect(gone.stat.deletions).toBe(1);
  });

  it('refuses an untracked path that escapes the worktree through a symlink', async () => {
    const outside = join(dirname(repo), `outside-${Date.now()}.txt`);
    await writeFile(outside, 'secret\n');
    try {
      await symlink(outside, join(repo, 'escape.txt'));
      await expect(diff({ path: 'escape.txt' })).rejects.toMatchObject({
        code: 'invalid_input',
        details: { reason: 'path_outside_worktree' },
      });
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('refuses a traversing or absolute pathspec before git ever sees it', async () => {
    await expect(diff({ path: '../etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(diff({ path: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(stage({ action: 'stage', paths: ['../outside'] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  /**
   * THE COMMIT GATE. `git commit` writes the INDEX, not the paths it was
   * handed, so a "Commit selected" that stages the selection and commits would
   * also sweep in anything already staged. The refusal names the offending
   * paths so the caller has somewhere to go.
   */
  it('refuses a selected commit while paths outside the selection are staged', async () => {
    await writeFile(join(repo, 'a.txt'), 'mine\n');
    await writeFile(join(repo, 'b.txt'), 'someone else\n');
    await stage({ action: 'stage', paths: ['b.txt'] });

    await expect(
      handlerFor(registry, 'execution.gitCommit')(ctxFor({}, { message: 'just a', paths: ['a.txt'] })),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'staged_outside_selection', outsidePaths: ['b.txt'], outsideCount: 1 },
    });

    // Nothing happened: the refusal is a refusal, not a partial commit.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(baseOid);

    // ESCAPE ONE — unstage the stranger, then the same commit succeeds and
    // contains only the selection.
    await stage({ action: 'unstage', paths: ['b.txt'] });
    const committed = (await handlerFor(registry, 'execution.gitCommit')(
      ctxFor({}, { message: 'just a', paths: ['a.txt'] }),
    )) as SessionGitCommitResult;
    expect(committed.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    // b.txt is still dirty on disk, exactly as the reviewer left it.
    expect((await status()).files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('allows a selected commit that includes the already-staged path (escape two)', async () => {
    await writeFile(join(repo, 'a.txt'), 'mine\n');
    await writeFile(join(repo, 'b.txt'), 'theirs\n');
    await stage({ action: 'stage', paths: ['b.txt'] });
    const committed = (await handlerFor(registry, 'execution.gitCommit')(
      ctxFor({}, { message: 'both', paths: ['a.txt', 'b.txt'] }),
    )) as SessionGitCommitResult;
    expect(committed.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  /**
   * THE ALIAS THAT IS VALID. A staged rename is ONE logical file over two index
   * entries, reported as one row whose `path` is the destination and whose
   * `origPath` is the source. Committing half of it is not a thing git can do,
   * so the destination row must not count as "outside" a selection that named
   * it — and the commit carries both halves.
   */
  it('commits a staged rename whole rather than calling its other half an intruder', async () => {
    git(repo, 'mv', 'a.txt', 'renamed.txt');
    // The premise, asserted rather than assumed: git scores this as ONE row.
    expect(git(repo, 'diff', '--cached', '--name-status')).toBe('R100\ta.txt\trenamed.txt');

    await handlerFor(registry, 'execution.gitCommit')(ctxFor({}, { message: 'move it', paths: ['renamed.txt'] }));

    // Both halves landed: the old name is gone from the tree, the new one is in.
    expect(git(repo, 'ls-tree', '--name-only', 'HEAD')).toBe('b.txt\nrenamed.txt');
    expect((await status()).files).toEqual([]);
  });

  /**
   * THE ALIAS THAT IS NOT — and the reason the gate asks for `R*` by name.
   *
   * `git diff --cached --name-status` folds a COPY into the same one-row shape
   * as a rename (`C100 src dst`), so `origPath` is set for both. But a copy's
   * source is UNTOUCHED by the copy: it is a second, independent file, and the
   * destination is new work the reviewer has not necessarily read. If the gate
   * treated `origPath` as an alias here, ticking `a.txt` and pressing Commit
   * selected would silently commit `dup.txt` too — the exact quiet widening
   * this gate exists to refuse, wearing a rename's clothes.
   *
   * Copy detection is off by default, so this sets `diff.renames = copies` on
   * the repo: the same config a user may perfectly well have, and the only way
   * a `C*` row reaches the server at all.
   */
  it('refuses a copy destination that rode in on its selected SOURCE', async () => {
    git(repo, 'config', 'diff.renames', 'copies');
    try {
      // `dup.txt` is byte-identical to `a.txt` AT HEAD, and `a.txt` itself is
      // modified — which is what makes git pair them as a copy rather than
      // reporting an unrelated addition.
      await writeFile(join(repo, 'a.txt'), 'one\nan edit of its own\n');
      await writeFile(join(repo, 'dup.txt'), 'one\n');
      await stage({ action: 'stage', paths: ['a.txt', 'dup.txt'] });
      // The premise: one row, `C`, with the source in the `origPath` slot.
      expect(git(repo, 'diff', '--cached', '--name-status')).toContain('C100\ta.txt\tdup.txt');

      await expect(
        handlerFor(registry, 'execution.gitCommit')(ctxFor({}, { message: 'just the source', paths: ['a.txt'] })),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'staged_outside_selection', outsidePaths: ['dup.txt'], outsideCount: 1 },
      });
      // Refused means refused: nothing was written.
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(baseOid);
    } finally {
      git(repo, 'config', '--unset', 'diff.renames');
    }
  });

  it('leaves commit --all alone: it is asking for the whole index on purpose', async () => {
    await writeFile(join(repo, 'a.txt'), 'mine\n');
    await writeFile(join(repo, 'b.txt'), 'theirs\n');
    await stage({ action: 'stage', paths: ['b.txt'] });
    const committed = (await handlerFor(registry, 'execution.gitCommit')(
      ctxFor({}, { message: 'everything', all: true }),
    )) as SessionGitCommitResult;
    expect(committed.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses stage on a worktree that is no longer active — never a silent success', async () => {
    const inactive = buildRegistry(() => [{ ...lane(), worktree_status: 'merged' }]);
    await expect(
      handlerFor(inactive, 'execution.gitStage')(ctxFor({}, { action: 'stage', paths: ['a.txt'] })),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'worktree_not_active' } });
  });

  it('answers stage with available:false semantics when the session has no worktree', async () => {
    const bare = buildRegistry(() => [
      { ...lane(), worktree_id: null, path: null, branch: null, worktree_status: null },
    ]);
    await expect(
      handlerFor(bare, 'execution.gitStage')(ctxFor({}, { action: 'stage', paths: ['a.txt'] })),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'no_worktree' } });
  });

  /*
   * PER-HUNK STAGING through the facade.
   *
   * The execution package proves the git mechanics; what is proved HERE is the
   * seam a client actually touches: that `gitDiff` hands out hunks with a
   * digest, that `gitStage` takes indices into exactly those hunks, and that
   * the two agree without a round trip in between. If they ever disagreed,
   * every selection would come back "stale" with no edit to explain it.
   */
  const HUNKY_BASE = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  /** First change INSERTS, so hunk 2's post-image start differs from its pre-image start. */
  const HUNKY_EDIT = HUNKY_BASE
    .replace('line 2\n', 'line 2\nINSERTED\n')
    .replace('line 20\n', 'CHANGED 20\n');

  async function twoHunkFile(): Promise<void> {
    await writeFile(join(repo, 'h.txt'), HUNKY_BASE);
    git(repo, 'add', 'h.txt');
    git(repo, 'commit', '-m', 'hunky base');
    await writeFile(join(repo, 'h.txt'), HUNKY_EDIT);
  }

  it('offers hunks with a digest on a path-scoped unstaged diff', async () => {
    await twoHunkFile();
    const d = await diff({ scope: 'unstaged', path: 'h.txt' });
    expect(d.hunks).not.toBeNull();
    expect(d.hunks).toHaveLength(2);
    expect(d.hunkDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.hunks![0]!.index).toBe(1);
    expect(d.hunks![1]!.text).toContain('CHANGED 20');
  });

  it('offers NO hunks for the session scope, whose pre-image is not the index', async () => {
    await twoHunkFile();
    const session = await diff({ scope: 'session', path: 'h.txt' });
    // The diff text is there; the selection is not, because `git apply
    // --cached` could not take it. Null, never an empty list.
    expect(session.diff).toContain('CHANGED 20');
    expect(session.hunks).toBeNull();
    expect(session.hunkDigest).toBeNull();
  });

  it('offers no hunks for a whole-tree diff, where an index has no file to point into', async () => {
    await twoHunkFile();
    expect((await diff({ scope: 'unstaged' })).hunks).toBeNull();
  });

  it('stages one hunk of a file and leaves the other pending', async () => {
    await twoHunkFile();
    const listed = await diff({ scope: 'unstaged', path: 'h.txt' });

    const res = await stage({
      action: 'stage',
      hunks: { path: 'h.txt', indices: [2], digest: listed.hunkDigest },
    });
    expect(res.hunkSelection).toEqual({ path: 'h.txt', applied: 1, total: 2 });
    expect(res.paths).toEqual(['h.txt']);
    expect(res.all).toBe(false);

    // The index holds hunk 2 only — read the staged BYTES, not the porcelain.
    const stagedText = git(repo, 'show', ':h.txt');
    expect(stagedText).toContain('CHANGED 20');
    expect(stagedText).not.toContain('INSERTED');
    // and the file is now both staged and unstaged, which is the whole point.
    expect(res.dirty.staged).toBe(1);
    expect(res.dirty.unstaged).toBe(1);
  });

  it('unstages one hunk back out, reading the staged side for its indices', async () => {
    await twoHunkFile();
    git(repo, 'add', 'h.txt');

    const stagedDiff = await diff({ scope: 'staged', path: 'h.txt' });
    expect(stagedDiff.hunks).toHaveLength(2);

    const res = await stage({
      action: 'unstage',
      hunks: { path: 'h.txt', indices: [1], digest: stagedDiff.hunkDigest },
    });
    expect(res.hunkSelection).toEqual({ path: 'h.txt', applied: 1, total: 2 });
    const stagedText = git(repo, 'show', ':h.txt');
    expect(stagedText).not.toContain('INSERTED');
    expect(stagedText).toContain('CHANGED 20');
    // An unstage never touches disk: the working tree still has both changes.
    expect(await readFileText(join(repo, 'h.txt'))).toBe(HUNKY_EDIT);
  });

  it('refuses a selection whose digest went stale under a concurrent write', async () => {
    await twoHunkFile();
    const listed = await diff({ scope: 'unstaged', path: 'h.txt' });
    // An agent turn writes the file between render and click.
    await writeFile(join(repo, 'h.txt'), HUNKY_EDIT.replace('CHANGED 20', 'CHANGED 20 AGAIN'));

    await expect(
      stage({ action: 'stage', hunks: { path: 'h.txt', indices: [2], digest: listed.hunkDigest } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Refusing means refusing: the index did not move on the way to the throw.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses hunks combined with paths or all, rather than ranking two scopes', async () => {
    await twoHunkFile();
    await expect(
      stage({ action: 'stage', paths: ['h.txt'], hunks: { path: 'h.txt', indices: [1] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      stage({ action: 'stage', all: true, hunks: { path: 'h.txt', indices: [1] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a non-integer or zero hunk index before git is reached', async () => {
    await twoHunkFile();
    for (const bad of [0, -1, 1.5, 'two' as unknown as number]) {
      await expect(
        stage({ action: 'stage', hunks: { path: 'h.txt', indices: [bad] } }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('refuses a hunk path that escapes the worktree', async () => {
    await twoHunkFile();
    await expect(
      stage({ action: 'stage', hunks: { path: '../outside.txt', indices: [1] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('offers no hunks for an untracked file, which has no diff to split', async () => {
    await writeFile(join(repo, 'brand-new.txt'), 'hello\n');
    const d = await diff({ scope: 'unstaged', path: 'brand-new.txt' });
    expect(d.untracked).toBe(true);
    expect(d.hunks).toBeNull();
  });

});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

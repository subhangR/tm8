/**
 * execution.git* — the session git rail behind the facade.
 *
 * Same posture as execution-journal.test.ts: the REGISTERED handlers are
 * driven as functions with a fake `Db` and a fake owner (no Postgres), while
 * the git behaviour runs against a REAL temp repository — because the thing
 * these operations exist to get right (dirty counts, ahead/behind, conflict
 * paths, rollback's untracked-file gate) is git behaviour, and a mocked git
 * would let every one of those claims pass while false.
 *
 * The lane row the fake Db returns is exactly what the production query
 * yields: the session joined to its newest `in_worktree` worktree row. Tests
 * vary that row (no worktree, inactive worktree) to prove the honesty
 * contract: reads answer `available:false` with a NAMED reason; commands
 * refuse with `conflict` and the reason in details — never a 500, never a
 * silent success.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  SessionGitCheckpointResult,
  SessionGitCommitResult,
  SessionGitDiff,
  SessionGitMergeResult,
  SessionGitRollbackResult,
  SessionGitStatus,
} from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionGitHandlers } from '../../src/facade/services/execution-git.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const WORKTREE_ID = '33333333-3333-4333-8333-333333333333';

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

describe('execution.git* handlers', () => {
  let repo: string;
  let baseOid: string;

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

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tm8-git-rail-'));
    git(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    baseOid = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'tm8/lane');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('answers not_found when the session row is absent (RLS gate)', async () => {
    const registry = buildRegistry(() => []);
    await expect(handlerFor(registry, 'execution.gitStatus')(ctxFor())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reads answer available:false with a NAMED reason when the session has no worktree', async () => {
    const registry = buildRegistry(() => [
      { ...lane(), worktree_id: null, path: null, branch: null, worktree_status: null },
    ]);
    const status = (await handlerFor(registry, 'execution.gitStatus')(ctxFor())) as SessionGitStatus;
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe('no_worktree');
    const diff = (await handlerFor(registry, 'execution.gitDiff')(ctxFor())) as SessionGitDiff;
    expect(diff.available).toBe(false);
    expect(diff.unavailableReason).toBe('no_worktree');
  });

  it('commands refuse by name when the worktree is not operable — never a silent success', async () => {
    const registry = buildRegistry(() => [{ ...lane(), worktree_status: 'merged' }]);
    await expect(
      handlerFor(registry, 'execution.gitCheckpoint')(ctxFor({}, {})),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'worktree_not_active' } });
  });

  it('status reports branch, dirty counts and ahead/behind the base ref, live', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n'); // unstaged modify
    await writeFile(join(repo, 'new.txt'), 'n\n'); // untracked
    const registry = buildRegistry(() => [lane()]);
    const status = (await handlerFor(registry, 'execution.gitStatus')(ctxFor())) as SessionGitStatus;
    expect(status.available).toBe(true);
    expect(status.branch).toBe('tm8/lane');
    expect(status.baseOid).toBe(baseOid);
    expect(status.dirty.untracked).toBe(1);
    expect(status.dirty.unstaged).toBe(1);
    expect(status.dirty.total).toBe(2);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('checkpoint commits the whole WIP; a clean tree is a success that creates nothing', async () => {
    const registry = buildRegistry(() => [lane()]);
    const first = (await handlerFor(registry, 'execution.gitCheckpoint')(
      ctxFor({}, { message: 'cp one' }),
    )) as SessionGitCheckpointResult;
    expect(first.created).toBe(true);
    expect(first.branch).toBe('tm8/lane');
    expect(first.files.length).toBe(2);
    const second = (await handlerFor(registry, 'execution.gitCheckpoint')(
      ctxFor({}, {}),
    )) as SessionGitCheckpointResult;
    expect(second.created).toBe(false);
    expect(second.oid).toBe(first.oid);

    // The status now reads ahead of base by exactly the checkpoint.
    const status = (await handlerFor(registry, 'execution.gitStatus')(ctxFor())) as SessionGitStatus;
    expect(status.ahead).toBe(1);
    expect(status.dirty.total).toBe(0);
  });

  it('diff measures from the merge-base: digest complete, text capped honestly', async () => {
    const registry = buildRegistry(() => [lane()]);
    const full = (await handlerFor(registry, 'execution.gitDiff')(ctxFor())) as SessionGitDiff;
    expect(full.available).toBe(true);
    expect(full.mergeBaseOid).toBe(baseOid);
    expect(full.stat.filesChanged).toBe(2);
    expect(full.diff).toContain('+two');
    expect(full.diffTruncated).toBe(false);

    const capped = (await handlerFor(registry, 'execution.gitDiff')(
      ctxFor({ maxBytes: '10' }),
    )) as SessionGitDiff;
    // The DIGEST survives the cap — that is the digest+partial contract.
    expect(capped.stat.filesChanged).toBe(2);
    expect(capped.diffTruncated).toBe(true);
    expect(Buffer.byteLength(capped.diff, 'utf8')).toBeLessThanOrEqual(10);

    await expect(handlerFor(registry, 'execution.gitDiff')(ctxFor({ maxBytes: '-1' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('rollback restores a checkpoint; untracked deletions gate on force', async () => {
    const registry = buildRegistry(() => [lane()]);
    const head = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'loose.txt'), 'untracked\n');
    await expect(
      handlerFor(registry, 'execution.gitRollback')(ctxFor({}, { to: baseOid })),
    ).rejects.toMatchObject({ code: 'conflict' });

    const rolled = (await handlerFor(registry, 'execution.gitRollback')(
      ctxFor({}, { to: baseOid, force: true }),
    )) as SessionGitRollbackResult;
    expect(rolled.oid).toBe(baseOid);
    expect(rolled.previousOid).toBe(head);
    expect(rolled.deletedUntracked).toContain('loose.txt');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('commit stages what it is told and refuses an empty index', async () => {
    const registry = buildRegistry(() => [lane()]);
    await expect(
      handlerFor(registry, 'execution.gitCommit')(ctxFor({}, { message: 'no' })),
    ).rejects.toMatchObject({ code: 'conflict' });

    await writeFile(join(repo, 'b.txt'), 'bee\n');
    const committed = (await handlerFor(registry, 'execution.gitCommit')(
      ctxFor({}, { message: 'add b', paths: ['b.txt'] }),
    )) as SessionGitCommitResult;
    expect(committed.branch).toBe('tm8/lane');
    expect(committed.files.map((f) => f.path)).toContain('b.txt');
  });

  it('merge brings base forward; a conflict is DATA with the worktree restored clean', async () => {
    // Advance base compatibly first: merge succeeds.
    git(repo, 'checkout', 'main');
    await writeFile(join(repo, 'c.txt'), 'sea\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base advance');
    git(repo, 'checkout', 'tm8/lane');

    const registry = buildRegistry(() => [lane()]);
    const merged = (await handlerFor(registry, 'execution.gitMerge')(ctxFor({}, {}))) as SessionGitMergeResult;
    expect(merged.status).toBe('merged');
    expect(merged.fromRef).toBe('main');

    // Now a conflicting base advance: conflict comes back as data.
    git(repo, 'checkout', 'main');
    await writeFile(join(repo, 'b.txt'), 'base version\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'conflicting b');
    git(repo, 'checkout', 'tm8/lane');

    const conflicted = (await handlerFor(registry, 'execution.gitMerge')(
      ctxFor({}, {}),
    )) as SessionGitMergeResult;
    expect(conflicted.status).toBe('conflict');
    if (conflicted.status === 'conflict') {
      expect(conflicted.conflictedPaths).toContain('b.txt');
    }
    // The abort contract held: no mid-merge state, no residue.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

/**
 * execution.gitCheckouts / execution.gitCheckoutDiff — the Changes rail for a
 * session WITHOUT a worktree.
 *
 * Same posture as execution-git.test.ts: registered handlers driven as
 * functions with a fake `Db`, git behaviour against REAL temp repositories
 * laid out the way prod agents lay them out — clones inside
 * `<dataDir>/scratch/<session>/`, with an `origin` whose default branch the
 * agent's branch has moved ahead of.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionCheckoutDiff, SessionCheckouts } from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { redactRemote, registerSessionCheckoutHandlers } from '../../src/facade/services/session-checkouts.js';
import type { Db } from '../../src/db/types.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';

interface Row {
  workdir_path: string | null;
  workdir_mode: string | null;
  has_worktree: boolean;
  credential_allowed: boolean;
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

function build(rows: () => Row[], dataDir: string | undefined): HandlerRegistry {
  const db: Db = { query: async () => rows() as never } as unknown as Db;
  const registry = new HandlerRegistry();
  registerSessionCheckoutHandlers(registry, {
    db,
    resolveOwner: async () => ({ identityId: 'ident', accountId: 'acct', isNodeAdmin: false }) as never,
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  return registry;
}

function handler(registry: HandlerRegistry, name: string): OperationHandler {
  const h = registry.get(name as never);
  if (!h) throw new Error(`${name} not registered`);
  return h;
}

function ctx(query: Record<string, string> = {}): RequestContext {
  return {
    params: { workSessionId: SESSION_ID },
    query: new URLSearchParams(query),
    requestId: 'req-1',
  } as unknown as RequestContext;
}

describe('execution.gitCheckouts', () => {
  let dataDir: string;
  let scratch: string;
  let outside: string;
  const scratchRow = (): Row => ({
    workdir_path: join(dataDir, 'scratch'),
    workdir_mode: 'scratch',
    has_worktree: false,
    credential_allowed: true,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-checkouts-'));
    scratch = join(dataDir, 'scratch', SESSION_ID);
    // The upstream the agent cloned.
    const upstream = join(dataDir, 'upstream');
    await mkdir(upstream, { recursive: true });
    git(upstream, 'init', '-b', 'main');
    await writeFile(join(upstream, 'keep.txt'), 'k\n');
    await writeFile(join(upstream, 'gone.txt'), 'g\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'base');
    // The agent's clone, two levels down like prod's `w266/`.
    await mkdir(scratch, { recursive: true });
    git(scratch, 'clone', '-q', `file://${upstream}`, 'w266');
    const clone = join(scratch, 'w266');
    git(clone, 'checkout', '-q', '-b', 'crawl/266');
    await writeFile(join(clone, 'keep.txt'), 'k\nk2\n');
    git(clone, 'rm', '-q', 'gone.txt');
    git(clone, 'commit', '-qam', 'committed work');
    await writeFile(join(clone, 'fresh.txt'), 'a\nb\nc\n'); // untracked
    // A dependency tree that must not be scanned for repos.
    await mkdir(join(scratch, 'node_modules', 'pkg'), { recursive: true });
    git(join(scratch, 'node_modules', 'pkg'), 'init', '-q');
    // A file outside every checkout, reachable through a symlink inside one.
    outside = join(dataDir, 'secret.txt');
    await writeFile(outside, 'TOKEN\n');
    await symlink(outside, join(clone, 'link.txt'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('finds the clone in the scratch dir and reports committed AND uncommitted work vs origin', async () => {
    const res = (await handler(build(() => [scratchRow()], dataDir), 'execution.gitCheckouts')(ctx())) as SessionCheckouts;
    expect(res.available).toBe(true);
    expect(res.checkouts.map((c) => c.name)).toEqual(['w266']); // node_modules skipped
    const c = res.checkouts[0]!;
    expect(c.branch).toBe('crawl/266');
    expect(c.baseRef).toBe('origin/main');
    expect(c.ahead).toBe(1);
    const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(byPath['keep.txt']).toMatchObject({ change: 'M', additions: 1, deletions: 0, uncommitted: false });
    expect(byPath['gone.txt']).toMatchObject({ change: 'D', deletions: 1, uncommitted: false });
    expect(byPath['fresh.txt']).toMatchObject({ change: '?', additions: 3, uncommitted: true });
    expect(c.stat.filesChanged).toBe(c.files.length);
  });

  it('answers has_worktree instead of a second reading of a lane', async () => {
    const res = (await handler(build(() => [{ ...scratchRow(), has_worktree: true }], dataDir), 'execution.gitCheckouts')(
      ctx(),
    )) as SessionCheckouts;
    expect(res).toMatchObject({ available: false, unavailableReason: 'has_worktree', checkouts: [] });
  });

  it('refuses a private-credential session and a missing row', async () => {
    await expect(
      handler(build(() => [{ ...scratchRow(), credential_allowed: false }], dataDir), 'execution.gitCheckouts')(ctx()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(handler(build(() => [], dataDir), 'execution.gitCheckouts')(ctx())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('diffs a committed change against the merge-base, and an untracked file as all-added', async () => {
    const reg = build(() => [scratchRow()], dataDir);
    const d = (await handler(reg, 'execution.gitCheckoutDiff')(ctx({ checkout: 'w266', path: 'keep.txt' }))) as SessionCheckoutDiff;
    expect(d.diff).toContain('+k2');
    const u = (await handler(reg, 'execution.gitCheckoutDiff')(ctx({ checkout: 'w266', path: 'fresh.txt' }))) as SessionCheckoutDiff;
    expect(u.diff).toContain('+c');
  });

  it('refuses names the listing never offered — another dir, an unchanged file, a symlink out', async () => {
    const reg = build(() => [scratchRow()], dataDir);
    const diff = handler(reg, 'execution.gitCheckoutDiff');
    await expect(diff(ctx({ checkout: '..', path: 'secret.txt' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(diff(ctx({ checkout: 'node_modules/pkg', path: 'x' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(diff(ctx({ checkout: 'w266', path: 'README.md' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(diff(ctx({ checkout: 'w266', path: 'link.txt' }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('takes credentials out of a remote URL', () => {
    expect(redactRemote('https://user:ghp_x@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(redactRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });
});

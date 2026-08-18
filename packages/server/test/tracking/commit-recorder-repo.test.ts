/**
 * D2/2d — the commit recorder never writes a `repo` that cannot join.
 *
 * `public.commits.repo` exists to be JOINED. `internal.pr_owning_session` tier
 * 2 (103:359) is `c.repo = pr.repo and c.sha = lower(pr.head_sha)`, and
 * `pr.repo` is always a forge `owner/name`. The recorder used to fall back to
 * the bare PROJECT NAME when a project had no remote url — a value that is
 * wrong in both directions at once:
 *
 *   - it can never match, so tier 2 was silently dead for local-only projects;
 *   - it CAN match the wrong thing, because nothing stops a project being
 *     named `acme/forge`, at which point purely local commits join an
 *     unrelated PR mirror and hand it an addressee it never produced.
 *
 * The second bullet is the one this file cares about most: it is the same
 * failure class as the 148 branch-name leak, arriving by a different door.
 *
 * The tick test drives the REAL code path — a real git repository on disk, a
 * real `git log`, the real `commitsAhead` — and asserts on the argument vector
 * that actually reaches `record_session_commit`. A unit test of `laneRepo`
 * alone would not have caught a caller that stopped using it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import { laneRepo, runCommitRecorderTick } from '../../src/tracking/commit-recorder.js';

describe('laneRepo — the value written into commits.repo', () => {
  it('is the forge slug when the project has a remote', () => {
    expect(laneRepo('https://github.com/acme/forge.git', 'forge')).toBe('acme/forge');
    expect(laneRepo('git@github.com:acme/forge.git', 'forge')).toBe('acme/forge');
  });

  it('is explicitly non-forge when it does not — never a bare project name', () => {
    expect(laneRepo(null, 'tm8')).toBe('local:tm8');
    expect(laneRepo('', 'tm8')).toBe('local:tm8');
  });

  it('cannot be mistaken for a forge slug even when the project is NAMED like one', () => {
    // The whole point. `acme/forge` as a project name used to be written
    // verbatim and would then join a real `acme/forge` pull request mirror.
    const written = laneRepo(null, 'acme/forge');
    expect(written).not.toBe('acme/forge');
    expect(written.startsWith('local:')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The tick, against a real repository.
// -----------------------------------------------------------------------------

interface RecordedCall {
  fn: string;
  args: readonly unknown[];
}

let root: string;
let baseOid: string;
let headSha: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'D2 lane', GIT_AUTHOR_EMAIL: 'd2@example.invalid',
      GIT_COMMITTER_NAME: 'D2 lane', GIT_COMMITTER_EMAIL: 'd2@example.invalid',
    },
  }).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tm8-d2-recorder-'));
  git(root, ['init', '--quiet', '--initial-branch=main', '.']);
  git(root, ['commit', '--allow-empty', '-q', '-m', 'base']);
  baseOid = git(root, ['rev-parse', 'HEAD']);
  git(root, ['commit', '--allow-empty', '-q', '-m', 'lane work']);
  headSha = git(root, ['rev-parse', 'HEAD']);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/**
 * A Db that hands back one lane row and records every rpc it is asked to make.
 *
 * `worktreeId` is a REQUIRED per-case argument, not a constant: the recorder's
 * `seen` memo is module-level and process-wide (by design — it is what keeps a
 * steady state from re-calling the door every tick), so two cases sharing a
 * worktree id would find the second one deduped to zero calls.
 */
function stubDb(
  worktreeId: string,
  lane: { repo_url: string | null; project_name: string },
): { db: Db; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: Db = {
    async tx() { throw new Error('not used'); },
    async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
      calls.push({ fn, args });
      return {} as T;
    },
    async query<R>(): Promise<R[]> {
      return [{
        worktree_id: worktreeId,
        path: root,
        base_commit_oid: baseOid,
        session_id: '22222222-2222-7222-8222-222222222222',
        repo_url: lane.repo_url,
        project_name: lane.project_name,
      }] as unknown as R[];
    },
    async end() { /* no pool */ },
  };
  return { db, calls };
}

describe('runCommitRecorderTick — what actually reaches record_session_commit', () => {
  it('records the forge slug for a project with a remote', async () => {
    const { db, calls } = stubDb('11111111-1111-7111-8111-111111111111', {
      repo_url: 'https://github.com/acme/forge.git', project_name: 'forge',
    });
    const outcome = await runCommitRecorderTick({ db, claims: async () => ({}) });

    expect(outcome.affected).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('public.record_session_commit');
    // [sessionId, repo, sha, subject, author, committedAt]
    expect(calls[0]?.args[1]).toBe('acme/forge');
    expect(calls[0]?.args[2]).toBe(headSha);
  });

  it('records a NON-JOINABLE marker, not the project name, when there is no remote', async () => {
    // Note the project name: before this fix, `acme/forge` went in verbatim and
    // the commit joined an unrelated pull request mirror in the same Space.
    const { db, calls } = stubDb('33333333-3333-7333-8333-333333333333', {
      repo_url: null, project_name: 'acme/forge',
    });
    const outcome = await runCommitRecorderTick({ db, claims: async () => ({}) });

    expect(outcome.affected).toBe(1);
    expect(calls[0]?.args[1]).not.toBe('acme/forge');
    expect(calls[0]?.args[1]).toBe('local:acme/forge');
  });
});

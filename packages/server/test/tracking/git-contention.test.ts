/**
 * The contention map against TWO REAL WORKTREES — no mocks around git.
 *
 * A scratch repo with a base commit, two `git worktree add` lanes off the same
 * base: lane A edits shared.ts (committed) + a.ts (uncommitted); lane B edits
 * shared.ts + b.ts (both uncommitted). The reads under test must report each
 * lane's touched set exactly, and the service must name shared.ts — the
 * "merges cleanly, silently reverts" file — as the ONE overlapping path.
 *
 * The database is stubbed (two lane rows pointing at the real paths); git is
 * not, because the git observation IS the feature.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getOperation } from '@tm8/contract';

import { ContentionService } from '../../src/facade/services/contention.js';
import { commitsAhead, repoFromUrl, touchedPaths } from '../../src/tracking/git-local.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';

const PROJECT_ID = '00000000-0000-7000-8000-000000000901';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let root: string;
let repo: string;
let laneA: string;
let laneB: string;
let baseOid: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tm8-t4-contention-'));
  repo = join(root, 'repo');
  laneA = join(root, 'wt-a');
  laneB = join(root, 'wt-b');

  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't4@test');
  git(repo, 'config', 'user.name', 'T4');
  writeFileSync(join(repo, 'shared.ts'), 'export const shared = 1;\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  baseOid = git(repo, 'rev-parse', 'HEAD').trim();

  git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', laneA, 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-b', laneB, 'main');

  // Lane A: one COMMITTED touch of shared.ts, one uncommitted touch of a.ts.
  writeFileSync(join(laneA, 'shared.ts'), 'export const shared = 2; // lane a\n');
  git(laneA, 'add', 'shared.ts');
  git(laneA, 'commit', '-q', '-m', 'feat: lane a shared fix');
  writeFileSync(join(laneA, 'a.ts'), 'export const a = 2;\n');

  // Lane B: uncommitted touches of shared.ts and b.ts.
  writeFileSync(join(laneB, 'shared.ts'), 'export const shared = 3; // lane b\n');
  writeFileSync(join(laneB, 'b.ts'), 'export const b = 2;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git-local reads against real worktrees', () => {
  it('touchedPaths unions the committed delta and the working tree, per lane', async () => {
    expect([...(await touchedPaths(laneA, baseOid))!].sort()).toEqual(['a.ts', 'shared.ts']);
    expect([...(await touchedPaths(laneB, baseOid))!].sort()).toEqual(['b.ts', 'shared.ts']);
  });

  it('commitsAhead lists lane A\'s one commit and lane B\'s none', async () => {
    const ahead = await commitsAhead(laneA, baseOid);
    expect(ahead).toHaveLength(1);
    expect(ahead![0]).toMatchObject({ subject: 'feat: lane a shared fix', author: 'T4' });
    expect(ahead![0]!.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await commitsAhead(laneB, baseOid)).toEqual([]);
  });

  it('an unreadable path yields null, never an empty set', async () => {
    expect(await touchedPaths(join(root, 'gone'), baseOid)).toBeNull();
    expect(await commitsAhead(join(root, 'gone'), baseOid)).toBeNull();
  });

  it('repoFromUrl derives owner/name across url shapes', () => {
    expect(repoFromUrl('https://github.com/acme/repo.git')).toBe('acme/repo');
    expect(repoFromUrl('git@github.com:acme/repo.git')).toBe('acme/repo');
    expect(repoFromUrl('https://github.com/acme/repo')).toBe('acme/repo');
    expect(repoFromUrl(null)).toBeNull();
  });
});

describe('ContentionService over the two real lanes', () => {
  const WT_A = '00000000-0000-7000-8000-000000000a01';
  const WT_B = '00000000-0000-7000-8000-000000000b01';

  function deps(): FacadeDeps {
    return {
      config: {} as FacadeDeps['config'],
      owner: async () => ({
        identityId: 't4-owner',
        accountId: '00000000-0000-7000-8000-000000000801',
        username: 't4-owner',
        isNodeAdmin: false,
      } as Awaited<ReturnType<FacadeDeps['owner']>>),
      db: {
        query: async <R>(_claims: unknown, sql: string): Promise<R[]> => {
          if (sql.includes('from public.projects')) return [{ id: PROJECT_ID }] as R[];
          return [
            { entity_id: WT_A, path: laneA, branch: 'lane-a', base_commit_oid: baseOid, session_id: null },
            { entity_id: WT_B, path: laneB, branch: 'lane-b', base_commit_oid: baseOid, session_id: null },
          ] as R[];
        },
      } as unknown as FacadeDeps['db'],
    };
  }

  function ctx(): RequestContext {
    return {
      op: getOperation('projects.contention'),
      opName: 'projects.contention',
      params: { projectId: PROJECT_ID },
      query: new URLSearchParams(),
      body: undefined,
      requestId: 'req-t4-contention',
      identity: { kind: 'auto-owner', identityId: 't4-owner' },
      headers: {},
    } as unknown as RequestContext;
  }

  it('names shared.ts as the one contended path between the two lanes', async () => {
    const report = await new ContentionService(deps()).report(ctx());
    expect(report.projectId).toBe(PROJECT_ID);
    expect(report.lanes).toHaveLength(2);
    expect(report.lanes.map((l) => l.skipped)).toEqual([null, null]);
    expect(report.pairs).toEqual([{
      aWorktreeId: WT_A,
      bWorktreeId: WT_B,
      aBranch: 'lane-a',
      bBranch: 'lane-b',
      overlappingPaths: ['shared.ts'],
    }]);
  });

  it('reports an unreadable lane as skipped and keeps the readable one honest', async () => {
    const d = deps();
    const db = d.db as unknown as { query: (c: unknown, sql: string) => Promise<unknown[]> };
    const original = db.query.bind(db);
    db.query = async (c: unknown, sql: string) => {
      const rows = await original(c, sql);
      if (sql.includes('from public.projects')) return rows;
      return (rows as Array<Record<string, unknown>>).map((row) =>
        row.entity_id === WT_B ? { ...row, path: join(root, 'vanished') } : row);
    };
    const report = await new ContentionService(d).report(ctx());
    expect(report.lanes.find((l) => l.worktreeId === WT_B)?.skipped).toMatch(/not readable/);
    expect(report.pairs).toEqual([]);
    expect(report.lanes.find((l) => l.worktreeId === WT_A)?.touchedPaths).toEqual(['a.ts', 'shared.ts']);
  });
});

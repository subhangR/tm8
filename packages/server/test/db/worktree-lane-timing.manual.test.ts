/**
 * MANUAL — how long a worktree launch's lane takes: today's `git worktree add`,
 * the pool off (TM8_WORKTREE_POOL=0), and the pool on. NOT part of the
 * standard suite: it checks out a real repository dozens of times (the tm8
 * repository, 5,572 files, is the intended subject), and skips unless pointed
 * at one:
 *
 *   TM8_WORKTREE_BENCH_REPO=<repository> TM8_WORKTREE_BENCH_AREA=<dir on the lane disk> \
 *   TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres \
 *     npx vitest run test/db/worktree-lane-timing.manual.test.ts
 *
 * One run is one launch's lane: `reserveWorktree` then `materializeWorktree` —
 * the phases lane C's spawn timings report under those names — through the
 * REAL DbGraphPort on a scratch database, one launch at a time. With the pool
 * on, each launch first waits until the pool is full again, so every launch
 * has a warm lane; the refill a claim starts runs alongside the rest of that
 * launch, as it would in production. Prints p50 / p90 / max per step with the
 * node's load average beside every table, because on a shared node the
 * absolute numbers mean little without it — and appends each table to
 * `<TM8_WORKTREE_BENCH_AREA>/lane-timing.txt`, since vitest does not always
 * show a passing test's output.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, it, vi } from 'vitest';

import {
  WorktreeManager,
  materializeWorktree,
  reserveWorktree,
  runGit,
  type ProvisionWorktreeParams,
  type WarmLanePool,
} from '@tm8/execution';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const REPO = process.env['TM8_WORKTREE_BENCH_REPO'];
const AREA = process.env['TM8_WORKTREE_BENCH_AREA'];
const RUNS = Number(process.env['TM8_WORKTREE_BENCH_RUNS'] ?? 12);
const IDENTITY = 'worktree-bench-owner';

vi.setConfig({ testTimeout: 60 * 60_000, hookTimeout: 30 * 60_000 });

type Run = Record<string, number>;

/** Wrap `obj[key]` so each call adds its duration to the run being measured. */
function timed(obj: object, key: string, label: string, into: () => Run): void {
  const target = obj as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target[key]!.bind(obj);
  target[key] = async (...args: unknown[]) => {
    const started = performance.now();
    try {
      return await original(...args);
    } finally {
      const run = into();
      run[label] = (run[label] ?? 0) + (performance.now() - started);
    }
  };
}

function table(title: string, runs: Run[]): string {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))];
  const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  const load = loadavg().map((l) => l.toFixed(1)).join(' ');
  const lines = [`${title} — n=${runs.length}, load ${load} (8 cores)`, `${'step'.padEnd(26)}${'p50'.padStart(9)}${'p90'.padStart(9)}${'max'.padStart(9)}  ms`];
  for (const key of keys) {
    const values = runs.map((r) => r[key] ?? 0).sort((a, b) => a - b);
    lines.push(`${key.padEnd(26)}${q(values, 0.5).toFixed(0).padStart(9)}${q(values, 0.9).toFixed(0).padStart(9)}${values.at(-1)!.toFixed(0).padStart(9)}`);
  }
  return lines.join('\n');
}

describe.skipIf(!REPO || !AREA)('worktree lane timing (manual)', () => {
  let database: W1ScratchDatabase;
  let db: Db;
  let spaceId: string;
  let projectId: string;
  let repoRoot: string;
  const claims = (): DbClaims => ({ identityId: IDENTITY, nodeAdmin: false, requestId: randomUUID() });
  const tables: string[] = [];

  beforeAll(async () => {
    database = await createW1ScratchDatabase('worktree_bench');
    database.apply(migrationFiles());
    db = createDb(database.url, { max: 4 });
    repoRoot = (await new WorktreeManager({ worktreeRoot: join(AREA!, 'probe') }).validateRepository(REPO!)).repoRoot;
    // A launch project has its gitignored code graph; lanes link it.
    await mkdir(join(repoRoot, 'graphify-out'), { recursive: true });
    spaceId = randomUUID();
    projectId = randomUUID();
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Bench')`, [IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Bench', $2)`, [spaceId, IDENTITY]);
      const member = randomUUID();
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'Bench')`, [member, spaceId, IDENTITY]);
      await c.query(`insert into public.projects(id, name, working_dir, trust) values ($1, 'Bench', $2, 'trusted')`, [projectId, repoRoot]);
      await c.query(`insert into public.space_projects(space_id, project_id) values ($1, $2)`, [spaceId, projectId]);
    });
  });

  afterAll(async () => {
    console.log(`\n${tables.join('\n\n')}\n`);
    await db?.end?.();
    await database?.destroy();
  });

  async function measure(
    title: string,
    manager: WorktreeManager,
    beforeEach: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    const graph = new DbGraphPort(db);
    let current: Run = {};
    const into = () => current;
    timed(graph, 'reserveWorktreeAllocation', 'reserve.door', into);
    timed(graph, 'createWorktreeEntity', 'materialize.entityDoor', into);
    timed(manager, 'add', 'materialize.coldCheckout', into);
    if (manager.pool) timed(manager.pool, 'claim', 'materialize.warmClaim', into);
    const params: ProvisionWorktreeParams = {
      auth: claims(), graph, manager, spaceId, projectId, projectWorkingDir: repoRoot,
      requestedBaseRef: null, nodeId: 'bench-node:1', cap: 0, clientMutationId: null,
    };
    const runs: Run[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      await beforeEach();
      current = {};
      const started = performance.now();
      const reserved = await reserveWorktree({ ...params, auth: claims() });
      const reservedAt = performance.now();
      const provisioned = await materializeWorktree({ ...params, auth: claims() }, reserved);
      const done = performance.now();
      current['reserveWorktree'] = reservedAt - started;
      current['materializeWorktree'] = done - reservedAt;
      current['lane total'] = done - started;
      runs.push(current);
      await stat(provisioned.path);
      await manager.remove({ projectId, repoRoot, path: provisioned.path, force: true });
      await runGit(['-C', repoRoot, 'branch', '-q', '-D', provisioned.branch]);
    }
    tables.push(table(title, runs));
    console.log(tables.at(-1));
    await appendFile(join(AREA!, 'lane-timing.txt'), `${tables.at(-1)}\n\n`);
  }

  it('today: one `git worktree add` with its checkout under the lock', async () => {
    const manager = new WorktreeManager({ worktreeRoot: join(AREA!, 'legacy') });
    // main's add(): registration and checkout in one command.
    (manager as unknown as { add: WorktreeManager['add'] }).add = async (p) => {
      const path = await manager.computeWorktreePath(p.projectId, p.worktreeId);
      await mkdir(join(path, '..'), { recursive: true });
      await manager.withProjectLock(p.projectId, async () => {
        const res = await runGit(['-C', p.repoRoot, 'worktree', 'add', '-b', p.branch, path, p.baseCommitOid], { timeoutMs: 600_000 });
        if (res.code !== 0) throw new Error(res.stderr);
      });
      return { path };
    };
    await measure('BEFORE — git worktree add (main today)', manager);
  });

  it('pool off: --no-checkout under the lock, parallel checkout outside it', async () => {
    await measure('AFTER — TM8_WORKTREE_POOL=0 (cold checkout)', new WorktreeManager({ worktreeRoot: join(AREA!, 'cold') }));
  });

  it('pool on: every launch claims a warm lane', async () => {
    const manager = new WorktreeManager({
      worktreeRoot: join(AREA!, 'warm'),
      pool: { root: join(AREA!, 'warm-pool'), size: 2 },
    });
    const pool: WarmLanePool = manager.pool!;
    pool.replenish(projectId, repoRoot);
    const full = async () => {
      while (pool.snapshot(projectId).filter((l) => l.state === 'warm').length < pool.size) {
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    try {
      await measure('AFTER — TM8_WORKTREE_POOL=2 (warm lane available)', manager, full);
    } finally {
      await pool.drain();
    }
  });
});

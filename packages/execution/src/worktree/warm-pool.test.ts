// The warm lane pool (warm-pool.ts) and WorktreeManager's adoption of a warm
// lane, against REAL git repositories in throwaway temp directories: every
// claim under test is about what is on disk and what git believes.
//
//   P1  fills to size in the background, outside the lane area: detached at
//       the default base, clean, shared paths linked, index past the racy window
//   P2  a claim moves a lane to the reserved path on the launch's branch, and
//       that lane is the checkout a cold `add` makes — the two are diffed
//   P3  a claim at a base the lane is not at checks out exactly that commit
//   P4  an empty pool answers null; a claim waits for a lane still filling
//   P5  claims are refilled; upkeep moves warm lanes to a moved default base
//   P6  the startup sweep removes every leftover and prunes it, before any fill
//   P7  containment: an area resolving elsewhere closes the pool; a lane path
//       swapped between validation and the move is removed and refused
//   P8  drain removes unclaimed lanes, spares claimed ones, closes the pool
//   P9  failures are logged with their path and back off — no retry loop

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../pty/types.js';
import { runGit } from './git-invoker.js';
import { WorktreeManager, isContainedIn } from './WorktreeManager.js';
import type { WarmLanePool } from './warm-pool.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';

let base: string;
let repoRoot: string;
let firstOid: string;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function waitFor(what: string, done: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function logger(): Logger & { warns: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    warns,
    error: () => undefined,
    warn: (message, meta) => {
      warns.push({ message, ...(meta ? { meta } : {}) });
    },
    info: () => undefined,
    debug: () => undefined,
  };
}

interface Areas {
  data: string;
  worktreeRoot: string;
  poolRoot: string;
}

let areaSeq = 0;
async function areas(): Promise<Areas> {
  areaSeq += 1;
  const data = join(base, `data-${areaSeq}`);
  await mkdir(data, { recursive: true });
  return { data, worktreeRoot: join(data, 'worktrees'), poolRoot: join(data, 'worktrees-pool') };
}

function pooled(a: Areas, size = 2, log: Logger = logger()): { manager: WorktreeManager; pool: WarmLanePool } {
  const manager = new WorktreeManager({ worktreeRoot: a.worktreeRoot, pool: { root: a.poolRoot, size, logger: log } });
  return { manager, pool: manager.pool! };
}

async function warmLanes(pool: WarmLanePool, n: number): Promise<void> {
  await waitFor(`${n} warm lane(s)`, () => pool.snapshot(PROJECT_ID).filter((l) => l.state === 'warm').length >= n);
}

/** Every file under `dir` except the `.git` pointer: content digests, symlink targets. */
async function treeDigest(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const rel = relative(dir, path);
      if (rel === '.git') continue;
      if (entry.isSymbolicLink()) out[rel] = `link:${await readlink(path)}`;
      else if (entry.isDirectory()) await walk(path);
      else out[rel] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(dir);
  return out;
}

/** What an agent sees of a lane through git, with the lane's own branch name taken out. */
async function gitView(lane: string, branch: string): Promise<Record<string, string>> {
  const status = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored'], lane);
  return {
    head: await git(['rev-parse', 'HEAD'], lane),
    branch: (await git(['symbolic-ref', '--short', 'HEAD'], lane)).replace(branch, '<branch>'),
    status: status.replace(branch, '<branch>'),
    index: await git(['ls-files', '-s'], lane),
    upstream: String((await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: lane })).code),
    stash: await git(['stash', 'list'], lane),
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-warm-pool-'));
  repoRoot = join(base, 'repo');
  await mkdir(join(repoRoot, 'dir'), { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await git(['config', 'user.email', 't@t'], repoRoot);
  await git(['config', 'user.name', 't'], repoRoot);
  await writeFile(join(repoRoot, '.gitignore'), '/graphify-out\n');
  await writeFile(join(repoRoot, 'a.txt'), 'one\n');
  await writeFile(join(repoRoot, 'b.txt'), 'bee\n');
  await writeFile(join(repoRoot, 'dir', 'c.txt'), 'sea\n');
  await git(['add', '.'], repoRoot);
  await git(['commit', '-m', 'first'], repoRoot);
  firstOid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
  // The launch project's gitignored code graph, which every lane borrows.
  await mkdir(join(repoRoot, 'graphify-out'));
  await writeFile(join(repoRoot, 'graphify-out', 'merged-graph.json'), '{}');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('P1 — filling', () => {
  it('fills to size in the background, outside the lane area, ready to claim', async () => {
    const a = await areas();
    const { manager, pool } = pooled(a);
    pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(pool, 2);

    const lanes = pool.snapshot(PROJECT_ID);
    expect(lanes).toHaveLength(2);
    const poolRoot = await manager.poolRoot();
    const laneArea = await manager.worktreeRoot();
    for (const lane of lanes) {
      expect(isContainedIn(lane.path, poolRoot)).toBe(true);
      expect(isContainedIn(lane.path, laneArea)).toBe(false);
      expect(lane.headOid).toBe(firstOid);
      expect(await git(['rev-parse', 'HEAD'], lane.path)).toBe(firstOid);
      // Detached: the branch is the launch's to name.
      expect((await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: lane.path })).code).not.toBe(0);
      expect(await git(['status', '--porcelain'], lane.path)).toBe('');
      expect(await readlink(join(lane.path, 'graphify-out'))).toBe(join(repoRoot, 'graphify-out'));
      // Past git's racy window: every file is older than the index, so the
      // first `git status` in the launched lane re-hashes nothing.
      const index = await stat(await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], lane.path));
      for (const file of ['a.txt', 'b.txt', join('dir', 'c.txt')]) {
        expect(Math.floor((await stat(join(lane.path, file))).mtimeMs / 1000))
          .toBeLessThan(Math.floor(index.mtimeMs / 1000));
      }
    }
    // Git knows them; the lane area holds nothing.
    const listed = (await manager.list(repoRoot)).map((e) => e.path);
    for (const lane of lanes) expect(listed).toContain(lane.path);
    expect(await readdir(laneArea)).toEqual([]);
    await pool.drain();
  });
});

describe('P2/P3 — claiming', () => {
  it('a claimed lane is the checkout a cold add makes: same commit, files, index, links, status', async () => {
    const a = await areas();
    const { manager, pool } = pooled(a);
    pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(pool, 2);

    const warmId = uuidN(1);
    const coldId = uuidN(2);
    const claimed = await pool.claim({
      projectId: PROJECT_ID, repoRoot, worktreeId: warmId, branch: `tm8/${warmId}`, baseCommitOid: firstOid,
    });
    expect(claimed).toEqual({ path: await manager.computeWorktreePath(PROJECT_ID, warmId) });
    const cold = await manager.add({
      repoRoot, projectId: PROJECT_ID, worktreeId: coldId, branch: `tm8/${coldId}`, baseCommitOid: firstOid,
    });
    // materializeWorktree links shared paths after either checkout.
    await manager.linkSharedPaths(repoRoot, claimed!.path);
    await manager.linkSharedPaths(repoRoot, cold.path);

    expect(await treeDigest(claimed!.path)).toEqual(await treeDigest(cold.path));
    expect(await gitView(claimed!.path, `tm8/${warmId}`)).toEqual(await gitView(cold.path, `tm8/${coldId}`));
    expect(await git(['symbolic-ref', '--short', 'HEAD'], claimed!.path)).toBe(`tm8/${warmId}`);
    expect(await git(['rev-parse', `tm8/${warmId}`], repoRoot)).toBe(firstOid);
    // Git agrees where it now lives, and the pool no longer has it.
    expect((await manager.list(repoRoot)).map((e) => e.path)).toContain(claimed!.path);
    expect(pool.snapshot(PROJECT_ID).some((l) => l.path === claimed!.path)).toBe(false);
    await pool.drain();
  });

  it('a claim at a commit the lane is not at checks out exactly that commit', async () => {
    const a = await areas();
    const { manager, pool } = pooled(a, 1);
    pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(pool, 1);

    // The base moves after the lane was made: a.txt changes, b.txt goes, d.txt arrives.
    const clone = join(base, `moved-${areaSeq}`);
    await git(['clone', '-q', repoRoot, clone], base);
    await writeFile(join(clone, 'a.txt'), 'two\n');
    await rm(join(clone, 'b.txt'));
    await writeFile(join(clone, 'd.txt'), 'dee\n');
    await git(['add', '-A'], clone);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'second'], clone);
    const secondOid = await git(['rev-parse', 'HEAD'], clone);
    await git(['fetch', '-q', clone, `${secondOid}:refs/tm8-test/second`], repoRoot);

    const id = uuidN(3);
    const claimed = await pool.claim({
      projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: secondOid,
    });
    expect(claimed).not.toBeNull();
    expect(await git(['rev-parse', 'HEAD'], claimed!.path)).toBe(secondOid);
    expect(await readFile(join(claimed!.path, 'a.txt'), 'utf8')).toBe('two\n');
    expect(await exists(join(claimed!.path, 'b.txt'))).toBe(false);
    expect(await readFile(join(claimed!.path, 'd.txt'), 'utf8')).toBe('dee\n');
    expect(await git(['status', '--porcelain'], claimed!.path)).toBe('');
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: claimed!.path, force: true });
    await pool.drain();
  });
});

describe('P4 — an empty pool, and a lane still filling', () => {
  it('answers null when it has nothing, so the caller checks out cold', async () => {
    const a = await areas();
    const { pool } = pooled(a);
    const id = uuidN(4);
    expect(await pool.claim({ projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid }))
      .toBeNull();
  });

  it('a claim takes a lane still filling and waits for it rather than checking out cold', async () => {
    const a = await areas();
    const { manager, pool } = pooled(a, 1);
    pool.replenish(PROJECT_ID, repoRoot);
    await waitFor('a filling lane', () => pool.snapshot(PROJECT_ID).some((l) => l.state === 'filling'));

    const id = uuidN(5);
    const claimed = await pool.claim({
      projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid,
    });
    expect(claimed).toEqual({ path: await manager.computeWorktreePath(PROJECT_ID, id) });
    expect(await git(['symbolic-ref', '--short', 'HEAD'], claimed!.path)).toBe(`tm8/${id}`);
    expect(await git(['status', '--porcelain'], claimed!.path)).toBe('');
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: claimed!.path, force: true });
    await pool.drain();
  });
});

describe('P5 — upkeep', () => {
  it('refills after claims, and moves warm lanes to a moved default base', async () => {
    const work = join(base, 'upkeep-repo');
    await git(['clone', '-q', repoRoot, work], base);
    await git(['checkout', '-q', '-B', 'main', 'origin/main'], work);
    const a = await areas();
    const { manager, pool } = pooled(a);
    pool.replenish(PROJECT_ID, work);
    await warmLanes(pool, 2);

    for (const n of [6, 7]) {
      const id = uuidN(n);
      const claimed = await pool.claim({ projectId: PROJECT_ID, repoRoot: work, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid });
      expect(claimed).not.toBeNull();
    }
    await warmLanes(pool, 2);

    // origin/main is the default base; it moves when anyone fetches.
    await writeFile(join(repoRoot, 'e.txt'), 'eee\n');
    await git(['add', 'e.txt'], repoRoot);
    await git(['commit', '-q', '-m', 'third'], repoRoot);
    const third = await git(['rev-parse', 'HEAD'], repoRoot);
    await git(['fetch', '-q', 'origin'], work);

    // The first call may join the refill's upkeep, which read the base before
    // the fetch; the second is an upkeep of its own.
    await pool.maintainAll();
    await pool.maintainAll();
    const lanes = pool.snapshot(PROJECT_ID);
    expect(lanes.map((l) => [l.state, l.headOid])).toEqual([['warm', third], ['warm', third]]);
    for (const lane of lanes) {
      expect(await git(['rev-parse', 'HEAD'], lane.path)).toBe(third);
      expect(await readFile(join(lane.path, 'e.txt'), 'utf8')).toBe('eee\n');
    }
    expect((await manager.list(work)).filter((e) => e.path.includes('worktrees-pool'))).toHaveLength(2);
    await pool.drain();
  });
});

describe('P6 — the startup sweep', () => {
  it('removes every warm lane a previous process left, prunes git, and reports what else it found', async () => {
    const a = await areas();
    const before = pooled(a);
    before.pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(before.pool, 2);
    const leftovers = before.pool.snapshot(PROJECT_ID).map((l) => l.path);
    // The previous process dies here. Something that is not a lane is there too.
    await writeFile(join(a.poolRoot, 'notes.txt'), 'not a lane\n');

    const { manager, pool } = pooled(a);
    const report = await pool.sweepOnce();
    expect(report.removed.sort()).toEqual([...leftovers].sort());
    expect(report.unexpected).toEqual([join(await manager.poolRoot(), 'notes.txt')]);
    expect(report.errors).toEqual([]);
    for (const path of leftovers) expect(await exists(path)).toBe(false);
    const listed = (await manager.list(repoRoot)).map((e) => e.path);
    for (const path of leftovers) expect(listed).not.toContain(path);
    expect(await readFile(join(a.poolRoot, 'notes.txt'), 'utf8')).toBe('not a lane\n');
    // Once per process: the second call is the first call's answer.
    expect(await pool.sweepOnce()).toBe(report);
  });
});

describe('P7 — containment', () => {
  it('a pool area that resolves outside its data directory is refused: no fill, nothing deleted there', async () => {
    const a = await areas();
    const outside = join(base, `outside-area-${areaSeq}`);
    await mkdir(join(outside, PROJECT_ID, uuidN(70)), { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'mine\n');
    await symlink(outside, a.poolRoot);
    const log = logger();
    const { pool } = pooled(a, 2, log);

    const report = await pool.sweepOnce();
    expect(report.errors).toHaveLength(1);
    expect(report.removed).toEqual([]);
    pool.replenish(PROJECT_ID, repoRoot);
    const id = uuidN(71);
    expect(await pool.claim({ projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid }))
      .toBeNull();
    expect(pool.snapshot()).toEqual([]);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(await exists(join(outside, PROJECT_ID, uuidN(70)))).toBe(true);
    expect(log.warns.some((w) => w.message.includes('unusable'))).toBe(true);
  });

  it('a lane path swapped for an outside symlink before the move: the moved lane is removed, the claim refused', async () => {
    const a = await areas();
    const manager = new WorktreeManager({ worktreeRoot: a.worktreeRoot, pool: { root: a.poolRoot, size: 1 } });
    const laneId = uuidN(72);
    const { path: from } = await manager.addPoolLane({ repoRoot, projectId: PROJECT_ID, laneId, baseCommitOid: firstOid });
    const outside = join(base, `outside-move-${areaSeq}`);
    await mkdir(outside, { recursive: true });
    const parent = join(await manager.worktreeRoot(), PROJECT_ID);
    const worktreeId = uuidN(73);

    await expect(manager.adoptPoolLane({
      repoRoot, projectId: PROJECT_ID, worktreeId, branch: `tm8/${worktreeId}`, baseCommitOid: firstOid,
      from, fromOid: firstOid,
      onBeforeGitMove: async () => {
        // Between the parent check and `git worktree move`, the parent becomes a symlink out.
        await rm(parent, { recursive: true, force: true });
        await symlink(outside, parent);
      },
    })).rejects.toMatchObject({ reason: 'containment_violation' });

    expect(await exists(join(outside, worktreeId))).toBe(false);
    expect((await manager.list(repoRoot)).some((e) => e.path.includes(worktreeId) || e.path === from)).toBe(false);
    await rm(parent, { force: true });
  });

  it('discarding refuses anything that is not a warm lane in the pool area', async () => {
    const a = await areas();
    const manager = new WorktreeManager({ worktreeRoot: a.worktreeRoot, pool: { root: a.poolRoot, size: 1 } });
    const lane = await manager.add({
      repoRoot, projectId: PROJECT_ID, worktreeId: uuidN(74), branch: `tm8/${uuidN(74)}`, baseCommitOid: firstOid,
    });
    await expect(manager.discardPoolLane({ projectId: PROJECT_ID, path: lane.path }))
      .rejects.toMatchObject({ reason: 'containment_violation' });
    await expect(manager.discardPoolLane({ projectId: PROJECT_ID, path: await manager.poolRoot() }))
      .rejects.toMatchObject({ reason: 'containment_violation' });
    expect(await git(['status', '--porcelain'], lane.path)).toBe('');
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: lane.path, force: true });
  });
});

describe('P8 — drain', () => {
  it('removes every unclaimed lane, leaves a claimed lane alone, and closes the pool', async () => {
    const a = await areas();
    const { manager, pool } = pooled(a);
    pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(pool, 2);
    const id = uuidN(80);
    const claimed = await pool.claim({ projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid });
    const unclaimed = pool.snapshot(PROJECT_ID).map((l) => l.path);

    const { discarded } = await pool.drain();
    expect(discarded).toBe(unclaimed.length);
    for (const path of unclaimed) expect(await exists(path)).toBe(false);
    expect(await git(['status', '--porcelain'], claimed!.path)).toBe('');
    // Closed for good.
    pool.replenish(PROJECT_ID, repoRoot);
    expect(pool.snapshot()).toEqual([]);
    const next = uuidN(81);
    expect(await pool.claim({ projectId: PROJECT_ID, repoRoot, worktreeId: next, branch: `tm8/${next}`, baseCommitOid: firstOid }))
      .toBeNull();
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: claimed!.path, force: true });
  });
});

describe('P9 — failures', () => {
  let a: Areas;
  beforeEach(async () => {
    a = await areas();
  });

  it('a fill that fails is logged with its path, removed, and backed off — a second replenish does not retry it', async () => {
    const log = logger();
    const manager = new WorktreeManager({ worktreeRoot: a.worktreeRoot, pool: { root: a.poolRoot, size: 2, logger: log } });
    const addPoolLane = vi.spyOn(manager, 'addPoolLane').mockRejectedValue(new Error('disk full'));
    const pool = manager.pool!;

    pool.replenish(PROJECT_ID, repoRoot);
    await waitFor('the backoff warning', () => log.warns.some((w) => w.message.includes('backing off')));
    const warning = log.warns.find((w) => w.message.includes('backing off'))!;
    expect(String(warning.meta?.path)).toContain(await manager.poolRoot());
    expect(warning.meta?.message).toBe('disk full');
    expect(addPoolLane).toHaveBeenCalledTimes(1);
    expect(pool.snapshot()).toEqual([]);

    pool.replenish(PROJECT_ID, repoRoot);
    await pool.maintainAll();
    expect(addPoolLane).toHaveBeenCalledTimes(1);
  });

  it('a project whose repository cannot be read backs off with the repository path', async () => {
    const log = logger();
    const { pool } = pooled(a, 2, log);
    const notARepo = join(base, `not-a-repo-${areaSeq}`);
    await mkdir(notARepo, { recursive: true });
    pool.replenish(PROJECT_ID, notARepo);
    await waitFor('the backoff warning', () => log.warns.some((w) => w.message.includes('backing off')));
    expect(log.warns.find((w) => w.message.includes('backing off'))?.meta?.path).toBe(notARepo);
    expect(pool.snapshot()).toEqual([]);
  });

  it('a lane that vanished from the pool area is not adopted: the claim answers null and the caller goes cold', async () => {
    const log = logger();
    const { manager, pool } = pooled(a, 1, log);
    pool.replenish(PROJECT_ID, repoRoot);
    await warmLanes(pool, 1);
    const [lane] = pool.snapshot(PROJECT_ID);
    await rm(lane!.path, { recursive: true, force: true });

    const id = uuidN(90);
    expect(await pool.claim({ projectId: PROJECT_ID, repoRoot, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid }))
      .toBeNull();
    expect(await exists(await manager.computeWorktreePath(PROJECT_ID, id))).toBe(false);
    expect(log.warns.some((w) => w.message.includes('backing off') && w.meta?.path === lane!.path)).toBe(true);
    // The reservation's path is free for the cold checkout.
    const cold = await manager.add({ repoRoot, projectId: PROJECT_ID, worktreeId: id, branch: `tm8/${id}`, baseCommitOid: firstOid });
    expect(await git(['status', '--porcelain'], cold.path)).toBe('');
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: cold.path, force: true });
    await pool.drain();
  });
});

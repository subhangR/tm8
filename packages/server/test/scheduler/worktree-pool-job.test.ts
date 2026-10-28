/**
 * The warm lane pool's upkeep job (`execution.worktree-pool`) and the
 * `TM8_WORKTREE_POOL` knob that sizes the pool. What upkeep does to lanes is
 * pinned against real repositories in
 * packages/execution/src/worktree/warm-pool.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKTREE_POOL, resolveWorktreePoolSize } from '../../src/facade/execution-handlers.js';
import {
  DEFAULT_WORKTREE_POOL_INTERVAL_MS,
  WORKTREE_POOL_JOB_NAME,
  createWorktreePoolJob,
  runWorktreePoolTick,
} from '../../src/scheduler/jobs/worktree-pool.js';

describe('worktree pool job', () => {
  it('reports the warm lanes upkeep left, per state', async () => {
    const maintain = vi.fn(async () => ({ projects: 2, lanes: { warm: 3, filling: 1 } }));
    expect(await runWorktreePoolTick({ maintain })).toEqual({
      affected: 3,
      detail: { projects: 2, lanes: { warm: 3, filling: 1 } },
    });
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it('a node with no worktree launches yet skips, with a reason', async () => {
    const outcome = await runWorktreePoolTick({ maintain: async () => ({ projects: 0, lanes: {} }) });
    expect(outcome).toMatchObject({ skipped: true });
    expect(outcome.reason).toBeTruthy();
  });

  it('is registered under its name, every five minutes, not at start', () => {
    const job = createWorktreePoolJob({ maintain: async () => ({ projects: 0, lanes: {} }) });
    expect(job.name).toBe(WORKTREE_POOL_JOB_NAME);
    expect(job.intervalMs).toBe(DEFAULT_WORKTREE_POOL_INTERVAL_MS);
    expect(DEFAULT_WORKTREE_POOL_INTERVAL_MS).toBe(5 * 60_000);
    expect(job.runOnStart).toBe(false);
  });
});

describe('resolveWorktreePoolSize (TM8_WORKTREE_POOL)', () => {
  it('defaults to two warm lanes per project', () => {
    expect(DEFAULT_WORKTREE_POOL).toBe(2);
    expect(resolveWorktreePoolSize({})).toBe(2);
    expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: '  ' })).toBe(2);
  });

  it('0 turns the pool off, and a number is honoured', () => {
    expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: '0' })).toBe(0);
    expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: '1' })).toBe(1);
    expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: ' 4 ' })).toBe(4);
  });

  it('a typo is the default, and no value fills the disk with checkouts', () => {
    for (const value of ['two', '-1', '1.5', '2x']) {
      expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: value })).toBe(2);
    }
    expect(resolveWorktreePoolSize({ TM8_WORKTREE_POOL: '500' })).toBe(8);
  });
});

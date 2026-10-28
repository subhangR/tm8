import { CollabError } from '@tm8/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatLeaseLostError, TurnLease, isLeaseFenceError, isTransientDbError, retryTransient,
} from '../../src/chat/lease.js';
import { DbPoolExhaustedError } from '../../src/db/client.js';

const exhausted = () => new DbPoolExhaustedError(5_000, 32, 32, 4);
const staleFence = () => new CollabError('forbidden', 'stale chat execution fence', { details: { sqlstate: '42501' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { vi.restoreAllMocks(); });

describe('error classification', () => {
  it('retries only failures that say nothing about the turn', () => {
    expect(isTransientDbError(exhausted())).toBe(true);
    expect(isTransientDbError(new CollabError('upstream_unavailable', 'x', { details: { sqlstate: '57014' } }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientDbError(staleFence())).toBe(false);
    expect(isTransientDbError(new CollabError('forbidden', 'preparation failure cannot settle possible dispatch',
      { details: { sqlstate: '42501' } }))).toBe(false);
    expect(isTransientDbError(new Error('DB offline'))).toBe(false);
  });
  it('recognises a refused lease fence and nothing else', () => {
    expect(isLeaseFenceError(staleFence())).toBe(true);
    expect(isLeaseFenceError(new CollabError('forbidden', 'stale native generation', { details: { sqlstate: '42501' } }))).toBe(true);
    expect(isLeaseFenceError(new CollabError('forbidden', 'chat not found', { details: { sqlstate: '42501' } }))).toBe(false);
    expect(isLeaseFenceError(exhausted())).toBe(false);
  });
});

describe('retryTransient', () => {
  it('retries a pool wait with backoff, reports every failed attempt, and returns the eventual answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0; const retries: number[] = [];
    const value = await retryTransient(async () => { calls += 1; if (calls < 3) throw exhausted(); return 'written'; },
      { until: () => Date.now() + 1_000, baseMs: 1, onRetry: (_e, attempt) => retries.push(attempt) });
    expect(value).toBe('written'); expect(retries).toEqual([1, 2]);
  });
  it('rethrows a real answer at once and a transient one when the budget is spent', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls += 1; throw staleFence(); }, { until: () => Date.now() + 1_000, baseMs: 1 }))
      .rejects.toThrow('stale chat execution fence');
    expect(calls).toBe(1);
    await expect(retryTransient(async () => { throw exhausted(); }, { until: () => Date.now() + 20, baseMs: 5 }))
      .rejects.toBeInstanceOf(DbPoolExhaustedError);
  });
});

describe('TurnLease', () => {
  function lease(renew: () => Promise<void>, overrides: Partial<ConstructorParameters<typeof TurnLease>[0]> = {}) {
    const onLost = vi.fn(); const onError = vi.fn();
    const keeper = new TurnLease({ renew, claimedAt: Date.now(), leaseMs: 400, safetyMs: 50, intervalMs: 10,
      attemptTimeoutMs: 50, retryBaseMs: 5, retryCapMs: 20, label: 'chat c turn t attempt 1', onLost, onError, ...overrides });
    return { keeper, onLost, onError };
  }

  it('retries a renewal that failed on a pool wait instead of dropping it, logging each failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const { keeper, onLost, onError } = lease(async () => { calls += 1; if (calls <= 2) throw exhausted(); });
    keeper.start(); await sleep(80); keeper.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(onLost).not.toHaveBeenCalled(); expect(keeper.lost).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls.filter(([line]) => String(line).includes('lease renewal failed for chat c turn t'))).toHaveLength(2);
  });

  it('declares the lease lost before it can expire when no renewal lands, and ends every racing wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { keeper, onLost } = lease(async () => { throw exhausted(); }, { leaseMs: 120 });
    const waiting = Promise.race([new Promise(() => {}), keeper.whenLost]);
    keeper.start();
    await expect(waiting).rejects.toBeInstanceOf(ChatLeaseLostError);
    expect(onLost).toHaveBeenCalledOnce();
    expect(keeper.lost?.message).toMatch(/no lease renewal landed for \d+s \(last error: database busy/);
    expect(Date.now()).toBeLessThan(keeper.latestExpiry);
    keeper.stop();
  });

  it('declares the lease lost at once when the database refuses its fence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renew = vi.fn(async () => { throw staleFence(); });
    const { keeper, onLost } = lease(renew);
    keeper.start(); await sleep(40); keeper.stop();
    expect(renew).toHaveBeenCalledOnce(); expect(onLost).toHaveBeenCalledOnce();
    expect(keeper.lost?.reason).toContain('the database refused its lease');
  });

  it('bounds a renewal that never answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { keeper, onError } = lease(() => new Promise<void>(() => {}), { attemptTimeoutMs: 15, leaseMs: 10_000 });
    keeper.start(); await sleep(60); keeper.stop();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'lease renewal timed out after 15ms' });
  });

  it('treats a fence refusal seen by any other write as a lost lease', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { keeper, onLost } = lease(async () => {});
    keeper.observe(exhausted()); expect(onLost).not.toHaveBeenCalled();
    keeper.observe(staleFence()); expect(onLost).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedTrigger, runLimited } from './event-refresh';

describe('createCoalescedTrigger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a burst costs ONE round, fired after the quiet period', async () => {
    const run = vi.fn();
    const t = createCoalescedTrigger({ quietMs: 600, maxWaitMs: 2_000, run });
    for (let i = 0; i < 50; i++) t.note();
    await vi.advanceTimersByTimeAsync(599);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    t.dispose();
  });

  it('a continuous stream still fires by the ceiling, not once per event', async () => {
    const run = vi.fn();
    const t = createCoalescedTrigger({ quietMs: 600, maxWaitMs: 2_000, run });
    // One event every 100ms for 10s: the quiet period is never reached.
    for (let ms = 0; ms < 10_000; ms += 100) {
      t.note();
      await vi.advanceTimersByTimeAsync(100);
    }
    // The old leading 400ms throttle fired 25 times over this window.
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(run.mock.calls.length).toBeLessThanOrEqual(5);
    t.dispose();
  });

  it('never overlaps a round in flight; events during it cost exactly one more', async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => { release = r; });
      active -= 1;
    });
    const t = createCoalescedTrigger({ quietMs: 100, maxWaitMs: 500, run });
    t.note();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    // A long round: many events arrive while it is outstanding.
    for (let i = 0; i < 20; i++) {
      t.note();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    t.dispose();
  });

  it('dispose cancels a pending round', async () => {
    const run = vi.fn();
    const t = createCoalescedTrigger({ quietMs: 100, maxWaitMs: 500, run });
    t.note();
    t.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('runLimited', () => {
  it('holds at most `limit` tasks in flight and runs them all', async () => {
    let active = 0;
    let maxActive = 0;
    let done = 0;
    const tasks = Array.from({ length: 64 }, () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      done += 1;
    });
    await runLimited(tasks, 4);
    expect(done).toBe(64);
    expect(maxActive).toBe(4);
  });

  it('a rejected task does not stop the rest', async () => {
    let done = 0;
    await runLimited([
      async () => { throw new Error('boom'); },
      async () => { done += 1; },
    ], 1);
    expect(done).toBe(1);
  });
});

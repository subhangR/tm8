/**
 * The one job runner (R26).
 *
 * The properties that matter operationally: jobs actually fire on their
 * interval, a slow job never has a second copy started on top of it, a throwing
 job never takes the runner down, and stopping actually stops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../src/sidecar/log.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { JobContext, ScheduledJob } from '../../src/scheduler/types.js';

function makeScheduler(random = () => 0.5): Scheduler {
  // random() === 0.5 → zero jitter offset, so timer maths in tests is exact.
  return new Scheduler({ logger: silentLogger, random, startupDelayMs: 100 });
}

describe('registration', () => {
  it('registers jobs and exposes them in status()', () => {
    const s = makeScheduler();
    s.register({ name: 'a', intervalMs: 1000, run: async () => ({}) });
    s.register({ name: 'b', intervalMs: 2000, run: async () => ({}) });

    expect(s.jobNames()).toEqual(['a', 'b']);
    expect(s.has('a')).toBe(true);
    const status = s.status();
    expect(status.running).toBe(false);
    expect(status.jobs.map((j) => j.name)).toEqual(['a', 'b']);
    expect(status.jobs[0]?.state).toBe('idle');
    expect(status.jobs[0]?.nextRunAt).toBeNull();
  });

  it('refuses duplicate names and non-positive intervals', () => {
    const s = makeScheduler();
    s.register({ name: 'a', intervalMs: 1000, run: async () => ({}) });
    expect(() => s.register({ name: 'a', intervalMs: 1000, run: async () => ({}) })).toThrow(
      /already registered/,
    );
    expect(() => s.register({ name: 'b', intervalMs: 0, run: async () => ({}) })).toThrow(
      /positive intervalMs/,
    );
  });

  it('throws on runNow for an unknown job', async () => {
    await expect(makeScheduler().runNow('nope')).rejects.toThrow(/unknown job/);
  });
});

describe('execution', () => {
  it('runs a job on demand and records the outcome', async () => {
    const s = makeScheduler();
    let seen: JobContext | null = null;
    s.register({
      name: 'j',
      intervalMs: 1000,
      run: async (ctx) => {
        seen = ctx;
        return { affected: 3 };
      },
    });

    const outcome = await s.runNow('j');
    expect(outcome).toEqual({ affected: 3 });
    expect(seen).not.toBeNull();
    expect(seen!.name).toBe('j');
    expect(seen!.signal.aborted).toBe(false);

    const st = s.status().jobs[0]!;
    expect(st.runs).toBe(1);
    expect(st.failures).toBe(0);
    expect(st.lastOutcome).toEqual({ affected: 3 });
    expect(st.lastRunAt).not.toBeNull();
  });

  it('treats a void return as an empty outcome', async () => {
    const s = makeScheduler();
    s.register({ name: 'j', intervalMs: 1000, run: async () => undefined });
    expect(await s.runNow('j')).toEqual({});
  });

  it('isolates failures: the job is recorded, the runner survives', async () => {
    const s = makeScheduler();
    s.register({
      name: 'bad',
      intervalMs: 1000,
      run: async () => {
        throw new Error('boom');
      },
    });
    s.register({ name: 'good', intervalMs: 1000, run: async () => ({ affected: 1 }) });

    expect(await s.runNow('bad')).toBeNull();
    expect(await s.runNow('good')).toEqual({ affected: 1 });

    const bad = s.status().jobs.find((j) => j.name === 'bad')!;
    expect(bad.failures).toBe(1);
    expect(bad.lastError).toBe('boom');
    expect(bad.state).toBe('idle');
  });
});

describe('per-job locking', () => {
  it('refuses a concurrent run of the same job and counts it as an overrun', async () => {
    const s = makeScheduler();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered = 0;

    s.register({
      name: 'slow',
      intervalMs: 10_000,
      run: async () => {
        entered += 1;
        await gate;
        return { affected: entered };
      },
    });

    const first = s.runNow('slow');
    // The second attempt must not enter the body at all.
    const second = await s.runNow('slow');
    expect(second).toBeNull();
    expect(entered).toBe(1);
    expect(s.status().jobs[0]?.state).toBe('running');
    expect(s.status().jobs[0]?.overruns).toBe(1);

    release();
    expect(await first).toEqual({ affected: 1 });
    expect(s.status().jobs[0]?.state).toBe('idle');

    // The lock is released, so a later run proceeds normally.
    expect(await s.runNow('slow')).toEqual({ affected: 2 });
  });

  it('locks per job, not globally', async () => {
    const s = makeScheduler();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    s.register({ name: 'slow', intervalMs: 10_000, run: () => gate.then(() => ({})) });
    s.register({ name: 'fast', intervalMs: 10_000, run: async () => ({ affected: 7 }) });

    const slow = s.runNow('slow');
    expect(await s.runNow('fast')).toEqual({ affected: 7 });
    release();
    await slow;
  });
});

describe('jitter', () => {
  it('stays within ±ratio of the interval and never goes negative', () => {
    const lo = new Scheduler({ logger: silentLogger, random: () => 0 });
    const hi = new Scheduler({ logger: silentLogger, random: () => 0.999_999 });
    const mid = new Scheduler({ logger: silentLogger, random: () => 0.5 });
    const job: ScheduledJob = { name: 'j', intervalMs: 1000, jitterRatio: 0.2, run: async () => ({}) };

    expect(lo.nextDelay(job)).toBe(800);
    expect(mid.nextDelay(job)).toBe(1000);
    expect(hi.nextDelay(job)).toBeLessThanOrEqual(1200);
    expect(hi.nextDelay(job)).toBeGreaterThan(1190);

    const noJitter: ScheduledJob = { name: 'k', intervalMs: 500, jitterRatio: 0, run: async () => ({}) };
    expect(lo.nextDelay(noJitter)).toBe(500);
    expect(hi.nextDelay(noJitter)).toBe(500);
  });
});

describe('timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on the interval and reschedules itself', async () => {
    const s = makeScheduler();
    let runs = 0;
    s.register({ name: 'tick', intervalMs: 1000, run: async () => { runs += 1; return {}; } });

    s.start();
    expect(s.status().running).toBe(true);
    expect(s.status().jobs[0]?.nextRunAt).not.toBeNull();
    expect(runs).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);

    await s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(2);
    expect(s.status().running).toBe(false);
    expect(s.status().jobs[0]?.nextRunAt).toBeNull();
  });

  it('honours runOnStart with the short startup delay', async () => {
    const s = makeScheduler();
    let runs = 0;
    s.register({
      name: 'eager',
      intervalMs: 60_000,
      runOnStart: true,
      run: async () => { runs += 1; return {}; },
    });

    s.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(1);
    // Subsequent runs use the real interval, not the startup delay.
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    await s.stop();
  });

  it('start() is idempotent and registering while started arms the new job', async () => {
    const s = makeScheduler();
    let runs = 0;
    s.start();
    s.start();
    s.register({ name: 'late', intervalMs: 1000, run: async () => { runs += 1; return {}; } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    await s.stop();
  });

  it('aborts in-flight jobs on stop()', async () => {
    const s = makeScheduler();
    let aborted = false;
    s.register({
      name: 'watcher',
      intervalMs: 1000,
      run: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await new Promise<void>((r) => setTimeout(r, 50_000));
        return {};
      },
    });

    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = s.stop(0);
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(aborted).toBe(true);
  });
});

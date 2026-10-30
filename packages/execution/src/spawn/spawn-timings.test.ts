import { describe, expect, it } from 'vitest';

import { SpawnPhaseTimer } from './spawn-timings.js';

/** A clock the test moves by hand, so every duration below is exact. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('SpawnPhaseTimer', () => {
  it('times each phase and the whole span, in the order the phases started', async () => {
    const clock = manualClock();
    const timer = new SpawnPhaseTimer(clock.now);
    await timer.time('read', async () => clock.advance(12.34));
    timer.timeSync('compose', () => clock.advance(0.26));
    clock.advance(5);

    const timings = timer.snapshot();
    expect(Object.keys(timings.phases)).toEqual(['read', 'compose']);
    expect(timings.phases).toEqual({ read: 12.3, compose: 0.3 });
    expect(timings.totalMs).toBe(17.6);
  });

  it('times a phase that throws, and rethrows', async () => {
    const clock = manualClock();
    const timer = new SpawnPhaseTimer(clock.now);
    await expect(
      timer.time('refused', async () => {
        clock.advance(7);
        throw new Error('no such teammate');
      }),
    ).rejects.toThrow('no such teammate');
    expect(timer.snapshot().phases).toEqual({ refused: 7 });
  });

  it('accumulates a phase timed twice, and takes recorded durations as given', async () => {
    const clock = manualClock();
    const timer = new SpawnPhaseTimer(clock.now);
    await timer.time('write', async () => clock.advance(2));
    await timer.time('write', async () => clock.advance(3));
    timer.record('handler.read', 4.44);
    expect(timer.snapshot().phases).toEqual({ write: 5, 'handler.read': 4.4 });
  });
});

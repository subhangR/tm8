// @tm8/execution — the wall clock of one spawn, phase by phase.
//
// CONTRACT
//   Called by: `SpawnService` (one timer per launch, spanning its admission and
//   its boot) and the `execution.spawn` handler (its own reads and writes
//   around SpawnService's, recorded into the same shape).
//   Input: named phases, each timed around a sync or async step.
//   Output: `SpawnTimings` — total wall clock since the timer was created and
//   each phase's own duration in ms, a tenth of a millisecond precise.
//   Invariants: a phase that throws is still timed; a phase timed twice
//   accumulates; concurrent phases overlap, so they need not sum to the total.
//   Nothing here changes what a launch does, only what it reports.
//
// A launch is a long chain of graph round trips, filesystem writes and
// subprocesses, and the only number the node ever had was the total: the row's
// `created_at`, the `running` transition, and an HTTP span around both. That
// says a launch is slow without saying where.

import { performance } from 'node:perf_hooks';

export interface SpawnTimings {
  /** Wall clock from the start of the timed span to the moment this was read. */
  totalMs: number;
  /**
   * Each phase's own wall clock, keyed by phase name in the order the phases
   * started. Phases that ran concurrently overlap, so they need not sum to
   * `totalMs`; a phase timed twice accumulates.
   */
  phases: Record<string, number>;
}

/** Sub-millisecond phases are real (in-process resolution), so keep a tenth. */
function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export class SpawnPhaseTimer {
  private readonly startedAt: number;
  private readonly phases = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  /**
   * Time one phase. A phase that throws is timed too: what a refusal cost is
   * part of what the launch cost.
   */
  async time<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await run();
    } finally {
      this.record(phase, this.now() - t0);
    }
  }

  timeSync<T>(phase: string, run: () => T): T {
    const t0 = this.now();
    try {
      return run();
    } finally {
      this.record(phase, this.now() - t0);
    }
  }

  record(phase: string, ms: number): void {
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + ms);
  }

  snapshot(): SpawnTimings {
    const phases: Record<string, number> = {};
    for (const [phase, ms] of this.phases) phases[phase] = round(ms);
    return { totalMs: round(this.now() - this.startedAt), phases };
  }
}

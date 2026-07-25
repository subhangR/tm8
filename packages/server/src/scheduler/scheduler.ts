/**
 * The one job runner (R26).
 *
 * Design notes, each of which is a decision rather than an accident:
 *
 * * **Self-rescheduling timers, not `setInterval`.** A fixed interval keeps
 *   firing while a slow job is still running, so a job that occasionally takes
 *   longer than its period silently stacks up. Each job schedules its own next
 *   run *after* the previous one settles — and jitter, which R26 asks for, is
 *   only expressible this way.
 * * **Per-job lock.** Even so, `runNow()` can race a timer fire, so every job
 *   holds an exclusive in-process lock. An attempt to enter a locked job is
 *   counted as an *overrun* and logged — never silently dropped.
 * * **Failure isolation.** A throwing job is recorded and rescheduled; it never
 *   takes down the runner or its siblings.
 * * **Unref'd timers.** The scheduler must not, by itself, keep the node process
 *   alive.
 *
 * The per-job lock is process-local, which is correct while tm8 is single-node:
 * the sidecar's single-instance lock (§7) already guarantees one server per data
 * dir. When Phase 2 introduces multiple nodes against one database, the same
 * seam takes a database-backed advisory lock — `acquire`/`release` is the only
 * thing that changes.
 */

import { createLogger, type SidecarLogger } from '../sidecar/log.js';
import type { JobOutcome, JobStatus, ScheduledJob, SchedulerStatus } from './types.js';

export interface SchedulerOptions {
  readonly logger?: SidecarLogger;
  /** Deterministic jitter for tests. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Default jitter when a job does not specify one. */
  readonly defaultJitterRatio?: number;
  /** Delay before a `runOnStart` job's first run. Default 5 s. */
  readonly startupDelayMs?: number;
}

const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_STARTUP_DELAY_MS = 5_000;

interface JobRecord {
  readonly job: ScheduledJob;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastRunAt: string | null;
  lastOutcome: JobOutcome | null;
  lastError: string | null;
  runs: number;
  failures: number;
  overruns: number;
  nextRunAt: number | null;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly logger: SidecarLogger;
  private readonly random: () => number;
  private readonly defaultJitterRatio: number;
  private readonly startupDelayMs: number;
  private started = false;
  private stopping: AbortController | null = null;

  constructor(opts: SchedulerOptions = {}) {
    this.logger = opts.logger ?? createLogger('scheduler');
    this.random = opts.random ?? Math.random;
    this.defaultJitterRatio = opts.defaultJitterRatio ?? DEFAULT_JITTER_RATIO;
    this.startupDelayMs = opts.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  }

  /** Register a job. Names are unique; re-registering a name is an error. */
  register(job: ScheduledJob): this {
    if (this.jobs.has(job.name)) {
      throw new Error(`scheduler: job "${job.name}" is already registered`);
    }
    if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
      throw new Error(`scheduler: job "${job.name}" needs a positive intervalMs`);
    }
    this.jobs.set(job.name, {
      job,
      timer: null,
      running: false,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
      runs: 0,
      failures: 0,
      overruns: 0,
      nextRunAt: null,
    });
    if (this.started) this.arm(job.name);
    return this;
  }

  registerAll(jobs: readonly ScheduledJob[]): this {
    for (const j of jobs) this.register(j);
    return this;
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  jobNames(): string[] {
    return [...this.jobs.keys()];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = new AbortController();
    for (const name of this.jobs.keys()) this.arm(name);
    this.logger.info(`started with ${this.jobs.size} job(s): ${this.jobNames().join(', ')}`);
  }

  /**
   * Stop firing and abort in-flight jobs. Awaits nothing longer than
   * `drainMs` — a job that ignores its abort signal must not block shutdown.
   */
  async stop(drainMs = 5_000): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stopping?.abort();
    this.stopping = null;

    for (const rec of this.jobs.values()) {
      if (rec.timer !== null) clearTimeout(rec.timer);
      rec.timer = null;
      rec.nextRunAt = null;
    }

    const deadline = Date.now() + drainMs;
    while ([...this.jobs.values()].some((r) => r.running) && Date.now() < deadline) {
      await new Promise<void>((r) => {
        setTimeout(r, 25).unref();
      });
    }
    const stuck = [...this.jobs.values()].filter((r) => r.running).map((r) => r.job.name);
    if (stuck.length > 0) this.logger.warn(`stopped with jobs still in flight: ${stuck.join(', ')}`);
    else this.logger.info('stopped');
  }

  /**
   * Run a job immediately, out of band.
   * @returns the outcome, or `null` when the job was already running (overrun).
   */
  async runNow(name: string): Promise<JobOutcome | null> {
    const rec = this.jobs.get(name);
    if (rec === undefined) throw new Error(`scheduler: unknown job "${name}"`);
    return this.execute(rec, 'manual');
  }

  status(): SchedulerStatus {
    return {
      running: this.started,
      jobs: [...this.jobs.values()].map((rec): JobStatus => ({
        name: rec.job.name,
        state: rec.running ? 'running' : 'idle',
        intervalMs: rec.job.intervalMs,
        lastRunAt: rec.lastRunAt,
        lastOutcome: rec.lastOutcome,
        lastError: rec.lastError,
        runs: rec.runs,
        failures: rec.failures,
        overruns: rec.overruns,
        nextRunAt: rec.nextRunAt === null ? null : new Date(rec.nextRunAt).toISOString(),
      })),
    };
  }

  // --- internals ------------------------------------------------------------

  /** Base delay ± jitterRatio, never negative. */
  nextDelay(job: ScheduledJob, base = job.intervalMs): number {
    const ratio = job.jitterRatio ?? this.defaultJitterRatio;
    if (ratio <= 0) return base;
    const spread = base * Math.min(ratio, 0.99);
    // random() in [0,1) → offset in [-spread, +spread)
    return Math.max(0, Math.round(base + (this.random() * 2 - 1) * spread));
  }

  private arm(name: string, base?: number): void {
    const rec = this.jobs.get(name);
    if (rec === undefined || !this.started) return;
    if (rec.timer !== null) clearTimeout(rec.timer);

    const delay = this.nextDelay(rec.job, base ?? (rec.runs === 0 && rec.job.runOnStart ? this.startupDelayMs : rec.job.intervalMs));
    rec.nextRunAt = Date.now() + delay;
    rec.timer = setTimeout(() => {
      void this.execute(rec, 'timer').finally(() => this.arm(name));
    }, delay);
    rec.timer.unref();
  }

  private async execute(rec: JobRecord, trigger: 'timer' | 'manual'): Promise<JobOutcome | null> {
    if (rec.running) {
      rec.overruns += 1;
      this.logger.warn(
        `job "${rec.job.name}" (${trigger}) skipped: the previous run is still in progress (overrun #${rec.overruns})`,
      );
      return null;
    }

    rec.running = true;
    const firedAt = new Date();
    const controller = new AbortController();
    const onStop = () => controller.abort();
    this.stopping?.signal.addEventListener('abort', onStop, { once: true });
    const timeoutMs = rec.job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    const startedAtMs = Date.now();

    try {
      const outcome = (await rec.job.run({
        name: rec.job.name,
        firedAt,
        logger: this.logger,
        signal: controller.signal,
      })) ?? {};
      rec.runs += 1;
      rec.lastRunAt = firedAt.toISOString();
      rec.lastOutcome = outcome;
      rec.lastError = null;
      const ms = Date.now() - startedAtMs;
      if (outcome.skipped) {
        this.logger.info(`job "${rec.job.name}" skipped: ${outcome.reason ?? 'no reason given'} (${ms}ms)`);
      } else {
        this.logger.info(
          `job "${rec.job.name}" ok${outcome.affected === undefined ? '' : ` (affected ${outcome.affected})`} (${ms}ms)`,
        );
      }
      return outcome;
    } catch (e) {
      rec.runs += 1;
      rec.failures += 1;
      rec.lastRunAt = firedAt.toISOString();
      rec.lastError = e instanceof Error ? e.message : String(e);
      // A failing job never takes the runner or its siblings down.
      this.logger.error(`job "${rec.job.name}" FAILED (failure #${rec.failures})`, e);
      return null;
    } finally {
      clearTimeout(timeout);
      this.stopping?.signal.removeEventListener('abort', onStop);
      rec.running = false;
    }
  }
}

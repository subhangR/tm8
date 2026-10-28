/**
 * The Codex home reclaim job (`execution.codex-home-reclaim`): its tick reports
 * honestly, and the retention knob is off unless an operator sets a positive
 * number of days. What gets reclaimed is pinned in
 * packages/execution/test/codex-home-reclaim.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_HOME_RECLAIM_JOB_NAME,
  codexHomeRetentionMsFromEnv,
  createCodexHomeReclaimJob,
  runCodexHomeReclaimTick,
} from '../../src/scheduler/jobs/codex-home-reclaim.js';
import { silentLogger } from '../../src/sidecar/log.js';

const DAY = 24 * 60 * 60_000;

describe('codex home reclaim job', () => {
  it('passes the retention through and reports what it reclaimed', async () => {
    const reclaim = vi.fn(async () => ({ reclaimed: 3, errors: [] }));
    expect(await runCodexHomeReclaimTick({ reclaim, retentionMs: 7 * DAY })).toEqual({
      affected: 3,
      detail: { reclaimed: 3, failed: 0 },
    });
    expect(reclaim).toHaveBeenCalledWith(7 * DAY);
  });

  it('a tick with nothing to do is a skip with a reason, and keeps resumable homes by default', async () => {
    const reclaim = vi.fn(async () => ({ reclaimed: 0, errors: [] }));
    const outcome = await runCodexHomeReclaimTick({ reclaim });
    expect(outcome).toMatchObject({ skipped: true });
    expect(reclaim).toHaveBeenCalledWith(null);
  });

  it('logs problems without throwing', async () => {
    const log = vi.fn();
    const outcome = await runCodexHomeReclaimTick(
      { reclaim: async () => ({ reclaimed: 0, errors: [{ message: 'node admin required' }] }) },
      log,
    );
    expect(outcome).toEqual({ affected: 0, detail: { reclaimed: 0, failed: 1 } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('node admin required'));
  });

  it('registers hourly, runs at start, and runs through the context logger', async () => {
    const job = createCodexHomeReclaimJob({ reclaim: async () => ({ reclaimed: 1, errors: [] }) });
    expect(job.name).toBe(CODEX_HOME_RECLAIM_JOB_NAME);
    expect(job.intervalMs).toBe(60 * 60_000);
    expect(job.runOnStart).toBe(true);
    const outcome = await job.run({
      name: job.name,
      firedAt: new Date('2026-10-19T12:00:00Z'),
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ affected: 1 });
  });

  it('TM8_CODEX_HOME_RETENTION_DAYS is off unless a positive number of days', () => {
    expect(codexHomeRetentionMsFromEnv({})).toBeNull();
    expect(codexHomeRetentionMsFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: '' })).toBeNull();
    expect(codexHomeRetentionMsFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: '0' })).toBeNull();
    expect(codexHomeRetentionMsFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: '-3' })).toBeNull();
    expect(codexHomeRetentionMsFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: 'week' })).toBeNull();
    expect(codexHomeRetentionMsFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: ' 14 ' })).toBe(14 * DAY);
  });
});

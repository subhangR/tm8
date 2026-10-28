/**
 * The session artifact reclaim job (`execution.session-artifact-reclaim`): its
 * tick reports honestly, and the retention knobs are off unless an operator
 * sets a positive number of days. What gets reclaimed is pinned in
 * packages/execution/test/codex-home-reclaim.test.ts and
 * packages/execution/test/session-artifact-reclaim.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_ARTIFACT_RECLAIM_JOB_NAME,
  createSessionArtifactReclaimJob,
  runSessionArtifactReclaimTick,
  sessionHomeRetentionFromEnv,
} from '../../src/scheduler/jobs/session-artifact-reclaim.js';
import { silentLogger } from '../../src/sidecar/log.js';

const DAY = 24 * 60 * 60_000;
const KEEP = { codexHomeMs: null, spaceHomeMs: null };

describe('session artifact reclaim job', () => {
  it('passes the retention through and reports what it reclaimed', async () => {
    const reclaim = vi.fn(async () => ({ reclaimed: 3, errors: [] }));
    const retention = { codexHomeMs: 7 * DAY, spaceHomeMs: 7 * DAY };
    expect(await runSessionArtifactReclaimTick({ reclaim, retention })).toEqual({
      affected: 3,
      detail: { reclaimed: 3, failed: 0 },
    });
    expect(reclaim).toHaveBeenCalledWith(retention);
  });

  it('a tick with nothing to do is a skip with a reason, and keeps every usable home by default', async () => {
    const reclaim = vi.fn(async () => ({ reclaimed: 0, errors: [] }));
    const outcome = await runSessionArtifactReclaimTick({ reclaim });
    expect(outcome).toMatchObject({ skipped: true });
    expect(reclaim).toHaveBeenCalledWith(KEEP);
  });

  it('logs problems without throwing', async () => {
    const log = vi.fn();
    const outcome = await runSessionArtifactReclaimTick(
      { reclaim: async () => ({ reclaimed: 0, errors: [{ message: 'node admin required' }] }) },
      log,
    );
    expect(outcome).toEqual({ affected: 0, detail: { reclaimed: 0, failed: 1 } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('node admin required'));
  });

  it('registers hourly, runs at start, and runs through the context logger', async () => {
    const job = createSessionArtifactReclaimJob({ reclaim: async () => ({ reclaimed: 1, errors: [] }) });
    expect(job.name).toBe(SESSION_ARTIFACT_RECLAIM_JOB_NAME);
    expect(job.name).toBe('execution.session-artifact-reclaim');
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

  it('TM8_SESSION_HOME_RETENTION_DAYS is off unless a positive number of days, and covers both homes', () => {
    expect(sessionHomeRetentionFromEnv({})).toEqual(KEEP);
    for (const raw of ['', '0', '-3', 'week']) {
      expect(sessionHomeRetentionFromEnv({ TM8_SESSION_HOME_RETENTION_DAYS: raw })).toEqual(KEEP);
    }
    expect(sessionHomeRetentionFromEnv({ TM8_SESSION_HOME_RETENTION_DAYS: ' 14 ' }))
      .toEqual({ codexHomeMs: 14 * DAY, spaceHomeMs: 14 * DAY });
  });

  it('the older TM8_CODEX_HOME_RETENTION_DAYS still means Codex homes only, and the new name wins', () => {
    for (const raw of ['', '0', '-3', 'week']) {
      expect(sessionHomeRetentionFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: raw })).toEqual(KEEP);
    }
    expect(sessionHomeRetentionFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: ' 14 ' }))
      .toEqual({ codexHomeMs: 14 * DAY, spaceHomeMs: null });
    expect(sessionHomeRetentionFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: '14', TM8_SESSION_HOME_RETENTION_DAYS: '3' }))
      .toEqual({ codexHomeMs: 3 * DAY, spaceHomeMs: 3 * DAY });
    // An invalid new value falls back to the old one rather than to "keep".
    expect(sessionHomeRetentionFromEnv({ TM8_CODEX_HOME_RETENTION_DAYS: '14', TM8_SESSION_HOME_RETENTION_DAYS: 'x' }))
      .toEqual({ codexHomeMs: 14 * DAY, spaceHomeMs: null });
  });
});

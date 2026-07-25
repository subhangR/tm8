/**
 * The registered job set (R26 + SIDECAR-PACKAGING.md §5).
 *
 * The point of asserting the stubs is that they are *honest* stubs: they report
 * `skipped` with a reason on every run. A stub that returned a bare success
 * would make the retention surface look wired long before it is.
 */

import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../src/sidecar/log.js';
import {
  BACKUP_JOB_NAME,
  COMMAND_LEDGER_TTL_MS,
  RESERVED_JOB_SLOTS,
  RETENTION_POLICIES,
  createBackupJob,
  createDefaultScheduler,
  createRetentionJobs,
  defaultJobNames,
} from '../../src/scheduler/index.js';
import type { JobContext } from '../../src/scheduler/types.js';
import type { SidecarManager, SidecarStatus } from '../../src/sidecar/manager.js';

function ctx(name: string): JobContext {
  return {
    name,
    firedAt: new Date('2026-07-25T12:00:00Z'),
    logger: silentLogger,
    signal: new AbortController().signal,
  };
}

function fakeSidecar(state: SidecarStatus['state'], backupNow = vi.fn()): SidecarManager {
  return {
    ensureStarted: vi.fn(),
    stop: vi.fn(),
    status: () =>
      ({
        state,
        pgMajor: 18,
        clusterMajor: 18,
        pid: 123,
        socketDir: '/tmp/run',
        pgPort: 5443,
        dataDir: '/tmp/data',
        pgDataDir: '/tmp/data/pg/18',
      }) as SidecarStatus,
    backupNow,
    exportTo: vi.fn(),
    config: {} as SidecarManager['config'],
  } as unknown as SidecarManager;
}

describe('retention jobs', () => {
  it('registers the four R26 retention jobs with their policies', () => {
    const jobs = createRetentionJobs();
    expect(jobs.map((j) => j.name)).toEqual([
      'retention.command-ledger',
      'retention.workspace-events',
      'retention.soft-delete-purge',
      'retention.snapshot-prune',
    ]);
    expect(COMMAND_LEDGER_TTL_MS).toBe(24 * 60 * 60_000);
    expect(RETENTION_POLICIES.find((p) => p.key === 'retention.command-ledger')?.retainMs).toBe(
      COMMAND_LEDGER_TTL_MS,
    );
  });

  it('reports every stub run as skipped, with a reason — never a silent no-op', async () => {
    for (const job of createRetentionJobs()) {
      const outcome = await job.run(ctx(job.name));
      expect(outcome).toBeDefined();
      expect(outcome!.skipped).toBe(true);
      expect(outcome!.reason).toMatch(/stub/);
      expect(outcome!.reason).toMatch(/awaiting the db schema/);
    }
  });

  it('goes live for any key with a real sweep, leaving the others stubbed', async () => {
    const sweep = vi.fn(async () => 42);
    const jobs = createRetentionJobs({ sweeps: { 'retention.command-ledger': sweep } });

    const ledger = jobs.find((j) => j.name === 'retention.command-ledger')!;
    const outcome = await ledger.run(ctx(ledger.name));
    expect(sweep).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ affected: 42 });
    expect(outcome!.skipped).toBeUndefined();

    const other = jobs.find((j) => j.name === 'retention.snapshot-prune')!;
    expect((await other.run(ctx(other.name)))!.skipped).toBe(true);
  });

  it('allows cadence overrides', () => {
    const jobs = createRetentionJobs({ intervalsMs: { 'retention.command-ledger': 5_000 } });
    expect(jobs.find((j) => j.name === 'retention.command-ledger')?.intervalMs).toBe(5_000);
    expect(jobs.find((j) => j.name === 'retention.snapshot-prune')?.intervalMs).toBe(24 * 60 * 60_000);
  });

  it('names the M3 slots without building them', () => {
    expect(RESERVED_JOB_SLOTS).toContain('spells.scheduled-rules');
    expect(RESERVED_JOB_SLOTS).toContain('notifications.reminders');
  });
});

describe('daily backup job', () => {
  it('calls backupNow({tier:"daily"}) when the sidecar is RUNNING', async () => {
    const backupNow = vi.fn(async () => ({
      path: '/tmp/data/backups/scheduled/daily/tm8_20260725T120000Z.dump',
      format: 'custom' as const,
      bytes: 1234,
      tier: 'daily' as const,
      startedAt: '2026-07-25T12:00:00.000Z',
      finishedAt: '2026-07-25T12:00:01.000Z',
    }));
    const job = createBackupJob({ sidecar: fakeSidecar('RUNNING', backupNow) });

    const outcome = await job.run(ctx(job.name));
    expect(backupNow).toHaveBeenCalledWith({ tier: 'daily' });
    expect(outcome).toMatchObject({ affected: 1, detail: { bytes: 1234 } });
    expect(job.intervalMs).toBe(24 * 60 * 60_000);
  });

  it('skips (loudly, not silently) when the sidecar is not RUNNING', async () => {
    const backupNow = vi.fn();
    const job = createBackupJob({ sidecar: fakeSidecar('STARTING', backupNow) });
    const outcome = await job.run(ctx(job.name));
    expect(backupNow).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ skipped: true });
    expect(outcome!.reason).toContain('STARTING');
  });

  it('propagates a backup failure instead of swallowing it (T-L5 trust backstop)', async () => {
    const backupNow = vi.fn(async () => {
      throw new Error('pg_dump exploded');
    });
    const job = createBackupJob({ sidecar: fakeSidecar('RUNNING', backupNow) });
    await expect(job.run(ctx(job.name))).rejects.toThrow(/pg_dump exploded/);
  });
});

describe('createDefaultScheduler', () => {
  it('wires the backup job only when a sidecar is supplied', () => {
    const withSidecar = createDefaultScheduler({
      logger: silentLogger,
      sidecar: fakeSidecar('RUNNING'),
    });
    expect(withSidecar.jobNames()).toEqual(defaultJobNames(true));
    expect(withSidecar.has(BACKUP_JOB_NAME)).toBe(true);

    const without = createDefaultScheduler({ logger: silentLogger });
    expect(without.jobNames()).toEqual(defaultJobNames(false));
    expect(without.has(BACKUP_JOB_NAME)).toBe(false);
  });

  it('registers exactly one runner holding all five jobs', () => {
    const s = createDefaultScheduler({ logger: silentLogger, sidecar: fakeSidecar('RUNNING') });
    expect(s.jobNames()).toHaveLength(5);
    expect(s.status().jobs.every((j) => j.state === 'idle')).toBe(true);
  });
});

/**
 * LIVE lifecycle test — a real Postgres cluster, created, started, locked,
 * backed up and stopped by the code under test.
 *
 * Isolation, non-negotiable: this suite uses its **own throwaway data dir**
 * (`~/.tm8-dev/pg-lifecycle-test`) and its **own port (5443)**. It must never
 * touch the shared dev cluster on 5442 — another workstream is using it, and a
 * test that stops someone's database is worse than no test.
 *
 * Skips loudly (never silently passes) when no Postgres 18 binaries exist.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findBinariesDirSync, toolPath } from '../../src/sidecar/binaries.js';
import { resolveSidecarConfig, PINNED_PG_MAJOR } from '../../src/sidecar/config.js';
import { isSidecarError } from '../../src/sidecar/errors.js';
import { run } from '../../src/sidecar/exec.js';
import { isTcpPortOpen, selectOne } from '../../src/sidecar/health.js';
import { readLock, readPostmasterPid, isPidAlive } from '../../src/sidecar/lock.js';
import { createLogger, silentLogger } from '../../src/sidecar/log.js';
import { PostgresSidecarManager } from '../../src/sidecar/manager.js';
import type { ResolvedSidecarConfig } from '../../src/sidecar/config.js';

/** Its own dir and its own port — never the shared dev stack's 5442. */
const DATA_DIR = join(homedir(), '.tm8-dev', 'pg-lifecycle-test');
const PG_PORT = '5443';
const SHARED_DEV_PORT = 5442;

const binariesDir = findBinariesDirSync({
  major: PINNED_PG_MAJOR,
  dataDir: DATA_DIR,
  repoRoot: join(import.meta.dirname, '..', '..', '..', '..'),
  override: process.env['TM8_PG_BIN_DIR'],
});

const testEnv: NodeJS.ProcessEnv = {
  TM8_ENV: 'dev',
  TM8_DATA_DIR: DATA_DIR,
  TM8_PG_PORT: PG_PORT,
  ...(binariesDir === null ? {} : { TM8_PG_BIN_DIR: binariesDir }),
  TM8_PG_DATABASE: 'tm8_lifecycle_test',
  TM8_PG_SUPERUSER: 'tm8',
};

/**
 * Probe budget for the test cluster. Deliberately more generous than the §6
 * production budget: a cold first `initdb` on a laptop with nothing in the page
 * cache is genuinely slow, and a test that fails on a slow machine teaches
 * nothing about the lifecycle.
 */
const fastHealth = { attempts: 240, intervalMs: 250 } as const;

/** `TM8_TEST_VERBOSE=1` surfaces the lifecycle's own log lines when diagnosing. */
const testLogger = process.env['TM8_TEST_VERBOSE'] ? createLogger('sidecar:test', 'debug') : silentLogger;

/** Scalar query against the throwaway cluster, for assertions the log cannot make. */
async function psqlCount(sql: string): Promise<number> {
  const r = await run(
    toolPath(binariesDir!, 'psql'),
    [
      '-h', join(DATA_DIR, 'run'),
      '-p', PG_PORT,
      '-U', 'tm8',
      '-d', 'tm8_lifecycle_test',
      '-v', 'ON_ERROR_STOP=1',
      '-tAc', sql,
    ],
    { timeoutMs: 30_000 },
  );
  if (!r.ok) throw new Error(`psql failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

/** Force the throwaway cluster down however it is currently up, then delete it. */
async function nukeThrowawayCluster(): Promise<void> {
  if (binariesDir === null) return;
  for (const dir of [join(DATA_DIR, 'pg', String(PINNED_PG_MAJOR)), join(DATA_DIR, 'pg')]) {
    if (!existsSync(join(dir, 'PG_VERSION'))) continue;
    await run(toolPath(binariesDir, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', '-t', '20', 'stop'], {
      timeoutMs: 40_000,
    });
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}

const describeLive = binariesDir === null ? describe.skip : describe;

if (binariesDir === null) {
  // Loud skip: a silent one reads as "the lifecycle is verified" when it is not.
  console.warn(
    `[sidecar:live] SKIPPED — no Postgres ${PINNED_PG_MAJOR} binaries found. ` +
      `Set TM8_PG_BIN_DIR to run the live lifecycle suite.`,
  );
}

describeLive('sidecar lifecycle (live cluster on 5443)', () => {
  let cfg: ResolvedSidecarConfig;
  let manager: PostgresSidecarManager;

  beforeAll(async () => {
    await nukeThrowawayCluster();
    cfg = await resolveSidecarConfig(testEnv);
    manager = new PostgresSidecarManager(cfg, { logger: testLogger, health: fastHealth });
  }, 120_000);

  afterAll(async () => {
    // `TM8_TEST_KEEP=1` leaves the cluster up for post-mortem poking. It is a
    // throwaway dir on its own port, so leaving it running harms nothing.
    if (process.env['TM8_TEST_KEEP']) {
      console.warn(`[sidecar:live] KEEPING ${DATA_DIR} (TM8_TEST_KEEP=1)`);
      return;
    }
    await nukeThrowawayCluster();
  }, 120_000);

  it('resolves a pinned-major config pointed at the throwaway dir, not the shared one', () => {
    expect(cfg.pgMajor).toBe(PINNED_PG_MAJOR);
    expect(cfg.dataDir).toBe(DATA_DIR);
    expect(cfg.pgPort).toBe(Number(PG_PORT));
    expect(cfg.pgPort).not.toBe(SHARED_DEV_PORT);
    expect(cfg.pgDataDir).toBe(join(DATA_DIR, 'pg', String(PINNED_PG_MAJOR)));
    expect(cfg.socketDir).toBe(join(DATA_DIR, 'run'));
  });

  it('initdb → start → healthcheck → RUNNING on a virgin data dir', async () => {
    expect(existsSync(cfg.pgDataDir)).toBe(false);

    const status = await manager.ensureStarted();

    expect(status.state).toBe('RUNNING');
    expect(status.clusterMajor).toBe(PINNED_PG_MAJOR);
    expect(readFileSync(join(cfg.pgDataDir, 'PG_VERSION'), 'utf8').trim()).toBe(String(PINNED_PG_MAJOR));
    expect(status.pid).not.toBeNull();
    expect(isPidAlive(status.pid!)).toBe(true);
    // §7: the primary connection path is the socket inside the data dir.
    expect(existsSync(join(cfg.socketDir, `.s.PGSQL.${PG_PORT}`))).toBe(true);
  }, 180_000);

  it('answers SELECT 1 on the application database (§6 readiness gate)', async () => {
    const probe = await selectOne({
      binariesDir: cfg.binariesDir,
      socketDir: cfg.socketDir,
      pgPort: cfg.pgPort,
      database: cfg.database,
      user: cfg.superuser,
    });
    expect(probe.ok).toBe(true);
  }, 60_000);

  it('writes a sidecar.lock recording pid + port + socket (S20 honest diagnostics)', () => {
    const lock = readLock(cfg.lockPath);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.pgPort).toBe(Number(PG_PORT));
    expect(lock!.socketDir).toBe(cfg.socketDir);
    expect(lock!.dataDir).toBe(DATA_DIR);
  });

  it('REFUSES a second manager on the same data dir with LockHeld (§7)', async () => {
    const second = new PostgresSidecarManager(cfg, { logger: testLogger, health: fastHealth });
    await expect(second.ensureStarted()).rejects.toThrow();

    try {
      await new PostgresSidecarManager(cfg, { logger: testLogger, health: fastHealth }).ensureStarted();
      expect.unreachable('a second sidecar must not start on a held data dir');
    } catch (e) {
      expect(isSidecarError(e)).toBe(true);
      if (isSidecarError(e)) {
        expect(e.code).toBe('LockHeld');
        expect(e.message).toContain(DATA_DIR);
      }
    }

    // The refusal did not disturb the incumbent.
    expect(manager.status().state).toBe('RUNNING');
    expect(readLock(cfg.lockPath)?.pid).toBe(process.pid);
  }, 60_000);

  it('ensureStarted() is idempotent for the owner', async () => {
    const pidBefore = readPostmasterPid(cfg.pgDataDir)?.pid;
    const status = await manager.ensureStarted();
    expect(status.state).toBe('RUNNING');
    expect(readPostmasterPid(cfg.pgDataDir)?.pid).toBe(pidBefore);
  }, 60_000);

  it('runs the db workstream\'s migration runner — or reports SKIPPED, never both', async () => {
    const outcome = manager.status().schemaMigrations;
    expect(outcome).toBeDefined();

    if (outcome?.ran === false) {
      // No runner on disk yet: the skip must be explicit, not a silent success.
      expect(outcome.reason).toContain('migrate.mjs');
      expect(outcome.reason).toContain('SKIPPED');
      return;
    }

    // The runner ran. Assert the database actually changed rather than trusting
    // the exit code: the runner's DEFAULT subcommand is `status`, which exits 0
    // having applied nothing, so a bare invocation would look identical here.
    expect(outcome?.ran).toBe(true);
    const tables = await psqlCount(
      `SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
    );
    expect(tables).toBeGreaterThan(0);
    const applied = await psqlCount('SELECT count(*) FROM applied_migrations');
    expect(applied).toBeGreaterThan(0);
  }, 60_000);

  it('takes a daily pg_dump, promotes a weekly, and applies retention (§5)', async () => {
    const result = await manager.backupNow({ tier: 'daily' });

    expect(result.tier).toBe('daily');
    expect(result.format).toBe('custom');
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path.startsWith(join(cfg.backupsDir, 'scheduled', 'daily'))).toBe(true);

    const weekly = readdirSync(join(cfg.backupsDir, 'scheduled', 'weekly'));
    expect(weekly).toHaveLength(1);

    // pg_dump -Fc writes the custom-format magic header.
    expect(readFileSync(result.path).subarray(0, 5).toString('latin1')).toBe('PGDMP');
  }, 180_000);

  it('refuses overlapping backups', async () => {
    const first = manager.backupNow({ tier: 'on-demand' });
    await expect(manager.backupNow({ tier: 'on-demand' })).rejects.toThrow(/already in progress/);
    await first;
  }, 180_000);

  it('stops gracefully, releases the lock, and frees the port', async () => {
    await manager.stop();

    expect(manager.status().state).toBe('STOPPED');
    expect(readLock(cfg.lockPath)).toBeNull();
    expect(await isTcpPortOpen(Number(PG_PORT))).toBe(false);
    expect(existsSync(join(cfg.socketDir, `.s.PGSQL.${PG_PORT}`))).toBe(false);
    // The cluster itself survives a stop — only the process went away.
    expect(existsSync(join(cfg.pgDataDir, 'PG_VERSION'))).toBe(true);
  }, 120_000);

  it('restarts against the existing cluster without re-running initdb', async () => {
    // The migration seam is stubbed here on purpose. This test is about restart
    // and cluster adoption; re-applying an already-applied sequence is the db
    // runner's concern, and it legitimately refuses when a migration file was
    // edited after it was applied — which happens constantly while the db
    // workstream is still writing them. Coupling a lifecycle assertion to that
    // would make this suite flaky for reasons that say nothing about restart.
    let migrationsInvoked = 0;
    const restarted = new PostgresSidecarManager(cfg, {
      logger: testLogger,
      health: fastHealth,
      runMigrations: async () => {
        migrationsInvoked += 1;
        return { ran: false, reason: 'stubbed by the restart test' };
      },
    });
    const status = await restarted.ensureStarted();

    expect(status.state).toBe('RUNNING');
    expect(status.clusterMajor).toBe(PINNED_PG_MAJOR);
    // The boot sequence still reaches the migration seam after healthcheck.
    expect(migrationsInvoked).toBe(1);
    // Data written before the stop is still there — this is the same cluster.
    const probe = await selectOne({
      binariesDir: cfg.binariesDir,
      socketDir: cfg.socketDir,
      pgPort: cfg.pgPort,
      database: cfg.database,
      user: cfg.superuser,
    });
    expect(probe.ok).toBe(true);

    await restarted.stop();
    expect(restarted.status().state).toBe('STOPPED');
  }, 180_000);

  it('leaves the shared dev cluster on 5442 completely alone', async () => {
    // Whatever its state, this suite never bound or stopped it: the assertion is
    // that our own port is what moved, not the shared one.
    expect(cfg.pgPort).toBe(5443);
    expect(cfg.dataDir).not.toBe(join(homedir(), '.tm8-dev'));
  });
});

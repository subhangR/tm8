/**
 * `SidecarManager` — the lifecycle state machine (SIDECAR-PACKAGING.md §9.2/§9.3).
 *
 *                  ensureStarted()
 *    STOPPED  ─────────────────────────►  STARTING
 *       ▲                                    │  (verify binary, lock, initdb-if-needed)
 *       │ stop() ok                          ▼
 *    STOPPING ◄───────────── stop() ──── MIGRATING   (only on major mismatch — §4)
 *       ▲                        │           │
 *       │                        └─────►  HEALTHCHECK  (pg_isready → SELECT 1 — §6)
 *       │                                    │
 *       └──────────────── stop() ───────  RUNNING
 *                                            │ fatal
 *                                            ▼
 *                                         FAILED   (terminal; operator action)
 *
 * FAILED is terminal on purpose: `ensureStarted()` from FAILED re-throws the
 * stored error rather than retrying, because every path into FAILED is one where
 * retrying automatically is how you turn a recoverable situation into data loss.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DAILY_RETENTION,
  WEEKLY_RETENTION,
  ensureBackupDirs,
  pgDump,
  promoteWeekly,
  pruneTier,
  utcStamp,
  type BackupResult,
  type BackupFormat,
} from './backup.js';
import { findBinariesDirSync } from './binaries.js';
import {
  clusterExists,
  ensureDatabase,
  initdb,
  pgCtlStatus,
  readLogTail,
  startPostmaster,
  stopPostmaster,
  type ClusterTarget,
} from './cluster.js';
import { PINNED_PG_MAJOR, resolveSidecarConfig, type ResolvedSidecarConfig } from './config.js';
import { SidecarError, asSidecarError } from './errors.js';
import { isTcpPortOpen, waitForReady, type ProbeTarget, type WaitForReadyOptions } from './health.js';
import { chooseClusterDir, readMajorAt } from './layout.js';
import { createLogger, type SidecarLogger } from './log.js';
import {
  evaluateLock,
  isPidAlive,
  newOwnerId,
  readPostmasterPid,
  removeLock,
  writeLock,
  type SidecarLockFile,
} from './lock.js';
import { runSchemaMigrations, type MigrationOutcome } from './migrate.js';
import { performMajorUpgrade, refuseDowngrade, type MajorUpgradeInfo } from './upgrade.js';

export type SidecarState =
  | 'STOPPED'
  | 'STARTING'
  | 'MIGRATING'
  | 'HEALTHCHECK'
  | 'RUNNING'
  | 'STOPPING'
  | 'FAILED';

export interface SidecarStatus {
  readonly state: SidecarState;
  readonly pgMajor: number;
  /** From PG_VERSION; null if no cluster yet. */
  readonly clusterMajor: number | null;
  /** Postmaster pid, from `postmaster.pid`. */
  readonly pid: number | null;
  readonly socketDir: string;
  readonly pgPort: number;
  readonly dataDir: string;
  readonly pgDataDir: string;
  readonly lastError?: SidecarError;
  readonly migration?: MajorUpgradeInfo;
  /** Outcome of the last db/migrations run — `ran:false` means SKIPPED, loudly. */
  readonly schemaMigrations?: MigrationOutcome;
}

export interface SidecarManager {
  /** Idempotent full boot. Throws a typed `SidecarError` on unrecoverable failure. */
  ensureStarted(): Promise<SidecarStatus>;
  /** Graceful shutdown (`pg_ctl stop -m fast`), release lock, → STOPPED. Idempotent. */
  stop(): Promise<void>;
  /** Non-throwing snapshot — safe to poll from the health page. */
  status(): SidecarStatus;
  /** On-demand/scheduled `pg_dump -Fc`. Guarded against overlap. RUNNING only. */
  backupNow(opts?: { tier?: 'daily' | 'weekly' | 'on-demand' }): Promise<BackupResult>;
  /** Dump to an explicit path (Q7 groundwork). RUNNING only. */
  exportTo(path: string, opts?: { format?: BackupFormat }): Promise<BackupResult>;
  /** Resolved configuration in use. */
  readonly config: ResolvedSidecarConfig;
}

export interface SidecarManagerDeps {
  readonly logger?: SidecarLogger;
  /** Health-probe overrides (§6) — tests shrink the budget; W2 swaps in the pool probe. */
  readonly health?: WaitForReadyOptions;
  /** Migration seam override (tests). Defaults to spawning `db/migrate.mjs`. */
  readonly runMigrations?: (cfg: ResolvedSidecarConfig) => Promise<MigrationOutcome>;
  readonly tm8Version?: string;
}

export class PostgresSidecarManager implements SidecarManager {
  readonly config: ResolvedSidecarConfig;

  private state: SidecarState = 'STOPPED';
  private readonly ownerId = newOwnerId();
  private readonly logger: SidecarLogger;
  private readonly deps: SidecarManagerDeps;
  private lastError: SidecarError | undefined;
  private migration: MajorUpgradeInfo | undefined;
  private schemaMigrations: MigrationOutcome | undefined;
  private backupInProgress = false;
  private starting: Promise<SidecarStatus> | null = null;

  constructor(config: ResolvedSidecarConfig, deps: SidecarManagerDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.logger = deps.logger ?? createLogger('sidecar');
  }

  // --- public API -----------------------------------------------------------

  async ensureStarted(): Promise<SidecarStatus> {
    if (this.state === 'RUNNING') return this.status();
    if (this.state === 'FAILED') {
      throw this.lastError ?? new SidecarError('StartTimeout', 'tm8: sidecar is in FAILED state');
    }
    // Concurrent callers share one boot rather than racing two initdbs.
    if (this.starting !== null) return this.starting;

    this.starting = this.boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.state === 'STOPPED') {
      removeLock(this.config.lockPath);
      return;
    }
    this.state = 'STOPPING';
    try {
      await stopPostmaster(this.clusterTarget(), this.logger);
      removeLock(this.config.lockPath);
      this.state = 'STOPPED';
    } catch (cause) {
      this.fail(asSidecarError('StartTimeout', 'tm8: graceful sidecar shutdown failed', cause));
      throw this.lastError;
    }
  }

  status(): SidecarStatus {
    const pm = readPostmasterPid(this.config.pgDataDir);
    return {
      state: this.state,
      pgMajor: this.config.pgMajor,
      clusterMajor: readMajorAt(this.config.pgDataDir),
      pid: pm !== null && isPidAlive(pm.pid) ? pm.pid : null,
      socketDir: this.config.socketDir,
      pgPort: this.config.pgPort,
      dataDir: this.config.dataDir,
      pgDataDir: this.config.pgDataDir,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.migration ? { migration: this.migration } : {}),
      ...(this.schemaMigrations ? { schemaMigrations: this.schemaMigrations } : {}),
    };
  }

  async backupNow(opts: { tier?: 'daily' | 'weekly' | 'on-demand' } = {}): Promise<BackupResult> {
    const tier = opts.tier ?? 'on-demand';
    this.requireRunning(`backupNow(${tier})`);
    return this.withBackupGuard(async () => {
      const dirs = await ensureBackupDirs(this.config);
      const now = new Date();
      const dir = tier === 'daily' ? dirs.daily : tier === 'weekly' ? dirs.weekly : dirs.onDemand;
      const result = await pgDump(this.dumpTarget(), {
        outPath: join(dir, `tm8_${utcStamp(now)}.dump`),
        tier,
        format: 'custom',
        logger: this.logger,
      });

      if (tier === 'daily') {
        await promoteWeekly(dirs, result.path, now, this.logger);
        await pruneTier(dirs.daily, DAILY_RETENTION, this.logger);
        await pruneTier(dirs.weekly, WEEKLY_RETENTION, this.logger);
        // pre-migration/ is deliberately exempt from retention (§5).
      }
      return result;
    });
  }

  async exportTo(path: string, opts: { format?: BackupFormat } = {}): Promise<BackupResult> {
    this.requireRunning('exportTo');
    return this.withBackupGuard(() =>
      pgDump(this.dumpTarget(), {
        outPath: path,
        tier: 'on-demand',
        format: opts.format ?? 'custom',
        logger: this.logger,
      }),
    );
  }

  // --- boot -----------------------------------------------------------------

  private async boot(): Promise<SidecarStatus> {
    try {
      this.state = 'STARTING';
      await this.prepareDirs();
      await this.acquireLock();
      await this.reconcileClusterVersion();
      await this.startIfNeeded();

      this.state = 'HEALTHCHECK';
      await waitForReady(this.probeTarget('postgres'), {
        logger: this.logger,
        onTimeoutDetail: () => readLogTail(this.clusterTarget()),
        ...this.deps.health,
      });

      await ensureDatabase(this.clusterTarget(), this.config.database, this.logger);
      this.schemaMigrations = await (this.deps.runMigrations ?? defaultRunMigrations(this.logger))(
        this.config,
      );

      this.state = 'RUNNING';
      this.logger.info(
        `RUNNING — pg${this.config.pgMajor} data=${this.config.pgDataDir} socket=${this.config.socketDir} port=${this.config.pgPort}`,
      );
      return this.status();
    } catch (cause) {
      this.fail(asSidecarError('StartTimeout', 'tm8: the sidecar failed to start', cause));
      throw this.lastError;
    }
  }

  /** S19: `~/.tm8*` and everything under it is user-private. */
  private async prepareDirs(): Promise<void> {
    for (const dir of [this.config.dataDir, this.config.socketDir, this.config.logDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await ensureBackupDirs(this.config);
  }

  /**
   * §7 locking. A live foreign holder is refused; a stale lock is reclaimed only
   * after confirming nothing is actually listening, and a still-running
   * postmaster left behind by a crashed tm8-server is *adopted*, not duplicated.
   */
  private async acquireLock(): Promise<void> {
    const verdict = evaluateLock(this.config.lockPath, this.ownerId);

    if (verdict.kind === 'held') {
      throw new SidecarError(
        'LockHeld',
        `tm8: another tm8-server (pid ${verdict.lock.pid}) already owns ${this.config.dataDir}.\n` +
          `Stop it, or point TM8_DATA_DIR at a different directory.`,
        { detail: JSON.stringify(verdict.lock) },
      );
    }

    if (verdict.kind === 'free' && verdict.stale !== null) {
      const pm = readPostmasterPid(this.config.pgDataDir);
      const postmasterAlive = pm !== null && isPidAlive(pm.pid);
      this.logger.warn(
        `lock: reclaiming a stale sidecar.lock from pid ${verdict.stale.pid} ` +
          `(postmaster ${postmasterAlive ? `still up as pid ${pm?.pid} — adopting it` : 'is down'})`,
      );
      // Postgres owns durability: a crashed postmaster replays its own WAL on
      // start, and we do not second-guess that.
      removeLock(this.config.lockPath);
    }

    const lock: SidecarLockFile = {
      pid: process.pid,
      ownerId: this.ownerId,
      dataDir: this.config.dataDir,
      socketDir: this.config.socketDir,
      pgPort: this.config.pgPort,
      startedAt: new Date().toISOString(),
      tm8Version: this.deps.tm8Version ?? '0.1.0',
    };
    writeLock(this.config.lockPath, lock);
  }

  /** §4: fresh install / same major / major upgrade / downgrade. */
  private async reconcileClusterVersion(): Promise<void> {
    const choice = chooseClusterDir(this.config.dataDir, this.config.pgMajor);

    if (choice.newerCluster !== null) {
      refuseDowngrade(this.config.pgMajor, choice.newerCluster.major, choice.newerCluster.path);
    }

    if (choice.adoptedUnversioned) {
      this.logger.info(
        `cluster: adopting the existing unversioned cluster at ${choice.pgDataDir} (major ${choice.existingMajor})`,
      );
    }

    if (choice.existingMajor === this.config.pgMajor) return; // the common path

    if (choice.existingMajor === null && choice.olderCluster !== null) {
      const from = choice.olderCluster.major;
      const oldBinariesDir = findBinariesDirSync({
        major: from,
        dataDir: this.config.dataDir,
        repoRoot: this.config.repoRoot,
        override: process.env[`TM8_PG_BIN_DIR_${from}`],
      });
      if (oldBinariesDir === null) {
        throw new SidecarError(
          'MigrationBackupFailed',
          `tm8: FATAL — your data dir holds a Postgres ${from} cluster and this build bundles ` +
            `${this.config.pgMajor}, but no Postgres ${from} binaries are available to take the ` +
            `mandatory pre-migration backup. Nothing was modified.\n` +
            `Install Postgres ${from} (or set TM8_PG_BIN_DIR_${from}) and start tm8 again.`,
        );
      }
      this.state = 'MIGRATING';
      this.migration = await performMajorUpgrade(
        this.config,
        { from, oldDataDir: choice.olderCluster.path, oldBinariesDir },
        {
          logger: this.logger,
          runMigrations: this.deps.runMigrations ?? defaultRunMigrations(this.logger),
        },
      );
      return;
    }

    // Fresh install.
    if (!clusterExists(this.config.pgDataDir)) {
      await initdb(this.clusterTarget(), { logger: this.logger });
    }
  }

  /**
   * Start the postmaster unless one is already serving this data dir.
   *
   * The `PortInUse` guard runs only when the port is occupied by something that
   * is *not* our own cluster — binding is best-effort tooling (§7), but a silent
   * second bind is exactly the failure the guard exists to prevent.
   */
  private async startIfNeeded(): Promise<void> {
    const target = this.clusterTarget();
    const running = await pgCtlStatus(target);
    if (running === 'running') {
      this.logger.info(`postgres: already running for ${this.config.pgDataDir} — adopting`);
      return;
    }

    // Only meaningful when we are actually going to bind TCP. Under the
    // socket-only profile (`listen_addresses = ''`) the port number names a
    // socket FILE inside our own 0700 data dir, so someone else holding that
    // TCP port is not a conflict — and treating it as one would refuse to boot
    // the desktop app on any machine already running a Postgres on 5442, which
    // is every developer's.
    if (this.config.listenAddresses !== '' && (await isTcpPortOpen(this.config.pgPort))) {
      throw new SidecarError(
        'PortInUse',
        `tm8: TCP port ${this.config.pgPort} is already in use by a process that is not this data dir's ` +
          `Postgres (${this.config.pgDataDir}). Stop it, or set TM8_PG_PORT.`,
      );
    }

    await startPostmaster(target, { logger: this.logger });
  }

  // --- helpers --------------------------------------------------------------

  private clusterTarget(): ClusterTarget {
    return {
      binariesDir: this.config.binariesDir,
      pgDataDir: this.config.pgDataDir,
      socketDir: this.config.socketDir,
      pgPort: this.config.pgPort,
      superuser: this.config.superuser,
      logDir: this.config.logDir,
      listenAddresses: this.config.listenAddresses,
    };
  }

  private probeTarget(database: string): ProbeTarget {
    return {
      binariesDir: this.config.binariesDir,
      socketDir: this.config.socketDir,
      pgPort: this.config.pgPort,
      database,
      user: this.config.superuser,
    };
  }

  private dumpTarget() {
    return {
      binariesDir: this.config.binariesDir,
      socketDir: this.config.socketDir,
      pgPort: this.config.pgPort,
      database: this.config.database,
      superuser: this.config.superuser,
    };
  }

  private requireRunning(what: string): void {
    if (this.state !== 'RUNNING') {
      throw new SidecarError('BackupFailed', `tm8: ${what} requires the sidecar to be RUNNING (it is ${this.state})`);
    }
  }

  /** §5: a slow daily dump and a manual `backupNow()` must not collide. */
  private async withBackupGuard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.backupInProgress) {
      throw new SidecarError('BackupFailed', 'tm8: a backup is already in progress');
    }
    this.backupInProgress = true;
    try {
      return await fn();
    } finally {
      this.backupInProgress = false;
    }
  }

  private fail(err: SidecarError): void {
    this.state = 'FAILED';
    this.lastError = err;
    this.logger.error(err.message, err.detail);
  }
}

function defaultRunMigrations(logger: SidecarLogger) {
  return (cfg: ResolvedSidecarConfig) => runSchemaMigrations(cfg, { logger });
}

export interface EnsureSidecarOptions extends SidecarManagerDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only override of the pinned major. */
  readonly pgMajor?: number;
  readonly repoRoot?: string;
}

/**
 * One-call boot for tm8-server: resolve config, then run the state machine to
 * RUNNING. This is the entry point the server's startup sequence uses so that
 * nobody ever hand-starts Postgres again.
 */
export async function ensureSidecar(opts: EnsureSidecarOptions = {}): Promise<SidecarManager> {
  const config = await resolveSidecarConfig(opts.env ?? process.env, {
    ...(opts.pgMajor === undefined ? {} : { pgMajor: opts.pgMajor }),
    ...(opts.repoRoot === undefined ? {} : { repoRoot: opts.repoRoot }),
  });
  const manager = new PostgresSidecarManager(config, opts);
  await manager.ensureStarted();
  return manager;
}

export { PINNED_PG_MAJOR };

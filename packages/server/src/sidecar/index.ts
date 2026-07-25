/**
 * Bundled Postgres sidecar lifecycle (R15).
 *
 * Implements `docs/ops/SIDECAR-PACKAGING.md` — pinned major, health-check-then-
 * start, single-instance locking, backup-before-migrate, scheduled `pg_dump`,
 * graceful shutdown. Runs under **node, never bun**.
 *
 * Typical use from the server's boot sequence:
 *
 * ```ts
 * const sidecar = await ensureSidecar();          // → RUNNING or throws SidecarError
 * const scheduler = createDefaultScheduler({ sidecar });
 * scheduler.start();
 * // ... on shutdown:
 * await scheduler.stop();
 * await sidecar.stop();
 * ```
 *
 * The schema itself is NOT owned here: `runSchemaMigrations()` spawns the db
 * workstream's `db/migrate.mjs`, keeping one migration sequence for laptop and
 * hub (T-L11).
 */

export {
  PINNED_PG_MAJOR,
  DEFAULT_PG_PORT,
  resolveSidecarConfig,
  resolveSidecarPaths,
  defaultRepoRoot,
  expandHome,
  type ResolvedSidecarConfig,
  type ResolveConfigOptions,
} from './config.js';

export {
  PostgresSidecarManager,
  ensureSidecar,
  type SidecarManager,
  type SidecarManagerDeps,
  type SidecarState,
  type SidecarStatus,
  type EnsureSidecarOptions,
} from './manager.js';

export { SidecarError, isSidecarError, type SidecarErrorCode } from './errors.js';

export {
  DAILY_RETENTION,
  WEEKLY_RETENTION,
  backupDirs,
  ensureBackupDirs,
  isoWeekKey,
  promoteWeekly,
  pruneTier,
  utcStamp,
  type BackupDirs,
  type BackupFormat,
  type BackupResult,
  type BackupTier,
} from './backup.js';

export {
  REQUIRED_PG_TOOLS,
  findBinariesDirSync,
  parseMajor,
  readBinaryMajor,
  resolveBinariesDir,
  targetTriple,
  toolPath,
  type PgTool,
} from './binaries.js';

export {
  chooseClusterDir,
  discoverClusters,
  readMajorAt,
  type ClusterChoice,
  type DiscoveredCluster,
} from './layout.js';

export {
  evaluateLock,
  isPidAlive,
  readLock,
  readPostmasterPid,
  removeLock,
  writeLock,
  type LockVerdict,
  type SidecarLockFile,
} from './lock.js';

export {
  HEALTH_ATTEMPTS,
  HEALTH_INTERVAL_MS,
  isTcpPortOpen,
  pgIsReady,
  selectOne,
  waitForReady,
  type ProbeOutcome,
  type ProbeTarget,
  type ReadinessProbe,
} from './health.js';

export {
  MIGRATE_APPLY_ARGS,
  MIGRATE_RUNNER_RELPATH,
  runSchemaMigrations,
  socketConnectionUrl,
  type MigrationOutcome,
} from './migrate.js';

export {
  performMajorUpgrade,
  refuseDowngrade,
  upgradeFailureMessage,
  type MajorUpgradeInfo,
} from './upgrade.js';

export { createLogger, silentLogger, type LogLevel, type SidecarLogger } from './log.js';

export {
  clusterExists,
  ensureDatabase,
  initdb,
  pgCtlStatus,
  postmasterOptions,
  readClusterMajor,
  resolveLocalePolicy,
  startPostmaster,
  stopPostmaster,
  type ClusterTarget,
  type LocalePolicy,
} from './cluster.js';

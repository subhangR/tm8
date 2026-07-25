/**
 * Backup-before-migrate on major-version change — SIDECAR-PACKAGING.md §4.
 *
 * There is NEVER a silent `pg_upgrade`. Unattended cross-major upgrades on a
 * user's laptop are the highest-risk operation in the whole lifecycle: a partial
 * one can leave a cluster that *looks* fine and has silently dropped rows. The
 * only safe posture for a single-homed database that is the user's source of
 * truth (T-L5) is dump → fresh cluster → restore → verify, and on any doubt at
 * all: stop, and hand the operator a dump path they can trust.
 *
 * The pessimal outcome of a version mismatch is "tm8 won't start and here is
 * your backup" — never "your data is gone".
 *
 * Deviation from §4 step 3 (move the old data dir aside), deliberate: because
 * clusters are major-scoped (`pg/18/`, `pg/19/`), the new cluster is a *sibling*
 * and the old directory is never in the way. Not moving it is strictly safer
 * than moving it — the old cluster is not touched at all, and rollback is
 * "delete the new dir", which is what the failure path does.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { pgDump, type BackupResult } from './backup.js';
import {
  ensureDatabase,
  initdb,
  startPostmaster,
  stopPostmaster,
  tableRowCounts,
  type ClusterTarget,
} from './cluster.js';
import { toolPath } from './binaries.js';
import type { ResolvedSidecarConfig } from './config.js';
import { SidecarError, asSidecarError } from './errors.js';
import { describeFailure, run } from './exec.js';
import type { SidecarLogger } from './log.js';
import { utcStamp } from './backup.js';

export interface MajorUpgradeInfo {
  readonly from: number;
  readonly to: number;
  readonly backupPath: string;
  readonly verified: boolean;
}

export interface UpgradeDeps {
  readonly logger?: SidecarLogger;
  /** Applies db/migrations to the freshly created cluster (§4 step 5). */
  readonly runMigrations: (cfg: ResolvedSidecarConfig) => Promise<unknown>;
}

/** §4 downgrade branch — refuse before touching anything on disk. */
export function refuseDowngrade(bundled: number, cluster: number, pgDataDir: string): never {
  throw new SidecarError(
    'MajorDowngrade',
    `tm8: FATAL — this tm8 build bundles Postgres ${bundled} but your data dir was created by\n` +
      `Postgres ${cluster} (${pgDataDir}). tm8 will not start and will NOT touch your data.\n` +
      `Install a tm8 build with Postgres ${cluster} or newer to open this workspace.`,
  );
}

/** The exact operator-facing text §4 specifies for a failed major upgrade. */
export function upgradeFailureMessage(from: number, to: number, backupPath: string, database: string): string {
  return (
    `tm8: FATAL — Postgres major upgrade ${from} -> ${to} failed and tm8 will not start.\n` +
    `Your data was NOT modified. A complete pre-migration backup was written to:\n` +
    `  ${backupPath}\n` +
    `Restore it into a matching tm8 build (Postgres ${from}) with:\n` +
    `  pg_restore --clean --if-exists -d ${database} ${backupPath}\n` +
    `Nothing was upgraded. Report this with the log above to the tm8 team.`
  );
}

function targetFor(cfg: ResolvedSidecarConfig, pgDataDir: string): ClusterTarget {
  return {
    binariesDir: cfg.binariesDir,
    pgDataDir,
    socketDir: cfg.socketDir,
    pgPort: cfg.pgPort,
    superuser: cfg.superuser,
    logDir: cfg.logDir,
  };
}

/**
 * Run the §4 major-upgrade machine.
 *
 * @param oldDataDir the existing cluster (major `from`)
 * @param oldBinariesDir binaries able to *read* the old cluster. The bundled
 *        (new-major) `pg_dump` can dump an older server, but the old server
 *        itself must be started by binaries of its own major — so an upgrade is
 *        only attempted when the old major's binaries are locatable.
 * @throws SidecarError `MigrationBackupFailed` / `MigrationRestoreFailed`, both
 *         carrying `backupPath` once a dump exists.
 */
export async function performMajorUpgrade(
  cfg: ResolvedSidecarConfig,
  args: {
    readonly from: number;
    readonly oldDataDir: string;
    readonly oldBinariesDir: string;
  },
  deps: UpgradeDeps,
): Promise<MajorUpgradeInfo> {
  const { logger } = deps;
  const to = cfg.pgMajor;
  const stamp = utcStamp();
  const backupPath = join(
    cfg.backupsDir,
    'pre-migration',
    `premigrate_${args.from}-${to}_${stamp}.dump`,
  );

  const oldTarget: ClusterTarget = {
    ...targetFor(cfg, args.oldDataDir),
    binariesDir: args.oldBinariesDir,
  };
  const newTarget = targetFor(cfg, cfg.pgDataDir);

  logger?.warn(`upgrade: Postgres major ${args.from} -> ${to}; taking a pre-migration dump first`);

  // --- 1. dump the old cluster (failure here => nothing was touched) ---------
  let manifest: Record<string, number> = {};
  let dump: BackupResult;
  try {
    await startPostmaster(oldTarget, { logger });
    manifest = await tableRowCounts(oldTarget, cfg.database);
    dump = await pgDump(
      {
        binariesDir: args.oldBinariesDir,
        socketDir: cfg.socketDir,
        pgPort: cfg.pgPort,
        database: cfg.database,
        superuser: cfg.superuser,
      },
      { outPath: backupPath, tier: 'pre-migration', format: 'custom', ...(logger ? { logger } : {}) },
    );
  } catch (cause) {
    await stopPostmaster(oldTarget, logger).catch(() => {});
    throw asSidecarError(
      'MigrationBackupFailed',
      `tm8: FATAL — the pre-migration backup for the Postgres ${args.from} -> ${to} upgrade failed.\n` +
        `Your data was NOT modified and nothing was upgraded.`,
      cause,
    );
  }

  // --- 2. stop the old cluster ----------------------------------------------
  await stopPostmaster(oldTarget, logger);

  // --- 3..7. build the new cluster; ANY failure removes only the NEW dir -----
  try {
    await initdb(newTarget, { ...(logger ? { logger } : {}) });
    await startPostmaster(newTarget, { logger });
    await ensureDatabase(newTarget, cfg.database, logger);
    await deps.runMigrations(cfg);

    const restore = await run(
      toolPath(cfg.binariesDir, 'pg_restore'),
      [
        '-h', cfg.socketDir,
        '-p', String(cfg.pgPort),
        '-U', cfg.superuser,
        '-d', cfg.database,
        '--data-only',
        '--exit-on-error',
        '--single-transaction',
        dump.path,
      ],
      { timeoutMs: 60 * 60_000 },
    );
    if (!restore.ok) {
      throw new SidecarError('MigrationRestoreFailed', 'pg_restore failed', {
        detail: describeFailure(restore),
        backupPath,
      });
    }

    // --- 7. verify: exact row counts must match the pre-dump manifest --------
    const after = await tableRowCounts(newTarget, cfg.database);
    const mismatches = Object.entries(manifest)
      .filter(([table, n]) => after[table] !== n)
      .map(([table, n]) => `${table}: expected ${n}, got ${after[table] ?? 'missing'}`);
    if (mismatches.length > 0) {
      throw new SidecarError('MigrationRestoreFailed', 'row-count verification failed after restore', {
        detail: mismatches.join('\n'),
        backupPath,
      });
    }

    logger?.info(
      `upgrade: ${args.from} -> ${to} complete and verified (${Object.keys(manifest).length} tables); ` +
        `pre-migration dump retained at ${backupPath}`,
    );
    return { from: args.from, to, backupPath, verified: true };
  } catch (cause) {
    // Leave the NEW dir removed; the OLD data dir was never modified.
    await stopPostmaster(newTarget, logger).catch(() => {});
    await rm(cfg.pgDataDir, { recursive: true, force: true }).catch(() => {});
    const detail = cause instanceof Error ? (cause as SidecarError).detail ?? cause.message : String(cause);
    throw new SidecarError(
      'MigrationRestoreFailed',
      upgradeFailureMessage(args.from, to, backupPath, cfg.database),
      { backupPath, detail, cause },
    );
  }
}

/**
 * Backups — SIDECAR-PACKAGING.md §5.
 *
 * `pg_dump -Fc` (custom format) is the artifact: compressed, and restorable
 * selectively/in parallel/reordered through `pg_restore`, which a plain `.sql`
 * dump cannot do. These dumps are both the disaster-recovery artifact for §4 and
 * the substrate for the Phase-2 space export, so restore flexibility beats
 * human-readability. `exportTo()` may opt into `-Fp` explicitly.
 *
 * Layout:
 *   <dataDir>/backups/scheduled/daily/tm8_<stamp>.dump      keep newest 7
 *   <dataDir>/backups/scheduled/weekly/tm8_<stamp>.dump     keep newest 4
 *   <dataDir>/backups/pre-migration/premigrate_<f>-<t>_<stamp>.dump   NEVER pruned
 *   <dataDir>/backups/on-demand/<name>.dump
 *
 * Retention never drops a file without a log line (the no-silent-truncation
 * rule): a backup that vanished quietly is indistinguishable from one that was
 * never taken.
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { toolPath } from './binaries.js';
import type { ResolvedSidecarConfig } from './config.js';
import { SidecarError } from './errors.js';
import { describeFailure, run } from './exec.js';
import type { SidecarLogger } from './log.js';

export type BackupTier = 'daily' | 'weekly' | 'pre-migration' | 'on-demand';
export type BackupFormat = 'custom' | 'plain';

export interface BackupResult {
  /** Absolute .dump path. */
  readonly path: string;
  readonly format: BackupFormat;
  readonly bytes: number;
  readonly tier: BackupTier;
  /** ISO-8601 UTC. */
  readonly startedAt: string;
  readonly finishedAt: string;
}

export const DAILY_RETENTION = 7;
export const WEEKLY_RETENTION = 4;

/** `20260725T140322Z` — sorts lexically in chronological order. */
export function utcStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** `2026-W30` — the key that decides whether this week already has a weekly. */
export function isoWeekKey(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO: week belongs to the year of its Thursday.
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface BackupDirs {
  readonly root: string;
  readonly daily: string;
  readonly weekly: string;
  readonly preMigration: string;
  readonly onDemand: string;
}

export function backupDirs(cfg: Pick<ResolvedSidecarConfig, 'backupsDir'>): BackupDirs {
  return {
    root: cfg.backupsDir,
    daily: join(cfg.backupsDir, 'scheduled', 'daily'),
    weekly: join(cfg.backupsDir, 'scheduled', 'weekly'),
    preMigration: join(cfg.backupsDir, 'pre-migration'),
    onDemand: join(cfg.backupsDir, 'on-demand'),
  };
}

export async function ensureBackupDirs(cfg: Pick<ResolvedSidecarConfig, 'backupsDir'>): Promise<BackupDirs> {
  const dirs = backupDirs(cfg);
  for (const d of [dirs.daily, dirs.weekly, dirs.preMigration, dirs.onDemand]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export interface DumpTarget {
  readonly binariesDir: string;
  readonly socketDir: string;
  readonly pgPort: number;
  readonly database: string;
  readonly superuser: string;
}

export interface DumpOptions {
  readonly outPath: string;
  readonly format?: BackupFormat;
  readonly tier: BackupTier;
  readonly timeoutMs?: number;
  readonly logger?: SidecarLogger;
}

/**
 * One `pg_dump` invocation.
 *
 * `pg_dump` takes a consistent snapshot and does not lock out writers, so a slow
 * dump does not stall the server — overlap between a scheduled and a manual dump
 * is guarded in the manager, not by blocking.
 *
 * @throws SidecarError `BackupFailed`, or `MigrationBackupFailed` for the §4 tier.
 */
export async function pgDump(t: DumpTarget, opts: DumpOptions): Promise<BackupResult> {
  const format = opts.format ?? 'custom';
  const startedAt = new Date().toISOString();
  await mkdir(dirname(opts.outPath), { recursive: true, mode: 0o700 });

  const r = await run(
    toolPath(t.binariesDir, 'pg_dump'),
    [
      '-h', t.socketDir,
      '-p', String(t.pgPort),
      '-U', t.superuser,
      '-d', t.database,
      format === 'custom' ? '-Fc' : '-Fp',
      '-f', opts.outPath,
    ],
    { timeoutMs: opts.timeoutMs ?? 30 * 60_000 },
  );

  if (!r.ok) {
    // A failed dump may leave a truncated file; remove it so nothing mistakes it
    // for a usable artifact.
    await rm(opts.outPath, { force: true }).catch(() => {});
    const code = opts.tier === 'pre-migration' ? 'MigrationBackupFailed' : 'BackupFailed';
    throw new SidecarError(code, `tm8: pg_dump (${opts.tier}) failed`, { detail: describeFailure(r) });
  }

  const bytes = (await stat(opts.outPath)).size;
  const result: BackupResult = {
    path: opts.outPath,
    format,
    bytes,
    tier: opts.tier,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  opts.logger?.info(`backup: ${opts.tier} → ${opts.outPath} (${bytes} bytes)`);
  return result;
}

/**
 * Prune a tier directory to the newest `keep` dumps, logging every removal.
 * @returns the paths that were removed
 */
export async function pruneTier(dir: string, keep: number, logger?: SidecarLogger): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  // Names embed a lexically-sortable UTC stamp, so name order == time order.
  const dumps = names.filter((n) => n.endsWith('.dump')).sort();
  if (dumps.length <= keep) return [];

  const doomed = dumps.slice(0, dumps.length - keep);
  const removed: string[] = [];
  for (const name of doomed) {
    const path = join(dir, name);
    try {
      await rm(path, { force: true });
      removed.push(path);
      logger?.info(`backup: pruned ${path} (retention keep=${keep})`);
    } catch (e) {
      logger?.warn(`backup: failed to prune ${path}`, e);
    }
  }
  return removed;
}

/**
 * Promote the day's dump to the weekly tier when this ISO week has none yet.
 * @returns the weekly path when a promotion happened
 */
export async function promoteWeekly(
  dirs: BackupDirs,
  dailyPath: string,
  now: Date,
  logger?: SidecarLogger,
): Promise<string | null> {
  const key = isoWeekKey(now);
  let existing: string[] = [];
  try {
    existing = await readdir(dirs.weekly);
  } catch {
    existing = [];
  }
  if (existing.some((n) => n.includes(key))) return null;

  const target = join(dirs.weekly, `tm8_${key}_${utcStamp(now)}.dump`);
  await copyFile(dailyPath, target);
  logger?.info(`backup: promoted ${dailyPath} → ${target} (first daily of ${key})`);
  return target;
}

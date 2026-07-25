/**
 * Single-instance locking + crash reclaim — SIDECAR-PACKAGING.md §7, S20.
 *
 * Three layers of defence against the one unrecoverable mistake (two
 * postmasters, one data dir):
 *
 *   1. the Unix socket lives *inside* the data dir, so two clusters have no
 *      shared endpoint to collide on (enforced in manager.ts, not here);
 *   2. this advisory `sidecar.lock` — pid + port + socket, so `doctor` can say
 *      honestly who holds the dir (S20);
 *   3. Postgres's own `postmaster.pid`, which we read but never delete by hand.
 *
 * The lock records an `ownerId` as well as a pid: a pid alone cannot distinguish
 * "this very manager already started it" from "another manager in this process
 * holds it", and the second case must still be refused.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface SidecarLockFile {
  /** pid of the tm8-server process that started the sidecar. */
  readonly pid: number;
  /** Per-manager identity; distinguishes two managers inside one process. */
  readonly ownerId: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly pgPort: number;
  /** ISO-8601 UTC. */
  readonly startedAt: string;
  readonly tm8Version: string;
}

export function newOwnerId(): string {
  return randomUUID();
}

/** Reads the lock; a missing, truncated or malformed file reads as "no lock". */
export function readLock(lockPath: string): SidecarLockFile | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<SidecarLockFile>;
    if (typeof parsed.pid !== 'number' || typeof parsed.ownerId !== 'string') return null;
    return parsed as SidecarLockFile;
  } catch {
    return null;
  }
}

export function writeLock(lockPath: string, lock: SidecarLockFile): void {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
}

export function removeLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* best effort — a lock we cannot remove is reported by the next start */
  }
}

/** Signal-0 liveness probe. EPERM means alive but owned by another user. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PostmasterPid {
  readonly pid: number;
  readonly dataDir: string;
  /** Unix epoch seconds, as Postgres writes it. */
  readonly startedAtEpoch: number | null;
  readonly port: number | null;
  readonly socketDir: string | null;
}

/**
 * Parse `<pgDataDir>/postmaster.pid`. Postgres's own guard; line order is fixed
 * (pid, data dir, start time, port, socket dir, listen address, shmem key).
 */
export function readPostmasterPid(pgDataDir: string): PostmasterPid | null {
  const path = `${pgDataDir}/postmaster.pid`;
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    const pid = Number(lines[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = Number(lines[3]);
    return {
      pid,
      dataDir: lines[1]?.trim() ?? pgDataDir,
      startedAtEpoch: Number.isInteger(Number(lines[2])) ? Number(lines[2]) : null,
      port: Number.isInteger(port) ? port : null,
      socketDir: lines[4]?.trim() || null,
    };
  } catch {
    return null;
  }
}

export type LockVerdict =
  /** No lock, or a lock whose owner process is gone. Safe to take. */
  | { readonly kind: 'free'; readonly stale: SidecarLockFile | null }
  /** This manager already holds it — `ensureStarted()` is idempotent. */
  | { readonly kind: 'ours'; readonly lock: SidecarLockFile }
  /** A live, foreign holder. Refuse with `LockHeld`. */
  | { readonly kind: 'held'; readonly lock: SidecarLockFile };

/**
 * Classify the current lock for `ownerId`.
 *
 * A live pid that is *not* ours is treated as held even if the pid might have
 * been reused by an unrelated program — the caller confirms nothing is actually
 * listening before reclaiming, per §7's "log loudly, reclaim only after
 * confirming" rule.
 */
export function evaluateLock(lockPath: string, ownerId: string): LockVerdict {
  const lock = readLock(lockPath);
  if (lock === null) return { kind: 'free', stale: null };
  if (lock.ownerId === ownerId) return { kind: 'ours', lock };
  if (!isPidAlive(lock.pid)) return { kind: 'free', stale: lock };
  return { kind: 'held', lock };
}

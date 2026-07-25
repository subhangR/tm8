/**
 * Single-instance locking — SIDECAR-PACKAGING.md §7, S20.
 *
 * Two postmasters on one data dir is the one unrecoverable mistake in this
 * system, so the lock's classification is asserted for every case: free, ours,
 * live-and-foreign, and stale-after-crash.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  evaluateLock,
  isPidAlive,
  newOwnerId,
  readLock,
  readPostmasterPid,
  removeLock,
  writeLock,
  type SidecarLockFile,
} from '../../src/sidecar/lock.js';

const scratch: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tm8-lock-'));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function lockFor(ownerId: string, pid = process.pid): SidecarLockFile {
  return {
    pid,
    ownerId,
    dataDir: '/tmp/tm8-test',
    socketDir: '/tmp/tm8-test/run',
    pgPort: 5443,
    startedAt: new Date().toISOString(),
    tm8Version: '0.1.0-test',
  };
}

/** A pid that is essentially certain to be dead: above the typical pid_max. */
const DEAD_PID = 4_194_300;

describe('lock file', () => {
  it('round-trips and reads absent/garbage files as "no lock"', () => {
    const dir = tempDir();
    const path = join(dir, 'sidecar.lock');

    expect(readLock(path)).toBeNull();

    const lock = lockFor(newOwnerId());
    writeLock(path, lock);
    expect(readLock(path)).toEqual(lock);

    writeFileSync(path, 'not json at all');
    expect(readLock(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ pid: 'x' }));
    expect(readLock(path)).toBeNull();

    removeLock(path);
    expect(readLock(path)).toBeNull();
  });

  it('detects liveness by pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe('evaluateLock', () => {
  it('is free when there is no lock', () => {
    const path = join(tempDir(), 'sidecar.lock');
    expect(evaluateLock(path, newOwnerId())).toEqual({ kind: 'free', stale: null });
  });

  it('is "ours" for the same owner — ensureStarted() must stay idempotent', () => {
    const path = join(tempDir(), 'sidecar.lock');
    const owner = newOwnerId();
    writeLock(path, lockFor(owner));
    expect(evaluateLock(path, owner).kind).toBe('ours');
  });

  it('is "held" for a live process with a different owner, even in-process', () => {
    const path = join(tempDir(), 'sidecar.lock');
    // Same pid (this process), different manager: still a refusal. A pid alone
    // cannot distinguish "I already started it" from "another manager holds it".
    writeLock(path, lockFor(newOwnerId(), process.pid));
    const verdict = evaluateLock(path, newOwnerId());
    expect(verdict.kind).toBe('held');
  });

  it('is "free" with the stale lock attached when the holder is gone (crash reclaim)', () => {
    const path = join(tempDir(), 'sidecar.lock');
    const dead = lockFor(newOwnerId(), DEAD_PID);
    writeLock(path, dead);
    const verdict = evaluateLock(path, newOwnerId());
    expect(verdict.kind).toBe('free');
    if (verdict.kind === 'free') expect(verdict.stale?.pid).toBe(DEAD_PID);
  });
});

describe('postmaster.pid', () => {
  it('parses the fixed line order Postgres writes', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'postmaster.pid'),
      ['12345', dir, '1769000000', '5443', '/tmp/tm8/run', '127.0.0.1', '  1234567 890'].join('\n'),
    );
    const pm = readPostmasterPid(dir);
    expect(pm?.pid).toBe(12345);
    expect(pm?.port).toBe(5443);
    expect(pm?.socketDir).toBe('/tmp/tm8/run');
  });

  it('returns null when absent or malformed', () => {
    const dir = tempDir();
    expect(readPostmasterPid(dir)).toBeNull();
    writeFileSync(join(dir, 'postmaster.pid'), 'garbage\n');
    expect(readPostmasterPid(dir)).toBeNull();
  });
});

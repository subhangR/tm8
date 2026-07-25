/**
 * Config + layout resolution — SIDECAR-PACKAGING.md §9.1, §7.
 *
 * These are the values every other decision is made from, so they are asserted
 * exactly: a wrong data dir is how dev and prod end up sharing a cluster.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { PINNED_PG_MAJOR, resolveSidecarPaths, expandHome } from '../../src/sidecar/config.js';
import { chooseClusterDir, discoverClusters, readMajorAt } from '../../src/sidecar/layout.js';

const scratch: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-sidecar-'));
  scratch.push(dir);
  return dir;
}
function makeCluster(dir: string, major: number): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), `${major}\n`);
  return dir;
}

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('resolveSidecarPaths', () => {
  it('defaults dev to ~/.tm8-dev and prod to ~/.tm8 (docs/ops/CONFIG.md §2)', () => {
    expect(resolveSidecarPaths({}).dataDir).toBe(join(homedir(), '.tm8-dev'));
    expect(resolveSidecarPaths({ TM8_ENV: 'dev' }).dataDir).toBe(join(homedir(), '.tm8-dev'));
    expect(resolveSidecarPaths({ TM8_ENV: 'prod' }).dataDir).toBe(join(homedir(), '.tm8'));
  });

  it('derives every path from the data dir, so dev and prod cannot share state', () => {
    const dataDir = tempDataDir();
    const cfg = resolveSidecarPaths({ TM8_DATA_DIR: dataDir });

    expect(cfg.pgDataDir).toBe(join(dataDir, 'pg', String(PINNED_PG_MAJOR)));
    expect(cfg.socketDir).toBe(join(dataDir, 'run'));
    expect(cfg.backupsDir).toBe(join(dataDir, 'backups'));
    expect(cfg.logDir).toBe(join(dataDir, 'log'));
    expect(cfg.lockPath).toBe(join(dataDir, 'sidecar.lock'));
  });

  it('defaults the sidecar port to 5442 and rejects garbage', () => {
    expect(resolveSidecarPaths({}).pgPort).toBe(5442);
    expect(resolveSidecarPaths({ TM8_PG_PORT: '5443' }).pgPort).toBe(5443);
    expect(() => resolveSidecarPaths({ TM8_PG_PORT: 'nope' })).toThrow(/integer port/);
    expect(() => resolveSidecarPaths({ TM8_PG_PORT: '0' })).toThrow(/integer port/);
  });

  it('pins the major at 18 and names role/database defaults', () => {
    const cfg = resolveSidecarPaths({ TM8_DATA_DIR: tempDataDir() });
    expect(cfg.pgMajor).toBe(18);
    expect(PINNED_PG_MAJOR).toBe(18);
    expect(cfg.database).toBe('tm8');
    expect(cfg.superuser).toBe('tm8');
    expect(cfg.appRole).toBe('tm8_app');
  });

  it('expands ~ the same way scripts/lib/env.mjs does', () => {
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('/abs')).toBe('/abs');
  });
});

describe('cluster discovery (§4 branch selection)', () => {
  it('reports no cluster for an empty data dir', () => {
    const dataDir = tempDataDir();
    expect(discoverClusters(dataDir)).toEqual([]);
    const choice = chooseClusterDir(dataDir, 18);
    expect(choice.existingMajor).toBeNull();
    expect(choice.newerCluster).toBeNull();
    expect(choice.olderCluster).toBeNull();
  });

  it('finds a major-scoped cluster and treats it as the in-place path', () => {
    const dataDir = tempDataDir();
    makeCluster(join(dataDir, 'pg', '18'), 18);
    const choice = chooseClusterDir(dataDir, 18);
    expect(choice.existingMajor).toBe(18);
    expect(choice.pgDataDir).toBe(join(dataDir, 'pg', '18'));
    expect(choice.adoptedUnversioned).toBe(false);
  });

  it('adopts an unversioned cluster of the pinned major rather than stranding it', () => {
    const dataDir = tempDataDir();
    makeCluster(join(dataDir, 'pg'), 18);
    const choice = chooseClusterDir(dataDir, 18);
    expect(choice.adoptedUnversioned).toBe(true);
    expect(choice.pgDataDir).toBe(join(dataDir, 'pg'));
    expect(choice.existingMajor).toBe(18);
  });

  it('flags an older cluster as the upgrade source', () => {
    const dataDir = tempDataDir();
    makeCluster(join(dataDir, 'pg', '17'), 17);
    const choice = chooseClusterDir(dataDir, 18);
    expect(choice.existingMajor).toBeNull();
    expect(choice.olderCluster?.major).toBe(17);
    expect(choice.newerCluster).toBeNull();
  });

  it('flags a newer cluster as the downgrade situation', () => {
    const dataDir = tempDataDir();
    makeCluster(join(dataDir, 'pg', '19'), 19);
    const choice = chooseClusterDir(dataDir, 18);
    expect(choice.newerCluster?.major).toBe(19);
  });

  it('reads PG_VERSION, tolerating minor-qualified values and absence', () => {
    const dataDir = tempDataDir();
    expect(readMajorAt(dataDir)).toBeNull();
    writeFileSync(join(dataDir, 'PG_VERSION'), '18.4\n');
    expect(readMajorAt(dataDir)).toBe(18);
  });
});

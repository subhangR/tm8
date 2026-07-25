/**
 * Data-dir layout and cluster discovery — SIDECAR-PACKAGING.md §5, §7.
 *
 *   <dataDir>/pg/<major>/     the live cluster, major-scoped (§5 path layout)
 *   <dataDir>/run/            unix_socket_directories (§7)
 *   <dataDir>/backups/…       §5
 *   <dataDir>/log/            postmaster log
 *   <dataDir>/sidecar.lock    §7 advisory lock
 *
 * Major-scoping is what makes the §4 upgrade non-destructive: a new major
 * `initdb`s a *sibling* directory, so the old cluster is never overwritten and
 * "leave the old data dir untouched" is the structural default, not a careful
 * sequence of moves.
 *
 * One accommodation: a cluster created directly at `<dataDir>/pg/` (the
 * unversioned layout a hand-run `initdb` produces) is **adopted in place** when
 * its major matches the pin, rather than ignored. Ignoring it would silently
 * strand real data next to a brand-new empty cluster — the most confusing
 * possible failure.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Parse `<dir>/PG_VERSION`. `null` when the directory is not a cluster. */
export function readMajorAt(dir: string): number | null {
  const path = join(dir, 'PG_VERSION');
  if (!existsSync(path)) return null;
  try {
    const major = Number(readFileSync(path, 'utf8').trim().split('.')[0]);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
}

export interface DiscoveredCluster {
  readonly major: number;
  readonly path: string;
  /** True for the unversioned `<dataDir>/pg/` layout. */
  readonly unversioned: boolean;
}

/** Every cluster under `<dataDir>/pg`, newest major last. */
export function discoverClusters(dataDir: string): DiscoveredCluster[] {
  const pgRoot = join(dataDir, 'pg');
  const found: DiscoveredCluster[] = [];

  const unversionedMajor = readMajorAt(pgRoot);
  if (unversionedMajor !== null) {
    found.push({ major: unversionedMajor, path: pgRoot, unversioned: true });
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(pgRoot);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const path = join(pgRoot, name);
    const major = readMajorAt(path);
    if (major !== null) found.push({ major, path, unversioned: false });
  }

  return found.sort((a, b) => a.major - b.major);
}

export interface ClusterChoice {
  /** The directory the lifecycle will use for the pinned major. */
  readonly pgDataDir: string;
  /** Existing cluster at that path, if any. */
  readonly existingMajor: number | null;
  /** True when an unversioned `<dataDir>/pg/` cluster was adopted. */
  readonly adoptedUnversioned: boolean;
  /** Any cluster with a major greater than the pin — a downgrade situation (§4). */
  readonly newerCluster: DiscoveredCluster | null;
  /** The newest cluster older than the pin — the upgrade source (§4). */
  readonly olderCluster: DiscoveredCluster | null;
}

/** Decide which directory the pinned major should use, and what else is present. */
export function chooseClusterDir(dataDir: string, pinnedMajor: number): ClusterChoice {
  const clusters = discoverClusters(dataDir);
  const versionedPath = join(dataDir, 'pg', String(pinnedMajor));

  const atVersioned = clusters.find((c) => !c.unversioned && c.path === versionedPath) ?? null;
  const unversioned = clusters.find((c) => c.unversioned) ?? null;

  const newer = [...clusters].reverse().find((c) => c.major > pinnedMajor) ?? null;
  const older =
    [...clusters].reverse().find((c) => c.major < pinnedMajor && !c.unversioned) ??
    (unversioned !== null && unversioned.major < pinnedMajor ? unversioned : null);

  if (atVersioned !== null) {
    return {
      pgDataDir: versionedPath,
      existingMajor: atVersioned.major,
      adoptedUnversioned: false,
      newerCluster: newer,
      olderCluster: older,
    };
  }

  if (unversioned !== null && unversioned.major === pinnedMajor) {
    return {
      pgDataDir: unversioned.path,
      existingMajor: unversioned.major,
      adoptedUnversioned: true,
      newerCluster: newer,
      olderCluster: older,
    };
  }

  return {
    pgDataDir: versionedPath,
    existingMajor: null,
    adoptedUnversioned: false,
    newerCluster: newer,
    olderCluster: older,
  };
}

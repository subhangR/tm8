/**
 * The port behind Settings → Filesystem access (migration 282, design doc
 * 01a0fb62 §4.3). A node admin grants one member one folder root to browse and
 * pick projects from; everyone else reads their own grants.
 */
import type {
  NodeAccountListView,
  PathGrantListView,
  PathGrantView,
  ProjectDirectoryListing,
} from '@tm8/contract';

import type { Seam } from '../data/seam';

export interface FilesystemAccessPort {
  viewer(): Promise<{ isNodeAdmin: boolean }>;
  /** Node admin: every grant on the node. */
  list(includeRevoked: boolean): Promise<PathGrantListView>;
  /** Node admin: who a grant can be addressed to. */
  accounts(): Promise<NodeAccountListView>;
  create(accountId: string, rootPath: string, note?: string): Promise<PathGrantView>;
  revoke(grantId: string): Promise<PathGrantView>;
  /** The viewer's own live grants. */
  mine(): Promise<PathGrantListView>;
  /** The admin's own folder browser, for picking the root to grant. Absent off-node. */
  browse?(path?: string): Promise<ProjectDirectoryListing>;
}

/** `null` when the seam has no node behind it (fixtures without `pathGrants`). */
export function filesystemAccessPortFromSeam(
  seam: Pick<Seam, 'pathGrants' | 'projectSetup' | 'identity'>,
): FilesystemAccessPort | null {
  const grants = seam.pathGrants;
  if (!grants) return null;
  const setup = seam.projectSetup;
  return {
    viewer: async () => ({ isNodeAdmin: (await seam.identity()).isNodeAdmin === true }),
    list: (includeRevoked) => grants.list(includeRevoked),
    accounts: () => grants.accounts(),
    create: (accountId, rootPath, note) => grants.create(accountId, rootPath, note),
    revoke: (grantId) => grants.revoke(grantId),
    mine: () => grants.mine(),
    ...(setup ? { browse: (path?: string) => setup.directories(path) } : {}),
  };
}

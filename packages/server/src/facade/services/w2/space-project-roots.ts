import { delimiter } from 'node:path';

import { CollabError } from '@tm8/contract';

import type { Db, DbClaims } from '../../../db/types.js';
import { canonicalRoots } from './project-directories.js';

/**
 * `TM8_PROJECT_ROOTS` exactly as the operator wrote it, or null when unset.
 *
 * Distinct from `canonicalRoots()`, whose unset default is the filesystem root:
 * that default is right for a node admin browsing their own machine and wrong
 * for a space admin, who would otherwise register `/` and hand every member of
 * the space a file listing of the whole node.
 */
export function explicitProjectRoots(raw = process.env.TM8_PROJECT_ROOTS): string[] | null {
  const roots = raw?.split(delimiter).map((value) => value.trim()).filter(Boolean) ?? [];
  return roots.length > 0 ? roots : null;
}

export const PROJECT_ROOTS_UNSET =
  'this node does not set TM8_PROJECT_ROOTS, so only a node admin can add a project folder; ask a node admin to set it or to add the project';

/** `internal.is_space_admin` under the caller's claims (pin-aware since 227/232). */
export async function isSpaceAdmin(db: Db, claims: DbClaims, spaceId: string): Promise<boolean> {
  const rows = await db.query<{ admin: boolean }>(
    claims,
    'select internal.is_space_admin($1::uuid) as admin',
    [spaceId],
  );
  return rows[0]?.admin === true;
}

/**
 * The canonical roots inside which THIS caller may put a folder behind one of
 * `spaceId`'s projects (task 01a13574, migration 326).
 *
 * Asked BEFORE anything touches the filesystem, so a member who is not a space
 * admin can neither create a directory nor learn which paths exist:
 *   - not an admin of the space: refused;
 *   - a node admin (unpinned — `claimsFor` already drops the flag for a pinned
 *     session): every `TM8_PROJECT_ROOTS` entry, or the filesystem root when
 *     unset, exactly as `projects.create` has always allowed;
 *   - any other space admin: `TM8_PROJECT_ROOTS` only when the node sets it.
 */
export async function spaceProjectRoots(db: Db, claims: DbClaims, spaceId: string): Promise<string[]> {
  if (!(await isSpaceAdmin(db, claims, spaceId))) {
    // Lane D B1: the refusal names who can unblock the caller.
    throw new CollabError('forbidden', 'only a space admin can add a project to this space; ask a space admin (or a node admin) to add it, or to make you an admin', {
      details: { reason: 'space_admin_required' },
    });
  }
  if (claims.nodeAdmin === true) return canonicalRoots();
  const explicit = explicitProjectRoots();
  if (!explicit) {
    throw new CollabError('forbidden', PROJECT_ROOTS_UNSET, { details: { reason: 'project_roots_unset' } });
  }
  return canonicalRoots(explicit);
}

/**
 * Trust is the gate's (migration 326 refuses it too). Asked up front so a space
 * admin's `trusted` is refused before a directory is created or a byte lands,
 * not after.
 */
export function requireTrustAllowed(claims: DbClaims, trust: string | undefined): void {
  if (trust === 'trusted' && claims.nodeAdmin !== true) {
    throw new CollabError(
      'forbidden',
      'only a node admin can trust a folder; add it untrusted and ask a node admin to trust it',
      { details: { reason: 'trust_requires_node_admin' } },
    );
  }
}

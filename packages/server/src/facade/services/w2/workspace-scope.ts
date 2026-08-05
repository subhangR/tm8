import { chmod, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { CollabError } from '@tm8/contract';

import type { Db, DbClaims } from '../../../db/types.js';
import { canonicalRoots, containedBy } from './project-directories.js';

/** A private workspace is one account's, and the OS is not what enforces that. */
const WORKSPACE_MODE = 0o700;

/**
 * WHO MAY BROWSE WHAT, and why this replaced a node-admin gate.
 *
 * The node-admin check that used to open every one of these operations was
 * unreachable in practice: the only node-admin account on a deployed node is
 * the loopback `owner`, which has no password and therefore cannot be logged
 * into from a browser. Every human account is a non-admin, so "connect a local
 * folder" refused everybody — the feature was dead from the day it shipped.
 *
 * The replacement is confinement rather than privilege: every authenticated
 * member gets ONE directory of their own, and browses only inside it. A node
 * admin additionally keeps the wider `TM8_PROJECT_ROOTS` view, so nothing an
 * admin could do before is lost.
 *
 * HONEST LIMIT, because it would be easy to read more into 0700 than is there:
 * every tm8 session on a node runs as the SAME operating-system user. The mode
 * bits below protect these directories from other UNIX users on the box; they
 * do not separate one tm8 account from another. What separates tm8 accounts is
 * this authorization check and nothing else — so a defect here is a real
 * cross-account read, not a defence-in-depth lapse.
 */
export interface WorkspaceScope {
  /** Every root this caller may read. Length >= 1. */
  readonly roots: readonly string[];
  /** This caller's own directory — where their projects are created. */
  readonly home: string;
  readonly nodeAdmin: boolean;
  /** Filesystem-safe, immutable, and not the username, which can change. */
  readonly accountId: string;
}

interface AccountRow {
  id: string;
}

function workspaceBase(raw = process.env.TM8_USER_WORKSPACE_ROOT): string {
  const configured = raw?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new CollabError('invalid_input', 'TM8_USER_WORKSPACE_ROOT must be absolute');
    }
    return resolve(configured);
  }
  return join(homedir(), 'tm8-workspaces');
}

/**
 * Create this account's directory if it is missing and return its canonical
 * path. Creation is idempotent, so the first browse of a new account is what
 * brings the directory into being — there is no separate provisioning step to
 * forget, and an account that never opens the picker never gets a directory.
 */
export async function ensureAccountWorkspace(accountId: string, base = workspaceBase()): Promise<string> {
  if (!/^[0-9a-fA-F-]{36}$/.test(accountId)) {
    // The account id becomes a path segment; anything else is refused rather
    // than sanitized, so there is no encoding to reason about.
    throw new CollabError('invalid_input', 'account id is not a uuid');
  }
  const target = join(base, accountId.toLowerCase());
  try {
    await mkdir(target, { recursive: true, mode: WORKSPACE_MODE });
    await chmod(target, WORKSPACE_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `cannot create the workspace directory: ${target}`);
    }
    throw new CollabError('upstream_unavailable', `could not create the workspace directory: ${target}`);
  }
  try {
    return await realpath(target);
  } catch {
    throw new CollabError('upstream_unavailable', `workspace directory is unavailable: ${target}`);
  }
}

/**
 * Resolve the caller's browsing scope.
 *
 * The account id is read under the CALLER'S OWN claims, so an identity with no
 * account resolves to nothing and is refused here rather than being handed a
 * directory that belongs to no one.
 */
export async function workspaceScopeFor(db: Db, claims: DbClaims): Promise<WorkspaceScope> {
  const identityId = claims.identityId;
  if (!identityId) {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  // Through a definer accessor, not a direct read: `tm8_app` has no grant on
  // public.accounts, and giving it one would hand the application role every
  // account row so it could learn one fact about itself.
  //
  // ONE function answers this, defined once in migration 078. There were
  // briefly three — 078 and 079 both defined `current_account_id` and this file
  // called a third, `workspace_account_id`, from a migration of its own. All
  // three had identical bodies and all used `create or replace`, so apply order
  // silently decided which survived; a later edit to one of them would have
  // been quietly undone by the next. Collapsed deliberately.
  const rows = await db.query<AccountRow>(
    claims,
    `select internal.current_account_id()::text as id`,
  );
  const accountId = rows[0]?.id;
  if (!accountId) {
    throw new CollabError('forbidden', 'this identity has no active account to own a workspace');
  }

  const home = await ensureAccountWorkspace(accountId);
  if (claims.nodeAdmin !== true) {
    return { roots: [home], home, nodeAdmin: false, accountId };
  }

  // A node admin keeps the wider view they already had. Their own home is
  // included so the two paths agree on where an admin's projects are created.
  const configured = await canonicalRoots().catch(() => [] as string[]);
  const roots = [...new Set([home, ...configured])].sort((a, b) => a.localeCompare(b));
  return { roots, home, nodeAdmin: true, accountId };
}

/** Refuse a path the caller's scope does not contain, with the reason. */
export function requireInScope(scope: WorkspaceScope, path: string): void {
  if (scope.roots.some((root) => containedBy(root, path))) return;
  throw new CollabError(
    'forbidden',
    scope.nodeAdmin
      ? 'path is outside TM8_PROJECT_ROOTS and outside your workspace'
      : 'path is outside your workspace',
  );
}

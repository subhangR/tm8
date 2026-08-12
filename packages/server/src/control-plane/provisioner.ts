/**
 * The control plane's orchestration half.
 *
 * The POLICY is in Postgres (migration 101): who may provision, what a personal
 * space is, and the capability graph. The PRIVILEGE — creating an OS user,
 * chowning a home — is not here either; it belongs to a small root helper the
 * server calls but never contains. This module is the thin middle: it hashes
 * the password (the one decision that cannot live in SQL, exactly as
 * `pg-auth.ts` explains for login), calls the door, and maps the row out.
 *
 * WHY PROVISIONING IS NOT ONE TRANSACTION. It spans Postgres, the filesystem
 * and /etc/passwd, and only the first of those can roll back. So it is a
 * durable state machine: `provision_user` commits the part that IS
 * transactional and leaves `user_homes.state = 'db_ready'`, and a later phase
 * drives the row forward to `ready`. A user in `db_ready` can log in and see
 * their space; what they cannot yet do is have an agent run as themselves.
 *
 * There is deliberately no rollback. A failed later step leaves a visibly
 * half-provisioned user, because auto-undo would mean building an
 * account-deletion primitive reachable from a failure path — the shape of bug
 * that turns "disk full" into "account gone".
 */
import { CollabError } from '@tm8/contract';
import type {
  NodeCapability, UserHomeView, UserSummary, UsersCreateResult,
} from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { ScryptPasswordHasher } from '../identity/crypto.js';
import type { AccountRowJson } from '../identity/pg-auth.js';

const hasher = new ScryptPasswordHasher();

/**
 * Where user homes live on this node. Configurable because it is a property of
 * the machine, not of the schema — and passed INTO the door on every call, so
 * the database never holds a second opinion about it.
 */
export function resolveHomesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TM8_HOMES_ROOT?.trim();
  if (!raw) return '/srv/tm8/homes';
  if (!raw.startsWith('/') || raw.includes('..')) {
    throw new CollabError(
      'invalid_input',
      'TM8_HOMES_ROOT must be an absolute path with no parent traversal',
    );
  }
  return raw.replace(/\/+$/, '');
}

interface HomeRowJson {
  os_username: string;
  os_uid: number | null;
  home_path: string;
  state: UserHomeView['state'];
  isolation: UserHomeView['isolation'];
  quota_backend: string | null;
  last_error: string | null;
}

function homeView(row: HomeRowJson): UserHomeView {
  return {
    osUsername: row.os_username,
    osUid: row.os_uid,
    homePath: row.home_path,
    state: row.state,
    isolation: row.isolation,
    quotaBackend: row.quota_backend,
    lastError: row.last_error,
  };
}

export interface ProvisionUserInput {
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  requestKey?: string | null;
}

interface ProvisionRowJson {
  account: AccountRowJson;
  home: HomeRowJson;
  spaceId: string;
  replayed: boolean;
}

/**
 * Provision a user: account, their own space, and the record of their home.
 *
 * Runs under the CALLER's claims and lets Postgres refuse — the guard is
 * `require_capability('users.provision')`, with the same first-run hole
 * `ensure_account` carries so a virgin node can mint its first account.
 */
export async function provisionUser(
  db: Db,
  claims: DbClaims,
  input: ProvisionUserInput,
  homesRoot: string,
): Promise<UsersCreateResult> {
  const passwordHash = await hasher.hash(input.password);
  const row = await db.rpc<ProvisionRowJson | null>(claims, 'public.provision_user', [
    input.username,
    input.displayName ?? null,
    input.email ?? null,
    hasher.algorithm,
    passwordHash,
    homesRoot,
    input.requestKey ?? null,
  ]);
  if (!row) {
    throw new CollabError('upstream_unavailable', 'provision_user returned no row');
  }
  return {
    account: {
      accountId: row.account.id,
      identityId: row.account.identity_id,
      username: row.account.username,
      displayName: row.account.display_name,
      isNodeAdmin: row.account.is_node_admin,
      isOwner: row.account.is_owner,
    },
    home: homeView(row.home),
    spaceId: row.spaceId,
    replayed: row.replayed,
  };
}

interface UserRowJson {
  accountId: string;
  identityId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: 'active' | 'disabled';
  isOwner: boolean;
  isNodeAdmin: boolean;
  osUsername: string | null;
  osUid: number | null;
  homePath: string | null;
  homeState: UserHomeView['state'] | null;
  isolation: UserHomeView['isolation'] | null;
  quotaBackend: string | null;
  lastError: string | null;
  personalSpaceId: string | null;
  personalSpaceName: string | null;
  capabilities: NodeCapability[];
}

export async function listProvisionedUsers(db: Db, claims: DbClaims): Promise<UserSummary[]> {
  const rows = await db.rpc<UserRowJson[] | null>(claims, 'public.list_provisioned_users', []);
  return (rows ?? []).map((r) => ({
    accountId: r.accountId,
    identityId: r.identityId,
    username: r.username,
    displayName: r.displayName,
    email: r.email,
    status: r.status,
    isOwner: r.isOwner,
    isNodeAdmin: r.isNodeAdmin,
    // A user with no home row is one who predates the control plane and has not
    // been backfilled. Reported as null rather than invented.
    home: r.osUsername === null || r.homePath === null || r.homeState === null
      ? null
      : {
          osUsername: r.osUsername,
          osUid: r.osUid,
          homePath: r.homePath,
          state: r.homeState,
          isolation: r.isolation ?? 'pending',
          quotaBackend: r.quotaBackend,
          lastError: r.lastError,
        },
    personalSpaceId: r.personalSpaceId,
    personalSpaceName: r.personalSpaceName,
    capabilities: r.capabilities ?? [],
  }));
}

export async function grantCapability(
  db: Db, claims: DbClaims, accountId: string, capability: NodeCapability,
): Promise<void> {
  await db.rpc(claims, 'public.grant_account_capability', [accountId, capability]);
}

export async function revokeCapability(
  db: Db, claims: DbClaims, accountId: string, capability: NodeCapability,
): Promise<void> {
  await db.rpc(claims, 'public.revoke_account_capability', [accountId, capability]);
}

/**
 * Postgres-backed `IdentityRepository`, against Cygnus's 002 migration.
 *
 * SCHEMA CONTACT SURFACE — this is the ONLY file in the identity block that
 * knows a column name. If 002 moves, this file changes and nothing else does.
 *
 * Tables/columns assumed (002, as published by Cygnus 2026-07-25, plus the five
 * changes he ratified):
 *
 *   accounts(id, identity_id, login, display_name, email, password_hash,
 *            password_algo, node_admin, is_owner, disabled_at, created_at, updated_at)
 *   auth_sessions(id, account_id, token_hash, kind, team_member_id, label,
 *                 issued_at, last_seen_at, expires_at, revoked_at,
 *                 user_agent, created_from)
 *   members(entity_id, space_id, identity_id, role, display_name, joined_at)
 *   team_members(entity_id, owner_member_id, name, avatar, ...)
 *
 * WRITE PATH (R2/S9): `tm8_app` holds zero direct DML. Every write here calls a
 * SECURITY DEFINER RPC in `public`. Reads go through RLS as `tm8_app`, except the
 * two deliberate claim-free bootstrap holes — `resolve_auth_session` and
 * `resolve_account_credential` — which exist because the caller has no identity
 * until they answer.
 *
 * CONNECTIONS (T-L11): this file never opens one. It takes a `SqlExecutor` the
 * db layer supplies, already inside a transaction with claims bound. Claim
 * binding is `claims.ts` + the db layer; it is not this file's job.
 */

import type {
  Account,
  AccountId,
  AuthSession,
  AuthSessionId,
  AuthSessionKind,
  IdentityId,
  MemberId,
  MemberRecord,
  PasswordAlgorithm,
  TeamMemberId,
  TeamMemberRecord,
} from './types.js';
import type {
  AccountCredentialRow,
  ActorScope,
  CreateAccountInput,
  CreateAuthSessionInput,
  IdentityRepository,
} from './repository.js';
import { notFound } from './errors.js';
import { CollabError, type CommandErrorCode } from '@tm8/contract';

/**
 * The db layer's query seam. Structurally compatible with `pg`'s
 * `Client`/`Pool`, so the db layer can pass one straight through — no adapter,
 * and no `pg` dependency in this package.
 */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * SQLSTATE → contract taxonomy, per Cygnus's mapping. Mechanical: a raise from
 * the RPC catalog becomes the right `CollabError` with no message parsing, so
 * error text stays free to change.
 */
const SQLSTATE_TO_CODE: Record<string, CommandErrorCode> = {
  '28000': 'unauthenticated',
  '42501': 'forbidden',
  P0002: 'not_found',
  '22023': 'invalid_input',
  '23514': 'invariant_violation',
  '23503': 'invariant_violation',
  '23505': 'invariant_violation',
  '40001': 'version_conflict',
  '53400': 'limit_exceeded',
  '54000': 'payload_too_large',
  '0A000': 'not_implemented',
};

export function translatePgError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return error;
  const mapped = SQLSTATE_TO_CODE[code];
  if (!mapped) return error;
  const message = (error as { message?: string }).message ?? 'database error';
  return new CollabError(mapped, message, { details: { sqlstate: code } });
}

// --- row shapes -------------------------------------------------------------

interface AccountRow {
  id: string;
  identity_id: string;
  login: string;
  display_name: string | null;
  node_admin: boolean;
  is_owner: boolean;
  disabled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface CredentialRow extends AccountRow {
  password_hash: string | null;
  password_algo: string | null;
}

interface SessionRow {
  id: string;
  account_id: string;
  kind: string;
  team_member_id: string | null;
  token_hash: string;
  label: string | null;
  issued_at: string | Date;
  expires_at: string | Date;
  last_seen_at: string | Date | null;
  revoked_at: string | Date | null;
}

interface MemberRow {
  entity_id: string;
  space_id: string;
  identity_id: string;
  role: string;
  display_name: string | null;
  joined_at: string | Date;
}

interface TeamMemberRow {
  entity_id: string;
  space_id: string;
  owner_member_id: string;
  name: string | null;
  avatar: string | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    identityId: row.identity_id,
    username: row.login,
    displayName: row.display_name ?? row.login,
    isNodeAdmin: row.node_admin,
    isOwner: row.is_owner,
    status: row.disabled_at === null ? 'active' : 'disabled',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    disabledAt: isoOrNull(row.disabled_at),
  };
}

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as AuthSessionKind,
    actingAsTeamMemberId: row.team_member_id,
    tokenHash: row.token_hash,
    label: row.label,
    createdAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    lastUsedAt: isoOrNull(row.last_seen_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function toMember(row: MemberRow): MemberRecord {
  return {
    id: row.entity_id,
    spaceId: row.space_id,
    identityId: row.identity_id,
    role: row.role as MemberRecord['role'],
    displayName: row.display_name ?? '',
    avatar: null,
    joinedAt: iso(row.joined_at),
  };
}

function toTeamMember(row: TeamMemberRow): TeamMemberRecord {
  return {
    id: row.entity_id,
    spaceId: row.space_id,
    ownerMemberId: row.owner_member_id,
    displayName: row.name ?? '',
    avatar: row.avatar,
  };
}

const ACCOUNT_COLUMNS =
  'id, identity_id, login, display_name, node_admin, is_owner, disabled_at, created_at, updated_at';

const SESSION_COLUMNS =
  'id, account_id, kind, team_member_id, token_hash, label, issued_at, expires_at, last_seen_at, revoked_at';

export class PgIdentityRepository implements IdentityRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private async run<R>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      const result = await this.sql.query<R>(text, params);
      return result.rows;
    } catch (error) {
      throw translatePgError(error);
    }
  }

  // --- accounts ------------------------------------------------------------

  async ensureAccount(input: CreateAccountInput): Promise<Account> {
    // Idempotent in the RPC (ON CONFLICT (login) DO NOTHING ... RETURNING the
    // existing row), and single-owner-safe via `UNIQUE(is_owner) WHERE is_owner`.
    // The RPC itself refuses a claim-free call once the node has any account
    // (F1) — this call site is not the only thing standing between an anonymous
    // caller and a new account.
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM public.ensure_account($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.identityId,
        input.username,
        input.displayName,
        input.isNodeAdmin,
        input.isOwner,
        input.passwordHash,
        input.passwordAlgorithm,
      ],
    );
    const row = rows[0];
    if (!row) throw notFound('ensure_account returned no row');
    return toAccount(row);
  }

  async getAccountById(id: AccountId): Promise<Account | null> {
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getAccountByIdentityId(identityId: IdentityId): Promise<Account | null> {
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE identity_id = $1`,
      [identityId],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE lower(login) = lower($1)`,
      [username],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getOwnerAccount(): Promise<Account | null> {
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE is_owner`,
      [],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async countAccounts(): Promise<number> {
    const rows = await this.run<{ count: string }>('SELECT count(*)::text AS count FROM accounts');
    return Number(rows[0]?.count ?? 0);
  }

  async getCredentialByUsername(username: string): Promise<AccountCredentialRow | null> {
    // Claim-free by design (F2): password auth has no identity to bind yet.
    // SECURITY DEFINER, auth-only, the twin of resolve_auth_session.
    const rows = await this.run<CredentialRow>(
      `SELECT ${ACCOUNT_COLUMNS}, password_hash, password_algo
         FROM public.resolve_account_credential($1)`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      account: toAccount(row),
      passwordHash: row.password_hash,
      passwordAlgorithm: (row.password_algo as PasswordAlgorithm | null) ?? null,
    };
  }

  async setCredential(
    accountId: AccountId,
    passwordHash: string,
    algorithm: PasswordAlgorithm,
    _updatedAt: string,
  ): Promise<void> {
    // `updated_at` is the RPC's to stamp — server and database clocks disagree,
    // and the database's is the one the rows are ordered by.
    await this.run('SELECT public.set_account_credential($1, $2, $3)', [
      accountId,
      passwordHash,
      algorithm,
    ]);
  }

  async setAccountDisabled(accountId: AccountId, disabled: boolean, _at: string): Promise<Account> {
    const rows = await this.run<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM public.set_account_disabled($1, $2)`,
      [accountId, disabled],
    );
    const row = rows[0];
    if (!row) throw notFound('account not found', { accountId });
    return toAccount(row);
  }

  // --- sessions ------------------------------------------------------------

  async createAuthSession(input: CreateAuthSessionInput): Promise<AuthSession> {
    const rows = await this.run<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM public.issue_auth_session($1, $2, $3, $4, $5, $6)`,
      [
        input.accountId,
        input.tokenHash,
        input.kind,
        input.actingAsTeamMemberId,
        input.expiresAt,
        input.label,
      ],
    );
    const row = rows[0];
    if (!row) throw notFound('issue_auth_session returned no row');
    return toSession(row);
  }

  async getAuthSessionById(id: AuthSessionId): Promise<AuthSession | null> {
    // Claim-free (the single bootstrap hole): a bearer token IS the identity
    // claim, so it cannot be verified from inside an identity-bound transaction.
    const rows = await this.run<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM public.resolve_auth_session($1)`,
      [id],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async touchAuthSession(id: AuthSessionId, _at: string): Promise<void> {
    await this.run('SELECT public.touch_auth_session($1)', [id]);
  }

  async revokeAuthSession(id: AuthSessionId, _at: string): Promise<void> {
    await this.run('SELECT public.revoke_auth_session($1)', [id]);
  }

  async revokeAccountSessions(accountId: AccountId, _at: string): Promise<number> {
    const rows = await this.run<{ revoked: number }>(
      'SELECT public.revoke_account_sessions($1) AS revoked',
      [accountId],
    );
    return Number(rows[0]?.revoked ?? 0);
  }

  async listAuthSessions(accountId: AccountId, includeInactive: boolean): Promise<AuthSession[]> {
    const rows = await this.run<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM auth_sessions
        WHERE account_id = $1 AND ($2 OR revoked_at IS NULL)
        ORDER BY issued_at ASC`,
      [accountId, includeInactive],
    );
    return rows.map(toSession);
  }

  async deleteExpiredSessions(before: string): Promise<number> {
    const rows = await this.run<{ removed: number }>(
      'SELECT public.purge_auth_sessions($1) AS removed',
      [before],
    );
    return Number(rows[0]?.removed ?? 0);
  }

  // --- graph-side identity -------------------------------------------------

  async getActorScope(identityId: IdentityId): Promise<ActorScope> {
    // Two indexed reads: membership chooses the spaces, then every live persona
    // in those spaces is launchable. owner_member_id governs configuration,
    // not the shared launch/use boundary.
    const members = await this.run<MemberRow>(
      `SELECT entity_id, space_id, identity_id, role, display_name, joined_at
         FROM members WHERE identity_id = $1`,
      [identityId],
    );
    if (members.length === 0) return { members: [], teamMembers: [] };

    const teamMembers = await this.run<TeamMemberRow>(
      `SELECT tm.entity_id, e.space_id, tm.owner_member_id, tm.name, tm.avatar
         FROM team_members tm
         JOIN entities e ON e.id = tm.entity_id AND e.deleted_at IS NULL
        WHERE e.space_id = ANY($1::uuid[])`,
      [members.map((m) => m.space_id)],
    );
    return { members: members.map(toMember), teamMembers: teamMembers.map(toTeamMember) };
  }

  async getTeamMember(id: TeamMemberId): Promise<TeamMemberRecord | null> {
    const rows = await this.run<TeamMemberRow>(
      `SELECT tm.entity_id, m.space_id, tm.owner_member_id, tm.name, tm.avatar
         FROM team_members tm
         JOIN members m ON m.entity_id = tm.owner_member_id
        WHERE tm.entity_id = $1`,
      [id],
    );
    return rows[0] ? toTeamMember(rows[0]) : null;
  }

  async getMember(id: MemberId): Promise<MemberRecord | null> {
    const rows = await this.run<MemberRow>(
      `SELECT entity_id, space_id, identity_id, role, display_name, joined_at
         FROM members WHERE entity_id = $1`,
      [id],
    );
    return rows[0] ? toMember(rows[0]) : null;
  }
}

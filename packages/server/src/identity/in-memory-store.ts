/**
 * In-memory `IdentityRepository`.
 *
 * The unit-test twin, and the reference for what the Postgres implementation
 * must do. It enforces the same invariants the schema does (single owner,
 * unique case-insensitive username, immutable identity_id) so a test that
 * passes here is testing the real rules, not a permissive stub.
 */

import type {
  Account,
  AccountId,
  AuthSession,
  AuthSessionId,
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
import { invariantViolation, notFound } from './errors.js';

interface AccountRow extends Account {
  passwordHash: string | null;
  passwordAlgorithm: PasswordAlgorithm | null;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly accounts = new Map<AccountId, AccountRow>();
  private readonly sessions = new Map<AuthSessionId, AuthSession>();
  private readonly members = new Map<MemberId, MemberRecord>();
  private readonly teamMembers = new Map<TeamMemberId, TeamMemberRecord>();

  // --- test fixtures -------------------------------------------------------

  /** Seed a member row (in production these arrive with space creation/invite redemption). */
  addMember(member: MemberRecord): void {
    this.members.set(member.id, member);
  }

  addTeamMember(teamMember: TeamMemberRecord): void {
    this.teamMembers.set(teamMember.id, teamMember);
  }

  removeMember(id: MemberId): void {
    this.members.delete(id);
  }

  // --- accounts ------------------------------------------------------------

  async ensureAccount(input: CreateAccountInput): Promise<Account> {
    if (input.isOwner) {
      // Mirrors `UNIQUE(is_owner) WHERE is_owner`: the loser of a first-run race
      // gets the winner's row, never a second owner.
      const owner = [...this.accounts.values()].find((a) => a.isOwner);
      if (owner) return stripCredential(owner);
    }
    const byUsername = this.findByUsername(input.username);
    if (byUsername) return stripCredential(byUsername);

    const row: AccountRow = {
      id: input.id,
      identityId: input.identityId,
      username: input.username,
      displayName: input.displayName,
      isNodeAdmin: input.isNodeAdmin,
      isOwner: input.isOwner,
      status: 'active',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      disabledAt: null,
      passwordHash: input.passwordHash,
      passwordAlgorithm: input.passwordAlgorithm,
    };
    this.accounts.set(row.id, row);
    return stripCredential(row);
  }

  async getAccountById(id: AccountId): Promise<Account | null> {
    const row = this.accounts.get(id);
    return row ? stripCredential(row) : null;
  }

  async getAccountByIdentityId(identityId: IdentityId): Promise<Account | null> {
    const row = [...this.accounts.values()].find((a) => a.identityId === identityId);
    return row ? stripCredential(row) : null;
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    const row = this.findByUsername(username);
    return row ? stripCredential(row) : null;
  }

  async getOwnerAccount(): Promise<Account | null> {
    const owners = [...this.accounts.values()].filter((a) => a.isOwner);
    if (owners.length > 1) {
      throw invariantViolation('node has more than one owner account', {
        accountIds: owners.map((o) => o.id),
      });
    }
    return owners[0] ? stripCredential(owners[0]) : null;
  }

  async countAccounts(): Promise<number> {
    return this.accounts.size;
  }

  async getCredentialByUsername(username: string): Promise<AccountCredentialRow | null> {
    const row = this.findByUsername(username);
    if (!row) return null;
    return {
      account: stripCredential(row),
      passwordHash: row.passwordHash,
      passwordAlgorithm: row.passwordAlgorithm,
    };
  }

  async setCredential(
    accountId: AccountId,
    passwordHash: string,
    algorithm: PasswordAlgorithm,
    updatedAt: string,
  ): Promise<void> {
    const row = this.require(accountId);
    row.passwordHash = passwordHash;
    row.passwordAlgorithm = algorithm;
    row.updatedAt = updatedAt;
  }

  async setAccountDisabled(accountId: AccountId, disabled: boolean, at: string): Promise<Account> {
    const row = this.require(accountId);
    row.status = disabled ? 'disabled' : 'active';
    row.disabledAt = disabled ? at : null;
    row.updatedAt = at;
    return stripCredential(row);
  }

  // --- sessions ------------------------------------------------------------

  async createAuthSession(input: CreateAuthSessionInput): Promise<AuthSession> {
    const session: AuthSession = {
      id: input.id,
      accountId: input.accountId,
      kind: input.kind,
      actingAsTeamMemberId: input.actingAsTeamMemberId,
      tokenHash: input.tokenHash,
      label: input.label,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  async getAuthSessionById(id: AuthSessionId): Promise<AuthSession | null> {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  async touchAuthSession(id: AuthSessionId, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = at;
  }

  async revokeAuthSession(id: AuthSessionId, at: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw notFound('auth session not found', { sessionId: id });
    if (session.revokedAt === null) session.revokedAt = at;
  }

  async revokeAccountSessions(accountId: AccountId, at: string): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && session.revokedAt === null) {
        session.revokedAt = at;
        revoked += 1;
      }
    }
    return revoked;
  }

  async listAuthSessions(accountId: AccountId, includeInactive: boolean): Promise<AuthSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.accountId === accountId && (includeInactive || s.revokedAt === null))
      .map((s) => ({ ...s }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteExpiredSessions(before: string): Promise<number> {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= before || (session.revokedAt !== null && session.revokedAt <= before)) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // --- graph-side identity -------------------------------------------------

  async getActorScope(identityId: IdentityId): Promise<ActorScope> {
    const members = [...this.members.values()].filter((m) => m.identityId === identityId);
    const owned = new Set(members.map((m) => m.id));
    const teamMembers = [...this.teamMembers.values()].filter((tm) => owned.has(tm.ownerMemberId));
    return {
      members: members.map((m) => ({ ...m })),
      teamMembers: teamMembers.map((tm) => ({ ...tm })),
    };
  }

  async getTeamMember(id: TeamMemberId): Promise<TeamMemberRecord | null> {
    const row = this.teamMembers.get(id);
    return row ? { ...row } : null;
  }

  async getMember(id: MemberId): Promise<MemberRecord | null> {
    const row = this.members.get(id);
    return row ? { ...row } : null;
  }

  // --- internals -----------------------------------------------------------

  private findByUsername(username: string): AccountRow | undefined {
    const needle = username.trim().toLowerCase();
    return [...this.accounts.values()].find((a) => a.username.toLowerCase() === needle);
  }

  private require(id: AccountId): AccountRow {
    const row = this.accounts.get(id);
    if (!row) throw notFound('account not found', { accountId: id });
    return row;
  }
}

function stripCredential(row: AccountRow): Account {
  const { passwordHash: _h, passwordAlgorithm: _a, ...account } = row;
  return { ...account };
}

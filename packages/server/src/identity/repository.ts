/**
 * The store seam.
 *
 * `IdentityService` talks only to this interface, so the in-memory twin used by
 * unit tests and the Postgres implementation backed by Cygnus's 002 migration
 * are interchangeable. Everything schema-shaped lives behind here: if 002's
 * column names move, exactly one file changes.
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

export interface CreateAccountInput {
  id: AccountId;
  identityId: IdentityId;
  username: string;
  displayName: string;
  isNodeAdmin: boolean;
  isOwner: boolean;
  passwordHash: string | null;
  passwordAlgorithm: PasswordAlgorithm | null;
  createdAt: string;
}

export interface CreateAuthSessionInput {
  id: AuthSessionId;
  accountId: AccountId;
  kind: AuthSessionKind;
  actingAsTeamMemberId: TeamMemberId | null;
  tokenHash: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Everything needed to authenticate a login attempt, in one claim-free read. */
export interface AccountCredentialRow {
  account: Account;
  passwordHash: string | null;
  passwordAlgorithm: PasswordAlgorithm | null;
}

/**
 * The identity's full authorization scope across every space. Assembled once
 * per authentication and folded into the claim set.
 */
export interface ActorScope {
  members: MemberRecord[];
  /** Shared personas in any space represented by `members` — the `can_act_as` set. */
  teamMembers: TeamMemberRecord[];
}

export interface IdentityRepository {
  // --- accounts ------------------------------------------------------------

  /**
   * Idempotent first-run owner creation (T-L7). Returns the existing row if one
   * is already there — the degenerate local case is the same code path with one
   * row in it, not a separate branch.
   *
   * Concurrency: two simultaneous first-run requests must yield ONE owner. In
   * Postgres that is enforced by `UNIQUE(is_owner) WHERE is_owner`; an
   * implementation that loses the race returns the winner's row rather than
   * raising.
   */
  ensureAccount(input: CreateAccountInput): Promise<Account>;

  getAccountById(id: AccountId): Promise<Account | null>;
  getAccountByIdentityId(identityId: IdentityId): Promise<Account | null>;
  /** Case-insensitive. */
  getAccountByUsername(username: string): Promise<Account | null>;
  /** The T-L7 singleton, or null before first run. */
  getOwnerAccount(): Promise<Account | null>;
  countAccounts(): Promise<number>;

  /** Claim-free by design — the caller has no identity until this resolves (F2). */
  getCredentialByUsername(username: string): Promise<AccountCredentialRow | null>;
  setCredential(
    accountId: AccountId,
    passwordHash: string,
    algorithm: PasswordAlgorithm,
    updatedAt: string,
  ): Promise<void>;

  /** R6 revocation. Flips `disabled_at`; the member entity and authored history are untouched. */
  setAccountDisabled(accountId: AccountId, disabled: boolean, at: string): Promise<Account>;

  // --- sessions ------------------------------------------------------------

  createAuthSession(input: CreateAuthSessionInput): Promise<AuthSession>;
  /** Indexed lookup by the token's session id; the hash comparison happens above. */
  getAuthSessionById(id: AuthSessionId): Promise<AuthSession | null>;
  touchAuthSession(id: AuthSessionId, at: string): Promise<void>;
  revokeAuthSession(id: AuthSessionId, at: string): Promise<void>;
  /** R6: one statement kills every live session for an account. Returns rows revoked. */
  revokeAccountSessions(accountId: AccountId, at: string): Promise<number>;
  listAuthSessions(accountId: AccountId, includeInactive: boolean): Promise<AuthSession[]>;
  /** Retention: the scheduler (R26) sweeps expired/revoked rows. Returns rows removed. */
  deleteExpiredSessions(before: string): Promise<number>;

  // --- graph-side identity -------------------------------------------------

  getActorScope(identityId: IdentityId): Promise<ActorScope>;
  getTeamMember(id: TeamMemberId): Promise<TeamMemberRecord | null>;
  getMember(id: MemberId): Promise<MemberRecord | null>;
}

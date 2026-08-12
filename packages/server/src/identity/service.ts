/**
 * IdentityService — the explicit seam (09 §3.2).
 *
 * Consumed by the HTTP facade at W2 and, in Phase 2, by the gateway's
 * remote-facing auth surface (R1/T-L8). There is no HTTP surface here and no
 * remote surface anywhere in Phase 1 (S1).
 *
 * The three laws this file exists to keep:
 *
 * - T-L7 — auth is always on; local is the degenerate case. `resolveLoopbackOwner`
 *   is not a bypass: it bootstraps a real account row and then runs the exact
 *   `buildClaims` every other authentication path runs. One code path, one row.
 * - T-L11/R2 — identity binds per transaction. This block PRODUCES claims
 *   (`claims.ts`); the db layer applies them with `SET LOCAL`. No connection, no
 *   DB credential, no JWT (JWTs exist only at the bridge, Phase 2).
 * - R6 — lifecycle minimums: node-admin credential reset, revocation that kills
 *   sessions while the member entity and authored history survive, and an
 *   opaque immutable `identity_id` so `user@server` can layer on later.
 */

import type {
  Account,
  AccountId,
  AuthContext,
  AuthSession,
  AuthSessionKind,
  ClaimSet,
  IdentityId,
  IssuedSession,
  MemberId,
  TeamMemberId,
} from './types.js';
import type { ActorScope, IdentityRepository } from './repository.js';
import { type Clock, type IdGenerator, systemClock, systemIds } from './ids.js';
import {
  type PasswordHasher,
  ScryptPasswordHasher,
  UNMATCHABLE_VERIFIER,
  formatToken,
  generateSecret,
  hashToken,
  parseToken,
} from './crypto.js';
import { forbidden, invalidInput, invariantViolation, notFound, unauthenticated } from './errors.js';

export interface BootstrapOwnerInput {
  username?: string;
  displayName?: string;
  /** Optional at first run: a loopback-only node may have no password at all (S1+S5). */
  password?: string;
}

export interface AuthenticateInput {
  username: string;
  password: string;
  kind?: AuthSessionKind;
  label?: string;
  ttlMs?: number;
}

export interface IssueSessionInput {
  accountId: AccountId;
  kind: AuthSessionKind;
  /** Required for `agent` sessions — the persona the token may act as (S8). */
  actingAsTeamMemberId?: TeamMemberId | null;
  label?: string;
  ttlMs?: number;
}

export interface ResolveClaimsInput {
  accountId: AccountId;
  /** Must be in the identity's `can_act_as` set, else `forbidden`. */
  actingAsTeamMemberId?: TeamMemberId | null;
  /** Pins authorship to one space's member row when the request is space-scoped. */
  spaceId?: string;
}

export interface ResetCredentialsInput {
  /** The caller. Must be a node admin, or the target itself. */
  actingAccountId: AccountId;
  targetAccountId: AccountId;
  newPassword: string;
}

export interface IdentityService {
  /**
   * First run creates the owner account; every later call returns it. Idempotent
   * by construction — this is the SAME path a multi-account node takes, with one
   * row in it (T-L7).
   */
  bootstrapOwner(input?: BootstrapOwnerInput): Promise<Account>;

  /**
   * v1 local auto-auth. Bootstraps (idempotent) and resolves the owner's claims.
   *
   * Deliberately issues NO token and creates NO session row: auto-auth is
   * identity resolution, not credential issuance, so an unauthenticated browser
   * request cannot spam `auth_sessions`. The facade calls this ONLY for requests
   * that already passed S1-S4 (loopback bind, Host allowlist, WS Origin, CORS);
   * this block cannot see those and does not pretend to (S5).
   */
  resolveLoopbackOwner(): Promise<AuthContext>;

  /** Password login. Same claim assembly as every other path. */
  authenticate(input: AuthenticateInput): Promise<AuthContext & { token: string }>;

  /** S8: mint a bearer token. Agent tokens are scoped to a `team_member`. */
  issueSession(input: IssueSessionInput): Promise<IssuedSession>;

  /** Bearer verification: format, existence, revocation, expiry, account status. */
  verifyToken(token: string): Promise<AuthContext>;

  revokeSession(sessionId: string): Promise<void>;
  listSessions(accountId: AccountId, includeInactive?: boolean): Promise<AuthSession[]>;

  /** R6 revocation: kills every session; member entity + authored history survive. */
  disableAccount(accountId: AccountId): Promise<Account>;
  enableAccount(accountId: AccountId): Promise<Account>;

  /** R6 recovery: node admin resets credentials (or an account resets its own). */
  resetCredentials(input: ResetCredentialsInput): Promise<void>;

  /** The claim set the db layer binds per transaction. */
  buildClaims(input: ResolveClaimsInput): Promise<ClaimSet>;

  /** Shared personas in spaces this identity has joined. */
  listCanActAs(identityId: IdentityId): Promise<TeamMemberId[]>;
  canActAs(identityId: IdentityId, teamMemberId: TeamMemberId): Promise<boolean>;
}

export interface IdentityServiceOptions {
  repository: IdentityRepository;
  clock?: Clock;
  ids?: IdGenerator;
  hasher?: PasswordHasher;
  /** Defaults for the owner minted on first run. */
  owner?: { username?: string; displayName?: string };
  sessionTtlMs?: Partial<Record<AuthSessionKind, number>>;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * R6 expiry. Kept in step with `pg-auth.ts`'s `SESSION_TTL_MS`, which is the
 * table the LIVE auth path actually reads (this class is the shape that did not
 * land — see this file's own header and `loopback.ts:4-12`). Two tables that
 * disagree would invite a future reader to "repair" the live one back to the
 * dead one's value, so they are corrected together. `pg-auth.ts` carries the
 * reasoning for the agent figure.
 */
export const DEFAULT_SESSION_TTL_MS: Record<AuthSessionKind, number> = {
  browser: 30 * DAY,
  cli: 90 * DAY,
  agent: 48 * HOUR,
};

export const DEFAULT_OWNER_USERNAME = 'owner';
export const DEFAULT_OWNER_DISPLAY_NAME = 'Owner';

export class IdentityServiceImpl implements IdentityService {
  private readonly repo: IdentityRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly hasher: PasswordHasher;
  private readonly ownerDefaults: { username: string; displayName: string };
  private readonly ttl: Record<AuthSessionKind, number>;

  constructor(options: IdentityServiceOptions) {
    this.repo = options.repository;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? systemIds;
    this.hasher = options.hasher ?? new ScryptPasswordHasher();
    this.ownerDefaults = {
      username: options.owner?.username ?? DEFAULT_OWNER_USERNAME,
      displayName: options.owner?.displayName ?? DEFAULT_OWNER_DISPLAY_NAME,
    };
    this.ttl = { ...DEFAULT_SESSION_TTL_MS, ...options.sessionTtlMs };
  }

  // --- bootstrap -----------------------------------------------------------

  async bootstrapOwner(input: BootstrapOwnerInput = {}): Promise<Account> {
    const existing = await this.repo.getOwnerAccount();
    if (existing) return existing;

    const now = this.clock.now();
    const passwordHash = input.password ? await this.hasher.hash(input.password) : null;

    // `ensureAccount` is the idempotency point: if a concurrent first run won the
    // race, it returns that winner rather than minting a second owner. The
    // identity id generated here is then simply discarded — it was never issued.
    return this.repo.ensureAccount({
      id: this.ids.uuid(),
      identityId: this.ids.identityId(),
      username: input.username ?? this.ownerDefaults.username,
      displayName: input.displayName ?? this.ownerDefaults.displayName,
      isNodeAdmin: true,
      isOwner: true,
      passwordHash,
      passwordAlgorithm: passwordHash ? this.hasher.algorithm : null,
      createdAt: now,
    });
  }

  async resolveLoopbackOwner(): Promise<AuthContext> {
    const owner = await this.bootstrapOwner();
    if (owner.status === 'disabled') {
      // A disabled owner is a real state (R6) and auto-auth must respect it
      // rather than resurrecting the account behind the admin's back.
      throw unauthenticated('node owner account is disabled', { accountId: owner.id });
    }
    const claims = await this.buildClaims({ accountId: owner.id });
    return { account: owner, session: null, claims };
  }

  // --- authentication ------------------------------------------------------

  async authenticate(input: AuthenticateInput): Promise<AuthContext & { token: string }> {
    const username = normalizeUsername(input.username);
    const row = await this.repo.getCredentialByUsername(username);

    // Spend the same work whether or not the login exists, so timing does not
    // enumerate accounts. Both branches end in one scrypt verification.
    const verifier = row?.passwordHash ?? UNMATCHABLE_VERIFIER;
    const ok = await this.hasher.verify(input.password, verifier);

    if (!row || !row.passwordHash || !ok) {
      throw unauthenticated('invalid credentials');
    }
    if (row.account.status === 'disabled') {
      throw unauthenticated('account is disabled', { accountId: row.account.id });
    }

    const issued = await this.issueSession({
      accountId: row.account.id,
      kind: input.kind ?? 'browser',
      label: input.label,
      ttlMs: input.ttlMs,
    });
    const claims = await this.buildClaims({ accountId: row.account.id });
    return { account: row.account, session: issued.session, claims, token: issued.token };
  }

  async issueSession(input: IssueSessionInput): Promise<IssuedSession> {
    const account = await this.repo.getAccountById(input.accountId);
    if (!account) throw notFound('account not found', { accountId: input.accountId });
    if (account.status === 'disabled') {
      throw forbidden('account is disabled', { accountId: account.id });
    }

    const actingAs = input.actingAsTeamMemberId ?? null;
    if (input.kind === 'agent' && !actingAs) {
      // S8: an agent token that is not scoped to a persona would act with the
      // launching human's authority rather than the teammate it is running.
      throw invalidInput('agent sessions must be scoped to a team_member');
    }
    if (actingAs) {
      await this.assertCanActAs(account.identityId, actingAs);
    }

    const id = this.ids.uuid();
    const secret = generateSecret();
    const now = this.clock.nowMs();
    const ttl = input.ttlMs ?? this.ttl[input.kind];

    const session = await this.repo.createAuthSession({
      id,
      accountId: account.id,
      kind: input.kind,
      actingAsTeamMemberId: actingAs,
      tokenHash: hashToken(secret),
      label: input.label ?? null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    });

    return { session, token: formatToken(id, secret) };
  }

  async verifyToken(token: string): Promise<AuthContext> {
    const parsed = parseToken(token);
    if (!parsed) throw unauthenticated('malformed token');

    const session = await this.repo.getAuthSessionById(parsed.sessionId);
    // One message and one code for every rejection reason below: a caller
    // holding a bad token learns nothing about which part was bad.
    if (!session) throw unauthenticated('invalid token');
    if (!constantTimeEqualHex(session.tokenHash, hashToken(parsed.secret))) {
      throw unauthenticated('invalid token');
    }
    if (session.revokedAt !== null) throw unauthenticated('invalid token');
    if (Date.parse(session.expiresAt) <= this.clock.nowMs()) {
      throw unauthenticated('invalid token');
    }

    const account = await this.repo.getAccountById(session.accountId);
    if (!account) throw unauthenticated('invalid token');
    if (account.status === 'disabled') throw unauthenticated('invalid token');

    await this.repo.touchAuthSession(session.id, this.clock.now());

    const claims = await this.buildClaims({
      accountId: account.id,
      actingAsTeamMemberId: session.actingAsTeamMemberId,
    });
    return { account, session, claims };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.repo.revokeAuthSession(sessionId, this.clock.now());
  }

  async listSessions(accountId: AccountId, includeInactive = false): Promise<AuthSession[]> {
    return this.repo.listAuthSessions(accountId, includeInactive);
  }

  // --- lifecycle (R6) ------------------------------------------------------

  async disableAccount(accountId: AccountId): Promise<Account> {
    const account = await this.repo.setAccountDisabled(accountId, true, this.clock.now());
    // Revocation kills sessions. It does NOT touch the member entity or any
    // authored history — the graph is a historical record of who acted (R6).
    await this.repo.revokeAccountSessions(accountId, this.clock.now());
    return account;
  }

  async enableAccount(accountId: AccountId): Promise<Account> {
    return this.repo.setAccountDisabled(accountId, false, this.clock.now());
  }

  async resetCredentials(input: ResetCredentialsInput): Promise<void> {
    const actor = await this.repo.getAccountById(input.actingAccountId);
    if (!actor) throw notFound('account not found', { accountId: input.actingAccountId });

    const isSelf = actor.id === input.targetAccountId;
    if (!actor.isNodeAdmin && !isSelf) {
      // Node-level role, not a space role — the two never mix (T-L7).
      throw forbidden('credential reset requires node admin');
    }
    if (actor.status === 'disabled') {
      throw forbidden('account is disabled', { accountId: actor.id });
    }

    const target = await this.repo.getAccountById(input.targetAccountId);
    if (!target) throw notFound('account not found', { accountId: input.targetAccountId });
    if (input.newPassword.length < 8) {
      throw invalidInput('password must be at least 8 characters');
    }

    const hash = await this.hasher.hash(input.newPassword);
    await this.repo.setCredential(target.id, hash, this.hasher.algorithm, this.clock.now());
    // A reset invalidates outstanding sessions; otherwise a stolen token
    // survives the very event the reset exists to respond to.
    await this.repo.revokeAccountSessions(target.id, this.clock.now());
  }

  // --- claims --------------------------------------------------------------

  async buildClaims(input: ResolveClaimsInput): Promise<ClaimSet> {
    const account = await this.repo.getAccountById(input.accountId);
    if (!account) throw notFound('account not found', { accountId: input.accountId });
    if (account.status === 'disabled') {
      throw unauthenticated('account is disabled', { accountId: account.id });
    }

    const scope = await this.repo.getActorScope(account.identityId);
    const memberIds = scope.members.map((m) => m.id);
    const canActAs = resolveCanActAs(scope);
    const actingAs = input.actingAsTeamMemberId ?? null;

    if (actingAs && !canActAs.includes(actingAs)) {
      // Authorization resolves through current space membership: teammate
      // ownership governs configuration, not shared launch/use authority.
      throw forbidden('not permitted to act as this team_member', {
        teamMemberId: actingAs,
        identityId: account.identityId,
      });
    }

    const actorId = actingAs ?? pickPrimaryMember(scope, input.spaceId);
    if (actorId === null) {
      // No member row anywhere: the identity exists but has not joined a space.
      // Claims still bind (identity_id is what RLS needs); actor_id is empty and
      // every space predicate is false.
      return {
        identityId: account.identityId,
        accountId: account.id,
        isNodeAdmin: account.isNodeAdmin,
        memberIds: [],
        teamMemberIds: canActAs,
        actingAsTeamMemberId: null,
        actorId: '',
        canActAs,
      };
    }

    return {
      identityId: account.identityId,
      accountId: account.id,
      isNodeAdmin: account.isNodeAdmin,
      memberIds,
      teamMemberIds: canActAs,
      actingAsTeamMemberId: actingAs,
      actorId,
      canActAs,
    };
  }

  async listCanActAs(identityId: IdentityId): Promise<TeamMemberId[]> {
    return resolveCanActAs(await this.repo.getActorScope(identityId));
  }

  async canActAs(identityId: IdentityId, teamMemberId: TeamMemberId): Promise<boolean> {
    return (await this.listCanActAs(identityId)).includes(teamMemberId);
  }

  private async assertCanActAs(identityId: IdentityId, teamMemberId: TeamMemberId): Promise<void> {
    if (await this.canActAs(identityId, teamMemberId)) return;
    const exists = await this.repo.getTeamMember(teamMemberId);
    if (!exists) throw notFound('team_member not found', { teamMemberId });
    throw forbidden('not permitted to act as this team_member', { teamMemberId, identityId });
  }
}

/**
 * Teammates are shared personas: membership in their space grants launch/use
 * authority. ownerMemberId still governs persona configuration. Node-admin
 * does NOT widen this — node-level and space-level roles remain separate.
 */
function resolveCanActAs(scope: ActorScope): TeamMemberId[] {
  return scope.teamMembers.map((tm) => tm.id);
}

/**
 * The member row a request authors as. Space-scoped requests use that space's
 * row; otherwise the oldest membership, which on a v1 local node is the only one.
 */
function pickPrimaryMember(scope: ActorScope, spaceId?: string): MemberId | null {
  if (scope.members.length === 0) return null;
  if (spaceId) {
    const match = scope.members.find((m) => m.spaceId === spaceId);
    if (!match) return null;
    return match.id;
  }
  const sorted = [...scope.members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  return sorted[0]!.id;
}

export function normalizeUsername(username: string): string {
  const trimmed = username.trim().toLowerCase();
  if (trimmed.length === 0) throw invalidInput('username must not be empty');
  return trimmed;
}

/** Both inputs are sha256 hex of fixed length; compare without early exit. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Exported for the store implementations, which must agree on the invariant. */
export function assertSingleOwner(owners: readonly Account[]): void {
  if (owners.length > 1) {
    throw invariantViolation('node has more than one owner account', {
      accountIds: owners.map((o) => o.id),
    });
  }
}

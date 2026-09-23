/**
 * The live local-account auth path (Identity v2 Stage 1), bound to the 007
 * RPCs as delivered — the same decision `loopback.ts` records for the owner
 * bootstrap.
 *
 * WHY THIS FILE RATHER THAN `IdentityServiceImpl` + `PgIdentityRepository`:
 * that pair is written against a schema and RPC surface that did not land
 * (see loopback.ts:4-12 and the pg-store header), while 007 already ships the
 * complete auth surface: the two claim-free bootstrap holes
 * (`resolve_auth_session` by token HASH, `resolve_account_credential` by
 * login) plus claim-guarded `issue_auth_session` / `revoke_auth_session` /
 * `touch_auth_session` / `ensure_account` / `set_account_disabled`. This file
 * is the narrow adapter between those RPCs and the HTTP surface. All
 * authorization lives in the RPCs' `require_*` guards; the ONLY decision made
 * in TypeScript is the scrypt password comparison, which cannot live in SQL.
 *
 * Claim discipline:
 * - `resolveBearerIdentity` and the credential read run CLAIM-FREE — the
 *   caller has no identity until they answer. 007 documents both holes.
 * - `issue_auth_session` runs under the just-verified identity's claims, so
 *   its "minting for someone else is node administration" guard holds.
 * - signup/logout run under the CALLER's claims; `ensure_account` and
 *   `revoke_auth_session` carry their own `require_*` guards in SQL.
 */
import { CollabError } from '@tm8/contract';
import { randomUUID } from 'node:crypto';
import type { Db, DbClaims } from '../db/types.js';
import {
  ScryptPasswordHasher,
  UNMATCHABLE_VERIFIER,
  formatToken,
  generateSecret,
  hashToken,
  parseToken,
} from './crypto.js';

const hasher = new ScryptPasswordHasher();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** R6 expiry: a runtime token is additionally revoked when its thread closes. */
export const SESSION_TTL_MS = {
  browser: 30 * DAY,
  cli: 90 * DAY,
  agent: 7 * DAY,
  agent_runtime: DAY,
} as const;

export type LoginKind = keyof typeof SESSION_TTL_MS;

/** `public.resolve_auth_session` result (007:110-124) — camelCase by construction. */
export interface ResolvedAuthSession {
  sessionId: string;
  accountId: string;
  identityId: string;
  username: string;
  displayName: string | null;
  isNodeAdmin: boolean;
  isOwner: boolean;
  kind: LoginKind;
  actingAsTeamMemberId: string | null;
  workSessionId: string | null;
  runtimeMemberId: string | null;
  /** Pre-176 credentials only; a chat is an entity now and binds through runtimeChatId. */
  runtimeThreadRootId: string | null;
  runtimeChatId: string | null;
  expiresAt: string;
  label: string | null;
}

/** `public.resolve_account_credential` result (007:131-140). */
interface ResolvedCredential {
  accountId: string;
  identityId: string;
  username: string;
  passwordHash: string | null;
  passwordAlgorithm: string | null;
  isNodeAdmin: boolean;
  isOwner: boolean;
  status: 'active' | 'disabled';
  disabledAt: string | null;
}

/** `to_jsonb(auth_sessions) - 'token_hash'` (007:288-310) — snake_case by construction. */
interface SessionRowJson {
  id: string;
  account_id: string;
  kind: LoginKind;
  acting_as_team_member_id: string | null;
  work_session_id?: string | null;
  runtime_member_id?: string | null;
  runtime_thread_root_id?: string | null;
  runtime_chat_id?: string | null;
  label: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** `to_jsonb(accounts) - 'password_hash'` (007:150-197) — snake_case by construction. */
export interface AccountRowJson {
  id: string;
  identity_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  is_node_admin: boolean;
  is_owner: boolean;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

export interface IssuedLogin {
  token: string;
  account: {
    accountId: string;
    identityId: string;
    username: string;
    displayName: string | null;
    isNodeAdmin: boolean;
    isOwner: boolean;
  };
  session: {
    sessionId: string;
    kind: LoginKind;
    actingAsTeamMemberId: string | null;
    label: string | null;
    createdAt: string;
    expiresAt: string;
  };
}

export interface IssuedAgentSession {
  token: string;
  sessionId: string;
  workSessionId: string;
  actingAsTeamMemberId: string;
  expiresAt: string;
}

export interface IssuedAgentRuntimeSession {
  token: string;
  sessionId: string;
  runtimeMemberId: string;
  runtimeChatId: string;
  actingAsTeamMemberId: string;
  expiresAt: string;
}

/**
 * Mint the credential for one concrete agent run.
 *
 * The dedicated RPC derives the account from the bound identity, verifies the
 * persona participates in this work session, and atomically revokes any token
 * from an earlier run (including resume). The human bearer is never copied.
 */
export async function issueAgentSession(
  db: Db,
  claims: DbClaims,
  input: { workSessionId: string; teamMemberId: string; label?: string | null },
): Promise<IssuedAgentSession> {
  const secret = generateSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS.agent).toISOString();
  const session = await db.rpc<SessionRowJson>(claims, 'issue_agent_auth_session', [
    input.workSessionId,
    input.teamMemberId,
    hashToken(secret),
    expiresAt,
    input.label ?? `agent:${input.workSessionId}`,
  ]);
  return {
    token: formatToken(session.id, secret),
    sessionId: session.id,
    workSessionId: input.workSessionId,
    actingAsTeamMemberId: input.teamMemberId,
    expiresAt: session.expires_at,
  };
}

/** Idempotent lifecycle cleanup. No token value is needed to revoke the run. */
export async function revokeAgentSession(
  db: Db,
  claims: DbClaims,
  workSessionId: string,
): Promise<void> {
  await db.rpc(claims, 'revoke_agent_auth_session', [workSessionId]);
}

/**
 * Mint the MCP credential for one hot chat thread.
 *
 * This is an internal server helper, never a facade/catalog operation. The SQL
 * function derives the account and member from `claims`, verifies teammate
 * authority in the thread's space, and atomically replaces any prior live
 * token for the same root. Plaintext leaves this function exactly once so the
 * orchestrator can pass it as `TM8_AGENT_RUNTIME_TOKEN` to the stdio server.
 */
export async function issueAgentRuntimeSession(
  db: Db,
  claims: DbClaims,
  input: { chatId: string; teamMemberId: string; label?: string | null },
): Promise<IssuedAgentRuntimeSession> {
  const secret = generateSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS.agent_runtime).toISOString();
  const session = await db.rpc<SessionRowJson>(claims, 'issue_agent_runtime_session', [
    input.chatId,
    input.teamMemberId,
    hashToken(secret),
    expiresAt,
    input.label ?? `chat:${input.chatId}`,
  ]);
  if (!session.runtime_member_id || !session.runtime_chat_id) {
    throw new CollabError('upstream_unavailable', 'agent runtime session returned no attribution');
  }
  return {
    token: formatToken(session.id, secret),
    sessionId: session.id,
    runtimeMemberId: session.runtime_member_id,
    runtimeChatId: session.runtime_chat_id,
    actingAsTeamMemberId: input.teamMemberId,
    expiresAt: session.expires_at,
  };
}

/** Idempotently revoke every live runtime credential owned by a chat. */
export async function revokeAgentRuntimeSession(
  db: Db,
  claims: DbClaims,
  chatId: string,
): Promise<void> {
  await db.rpc(claims, 'revoke_agent_runtime_session', [chatId]);
}

/** One message and one code for every rejection: a caller holding a bad credential learns nothing. */
function invalidToken(): CollabError {
  return new CollabError('unauthenticated', 'invalid token');
}

function invalidCredentials(): CollabError {
  return new CollabError('unauthenticated', 'invalid credentials');
}

/**
 * Verify a presented `tm8s_…` bearer token against `auth_sessions`.
 *
 * Claim-free by design (007's one claim-free session read): the token IS the
 * identity claim, so it cannot be verified from inside an identity-bound
 * transaction. The RPC itself refuses revoked and expired sessions and
 * disabled accounts — a disabled account's live tokens die immediately, not
 * at next expiry (R6).
 *
 * Throws `unauthenticated` for every failure mode with one uniform message.
 */
export async function resolveBearerIdentity(db: Db, token: string): Promise<ResolvedAuthSession> {
  const parsed = parseToken(token);
  if (!parsed) throw invalidToken();

  const tokenHash = hashToken(parsed.secret);
  const session = await db.tx({}, async (q) => {
    const resolved = await q.rpc<ResolvedAuthSession | null>('resolve_auth_session', [tokenHash]);
    if (resolved) await q.rpc('touch_auth_session', [resolved.sessionId]);
    return resolved;
  });

  // The session id in the token is a routing hint, never the credential; the
  // sha256 lookup above is what authenticated. Refusing a mismatched pair
  // costs nothing and rejects spliced tokens.
  if (!session || session.sessionId !== parsed.sessionId) throw invalidToken();
  return session;
}

export interface LoginInput {
  username: string;
  password: string;
  kind?: 'browser' | 'cli';
  label?: string | null;
}

/**
 * Password login: claim-free credential read, constant-work scrypt
 * verification, then a session mint under the just-verified identity.
 *
 * The dummy-verifier branch spends the same scrypt work on an unknown
 * username as on a wrong password, so response timing does not enumerate
 * accounts — and the error is byte-identical either way.
 */
export async function loginWithPassword(
  db: Db,
  input: LoginInput,
  requestId?: string,
): Promise<IssuedLogin> {
  const row = await db.rpc<ResolvedCredential | null>({}, 'resolve_account_credential', [
    input.username,
  ]);

  const verifier = row?.passwordHash ?? UNMATCHABLE_VERIFIER;
  const ok = await hasher.verify(input.password, verifier);
  if (!row || !row.passwordHash || !ok) throw invalidCredentials();
  // Password proven but the account is switched off (R6). Same code, same
  // message as a bad credential: a disabled account is not enumerable either.
  if (row.status !== 'active') throw invalidCredentials();

  const kind: LoginKind = input.kind ?? 'browser';
  const sessionId = randomUUID();
  const secret = generateSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS[kind]).toISOString();

  // Bound claims make issue_auth_session's guard hold: this identity mints
  // for itself, which the RPC permits without node admin. The profile read
  // rides in the same transaction under the same claims — user_profiles'
  // self-select policy admits it.
  const claims = { identityId: row.identityId, ...(requestId ? { requestId } : {}) };
  const { session, displayName } = await db.tx(claims, async (q) => {
    const issued = await q.rpc<SessionRowJson>('issue_auth_session', [
      row.accountId,
      hashToken(secret),
      kind,
      expiresAt,
      null,
      input.label ?? null,
    ]);
    const profile = await q.query<{ display_name: string | null }>(
      'select display_name from public.user_profiles where identity_id = $1',
      [row.identityId],
    );
    return { session: issued, displayName: profile[0]?.display_name ?? null };
  });

  return {
    token: formatToken(session.id, secret),
    account: {
      accountId: row.accountId,
      identityId: row.identityId,
      username: row.username,
      displayName,
      isNodeAdmin: row.isNodeAdmin,
      isOwner: row.isOwner,
    },
    session: {
      sessionId: session.id,
      kind: session.kind,
      actingAsTeamMemberId: session.acting_as_team_member_id,
      label: session.label,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
    },
  };
}

export interface SignupInput {
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  isNodeAdmin?: boolean;
}

/**
 * Node-admin provisioning of a local account. The guard is in SQL:
 * `ensure_account` (007 F1) demands an authenticated node admin the moment
 * the node has any account, so this function simply runs under the CALLER's
 * claims and lets Postgres refuse. There is no open self-registration path.
 *
 * `ensure_account` is idempotent by lookup — an existing username returns the
 * existing row rather than raising — so signup detects that case by identity
 * and refuses with `conflict` instead of silently handing back someone
 * else's account.
 */
export async function signupAccount(
  db: Db,
  claims: { identityId?: string; nodeAdmin?: boolean; requestId?: string },
  input: SignupInput,
): Promise<AccountRowJson> {
  const identityId = `id_${randomUUID()}`;
  const passwordHash = await hasher.hash(input.password);

  const account = await db.rpc<AccountRowJson | null>(claims, 'ensure_account', [
    identityId,
    input.username,
    input.displayName ?? null,
    input.email ?? null,
    false, // p_is_owner — signup never mints an owner
    input.isNodeAdmin ?? false,
    hasher.algorithm,
    passwordHash,
  ]);
  if (!account) {
    throw new CollabError('upstream_unavailable', 'ensure_account returned no row');
  }
  if (account.identity_id !== identityId) {
    throw new CollabError('conflict', 'an account with this username already exists');
  }
  return account;
}

/* ── first-run node claim (docs/identity/FIRST-RUN-CLAIM-DESIGN.md) ──────── */

/**
 * The claim token's wire prefix, mirroring `tm8s_` for sessions.
 *
 * Distinct on purpose: the two are easy to confuse, both start `tm8`, and a
 * person pasting a session token into the claim field should be told so by the
 * shape rather than by an opaque refusal from the database.
 */
export const CLAIM_TOKEN_PREFIX = 'tm8c_';

/** 32 random bytes, base64url — the same generator the session secret uses. */
export function generateClaimToken(): string {
  return `${CLAIM_TOKEN_PREFIX}${generateSecret()}`;
}

/**
 * Whether any active account on this node has a credential.
 *
 * CLAIM-FREE: a caller deciding whether to claim has no identity yet. This is
 * the read behind `auth.claim.status` and the guard the minting path consults.
 */
export async function nodeIsClaimed(db: Db): Promise<boolean> {
  const claimed = await db.rpc<boolean | null>({}, 'node_is_claimed', []);
  return claimed === true;
}

/**
 * Mint and record a claim token, hash only.
 *
 * Returns the PLAINTEXT to its one caller (the boot path), which prints it and
 * writes it to `<dataDir>/setup-token`. It is never returned over HTTP and
 * never stored: `node_claim_tokens` holds the sha256 alone, so a database dump
 * of an unclaimed node is not a way to claim it.
 *
 * The RPC refuses once the node is claimed, and burns any prior live token, so
 * exactly one claim URL is valid at a time.
 */
export async function issueNodeClaimToken(db: Db): Promise<string> {
  const token = generateClaimToken();
  await db.rpc({}, 'issue_node_claim_token', [hashToken(token.slice(CLAIM_TOKEN_PREFIX.length))]);
  return token;
}

/**
 * Is this exact plaintext still a live claim token?
 *
 * The boot path asks before minting, so an ordinary restart REPRINTS the token
 * it already issued. Minting unconditionally burned the previous one, which
 * quietly broke the design's own no-expiry promise: an operator who saved the
 * first boot's URL and restarted before claiming found a dead link and no
 * indication why.
 */
export async function claimTokenIsLive(db: Db, token: string): Promise<boolean> {
  if (!token.startsWith(CLAIM_TOKEN_PREFIX)) return false;
  const live = await db.rpc<boolean | null>({}, 'node_claim_token_is_live', [
    hashToken(token.slice(CLAIM_TOKEN_PREFIX.length)),
  ]);
  return live === true;
}

export interface ClaimNodeInput {
  token: string;
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  kind?: 'browser' | 'cli';
}

/**
 * The claim ceremony: set the first credential on the node's EXISTING owner
 * account, then sign in.
 *
 * CLAIM-FREE — the token is the authorization, which is exactly what lets this
 * run from a device that is not the server. Every guard that matters
 * (token validity, single-use, and the re-assertion that the node is still
 * unclaimed) is inside `claim_node`, under one lock, so two concurrent claims
 * serialize rather than racing.
 *
 * The session is minted by delegating to `loginWithPassword` with the
 * credential just set, rather than by minting one here. That is deliberate:
 * session issuance, TTL selection, the profile read and the disabled-account
 * check are all non-trivial and already proven on the login path, and a second
 * copy of them would be a second place for them to drift. It costs one extra
 * scrypt verification — on a once-per-node ceremony.
 */
export async function claimNode(
  db: Db,
  input: ClaimNodeInput,
  requestId?: string,
): Promise<IssuedLogin> {
  if (!input.token.startsWith(CLAIM_TOKEN_PREFIX)) {
    throw new CollabError('unauthenticated', 'invalid or already-used claim token');
  }
  const passwordHash = await hasher.hash(input.password);

  await db.rpc<AccountRowJson | null>({}, 'claim_node', [
    hashToken(input.token.slice(CLAIM_TOKEN_PREFIX.length)),
    input.username,
    hasher.algorithm,
    passwordHash,
    input.displayName ?? null,
    input.email ?? null,
  ]);

  return loginWithPassword(
    db,
    {
      username: input.username,
      password: input.password,
      ...(input.kind ? { kind: input.kind } : {}),
      label: 'first-run claim',
    },
    requestId,
  );
}

/* ── password change (docs/identity/FIRST-RUN-CLAIM-DESIGN.md §10.3) ──────── */

export interface ChangePasswordInput {
  accountId: string;
  identityId: string;
  username: string;
  currentPassword: string;
  newPassword: string;
  /** The session to keep alive; null for a loopback auto-owner (no session). */
  keepSessionId: string | null;
}

/**
 * Rotate the caller's OWN credential — CHANGE, not reset.
 *
 * The current password is proven with the same claim-free credential read and
 * constant-work scrypt the login path uses. Requiring it even though the caller
 * is already authenticated is the whole security posture of this operation: a
 * walk-up on an unlocked screen, or a stolen live session, must not be able to
 * silently re-credential the account and lock the real owner out. There is no
 * reset-without-the-old-password variant — that needs an out-of-band capability
 * this lane deliberately does not invent.
 *
 * The write is 007's `set_account_credential` under the caller's own claims (an
 * account may set its own credential without node admin), and then every OTHER
 * live session is revoked while the one making the change is spared. Both run in
 * one transaction so a credential is never rotated without its session sweep.
 */
export async function changePassword(
  db: Db,
  input: ChangePasswordInput,
  requestId?: string,
): Promise<{ accountId: string; revokedOtherSessions: number }> {
  const row = await db.rpc<ResolvedCredential | null>({}, 'resolve_account_credential', [
    input.username,
  ]);

  const verifier = row?.passwordHash ?? UNMATCHABLE_VERIFIER;
  const ok = await hasher.verify(input.currentPassword, verifier);
  // No stored credential means an unclaimed loopback owner: there is no password
  // to change — they claim, they do not rotate. Same uniform refusal as a wrong
  // current password, so neither state is enumerable.
  if (!row || !row.passwordHash || !ok) throw invalidCredentials();
  if (row.status !== 'active') throw invalidCredentials();
  // The credential the caller proved must belong to the account they are
  // authenticated as. It always should; a mismatch means the username resolved
  // to someone else's row, which must never rotate under this caller's identity.
  if (row.accountId !== input.accountId) throw invalidCredentials();

  const newHash = await hasher.hash(input.newPassword);
  const claims = { identityId: input.identityId, ...(requestId ? { requestId } : {}) };
  const revoked = await db.tx(claims, async (q) => {
    await q.rpc('set_account_credential', [input.accountId, newHash, hasher.algorithm]);
    return q.rpc<number>('revoke_account_sessions_except', [
      input.accountId,
      input.keepSessionId,
    ]);
  });

  return { accountId: input.accountId, revokedOtherSessions: revoked ?? 0 };
}

/* ── invite-bound self-signup (docs/identity/FIRST-RUN-CLAIM-DESIGN.md D5) ── */

export interface SignupViaInviteInput {
  code: string;
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  kind?: 'browser' | 'cli';
}

export interface IssuedInviteSignup extends IssuedLogin {
  spaceId: string;
  memberId: string;
}

/**
 * Redeem an invite that CREATES the account — the last piece of D5.
 *
 * CLAIM-FREE: the invited person has no identity until this call, so the code is
 * the only authorization, exactly as it is for `auth.invite.resolve`.
 * `signup_via_invite` creates the account, the profile, the membership and
 * consumes the invite atomically, hard-coding a non-admin non-owner account.
 *
 * Then it SIGNS THEM IN by delegating to `loginWithPassword` with the credential
 * just set — the same pattern `claimNode` follows, and for the same reason: TTL
 * selection, the profile read, the disabled-account check and session issuance
 * are all proven on the login path, and a second copy would be a second place
 * for them to drift.
 */
export async function signupViaInvite(
  db: Db,
  input: SignupViaInviteInput,
  requestId?: string,
): Promise<IssuedInviteSignup> {
  const identityId = `id_${randomUUID()}`;
  const passwordHash = await hasher.hash(input.password);

  const created = await db.rpc<{
    account: AccountRowJson;
    spaceId: string;
    memberId: string;
  } | null>({}, 'signup_via_invite', [
    input.code,
    identityId,
    input.username,
    input.displayName ?? null,
    input.email ?? null,
    hasher.algorithm,
    passwordHash,
  ]);
  if (!created) {
    throw new CollabError('upstream_unavailable', 'signup_via_invite returned no row');
  }

  const issued = await loginWithPassword(
    db,
    {
      username: input.username,
      password: input.password,
      ...(input.kind ? { kind: input.kind } : {}),
      label: 'invite signup',
    },
    requestId,
  );

  return { ...issued, spaceId: created.spaceId, memberId: created.memberId };
}

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

/**
 * R6 expiry: browser 30d, cli 90d, agent 48h.
 *
 * The agent value is a BACKSTOP, not the mechanism. An agent bearer should die
 * when its agent does, and two things now make that happen: the exit sink
 * revokes it (facade/execution-handlers.ts), and a sweep keyed on PTY liveness
 * catches the deaths the sink misses — a signal kill, a crashed node, a
 * process that never reached its exit handler (scheduler/jobs/agent-sessions.ts).
 * This constant only bounds the case where BOTH fail.
 *
 * Why 48h and not something aggressive: measured on this node, work sessions
 * run to a p95 of ~1d8h and a maximum of ~1d22h. A 24h ceiling would cut live
 * agents off from their own credential mid-run, which is a worse failure than
 * the one being fixed. 48h clears the longest observed session with margin and
 * still cuts the orphan window by 3.5x.
 *
 * The narrower fix — restoring the liveness clause 072:36-59 had, which
 * 074:26-41 dropped when it redefined `resolve_auth_session` — is deliberately
 * NOT taken here: `work_session_transition` is `require_space_member` only, so
 * until session lifecycle is gated it would let any space member revoke any
 * other member's live agent credential with one call.
 */
export const SESSION_TTL_MS = { browser: 30 * DAY, cli: 90 * DAY, agent: 48 * HOUR } as const;

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

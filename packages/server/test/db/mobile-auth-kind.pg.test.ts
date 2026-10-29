/**
 * The `mobile` auth kind (TM8 Mobile S4, task 01a1867c), on one scratch database
 * (TM8_W1_ADMIN_DATABASE_URL; the 5443 staging cluster on the tm8 host).
 *
 * The phone signs in as itself: a human bearer session, 90 days like `cli`,
 * never a cookie, admitted by every human-only door and listed with its kind
 * and label. The real composition root answers over HTTP for the three sign-in
 * paths (auth.claim, auth.login, auth.invite.signup), auth.space.enter,
 * auth.sessions.list and a catalog human-only read. The doors the migration
 * widened are then driven as RPCs under claims, and the end state is read off
 * the catalog: no live function or CHECK names 'browser' and 'cli' without
 * 'mobile' (the static twin is test/mobile-auth-kind-migration.test.ts).
 *
 * Nothing here logs a token.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuthClaimResultSchema,
  AuthInviteSignupResultSchema,
  AuthLoginResultSchema,
  AuthSessionGetResultSchema,
  AuthSessionsListResultSchema,
  AuthSpaceEnterResultSchema,
  type AuthClaimResult,
  type AuthInviteSignupResult,
  type AuthLoginResult,
  type AuthSessionGetResult,
  type AuthSessionsListResult,
  type AuthSpaceEnterResult,
} from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { generateSecret, hashToken } from '../../src/identity/crypto.js';
import { DEFAULT_SESSION_TTL_MS } from '../../src/identity/index.js';
import { hashSpacePassword, SESSION_TTL_MS } from '../../src/identity/pg-auth.js';
import { startW3PublicServer, type W3PublicServer } from '../w3/public-harness.js';

const DAY = 24 * 60 * 60 * 1000;
const LABEL = 'TM8 Mobile · iPhone';
const OWNER = { username: 'mobileowner', password: 'owner-password-123' };

interface Wire<T> {
  status: number;
  data: T | undefined;
  error: { code: string; message: string } | undefined;
  cookie: string | null;
}

let server: W3PublicServer;
let db: Db;
let claim: Wire<AuthClaimResult>;
let login: Wire<AuthLoginResult>;

/** One HTTP call on the booted server; a bearer only when `token` is given. */
async function send<T>(method: string, path: string, body?: unknown, token?: string): Promise<Wire<T>> {
  const response = await fetch(new URL(path, server.baseUrl), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json() as { data?: T; error?: { code: string; message: string } };
  return { status: response.status, data: parsed.data, error: parsed.error, cookie: response.headers.get('set-cookie') };
}

/** Days from now until `iso`. */
const daysLeft = (iso: string): number => (Date.parse(iso) - Date.now()) / DAY;

/** A space the loopback auto-owner (the node owner) creates, so the owner is its owner member. */
async function ownSpace(tag: string): Promise<string> {
  const created = await send<{ space: { id: string } }>('POST', '/v2/spaces', {
    name: `mobile-${tag}-${randomUUID().slice(0, 8)}`,
    clientMutationId: `mobile-space-${randomUUID()}`,
  });
  expect(created.status).toBe(201);
  return created.data!.space.id;
}

/** A fresh member invite into a fresh space, redeemed by a new person signing in as `kind`. */
async function inviteSignup(kind: 'browser' | 'cli' | 'mobile'): Promise<Wire<AuthInviteSignupResult>> {
  const spaceId = await ownSpace(`invite-${kind}`);
  const invite = await send<{ invite?: { code: string }; code?: string }>('POST', `/v2/spaces/${spaceId}/invites`, {
    role: 'member', maxUses: 1, clientMutationId: `mobile-invite-${randomUUID()}`,
  });
  const code = invite.data!.invite?.code ?? invite.data!.code;
  return send<AuthInviteSignupResult>('POST', '/v2/auth/invite/signup', {
    code, username: `invitee-${kind}-${randomUUID().slice(0, 8)}`, password: 'invitee-password-123', kind,
  });
}

/** The SQLSTATE a refused call raised, or `'ok'`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

const ownerClaims = (authKind: string): DbClaims => ({
  identityId: claim.data!.account.identityId,
  authKind,
  requestId: `mobile-kind-${randomUUID()}`,
} as DbClaims);

beforeAll(async () => {
  server = await startW3PublicServer('mobile_kind');
  db = createDb(server.database.url, { max: 4 });
  const token = (await readFile(join(server.dataDir, 'setup-token'), 'utf8')).trim();
  claim = await send<AuthClaimResult>('POST', '/v2/auth/claim', { token, ...OWNER, kind: 'mobile' });
  login = await send<AuthLoginResult>('POST', '/v2/auth/login', { ...OWNER, kind: 'mobile', label: LABEL });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await server?.close();
}, 180_000);

describe.sequential('the three sign-in paths mint a mobile session (HTTP)', () => {
  it('auth.claim {kind: mobile}: the owner signs in on a mobile session, 90 days, no cookie', () => {
    expect(claim.status).toBe(200);
    expect(AuthClaimResultSchema.safeParse(claim.data).error?.issues).toBeUndefined();
    expect(claim.data!.session.kind).toBe('mobile');
    expect(daysLeft(claim.data!.session.expiresAt)).toBeGreaterThan(89.9);
    expect(daysLeft(claim.data!.session.expiresAt)).toBeLessThanOrEqual(90);
    expect(claim.cookie).toBeNull();
  });

  it('auth.login {kind: mobile, label}: the live TTL path gives 90 days and no cookie; the row stores kind and label', async () => {
    expect(login.status).toBe(200);
    const session = login.data!.session;
    expect(session).toMatchObject({ kind: 'mobile', label: LABEL, actingAsTeamMemberId: null });
    expect(Math.abs(Date.parse(session.expiresAt) - Date.parse(session.createdAt!) - SESSION_TTL_MS.mobile)).toBeLessThan(60_000);
    expect(login.cookie).toBeNull();
    const [row] = await server.rows<{ kind: string; label: string; days: number }>(
      `select kind, label, extract(epoch from expires_at - created_at) / 86400 as days
         from public.auth_sessions where id = $1`, [session.sessionId]);
    expect(row).toMatchObject({ kind: 'mobile', label: LABEL });
    expect(Number(row!.days)).toBeCloseTo(90, 2);
  });

  it('90 days in both TTL tables: the live one (pg-auth) and the unwired identity/service.ts copy', () => {
    expect(SESSION_TTL_MS.mobile).toBe(90 * DAY);
    expect(SESSION_TTL_MS.mobile).toBe(SESSION_TTL_MS.cli);
    expect(DEFAULT_SESSION_TTL_MS.mobile).toBe(SESSION_TTL_MS.mobile);
  });

  it('positive control: a browser login sets the session cookie and lives 30 days; mobile never gets that ambient authority', async () => {
    const browser = await send<AuthLoginResult>('POST', '/v2/auth/login', { ...OWNER, kind: 'browser' });
    expect(browser.status).toBe(200);
    expect(browser.data!.session.kind).toBe('browser');
    expect(browser.cookie).not.toBeNull();
    expect(daysLeft(browser.data!.session.expiresAt)).toBeLessThanOrEqual(30);
  });

  it('auth.login refuses a kind no person signs in as (400), and mints nothing', async () => {
    const count = async (): Promise<number> => Number((await server.rows<{ n: string }>(
      'select count(*) as n from public.auth_sessions'))[0]!.n);
    const before = await count();
    for (const kind of ['agent', 'agent_runtime', 'link', 'Mobile']) {
      const refused = await send('POST', '/v2/auth/login', { ...OWNER, kind });
      expect([kind, refused.status, refused.error?.code]).toEqual([kind, 400, 'invalid_input']);
    }
    expect(await count()).toBe(before);
  });

  it('auth.invite.signup {kind: mobile}: an invited person joins and is signed in on a mobile session', async () => {
    const signup = await inviteSignup('mobile');
    expect(signup.status).toBe(200);
    expect(signup.data!.session.kind).toBe('mobile');
    expect(daysLeft(signup.data!.session.expiresAt)).toBeGreaterThan(89.9);
    expect(signup.cookie).toBeNull();
  });
});

describe('every sign-in result is in its contract shape (ISO-8601 UTC timestamps), whatever the kind', () => {
  it('auth.login, auth.invite.signup, auth.space.enter and auth.session.get results parse for browser, cli and mobile', async () => {
    const spaceId = await ownSpace('shapes');
    for (const kind of ['browser', 'cli', 'mobile'] as const) {
      const signedIn = await send<AuthLoginResult>('POST', '/v2/auth/login', { ...OWNER, kind, label: LABEL });
      expect([kind, AuthLoginResultSchema.safeParse(signedIn.data).error?.issues]).toEqual([kind, undefined]);
      expect(signedIn.data!.session.kind).toBe(kind);
      const joined = await inviteSignup(kind);
      expect([kind, AuthInviteSignupResultSchema.safeParse(joined.data).error?.issues]).toEqual([kind, undefined]);
      const entered = await send<AuthSpaceEnterResult>('POST', '/v2/auth/space/enter', { spaceId }, signedIn.data!.token);
      expect([kind, AuthSpaceEnterResultSchema.safeParse(entered.data).error?.issues]).toEqual([kind, undefined]);
      expect(entered.data!.session.kind).toBe(kind);
      const current = await send<AuthSessionGetResult>('GET', '/v2/auth/session', undefined, signedIn.data!.token);
      expect([kind, AuthSessionGetResultSchema.safeParse(current.data).error?.issues]).toEqual([kind, undefined]);
      expect(current.data!.session).toMatchObject({ kind, label: LABEL });
    }
  });
});

describe.sequential('a mobile session at the human-only doors (HTTP)', () => {
  it('auth.sessions.list (humans only in SQL) shows the session with its kind and label, in the contract shape', async () => {
    const listed = await send<AuthSessionsListResult>('GET', '/v2/auth/sessions', undefined, login.data!.token);
    expect(listed.status).toBe(200);
    expect(AuthSessionsListResultSchema.safeParse(listed.data).success).toBe(true);
    const mine = listed.data!.sessions.find((row) => row.sessionId === login.data!.session.sessionId);
    expect(mine).toMatchObject({ kind: 'mobile', label: LABEL, origin: 'login', spaceId: null, current: true });
    expect(JSON.stringify(listed.data)).not.toContain(login.data!.token);
  });

  it('auth.space.enter from a mobile gate mints a mobile session pinned to the space, no cookie; the gate lists it', async () => {
    const spaceId = await ownSpace('enter');
    const gate = login.data!;
    const entered = await send<AuthSpaceEnterResult>('POST', '/v2/auth/space/enter', { spaceId, label: LABEL }, gate.token);
    expect(entered.status).toBe(200);
    expect(entered.data!.session).toMatchObject({ kind: 'mobile', spaceId, label: LABEL });
    expect(Date.parse(entered.data!.session.expiresAt)).toBeLessThanOrEqual(Date.parse(gate.session.expiresAt));
    expect(entered.cookie).toBeNull();
    const listed = await send<AuthSessionsListResult>('GET', '/v2/auth/sessions', undefined, gate.token);
    expect(listed.data!.sessions.find((row) => row.sessionId === entered.data!.session.sessionId)).toMatchObject({
      kind: 'mobile', origin: 'space_enter', spaceId, parentSessionId: gate.session.sessionId,
    });
  });

  it('a catalog humanOnly read (credentials.status) answers a mobile bearer', async () => {
    const status = await send('GET', '/v2/identity/credentials', undefined, login.data!.token);
    expect([status.status, status.error?.code]).toEqual([200, undefined]);
  });

  it('auth.sessions.list still parses when the member also holds a stored space-link session', async () => {
    const spaceId = await ownSpace('link');
    const [link] = await server.rows<{ id: string }>(
      `insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id)
       values ($1, 'link', $2, 'link probe', now() + interval '1 hour', $3) returning id::text`,
      [claim.data!.account.accountId, hashToken(generateSecret()), spaceId]);
    const listed = await send<AuthSessionsListResult>('GET', '/v2/auth/sessions', undefined, login.data!.token);
    expect(listed.data!.sessions.find((row) => row.sessionId === link!.id)).toMatchObject({ kind: 'link', origin: 'link' });
    expect(AuthSessionsListResultSchema.safeParse(listed.data).error?.issues).toBeUndefined();
    await server.rows('update public.auth_sessions set revoked_at = now() where id = $1', [link!.id]);
  });
});

describe.sequential('the doors the migration widened (RPC under claims)', () => {
  it('internal.require_human_auth_kind() admits browser, cli and mobile, and refuses every other kind (42501)', async () => {
    const door = (kind: string | null) => server.database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      if (kind !== null) await client.query(`select set_config('tm8.auth_kind', $1, true)`, [kind]);
      await client.query('select internal.require_human_auth_kind()');
    });
    const verdicts: Record<string, string> = {};
    for (const kind of ['browser', 'cli', 'mobile', 'agent', 'agent_runtime', 'link', 'Mobile', '', null]) {
      verdicts[String(kind)] = await outcome(() => door(kind));
    }
    expect(verdicts).toEqual({
      browser: 'ok', cli: 'ok', mobile: 'ok',
      agent: '42501', agent_runtime: '42501', link: '42501', Mobile: '42501', '': '42501', null: '42501',
    });
  });

  it('enter_space admits a mobile gate and the pinned row inherits mobile; an agent-kind caller is still refused', async () => {
    const spaceId = await ownSpace('rpc-enter');
    const account = claim.data!.account.accountId;
    const gate = await db.tx(ownerClaims('mobile'), (q) => q.rpc<{ id: string; kind: string }>('issue_auth_session', [
      account, hashToken(generateSecret()), 'mobile', new Date(Date.now() + DAY).toISOString(), null, LABEL,
    ]));
    expect(gate.kind).toBe('mobile');
    const enter = (authKind: string) => db.tx(ownerClaims(authKind), (q) => q.rpc<{ kind: string; space_id: string }>('enter_space', [
      spaceId, gate.id, hashToken(generateSecret()), new Date(Date.now() + DAY).toISOString(), LABEL, null,
    ]));
    expect(await enter('mobile')).toMatchObject({ kind: 'mobile', space_id: spaceId });
    expect(await outcome(() => enter('agent'))).toBe('42501');
  });

  it('requiring a space password ends the space\'s mobile pinned sessions too, and leaves other spaces\' alone', async () => {
    const spaceId = await ownSpace('require');
    const elsewhere = await ownSpace('elsewhere');
    const account = claim.data!.account.accountId;
    const pin = async (target: string): Promise<string> => {
      const gate = await db.tx(ownerClaims('mobile'), (q) => q.rpc<{ id: string }>('issue_auth_session', [
        account, hashToken(generateSecret()), 'mobile', new Date(Date.now() + DAY).toISOString(), null, LABEL,
      ]));
      const pinned = await db.tx(ownerClaims('mobile'), (q) => q.rpc<{ id: string }>('enter_space', [
        target, gate.id, hashToken(generateSecret()), new Date(Date.now() + DAY).toISOString(), LABEL, null,
      ]));
      return pinned.id;
    };
    const inSpace = await pin(spaceId);
    const inOther = await pin(elsewhere);
    const verifier = await hashSpacePassword(`sp-${randomUUID()}`);
    const on = await db.tx(ownerClaims('mobile'), (q) => q.rpc<{ revokedSessionIds: string[] }>(
      'set_space_require_credential', [spaceId, true, verifier]));
    expect(on.revokedSessionIds).toContain(inSpace);
    expect(on.revokedSessionIds).not.toContain(inOther);
    const revoked = await server.rows<{ id: string; revoked: boolean }>(
      'select id::text, revoked_at is not null as revoked from public.auth_sessions where id = any($1::uuid[])',
      [[inSpace, inOther]]);
    expect(Object.fromEntries(revoked.map((row) => [row.id, row.revoked]))).toEqual({ [inSpace]: true, [inOther]: false });
  });

  it('a mobile session token resolves and is refused once revoked (logout ends it)', async () => {
    const fresh = await send<AuthLoginResult>('POST', '/v2/auth/login', { ...OWNER, kind: 'mobile', label: LABEL });
    const token = fresh.data!.token;
    expect((await send('GET', '/v2/auth/session', undefined, token)).status).toBe(200);
    expect((await send('POST', '/v2/auth/logout', {}, token)).status).toBe(200);
    expect((await send('GET', '/v2/auth/session', undefined, token)).status).toBe(401);
  });
});

describe('end state: every kind list that names browser and cli names mobile', () => {
  it('no live function in public or internal is left with browser and cli but not mobile', async () => {
    const rows = await server.rows<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'internal')
          and exists (
            select 1 from regexp_matches(p.prosrc, '\\(([^()]*''cli''[^()]*)\\)', 'g') m(list)
             where m.list[1] like '%''browser''%' and m.list[1] not like '%''mobile''%')
        order by 1`);
    expect(rows.map((row) => row.fn)).toEqual([]);
  });

  it('no CHECK constraint names cli without mobile (auth_sessions.kind and chat_turns.requested_by_auth_kind admit it)', async () => {
    const rows = await server.rows<{ name: string; def: string }>(
      `select c.conrelid::regclass::text || ' ' || c.conname as name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c where pg_get_constraintdef(c.oid) like '%''cli''%' order by 1`);
    expect(rows.filter((row) => !row.def.includes("'mobile'")).map((row) => row.name)).toEqual([]);
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'auth_sessions auth_sessions_kind_check',
      'chat_turns chat_turns_requested_by_auth_kind_check',
    ]));
  });
});

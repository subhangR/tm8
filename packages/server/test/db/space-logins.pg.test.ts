/**
 * W5 (K2, decision 30) — per-space credentials: `space_logins` (268).
 *
 * Two spaces, C and D, both owned by O. A is an admin of C; M is a plain
 * member of both; N is a member of C who never gets a space password. Each
 * refusal below has its paired positive in the same `it`, and the SQL cells
 * are exercised through the same claims the server binds (browser gate
 * sessions minted by `issue_auth_session`).
 *
 *   a1  setting on → a gate session alone is refused `enter_space`.
 *   a2  a space password works only for its own space.
 *   a3  setting off → `enter_space` behaves exactly as W3-server did.
 *   a4  both invite paths (signup_via_invite, redeem_invite) set the space
 *       password when the setting is on.
 *   a5  admin reset and lock work, and are human-only.
 *
 * No plaintext password reaches SQL or this file's output: passwords are
 * random per run and only their scrypt verifiers are passed to SQL.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import {
  checkSpacePassword,
  enterSpace,
  hashSpacePassword,
  inviteRequiresSpacePassword,
  signupViaInvite,
} from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Person {
  identity: string;
  account: string;
}

interface Fixture {
  spaceC: string;
  spaceD: string;
  O: Person;
  A: Person;
  M: Person;
  N: Person;
  P: Person;
  Q: Person;
  memberOC: string;
  memberAC: string;
  memberMC: string;
  memberMD: string;
  memberNC: string;
}

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;

const password = (): string => `sp-${randomUUID()}`;

function claims(who: Person, authKind = 'browser', sessionSpaceId?: string): DbClaims {
  return {
    identityId: who.identity,
    authKind,
    requestId: `space-logins-${randomUUID()}`,
    ...(sessionSpaceId ? { sessionSpaceId } : {}),
  } as DbClaims;
}

function as<T>(who: Person, fn: (q: Querier) => Promise<T>, authKind = 'browser'): Promise<T> {
  return db.tx(claims(who, authKind), fn);
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

/** The facade refusal reason (`details.reason`), or `'ok'`. */
async function reason(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof CollabError) return `${err.code}:${String(err.details?.reason ?? '')}`;
    throw err;
  }
}

const cmid = (): string => `space-logins-${randomUUID()}`;

async function gateSession(who: Person): Promise<string> {
  const secret = generateSecret();
  const row = await as(who, (q) => q.rpc<{ id: string }>('issue_auth_session', [
    who.account, hashToken(secret), 'browser',
    new Date(Date.now() + 3_600_000).toISOString(), null, 'space-logins gate',
  ]));
  return formatToken(row.id, secret);
}

/** `enter_space` straight in SQL with `verifier` (or none). Returns the pinned session id. */
async function enterSql(who: Person, spaceId: string, verifier: string | null = null): Promise<string> {
  const gate = await gateSession(who);
  const row = await as(who, (q) => q.rpc<{ id: string; space_id: string }>('enter_space', [
    spaceId, parseToken(gate)!.sessionId, hashToken(generateSecret()),
    new Date(Date.now() + 3_600_000).toISOString(), 'space-logins pinned', verifier,
  ]));
  expect(row.space_id).toBe(spaceId);
  return row.id;
}

/** The facade path: check the password in TypeScript, then mint. */
async function enterWithPassword(who: Person, spaceId: string, pw: string | undefined): Promise<string> {
  const gate = await gateSession(who);
  const c = claims(who);
  const verifier = await checkSpacePassword(db, c, spaceId, pw);
  const issued = await enterSpace(db, c, {
    spaceId, parentSessionId: parseToken(gate)!.sessionId, kind: 'browser', spaceVerifier: verifier,
  });
  return issued.session.sessionId;
}

async function setRequired(who: Person, spaceId: string, required: boolean, ownPassword?: string): Promise<unknown> {
  const verifier = ownPassword ? await hashSpacePassword(ownPassword) : null;
  return as(who, (q) => q.rpc('set_space_require_credential', [spaceId, required, verifier]));
}

async function reset(who: Person, spaceId: string, memberId: string, pw: string, authKind = 'browser') {
  const verifier = await hashSpacePassword(pw);
  return as(who, (q) => q.rpc<{ status: string; revokedSessionIds: string[] }>(
    'reset_space_login', [spaceId, memberId, verifier]), authKind);
}

function lock(who: Person, spaceId: string, memberId: string, locked: boolean, authKind = 'browser') {
  return as(who, (q) => q.rpc<{ status: string; revokedSessionIds: string[] }>(
    'set_space_login_locked', [spaceId, memberId, locked]), authKind);
}

async function loginRow(spaceId: string, accountId: string) {
  return (await database.query<{ status: string; verifier: string }>(
    'select status, verifier from public.space_logins where space_id = $1 and account_id = $2',
    [spaceId, accountId]))[0];
}

async function revokedAt(sessionId: string): Promise<Date | null> {
  return (await database.query<{ revoked_at: Date | null }>(
    'select revoked_at from public.auth_sessions where id = $1', [sessionId]))[0]!.revoked_at;
}

async function invite(spaceId: string): Promise<string> {
  const row = await as(f.O, (q) => q.rpc<{ invite: { code: string } }>(
    'create_invite', [spaceId, 5, null, null, cmid(), 'member']));
  return row.invite.code;
}

async function seed(): Promise<Fixture> {
  const person = (tag: string): Person => ({ identity: `space-logins-${tag}-${randomUUID()}`, account: randomUUID() });
  const ids = {
    spaceC: randomUUID(),
    spaceD: randomUUID(),
    O: person('o'),
    A: person('a'),
    M: person('m'),
    N: person('n'),
    P: person('p'),
    Q: person('q'),
    memberOC: randomUUID(),
    memberOD: randomUUID(),
    memberAC: randomUUID(),
    memberMC: randomUUID(),
    memberMD: randomUUID(),
    memberNC: randomUUID(),
  };
  const people = [ids.O, ids.A, ids.M, ids.N, ids.P, ids.Q];
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    for (const [i, p] of people.entries()) {
      await client.query('insert into public.user_profiles(identity_id, display_name) values ($1, $2)',
        [p.identity, `SL${i}`]);
      await client.query('insert into public.accounts(id, identity_id, username) values ($1, $2, $3)',
        [p.account, p.identity, `space-logins-${i}-${randomUUID().slice(0, 8)}`]);
    }
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Space logins C', $3), ($2, 'Space logins D', $3)`,
      [ids.spaceC, ids.spaceD, ids.O.identity],
    );
    const members: Array<[string, string, Person, string]> = [
      [ids.memberOC, ids.spaceC, ids.O, 'owner'],
      [ids.memberOD, ids.spaceD, ids.O, 'owner'],
      [ids.memberAC, ids.spaceC, ids.A, 'admin'],
      [ids.memberMC, ids.spaceC, ids.M, 'member'],
      [ids.memberMD, ids.spaceD, ids.M, 'member'],
      [ids.memberNC, ids.spaceC, ids.N, 'member'],
    ];
    // signup_via_invite needs a claimed node (143): O holds a password.
    await client.query(
      `update public.accounts set password_algorithm = 'scrypt', password_hash = $2 where id = $1`,
      [ids.O.account, await hashSpacePassword(password())]);
    for (const [entityId, spaceId, p, role] of members) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'member', $1, 'space')`, [entityId, spaceId]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, $4, $5)`, [entityId, spaceId, p.identity, role, role]);
    }
  });
  return ids;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_logins');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe.sequential('W5 space_logins — the setting (require_space_credential)', () => {
  it('a3: setting off → no prompt, and enter_space admits a member with no verifier (W3 behaviour)', async () => {
    const need = await as(f.M, (q) => q.rpc<{ required: boolean }>('space_login_for_enter', [f.spaceC]));
    expect(need.required).toBe(false);
    expect(await outcome(() => enterSql(f.M, f.spaceC))).toBe('ok');
    expect(await outcome(() => enterWithPassword(f.M, f.spaceC, undefined))).toBe('ok');
  });

  it('the column is written only by set_space_require_credential: a direct UPDATE is refused (42501); positive: the op writes it', async () => {
    expect(await outcome(() => database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.spaces set require_space_credential = true where id = $1', [f.spaceD]);
    }))).toBe('42501');
    const pw = password();
    expect(await setRequired(f.O, f.spaceD, true, pw)).toEqual({ spaceId: f.spaceD, requireSpacePassword: true, revokedSessionIds: [] });
    expect(await setRequired(f.O, f.spaceD, false)).toEqual({ spaceId: f.spaceD, requireSpacePassword: false, revokedSessionIds: [] });
  });

  it('only a space admin sets it: member M is refused (42501); positive: admin A turns it off', async () => {
    expect(await outcome(() => setRequired(f.M, f.spaceC, true, password()))).toBe('42501');
    expect(await outcome(() => setRequired(f.M, f.spaceC, false))).toBe('42501');
    expect(await outcome(() => setRequired(f.A, f.spaceC, false))).toBe('ok');
  });

  it('human-only: an agent-kind caller is refused (42501); positive: the same identity as a cli session', async () => {
    const verifier = await hashSpacePassword(password());
    expect(await outcome(() => as(f.O, (q) => q.rpc('set_space_require_credential', [f.spaceC, false, verifier]), 'agent'))).toBe('42501');
    expect(await outcome(() => as(f.O, (q) => q.rpc('set_space_require_credential', [f.spaceC, false, verifier]), 'cli'))).toBe('ok');
  });

  it('turning it on needs the admin\'s own space password when they have none (22023); positive: with one', async () => {
    const fresh = await database.query<{ n: number }>(
      'select count(*)::int n from public.space_logins where space_id = $1 and account_id = $2', [f.spaceC, f.O.account]);
    expect(fresh[0]!.n).toBe(0);
    expect(await outcome(() => setRequired(f.O, f.spaceC, true))).toBe('22023');
    expect(await outcome(() => setRequired(f.O, f.spaceC, true, 'x'.repeat(8)))).toBe('ok');
    // Leave C ON for the next describe, with O's password known.
  });

  it('turning it ON is owner-only: admin A is refused (42501), even with its own password; positive: owner O', async () => {
    expect(await outcome(() => setRequired(f.A, f.spaceC, false))).toBe('ok');
    expect(await outcome(() => setRequired(f.A, f.spaceC, true, password()))).toBe('42501');
    expect(await loginRow(f.spaceC, f.A.account)).toBeUndefined();
    expect(await outcome(() => setRequired(f.O, f.spaceC, true))).toBe('ok');
  });

  it('a verifier that is not a scrypt string is refused (22023) — plaintext cannot be stored', async () => {
    expect(await outcome(() => as(f.O, (q) => q.rpc('set_space_require_credential', [f.spaceC, true, 'plaintext-password'])))).toBe('22023');
    const row = await loginRow(f.spaceC, f.O.account);
    expect(row!.verifier).toMatch(/^scrypt\$/);
    expect(row!.verifier).not.toContain('x'.repeat(8));
  });
});

describe.sequential('W5 space_logins — entering (a1, a2)', () => {
  const pwM = { C: password(), D: password() };

  it('a1: setting on → a gate session alone is refused; positive: the owner with their password is admitted', async () => {
    expect(await outcome(() => enterSql(f.O, f.spaceC))).toBe('42501');
    expect(await reason(() => enterWithPassword(f.O, f.spaceC, undefined))).toBe('forbidden:space_password_required');
    expect(await reason(() => enterWithPassword(f.O, f.spaceC, 'x'.repeat(8)))).toBe('ok');
  });

  it('a1: a member with no space password is refused whatever they send; positive: after an admin reset, admitted', async () => {
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pwM.C))).toBe('forbidden:space_password_rejected');
    await reset(f.A, f.spaceC, f.memberMC, pwM.C);
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pwM.C))).toBe('ok');
  });

  it('a1: a wrong password is refused; positive: the right one is admitted', async () => {
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, password()))).toBe('forbidden:space_password_rejected');
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pwM.C))).toBe('ok');
  });

  it('a1: enter_space binds the verifier — a guessed/forged one is refused in SQL; positive: the active one', async () => {
    const forged = await hashSpacePassword(pwM.C); // same password, different salt: not the row's verifier
    expect(await outcome(() => enterSql(f.M, f.spaceC, forged))).toBe('42501');
    expect(await outcome(async () => enterSql(f.M, f.spaceC, (await loginRow(f.spaceC, f.M.account))!.verifier))).toBe('ok');
  });

  it('a2: C\'s password does not open D; positive: D\'s own password does', async () => {
    await setRequired(f.O, f.spaceD, true, password());
    await reset(f.O, f.spaceD, f.memberMD, pwM.D);
    expect(await reason(() => enterWithPassword(f.M, f.spaceD, pwM.C))).toBe('forbidden:space_password_rejected');
    const verifierC = (await loginRow(f.spaceC, f.M.account))!.verifier;
    expect(await outcome(() => enterSql(f.M, f.spaceD, verifierC))).toBe('42501');
    expect(await reason(() => enterWithPassword(f.M, f.spaceD, pwM.D))).toBe('ok');
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pwM.D))).toBe('forbidden:space_password_rejected');
  });

  it('a reset between check and mint refuses the stale verifier; positive: the new one', async () => {
    const stale = (await loginRow(f.spaceC, f.M.account))!.verifier;
    await reset(f.A, f.spaceC, f.memberMC, pwM.C);
    expect(await outcome(() => enterSql(f.M, f.spaceC, stale))).toBe('42501');
    expect(await outcome(async () => enterSql(f.M, f.spaceC, (await loginRow(f.spaceC, f.M.account))!.verifier))).toBe('ok');
  });

  it('a non-member learns nothing: required=false and enter_space refuses on membership', async () => {
    const need = await as(f.N, (q) => q.rpc<{ required: boolean; verifier: string | null }>('space_login_for_enter', [f.spaceD]));
    expect(need).toMatchObject({ required: false, verifier: null });
    expect(await outcome(() => enterSql(f.N, f.spaceD))).toBe('42501');
  });

  it('space_login_for_enter is human and gate only: agent kind and a pinned session are refused; positive: a browser gate', async () => {
    expect(await outcome(() => as(f.M, (q) => q.rpc('space_login_for_enter', [f.spaceC]), 'agent'))).toBe('42501');
    expect(await outcome(() => db.tx(claims(f.M, 'browser', f.spaceC), (q) => q.rpc('space_login_for_enter', [f.spaceC])))).toBe('42501');
    expect(await outcome(() => as(f.M, (q) => q.rpc('space_login_for_enter', [f.spaceC])))).toBe('ok');
  });
});

describe.sequential('W5 space_logins — admin reset and lock (a5)', () => {
  it('lock: A locks M in C — M\'s C pins are revoked, D pins are not; the right password is refused; unlock admits', async () => {
    const pw = password();
    await reset(f.A, f.spaceC, f.memberMC, pw);
    const pinC = await enterWithPassword(f.M, f.spaceC, pw);
    const pinD = await enterSql(f.M, f.spaceD, (await loginRow(f.spaceD, f.M.account))!.verifier);
    const locked = await lock(f.A, f.spaceC, f.memberMC, true);
    expect(locked.status).toBe('locked');
    expect(locked.revokedSessionIds).toContain(pinC);
    expect(await revokedAt(pinC)).not.toBeNull();
    expect(await revokedAt(pinD)).toBeNull();
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pw))).toBe('forbidden:space_password_rejected');
    expect(await outcome(async () => enterSql(f.M, f.spaceC, (await loginRow(f.spaceC, f.M.account))!.verifier))).toBe('42501');
    expect((await lock(f.A, f.spaceC, f.memberMC, false)).status).toBe('active');
    expect(await reason(() => enterWithPassword(f.M, f.spaceC, pw))).toBe('ok');
  });

  it('a locked login refuses entry even with the setting off; positive: unlocked, off admits with no password', async () => {
    await setRequired(f.O, f.spaceD, false);
    await lock(f.O, f.spaceD, f.memberMD, true);
    expect(await reason(() => enterWithPassword(f.M, f.spaceD, undefined))).toBe('forbidden:space_password_required');
    expect(await outcome(() => enterSql(f.M, f.spaceD))).toBe('42501');
    await lock(f.O, f.spaceD, f.memberMD, false);
    expect(await reason(() => enterWithPassword(f.M, f.spaceD, undefined))).toBe('ok');
  });

  it('reset revokes the member\'s pinned sessions in that space', async () => {
    const pw = password();
    await reset(f.A, f.spaceC, f.memberMC, pw);
    const pin = await enterWithPassword(f.M, f.spaceC, pw);
    const result = await reset(f.A, f.spaceC, f.memberMC, password());
    expect(result.revokedSessionIds).toContain(pin);
    expect(await revokedAt(pin)).not.toBeNull();
  });

  it('only a space admin resets or locks: M is refused (42501); positive: A', async () => {
    expect(await outcome(() => reset(f.M, f.spaceC, f.memberNC, password()))).toBe('42501');
    expect(await outcome(() => lock(f.M, f.spaceC, f.memberAC, true))).toBe('42501');
    expect(await outcome(() => reset(f.A, f.spaceC, f.memberNC, password()))).toBe('ok');
  });

  it('human-only: an agent-kind admin is refused reset and lock (42501); positive: the same admin as cli', async () => {
    expect(await outcome(() => reset(f.A, f.spaceC, f.memberNC, password(), 'agent'))).toBe('42501');
    expect(await outcome(() => lock(f.A, f.spaceC, f.memberNC, true, 'agent'))).toBe('42501');
    expect(await outcome(() => lock(f.A, f.spaceC, f.memberNC, true, 'cli'))).toBe('ok');
    expect(await outcome(() => lock(f.A, f.spaceC, f.memberNC, false, 'cli'))).toBe('ok');
  });

  it('an admin cannot reset or lock an owner (42501); positive: the owner resets their own', async () => {
    expect(await outcome(() => reset(f.A, f.spaceC, f.memberOC, password()))).toBe('42501');
    expect(await outcome(() => lock(f.A, f.spaceC, f.memberOC, true))).toBe('42501');
    expect(await outcome(() => reset(f.O, f.spaceC, f.memberOC, 'x'.repeat(8)))).toBe('ok');
  });

  it('nobody locks themself (22023); positive: the owner locks the admin', async () => {
    expect(await outcome(() => lock(f.O, f.spaceC, f.memberOC, true))).toBe('22023');
    await reset(f.O, f.spaceC, f.memberAC, password());
    expect(await outcome(() => lock(f.O, f.spaceC, f.memberAC, true))).toBe('ok');
    expect(await outcome(() => lock(f.O, f.spaceC, f.memberAC, false))).toBe('ok');
  });

  it('a pinned admin session for ANOTHER space is refused (42501); positive: pinned to this space', async () => {
    const verifier = await hashSpacePassword(password());
    expect(await outcome(() => db.tx(claims(f.O, 'browser', f.spaceD), (q) =>
      q.rpc('reset_space_login', [f.spaceC, f.memberNC, verifier])))).toBe('42501');
    expect(await outcome(() => db.tx(claims(f.O, 'browser', f.spaceC), (q) =>
      q.rpc('reset_space_login', [f.spaceC, f.memberNC, verifier])))).toBe('ok');
  });

  it('lock on a member with no space password answers not found (P0002); a non-member id likewise', async () => {
    await database.query('delete from public.space_logins where space_id = $1 and account_id = $2', [f.spaceD, f.M.account]);
    expect(await outcome(() => lock(f.O, f.spaceD, f.memberMD, true))).toBe('P0002');
    expect(await outcome(() => lock(f.O, f.spaceD, f.memberNC, true))).toBe('P0002');
  });
});

describe.sequential('W5 space_logins — invites (a4)', () => {
  it('invite_requires_space_password: true for a live code into C (on), false for D (off)', async () => {
    expect(await inviteRequiresSpacePassword(db, await invite(f.spaceC))).toBe(true);
    expect(await inviteRequiresSpacePassword(db, await invite(f.spaceD))).toBe(false);
    expect(await inviteRequiresSpacePassword(db, `inv_${randomUUID()}`)).toBe(false);
  });

  it('signup via invite into C without a space password is refused; positive: with one, a login row is set and admits', async () => {
    const code = await invite(f.spaceC);
    const username = `sl-signup-${randomUUID().slice(0, 8)}`;
    const pw = password();
    expect(await reason(() => signupViaInvite(db, { code, username, password: password() }))).toBe('forbidden:space_password_required');
    // The SQL refuses on its own too (42501), not only the facade.
    const hash = await hashSpacePassword(password());
    expect(await outcome(() => db.rpc({}, 'signup_via_invite',
      [code, `id_${randomUUID()}`, `${username}-sql`, null, null, 'scrypt', hash, null]))).toBe('42501');
    const issued = await signupViaInvite(db, { code, username, password: password(), spacePassword: pw });
    const account = (await database.query<{ id: string; identity_id: string }>(
      'select id::text, identity_id from public.accounts where username = $1', [username]))[0]!;
    const row = await loginRow(f.spaceC, account.id);
    expect(row).toMatchObject({ status: 'active' });
    expect(row!.verifier).toMatch(/^scrypt\$/);
    expect(row!.verifier).not.toContain(pw);
    expect(issued.spaceId).toBe(f.spaceC);
    const who = { identity: account.identity_id, account: account.id };
    expect(await reason(() => enterWithPassword(who, f.spaceC, pw))).toBe('ok');
    expect(await reason(() => enterWithPassword(who, f.spaceC, password()))).toBe('forbidden:space_password_rejected');
  });

  it('a3: signup via invite into D (off) needs no space password and stores no login row', async () => {
    const code = await invite(f.spaceD);
    const username = `sl-signup-off-${randomUUID().slice(0, 8)}`;
    await signupViaInvite(db, { code, username, password: password() });
    const account = (await database.query<{ id: string }>(
      'select id::text from public.accounts where username = $1', [username]))[0]!;
    expect(await loginRow(f.spaceD, account.id)).toBeUndefined();
  });

  it('redeem requiring a password is human-only: agent kind refused (42501); positive: a browser session', async () => {
    const code = await invite(f.spaceC);
    const verifier = await hashSpacePassword(password());
    expect(await outcome(() => as(f.P, (q) => q.rpc('redeem_invite', [code, cmid(), verifier]), 'agent'))).toBe('42501');
    expect(await loginRow(f.spaceC, f.P.account)).toBeUndefined();
  });

  it('redeem into C by an existing account without a space password is refused (42501); positive: with one', async () => {
    const code = await invite(f.spaceC);
    expect(await outcome(() => as(f.P, (q) => q.rpc('redeem_invite', [code, cmid()])))).toBe('42501');
    expect(await loginRow(f.spaceC, f.P.account)).toBeUndefined();
    const pw = password();
    const verifier = await hashSpacePassword(pw);
    const joined = await as(f.P, (q) => q.rpc<{ joined: boolean }>('redeem_invite', [code, cmid(), verifier]));
    expect(joined.joined).toBe(true);
    expect((await loginRow(f.spaceC, f.P.account))!.verifier).toBe(verifier);
    expect(await reason(() => enterWithPassword(f.P, f.spaceC, pw))).toBe('ok');
  });

  it('a garbage verifier on redeem is refused (22023) — plaintext cannot be stored', async () => {
    const code = await invite(f.spaceC);
    expect(await outcome(() => as(f.Q, (q) => q.rpc('redeem_invite', [code, cmid(), 'plaintext-password'])))).toBe('22023');
    expect(await loginRow(f.spaceC, f.Q.account)).toBeUndefined();
  });

  it('redeem never overwrites an existing login row: a locked row stays locked; positive: the join itself succeeds', async () => {
    // Q holds a locked C row from before (an admin locked it, then Q's membership ended).
    await database.query(
      `insert into public.space_logins(space_id, account_id, verifier, status) values ($1, $2, $3, 'locked')`,
      [f.spaceC, f.Q.account, await hashSpacePassword(password())]);
    const before = await loginRow(f.spaceC, f.Q.account);
    const code = await invite(f.spaceC);
    const fresh = await hashSpacePassword(password());
    const joined = await as(f.Q, (q) => q.rpc<{ joined: boolean }>('redeem_invite', [code, cmid(), fresh]));
    expect(joined.joined).toBe(true);
    expect(await loginRow(f.spaceC, f.Q.account)).toEqual(before);
    expect(await outcome(() => enterSql(f.Q, f.spaceC, before!.verifier))).toBe('42501');
  });

  it('a3: redeem into D (off) needs no space password and stores no login row', async () => {
    const code = await invite(f.spaceD);
    const joined = await as(f.P, (q) => q.rpc<{ joined: boolean }>('redeem_invite', [code, cmid()]));
    expect(joined.joined).toBe(true);
    expect(await loginRow(f.spaceD, f.P.account)).toBeUndefined();
    expect(await outcome(() => enterSql(f.P, f.spaceD))).toBe('ok');
  });
});

/**
 * The review fixes (5327376587): turning it on is refused while any owner
 * lacks an active login row (#2), ends the space's pinned human sessions (#4);
 * enter_space matches the verifier to the caller's own row (#5); a dead code
 * never reveals the setting (#6). Spaces E (owners O and A, member M) and F
 * (owner O, member M) start off.
 */
describe.sequential('W5 space_logins — turning it on, the verifier owner, dead codes', () => {
  const spaceE = randomUUID();
  const spaceF = randomUUID();
  const memberAE = randomUUID();
  const memberMF = randomUUID();
  const pwO = { E: password(), F: password() };
  const pwMF = password();
  let R: Person;

  beforeAll(async () => {
    R = { identity: `space-logins-r-${randomUUID()}`, account: randomUUID() };
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('insert into public.user_profiles(identity_id, display_name) values ($1, $2)', [R.identity, 'SLR']);
      await client.query('insert into public.accounts(id, identity_id, username) values ($1, $2, $3)',
        [R.account, R.identity, `space-logins-r-${randomUUID().slice(0, 8)}`]);
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Space logins E', $3), ($2, 'Space logins F', $3)`,
        [spaceE, spaceF, f.O.identity]);
      const members: Array<[string, string, Person, string]> = [
        [randomUUID(), spaceE, f.O, 'owner'],
        [memberAE, spaceE, f.A, 'owner'],
        [randomUUID(), spaceE, f.M, 'member'],
        [randomUUID(), spaceF, f.O, 'owner'],
        [memberMF, spaceF, f.M, 'member'],
      ];
      for (const [entityId, spaceId, p, role] of members) {
        await client.query(
          `insert into public.entities(id, space_id, kind, created_by, visibility)
           values ($1, $2, 'member', $1, 'space')`, [entityId, spaceId]);
        await client.query(
          `insert into public.members(entity_id, space_id, identity_id, role, display_name)
           values ($1, $2, $3, $4, $5)`, [entityId, spaceId, p.identity, role, role]);
      }
    });
  });

  const required = async (spaceId: string): Promise<boolean> => (await database.query<{ r: boolean }>(
    'select require_space_credential r from public.spaces where id = $1', [spaceId]))[0]!.r;

  it('#4: turning it on ends the space\'s pinned browser/cli sessions — not other spaces\', not agent sessions; positive: re-entry with the password', async () => {
    const pinMF = await enterSql(f.M, spaceF);
    const pinOF = await enterSql(f.O, spaceF);
    const pinME = await enterSql(f.M, spaceE);
    const agentF = (await database.query<{ id: string }>(
      `insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id)
       values ($1, 'agent', $2, 'space-logins agent', now() + interval '1 hour', $3) returning id::text`,
      [f.M.account, hashToken(generateSecret()), spaceF]))[0]!.id;
    const on = await setRequired(f.O, spaceF, true, pwO.F) as { revokedSessionIds: string[] };
    expect([...on.revokedSessionIds].sort()).toEqual([pinMF, pinOF].sort());
    expect(await revokedAt(pinMF)).not.toBeNull();
    expect(await revokedAt(pinOF)).not.toBeNull();
    expect(await revokedAt(pinME)).toBeNull();
    expect(await revokedAt(agentF)).toBeNull();
    expect(await reason(() => enterWithPassword(f.O, spaceF, pwO.F))).toBe('ok');
    // Turning it off revokes nothing.
    const pinOF2 = await enterWithPassword(f.O, spaceF, pwO.F);
    expect(await setRequired(f.O, spaceF, false)).toMatchObject({ revokedSessionIds: [] });
    expect(await revokedAt(pinOF2)).toBeNull();
    expect(await outcome(() => setRequired(f.O, spaceF, true))).toBe('ok');
  });

  it('#2: refused (42501) while another owner (A) has no active login row, or a locked one; positive: once A\'s is active, O turns it on and still enters', async () => {
    expect(await outcome(() => setRequired(f.O, spaceE, true, pwO.E))).toBe('42501');
    expect(await required(spaceE)).toBe(false);
    expect(await loginRow(spaceE, f.O.account)).toBeUndefined();
    await reset(f.O, spaceE, memberAE, password());
    await lock(f.O, spaceE, memberAE, true);
    expect(await outcome(() => setRequired(f.O, spaceE, true, pwO.E))).toBe('42501');
    await lock(f.O, spaceE, memberAE, false);
    expect(await outcome(() => setRequired(f.O, spaceE, true, pwO.E))).toBe('ok');
    expect(await required(spaceE)).toBe(true);
    expect(await reason(() => enterWithPassword(f.O, spaceE, pwO.E))).toBe('ok');
  });

  it('#2: an owner without their own row is refused (22023) and the setting stays off; positive: the same owner with one', async () => {
    expect(await setRequired(f.O, spaceE, false)).toMatchObject({ requireSpacePassword: false });
    await database.query('delete from public.space_logins where space_id = $1 and account_id = $2', [spaceE, f.O.account]);
    expect(await outcome(() => setRequired(f.O, spaceE, true))).toBe('22023');
    expect(await required(spaceE)).toBe(false);
    expect(await outcome(() => setRequired(f.O, spaceE, true, pwO.E))).toBe('ok');
  });

  it('#5: enter_space matches the caller\'s own row — M presenting O\'s active verifier for F is refused (42501); positive: M\'s own', async () => {
    await reset(f.O, spaceF, memberMF, pwMF);
    const verifierO = (await loginRow(spaceF, f.O.account))!.verifier;
    expect(await outcome(() => enterSql(f.M, spaceF, verifierO))).toBe('42501');
    expect(await outcome(async () => enterSql(f.M, spaceF, (await loginRow(spaceF, f.M.account))!.verifier))).toBe('ok');
    expect(await outcome(() => enterSql(f.O, spaceF, verifierO))).toBe('ok');
  });

  it('#6: a dead code (exhausted, expired, revoked, unknown) answers false like an unknown one, and redeem refuses it; positive: a live code answers true', async () => {
    const live = await invite(f.spaceC);
    const exhausted = await invite(f.spaceC);
    const expired = await invite(f.spaceC);
    const revoked = await invite(f.spaceC);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.space_invites set use_count = max_uses where code = $1', [exhausted]);
      await client.query(`update public.space_invites set expires_at = now() - interval '1 hour' where code = $1`, [expired]);
      await client.query('update public.space_invites set revoked_at = now() where code = $1', [revoked]);
    });
    expect(await inviteRequiresSpacePassword(db, live)).toBe(true);
    const verifier = await hashSpacePassword(password());
    const dead: Array<[string, string]> = [
      [exhausted, '53400'], [expired, '42501'], [revoked, '42501'], [`inv_${randomUUID()}`, 'P0002'],
    ];
    for (const [code, refusal] of dead) {
      expect(await inviteRequiresSpacePassword(db, code)).toBe(false);
      expect(await outcome(() => as(R, (q) => q.rpc('redeem_invite', [code, cmid(), verifier])))).toBe(refusal);
    }
    expect(await outcome(() => as(R, (q) => q.rpc('redeem_invite', [live, cmid(), verifier])))).toBe('ok');
  });
});

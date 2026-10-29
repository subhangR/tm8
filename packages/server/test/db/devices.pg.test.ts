/**
 * 392 devices (TM8 Mobile S1, task 01a1867c) against a REAL PostgreSQL, every
 * assertion running as `tm8_app` under the caller's claims so RLS, the column
 * grant, the human-only gate and the revocation trigger are all live.
 *
 *   · who: a human sign-in only — an agent, a link session, a caller with no
 *     sign-in, and a revoked or expired one are refused;
 *   · RLS: a person reads only their own rows and writes none directly; another
 *     person's device id is not found on update and "nothing to unregister" on
 *     unregister (ac1);
 *   · one row per sign-in, bound to its ROOT session, and one per (person,
 *     token);
 *   · revocation: logging out, revoking the sign-in, deleting the account and
 *     expiry all end the device; revoking one pinned session does not;
 *   · the token never leaves its seal: not in a result, a ledger row, an event
 *     or a column tm8_app may select (ac3).
 *
 * Every rule has a control beside it that shows the assertion can fail.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SECRET_KEY_BYTES } from '../../src/credentials/secret-box.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { openDeviceToken, sealDeviceToken } from '../../src/devices/device-token.js';
import { generateSecret, hashToken } from '../../src/identity/crypto.js';
import { leaksSecret } from './secret-probe.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const ANA = 'devices-ana';
const BEN = 'devices-ben';
const CAL = 'devices-cal';
const DAN = 'devices-dan';
const key = randomBytes(SECRET_KEY_BYTES);

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};
let tokenSeq = 0;

interface DeviceView {
  id: string;
  platform: string;
  relay: string;
  appVersion: string;
  locale: string;
  previews: string;
  label: string;
  quietUntil: string | null;
  version: number;
}
interface DeviceWrite { deviceId: string; device: DeviceView }
interface DeviceUnregister { deviceId: string; unregistered: boolean }

/** A fresh, recognisable Expo-shaped token. */
function newToken(): string {
  tokenSeq += 1;
  return `ExponentPushToken[s1pg${String(tokenSeq).padStart(4, '0')}${randomUUID().slice(0, 8)}]`;
}

function claims(identityId: string, authSessionId?: string, extra: Partial<DbClaims> = {}): DbClaims {
  return {
    identityId,
    nodeAdmin: false,
    requestId: randomUUID(),
    authKind: 'cli',
    ...(authSessionId ? { authSessionId } : {}),
    ...extra,
  } as DbClaims;
}

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** A person of their own, for a test that ends sessions or the account. */
async function newPerson(identity: string): Promise<string> {
  await asOwner(async (c) => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
    await c.query(`insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1)`, [identity]);
  });
  return identity;
}

async function accountIdOf(identity: string): Promise<string> {
  return asOwner(async (c) => (await c.query<{ id: string }>(
    'select id::text from public.accounts where identity_id = $1', [identity])).rows[0]!.id);
}

async function mintSession(identity: string, opts: { parent?: string; space?: string } = {}): Promise<string> {
  return asOwner(async (c) => (await c.query<{ id: string }>(
    `insert into public.auth_sessions(account_id, kind, token_hash, expires_at, parent_session_id, space_id, label)
     select a.id, 'cli', $2, now() + interval '1 hour', $3, $4, 'devices pg'
       from public.accounts a where a.identity_id = $1
     returning id::text`,
    [identity, hashToken(generateSecret()), opts.parent ?? null, opts.space ?? null],
  )).rows[0]!.id);
}

function register(
  identity: string,
  session: string | undefined,
  token: string,
  opts: { previews?: string; quietUntil?: string; cmid?: string; extra?: Partial<DbClaims> } = {},
): Promise<DeviceWrite> {
  const sealed = sealDeviceToken(key, identity, token);
  return db.rpc<DeviceWrite>(claims(identity, session, opts.extra), 'register_device', [
    'ios', 'expo', sealed.tokenHash, sealed.ciphertext, sealed.nonce,
    '1.0.0 (42)', 'en-US', opts.previews ?? null, 'TM8 Mobile · iPhone', opts.quietUntil ?? null,
    opts.cmid ?? randomUUID(),
  ]);
}

function update(
  identity: string,
  session: string | undefined,
  deviceId: string,
  expectedVersion: number | null,
  change: { token?: string; previews?: string; label?: string; quietUntil?: string | null; cmid?: string },
): Promise<DeviceWrite> {
  const sealed = change.token === undefined ? undefined : sealDeviceToken(key, identity, change.token);
  return db.rpc<DeviceWrite>(claims(identity, session), 'update_device', [
    deviceId, expectedVersion,
    sealed?.tokenHash ?? null, sealed?.ciphertext ?? null, sealed?.nonce ?? null,
    null, null, change.previews ?? null, change.label ?? null,
    change.quietUntil !== undefined, change.quietUntil ?? null,
    change.cmid ?? randomUUID(),
  ]);
}

function unregister(identity: string, session: string | undefined, deviceId: string, cmid = randomUUID()): Promise<DeviceUnregister> {
  return db.rpc<DeviceUnregister>(claims(identity, session), 'unregister_device', [deviceId, null, cmid]);
}

async function storedRows(identity: string): Promise<Array<{ id: string; auth_session_id: string; token_hash: string; token_ciphertext: Buffer; token_nonce: Buffer }>> {
  return asOwner(async (c) => (await c.query(
    `select id::text, auth_session_id::text, token_hash, token_ciphertext, token_nonce
       from public.devices where identity_id = $1 order by created_at`, [identity],
  )).rows);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('devices');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await asOwner(async (c) => {
    for (const identity of [ANA, BEN, CAL, DAN]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2)`, [identity, identity === ANA],
      );
    }
    ids.space = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Phones', $2)`, [ids.space, ANA]);
    // ANA and BEN share a space: the rule must hold between colleagues.
    for (const [identity, role] of [[ANA, 'owner'], [BEN, 'member']] as const) {
      const member = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.space, identity, role],
      );
    }
  });
  ids.anaGate = await mintSession(ANA);
  ids.anaPinned = await mintSession(ANA, { parent: ids.anaGate, space: ids.space });
  ids.benGate = await mintSession(BEN);
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('who may register: a human sign-in only', () => {
  it('refuses an agent, a link session and an absent kind (control: cli and browser pass)', async () => {
    for (const authKind of ['agent', 'agent_runtime', 'link', '']) {
      await expect(register(BEN, ids.benGate, newToken(), { extra: { authKind } }))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(register(BEN, ids.benGate, newToken(), { extra: { authKind: 'browser' } })).resolves.toHaveProperty('deviceId');
    await expect(register(BEN, ids.benGate, newToken())).resolves.toHaveProperty('deviceId');
  });

  it('refuses a caller with no sign-in, and a sign-in that is revoked, expired or someone else’s', async () => {
    await expect(register(BEN, undefined, newToken())).rejects.toMatchObject({ code: 'forbidden' });
    // ANA's own session presented under BEN's identity is not BEN's sign-in.
    await expect(register(BEN, ids.anaGate, newToken())).rejects.toMatchObject({ code: 'forbidden' });
    const ended = await mintSession(BEN);
    const lapsed = await mintSession(BEN);
    await asOwner(async (c) => {
      await c.query(`update public.auth_sessions set revoked_at = now() where id = $1`, [ended]);
      await c.query(`update public.auth_sessions set expires_at = now() - interval '1 minute' where id = $1`, [lapsed]);
    });
    await expect(register(BEN, ended, newToken())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(register(BEN, lapsed, newToken())).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('RLS: a person reads only their own devices and writes none directly (ac1)', () => {
  it('another member is refused: not visible, not updatable, not removable', async () => {
    const ana = await register(ANA, ids.anaGate, newToken());

    // Control: the owner sees her row through RLS.
    const anaSees = await db.query<{ id: string }>(claims(ANA, ids.anaGate), 'select id::text from public.devices');
    expect(anaSees.map((row) => row.id)).toEqual([ana.deviceId]);
    // BEN, a member of the same space, sees none of ANA's rows.
    const benSees = await db.query<{ id: string }>(claims(BEN, ids.benGate), 'select id::text from public.devices');
    expect(benSees.map((row) => row.id)).not.toContain(ana.deviceId);

    await expect(update(BEN, ids.benGate, ana.deviceId, 1, { previews: 'full' }))
      .rejects.toMatchObject({ code: 'not_found' });
    // Unregister is idempotent, so another person's id answers like a missing one.
    await expect(unregister(BEN, ids.benGate, ana.deviceId)).resolves.toEqual({ deviceId: ana.deviceId, unregistered: false });
    expect((await storedRows(ANA)).map((row) => row.id)).toContain(ana.deviceId);
  });

  it('tm8_app holds no INSERT, UPDATE or DELETE on the table, for the owner either', async () => {
    const [row] = await storedRows(ANA);
    await expect(db.query(claims(ANA, ids.anaGate),
      `insert into public.devices(identity_id, auth_session_id, platform, relay, token_hash, token_ciphertext, token_nonce, app_version, locale, label)
       values ($1, $2, 'ios', 'expo', repeat('a', 64), decode(repeat('ab', 20), 'hex'), decode(repeat('00', 12), 'hex'), '1', 'en', 'x')`,
      [ANA, ids.anaPinned])).rejects.toThrow(/permission denied/);
    await expect(db.query(claims(ANA, ids.anaGate), `update public.devices set label = 'mine' where id = $1`, [row!.id]))
      .rejects.toThrow(/permission denied/);
    await expect(db.query(claims(ANA, ids.anaGate), `delete from public.devices where id = $1`, [row!.id]))
      .rejects.toThrow(/permission denied/);
  });

  it('never grants a token column to tm8_app (control: the label column is readable)', async () => {
    await expect(db.query(claims(ANA, ids.anaGate), 'select label from public.devices')).resolves.toHaveLength(1);
    for (const column of ['token_hash', 'token_ciphertext', 'token_nonce', '*']) {
      await expect(db.query(claims(ANA, ids.anaGate), `select ${column} from public.devices`))
        .rejects.toThrow(/permission denied/);
    }
  });
});

describe('one row per sign-in, bound to its root session', () => {
  it('re-registering refreshes the row in place, and a pinned session registers for its gate sign-in', async () => {
    const identity = CAL;
    const gate = await mintSession(identity);
    const pinned = await mintSession(identity, { parent: gate });
    const first = await register(identity, gate, newToken());
    const again = await register(identity, gate, newToken(), { previews: 'none' });
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.device).toMatchObject({ version: 2, previews: 'none' });
    const viaPin = await register(identity, pinned, newToken());
    expect(viaPin.deviceId).toBe(first.deviceId);
    expect(viaPin.device.version).toBe(3);
    const rows = await storedRows(identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.auth_session_id).toBe(gate);
  });

  it('previews default to sender when the body leaves them out', async () => {
    const result = await register(DAN, await mintSession(DAN), newToken());
    expect(result.device.previews).toBe('sender');
  });

  it('the same phone token from a newer sign-in of the same person replaces the older row', async () => {
    const identity = CAL;
    const older = await mintSession(identity);
    const newer = await mintSession(identity);
    const token = newToken();
    const first = await register(identity, older, token);
    // Control: a different token from a third sign-in is a row of its own.
    const third = await register(identity, await mintSession(identity), newToken());
    const second = await register(identity, newer, token);
    expect(second.deviceId).not.toBe(first.deviceId);
    const left = (await storedRows(identity)).map((row) => row.id);
    expect(left).not.toContain(first.deviceId);
    expect(left).toEqual(expect.arrayContaining([second.deviceId, third.deviceId]));
  });
});

describe('revocation: a device ends with its sign-in', () => {
  it('logout (revoke_auth_session) deletes the device; another member’s device is untouched', async () => {
    const gate = await mintSession(BEN);
    const mine = await register(BEN, gate, newToken());
    const other = await register(ANA, ids.anaGate, newToken());
    await db.rpc(claims(BEN, gate), 'revoke_auth_session', [gate]);
    const benLeft = (await storedRows(BEN)).map((row) => row.id);
    expect(benLeft).not.toContain(mine.deviceId);
    expect((await storedRows(ANA)).map((row) => row.id)).toContain(other.deviceId);
  });

  it('revoking one pinned session leaves the device; revoking its gate sign-in (auth.sessions.revoke) ends it', async () => {
    const gate = await mintSession(BEN);
    const pinned = await mintSession(BEN, { parent: gate, space: ids.space });
    const device = await register(BEN, pinned, newToken());
    await db.rpc(claims(BEN, gate), 'revoke_listed_auth_session', [pinned]);
    expect((await storedRows(BEN)).map((row) => row.id)).toContain(device.deviceId);
    await db.rpc(claims(BEN, gate), 'revoke_listed_auth_session', [gate]);
    expect((await storedRows(BEN)).map((row) => row.id)).not.toContain(device.deviceId);
  });

  it('a password change, which revokes every other session, takes their devices with it', async () => {
    const identity = await newPerson('devices-eve');
    const phone = await mintSession(identity);
    const laptop = await mintSession(identity);
    const onPhone = await register(identity, phone, newToken());
    const onLaptop = await register(identity, laptop, newToken());
    // auth.password.change's own revocation (pg-auth.ts), as the person, sparing the laptop.
    const revoked = await db.rpc<number>(claims(identity, laptop), 'revoke_account_sessions_except', [
      await accountIdOf(identity), laptop,
    ]);
    expect(revoked).toBe(1);
    const left = (await storedRows(identity)).map((row) => row.id);
    expect(left).not.toContain(onPhone.deviceId);
    expect(left).toContain(onLaptop.deviceId);
  });

  it('deleting the account deletes its devices', async () => {
    const identity = await newPerson('devices-gone');
    await register(identity, await mintSession(identity), newToken());
    expect(await storedRows(identity)).toHaveLength(1);
    await asOwner((c) => c.query('delete from public.accounts where identity_id = $1', [identity]));
    expect(await storedRows(identity)).toHaveLength(0);
  });

  it('a device whose sign-in expired is swept by the person’s next registration', async () => {
    const lapsing = await mintSession(DAN);
    const stale = await register(DAN, lapsing, newToken());
    await asOwner((c) => c.query(`update public.auth_sessions set expires_at = now() - interval '1 minute' where id = $1`, [lapsing]));
    // Control: the expired row is still stored until someone registers.
    expect((await storedRows(DAN)).map((row) => row.id)).toContain(stale.deviceId);
    await register(DAN, await mintSession(DAN), newToken());
    expect((await storedRows(DAN)).map((row) => row.id)).not.toContain(stale.deviceId);
  });
});

describe('the token never leaves its seal (ac3)', () => {
  it('is in no result, ledger row or event, and opens only through openDeviceToken', async () => {
    const token = newToken();
    const rotated = newToken();
    const registerCmid = randomUUID();
    const updateCmid = randomUUID();
    const eventCount = async (): Promise<string> => asOwner(async (c) =>
      (await c.query<{ count: string }>('select count(*)::text count from public.workspace_events')).rows[0]!.count);
    const eventsBefore = await eventCount();

    const registered = await register(ANA, ids.anaGate, token, { cmid: registerCmid });
    const updated = await update(ANA, ids.anaGate, registered.deviceId, registered.device.version,
      { token: rotated, cmid: updateCmid });
    const [row] = (await storedRows(ANA)).filter((stored) => stored.id === registered.deviceId);

    const ledger = await asOwner(async (c) => (await c.query<{ result: unknown }>(
      'select result from public.command_ledger where client_mutation_id = any($1)', [[registerCmid, updateCmid]],
    )).rows);
    expect(ledger).toHaveLength(2);
    expect(await eventCount()).toBe(eventsBefore);

    const surfaces = [JSON.stringify(registered), JSON.stringify(updated), JSON.stringify(ledger)];
    // Control: the probes find a token and a hash where one is present.
    expect(JSON.stringify({ token }).includes(token)).toBe(true);
    for (const surface of surfaces) {
      for (const secret of [token, rotated, row!.token_hash, 's1pg']) {
        expect(surface.includes(secret)).toBe(false);
      }
      expect(surface).not.toMatch(/"token/i);
      expect(leaksSecret(surface)).toBe(false);
    }

    expect(row!.token_ciphertext.includes(Buffer.from(rotated))).toBe(false);
    expect(openDeviceToken(key, ANA, {
      tokenHash: row!.token_hash, ciphertext: row!.token_ciphertext, nonce: row!.token_nonce,
    })).toBe(rotated);
  });
});

describe('devices.update and devices.unregister', () => {
  it('changes only what it is given, and clears quietUntil with an explicit null', async () => {
    const gate = await mintSession(DAN);
    const created = await register(DAN, gate, newToken(), { quietUntil: '2026-10-30T07:00:00Z' });
    expect(created.device.quietUntil).not.toBeNull();
    const previews = await update(DAN, gate, created.deviceId, 1, { previews: 'none' });
    expect(previews.device).toMatchObject({ version: 2, previews: 'none', label: 'TM8 Mobile · iPhone' });
    expect(previews.device.quietUntil).not.toBeNull();
    const cleared = await update(DAN, gate, created.deviceId, 2, { quietUntil: null });
    expect(cleared.device).toMatchObject({ version: 3, previews: 'none', quietUntil: null });
  });

  it('refuses a stale expectedVersion with the current version, and a missing one as invalid input', async () => {
    const gate = await mintSession(DAN);
    const created = await register(DAN, gate, newToken());
    await expect(update(DAN, gate, created.deviceId, created.device.version + 5, { previews: 'full' }))
      .rejects.toMatchObject({ code: 'version_conflict', details: expect.objectContaining({ currentVersion: created.device.version }) });
    await expect(update(DAN, gate, created.deviceId, null, { previews: 'full' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rotating to a token another of the person’s sign-ins holds supersedes that row', async () => {
    const shared = newToken();
    const a = await register(DAN, await mintSession(DAN), shared);
    const bSession = await mintSession(DAN);
    const b = await register(DAN, bSession, newToken());
    await update(DAN, bSession, b.deviceId, b.device.version, { token: shared });
    const left = (await storedRows(DAN)).map((row) => row.id);
    expect(left).toContain(b.deviceId);
    expect(left).not.toContain(a.deviceId);
  });

  it('unregister is idempotent, and a replayed id may not address another device', async () => {
    const gate = await mintSession(DAN);
    const device = await register(DAN, gate, newToken());
    const cmid = randomUUID();
    await expect(unregister(DAN, gate, device.deviceId, cmid)).resolves.toEqual({ deviceId: device.deviceId, unregistered: true });
    // A lost response retried with the same id gets the same answer.
    await expect(unregister(DAN, gate, device.deviceId, cmid)).resolves.toEqual({ deviceId: device.deviceId, unregistered: true });
    await expect(unregister(DAN, gate, device.deviceId)).resolves.toEqual({ deviceId: device.deviceId, unregistered: false });
    await expect(unregister(DAN, gate, randomUUID(), cmid)).rejects.toMatchObject({ code: 'invariant_violation' });
  });
});

describe('limits', () => {
  it('stops at 50 live devices per person (control: an existing sign-in still refreshes)', async () => {
    const identity = await newPerson('devices-many');
    await asOwner(async (c) => {
      await c.query(
        `with s as (
           insert into public.auth_sessions(account_id, kind, token_hash, expires_at, label)
           select a.id, 'cli', encode(sha256(convert_to('cap-session-' || g, 'utf8')), 'hex'), now() + interval '1 hour', 'cap'
             from public.accounts a, generate_series(1, 50) g where a.identity_id = $1
           returning id
         )
         insert into public.devices(identity_id, auth_session_id, platform, relay, token_hash, token_ciphertext,
                                    token_nonce, app_version, locale, label)
         select $1, s.id, 'android', 'expo', encode(sha256(convert_to('cap-token-' || s.id::text, 'utf8')), 'hex'),
                decode(repeat('ab', 20), 'hex'), decode(repeat('00', 12), 'hex'), '1.0.0', 'en', 'cap'
           from s`, [identity]);
    });
    await expect(register(identity, await mintSession(identity), newToken()))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    const existing = (await storedRows(identity))[0]!;
    await expect(register(identity, existing.auth_session_id, newToken())).resolves.toMatchObject({ deviceId: existing.id });
  });
});

/**
 * Node-admin account administration (migration 323, task 01a13574) against a
 * REAL PostgreSQL with every migration applied, called as `tm8_app` under each
 * caller's claims — the SQL half of the two-layer check.
 *
 * Cast: OWNER is the node owner, ADMIN a node admin, M1 an ordinary account.
 * Every write is human node admin on an unpinned session; the setup link is
 * single use, expiring and stored only as a hash; the owner is never reset or
 * demoted; the last node admin is never revoked.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import {
  adminCreateAccount,
  adminResetAccount,
  loginWithPassword,
  previewAccountSetup,
  redeemAccountSetup,
  resolveBearerIdentity,
} from '../../src/identity/pg-auth.js';
import { hashToken } from '../../src/identity/crypto.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = `pg-owner-${randomUUID()}`;
const ADMIN = `pg-admin-${randomUUID()}`;
const M1 = `pg-m1-${randomUUID()}`;
const accounts: Record<string, string> = {};

let database: W1ScratchDatabase;
let db: Db;
let spaceId: string;

function claims(identityId: string, opts: { nodeAdmin?: boolean; authKind?: string; pinned?: string } = {}): DbClaims {
  return {
    identityId,
    nodeAdmin: opts.nodeAdmin ?? false,
    authKind: opts.authKind ?? 'browser',
    requestId: `pg-${randomUUID()}`,
    ...(opts.pinned ? { sessionSpaceId: opts.pinned } : {}),
  };
}
const admin = (): DbClaims => claims(ADMIN, { nodeAdmin: true });
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; details?: { sqlstate?: string }; cause?: { code?: string } };
    return String(e.details?.sqlstate ?? e.cause?.code ?? e.code);
  }
}

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const create = (username: string, as = admin(), extra: Partial<Parameters<typeof adminCreateAccount>[2]> = {}) =>
  adminCreateAccount(db, as, { username, expiresAt: inHours(72), ...extra });

beforeAll(async () => {
  expect(migrationFiles().some((f) => /_account_admin\.sql$/.test(f))).toBe(true);
  database = await createW1ScratchDatabase('account_admin');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await asOwner(async (c) => {
    for (const identity of [OWNER, ADMIN, M1]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, is_owner, is_node_admin, password_algorithm, password_hash)
         values ($1, $1, $2, $3, 'x', 'x') returning id::text`,
        [identity, identity === OWNER, identity === OWNER || identity === ADMIN]);
      accounts[identity] = rows[0]!.id;
    }
  });
  const space = await db.rpc<{ space: { id: string } }>(
    claims(ADMIN), 'create_space', ['admin-space', '', 'private', null, `cmid-${randomUUID()}`]);
  spaceId = space.space.id;
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('node.accounts.create (admin_create_account)', () => {
  it('refuses a non-admin, an agent session and a space-pinned admin', async () => {
    expect(await outcome(() => create(`x-${randomUUID()}`, claims(M1)))).toBe('42501');
    expect(await outcome(() => create(`x-${randomUUID()}`, claims(ADMIN, { nodeAdmin: true, authKind: 'agent' })))).toBe('42501');
    expect(await outcome(() => create(`x-${randomUUID()}`, claims(ADMIN, { nodeAdmin: true, pinned: spaceId })))).toBe('42501');
  });

  it('creates a passwordless account with a hashed, live, single-use link', async () => {
    const created = await create('Alice', admin(), { displayName: 'Alice A' });
    expect(created.account.username).toBe('alice');
    expect(created.account.is_node_admin).toBe(false);
    expect(created.token).toMatch(/^tm8a_[A-Za-z0-9_-]+$/);

    const stored = await asOwner(async (c) => (await c.query<{ password_hash: string | null; hashes: string[] }>(
      `select a.password_hash, array(select token_hash from public.account_setup_tokens t where t.account_id = a.id) as hashes
         from public.accounts a where a.id = $1`, [created.account.id])).rows[0]!);
    expect(stored.password_hash).toBeNull();
    expect(stored.hashes).toEqual([hashToken(created.token.slice('tm8a_'.length))]);
    expect(stored.hashes).not.toContain(created.token);

    // No password: it cannot sign in before the link is redeemed.
    expect(await outcome(() => loginWithPassword(db, { username: 'alice', password: 'whatever-123' }))).toBe('unauthenticated');

    expect(await previewAccountSetup(db, created.token)).toMatchObject({ username: 'alice', purpose: 'create' });
    const issued = await redeemAccountSetup(db, { token: created.token, password: 'alice-chosen-pw' });
    expect(issued.account.username).toBe('alice');
    expect((await resolveBearerIdentity(db, issued.token)).accountId).toBe(created.account.id);

    // Single use.
    expect(await previewAccountSetup(db, created.token)).toBeNull();
    expect(await outcome(() => redeemAccountSetup(db, { token: created.token, password: 'another-pw-123' }))).toBe('28000');
    expect((await loginWithPassword(db, { username: 'alice', password: 'alice-chosen-pw' })).account.username).toBe('alice');
  });

  it('refuses a taken username and a role without a space', async () => {
    expect(await outcome(() => create('ALICE'))).toBe('23505');
    expect(await outcome(() => create(`r-${randomUUID()}`, admin(), { role: 'member' }))).toBe('22023');
    expect(await outcome(() => create(`r-${randomUUID()}`, admin(), { spaceId, role: 'owner' as 'admin' }))).toBe('22023');
  });

  it('can grant node admin and place the account into a space with a role', async () => {
    const created = await create('bob', admin(), { isNodeAdmin: true, spaceId, role: 'admin' });
    expect(created.account.is_node_admin).toBe(true);
    expect(created.role).toBe('admin');
    const member = await asOwner(async (c) => (await c.query<{ role: string; status: string }>(
      `select role, status from public.members where space_id = $1 and entity_id = $2`,
      [spaceId, created.memberId])).rows[0]);
    expect(member).toEqual({ role: 'admin', status: 'active' });
  });

  it('refuses an expired link without enumerating why', async () => {
    const created = await create(`exp-${randomUUID().slice(0, 8)}`);
    await asOwner((c) => c.query(
      `update public.account_setup_tokens set expires_at = now() - interval '1 minute' where account_id = $1`,
      [created.account.id]));
    expect(await previewAccountSetup(db, created.token)).toBeNull();
    expect(await outcome(() => redeemAccountSetup(db, { token: created.token, password: 'late-password' }))).toBe('28000');
    expect(await previewAccountSetup(db, 'tm8a_not-a-real-token')).toBeNull();
    expect(await previewAccountSetup(db, 'tm8c_wrong-prefix')).toBeNull();
  });
});

describe('node.accounts.reset (admin_reset_account)', () => {
  it('refuses the owner, yourself and a non-admin', async () => {
    expect(await outcome(() => adminResetAccount(db, admin(), accounts[OWNER]!, inHours(1)))).toBe('42501');
    expect(await outcome(() => adminResetAccount(db, admin(), accounts[ADMIN]!, inHours(1)))).toBe('42501');
    expect(await outcome(() => adminResetAccount(db, claims(M1), accounts[ADMIN]!, inHours(1)))).toBe('42501');
  });

  it('clears the credential, revokes sessions, and supersedes an earlier link', async () => {
    const created = await create('carol');
    const first = await redeemAccountSetup(db, { token: created.token, password: 'carol-first-pw' });

    const reset1 = await adminResetAccount(db, admin(), created.account.id, inHours(1));
    expect(reset1.revokedSessionCount).toBeGreaterThanOrEqual(1);
    expect(await outcome(() => resolveBearerIdentity(db, first.token))).toBe('unauthenticated');
    expect(await outcome(() => loginWithPassword(db, { username: 'carol', password: 'carol-first-pw' }))).toBe('unauthenticated');

    const reset2 = await adminResetAccount(db, admin(), created.account.id, inHours(1));
    expect(await previewAccountSetup(db, reset1.token)).toBeNull();
    expect(await previewAccountSetup(db, reset2.token)).toMatchObject({ username: 'carol', purpose: 'reset' });
    await redeemAccountSetup(db, { token: reset2.token, password: 'carol-second-pw' });
    expect((await loginWithPassword(db, { username: 'carol', password: 'carol-second-pw' })).account.username).toBe('carol');
  });
});

describe('accounts.disable / accounts.enable', () => {
  it('turns an account off and back on; a disabled account cannot redeem', async () => {
    const created = await create('dave');
    expect(await outcome(() => db.rpc(claims(M1), 'enable_account', [created.account.id, `cmid-${randomUUID()}`]))).toBe('42501');
    await db.rpc(admin(), 'disable_account', [created.account.id, `cmid-${randomUUID()}`]);
    expect(await previewAccountSetup(db, created.token)).toBeNull();
    expect(await outcome(() => redeemAccountSetup(db, { token: created.token, password: 'dave-password' }))).toBe('28000');

    const enabled = await db.rpc<{ accountId: string; status: string }>(
      admin(), 'enable_account', [created.account.id, `cmid-${randomUUID()}`]);
    expect(enabled).toEqual({ accountId: created.account.id, status: 'active' });
    await redeemAccountSetup(db, { token: created.token, password: 'dave-password' });
  });
});

describe('node.accounts.nodeAdmin.set (set_account_node_admin)', () => {
  const setAdmin = (id: string, on: boolean, as = admin()) =>
    db.rpc<{ accountId: string; isNodeAdmin: boolean }>(as, 'set_account_node_admin', [id, on]);

  it('refuses a non-admin and never changes the owner', async () => {
    expect(await outcome(() => setAdmin(accounts[M1]!, true, claims(M1)))).toBe('42501');
    expect(await outcome(() => setAdmin(accounts[OWNER]!, false))).toBe('42501');
  });

  it('grants and revokes', async () => {
    expect(await setAdmin(accounts[M1]!, true)).toMatchObject({ isNodeAdmin: true });
    expect(await setAdmin(accounts[M1]!, false)).toMatchObject({ isNodeAdmin: false });
  });

  it('refuses to revoke the last active node admin', async () => {
    // Make the owner not count (a node whose owner row was never credentialed
    // is still an owner, so take the owner flag away in a scratch copy).
    await asOwner((c) => c.query(`update public.accounts set is_owner = false, is_node_admin = false where id = $1`, [accounts[OWNER]]));
    try {
      const others = await asOwner(async (c) => (await c.query<{ id: string }>(
        `select id::text from public.accounts where is_node_admin and id <> $1`, [accounts[ADMIN]])).rows);
      for (const row of others) await setAdmin(row.id, false);
      expect(await outcome(() => setAdmin(accounts[ADMIN]!, false))).toBe('42501');
      await setAdmin(accounts[M1]!, true);
      expect(await setAdmin(accounts[ADMIN]!, false)).toMatchObject({ isNodeAdmin: false });
    } finally {
      await asOwner((c) => c.query(
        `update public.accounts set is_owner = (id = $1), is_node_admin = (id in ($1, $2)) where id in ($1, $2, $3)`,
        [accounts[OWNER], accounts[ADMIN], accounts[M1]]));
    }
  });
});

describe('node.accounts.memberships.add (admin_add_space_member)', () => {
  const add = (id: string, role: string, as = admin()) =>
    db.rpc<{ memberId: string; role: string; created: boolean }>(as, 'admin_add_space_member', [id, spaceId, role]);

  it('puts an account into a space once, and leaves an existing membership alone', async () => {
    expect(await outcome(() => add(accounts[M1]!, 'member', claims(M1)))).toBe('42501');
    expect(await outcome(() => add(accounts[M1]!, 'owner'))).toBe('22023');
    const first = await add(accounts[M1]!, 'member');
    expect(first).toMatchObject({ role: 'member', created: true });
    const again = await add(accounts[M1]!, 'admin');
    expect(again).toMatchObject({ memberId: first.memberId, role: 'member', created: false });
  });

  it('lists hasPassword / isOwner / setupExpiresAt for the admin page', async () => {
    const pending = await create(`list-${randomUUID().slice(0, 8)}`);
    const rows = await db.rpc<Array<{ accountId: string; isOwner?: boolean; hasPassword?: boolean; setupExpiresAt?: string }>>(
      admin(), 'list_node_accounts', []);
    const owner = rows.find((r) => r.accountId === accounts[OWNER]);
    const fresh = rows.find((r) => r.accountId === pending.account.id);
    expect(owner).toMatchObject({ isOwner: true, hasPassword: true });
    expect(owner?.setupExpiresAt).toBeUndefined();
    expect(fresh).toMatchObject({ isOwner: false, hasPassword: false });
    expect(fresh?.setupExpiresAt).toBeTruthy();
  });
});

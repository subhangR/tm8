/**
 * Filesystem path grants (migration 282, design doc 01a0fb62 §4, lane L1)
 * against a REAL PostgreSQL with every migration applied, called as `tm8_app`
 * under each caller's claims.
 *
 * Cast: ADMIN is a node admin; M1 and M2 are ordinary accounts. Writes and the
 * node-wide list are gate admin only (node admin AND unpinned AND human); a
 * member reads only their own live grants.
 *
 * Also here: `readProjectIsolation`, the facade's one reader of the boot-written
 * `internal.node_policy` row, because the only honest test of "reads the policy
 * the database enforces" is against that database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { readProjectIsolation } from '../../src/facade/handlers/w2/auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const ADMIN = `pg-admin-${randomUUID()}`;
const M1 = `pg-m1-${randomUUID()}`;
const M2 = `pg-m2-${randomUUID()}`;
const accounts: Record<string, string> = {};

interface Grant {
  id: string;
  accountId: string;
  rootPath: string;
  mode: string;
  grantedAt: string;
  revokedAt?: string;
  note?: string;
  grantee?: { accountId: string; username: string };
  grantedBy?: { accountId: string; username: string };
}

let database: W1ScratchDatabase;
let db: Db;

function claims(identityId: string, opts: { nodeAdmin?: boolean; authKind?: string; pinned?: string } = {}): DbClaims {
  return {
    identityId,
    nodeAdmin: opts.nodeAdmin ?? false,
    authKind: opts.authKind ?? 'browser',
    requestId: `pg-${randomUUID()}`,
    ...(opts.pinned ? { sessionSpaceId: opts.pinned } : {}),
  };
}
const gate = (): DbClaims => claims(ADMIN, { nodeAdmin: true });

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

const grant = (who: string, root: string, note: string | null = null, as = gate()) =>
  db.rpc<Grant>(as, 'create_path_grant', [accounts[who], root, note]);
const mine = (who: string) => db.rpc<Grant[]>(claims(who), 'my_path_grants', []);

beforeAll(async () => {
  expect(migrationFiles().some((f) => /_path_grants\.sql$/.test(f))).toBe(true);
  database = await createW1ScratchDatabase('path_grants');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await asOwner(async (c) => {
    for (const identity of [ADMIN, M1, M2]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, is_node_admin) values ($1, $1, $2) returning id::text`,
        [identity, identity === ADMIN]);
      accounts[identity] = rows[0]!.id;
    }
  });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('path grants — who may write', () => {
  it('a gate admin grants; the row names grantee and grantor', async () => {
    const row = await grant(M1, '/srv/repos', ' shared repos ');
    expect(row).toMatchObject({
      accountId: accounts[M1],
      rootPath: '/srv/repos',
      mode: 'select',
      note: 'shared repos',
      grantee: { accountId: accounts[M1], username: M1 },
      grantedBy: { accountId: accounts[ADMIN], username: ADMIN },
    });
    expect(row.revokedAt).toBeUndefined();
  });

  it('refuses a member, a pinned node admin, and an agent session of a node admin (42501)', async () => {
    const spaceId = randomUUID();
    expect(await outcome(() => grant(M2, '/srv/m2', null, claims(M1)))).toBe('42501');
    expect(await outcome(() => grant(M2, '/srv/m2', null, claims(M1, { nodeAdmin: true })))).toBe('42501');
    expect(await outcome(() => grant(M2, '/srv/m2', null, claims(ADMIN, { nodeAdmin: true, pinned: spaceId })))).toBe('42501');
    expect(await outcome(() => grant(M2, '/srv/m2', null, claims(ADMIN, { nodeAdmin: true, authKind: 'agent' })))).toBe('42501');
    expect(await outcome(() => db.rpc(claims(M1), 'list_path_grants', [true]))).toBe('42501');
    expect(await outcome(() => db.rpc(claims(M1), 'list_node_accounts', []))).toBe('42501');
    expect(await mine(M2)).toEqual([]);
  });

  it('refuses a relative root, a `..` segment, and an unknown or disabled account', async () => {
    expect(await outcome(() => grant(M2, 'srv/rel'))).toBe('23514');
    expect(await outcome(() => grant(M2, '/srv/../etc'))).toBe('23514');
    expect(await grant(M2, '/srv/name..with-dots')).toMatchObject({ rootPath: '/srv/name..with-dots' });
    expect(await outcome(() => db.rpc(gate(), 'create_path_grant', [randomUUID(), '/srv', null]))).toBe('P0002');
  });
});

describe('path grants — who may read', () => {
  it('a member reads only their own live grants; the table agrees under RLS', async () => {
    await grant(M1, '/srv/alpha');
    const m1 = await mine(M1);
    expect(m1.map((g) => g.rootPath)).toEqual(expect.arrayContaining(['/srv/alpha', '/srv/repos']));
    expect(m1.every((g) => g.accountId === accounts[M1])).toBe(true);
    // The member view carries no grantee/grantor join.
    expect(m1.every((g) => g.grantee === undefined && g.grantedBy === undefined)).toBe(true);
    expect((await mine(M2)).every((g) => g.accountId === accounts[M2])).toBe(true);

    const rows = await db.query<{ account_id: string }>(claims(M2), 'select account_id::text from public.path_grants');
    expect(rows.every((r) => r.account_id === accounts[M2])).toBe(true);
  });

  it('revoke hides the grant from its holder, keeps it on the admin list, and re-granting re-opens it', async () => {
    const row = await grant(M1, '/srv/revoke-me');
    const revoked = await db.rpc<Grant>(gate(), 'revoke_path_grant', [row.id]);
    expect(revoked.revokedAt).toBeDefined();
    expect((await mine(M1)).some((g) => g.id === row.id)).toBe(false);

    const live = await db.rpc<Grant[]>(gate(), 'list_path_grants', [false]);
    const all = await db.rpc<Grant[]>(gate(), 'list_path_grants', [true]);
    expect(live.some((g) => g.id === row.id)).toBe(false);
    expect(all.find((g) => g.id === row.id)?.revokedAt).toBeDefined();

    // Revoking again is a no-op; an unknown id is not_found.
    expect((await db.rpc<Grant>(gate(), 'revoke_path_grant', [row.id])).revokedAt).toBe(revoked.revokedAt);
    expect(await outcome(() => db.rpc(gate(), 'revoke_path_grant', [randomUUID()]))).toBe('P0002');

    const reopened = await grant(M1, '/srv/revoke-me', 'again');
    expect(reopened.id).toBe(row.id);
    expect(reopened.revokedAt).toBeUndefined();
    expect((await mine(M1)).some((g) => g.id === row.id)).toBe(true);
  });

  it('a disabled account holds no live grant', async () => {
    await grant(M2, '/srv/m2-live');
    await asOwner((c) => c.query(
      `update public.accounts set status = 'disabled', disabled_at = now() where id = $1`, [accounts[M2]]));
    try {
      expect(await mine(M2)).toEqual([]);
      expect(await outcome(() => grant(M2, '/srv/m2-after'))).toBe('P0002');
    } finally {
      await asOwner((c) => c.query(
        `update public.accounts set status = 'active', disabled_at = null where id = $1`, [accounts[M2]]));
    }
  });

  it('the gate admin lists every account on the node', async () => {
    const listed = await db.rpc<Array<{ accountId: string; username: string; isNodeAdmin?: boolean }>>(
      gate(), 'list_node_accounts', []);
    expect(listed.map((a) => a.username)).toEqual(expect.arrayContaining([ADMIN, M1, M2]));
    expect(listed.find((a) => a.username === ADMIN)?.isNodeAdmin).toBe(true);
    expect(listed.find((a) => a.username === M1)?.isNodeAdmin).toBe(false);
  });
});

describe('projectIsolation — read from internal.node_policy', () => {
  it('is isolated with no row, shared only for a shared row, isolated for anything else', async () => {
    await asOwner((c) => c.query(`delete from internal.node_policy where key = 'project_folders'`));
    expect(await readProjectIsolation(db)).toBe('isolated');
    await asOwner((c) => c.query(
      `insert into internal.node_policy(key, value) values ('project_folders', 'shared')`));
    expect(await readProjectIsolation(db)).toBe('shared');
    await asOwner((c) => c.query(
      `update internal.node_policy set value = 'one_space' where key = 'project_folders'`));
    expect(await readProjectIsolation(db)).toBe('isolated');
  });
});

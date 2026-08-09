/** 092 against real Postgres: RLS, grants, human mutations, and spawn read. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { DbGitHubCredentialStore } from '../../src/credentials/github-credential-store.js';
import { createDb } from '../../src/db/client.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const CIPHERTEXT = Buffer.alloc(32, 7);
const OTHER_CIPHERTEXT = Buffer.alloc(32, 9);
const NONCE = Buffer.alloc(12, 3);

let database: W1ScratchDatabase;
let identityA: string;
let identityB: string;
let accountA: string;
let accountB: string;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asApp<T>(
  identityId: string,
  authKind: string,
  fn: (client: PoolClient) => Promise<T>,
  nodeAdmin = false,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    await client.query(`select set_config('tm8.auth_kind',$1,true)`, [authKind]);
    await client.query(`select set_config('tm8.node_admin',$1,true)`, [String(nodeAdmin)]);
    return fn(client);
  });
}

async function store(
  identityId: string,
  login: string,
  ciphertext = CIPHERTEXT,
): Promise<Record<string, unknown>> {
  return asApp(identityId, 'browser', async (client) =>
    (await client.query<{ value: Record<string, unknown> }>(
      `select public.set_account_git_credential('github',$1,$2,$3) value`,
      [login, ciphertext, NONCE],
    )).rows[0]!.value);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('github_credentials_092');
  database.apply(migrationFiles());
  identityA = `github-a-${randomUUID()}`;
  identityB = `github-b-${randomUUID()}`;
  accountA = randomUUID();
  accountB = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1,$2,'github-a'), ($3,$4,'github-b')`,
      [accountA, identityA, accountB, identityB],
    );
  });
}, 300_000);

beforeEach(async () => {
  await asOwner(async (client) => {
    await client.query('delete from public.account_git_credentials');
  });
});

afterAll(async () => {
  await database?.destroy();
}, 300_000);

describe('092 account_git_credentials security posture', () => {
  it('proves the migration by CALLING its RPCs inside an explicit rollback', async () => {
    const client = await database.pool.connect();
    let during: Record<string, unknown> | undefined;
    try {
      await client.query('begin');
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityA]);
      await client.query(`select set_config('tm8.auth_kind','browser',true)`);
      during = (await client.query<{ value: Record<string, unknown> }>(
        `select public.set_account_git_credential('github','rollback-proof',$1,$2) value`,
        [CIPHERTEXT, NONCE],
      )).rows[0]!.value;
      const read = (await client.query<{ value: Record<string, unknown> | null }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value;
      expect(read).toMatchObject({ login: 'rollback-proof', accountId: accountA });
    } finally {
      await client.query('rollback');
      client.release();
    }

    expect(during).toMatchObject({ connected: true, login: 'rollback-proof' });
    const after = await asOwner(async (owner) =>
      (await owner.query<{ count: string }>(
        `select count(*)::text count from public.account_git_credentials`,
      )).rows[0]!.count);
    expect(after).toBe('0');
  });

  it('exists with RLS enabled, one self-select policy, and no table write grants', async () => {
    const result = await asOwner(async (client) => {
      const relation = (await client.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where oid='public.account_git_credentials'::regclass`,
      )).rows[0]!;
      const policies = (await client.query<{ policyname: string }>(
        `select policyname from pg_policies
          where schemaname='public' and tablename='account_git_credentials'`,
      )).rows;
      const writes = (await client.query<{ insert_ok: boolean; update_ok: boolean; delete_ok: boolean }>(
        `select has_table_privilege('tm8_app','public.account_git_credentials','insert') insert_ok,
                has_table_privilege('tm8_app','public.account_git_credentials','update') update_ok,
                has_table_privilege('tm8_app','public.account_git_credentials','delete') delete_ok`,
      )).rows[0]!;
      return { relation, policies, writes };
    });
    expect(result.relation.relrowsecurity).toBe(true);
    expect(result.policies.map((row) => row.policyname)).toEqual([
      'account_git_credentials_self_select',
    ]);
    expect(result.writes).toEqual({ insert_ok: false, update_ok: false, delete_ok: false });
  });

  it('stores and rotates one sealed row through the human-only RPC', async () => {
    const first = await store(identityA, 'alice');
    expect(first).toMatchObject({ connected: true, provider: 'github', login: 'alice' });
    expect(Object.keys(first).sort()).toEqual(['connected', 'login', 'provider', 'updatedAt']);

    await store(identityA, 'alice-renamed', OTHER_CIPHERTEXT);
    const rows = await asOwner(async (client) =>
      (await client.query<{ login: string; token_ciphertext: Buffer }>(
        `select login, token_ciphertext from public.account_git_credentials where account_id=$1`,
        [accountA],
      )).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.login).toBe('alice-renamed');
    expect(rows[0]!.token_ciphertext.equals(OTHER_CIPHERTEXT)).toBe(true);
  });

  it('demonstrates the mutation guard RED for an agent and for a missing kind', async () => {
    for (const kind of ['agent', '']) {
      await expect(
        asApp(identityA, kind, (client) =>
          client.query(`select public.set_account_git_credential('github','alice',$1,$2)`, [
            CIPHERTEXT,
            NONCE,
          ])),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp(identityA, kind, (client) =>
          client.query(`select public.delete_account_git_credential('github')`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('pins SELECT to the caller own account even when node_admin=true', async () => {
    await store(identityA, 'alice', CIPHERTEXT);
    await store(identityB, 'bob', OTHER_CIPHERTEXT);

    const a = await asApp(identityA, 'browser', async (client) =>
      (await client.query<{ account_id: string; login: string }>(
        'select account_id, login from public.account_git_credentials',
      )).rows);
    const bAsAdmin = await asApp(identityB, 'browser', async (client) =>
      (await client.query<{ account_id: string; login: string }>(
        'select account_id, login from public.account_git_credentials',
      )).rows, true);
    expect(a).toEqual([{ account_id: accountA, login: 'alice' }]);
    expect(bAsAdmin).toEqual([{ account_id: accountB, login: 'bob' }]);
  });

  it('denies secret-column SELECT and every direct table mutation with 42501', async () => {
    await store(identityA, 'alice');
    for (const sql of [
      'select token_ciphertext from public.account_git_credentials',
      'select token_nonce from public.account_git_credentials',
      'select * from public.account_git_credentials',
      `update public.account_git_credentials set login='mallory'`,
      'delete from public.account_git_credentials',
    ]) {
      await expect(asApp(identityA, 'browser', (client) => client.query(sql)))
        .rejects.toMatchObject({ code: '42501' });
    }
  });

  it('lets an agent spawn-reader obtain only its owner sealed row', async () => {
    await store(identityA, 'alice', CIPHERTEXT);
    await store(identityB, 'bob', OTHER_CIPHERTEXT);

    const mine = await asApp(identityA, 'agent', async (client) =>
      (await client.query<{ value: Record<string, string> | null }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value);
    const theirs = await asApp(identityB, 'agent', async (client) =>
      (await client.query<{ value: Record<string, string> | null }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value);
    expect(mine).toMatchObject({ accountId: accountA, login: 'alice', provider: 'github' });
    expect(theirs).toMatchObject({ accountId: accountB, login: 'bob', provider: 'github' });
    expect(theirs!.tokenCiphertext).not.toBe(mine!.tokenCiphertext);
  });

  it('round-trips the real encrypted server store through PgDb', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-github-store-pg-'));
    const db = createDb(database.url);
    const git = new DbGitHubCredentialStore({ db, dataDir });
    const token = `gho_${'T'.repeat(36)}`;
    const aliceHuman = { identityId: identityA, authKind: 'browser', nodeAdmin: false };
    const aliceAgent = { identityId: identityA, authKind: 'agent', nodeAdmin: false };
    const bobAgent = { identityId: identityB, authKind: 'agent', nodeAdmin: false };

    try {
      await git.store(aliceHuman, { login: 'alice', token });
      await expect(git.resolve(aliceAgent)).resolves.toEqual({
        provider: 'github', login: 'alice', token,
      });
      await expect(git.resolve(bobAgent)).resolves.toBeNull();
      await git.delete(aliceHuman);
      await expect(git.resolve(aliceAgent)).resolves.toBeNull();
    } finally {
      await db.end();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('deletes idempotently and never touches another account row', async () => {
    await store(identityA, 'alice');
    await store(identityB, 'bob', OTHER_CIPHERTEXT);
    const first = await asApp(identityB, 'cli', async (client) =>
      (await client.query<{ value: { deleted: boolean } }>(
        `select public.delete_account_git_credential('github') value`,
      )).rows[0]!.value);
    const second = await asApp(identityB, 'cli', async (client) =>
      (await client.query<{ value: { deleted: boolean } }>(
        `select public.delete_account_git_credential('github') value`,
      )).rows[0]!.value);
    expect(first.deleted).toBe(true);
    expect(second.deleted).toBe(false);
    const survivors = await asOwner(async (client) =>
      (await client.query<{ account_id: string }>(
        'select account_id from public.account_git_credentials',
      )).rows);
    expect(survivors).toEqual([{ account_id: accountA }]);
  });
});

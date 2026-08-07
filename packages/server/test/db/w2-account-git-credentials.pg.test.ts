/**
 * 081 against a real Postgres: the table, the RLS policy, the column grant and
 * the three RPCs.
 *
 * The assertions here are the SECURITY claims, not the CRUD ones. Anyone can
 * write a test that stores a row and reads it back; what has to be pinned is
 * that account B cannot see account A's row, that `tm8_app` cannot name the
 * ciphertext column at all, and that no function which answers an HTTP request
 * has a path to the secret.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

interface Fixture {
  identityA: string;
  identityB: string;
  accountA: string;
  accountB: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** The application role — the only one the server ever connects as. */
async function asApp<T>(identityId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    return fn(client);
  });
}

/** The migration owner — stands in for "someone with the whole database". */
async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const CIPHERTEXT = Buffer.from('0123456789abcdef0123456789', 'utf8');
const NONCE = Buffer.alloc(12, 7);

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      identityA: 'git-cred-a',
      identityB: 'git-cred-b',
      accountA: randomUUID(),
      accountB: randomUUID(),
    };
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1,$2,'git-cred-a'), ($3,$4,'git-cred-b')`,
      [ids.accountA, ids.identityA, ids.accountB, ids.identityB],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('git_credentials');
  database.apply(migrationFiles());
  fixture = await seed();
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 240_000);

describe('081 account_git_credentials', () => {
  it('stores one credential per account+provider, and upserting rotates rather than duplicates', async () => {
    const stored = await asApp(fixture.identityA, async (client) =>
      (await client.query<{ value: Record<string, unknown> }>(
        `select public.set_account_git_credential('github','octocat',$1,$2) value`,
        [CIPHERTEXT, NONCE],
      )).rows[0]!.value);
    expect(stored).toMatchObject({ connected: true, provider: 'github', login: 'octocat' });
    // The status shape is the ONLY thing this RPC may answer with.
    expect(Object.keys(stored).sort()).toEqual(['connected', 'login', 'provider', 'updatedAt']);

    const rotated = Buffer.from('a completely different ciphertext', 'utf8');
    await asApp(fixture.identityA, async (client) => {
      await client.query(
        `select public.set_account_git_credential('github','octocat-renamed',$1,$2)`,
        [rotated, Buffer.alloc(12, 9)],
      );
    });

    const rows = await asOwner(async (client) =>
      (await client.query<{ login: string; token_ciphertext: Buffer }>(
        `select login, token_ciphertext from public.account_git_credentials where account_id = $1`,
        [fixture.accountA],
      )).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.login).toBe('octocat-renamed');
    expect(rows[0]!.token_ciphertext.equals(rotated)).toBe(true);
  });

  it('lets an account read ONLY its own row', async () => {
    await asApp(fixture.identityB, async (client) => {
      await client.query(
        `select public.set_account_git_credential('github','hubot',$1,$2)`,
        [CIPHERTEXT, NONCE],
      );
    });

    const seenByA = await asApp(fixture.identityA, async (client) =>
      (await client.query<{ login: string | null; account_id: string }>(
        `select account_id, login from public.account_git_credentials`,
      )).rows);
    // Two credentials exist in this database. A sees one, and it is theirs.
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.account_id).toBe(fixture.accountA);

    const seenByB = await asApp(fixture.identityB, async (client) =>
      (await client.query<{ account_id: string }>(
        `select account_id from public.account_git_credentials`,
      )).rows);
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]!.account_id).toBe(fixture.accountB);

    const total = await asOwner(async (client) =>
      (await client.query<{ count: string }>(
        `select count(*)::text count from public.account_git_credentials`,
      )).rows[0]!.count);
    expect(total).toBe('2');
  });

  it('refuses an unauthenticated caller outright', async () => {
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        return client.query(
          `select public.set_account_git_credential('github','nobody',$1,$2)`,
          [CIPHERTEXT, NONCE],
        );
      }),
    ).rejects.toMatchObject({ code: '28000' });
  });

  it('does not let tm8_app name the ciphertext columns at all', async () => {
    // Not "returns null", not "returns an empty row" — the PRIVILEGE is absent,
    // so the statement cannot be planned. This is the claim in the 081 header
    // that a policy change alone could never undo.
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select token_ciphertext from public.account_git_credentials`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select token_nonce from public.account_git_credentials`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select * from public.account_git_credentials`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gives tm8_app no way to write the table except through the RPCs', async () => {
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(
          `insert into public.account_git_credentials(account_id, provider, token_ciphertext, token_nonce)
           values ($1,'github',$2,$3)`,
          [fixture.accountA, CIPHERTEXT, NONCE],
        )),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`update public.account_git_credentials set login = 'someone-else'`)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`delete from public.account_git_credentials`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reads ciphertext back for the owning account only, through the one narrow function', async () => {
    const mine = await asApp(fixture.identityA, async (client) =>
      (await client.query<{ value: Record<string, string> | null }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value);
    expect(mine).toMatchObject({ accountId: fixture.accountA, provider: 'github' });
    expect(Buffer.from(mine!.tokenNonce, 'base64')).toHaveLength(12);

    const theirs = await asApp(fixture.identityB, async (client) =>
      (await client.query<{ value: Record<string, string> | null }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value);
    // B's own row, never A's — the function takes no account parameter, so
    // asking for someone else's is not expressible.
    expect(theirs!.accountId).toBe(fixture.accountB);
    expect(theirs!.tokenCiphertext).not.toBe(mine!.tokenCiphertext);
  });

  it('answers null rather than raising when nothing is stored', async () => {
    const identityC = 'git-cred-c';
    await asOwner(async (client) => {
      await client.query(
        `insert into public.accounts(id, identity_id, username) values ($1,$2,'git-cred-c')`,
        [randomUUID(), identityC],
      );
    });
    const value = await asApp(identityC, async (client) =>
      (await client.query<{ value: unknown }>(
        `select public.read_account_git_credential('github') value`,
      )).rows[0]!.value);
    expect(value).toBeNull();
  });

  it('deletes idempotently and only ever the caller own row', async () => {
    const first = await asApp(fixture.identityB, async (client) =>
      (await client.query<{ value: { deleted: boolean } }>(
        `select public.delete_account_git_credential('github') value`,
      )).rows[0]!.value);
    expect(first).toMatchObject({ connected: false, provider: 'github', deleted: true });

    const second = await asApp(fixture.identityB, async (client) =>
      (await client.query<{ value: { deleted: boolean } }>(
        `select public.delete_account_git_credential('github') value`,
      )).rows[0]!.value);
    // Not an error, and not a lie: nothing was deleted the second time.
    expect(second).toMatchObject({ connected: false, deleted: false });

    const survivors = await asOwner(async (client) =>
      (await client.query<{ account_id: string }>(
        `select account_id from public.account_git_credentials`,
      )).rows);
    expect(survivors.map((r) => r.account_id)).toEqual([fixture.accountA]);
  });

  it('refuses a provider the CHECK constraint does not admit', async () => {
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select public.set_account_git_credential('gitlab','octocat',$1,$2)`, [
          CIPHERTEXT,
          NONCE,
        ])),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses bytes that are not a plausible AES-GCM sealing', async () => {
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select public.set_account_git_credential('github','octocat',$1,$2)`, [
          CIPHERTEXT,
          Buffer.alloc(8, 1),
        ])),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asApp(fixture.identityA, (client) =>
        client.query(`select public.set_account_git_credential('github','octocat',$1,$2)`, [
          Buffer.alloc(4, 1),
          NONCE,
        ])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('disappears with the account it belongs to', async () => {
    await asOwner(async (client) => {
      await client.query(`delete from public.accounts where id = $1`, [fixture.accountA]);
    });
    const remaining = await asOwner(async (client) =>
      (await client.query<{ count: string }>(
        `select count(*)::text count from public.account_git_credentials`,
      )).rows[0]!.count);
    expect(remaining).toBe('0');
  });
});

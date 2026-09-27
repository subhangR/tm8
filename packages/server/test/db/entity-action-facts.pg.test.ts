/**
 * 999 (placeholder ordinal) — `internal.entity_action_facts` against a REAL PostgreSQL, as `tm8_app`
 * under each caller's claims (task 01a0e24d, doc 01a0e257 v2 change 2).
 *
 * The function exists so `actions.list` can advertise a credential, link or
 * server verb exactly when its door would admit it. So the pins here are
 * AGREEMENT pins: for each caller, the fact and the door's own answer match,
 * both ways. Plus the masking pin: the function returns no column that could
 * carry the secret, the key hint, the vendor login or a path.
 *
 * Cast, in space S: OWN owner, ADM admin, A and B members. OUT is in T only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'eaf-owner';
const ADM = 'eaf-admin';
const A = 'eaf-a';
const B = 'eaf-b';
const OUT = 'eaf-out';
const CAST = [OWN, ADM, A, B, OUT] as const;

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;

type Client = import('pg').PoolClient;
type Facts = {
  cred_can_manage: boolean | null;
  cred_can_revoke: boolean | null;
  cred_is_owner: boolean | null;
  cred_can_claim: boolean | null;
  cred_can_usage: boolean | null;
  cred_status: string | null;
  cred_shape: string | null;
  link_mine_status: string | null;
  link_is_member: boolean | null;
  link_ever_signed_in: boolean | null;
  server_can_remove: boolean | null;
};

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function facts(who: string, entityId: string): Promise<Facts> {
  const [row] = await db.query<Facts>(claims(who), 'select * from internal.entity_action_facts($1)', [entityId]);
  return row!;
}

/** Whether the door admits `who`: resolves true, refuses 42501 false, anything else throws. */
async function admits(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    const text = `${(error as { code?: string }).code ?? ''} ${String(error)}`;
    if (/42501|forbidden|not_found|only the|permission/i.test(text)) return false;
    throw error;
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-eaf-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('entity_action_facts');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of CAST) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2)`,
        [identity, identity === OWN],
      );
    }
    ids.S = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $4)`, [ids.S, ids.T, OWN, OUT]);
    const memberships: Array<[string, string, string]> = [
      [ids.S!, OWN, 'owner'], [ids.S!, ADM, 'admin'], [ids.S!, A, 'member'], [ids.S!, B, 'member'], [ids.T!, OUT, 'owner'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = ids[`member:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role],
      );
    }
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('999 entity_action_facts', () => {
  it('returns booleans and statuses only: no column that could carry a secret, hint, login or path', async () => {
    const [shape] = await database.query<{ args: string }>(
      `select pg_get_function_result('internal.entity_action_facts(uuid)'::regprocedure) args`,
    );
    expect(shape!.args).not.toMatch(/hint|login|secret|path|home|cipher|nonce|token|label/i);
    // Only tm8_app (and the owner) may call it.
    const [grant] = await database.query<{ app: boolean; pub: boolean }>(
      `select has_function_privilege('tm8_app', 'internal.entity_action_facts(uuid)', 'execute') app,
              has_function_privilege('public', 'internal.entity_action_facts(uuid)', 'execute') pub`,
    );
    expect(grant).toEqual({ app: true, pub: false });
  });

  it('credential: can_manage agrees with the rename door, can_usage with the usage door, for every caller', async () => {
    const created = await store.create(claims(A), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: 'eaf key', secret: `sk-eaf-${randomUUID()}`,
    });
    // A new row is ownerless until its creator chooses; claim it so it is A's.
    expect((await facts(A, created.id)).cred_can_claim).toBe(true);
    const credential = await store.claim(claims(A), created.id);
    for (const who of CAST) {
      const fact = await facts(who, credential.id);
      const renamed = await admits(() => store.rename(claims(who), credential.id, `eaf key ${who}`));
      expect({ who, manage: fact.cred_can_manage === true }).toEqual({ who, manage: renamed });
      const used = await admits(() => store.usage(claims(who), credential.id));
      expect({ who, usage: fact.cred_can_usage === true }).toEqual({ who, usage: used });
    }
    const mine = await facts(A, credential.id);
    expect(mine).toMatchObject({ cred_is_owner: true, cred_status: 'active', cred_shape: 'api_key', cred_can_claim: false });
    // A non-member learns nothing, not even the status.
    expect(await facts(OUT, credential.id)).toMatchObject({ cred_status: null, cred_can_manage: null });
  });

  it('credential, ownerless: usage is advertised to an admin only, per the fixed 255 door', async () => {
    const credential = await store.create(claims(A), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: 'eaf ownerless', secret: `sk-eaf-${randomUUID()}`,
    });
    // Written against the door AFTER its NULL fix (coalesce(owner = me,
    // false), separate PR, lands first): an ownerless row's usage is the
    // admins'. The door itself is pinned by that PR, not here.
    expect((await facts(ADM, credential.id)).cred_can_usage).toBe(true);
    expect((await facts(B, credential.id)).cred_can_usage).toBe(false);
    expect((await facts(A, credential.id)).cred_can_usage).toBe(false);
  });

  it('credential: can_revoke agrees with the revoke door; a revoked row reports revoked', async () => {
    for (const who of [B, ADM, A]) {
      const credential = await store.create(claims(A), {
        spaceId: ids.S!, provider: 'openai', shape: 'api_key', label: `eaf revoke ${who}`, secret: `sk-eaf-${randomUUID()}`,
      });
      const fact = await facts(who, credential.id);
      const revoked = await admits(() => store.revoke(claims(who), credential.id));
      expect({ who, revoke: fact.cred_can_revoke === true }).toEqual({ who, revoke: revoked });
      if (revoked) expect((await facts(A, credential.id)).cred_status).toBe('revoked');
    }
  });

  it('server: can_remove agrees with remove_server (creator or admin), and a non-member gets nulls', async () => {
    const add = (who: string, name: string) => db.rpc<{ id: string }>(claims(who), 'add_server',
      [ids.S, name, 'https://eaf.example', null, randomUUID()]);
    for (const who of [B, ADM, A]) {
      const server = await add(A, `eaf-${who}`);
      const fact = await facts(who, server.id);
      const removed = await admits(() => db.rpc(claims(who), 'remove_server', [server.id, randomUUID()]));
      expect({ who, remove: fact.server_can_remove === true }).toEqual({ who, remove: removed });
    }
    const kept = await add(A, 'eaf-kept');
    expect((await facts(OUT, kept.id)).server_can_remove).toBeNull();
  });

  it('space_link: the caller\'s own token row decides status and ever-signed-in', async () => {
    const link = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'space_link', 0, $3)`, [id, ids.S, ids[`member:${A}`]]);
      await c.query(`insert into public.space_links(entity_id, home_space_id, target_space_id) values ($1, $2, $3)`, [id, ids.S, ids.T]);
      for (const [who, status, used] of [[A, 'signed_in', true], [B, 'signed_out', false]] as const) {
        const member = ids[`member:${who}`]!;
        await c.query(
          `insert into public.space_link_tokens(link_id, home_space_id, member_id, target_space_id, aad, status, last_used_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, ids.S, member, ids.T, `${ids.S}|${id}|${member}|${ids.T}`, status, used ? new Date() : null],
        );
      }
      return id;
    });
    expect(await facts(A, link)).toMatchObject({ link_is_member: true, link_mine_status: 'signed_in', link_ever_signed_in: true });
    // B's row was never signed in: 256 refuses its relogin, so the fact is false.
    expect(await facts(B, link)).toMatchObject({ link_is_member: true, link_mine_status: 'signed_out', link_ever_signed_in: false });
    // ADM is a member with no row of their own.
    expect(await facts(ADM, link)).toMatchObject({ link_is_member: true, link_mine_status: null, link_ever_signed_in: false });
    expect(await facts(OUT, link)).toMatchObject({ link_is_member: null, link_mine_status: null });
  });
});

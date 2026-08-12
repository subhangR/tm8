/**
 * The capability split — migration 103.
 *
 * Seven of the eight accounts on the production node hold `is_node_admin`, and
 * that one flag gated everything from "register a working directory" to "reset
 * any account's password". This suite proves the gate actually moved, in both
 * directions, for every function — because a split that refused nothing new
 * would look identical to a split that worked, from any single passing test.
 *
 * Three properties, and the middle one is the one people forget:
 *
 *  1. WITHOUT its capability, each function refuses 42501.
 *  2. WITH it, each function is reached — i.e. the guard is the only thing that
 *     changed, and no body was damaged in the re-pointing.
 *  3. `is_node_admin` no longer implies anything, so an account holding only the
 *     flag is refused everywhere.
 *
 * Property 3 is the actual deliverable. Properties 1 and 2 without it would be
 * satisfied by a migration that added capabilities and left the flag working.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;

interface Actor { identity: string; accountId: string }
/** Holds every capability. */ let full: Actor;
/** Holds ONLY the legacy is_node_admin flag — the account that must now fail. */ let flagOnly: Actor;
/** Holds nothing. */ let plain: Actor;
/** A second ordinary account, used as the victim of takeover attempts. */ let victim: Actor;

const CAPABILITIES = [
  'users.provision', 'users.credentials', 'users.suspend', 'users.delete',
  'projects.register', 'projects.register.any', 'connections.manage',
  'node.maintain', 'capabilities.grant',
] as const;

async function asApp<T>(identity: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    if (identity) await client.query(`select set_config('tm8.identity_id',$1,true)`, [identity]);
    // Pinned TRUE for every caller, deliberately: the flag must not be able to
    // buy anything, so asserting it everywhere makes the negative cases mean
    // something rather than merely not being contradicted.
    await client.query(`select set_config('tm8.node_admin','true',true)`);
    return fn(client);
  });
}

async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function makeAccount(username: string, opts: { nodeAdmin?: boolean } = {}): Promise<Actor> {
  const identity = `id_${randomUUID()}`;
  const accountId = await asOwner(async (client) => {
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1,$2)`,
      [identity, username]);
    const r = await client.query<{ id: string }>(
      `insert into public.accounts(identity_id, username, is_node_admin)
       values ($1,$2,$3) returning id`, [identity, username, opts.nodeAdmin ?? false]);
    return r.rows[0]!.id;
  });
  return { identity, accountId };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('capability_split');
  database.apply(migrationFiles());

  full = await makeAccount('cap-full');
  flagOnly = await makeAccount('cap-flag-only', { nodeAdmin: true });
  plain = await makeAccount('cap-plain');
  victim = await makeAccount('cap-victim');

  await asOwner(async (client) => {
    for (const c of CAPABILITIES) {
      await client.query(
        `insert into public.account_capabilities(account_id, capability) values ($1,$2)`,
        [full.accountId, c]);
    }
  });
}, 180_000);

afterAll(async () => { await database?.destroy(); }, 180_000);

/**
 * One row per re-pointed function: a call that reaches its guard, and the
 * capability that guard now demands. The call arguments are chosen so that a
 * caller WITH the capability gets past the guard — it may then fail on its own
 * terms (not-found, no rows), which is a pass here. What must never happen is
 * 42501 for a holder, or anything other than 42501 for a non-holder.
 */
const MATRIX: Array<{ fn: string; capability: string; call: string; args?: unknown[] }> = [
  { fn: 'ensure_account', capability: 'users.provision',
    call: `select public.ensure_account($1,$2,null,null,false,false,null,null)`,
    args: [`id_${randomUUID()}`, `cap-new-${randomUUID().slice(0, 8)}`] },
  { fn: 'set_account_disabled', capability: 'users.suspend',
    call: `select public.set_account_disabled($1,false)`, args: ['VICTIM'] },
  { fn: 'revoke_account_sessions', capability: 'users.suspend',
    call: `select public.revoke_account_sessions($1)`, args: ['VICTIM'] },
  { fn: 'prune_auth_sessions', capability: 'node.maintain',
    call: `select public.prune_auth_sessions(interval '30 days')` },
  { fn: 'sweep_file_upload_slots', capability: 'node.maintain',
    call: `select public.sweep_file_upload_slots(1)` },
  { fn: 'mark_file_upload_slots_purged', capability: 'node.maintain',
    call: `select public.mark_file_upload_slots_purged('{}'::uuid[])` },
  { fn: 'purge_deleted_file_blobs', capability: 'node.maintain',
    call: `select public.purge_deleted_file_blobs(1,1,1)` },
  { fn: 'live_agent_session_work_ids', capability: 'node.maintain',
    call: `select public.live_agent_session_work_ids('node-x:1')` },
  { fn: 'revoke_orphaned_agent_sessions', capability: 'node.maintain',
    call: `select public.revoke_orphaned_agent_sessions('node-x:1','{}'::uuid[])` },
  { fn: 'create_server_connection', capability: 'connections.manage',
    call: `select public.create_server_connection($1,'http://127.0.0.1:9/',null,$2)`,
    args: [`peer-${randomUUID().slice(0, 8)}`, randomUUID()] },
  { fn: 'create_project', capability: 'projects.register.any',
    call: `select public.create_project($1,$2,null,'untrusted','{}'::jsonb,$3)`,
    args: [`cap-proj-${randomUUID().slice(0, 8)}`, `/tmp/cap-${randomUUID()}`, randomUUID()] },
];

function bind(args: unknown[] | undefined, actor: Actor): unknown[] {
  return (args ?? []).map((a) => (a === 'VICTIM' ? actor.accountId : a));
}

describe('103 — every re-pointed gate refuses without its capability', () => {
  for (const row of MATRIX) {
    it(`${row.fn} refuses a caller with no capabilities`, async () => {
      await expect(
        asApp(plain.identity, (c) => c.query(row.call, bind(row.args, victim) as never[])),
      ).rejects.toMatchObject({ code: '42501' });
    });
  }
});

describe('103 — is_node_admin no longer buys anything', () => {
  for (const row of MATRIX) {
    it(`${row.fn} refuses an account holding only the legacy flag`, async () => {
      await expect(
        asApp(flagOnly.identity, (c) => c.query(row.call, bind(row.args, victim) as never[])),
      ).rejects.toMatchObject({ code: '42501' });
    });
  }

  it('internal.has_capability answers false for a flag-only account', async () => {
    const answers = await asApp(flagOnly.identity, async (client) => {
      const r = await client.query<{ v: boolean }>(
        `select bool_or(internal.has_capability(c)) v from unnest($1::text[]) c`,
        [CAPABILITIES as unknown as string[]]);
      return r.rows[0]!.v;
    });
    expect(answers).toBe(false);
  });
});

describe('103 — every re-pointed gate is REACHED with its capability', () => {
  for (const row of MATRIX) {
    it(`${row.fn} gets past its guard for a holder`, async () => {
      // Past the guard is the assertion. The body may still refuse on its own
      // terms; what it must not do is raise 42501, which would mean the guard
      // is still refusing a legitimate holder.
      const error = await asApp(full.identity, (c) =>
        c.query(row.call, bind(row.args, victim) as never[])).catch((e) => e);
      if (error) expect(error).not.toMatchObject({ code: '42501' });
    });
  }
});

describe('103 — self-service is preserved exactly', () => {
  it('lets an account change its OWN password with no capability', async () => {
    await asApp(plain.identity, (c) =>
      c.query(`select public.set_account_credential($1,'hash','scrypt')`, [plain.accountId]));
    const stored = await asOwner(async (client) =>
      (await client.query<{ password_hash: string }>(
        `select password_hash from public.accounts where id=$1`, [plain.accountId])).rows[0]!.password_hash);
    expect(stored).toBe('hash');
  });

  it("refuses the same account changing SOMEONE ELSE's password", async () => {
    await expect(
      asApp(plain.identity, (c) =>
        c.query(`select public.set_account_credential($1,'hash','scrypt')`, [victim.accountId])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets an account mint and revoke its OWN session — login depends on this', async () => {
    const hash = 'c'.repeat(64);
    const sessionId = await asApp(plain.identity, async (client) => {
      const r = await client.query<{ v: { id: string } }>(
        `select public.issue_auth_session($1,$2,'cli',now()+interval '1 hour',null,'own') v`,
        [plain.accountId, hash]);
      return r.rows[0]!.v.id;
    });
    await asApp(plain.identity, (c) => c.query(`select public.revoke_auth_session($1)`, [sessionId]));
    const revoked = await asOwner(async (client) =>
      (await client.query<{ n: string }>(
        `select count(*)::text n from public.auth_sessions where id=$1 and revoked_at is not null`,
        [sessionId])).rows[0]!.n);
    expect(revoked).toBe('1');
  });

  it("refuses minting a session for SOMEONE ELSE without users.suspend", async () => {
    await expect(
      asApp(plain.identity, (c) =>
        c.query(`select public.issue_auth_session($1,$2,'cli',now()+interval '1 hour',null,'theirs')`,
          [victim.accountId, 'd'.repeat(64)])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('103 — the migration left nothing behind', () => {
  it('has no function in public that still gates on node admin', async () => {
    const leftover = await asOwner(async (client) =>
      (await client.query<{ names: string | null }>(
        `select string_agg(p.proname, ', ' order by p.proname) names
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.prokind = 'f'
            and pg_get_functiondef(p.oid) like '%require_node_admin()%'`)).rows[0]!.names);
    expect(leftover).toBeNull();
  });

  it('kept every re-pointed function a SECURITY DEFINER with a pinned search_path', async () => {
    // The re-pointing rewrote each definition. A dropped `security definer`
    // would turn a working guard into a permission error for every caller; a
    // dropped `search_path` is a search-path attack.
    const bad = await asOwner(async (client) =>
      (await client.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.prokind = 'f'
            and pg_get_functiondef(p.oid) like '%require_capability%'
            and (p.prosecdef is false or p.proconfig is null)`)).rows.map((r) => r.proname));
    expect(bad).toEqual([]);
  });
});

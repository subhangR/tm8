/**
 * The control plane — migration 101.
 *
 * `provision_user` is the operation the whole phase exists for: an account, the
 * person's OWN space, and the record of the home their agents will run in, in
 * one transaction. Before it, `ensure_account` wrote a profile row and an
 * account row and stopped, which is why `ramu` on the production node has an
 * account and zero memberships and sees "No spaces on this node".
 *
 * The properties pinned here are the ones a reader cannot check by inspection:
 *
 *  - provisioning is ATOMIC across account + space + home, and REPLAYS durably
 *    off `user_homes.request_key` rather than off the 24h command ledger;
 *  - `internal.create_space_for` — "create a space as somebody else" — is not
 *    reachable from a `tm8_app` connection at all, which is the entire reason it
 *    exists instead of the server binding another identity's claim;
 *  - capability grants cannot be used to widen yourself, and the two that can
 *    take the node are owner-only;
 *  - the adoption predicate is conservative enough that a SHARED space is never
 *    mistaken for somebody's personal one. That case is what the production
 *    node's seven-member space depends on.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;
/** The first account on the node — provisioned through the first-run hole. */
let operator: { identityId: string; accountId: string };

async function asApp<T>(identityId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    if (identityId !== null) {
      await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    }
    return fn(client);
  });
}

async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

interface Provisioned {
  account: { id: string; identity_id: string; username: string; is_node_admin: boolean };
  home: { identity_id: string; os_username: string; home_path: string; state: string; serial: number };
  spaceId: string;
  replayed: boolean;
}

async function provision(
  callerIdentity: string | null,
  username: string,
  extra: { displayName?: string; requestKey?: string } = {},
): Promise<Provisioned> {
  return asApp(callerIdentity, async (client) =>
    (await client.query<{ v: Provisioned }>(
      `select public.provision_user($1,$2,null,null,null,'/srv/tm8/homes',$3) v`,
      [username, extra.displayName ?? null, extra.requestKey ?? null],
    )).rows[0]!.v);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('control_plane');
  database.apply(migrationFiles());
  // A virgin node: the first call is claim-free, exactly as `ensure_account`'s
  // first-run hole is, because nobody can be authenticated yet.
  const first = await provision(null, 'operator', { displayName: 'Operator' });
  operator = { identityId: first.account.identity_id, accountId: first.account.id };
  // Provisioning never mints an owner or an admin, so the first account needs
  // its authority granted explicitly. Done as the graph owner because there is
  // nobody on the node yet who could grant it.
  await asOwner(async (client) => {
    await client.query(
      `insert into public.account_capabilities(account_id, capability)
       select $1, c from unnest(array['users.provision','capabilities.grant']) c`,
      [operator.accountId],
    );
  });
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe('provision_user', () => {
  it('creates the account, the personal space and the home record in one call', async () => {
    const result = await provision(operator.identityId, 'raghav', { displayName: 'Raghav' });

    expect(result.replayed).toBe(false);
    expect(result.account.username).toBe('raghav');
    // Never an owner and never an admin: capabilities are granted explicitly.
    expect(result.account.is_node_admin).toBe(false);
    expect(result.home.os_username).toMatch(/^tm8u\d+$/);
    expect(result.home.home_path).toBe(`/srv/tm8/homes/${result.home.os_username}`);
    expect(result.home.state).toBe('db_ready');

    const space = await asOwner(async (client) =>
      (await client.query<{ name: string; personal_for_identity: string; members: string }>(
        `select s.name, s.personal_for_identity,
                (select count(*)::text from public.members m where m.space_id=s.id) members
           from public.spaces s where s.id=$1`,
        [result.spaceId],
      )).rows[0]!);
    expect(space.name).toBe("Raghav's Space");
    expect(space.personal_for_identity).toBe(result.account.identity_id);
    expect(space.members).toBe('1');

    // The space is USABLE, not just present: a default channel, a menu and the
    // owner role are what make it somewhere you can land after logging in.
    const shape = await asOwner(async (client) =>
      (await client.query<{ channel: boolean; menus: string; role: string }>(
        `select s.default_channel_id is not null channel,
                (select count(*)::text from public.space_menu_configs mc where mc.space_id=s.id) menus,
                (select m.role from public.members m where m.space_id=s.id limit 1) role
           from public.spaces s where s.id=$1`,
        [result.spaceId],
      )).rows[0]!);
    expect(shape).toMatchObject({ channel: true, menus: '1', role: 'owner' });
  });

  it('grants every provisioned user projects.register — the de-escalation lever', async () => {
    const result = await provision(operator.identityId, 'bhargav');
    const caps = await asOwner(async (client) =>
      (await client.query<{ capability: string }>(
        `select c.capability from public.account_capabilities c where c.account_id=$1`,
        [result.account.id],
      )).rows.map((r) => r.capability));
    // Exactly one. Registering a project in your own home must not require the
    // capability that can reset another account's password.
    expect(caps).toEqual(['projects.register']);
  });

  it('replays a request_key durably and creates nothing the second time', async () => {
    const key = `provision-${randomUUID()}`;
    const first = await provision(operator.identityId, 'tarkesh', { requestKey: key });
    const before = await asOwner(async (client) =>
      (await client.query<{ n: string }>(`select count(*)::text n from public.accounts`)).rows[0]!.n);

    const second = await provision(operator.identityId, 'tarkesh', { requestKey: key });

    expect(second.replayed).toBe(true);
    expect(second.account.identity_id).toBe(first.account.identity_id);
    expect(second.spaceId).toBe(first.spaceId);
    const after = await asOwner(async (client) =>
      (await client.query<{ n: string }>(`select count(*)::text n from public.accounts`)).rows[0]!.n);
    expect(after).toBe(before);

    // The replay is keyed on a DURABLE row, not the command ledger, whose rows
    // `internal.prune_command_ledger` drops after 24h. Emptying the ledger must
    // not resurrect the ability to double-provision.
    await asOwner(async (client) => { await client.query(`delete from public.command_ledger`); });
    const third = await provision(operator.identityId, 'tarkesh', { requestKey: key });
    expect(third.replayed).toBe(true);
    expect(third.account.identity_id).toBe(first.account.identity_id);
  });

  it('refuses a duplicate username instead of handing back the existing account', async () => {
    await provision(operator.identityId, 'ganesh');
    await expect(provision(operator.identityId, 'ganesh')).rejects.toMatchObject({ code: '23505' });
    // And case-insensitively, because `accounts_username_lower_idx` (002:69) is
    // what the DB actually enforces.
    await expect(provision(operator.identityId, 'GANESH')).rejects.toMatchObject({ code: '23505' });
  });

  it('requires the capability once the node has an account', async () => {
    const plain = await provision(operator.identityId, 'nobody');
    await expect(provision(plain.account.identity_id, 'someone-else'))
      .rejects.toMatchObject({ code: '42501' });
    // And an unauthenticated caller is refused outright rather than falling
    // through the first-run hole, which closed with the first account.
    await expect(provision(null, 'anonymous')).rejects.toMatchObject({ code: '28000' });
  });

  it('refuses a relative or traversing homes root', async () => {
    for (const root of ['relative/path', '/srv/tm8/../../etc']) {
      await expect(asApp(operator.identityId, (client) =>
        client.query(`select public.provision_user('bad',null,null,null,null,$1,null)`, [root]),
      )).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('never lets one identity hold two personal spaces', async () => {
    const user = await provision(operator.identityId, 'twospaces');
    await expect(asOwner((client) =>
      client.query(
        `insert into public.spaces(id,name,created_by_identity,personal_for_identity)
         values (internal.new_id(),'Second',$1,$1)`,
        [user.account.identity_id],
      ),
    )).rejects.toMatchObject({ code: '23505' });
  });
});

describe('internal.create_space_for is not reachable from the app role', () => {
  it('refuses execution as tm8_app, which is why it exists instead of claim impersonation', async () => {
    await expect(asApp(operator.identityId, (client) =>
      client.query(`select internal.create_space_for($1,'Sneaky')`, [operator.identityId]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('leaves spaces.create behaving exactly as before — caller becomes the owner', async () => {
    const created = await asApp(operator.identityId, async (client) =>
      (await client.query<{ v: { memberId: string; space: { id: string } } }>(
        `select public.create_space('Ordinary','desc','private',null,$1) v`,
        [`create-${randomUUID()}`],
      )).rows[0]!.v);

    const row = await asOwner(async (client) =>
      (await client.query<{ identity_id: string; role: string; personal: string | null }>(
        `select m.identity_id, m.role, s.personal_for_identity personal
           from public.members m join public.spaces s on s.id = m.space_id
          where m.entity_id = $1`,
        [created.memberId],
      )).rows[0]!);
    expect(row.identity_id).toBe(operator.identityId);
    expect(row.role).toBe('owner');
    // An ordinary space is NOT anybody's personal space.
    expect(row.personal).toBeNull();
  });
});

describe('capability administration', () => {
  it('refuses a self-grant, so an operator cannot widen themselves', async () => {
    await expect(asApp(operator.identityId, (client) =>
      client.query(`select public.grant_account_capability($1,'node.maintain')`, [operator.accountId]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('reserves the two node-taking capabilities for the owner', async () => {
    const target = await provision(operator.identityId, 'wants-power');
    // The operator holds `capabilities.grant` but is NOT the owner.
    for (const capability of ['capabilities.grant', 'users.credentials']) {
      await expect(asApp(operator.identityId, (client) =>
        client.query(`select public.grant_account_capability($1,$2)`,
          [target.account.id, capability]),
      )).rejects.toMatchObject({ code: '42501' });
    }
    // An ordinary capability goes through.
    await asApp(operator.identityId, (client) =>
      client.query(`select public.grant_account_capability($1,'node.maintain')`,
        [target.account.id]));
    expect(await asOwner(async (client) =>
      (await client.query<{ n: string }>(
        `select count(*)::text n from public.account_capabilities
          where account_id=$1 and capability='node.maintain'`, [target.account.id],
      )).rows[0]!.n)).toBe('1');
  });

  it('resolves has_capability from the table, so a claim cannot manufacture one', async () => {
    const plain = await provision(operator.identityId, 'claim-forger');
    const answer = await database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id',$1,true)`, [plain.account.identity_id]);
      await client.query(`select set_config('tm8.node_admin','true',true)`);
      return (await client.query<{ v: boolean }>(
        `select internal.has_capability('users.provision') v`,
      )).rows[0]!.v;
    });
    expect(answer).toBe(false);
  });

  it('does not expose password hashes through the operator listing', async () => {
    const listed = await asApp(operator.identityId, async (client) =>
      (await client.query<{ v: Array<Record<string, unknown>> }>(
        `select public.list_provisioned_users() v`,
      )).rows[0]!.v);
    expect(listed.length).toBeGreaterThan(1);
    for (const row of listed) {
      expect(Object.keys(row)).not.toContain('password_hash');
      expect(Object.keys(row)).not.toContain('passwordHash');
    }
    expect(listed.some((r) => r.username === 'raghav' && r.personalSpaceId !== null)).toBe(true);
  });
});

describe('personal-space adoption is conservative', () => {
  it('never adopts a SHARED space — the production node depends on this', async () => {
    // A space with two members, created by one of them. The backfill predicate
    // requires exactly one member, so this must stay shared. Adopting it would
    // hand one person a "personal" space full of other people's work.
    const { spaceId, secondIdentity } = await asOwner(async (client) => {
      const a = await client.query<{ v: { space: { id: string } } }>(
        `select internal.create_space_for($1,'Shared team space') v`, [operator.identityId]);
      const sid = a.rows[0]!.v.space.id;
      const other = `id_${randomUUID()}`;
      await client.query(`insert into public.user_profiles(identity_id) values ($1)`, [other]);
      const memberId = randomUUID();
      await client.query(
        `insert into public.entities(id,space_id,kind,created_by) values ($1,$2,'member',$1)`,
        [memberId, sid]);
      await client.query(
        `insert into public.members(entity_id,space_id,identity_id,role) values ($1,$2,$3,'member')`,
        [memberId, sid, other]);
      return { spaceId: sid, secondIdentity: other };
    });

    // Re-run the adoption predicate exactly as the backfill states it.
    const adopted = await asOwner(async (client) =>
      (await client.query<{ n: string }>(
        `select count(*)::text n from public.spaces s
          where s.id = $1
            and s.personal_for_identity is null
            and (select count(*) from public.members m where m.space_id = s.id) = 1
            and exists (select 1 from public.members m
                         where m.space_id = s.id and m.identity_id = s.created_by_identity)`,
        [spaceId],
      )).rows[0]!.n);
    expect(adopted).toBe('0');
    expect(secondIdentity).toMatch(/^id_/);
  });
});

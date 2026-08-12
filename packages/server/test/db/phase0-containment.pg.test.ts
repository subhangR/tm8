/**
 * Phase 0 containment — migration 100.
 *
 * Two properties, both of which FakeDb structurally cannot see (it evaluates no
 * plpgsql and no RLS), so they are asserted against a real Postgres or they are
 * not asserted at all:
 *
 *   A. Node-admin authority resolves from `public.accounts`, not from the
 *      `tm8.node_admin` claim. The test that matters is the negative one — an
 *      identity that FORGES the claim must be refused — and its mirror, a real
 *      admin whose claim says `false` must still pass. Together those prove the
 *      table is the authority in both directions rather than merely agreeing
 *      with the claim on the happy path.
 *
 *   B. An agent bearer does not outlive its agent. `revoke_agent_auth_session`
 *      shipped in 074 with zero callers, so before this work a token lived its
 *      whole TTL regardless of whether the process still existed. The sweep is
 *      keyed on PTY liveness, and the test pins the specific thing that makes
 *      that choice load-bearing: a session marked `exited` in the DATABASE, by
 *      an ordinary member, must NOT lose its credential, because
 *      `work_session_transition` is `require_space_member` only and a
 *      status-keyed sweep would hand every member a one-call revocation of
 *      anyone's live agent.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const NODE_A = 'node-a:4610';
const NODE_B = 'node-b:4610';

interface Fixture {
  adminIdentity: string;
  plainIdentity: string;
  spaceId: string;
  adminMember: string;
  plainMember: string;
  personaId: string;
  /** Two sessions on this node, one on a different node. */
  sessionLive: string;
  sessionDead: string;
  sessionOtherNode: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** A caller bound as `tm8_app` with an identity, and optionally a forged claim. */
async function asApp<T>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
  claims: Record<string, string> = {},
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    for (const [name, value] of Object.entries(claims)) {
      await client.query(`select set_config($1,$2,true)`, [name, value]);
    }
    return fn(client);
  });
}

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function liveTokenCount(workSessionId: string): Promise<number> {
  return asOwner(async (client) => {
    const r = await client.query<{ n: string }>(
      `select count(*)::text n from public.auth_sessions
        where work_session_id = $1 and kind = 'agent' and revoked_at is null`,
      [workSessionId],
    );
    return Number(r.rows[0]!.n);
  });
}

async function mintAgentToken(workSessionId: string, hash: string): Promise<void> {
  await asApp(fixture.adminIdentity, async (client) => {
    await client.query(
      `select public.issue_agent_auth_session($1,$2,$3,now()+interval '48 hours',$4)`,
      [workSessionId, fixture.personaId, hash, `token for ${workSessionId}`],
    );
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids: Fixture = {
      adminIdentity: 'p0-admin',
      plainIdentity: 'p0-plain',
      spaceId: randomUUID(),
      adminMember: randomUUID(),
      plainMember: randomUUID(),
      personaId: randomUUID(),
      sessionLive: randomUUID(),
      sessionDead: randomUUID(),
      sessionOtherNode: randomUUID(),
    };
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1,'Admin'),($2,'Plain')`,
      [ids.adminIdentity, ids.plainIdentity],
    );
    // Exactly one of these two is a node admin. That asymmetry is the test.
    await client.query(
      `insert into public.accounts(id, identity_id, username, is_node_admin)
       values ($1,$2,'p0admin',true), ($3,$4,'p0plain',false)`,
      [randomUUID(), ids.adminIdentity, randomUUID(), ids.plainIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1,'Phase 0',$2)`,
      [ids.spaceId, ids.adminIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1,$7,'member',$1,'space'),
              ($2,$7,'member',$2,'space'),
              ($3,$7,'team_member',$1,'space'),
              ($4,$7,'work_session',$3,'space'),
              ($5,$7,'work_session',$3,'space'),
              ($6,$7,'work_session',$3,'space')`,
      [ids.adminMember, ids.plainMember, ids.personaId,
        ids.sessionLive, ids.sessionDead, ids.sessionOtherNode, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$3,$4,'owner','Admin'), ($2,$3,$5,'member','Plain')`,
      [ids.adminMember, ids.plainMember, ids.spaceId, ids.adminIdentity, ids.plainIdentity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1,$2,'P0 Agent','worker','persona')`,
      [ids.personaId, ids.adminMember],
    );
    // Migration 103 re-pointed these doors from `require_node_admin()` onto the
    // named `node.maintain` capability, and stopped `is_node_admin` implying
    // anything. The flag stays TRUE on this fixture on purpose: 100's property
    // was "the TABLE decides, not the claim", and 103's is "the CAPABILITY
    // decides, not the flag". Keeping the flag set is what lets the negative
    // cases below still prove both.
    await client.query(
      `insert into public.account_capabilities(account_id, capability)
       select id, c from public.accounts,
              unnest(array['node.maintain','projects.register.any']) c
        where identity_id = $1`,
      [ids.adminIdentity],
    );
    // All three are 'running' in the DB. The node id is what separates them.
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, node_id, started_at)
       values ($1,'live','running',$4,now()),
              ($2,'dead','running',$4,now()),
              ($3,'elsewhere','running',$5,now())`,
      [ids.sessionLive, ids.sessionDead, ids.sessionOtherNode, NODE_A, NODE_B],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1,$2,$3,'participates_in',$2),
              ($1,$2,$4,'participates_in',$2),
              ($1,$2,$5,'participates_in',$2)`,
      [ids.spaceId, ids.personaId, ids.sessionLive, ids.sessionDead, ids.sessionOtherNode],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('phase0_containment');
  database.apply(migrationFiles());
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe('100/103 — authority is a table-resolved CAPABILITY, never a claim or a flag', () => {
  it('refuses a forged tm8.node_admin claim, and the legacy flag, on the write gates', async () => {
    const forged = { 'tm8.node_admin': 'true' };

    // The claim accessor still reports what the claim says: it is a claim
    // READER and 009 grants it deliberately. What must not happen is any gate
    // deciding on it.
    const [claimSays, tableSays] = await asApp(fixture.plainIdentity, async (client) => {
      const r = await client.query<{ claim: boolean; tbl: boolean }>(
        `select internal.is_node_admin() claim, internal.has_node_admin_account() tbl`,
      );
      return [r.rows[0]!.claim, r.rows[0]!.tbl];
    }, forged);
    expect(claimSays).toBe(true);
    expect(tableSays).toBe(false);

    for (const call of [
      `select public.sweep_file_upload_slots(1)`,
      `select public.mark_file_upload_slots_purged('{}'::uuid[])`,
      `select public.purge_deleted_file_blobs(1,1,1)`,
      `select public.live_agent_session_work_ids('${NODE_A}')`,
      `select public.revoke_orphaned_agent_sessions('${NODE_A}','{}'::uuid[])`,
    ]) {
      await expect(
        asApp(fixture.plainIdentity, (client) => client.query(call), forged),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('admits a capability holder even when the claim says false', async () => {
    const denied = { 'tm8.node_admin': 'false' };
    const ok = await asApp(fixture.adminIdentity, async (client) => {
      const r = await client.query<{ tbl: boolean }>(
        `select internal.has_node_admin_account() tbl`,
      );
      await client.query(`select public.sweep_file_upload_slots(1)`);
      return r.rows[0]!.tbl;
    }, denied);
    expect(ok).toBe(true);
  });

  it('hides other spaces’ projects from a forged claim but shows them to a capability holder', async () => {
    const projectId = randomUUID();
    await asOwner(async (client) => {
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1,'unlinked','/tmp/p0-unlinked-project','untrusted')`,
        [projectId],
      );
    });

    // Not linked to any space, so membership cannot explain seeing it — the
    // node-admin arm of projects_select is the only way through.
    const forgedRows = await asApp(fixture.plainIdentity, async (client) =>
      (await client.query(`select id from public.projects where id=$1`, [projectId])).rowCount,
      { 'tm8.node_admin': 'true' });
    expect(forgedRows).toBe(0);

    const adminRows = await asApp(fixture.adminIdentity, async (client) =>
      (await client.query(`select id from public.projects where id=$1`, [projectId])).rowCount,
      { 'tm8.node_admin': 'false' });
    expect(adminRows).toBe(1);
  });
});

describe('100 part B — orphaned agent credentials', () => {
  it('revokes credentials with no live PTY, keeps the live one, never touches another node', async () => {
    await mintAgentToken(fixture.sessionLive, 'a'.repeat(64));
    await mintAgentToken(fixture.sessionDead, 'b'.repeat(64));
    await mintAgentToken(fixture.sessionOtherNode, 'c'.repeat(64));

    const outstanding = await asApp(fixture.adminIdentity, async (client) =>
      (await client.query<{ v: string[] }>(
        `select public.live_agent_session_work_ids($1) v`, [NODE_A],
      )).rows[0]!.v);
    // This node's two sessions, and NOT the one belonging to node B.
    expect(new Set(outstanding)).toEqual(new Set([fixture.sessionLive, fixture.sessionDead]));

    // The node reports one live PTY. The other is an orphan.
    const result = await asApp(fixture.adminIdentity, async (client) =>
      (await client.query<{ v: { revoked: number; workSessionIds: string[] } }>(
        `select public.revoke_orphaned_agent_sessions($1,$2::uuid[]) v`,
        [NODE_A, [fixture.sessionLive]],
      )).rows[0]!.v);

    expect(result.revoked).toBe(1);
    expect(result.workSessionIds).toEqual([fixture.sessionDead]);
    expect(await liveTokenCount(fixture.sessionLive)).toBe(1);
    expect(await liveTokenCount(fixture.sessionDead)).toBe(0);
    // The whole point of the node_id bound: node A cannot revoke node B's agents.
    expect(await liveTokenCount(fixture.sessionOtherNode)).toBe(1);
  });

  it('does NOT revoke on a database status flip, because status is member-writable', async () => {
    // This is the DoS the PTY-keyed design exists to avoid, driven through the
    // real member-callable path rather than simulated: `work_session_transition`
    // is `require_space_member` only (043:92). `plain` is an ordinary member who
    // neither owns nor spawned this session, and the call succeeds — that IS the
    // vector. What must not follow is the credential dying.
    await asApp(fixture.plainIdentity, async (client) => {
      await client.query(
        `select public.work_session_transition($1,'exited',0,null,null,$2)`,
        [fixture.sessionLive, `p0-dos-${randomUUID()}`],
      );
    });
    const flipped = await asOwner(async (client) =>
      (await client.query<{ status: string }>(
        `select status from public.work_sessions where entity_id=$1`, [fixture.sessionLive],
      )).rows[0]!.status);
    expect(flipped).toBe('exited');

    // Still offered, and still spared while its PTY is live.
    const outstanding = await asApp(fixture.adminIdentity, async (client) =>
      (await client.query<{ v: string[] }>(
        `select public.live_agent_session_work_ids($1) v`, [NODE_A],
      )).rows[0]!.v);
    expect(outstanding).toContain(fixture.sessionLive);

    await asApp(fixture.adminIdentity, async (client) => {
      await client.query(
        `select public.revoke_orphaned_agent_sessions($1,$2::uuid[])`,
        [NODE_A, [fixture.sessionLive]],
      );
    });
    expect(await liveTokenCount(fixture.sessionLive)).toBe(1);
  });

  it('revokes everything on this node when the live set is empty — the boot repair', async () => {
    await asApp(fixture.adminIdentity, async (client) => {
      await client.query(
        `select public.revoke_orphaned_agent_sessions($1,'{}'::uuid[])`, [NODE_A],
      );
    });
    expect(await liveTokenCount(fixture.sessionLive)).toBe(0);
    expect(await liveTokenCount(fixture.sessionDead)).toBe(0);
    expect(await liveTokenCount(fixture.sessionOtherNode)).toBe(1);
  });

  it('refuses a blank node id rather than sweeping the world', async () => {
    await expect(
      asApp(fixture.adminIdentity, (client) =>
        client.query(`select public.revoke_orphaned_agent_sessions('  ','{}'::uuid[])`)),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('100 part C — the account count for the boot invariant', () => {
  it('counts accounts claim-free, because boot has no identity yet', async () => {
    const n = await database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      return (await client.query<{ v: number }>(
        `select public.node_account_count() v`,
      )).rows[0]!.v;
    });
    expect(n).toBe(2);
  });
});

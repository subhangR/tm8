/**
 * 372 against a real Postgres: `public.work_session_home_facts`, the read the
 * Codex home reclaim decides from.
 *
 * The reclaim treats an id missing from this answer as "no such session" and
 * removes that session's home. So the property that matters most is the one
 * an RLS-scoped read would get wrong: a node admin who is NOT a member of a
 * session's space still gets its row. Also pinned: only a node admin may call
 * it, a deleted row is reported as deleted (not left out), the status, paths
 * and ending come through, and an unknown id is simply absent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

interface HomeFact {
  sessionId: string;
  status: string;
  deleted: boolean;
  workdirMode: string;
  workdirPath: string | null;
  exitedAt: string | null;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const ADMIN_ELSEWHERE = 'home-facts-372-node-admin';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

let database: W1ScratchDatabase;
let fixture: Fixture;
let unique = 0;
const cmid = (label: string): string => `home-facts-372-${label}-${(unique += 1)}`;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'home-facts-372-owner'::text "identityId", internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId", internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Owner')`, [
      f.identityId,
    ]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Home facts',$2)`, [
      f.spaceId,
      f.identityId,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Worker','','persona')`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

/** As tm8_app, as `identityId`, with the node-admin claim as given. */
async function asApp<T>(fn: (q: Q) => Promise<T>, identityId: string, nodeAdmin: boolean): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin',$2,true),set_config('tm8.request_id','req-372',true),
              set_config('tm8.work_session_id','',true)`,
      [identityId, nodeAdmin ? 'true' : 'false'],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

const asOwner = <T>(fn: (q: Q) => Promise<T>): Promise<T> => asApp(fn, fixture.identityId, false);

async function spawn(): Promise<string> {
  const rows = await asOwner((q) =>
    q(
      `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => '{}'::uuid[],
         p_workdir_mode => 'scratch', p_model => 'gpt-5.5', p_agent_tool => 'codex',
         p_title => 'Run', p_node_id => 'node-local', p_confirm_untrusted => true,
         p_session_cap => 64, p_client_mutation_id => $3) result`,
      [fixture.spaceId, fixture.teamMemberId, cmid('spawn')],
    ),
  );
  const id = (rows[0]!.result as { entity: { id: string } }).entity.id;
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `select internal.settle_credential_binding($1, '{"effectiveCredentialSources":{"openai":"node"}}'::jsonb)`,
      [id],
    );
  });
  return id;
}

async function transition(sessionId: string, status: string): Promise<void> {
  await asOwner((q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3,null,null)`, [sessionId, status, cmid(status)]),
  );
}

async function facts(ids: string[], identityId = ADMIN_ELSEWHERE, nodeAdmin = true): Promise<HomeFact[]> {
  const rows = await asApp(
    (q) => q(`select public.work_session_home_facts($1::uuid[]) result`, [ids]),
    identityId,
    nodeAdmin,
  );
  return rows[0]!.result as HomeFact[];
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('home-facts-372');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('372 — work_session_home_facts', () => {
  it('answers a node admin for a session in a space it is not a member of, where RLS would hide it', async () => {
    const running = await spawn();
    await transition(running, 'running');

    // Control: the same caller reading through RLS sees nothing.
    const visible = await asApp(
      (q) => q(`select entity_id from public.work_sessions where entity_id = $1`, [running]),
      ADMIN_ELSEWHERE,
      true,
    );
    expect(visible).toEqual([]);

    const rows = await facts([running]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: running, status: 'running', deleted: false, exitedAt: null });
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['deleted', 'exitedAt', 'sessionId', 'status', 'workdirMode', 'workdirPath'],
    );
  });

  it('reports an ended session with its ending, and a deleted one as deleted rather than leaving it out', async () => {
    const ended = await spawn();
    await transition(ended, 'running');
    await transition(ended, 'exited');
    const deleted = await spawn();
    await transition(deleted, 'running');
    await transition(deleted, 'exited');
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [deleted]);
    });

    const rows = new Map((await facts([ended, deleted, UNKNOWN])).map((row) => [row.sessionId, row]));

    expect(rows.size).toBe(2);
    expect(rows.has(UNKNOWN)).toBe(false);
    expect(rows.get(ended)).toMatchObject({ status: 'exited', deleted: false });
    expect(Number.isFinite(Date.parse(rows.get(ended)!.exitedAt ?? ''))).toBe(true);
    expect(rows.get(deleted)).toMatchObject({ status: 'exited', deleted: true });
  });

  it('refuses anyone who is not a node admin, the space owner included', async () => {
    const id = await spawn();
    await expect(facts([id], fixture.identityId, false)).rejects.toMatchObject({ code: '42501' });
  });

  it('bounds a call at 1000 ids and answers an empty list with an empty array', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(facts(many)).rejects.toMatchObject({ code: '22023' });
    expect(await facts([])).toEqual([]);
  });
});

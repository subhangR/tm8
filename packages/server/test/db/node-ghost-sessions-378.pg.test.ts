/**
 * 378 against a real Postgres: a node retires its ghost sessions in EVERY
 * space, and the cap and the ghost read agree on what "live" means.
 *
 * The defect (prod, 2026-10-28): boot reconciliation and the lost-session
 * reaper run as the node's loopback owner, read their candidates through RLS
 * and write through `work_session_transition`. The owner is a member of one
 * space; ghosts in the others were never candidates, and would have been
 * refused at the write anyway. The cap counts every space, so they refused
 * launches everywhere.
 *
 * Pinned here: the old read misses the other space's ghost (the reproduction);
 * the node read and the ending door reach it; the ending is the process fact
 * only (outcome and claims untouched), pairs status with kind, leaves an
 * `execution.node_ending` ledger row and returns the usage facts; the usage
 * door writes in any space; only a node admin may call any door, and the node
 * id scopes each; `session_capacity` gives every caller the node-wide `used`;
 * and the cap's count equals the node read on a fixture holding every
 * status × outcome × kind × deleted combination.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface SpaceFixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const NODE = 'node-local';
const OTHER_NODE = 'node-elsewhere';

let database: W1ScratchDatabase;
/** The node owner's own space. */
let mine: SpaceFixture;
/** A space the node owner is NOT a member of. */
let theirs: SpaceFixture;
let unique = 0;
const cmid = (label: string): string => `ghost-378-${label}-${(unique += 1)}`;

async function seedSpace(db: W1ScratchDatabase, identityId: string, name: string): Promise<SpaceFixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<SpaceFixture>(
        `select $1::text "identityId", internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId", internal.new_id()::text "teamMemberId"`,
        [identityId],
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,$2) on conflict do nothing`,
      [identityId, name],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,$2,$3)`, [
      f.spaceId,
      name,
      identityId,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner',$4)`,
      [f.memberId, f.spaceId, identityId, name],
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
              set_config('tm8.node_admin',$2,true),set_config('tm8.request_id','req-378',true),
              set_config('tm8.work_session_id','',true)`,
      [identityId, nodeAdmin ? 'true' : 'false'],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** The node's background identity: the owner of `mine`, a node admin. */
const asNode = <T>(fn: (q: Q) => Promise<T>): Promise<T> => asApp(fn, mine.identityId, true);

async function asGraphOwner(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`select set_config('tm8.work_session_transition','on',true)`);
    return (await client.query(sql, params)).rows as Record<string, unknown>[];
  });
}

async function spawnRunning(space: SpaceFixture, node = NODE): Promise<string> {
  const rows = await asApp(
    (q) =>
      q(
        `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => '{}'::uuid[],
           p_workdir_mode => 'scratch', p_model => 'gpt-5.5', p_agent_tool => 'codex',
           p_title => 'Run', p_node_id => $4, p_confirm_untrusted => true,
           p_session_cap => 100000, p_client_mutation_id => $3) result`,
        [space.spaceId, space.teamMemberId, cmid('spawn'), node],
      ),
    space.identityId,
    false,
  );
  const id = (rows[0]!.result as { entity: { id: string } }).entity.id;
  await asGraphOwner(
    `select internal.settle_credential_binding($1, '{"effectiveCredentialSources":{"openai":"node"}}'::jsonb)`,
    [id],
  );
  await asApp(
    (q) => q(`select public.work_session_transition($1,'running',null,null,null,$2,null,null)`, [id, cmid('run')]),
    space.identityId,
    false,
  );
  return id;
}

async function sessionRow(id: string): Promise<Record<string, unknown>> {
  return (
    await asGraphOwner(
      `select ws.status, ws.outcome, ws.ended_kind, ws.ended_reason, ws.error, ws.exited_at, e.version
         from public.work_sessions ws join public.entities e on e.id = ws.entity_id
        where ws.entity_id = $1`,
      [id],
    )
  )[0]!;
}

const nodeLive = async (node = NODE): Promise<string[]> =>
  (await asNode((q) => q(`select session_id from public.node_live_work_sessions($1)`, [node]))).map((r) =>
    String(r.session_id),
  );

interface Ending {
  recorded: boolean;
  usageFacts: Record<string, unknown> | null;
}

const recordEnding = (id: string, kind = 'lost', status = 'failed', node = NODE): Promise<Ending> =>
  asNode((q) =>
    q(`select public.node_record_work_session_ending($1,$2,$3,$4,'Lost: gone.','marked lost by test') r`, [
      node,
      id,
      status,
      kind,
    ]),
  ).then((rows) => rows[0]!.r as Ending);

const recordLost = (id: string, kind = 'lost', node = NODE): Promise<boolean> =>
  recordEnding(id, kind, 'failed', node).then((r) => r.recorded);

const capacity = async (
  identity: string,
  node: string | null,
  held: string[] = [],
): Promise<{ used: number; ghosts: number | null }> => {
  const row = (
    await asApp((q) => q(`select used, ghosts from public.session_capacity($1,$2::uuid[])`, [node, held]),
      identity, false)
  )[0]!;
  return { used: Number(row.used), ghosts: row.ghosts === null ? null : Number(row.ghosts) };
};

beforeAll(async () => {
  database = await createW1ScratchDatabase('ghost-378');
  database.apply(migrationFiles());
  mine = await seedSpace(database, 'ghost-378-node-owner', 'Owner space');
  theirs = await seedSpace(database, 'ghost-378-other-member', 'Someone else');
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('378 — node ghost sessions', () => {
  it('reproduction: the RLS-scoped candidate read misses a ghost in a space the node owner is not in', async () => {
    const own = await spawnRunning(mine);
    const foreign = await spawnRunning(theirs);

    // The pre-378 `DbGraphPort.listNodeActiveSessions` SQL, verbatim, as the node.
    const old = await asNode((q) =>
      q(
        `select ws.entity_id from public.work_sessions ws join public.entities e on e.id = ws.entity_id
          where ws.node_id = $1 and ws.status in ('spawning','running','idle') and e.deleted_at is null`,
        [NODE],
      ),
    );
    const oldIds = old.map((r) => String(r.entity_id));
    expect(oldIds).toContain(own);
    expect(oldIds).not.toContain(foreign);

    // ...and the pre-378 write is refused for it.
    await expect(
      asNode((q) =>
        q(`select public.work_session_transition($1,'failed',null,'x',null,$2,'lost','x')`, [foreign, cmid('old')]),
      ),
    ).rejects.toThrow(/not a member/);

    // The node read sees both.
    const ids = await nodeLive();
    expect(ids).toEqual(expect.arrayContaining([own, foreign]));
  });

  it('records the process fact only, in a space the node owner is not a member of', async () => {
    const foreign = await spawnRunning(theirs);
    const before = await sessionRow(foreign);

    const ending = await recordEnding(foreign);
    expect(ending.recorded).toBe(true);
    // The facts the node needs to find the transcript, and nothing else.
    expect(Object.keys(ending.usageFacts ?? {}).sort()).toEqual(
      ['agentConfigDir', 'agentTool', 'nativeSessionId', 'workdirMode', 'workdirPath'],
    );
    expect(ending.usageFacts).toMatchObject({ agentTool: 'codex', workdirMode: 'scratch' });

    const after = await sessionRow(foreign);
    expect(after).toMatchObject({
      status: 'failed',
      outcome: 'open',
      ended_kind: 'lost',
      ended_reason: 'Lost: gone.',
      error: 'marked lost by test',
    });
    expect(after.exited_at).not.toBeNull();
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    expect(await nodeLive()).not.toContain(foreign);
    // A second write finds nothing live and says so, rather than rewriting the ending.
    expect(await recordLost(foreign, 'server_restart')).toBe(false);
    expect((await sessionRow(foreign)).ended_kind).toBe('lost');
  });

  it('is scoped to the node named: a session on another node is neither listed nor written', async () => {
    const elsewhere = await spawnRunning(theirs, OTHER_NODE);
    expect(await nodeLive()).not.toContain(elsewhere);
    expect(await recordLost(elsewhere)).toBe(false);
    expect((await sessionRow(elsewhere)).status).toBe('running');
  });

  it('refuses a plain member and a non-admin identity, and any ending a node cannot infer', async () => {
    const foreign = await spawnRunning(theirs);
    // The space's own owner, a member, but not a node admin.
    await expect(
      asApp((q) => q(`select public.node_record_work_session_ending($1,$2,'failed','lost','r','e')`, [NODE, foreign]),
        theirs.identityId, false),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp((q) => q(`select * from public.node_live_work_sessions($1)`, [NODE]), theirs.identityId, false),
    ).rejects.toMatchObject({ code: '42501' });
    // An identity with no membership anywhere and no node-admin claim.
    await expect(
      asApp((q) => q(`select public.node_record_work_session_ending($1,$2,'failed','lost','r','e')`, [NODE, foreign]),
        'ghost-378-stranger', false),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp((q) => q(`select public.node_record_work_session_usage($1,$2,'{}'::jsonb,'codex_rollout')`, [NODE, foreign]),
        theirs.identityId, false),
    ).rejects.toMatchObject({ code: '42501' });
    // A node admin naming no node, or an ending that is not a process fact.
    await expect(asNode((q) => q(`select * from public.node_live_work_sessions('')`))).rejects.toMatchObject({
      code: '22023',
    });
    // exited_clean only with exited, and the inferable kinds only with failed.
    await expect(recordLost(foreign, 'exited_clean')).rejects.toMatchObject({ code: '22023' });
    await expect(recordEnding(foreign, 'lost', 'exited')).rejects.toMatchObject({ code: '22023' });
    await expect(recordLost(foreign, 'stopped_by_operator')).rejects.toMatchObject({ code: '22023' });
    await expect(recordLost(foreign, 'credential_revoked')).rejects.toMatchObject({ code: '22023' });
    expect((await sessionRow(foreign)).status).toBe('running');
  });

  it('leaves an execution.node_ending ledger row naming the node identity and the reason', async () => {
    const foreign = await spawnRunning(theirs);
    expect(await recordLost(foreign)).toBe(true);
    const rows = await asGraphOwner(
      `select identity_id, operation, result from public.command_ledger
        where operation = 'execution.node_ending' and result->>'sessionId' = $1`,
      [foreign],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identity_id: mine.identityId,
      result: { nodeId: NODE, status: 'failed', endedKind: 'lost', reason: 'marked lost by test' },
    });
  });

  it('closes a completed session’s idle process as exited / exited_clean, outcome untouched', async () => {
    const done = await spawnRunning(theirs);
    await asGraphOwner(
      `with ok as (select set_config('tm8.work_session_outcome','on',true))
       update public.work_sessions set outcome = 'completed', outcome_at = now(), outcome_source = 'operator'
        where entity_id = $1 and (select true from ok)`,
      [done],
    );
    // Not a ghost candidate (the cap does not count it either)...
    expect(await nodeLive()).not.toContain(done);
    // ...but its process is still recorded live, so the auto-close may end it.
    expect((await recordEnding(done, 'exited_clean', 'exited')).recorded).toBe(true);
    expect(await sessionRow(done)).toMatchObject({ status: 'exited', outcome: 'completed', ended_kind: 'exited_clean' });
  });

  it('writes usage for a session this node ran, in a space the node owner is not in', async () => {
    const foreign = await spawnRunning(theirs);
    await recordLost(foreign);
    const usage = { transcript: { messages: 3 }, transcriptBytes: 10 };
    const write = (node: string) =>
      asNode((q) =>
        q(`select public.node_record_work_session_usage($1,$2,$3::jsonb,'codex_rollout') ok`, [node, foreign,
          JSON.stringify(usage)]),
      ).then((rows) => rows[0]!.ok);
    expect(await write(NODE)).toBe(true);
    expect(await write(OTHER_NODE)).toBe(false);
    const row = await asGraphOwner(`select usage, usage_source from public.work_sessions where entity_id = $1`, [foreign]);
    expect(row[0]).toMatchObject({ usage, usage_source: 'codex_rollout' });
  });

  it('session_capacity: used is node-wide for ANY caller; ghosts is this node’s share with no PTY here', async () => {
    const held = await spawnRunning(mine);
    const live = await nodeLive();
    const cap = Number((await asGraphOwner(`select internal.live_work_session_count(null) n`))[0]!.n);
    // A member of ONE space sees the same `used` the spawn gate counts, not
    // its own spaces' share, so `used` and `ghosts` describe one population.
    for (const identity of [theirs.identityId, mine.identityId]) {
      expect((await capacity(identity, null)).used).toBe(cap);
    }
    expect(await capacity(theirs.identityId, null)).toMatchObject({ ghosts: null });
    expect((await capacity(theirs.identityId, NODE)).ghosts).toBe(live.length);
    expect((await capacity(theirs.identityId, NODE, [held])).ghosts).toBe(live.length - 1);
    expect((await capacity(theirs.identityId, NODE, live)).ghosts).toBe(0);
  });

  it('the cap and the node read share one definition of live, on every combination', async () => {
    const template = await spawnRunning(mine);
    const statuses = ['spawning', 'running', 'idle', 'exited', 'failed'];
    const outcomes = ['open', 'completed', 'stopped'];
    const kinds = ['agent', 'credential', 'shell'];
    for (const status of statuses) {
      for (const outcome of outcomes) {
        for (const kind of kinds) {
          for (const deleted of [false, true]) {
            await asGraphOwner(
              `with id as (select internal.new_id() v),
                    ent as (
                      insert into public.entities
                      select (jsonb_populate_record(null::public.entities, to_jsonb(e) || jsonb_build_object(
                        'id', (select v from id),
                        'deleted_at', case when $5 then now() else null end))).*
                        from public.entities e where e.id = $1
                      returning id)
               insert into public.work_sessions
               select (jsonb_populate_record(null::public.work_sessions, to_jsonb(ws) || jsonb_build_object(
                 'entity_id', (select id from ent),
                 'status', $2::text, 'outcome', $3::text, 'session_kind', $4::text,
                 'outcome_at', case when $3 = 'open' then null else now() end,
                 'outcome_source', case when $3 = 'open' then null else 'operator' end,
                 -- Minted fresh, as the insert guard (273) requires.
                 'credential_binding', null, 'credential_none_reason', null,
                 'client_mutation_id', null))).*
                 from public.work_sessions ws where ws.entity_id = $1`,
              [template, status, outcome, kind, deleted],
            );
          }
        }
      }
    }

    // Every session in this database is on NODE or OTHER_NODE; take OTHER_NODE's out.
    const cap = Number((await asGraphOwner(`select internal.live_work_session_count(null) n`))[0]!.n);
    const otherNode = (await nodeLive(OTHER_NODE)).length;
    const live = await nodeLive();
    expect(cap - otherNode).toBe(live.length);
    // The capacity read counts the same population as the cap.
    expect((await capacity(theirs.identityId, null)).used).toBe(cap);
    // Not vacuous: 3 live statuses x 2 unfinished outcomes, agent, not deleted.
    expect(live.length).toBeGreaterThanOrEqual(6);

    // And row for row: the node read is exactly the rows the shared predicate calls live.
    const expected = (
      await asGraphOwner(
        `select ws.entity_id from public.work_sessions ws join public.entities e on e.id = ws.entity_id
          where ws.node_id = $1
            and ws.status in ('spawning','running','idle') and ws.outcome <> 'completed'
            and ws.session_kind = 'agent' and e.deleted_at is null
          order by 1`,
        [NODE],
      )
    ).map((r) => String(r.entity_id));
    expect(live).toEqual(expected);
  });
});

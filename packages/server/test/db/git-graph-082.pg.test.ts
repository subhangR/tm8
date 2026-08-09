/**
 * 082 — git facts as graph citizens, proven against a real chain.
 *
 * Four claims, each the SQL half of a Tier 4 acceptance line:
 *
 *  1. A pull-request STATE change authors a contract-shaped
 *     `git.pr_state_changed` row on `workspace_events`; a refresh that learns
 *     nothing authors nothing (the observer's "I looked" must stay silent).
 *  2. `record_session_commit` mints the commit mirror ONCE (link_commit's
 *     dedupe key), stamps exactly one `created_in` edge commit→session, and
 *     the insert trigger authors `git.commit_recorded`.
 *  3. A worktree status transition authors `git.worktree_status_changed`.
 *  4. The completion gate: DEFAULT behaviour unchanged (an open tracked PR
 *     does not block an ungated task); `pr_merged` refuses on an open PR, on
 *     a merged-but-CI-red PR, and on a gate with no tracked PR at all; a
 *     merged PR with passing CI completes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  gatedTaskId: string;
  plainTaskId: string;
  bareGateTaskId: string;
  workSessionId: string;
  projectId: string;
  worktreeId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 't4-owner'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "gatedTaskId", internal.new_id()::text "plainTaskId",
              internal.new_id()::text "bareGateTaskId", internal.new_id()::text "workSessionId",
              internal.new_id()::text "projectId", internal.new_id()::text "worktreeId"`,
    )).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'T4 owner')`,
      [fixture.identityId]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'T4 Space',$2)`,
      [fixture.spaceId, fixture.identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$6,'member',null,0,$1),($2,$6,'task',null,10,$1),($3,$6,'task',null,20,$1),
       ($4,$6,'task',null,30,$1),($5,$6,'work_session',null,40,$1)`,
      [fixture.memberId, fixture.gatedTaskId, fixture.plainTaskId, fixture.bareGateTaskId,
        fixture.workSessionId, fixture.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','T4 owner')`,
      [fixture.memberId, fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority) values
       ($1,'gated','open','medium'),($2,'plain','open','medium'),($3,'bare gate','open','medium')`,
      [fixture.gatedTaskId, fixture.plainTaskId, fixture.bareGateTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'T4 run','running','space')`,
      [fixture.workSessionId],
    );
    await client.query(
      `insert into public.projects(id,name,working_dir,trust) values($1,'T4 project','/tmp/tm8-t4-proj','trusted')`,
      [fixture.projectId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'worktree',null,50,$3)`,
      [fixture.worktreeId, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.worktrees(entity_id,project_id,path,branch,base_ref,base_commit_oid,status)
       values($1,$2,'/tmp/tm8-t4-proj/wt-a','feat/t4-lane','main',repeat('a',40),'active')`,
      [fixture.worktreeId, fixture.projectId],
    );
    await client.query(
      `select internal.record_initial_version(value,$1) from unnest($2::uuid[]) value`,
      [fixture.memberId, [fixture.gatedTaskId, fixture.plainTaskId, fixture.bareGateTaskId]],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-t4-pg',true)`,
      [identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <TResult>(name: string, args: readonly unknown[] = []): Promise<TResult> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe test RPC ${name}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(',');
        const result = await client.query(`select * from public.${name}(${placeholders})`, [...args]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        const field = result.fields[0];
        return (row && field ? row[field.name] : undefined) as TResult;
      },
    };
    return fn(q);
  });
}

describe('082 — git facts on the ledger, provenance, and the completion gate', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('git_graph_082');
    database.apply(migrationFiles());
    fixture = await seed(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  const events = (type: string): Promise<Array<{ payload: Record<string, unknown> }>> =>
    database.query(
      `select payload from public.workspace_events where space_id=$1 and event_type=$2 order by seq`,
      [fixture.spaceId, type],
    );

  const version = async (id: string): Promise<number> =>
    (await database.query<{ version: number }>(`select version from public.entities where id=$1`, [id]))[0]!.version;

  let prEntityId: string;

  it('authors git.pr_state_changed on a real state change, and nothing on a no-op refresh', async () => {
    await asApp(database, fixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('link_pull_request', [
        fixture.gatedTaskId, 'https://github.com/acme/repo/pull/42', 'github', 'acme/repo', 42,
        null, null, 'cmid-t4-linkpr',
      ]));
    prEntityId = (await database.query<{ entity_id: string }>(
      `select entity_id from public.pull_requests where space_id=$1 and number=42`, [fixture.spaceId],
    ))[0]!.entity_id;
    expect(prEntityId).toBeTruthy();

    // A refresh that learns nothing: same state, only fetched_at moves.
    await asApp(database, fixture.identityId, (q) =>
      q.rpc('apply_pull_request_facts', [prEntityId, null, 'open', null, null]));
    expect(await events('git.pr_state_changed')).toHaveLength(0);

    await asApp(database, fixture.identityId, (q) =>
      q.rpc('apply_pull_request_facts', [prEntityId, null, 'merged', 'deadbeef', null]));
    const rows = await events('git.pr_state_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      type: 'git.pr_state_changed',
      prEntityId,
      repo: 'acme/repo',
      number: 42,
      previousState: 'open',
      state: 'merged',
    });
    // Reset to open for the gate tests below.
    await asApp(database, fixture.identityId, (q) =>
      q.rpc('apply_pull_request_facts', [prEntityId, null, 'open', null, null]));
  });

  it('record_session_commit mints once, converges on retry, and stamps ONE created_in edge', async () => {
    const sha = 'b'.repeat(40);
    const first = await asApp(database, fixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('record_session_commit', [
        fixture.workSessionId, 'acme/repo', sha, 'feat: t4 provenance', 'T4 Author', new Date().toISOString(),
      ]));
    expect(first.created).toBe(true);
    const commitEntityId = first.commitEntityId as string;

    const again = await asApp(database, fixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('record_session_commit', [
        fixture.workSessionId, 'acme/repo', sha, null, null, null,
      ]));
    expect(again.created).toBe(false);
    expect(again.commitEntityId).toBe(commitEntityId);

    // Provenance is an ordinary edge read: which session produced commit X.
    const edges = await database.query<{ dst_id: string }>(
      `select dst_id from public.edges where src_id=$1 and type='created_in'`, [commitEntityId]);
    expect(edges).toEqual([{ dst_id: fixture.workSessionId }]);

    const recorded = await events('git.commit_recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      type: 'git.commit_recorded', commitEntityId, repo: 'acme/repo', sha, provider: 'github',
    });
  });

  it('authors git.worktree_status_changed on a lane transition', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      // 057's R29 single-writer guard: status moves only under the worktree
      // transition claim. This test IS the transition writer here.
      await client.query(`select set_config('tm8.worktree_transition','on',true)`);
      await client.query(`update public.worktrees set status='merged' where entity_id=$1`, [fixture.worktreeId]);
    });
    const rows = await events('git.worktree_status_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      type: 'git.worktree_status_changed',
      worktreeEntityId: fixture.worktreeId,
      projectId: fixture.projectId,
      branch: 'feat/t4-lane',
      previousStatus: 'active',
      status: 'merged',
    });
  });

  it('DEFAULT UNCHANGED: an ungated task completes with an open tracked PR', async () => {
    await asApp(database, fixture.identityId, (q) =>
      q.rpc('link_pull_request', [
        fixture.plainTaskId, 'https://github.com/acme/repo/pull/43', 'github', 'acme/repo', 43,
        null, null, 'cmid-t4-linkpr-plain',
      ]));
    const result = await asApp(database, fixture.identityId, async (q) =>
      q.rpc<Record<string, unknown>>('complete_task', [
        fixture.plainTaskId, await version(fixture.plainTaskId), [fixture.memberId], null, 'cmid-t4-plain-done',
      ]));
    expect(result).toBeTruthy();
    const status = await database.query<{ work_status: string }>(
      `select work_status from public.tasks where entity_id=$1`, [fixture.plainTaskId]);
    expect(status[0]!.work_status).toBe('done');
  });

  it('pr_merged refuses on open, refuses on CI-red, completes on merged+passing', async () => {
    await asApp(database, fixture.identityId, async (q) =>
      q.rpc('set_task_gate', [
        fixture.gatedTaskId, await version(fixture.gatedTaskId), 'pr_merged', null, 'cmid-t4-gate-on',
      ]));
    const gate = await database.query<{ completion_gate: string }>(
      `select completion_gate from public.tasks where entity_id=$1`, [fixture.gatedTaskId]);
    expect(gate[0]!.completion_gate).toBe('pr_merged');

    // Open PR: refused.
    await expect(asApp(database, fixture.identityId, async (q) =>
      q.rpc('complete_task', [
        fixture.gatedTaskId, await version(fixture.gatedTaskId), [fixture.memberId], null, null,
      ]))).rejects.toThrow(/completion gate pr_merged: a tracked pull request is unmerged or CI-red/);

    // Merged but CI-red: still refused.
    await asApp(database, fixture.identityId, (q) =>
      q.rpc('apply_pull_request_facts', [prEntityId, null, 'merged', null, 'failing']));
    await expect(asApp(database, fixture.identityId, async (q) =>
      q.rpc('complete_task', [
        fixture.gatedTaskId, await version(fixture.gatedTaskId), [fixture.memberId], null, null,
      ]))).rejects.toThrow(/unmerged or CI-red/);

    // Merged and passing: completes.
    await asApp(database, fixture.identityId, (q) =>
      q.rpc('apply_pull_request_facts', [prEntityId, null, 'merged', null, 'passing']));
    await asApp(database, fixture.identityId, async (q) =>
      q.rpc('complete_task', [
        fixture.gatedTaskId, await version(fixture.gatedTaskId), [fixture.memberId], null, 'cmid-t4-gated-done',
      ]));
    const status = await database.query<{ work_status: string }>(
      `select work_status from public.tasks where entity_id=$1`, [fixture.gatedTaskId]);
    expect(status[0]!.work_status).toBe('done');
  });

  it('pr_merged with NO tracked PR refuses rather than completing vacuously', async () => {
    await asApp(database, fixture.identityId, async (q) =>
      q.rpc('set_task_gate', [
        fixture.bareGateTaskId, await version(fixture.bareGateTaskId), 'pr_merged', null, 'cmid-t4-gate-bare',
      ]));
    await expect(asApp(database, fixture.identityId, async (q) =>
      q.rpc('complete_task', [
        fixture.bareGateTaskId, await version(fixture.bareGateTaskId), [fixture.memberId], null, null,
      ]))).rejects.toThrow(/no tracked pull request/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { queryEdges } from '../../src/facade/services/w2/edges-placements.js';
import { createW1ScratchDatabase, type W1ScratchDatabase } from './w1-pg.js';

const MIGRATIONS = [
  '001_core_graph.sql',
  '002_identity.sql',
  '003_read_model.sql',
  '004_ledgers.sql',
  '005_custom_kinds.sql',
  '006_execution_side.sql',
  '007_rpc_catalog.sql',
  '008_rls_policies.sql',
  '009_claim_accessor_grants.sql',
  '010_fix_mark_read_ambiguity.sql',
  '011_entity_content_missing_kinds.sql',
  '012_ledger_reserve_cmid.sql',
  '013_next_event_seq_warning.sql',
  '014_assert_version_locks.sql',
  '015_w1_foundations.sql',
  '018_w2_edges_placements.sql',
] as const;

interface Fixture {
  identityId: string;
  outsiderIdentityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
  taskAId: string;
  taskBId: string;
  taskCId: string;
  deletedTaskId: string;
  otherTaskId: string;
  channelId: string;
  workSessionId: string;
  profileId: string;
  fileId: string;
  messageId: string;
  pullRequestId: string;
  projectId: string;
  projectEntityId: string;
  attachedEdgeId: string;
  sharedEdgeId: string;
  selectedProfileEdgeId: string;
  materializedProjectEdgeId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Omit<Fixture,
      | 'projectEntityId'
      | 'attachedEdgeId'
      | 'sharedEdgeId'
      | 'selectedProfileEdgeId'
      | 'materializedProjectEdgeId'>>(
      `select 'g03-owner'::text as "identityId",
              'g03-outsider'::text as "outsiderIdentityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "otherSpaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "outsiderMemberId",
              internal.new_id()::text as "taskAId",
              internal.new_id()::text as "taskBId",
              internal.new_id()::text as "taskCId",
              internal.new_id()::text as "deletedTaskId",
              internal.new_id()::text as "otherTaskId",
              internal.new_id()::text as "channelId",
              internal.new_id()::text as "workSessionId",
              internal.new_id()::text as "profileId",
              internal.new_id()::text as "fileId",
              internal.new_id()::text as "messageId",
              internal.new_id()::text as "pullRequestId",
              internal.new_id()::text as "projectId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G03 owner'), ($2, 'G03 outsider')`,
      [ids.identityId, ids.outsiderIdentityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G03 space', $3), ($2, 'G03 other', $4)`,
      [ids.spaceId, ids.otherSpaceId, ids.identityId, ids.outsiderIdentityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by, deleted_at)
       values ($1, $13, 'member', null, 0, $1, null),
              ($2, $14, 'member', null, 0, $2, null),
              ($3, $13, 'task', null, 0, $1, null),
              ($4, $13, 'task', null, 1, $1, null),
              ($5, $13, 'task', null, 2, $1, null),
              ($6, $13, 'task', null, 3, $1, now()),
              ($7, $14, 'task', null, 0, $2, null),
              ($8, $13, 'channel', null, 0, $1, null),
              ($9, $13, 'work_session', null, 0, $1, null),
              ($10, $13, 'interaction_profile', null, 0, $1, null),
              ($11, $13, 'file', null, 0, $1, null),
              ($12, $13, 'message', null, 0, $1, null),
              ($15, $13, 'pull_request', null, 0, $1, null)`,
      [
        ids.memberId,
        ids.outsiderMemberId,
        ids.taskAId,
        ids.taskBId,
        ids.taskCId,
        ids.deletedTaskId,
        ids.otherTaskId,
        ids.channelId,
        ids.workSessionId,
        ids.profileId,
        ids.fileId,
        ids.messageId,
        ids.spaceId,
        ids.otherSpaceId,
        ids.pullRequestId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'G03 owner'),
              ($2, $4, $6, 'owner', 'G03 outsider')`,
      [ids.memberId, ids.outsiderMemberId, ids.spaceId, ids.otherSpaceId, ids.identityId, ids.outsiderIdentityId],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority)
       values ($1, 'Task A', 'open', 'medium'),
              ($2, 'Task B', 'open', 'medium'),
              ($3, 'Task C', 'open', 'medium'),
              ($4, 'Deleted task', 'open', 'medium'),
              ($5, 'Other task', 'open', 'medium')`,
      [ids.taskAId, ids.taskBId, ids.taskCId, ids.deletedTaskId, ids.otherTaskId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name) values ($1, $2, 'g03')`,
      [ids.channelId, ids.spaceId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1, 'G03 session', 'running', 'space')`,
      [ids.workSessionId],
    );
    await client.query(`insert into public.interaction_profiles(entity_id) values ($1)`, [ids.profileId]);
    await client.query(
      `insert into public.files(entity_id, name, mime_type, size_bytes, storage_path)
       values ($1, 'fixture.txt', 'text/plain', 7, $2)`,
      [ids.fileId, `spaces/${ids.spaceId}/fixture.txt`],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, author_id, body)
       values ($1, $2, $3, 'fixture message')`,
      [ids.messageId, ids.channelId, ids.memberId],
    );
    await client.query(
      `insert into public.pull_requests(entity_id, space_id, url, repo, number, title)
       values ($1, $2, 'https://example.test/pr/3', 'tm8/g03', 3, 'G03 PR')`,
      [ids.pullRequestId, ids.spaceId],
    );
    await client.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'G03 project', '/tmp/tm8-g03-project', 'trusted')`,
      [ids.projectId],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)`,
      [ids.spaceId, ids.projectId, ids.memberId],
    );
    const projectEntityId = (await client.query<{ id: string }>(
      `select project_entity_id::text id from public.project_links where space_id = $1 and project_id = $2`,
      [ids.spaceId, ids.projectId],
    )).rows[0]!.id;

    await client.query(`select internal.w1_set_writer('message_attachment')`);
    const attachedEdgeId = (await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'attached_to', $4) returning id::text`,
      [ids.spaceId, ids.fileId, ids.messageId, ids.memberId],
    )).rows[0]!.id;
    await client.query(`select internal.w1_set_writer('handoff_recorder')`);
    const sharedEdgeId = (await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'shared_into', $4) returning id::text`,
      [ids.spaceId, ids.taskAId, ids.workSessionId, ids.memberId],
    )).rows[0]!.id;
    await client.query(`select internal.w1_set_writer('profile_pin')`);
    const selectedProfileEdgeId = (await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'selected_profile', $4) returning id::text`,
      [ids.spaceId, ids.workSessionId, ids.profileId, ids.memberId],
    )).rows[0]!.id;
    await client.query(`select internal.w1_set_writer('materialized')`);
    const materializedProjectEdgeId = (await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'in_project', $4) returning id::text`,
      [ids.spaceId, ids.pullRequestId, projectEntityId, ids.memberId],
    )).rows[0]!.id;
    await client.query(`select internal.w1_set_writer(null)`);

    return {
      ...ids,
      projectEntityId,
      attachedEdgeId,
      sharedEdgeId,
      selectedProfileEdgeId,
      materializedProjectEdgeId,
    };
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (q: Querier, client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'req-g03-pg', true)`,
      [identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <T>(fnName: string, args: readonly unknown[] = []): Promise<T> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        return (await client.query<{ result: T }>(
          `select public.${fnName}(${placeholders}) result`,
          [...args],
        )).rows[0]!.result;
      },
    };
    return fn(q, client);
  });
}

async function createLinkedProject(
  database: W1ScratchDatabase,
  fixture: Fixture,
  suffix: string,
): Promise<{ projectId: string; projectEntityId: string }> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const projectId = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.projects(id, name, working_dir, trust) values ($1, $2, $3, 'trusted')`,
      [projectId, `G03 ${suffix}`, `/tmp/tm8-g03-${suffix}`],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)`,
      [fixture.spaceId, projectId, fixture.memberId],
    );
    const projectEntityId = (await client.query<{ id: string }>(
      `select project_entity_id::text id from public.project_links where space_id = $1 and project_id = $2`,
      [fixture.spaceId, projectId],
    )).rows[0]!.id;
    return { projectId, projectEntityId };
  });
}

describe.sequential('W2.G03 edges and placements PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g03');
    database.apply(MIGRATIONS);
    fixture = await seed(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('applies independently after 001-015, preserves RPC signatures, and publishes enforced registry schemas', async () => {
    const functions = await database.query<{ name: string; args: string; app_exec: boolean; public_exec: boolean }>(
      `select p.proname name, pg_get_function_identity_arguments(p.oid) args,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('write_edge','update_edge','delete_edge','place_entity')
        order by p.proname`,
    );
    expect(functions).toHaveLength(4);
    expect(functions.every((row) => row.app_exec && !row.public_exec)).toBe(true);
    expect(functions.find((row) => row.name === 'delete_edge')?.args).toBe(
      'p_edge_id uuid, p_actor_id uuid, p_client_mutation_id text',
    );
    const registry = await database.query<{ missing: number; hard_type: string }>(
      `select count(*) filter (where props_schema is null)::integer missing,
              max(props_schema #>> '{properties,hard,type}') filter (where type = 'depends_on') hard_type
         from public.edge_types`,
    );
    expect(registry[0]).toEqual({ missing: 0, hard_type: 'boolean' });
  });

  it('lists only RLS-readable edges with live endpoints and cursor filters bound to the fingerprint', async () => {
    await asApp(database, fixture.identityId, async (_q, client) => {
      await client.query(
        `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, 'g03-list-live')`,
        [fixture.taskAId, fixture.taskBId, fixture.memberId],
      );
      await client.query(
        `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, 'g03-list-page-two')`,
        [fixture.taskAId, fixture.taskCId, fixture.memberId],
      );
    });
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'relates_to', $4)`,
        [fixture.spaceId, fixture.taskAId, fixture.deletedTaskId, fixture.memberId],
      );
    });

    const first = await asApp(database, fixture.identityId, (q) => queryEdges(
      q,
      new URLSearchParams(`source=${fixture.taskAId}&direction=outgoing&type=relates_to&limit=1`),
      fixture.identityId,
    ));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await asApp(database, fixture.identityId, (q) => queryEdges(
      q,
      new URLSearchParams(
        `source=${fixture.taskAId}&direction=outgoing&type=relates_to&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      fixture.identityId,
    ));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((edge) => edge.target.id))).toEqual(
      new Set([fixture.taskBId, fixture.taskCId]),
    );
    await expect(asApp(database, fixture.identityId, (q) => queryEdges(
      q,
      new URLSearchParams(
        `source=${fixture.taskAId}&direction=outgoing&type=depends_on&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      fixture.identityId,
    ))).rejects.toMatchObject({ code: 'invalid_cursor' });

    const incoming = await asApp(database, fixture.identityId, (q) => queryEdges(
      q,
      new URLSearchParams(
        `source=${fixture.taskBId}&destination=${fixture.taskAId}&direction=incoming&type=relates_to`,
      ),
      fixture.identityId,
    ));
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0]).toMatchObject({
      source: { id: fixture.taskAId },
      target: { id: fixture.taskBId },
    });

    const outsider = await asApp(database, fixture.outsiderIdentityId, (q) => queryEdges(
      q,
      new URLSearchParams(`source=${fixture.taskAId}`),
      fixture.outsiderIdentityId,
    ));
    expect(outsider.items).toEqual([]);
  });

  it('enforces endpoint liveness, same-Space kinds, property schemas, server-owned origin, and replay', async () => {
    const write = (props: Record<string, unknown>, cmid: string) => asApp(
      database,
      fixture.identityId,
      async (_q, client) => (await client.query<{ result: Record<string, unknown> }>(
        `select public.write_edge($1, $2, 'depends_on', $3::jsonb, $4, $5) result`,
        [fixture.taskAId, fixture.taskCId, JSON.stringify(props), fixture.memberId, cmid],
      )).rows[0]!.result,
    );
    await expect(write({ hard: 'yes' }, 'g03-props-bad')).rejects.toMatchObject({ code: '22023' });
    await expect(write({ origin: 'client' }, 'g03-origin-create')).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, 'g03-deleted-endpoint')`,
      [fixture.taskAId, fixture.deletedTaskId, fixture.memberId],
    ))).rejects.toMatchObject({ code: 'P0002' });
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, 'g03-cross-space')`,
      [fixture.taskAId, fixture.otherTaskId, fixture.memberId],
    ))).rejects.toMatchObject({ code: '23514' });

    const first = await write({ hard: true }, 'g03-props-good');
    const replay = await write({ hard: true }, 'g03-props-good');
    expect(replay).toEqual(first);
    const edgeId = (first.edge as { id: string }).id;
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.update_edge($1, '{"origin":"client"}'::jsonb, $2, 'g03-origin-patch')`,
      [edgeId, fixture.memberId],
    ))).rejects.toMatchObject({ code: '42501' });
    const counts = await database.query<{ edges: number; ledger: number }>(
      `select count(*) filter (where id = $1)::integer edges,
              (select count(*)::integer from public.command_ledger where client_mutation_id = $2) ledger
         from public.edges`,
      [edgeId, 'g03-props-good'],
    );
    expect(counts[0]).toEqual({ edges: 1, ledger: 1 });
  });

  it('keeps ordinary edges mutable while refusing message/materializer/recorder-owned lifecycle writes', async () => {
    const ordinary = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { edge: { id: string } } }>(
        `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, $3, 'g03-user-project') result`,
        [fixture.taskBId, fixture.projectEntityId, fixture.memberId],
      )
    ).rows[0]!.result);
    await asApp(database, fixture.identityId, async (_q, client) => {
      await client.query(
        `select public.update_edge($1, '{"note":"mutable"}'::jsonb, $2, 'g03-user-project-patch')`,
        [ordinary.edge.id, fixture.memberId],
      );
      await client.query(
        `select public.delete_edge($1, $2, 'g03-user-project-delete')`,
        [ordinary.edge.id, fixture.memberId],
      );
    });
    const sessionAssociation = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { edge: { id: string; props: Record<string, unknown> } } }>(
        `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, $3, 'g03-session-project') result`,
        [fixture.workSessionId, fixture.projectEntityId, fixture.memberId],
      )
    ).rows[0]!.result);
    expect(sessionAssociation.edge.props).toMatchObject({ origin: 'user' });
    await asApp(database, fixture.identityId, async (_q, client) => {
      await client.query(
        `select public.update_edge($1, '{"note":"still mutable"}'::jsonb, $2, 'g03-session-project-patch')`,
        [sessionAssociation.edge.id, fixture.memberId],
      );
      await client.query(
        `select public.delete_edge($1, $2, 'g03-session-project-delete')`,
        [sessionAssociation.edge.id, fixture.memberId],
      );
    });

    for (const edgeId of [
      fixture.attachedEdgeId,
      fixture.sharedEdgeId,
      fixture.selectedProfileEdgeId,
      fixture.materializedProjectEdgeId,
    ]) {
      await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
        `select public.update_edge($1, '{}'::jsonb, $2, null)`,
        [edgeId, fixture.memberId],
      ))).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
        `select public.delete_edge($1, $2, null)`,
        [edgeId, fixture.memberId],
      ))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('resolves every placement intent atomically with normalized direction, hard dependency, messages, tokens, and replay', async () => {
    const place = (
      sourceId: string,
      targetId: string,
      intent: string,
      embedMessage: string | null,
      cmid: string,
    ) => asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: Record<string, unknown> }>(
        `select public.place_entity($1, $2, $3, $4, null, $5, $6) result`,
        [sourceId, targetId, intent, embedMessage, fixture.memberId, cmid],
      )
    ).rows[0]!.result);

    const assigned = await place(fixture.memberId, fixture.taskAId, 'assign', null, 'g03-place-assign');
    expect(assigned.edge).toMatchObject({ src_id: fixture.taskAId, dst_id: fixture.memberId, type: 'assigned_to' });
    const depended = await place(fixture.taskBId, fixture.taskCId, 'depend', null, 'g03-place-depend');
    expect(depended.edge).toMatchObject({
      src_id: fixture.taskCId,
      dst_id: fixture.taskBId,
      type: 'depends_on',
      props: { hard: true },
    });
    const moved = await place(fixture.taskBId, fixture.taskAId, 'subtask', null, 'g03-place-subtask');
    expect(moved.entity).toMatchObject({ id: fixture.taskBId, parent_id: fixture.taskAId });

    const attached = await place(
      fixture.taskCId,
      fixture.channelId,
      'attach',
      'Attached card',
      'g03-place-attach',
    );
    expect(attached.edge).toMatchObject({ src_id: fixture.taskCId, dst_id: fixture.channelId, type: 'attached_to' });
    const attachMessages = await database.query<{ body: string }>(
      `select body from public.messages where anchor_id = $1 and body like 'Attached card%'`,
      [fixture.channelId],
    );
    expect(attachMessages[0]!.body).toContain(`{{embed:${fixture.taskCId}}}`);

    const embedded = await place(fixture.taskAId, fixture.channelId, 'embed', 'Look', 'g03-place-embed');
    const replay = await place(fixture.taskAId, fixture.channelId, 'embed', 'Look', 'g03-place-embed');
    expect(replay).toEqual(embedded);
    const messageId = (embedded.entity as { id: string }).id;
    const embedState = await database.query<{ body: string; operation: string; arguments: Record<string, unknown>; messages: number }>(
      `select m.body, u.operation, u.arguments,
              (select count(*)::integer from public.messages where anchor_id = $1 and body like 'Look%') messages
         from public.messages m
         join public.undo_tokens u on u.token = $2
        where m.entity_id = $3`,
      [fixture.channelId, (embedded.undo as { token: string }).token, messageId],
    );
    expect(embedState[0]).toMatchObject({
      body: `Look {{embed:${fixture.taskAId}}}`,
      operation: 'messages.delete',
      arguments: { messageId },
      messages: 1,
    });
  });

  it('rolls back every placement effect, ledger row, and undo token when a compound attach fails', async () => {
    const before = (await database.query<{ edges: number; messages: number; tokens: number }>(
      `select (select count(*)::integer from public.edges) edges,
              (select count(*)::integer from public.messages) messages,
              (select count(*)::integer from public.undo_tokens) tokens`,
    ))[0]!;
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.place_entity($1, $2, 'attach', $3, null, $4, 'g03-place-rollback')`,
      [fixture.taskAId, fixture.channelId, 'x'.repeat(10_001), fixture.memberId],
    ))).rejects.toMatchObject({ code: '23514' });
    const after = (await database.query<{ edges: number; messages: number; tokens: number; ledger: number }>(
      `select (select count(*)::integer from public.edges) edges,
              (select count(*)::integer from public.messages) messages,
              (select count(*)::integer from public.undo_tokens) tokens,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'g03-place-rollback') ledger`,
    ))[0]!;
    expect(after).toEqual({ ...before, ledger: 0 });
  });

  it('serializes in_project creation on ProjectResource, caps live sessions at 16, and revalidates unlink races', async () => {
    const projects = [] as Array<{ projectId: string; projectEntityId: string }>;
    for (let index = 0; index < 17; index += 1) {
      projects.push(await createLinkedProject(database, fixture, `cap-${index}`));
    }
    for (const [index, project] of projects.slice(0, 16).entries()) {
      await asApp(database, fixture.identityId, async (_q, client) => client.query(
        `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, $3, $4)`,
        [fixture.workSessionId, project.projectEntityId, fixture.memberId, `g03-cap-${index}`],
      ));
    }
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, $3, 'g03-cap-17')`,
      [fixture.workSessionId, projects[16]!.projectEntityId, fixture.memberId],
    ))).rejects.toMatchObject({ code: '53400', detail: 'project_association_cap' });

    const race = await createLinkedProject(database, fixture, 'unlink-race');
    const locker = await database.pool.connect();
    const creator = await database.pool.connect();
    try {
      await locker.query('begin');
      await locker.query('set local role tm8_graph_owner');
      await locker.query(`select 1 from public.projects where id = $1 for update`, [race.projectId]);

      await creator.query('begin');
      await creator.query('set local role tm8_app');
      await creator.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true)`,
        [fixture.identityId],
      );
      const pendingCreate = creator.query(
        `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, $3, 'g03-unlink-race')`,
        [fixture.workSessionId, race.projectEntityId, fixture.memberId],
      );
      await locker.query(
        `delete from public.space_projects where space_id = $1 and project_id = $2`,
        [fixture.spaceId, race.projectId],
      );
      await locker.query('commit');
      await expect(pendingCreate).rejects.toMatchObject({ code: '23514', detail: 'project_not_linked' });
      await creator.query('rollback');
    } finally {
      if (!locker.release) throw new Error('missing locker release');
      await locker.query('rollback').catch(() => undefined);
      await creator.query('rollback').catch(() => undefined);
      locker.release();
      creator.release();
    }
    const state = await database.query<{ edges: number; ledger: number }>(
      `select count(*) filter (where src_id = $1 and dst_id = $2 and type = 'in_project')::integer edges,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'g03-unlink-race') ledger
         from public.edges`,
      [fixture.workSessionId, race.projectEntityId],
    );
    expect(state[0]).toEqual({ edges: 0, ledger: 0 });
  }, 120_000);
});

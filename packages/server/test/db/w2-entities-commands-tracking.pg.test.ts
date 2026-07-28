import { spawnSync } from 'node:child_process';

import { EntityDetailSchema, getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { Querier } from '../../src/db/types.js';
import { buildUniversalDetail, queryConnections } from '../../src/facade/services/w2/entities-commands-tracking.js';
import { W2EntitiesCommandsTrackingService } from '../../src/facade/services/w2/entities-commands-tracking.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

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
  '017_w2_entities_commands_tracking.sql',
] as const;

interface Fixture {
  identityId: string;
  outsiderIdentityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
  teamMemberId: string;
  taskId: string;
  childTaskId: string;
  deletedTaskId: string;
  otherTaskId: string;
  channelId: string;
  messageId: string;
  workSessionId: string;
  profileId: string;
  projectId: string;
  projectEntityId: string;
  unlinkedProjectId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Omit<Fixture, 'projectEntityId'>>(
      `select 'g02-owner'::text "identityId", 'g02-outsider'::text "outsiderIdentityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "outsiderMemberId",
              internal.new_id()::text "teamMemberId", internal.new_id()::text "taskId",
              internal.new_id()::text "childTaskId", internal.new_id()::text "deletedTaskId",
              internal.new_id()::text "otherTaskId", internal.new_id()::text "channelId",
              internal.new_id()::text "messageId", internal.new_id()::text "workSessionId",
              internal.new_id()::text "profileId", internal.new_id()::text "projectId",
              internal.new_id()::text "unlinkedProjectId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'G02 owner'),($2,'G02 outsider')`,
      [fixture.identityId, fixture.outsiderIdentityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity)
       values($1,'G02 Space',$3),($2,'G02 Other',$4)`,
      [fixture.spaceId, fixture.otherSpaceId, fixture.identityId, fixture.outsiderIdentityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by,deleted_at) values
       ($1,$12,'member',null,0,$1,null),($2,$13,'member',null,0,$2,null),
       ($3,$12,'team_member',null,1,$1,null),($4,$12,'task',null,10,$1,null),
       ($5,$12,'task',$4,20,$1,null),($6,$12,'task',null,30,$1,now()),
       ($7,$13,'task',null,10,$2,null),($8,$12,'channel',null,40,$1,null),
       ($9,$12,'message',null,50,$1,null),($10,$12,'work_session',null,60,$1,null),
       ($11,$12,'interaction_profile',null,70,$1,null)`,
      [fixture.memberId, fixture.outsiderMemberId, fixture.teamMemberId, fixture.taskId,
        fixture.childTaskId, fixture.deletedTaskId, fixture.otherTaskId, fixture.channelId,
        fixture.messageId, fixture.workSessionId, fixture.profileId, fixture.spaceId, fixture.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$3,$5,'owner','G02 owner'),($2,$4,$6,'owner','G02 outsider')`,
      [fixture.memberId, fixture.outsiderMemberId, fixture.spaceId, fixture.otherSpaceId,
        fixture.identityId, fixture.outsiderIdentityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'G02 agent','worker','test agent')`,
      [fixture.teamMemberId, fixture.memberId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority,points_estimate) values
       ($1,'G02 task','open','medium',3),($2,'G02 child','open','medium',null),
       ($3,'G02 deleted','open','medium',null),($4,'Other task','open','medium',null)`,
      [fixture.taskId, fixture.childTaskId, fixture.deletedTaskId, fixture.otherTaskId],
    );
    await client.query(`insert into public.channels(entity_id,space_id,name) values($1,$2,'g02')`,
      [fixture.channelId, fixture.spaceId]);
    await client.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,'G02 message')`,
      [fixture.messageId, fixture.channelId, fixture.memberId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'G02 run','running','space')`,
      [fixture.workSessionId],
    );
    await client.query(`insert into public.interaction_profiles(entity_id) values($1)`, [fixture.profileId]);
    await client.query(
      `insert into public.projects(id,name,working_dir,trust) values
       ($1,'G02 linked','/tmp/tm8-g02-linked','trusted'),
       ($2,'G02 unlinked','/tmp/tm8-g02-unlinked','trusted')`,
      [fixture.projectId, fixture.unlinkedProjectId],
    );
    await client.query(
      `insert into public.space_projects(space_id,project_id,linked_by) values($1,$2,$3)`,
      [fixture.spaceId, fixture.projectId, fixture.memberId],
    );
    const projectEntityId = (await client.query<{ id: string }>(
      `select project_entity_id::text id from public.project_links where space_id=$1 and project_id=$2`,
      [fixture.spaceId, fixture.projectId],
    )).rows[0]!.id;
    await client.query(
      `select internal.record_initial_version(value,$1) from unnest($2::uuid[]) value`,
      [fixture.memberId, [fixture.taskId, fixture.childTaskId, fixture.otherTaskId]],
    );
    return { ...fixture, projectEntityId };
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
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-g02-pg',true)`,
      [identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <TResult>(name: string, args: readonly unknown[] = []): Promise<TResult> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe test RPC ${name}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(',');
        return (await client.query<{ result: TResult }>(
          `select public.${name}(${placeholders}) result`, [...args],
        )).rows[0]!.result;
      },
    };
    return fn(q, client);
  });
}

function request(
  opName: OperationName,
  options: { params?: Record<string, string>; query?: string; body?: unknown } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName, params: options.params ?? {}, query: new URLSearchParams(options.query), body: options.body,
    requestId: `req-${opName}`, identity: { kind: 'auto-owner', identityId: 'g02-owner' }, headers: {},
    method: op.method, path: op.path,
  };
}

describe.sequential('W2.G02 entities, commands, and tracking PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;
  let facadeDb: PgDb;
  let service: W2EntitiesCommandsTrackingService;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g02');
    database.apply(MIGRATIONS);
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    service = new W2EntitiesCommandsTrackingService({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000299',
        username: 'g02-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  }, 30_000);

  it('applies exactly after 001-015 and exposes only enumerable app RPCs', async () => {
    const functions = await database.query<{ name: string; app_exec: boolean; public_exec: boolean }>(
      `select p.proname name,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in (
          'create_file_entity','create_spell_entity','create_skill_entity',
          'create_pull_request_entity','create_commit_entity','create_custom_entity',
          'update_file_entity','update_spell_entity','update_skill_entity',
          'update_pull_request_entity','update_commit_entity','update_custom_entity',
          'link_pull_request','link_commit','queue_tracking_refresh'
        ) order by p.proname`,
    );
    expect(functions).toHaveLength(15);
    expect(functions.every((row) => row.app_exec && !row.public_exec)).toBe(true);
  });

  it('denies tm8_app direct DML and RLS-hides nonmember and tombstoned entities', async () => {
    await expect(asApp(database, fixture.identityId, async (_q, client) => {
      await client.query(`update public.tasks set title='forged' where entity_id=$1`, [fixture.taskId]);
    })).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.outsiderIdentityId, (q) =>
      buildUniversalDetail(q, fixture.taskId, fixture.outsiderIdentityId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, fixture.deletedTaskId, fixture.identityId))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('creates and patches typed and custom entities with exact concurrent ledger replay and versions', async () => {
    const args = [fixture.spaceId, 'Concurrent spell', null, 'first', {}, null, null, 'g02-create-spell'] as const;
    const [first, replay] = await Promise.all([
      asApp(database, fixture.identityId, (q) => q.rpc<Record<string, any>>('create_spell_entity', args)),
      asApp(database, fixture.identityId, (q) => q.rpc<Record<string, any>>('create_spell_entity', args)),
    ]);
    expect(replay).toEqual(first);
    const spellId = first['entity'].id as string;
    expect((await database.query<{ count: number }>(
      `select count(*)::integer count from public.spells where name='Concurrent spell'`,
    ))[0]?.count).toBe(1);

    await asApp(database, fixture.identityId, (q) => q.rpc('update_spell_entity',
      [spellId, 1, null, 'Updated spell', 'second', { allow: true }, 'g02-patch-spell']));
    const detail = await asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, spellId, fixture.identityId));
    expect(EntityDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.title).toBe('Updated spell');
    expect(detail.version).toBe(2);
    expect(detail.content).toMatchObject({ kind: 'spell', description: 'second', rule: { allow: true } });
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('update_spell_entity',
      [spellId, 1, null, 'Stale write', null, null, 'g02-patch-stale']))).rejects.toMatchObject({ code: '40001' });

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entity_kinds(kind,origin,space_id,field_schema,capabilities)
         values('c:case','custom',$1,'[{"name":"severity","type":"number","required":true}]','{}')`,
        [fixture.spaceId],
      );
    });
    const custom = await asApp(database, fixture.identityId, (q) => q.rpc<Record<string, any>>(
      'create_custom_entity', [fixture.spaceId, 'c:case', 'Incident', null, { severity: 2 }, null, null, 'g02-custom'],
    ));
    const customDetail = await asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, custom['entity'].id as string, fixture.identityId));
    expect(EntityDetailSchema.safeParse(customDetail).success).toBe(true);
    expect(customDetail).toMatchObject({ title: 'Incident', state: { kind: 'c:case', fields: { severity: 2 } } });
  });

  it('decorates optimistic conflicts with the current universal detail', async () => {
    const created = await service.createEntity(request('entities.create', { body: {
      clientMutationId: 'g02-conflict-create', spaceId: fixture.spaceId, kind: 'doc',
      title: 'Conflict doc', content: { body: 'v1', format: 'markdown' },
    } }));
    const id = created.entity!.id;
    await service.patchEntity(request('entities.patch', {
      params: { id },
      body: { clientMutationId: 'g02-conflict-update', expectedVersion: 1, title: 'Current doc' },
    }));
    await expect(service.patchEntity(request('entities.patch', {
      params: { id },
      body: { clientMutationId: 'g02-conflict-stale', expectedVersion: 1, title: 'Stale doc' },
    }))).rejects.toMatchObject({
      code: 'version_conflict',
      current: { id, version: 2, title: 'Current doc' },
    });
  });

  it('refuses generic lifecycle writes for member, message, work-session, project, and interaction-profile ownership', async () => {
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('delete_entity',
      [fixture.memberId, null, 'g02-member-delete']))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('move_entity',
      [fixture.profileId, null, 0, 1, null, 'g02-profile-move']))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('delete_entity',
      [fixture.messageId, null, 'g02-message-delete']))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('delete_entity',
      [fixture.workSessionId, null, 'g02-session-delete']))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('restore_entity',
      [fixture.projectEntityId, null, 'g02-project-restore']))).rejects.toMatchObject({ code: '42501' });
  });

  it('moves, deletes, and restores a live subtree and pages children, versions, and activity by fingerprint', async () => {
    const createDoc = async (title: string, cmid: string): Promise<string> => {
      const result = await asApp(database, fixture.identityId, (q) => q.rpc<Record<string, any>>('create_document',
        [fixture.spaceId, title, null, '', 'markdown', null, null, null, 'attached_to', cmid]));
      return result['entity'].id as string;
    };
    const parentId = await createDoc('Lifecycle parent', 'g02-life-parent');
    const childId = await createDoc('Lifecycle child', 'g02-life-child');
    await asApp(database, fixture.identityId, (q) => q.rpc('move_entity',
      [childId, parentId, 10, 1, null, 'g02-life-move']));

    const children = await service.listChildren(request('entities.children', {
      params: { id: parentId }, query: 'limit=1',
    }));
    expect(children.items.map((item) => item.id)).toEqual([childId]);
    const hierarchy = await service.getHierarchy(request('entities.hierarchy', { params: { id: childId } }));
    expect(hierarchy.parent?.id).toBe(parentId);
    expect(hierarchy.path.map((item) => item.id)).toEqual([parentId]);

    const versions = await service.listVersions(request('entities.versions', {
      params: { id: childId }, query: 'limit=1',
    }));
    expect(versions.items).toHaveLength(1);
    expect(versions.nextCursor).toBeTruthy();
    const versionsNext = await service.listVersions(request('entities.versions', {
      params: { id: childId }, query: `limit=1&cursor=${encodeURIComponent(versions.nextCursor!)}`,
    }));
    expect(versionsNext.items).toHaveLength(1);
    await expect(service.listVersions(request('entities.versions', {
      params: { id: parentId }, query: `limit=1&cursor=${encodeURIComponent(versions.nextCursor!)}`,
    }))).rejects.toMatchObject({ code: 'invalid_cursor' });

    const activity = await service.listActivity(request('entities.activity', {
      params: { id: childId }, query: 'limit=1',
    }));
    expect(activity.items).toHaveLength(1);
    expect(activity.nextCursor).toBeTruthy();
    const activityNext = await service.listActivity(request('entities.activity', {
      params: { id: childId }, query: `limit=1&cursor=${encodeURIComponent(activity.nextCursor!)}`,
    }));
    expect(activityNext.items).toHaveLength(1);
    await expect(service.listActivity(request('entities.activity', {
      params: { id: parentId }, query: `limit=1&cursor=${encodeURIComponent(activity.nextCursor!)}`,
    }))).rejects.toMatchObject({ code: 'invalid_cursor' });

    const deleted = await service.deleteEntity(request('entities.delete', {
      params: { id: parentId }, body: { clientMutationId: 'g02-life-delete' },
    }));
    expect(new Set(deleted.patches.map((patch) => patch.id))).toEqual(new Set([parentId, childId]));
    await expect(service.getEntity(request('entities.get', { params: { id: childId } }))).rejects.toMatchObject({
      code: 'not_found',
    });
    await service.restoreEntity(request('entities.restore', {
      params: { id: parentId }, body: { clientMutationId: 'g02-life-restore' },
    }));
    expect((await service.getEntity(request('entities.get', { params: { id: childId } }))).deletedAt).toBeNull();
  });

  it('enforces human reactions and point-ledger idempotency', async () => {
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('react',
      [fixture.taskId, 'like', true, fixture.teamMemberId, 'g02-agent-react']))).rejects.toMatchObject({ code: '42501' });
    await asApp(database, fixture.identityId, (q) => q.rpc('react',
      [fixture.taskId, 'like', true, null, 'g02-human-react']));
    const reaction = await database.query<{ count: number }>(
      `select count(*)::integer count from public.edges where src_id=$1 and dst_id=$2 and type='likes'`,
      [fixture.memberId, fixture.taskId],
    );
    expect(reaction[0]?.count).toBe(1);

    const grantArgs = [fixture.teamMemberId, 5, 'grant', null, null, 'g02-point-once'] as const;
    const [one, two] = await Promise.all([
      asApp(database, fixture.identityId, (q) => q.rpc('grant_points', grantArgs)),
      asApp(database, fixture.identityId, (q) => q.rpc('grant_points', grantArgs)),
    ]);
    expect(two).toEqual(one);
    const points = await database.query<{ count: number; total: number }>(
      `select count(*)::integer count,coalesce(sum(amount),0)::integer total
         from public.point_events where client_event_id='g02-point-once'`,
    );
    expect(points[0]).toEqual({ count: 1, total: 5 });
  });

  it('keeps task work/complete commands kind-bound, versioned, and single-award', async () => {
    await expect(asApp(database, fixture.identityId, (q) => q.rpc('set_work_state',
      [fixture.taskId, 'done', null, null, null, 'g02-work-done']))).rejects.toMatchObject({ code: '23514' });
    await asApp(database, fixture.identityId, (q) => q.rpc('set_work_state',
      [fixture.taskId, 'working', null, null, 'active', 'g02-work']));
    const version = (await database.query<{ version: number }>(
      `select version from public.entities where id=$1`, [fixture.taskId],
    ))[0]!.version;
    const args = [fixture.taskId, version, [fixture.memberId], null, 'g02-complete'] as const;
    const first = await asApp(database, fixture.identityId, (q) => q.rpc('complete_task', args));
    const second = await asApp(database, fixture.identityId, (q) => q.rpc('complete_task', args));
    expect(second).toEqual(first);
    expect((await database.query<{ status: string }>(
      `select work_status status from public.tasks where entity_id=$1`, [fixture.taskId],
    ))[0]?.status).toBe('done');
    expect((await database.query<{ count: number }>(
      `select count(*)::integer count from public.point_events where client_event_id=$1`,
      [`g02-complete:award:${fixture.memberId}`],
    ))[0]?.count).toBe(1);
  });

  it('stores deterministic pinned pull projection and derives staleness after a later edit', async () => {
    const first = await asApp(database, fixture.identityId, (q) => q.rpc<Record<string, any>>('set_pull_state',
      [fixture.childTaskId, 1, 'local-child', null, 'g02-pull']));
    const replay = await asApp(database, fixture.identityId, (q) => q.rpc('set_pull_state',
      [fixture.childTaskId, 1, 'different-local-id', null, 'g02-pull']));
    expect(replay).toEqual(first);
    const before = await database.query<{ props: Record<string, any> }>(
      `select props from public.edges where src_id=$1 and dst_id=$2 and type='pulled'`,
      [fixture.memberId, fixture.childTaskId],
    );
    expect(before[0]?.props).toMatchObject({ localId: 'local-child', pinnedVersion: 1 });
    expect(before[0]?.props['projectionHash']).toMatch(/^[a-f0-9]{32}$/);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.tasks set description='new source state' where entity_id=$1`, [fixture.childTaskId]);
    });
    const detail = await asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, fixture.childTaskId, fixture.identityId));
    expect(detail.badges.pulls?.[0]).toMatchObject({ pinnedVersion: 1, contentStale: true, localId: 'local-child' });
  });

  it('upserts provider mirrors, promotes project provenance, rejects inactive projects, and queues refresh work', async () => {
    const prArgs = [fixture.taskId, 'https://github.com/acme/tm8/pull/41', 'github', 'acme/tm8', 41,
      fixture.projectId, null, 'g02-link-pr'] as const;
    const linkedPr = await asApp(database, fixture.identityId, (q) =>
      q.rpc<Record<string, any>>('link_pull_request', prArgs));
    expect(await asApp(database, fixture.identityId, (q) => q.rpc('link_pull_request', prArgs))).toEqual(linkedPr);
    const prId = (await database.query<{ id: string }>(
      `select entity_id::text id from public.pull_requests where space_id=$1 and repo='acme/tm8' and number=41`,
      [fixture.spaceId],
    ))[0]!.id;
    const pureAssociation = await database.query<{ props: Record<string, unknown> }>(
      `select props from public.edges where src_id=$1 and dst_id=$2 and type='in_project'`,
      [prId, fixture.projectEntityId],
    );
    expect(pureAssociation[0]?.props).toEqual({ origin: 'materialized' });

    const commitBase = [fixture.taskId, 'https://github.com/acme/tm8/commit/abcdef1234567',
      'github', 'acme/tm8', 'abcdef1234567', null, null, 'g02-link-commit-base'] as const;
    await asApp(database, fixture.identityId, (q) => q.rpc('link_commit', commitBase));
    const commitId = (await database.query<{ id: string }>(
      `select entity_id::text id from public.commits where space_id=$1 and repo='acme/tm8' and sha='abcdef1234567'`,
      [fixture.spaceId],
    ))[0]!.id;
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
         values($1,$2,$3,'in_project','{}',$4)`,
        [fixture.spaceId, commitId, fixture.projectEntityId, fixture.memberId],
      );
    });
    await asApp(database, fixture.identityId, (q) => q.rpc('link_commit',
      [fixture.taskId, 'https://github.com/acme/tm8/commit/abcdef1234567', 'github', 'acme/tm8',
        'abcdef1234567', fixture.projectId, null, 'g02-link-commit-promote']));
    const promoted = await database.query<{ props: Record<string, unknown> }>(
      `select props from public.edges where src_id=$1 and dst_id=$2 and type='in_project'`,
      [commitId, fixture.projectEntityId],
    );
    expect(promoted[0]?.props).toMatchObject({ origin: 'materialized', promotedFromOrigin: 'user' });

    await expect(asApp(database, fixture.identityId, (q) => q.rpc('link_pull_request',
      [fixture.taskId, 'https://github.com/acme/tm8/pull/42', 'github', 'acme/tm8', 42,
        fixture.unlinkedProjectId, null, 'g02-link-unlinked']))).rejects.toMatchObject({
      code: '23514', detail: 'project_not_linked',
    });

    const refreshArgs = [[prId, commitId], null, 'g02-refresh'] as const;
    const refresh = await asApp(database, fixture.identityId, (q) =>
      q.rpc<Record<string, any>>('queue_tracking_refresh', refreshArgs));
    expect(refresh).toMatchObject({ accepted: true, status: 'queued' });
    expect(refresh['requestIds']).toHaveLength(1);
    expect(await asApp(database, fixture.identityId, (q) => q.rpc('queue_tracking_refresh', refreshArgs))).toEqual(refresh);
    const queued = await database.query<{ count: number; entity_ids: string[] }>(
      `select (select count(*)::integer from public.tracking_refresh_requests where space_id=$1) count,
              (select array_agg(value::text order by value::text)
                 from public.tracking_refresh_requests r cross join lateral unnest(r.entity_ids) value
                where r.space_id=$1) entity_ids`, [fixture.spaceId],
    );
    expect(queued[0]?.count).toBe(1);
    expect(new Set(queued[0]?.entity_ids)).toEqual(new Set([prId, commitId]));
    await expect(asApp(database, fixture.outsiderIdentityId, (q) => q.rpc('queue_tracking_refresh',
      [[prId], null, 'g02-refresh-outside']))).rejects.toMatchObject({ code: 'P0002' });
  });

  it('projects live connections with fingerprinted keysets and omits tombstoned endpoints', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,created_by)
         values($1,$2,$3,'relates_to',$4)`,
        [fixture.spaceId, fixture.taskId, fixture.deletedTaskId, fixture.memberId],
      );
    });
    const base = {
      entityId: fixture.taskId,
      types: ['tracks'], direction: 'outgoing' as const, peerIds: [], peerKinds: [], createdByIds: [],
      createdAfter: null, createdBefore: null, sort: 'createdAt' as const, order: 'asc' as const,
      cursor: null, limit: 1,
    };
    const first = await asApp(database, fixture.identityId, (q) => queryConnections(q, base, fixture.identityId));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await asApp(database, fixture.identityId, (q) =>
      queryConnections(q, { ...base, cursor: first.nextCursor }, fixture.identityId));
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((edge) => edge.target.kind))).toEqual(
      new Set(['pull_request', 'commit']),
    );
    await expect(asApp(database, fixture.identityId, (q) => queryConnections(q,
      { ...base, types: ['relates_to'], cursor: first.nextCursor }, fixture.identityId))).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    const dead = await asApp(database, fixture.identityId, (q) => queryConnections(q,
      { ...base, types: ['relates_to'], cursor: null, limit: 50 }, fixture.identityId));
    expect(dead.items).toEqual([]);
  });

  it('returns finite hierarchy under corrupted cycles and exposes stable version/activity truth', async () => {
    const before = await asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, fixture.taskId, fixture.identityId));
    expect(before.hierarchy.children.items.map((child) => child.id)).toContain(fixture.childTaskId);
    const truth = await database.query<{ versions: number; activities: number }>(
      `select (select count(*)::integer from public.entity_versions where entity_id=$1) versions,
              (select count(*)::integer from public.activity where entity_id=$2
                and verb in ('pr.linked','linked','completed','work.changed')) activities`,
      [fixture.childTaskId, fixture.taskId],
    );
    expect(truth[0]!.versions).toBeGreaterThanOrEqual(1);
    expect(truth[0]!.activities).toBeGreaterThanOrEqual(4);

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('alter table public.entities disable trigger entities_validate_parent');
      await client.query(`update public.entities set parent_id=$1 where id=$2`, [fixture.childTaskId, fixture.taskId]);
      await client.query('set constraints all immediate');
      await client.query('alter table public.entities enable trigger entities_validate_parent');
    });
    const cyclic = await asApp(database, fixture.identityId, (q) =>
      buildUniversalDetail(q, fixture.taskId, fixture.identityId));
    expect(cyclic.hierarchy.path).toHaveLength(1);
    expect(cyclic.hierarchy.path[0]?.id).toBe(fixture.childTaskId);
  });
});

// ---------------------------------------------------------------------------
// W2.G02-FIX — tracking.refresh across MORE THAN ONE Space.
//
// The defect this block pins: public.queue_tracking_refresh loops over the
// caller's Space memberships and, inside the loop, calls
//
//     actor := internal.resolve_actor(p_actor_id, row_value.space_id);
//     perform internal.bind_actor(actor);
//
// internal.bind_actor writes tm8.actor_id with set_config(..., true) — LOCAL to
// the transaction, therefore alive for every later iteration — while
// internal.resolve_actor is
//
//     coalesce(requested, internal.actor_id(), internal.current_member_id(space))
//
// So iteration 1 binds Space A's member id, and iteration 2's coalesce
// short-circuits on that stale value instead of reaching
// current_member_id(Space B). can_act_as(memberA, spaceB) is false and the
// function raises 42501, which the facade maps to 403. Any caller who belongs
// to two or more Spaces cannot refresh anything.
//
// Two deliberate choices about this block:
//
//   * It builds its chain from migrationFiles() — the WHOLE applied chain, not
//     a hand-listed slice like MIGRATIONS above. The fix lands as a
//     forward-only `create or replace` in a NEW migration, so a fixture pinned
//     to a 17-file slice could not observe it no matter what. That makes this
//     a coverage proof under the full chain, not a per-group isolation proof.
//     It also means the migration NUMBER is never named here.
//
//   * Half of it is a POSITIVE half that must not regress. Resolving the actor
//     per-Space is only correct if an explicitly requested actor still wins and
//     is still authorized per Space. The two anti-bypass cases below —
//     a stranger's member id, and the caller's own Space-A member id used
//     across a two-Space fan-out — pass TODAY and must still refuse after the
//     fix. A fix that authorized everyone would satisfy every red case here
//     and would be caught only by those two.
// ---------------------------------------------------------------------------

interface FanFixture {
  identityId: string;
  strangerIdentityId: string;
  spaceAId: string;
  spaceBId: string;
  spaceCId: string;
  memberAId: string;
  memberBId: string;
  strangerMemberId: string;
  teamMemberId: string;
  pullRequestAId: string;
  commitBId: string;
}

async function seedFanOut(database: W1ScratchDatabase): Promise<FanFixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fanFixture = (await client.query<FanFixture>(
      `select 'g02fan-owner'::text "identityId", 'g02fan-stranger'::text "strangerIdentityId",
              internal.new_id()::text "spaceAId", internal.new_id()::text "spaceBId",
              internal.new_id()::text "spaceCId", internal.new_id()::text "memberAId",
              internal.new_id()::text "memberBId", internal.new_id()::text "strangerMemberId",
              internal.new_id()::text "teamMemberId", internal.new_id()::text "pullRequestAId",
              internal.new_id()::text "commitBId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'G02 fan owner'),($2,'G02 fan stranger')`,
      [fanFixture.identityId, fanFixture.strangerIdentityId],
    );
    // The caller belongs to A and B. C exists only so the stranger has a member
    // row somewhere the caller cannot reach.
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values
       ($1,'G02 Fan A',$4),($2,'G02 Fan B',$4),($3,'G02 Fan C',$5)`,
      [fanFixture.spaceAId, fanFixture.spaceBId, fanFixture.spaceCId,
        fanFixture.identityId, fanFixture.strangerIdentityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$7,'member',null,0,$1),($2,$8,'member',null,0,$2),($3,$9,'member',null,0,$3),
       ($4,$7,'team_member',null,1,$1),
       ($5,$7,'pull_request',null,10,$1),($6,$8,'commit',null,10,$2)`,
      [fanFixture.memberAId, fanFixture.memberBId, fanFixture.strangerMemberId,
        fanFixture.teamMemberId, fanFixture.pullRequestAId, fanFixture.commitBId,
        fanFixture.spaceAId, fanFixture.spaceBId, fanFixture.spaceCId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$4,$7,'owner','G02 fan owner in A'),($2,$5,$7,'owner','G02 fan owner in B'),
       ($3,$6,$8,'owner','G02 fan stranger in C')`,
      [fanFixture.memberAId, fanFixture.memberBId, fanFixture.strangerMemberId,
        fanFixture.spaceAId, fanFixture.spaceBId, fanFixture.spaceCId,
        fanFixture.identityId, fanFixture.strangerIdentityId],
    );
    // Owned by the caller's Space-A member row, so can_act_as authorizes it in
    // Space A and nowhere else — the legitimate acting-as case.
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'G02 fan agent','worker','test agent')`,
      [fanFixture.teamMemberId, fanFixture.memberAId],
    );
    await client.query(
      `insert into public.pull_requests(entity_id,space_id,url,repo,number,title)
       values($1,$2,'https://example.invalid/pr/1','acme/tm8',1,'Fan PR')`,
      [fanFixture.pullRequestAId, fanFixture.spaceAId],
    );
    await client.query(
      `insert into public.commits(entity_id,space_id,url,repo,sha,message)
       values($1,$2,'https://example.invalid/c/1','acme/tm8','abcdef1234567','Fan commit')`,
      [fanFixture.commitBId, fanFixture.spaceBId],
    );
    return fanFixture;
  });
}

/**
 * Apply a not-yet-landed migration candidate from an absolute path OUTSIDE the
 * repository.
 *
 * This exists because of a real constraint, not convenience. The fix for the
 * fan-out defect must land as a forward-only `create or replace` in a NEW
 * migration (017 is applied and db/migrate.mjs checksums it), but a candidate
 * file parked in db/migrations would be swept up by every fixture that
 * enumerates the directory — including the independent W3 public harness — and
 * injected into scratch databases it was never meant to reach. So the
 * candidate is authored outside the tree and pointed at by
 * TM8_G02FIX_CANDIDATE, which lets these exact assertions run against it
 * before it lands. Once the coordinator lands it under its assigned number,
 * migrationFiles() picks it up on its own and the variable is simply unset —
 * which is why no test here names a migration number.
 */
function applyCandidate(url: string, candidatePath: string): void {
  const psql = process.env['TM8_PSQL'] ?? '/opt/homebrew/opt/postgresql@18/bin/psql';
  const result = spawnSync(
    psql, ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-1', '-q', url, '-f', candidatePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`could not apply candidate ${candidatePath}:\n${result.stdout}\n${result.stderr}`);
  }
}

describe.sequential('W2.G02-FIX tracking.refresh multi-Space fan-out', () => {
  let database: W1ScratchDatabase;
  let fanFixture: FanFixture;
  let appliedChain: string[];

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g02_fan');
    appliedChain = migrationFiles();
    database.apply(appliedChain);
    const candidate = process.env['TM8_G02FIX_CANDIDATE'];
    if (candidate) applyCandidate(database.url, candidate);
    fanFixture = await seedFanOut(database);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  });

  it('applies the whole migration chain, discovered rather than listed', () => {
    // Named in the evidence so a reader knows exactly what this fixture proves
    // against. If the chain grows, this expectation grows with it by itself.
    expect(appliedChain).toContain('017_w2_entities_commands_tracking.sql');
    expect(appliedChain.length).toBeGreaterThanOrEqual(28);
  });

  it('accepts an unscoped refresh spanning every Space the caller belongs to', async () => {
    const accepted = await asApp(database, fanFixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('queue_tracking_refresh', [[], null, 'g02fan-unscoped']));
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' });
    expect(accepted['requestIds']).toHaveLength(2);
    const queued = await database.query<{ spaces: number }>(
      `select count(distinct space_id)::integer spaces from public.tracking_refresh_requests
        where space_id = any($1::uuid[])`,
      [[fanFixture.spaceAId, fanFixture.spaceBId]],
    );
    expect(queued[0]!.spaces).toBe(2);
  });

  it('accepts entityIds that span two Spaces', async () => {
    const accepted = await asApp(database, fanFixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('queue_tracking_refresh', [
        [fanFixture.pullRequestAId, fanFixture.commitBId], null, 'g02fan-two-space',
      ]));
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' });
    expect(accepted['requestIds']).toHaveLength(2);
  });

  it('still accepts a single-Space refresh and records the caller as requester', async () => {
    const accepted = await asApp(database, fanFixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('queue_tracking_refresh', [
        [fanFixture.pullRequestAId], null, 'g02fan-single-space',
      ]));
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' });
    expect(accepted['requestIds']).toHaveLength(1);
    const requested = await database.query<{ requestedBy: string }>(
      `select requested_by::text "requestedBy" from public.tracking_refresh_requests where id=$1`,
      [(accepted['requestIds'] as string[])[0]],
    );
    expect(requested[0]!.requestedBy).toBe(fanFixture.memberAId);
  });

  it('still authorizes a legitimate act-as inside the Space that owns the actor', async () => {
    const accepted = await asApp(database, fanFixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('queue_tracking_refresh', [
        [fanFixture.pullRequestAId], fanFixture.teamMemberId, 'g02fan-actas-ok',
      ]));
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' });
    expect(accepted['requestIds']).toHaveLength(1);
  });

  it('still refuses an actor the caller cannot act as', async () => {
    await expect(asApp(database, fanFixture.identityId, (q) =>
      q.rpc('queue_tracking_refresh', [[], fanFixture.strangerMemberId, 'g02fan-actas-stranger']),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('still refuses a Space-A member id offered across a two-Space fan-out', async () => {
    // The sharpest anti-bypass case in this block, and the one that looks most
    // like the defect: an EXPLICIT p_actor_id must keep winning the coalesce in
    // every iteration, so a member row that is only valid in Space A must still
    // be refused when the fan-out reaches Space B. A fix that resolved from
    // current_member_id unconditionally would turn this into a silent success.
    await expect(asApp(database, fanFixture.identityId, (q) =>
      q.rpc('queue_tracking_refresh', [[], fanFixture.memberAId, 'g02fan-actas-crossspace']),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('attributes each fanned-out row to the caller member of ITS OWN Space', async () => {
    // The positive statement of the defect: the per-Space attribution the loop
    // is supposed to produce. requested_by comes from current_member_id(space),
    // so each row must name a different member row — the caller's own in that
    // Space — never one Space's member id twice.
    const accepted = await asApp(database, fanFixture.identityId, (q) =>
      q.rpc<Record<string, unknown>>('queue_tracking_refresh', [[], null, 'g02fan-attribution']));
    const rows = await database.query<{ spaceId: string; requestedBy: string }>(
      `select space_id::text "spaceId", requested_by::text "requestedBy"
         from public.tracking_refresh_requests where id = any($1::uuid[]) order by space_id`,
      [accepted['requestIds']],
    );
    const attribution = new Map(rows.map((row) => [row.spaceId, row.requestedBy]));
    expect(attribution.get(fanFixture.spaceAId)).toBe(fanFixture.memberAId);
    expect(attribution.get(fanFixture.spaceBId)).toBe(fanFixture.memberBId);
  });

  it('carries no trigger or actor-reading default on the queue table', async () => {
    // The executable half of "is internal.bind_actor load-bearing for this
    // INSERT?". Read of the catalog rather than of the migration text: if the
    // queue table grows a trigger or a default that reads tm8.actor_id, the
    // binding stops being incidental and this expectation fails loudly.
    const triggers = await database.query<{ total: number }>(
      `select count(*)::integer total from pg_trigger
        where tgrelid = 'public.tracking_refresh_requests'::regclass and not tgisinternal`);
    expect(triggers[0]!.total).toBe(0);
    const defaults = await database.query<{ expression: string }>(
      `select pg_get_expr(d.adbin, d.adrelid) expression
         from pg_attrdef d where d.adrelid = 'public.tracking_refresh_requests'::regclass`);
    expect(defaults.map((row) => row.expression).join(' ')).not.toMatch(/actor/i);
  });

  it('records no per-Space actor on the ledger row for an unbound caller', async () => {
    // The one deliberate behavioural delta of the fix, pinned so it is a stated
    // expectation and not a silent side effect. internal.ledger_record is the
    // only reader of the binding downstream of the loop; before the fix it
    // recorded whichever Space happened to be last. A fan-out spanning N Spaces
    // has no single actor, so NULL is the honest value — and 031's header
    // states replay pins identity_id only, never actor_id, so nothing depends
    // on the old one.
    await asApp(database, fanFixture.identityId, (q) =>
      q.rpc('queue_tracking_refresh', [[], null, 'g02fan-ledger-actor']));
    const ledger = await database.query<{ actorId: string | null; identityId: string }>(
      `select actor_id::text "actorId", identity_id "identityId" from public.command_ledger
        where client_mutation_id='g02fan-ledger-actor'`);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.identityId).toBe(fanFixture.identityId);
    expect(ledger[0]!.actorId).toBeNull();
  });

  it('still records the requested actor on the ledger row for an acting-as caller', async () => {
    // The other side of that delta: restoring the ENTRY state is a no-op for a
    // caller who deliberately named an actor, so their audit trail is unchanged.
    await asApp(database, fanFixture.identityId, async (q, client) => {
      await client.query(`select set_config('tm8.actor_id',$1,true)`, [fanFixture.teamMemberId]);
      return q.rpc('queue_tracking_refresh', [
        [fanFixture.pullRequestAId], fanFixture.teamMemberId, 'g02fan-ledger-actas',
      ]);
    });
    const ledger = await database.query<{ actorId: string | null }>(
      `select actor_id::text "actorId" from public.command_ledger
        where client_mutation_id='g02fan-ledger-actas'`);
    expect(ledger[0]!.actorId).toBe(fanFixture.teamMemberId);
  });

  it('leaves no partially queued row behind when the fan-out is refused', async () => {
    const before = await database.query<{ total: number }>(
      `select count(*)::integer total from public.tracking_refresh_requests`);
    await expect(asApp(database, fanFixture.identityId, (q) =>
      q.rpc('queue_tracking_refresh', [[], fanFixture.strangerMemberId, 'g02fan-rollback']),
    )).rejects.toMatchObject({ code: '42501' });
    const after = await database.query<{ total: number }>(
      `select count(*)::integer total from public.tracking_refresh_requests`);
    expect(after[0]!.total).toBe(before[0]!.total);
  });
});

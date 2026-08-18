import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const IDENTITY = 'assignment-provenance-owner';

interface Fixture {
  spaceId: string;
  memberId: string;
  peerId: string;
  teammateId: string;
  memberTaskId: string;
  teammateTaskId: string;
  doneTaskId: string;
  otherAssigneeTaskId: string;
  reassignedTaskId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
let legacyCreatedAt: Date;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asApp<T>(fn: (q: Querier, client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'assignment-provenance-pg', true)`,
      [IDENTITY],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async <T2>(fnName: string, args: readonly unknown[] = []): Promise<T2> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        const result = await client.query(`select public.${fnName}(${placeholders}) result`, [...args]);
        return result.rows[0]?.result as T2;
      },
    };
    return fn(q, client);
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids = (await client.query<{
      space_id: string;
      member_id: string;
      peer_id: string;
      teammate_id: string;
      member_task_id: string;
      teammate_task_id: string;
      done_task_id: string;
      other_assignee_task_id: string;
      reassigned_task_id: string;
    }>(
      `select internal.new_id() space_id,
              internal.new_id() member_id,
              internal.new_id() peer_id,
              internal.new_id() teammate_id,
              internal.new_id() member_task_id,
              internal.new_id() teammate_task_id,
              internal.new_id() done_task_id,
              internal.new_id() other_assignee_task_id,
              internal.new_id() reassigned_task_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Assignment owner'), ('assignment-provenance-peer', 'Assignment peer')`,
      [IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Assignment provenance', $2)`,
      [ids.space_id, IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $4, 'member', 0, $1),
       ($2, $4, 'member', 1, $2),
       ($3, $4, 'team_member', 2, $1),
       ($5, $4, 'task', 3, $1),
       ($6, $4, 'task', 4, $3),
       ($7, $4, 'task', 5, $1),
       ($8, $4, 'task', 6, $1),
       ($9, $4, 'task', 7, $1)`,
      [
        ids.member_id,
        ids.peer_id,
        ids.teammate_id,
        ids.space_id,
        ids.member_task_id,
        ids.teammate_task_id,
        ids.done_task_id,
        ids.other_assignee_task_id,
        ids.reassigned_task_id,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $3, $4, 'owner', 'Assignment owner'),
       ($2, $3, 'assignment-provenance-peer', 'member', 'Assignment peer')`,
      [ids.member_id, ids.peer_id, ids.space_id, IDENTITY],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role)
       values ($1, $2, 'Assignment agent', 'engineer')`,
      [ids.teammate_id, ids.member_id],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority) values
       ($1, 'Member assigned', 'open', 'medium'),
       ($2, 'Teammate assigned', 'open', 'medium'),
       ($3, 'Done member assigned', 'done', 'medium'),
       ($4, 'Other assignee', 'open', 'medium'),
       ($5, 'Reassigned', 'open', 'medium')`,
      [
        ids.member_task_id,
        ids.teammate_task_id,
        ids.done_task_id,
        ids.other_assignee_task_id,
        ids.reassigned_task_id,
      ],
    );

    return {
      spaceId: ids.space_id,
      memberId: ids.member_id,
      peerId: ids.peer_id,
      teammateId: ids.teammate_id,
      memberTaskId: ids.member_task_id,
      teammateTaskId: ids.teammate_task_id,
      doneTaskId: ids.done_task_id,
      otherAssigneeTaskId: ids.other_assignee_task_id,
      reassignedTaskId: ids.reassigned_task_id,
    };
  });
}

async function assign(taskId: string, assigneeId: string, actorId: string, mutationId: string): Promise<void> {
  await asApp(async (_q, client) => {
    await client.query(
      `select public.write_edge($1, $2, 'assigned_to', '{}'::jsonb, $3, $4)`,
      [taskId, assigneeId, actorId, mutationId],
    );
  });
}

describe.sequential('task assignment provenance (129)', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('assignment_prov');
    const files = migrationFiles();
    const migration = '129_task_assignment_provenance.sql';
    // Position-pinned (R15): this suite asserts the chain AT 129, so it
    // applies the slice BEFORE 129, seeds the legacy edge, then applies 129
    // itself. `files.at(-1)` was the original pin and broke the moment a
    // later migration (130, the Board tab) landed — and the filter() it
    // guarded would have applied 130 *before* 129, out of chain order.
    const index = files.indexOf(migration);
    expect(index).toBeGreaterThan(-1);
    database.apply(files.slice(0, index));
    fixture = await seed();
    legacyCreatedAt = await asOwner(async (client) => {
      const row = (await client.query<{ created_at: Date }>(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'assigned_to', $4)
         returning created_at`,
        [fixture.spaceId, fixture.memberTaskId, fixture.peerId, fixture.memberId],
      )).rows[0]!;
      return row.created_at;
    });
    database.apply([migration]);
    // …plus EXACTLY 135_graph_kind, out of band. The reads below run CURRENT
    // code, and current code speaks the current schema — 135 joined
    // public.graphs into ENTITY_FROM, so `loadEntitySummariesByIds` refuses
    // to run without the relation. The FULL remainder is deliberately NOT
    // applied: this suite is position-pinned AT 129 (the header's whole
    // point), and later migrations legitimately changed execution_spawn's
    // provenance behaviour — applying them would silently retarget the spawn
    // assertion below at a different function than the one it documents.
    // 135 touches no function this suite exercises (verified: registry row,
    // detail table, entity_content arm, its own doors) and depends on nothing
    // past 091, so the position statement survives it.
    database.apply(['135_graph_kind.sql']);
    // …and 147, for EXACTLY the reason 135 is here. 147 added
    // `entities.status_category` to `ENTITY_COLUMNS`, so current code selects a
    // column a 129-era schema does not have and `loadEntitySummariesByIds`
    // refuses to run — the same failure 135 caused, with a different relation.
    // Same safety argument, checked the same way: 147 depends on nothing past
    // 003 (public.entities, public.tasks, and disabling `entities_capture_event`
    // around its own backfill), and the only behaviour it adds is a trigger that
    // maintains that column from `tasks.work_status`. It touches no function
    // this suite exercises, so the position statement survives it too.
    database.apply(['147_entity_status_category.sql']);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('backfills legacy assignment time while leaving the unknowable assigner null', async () => {
    const row = (await database.query<{
      assigned_by: string | null;
      assigned_at: Date;
    }>(
      `select assigned_by, assigned_at from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [fixture.memberTaskId, fixture.peerId],
    ))[0]!;
    expect(row.assigned_by).toBeNull();
    expect(row.assigned_at.toISOString()).toBe(legacyCreatedAt.toISOString());
  });

  it('records member and team_member assigners and refreshes provenance on re-assignment', async () => {
    await assign(fixture.memberTaskId, fixture.peerId, fixture.memberId, 'assignment-member');
    await assign(fixture.teammateTaskId, fixture.peerId, fixture.teammateId, 'assignment-teammate');
    await assign(fixture.doneTaskId, fixture.peerId, fixture.memberId, 'assignment-done');
    await assign(fixture.otherAssigneeTaskId, fixture.teammateId, fixture.memberId, 'assignment-other-assignee');
    await assign(fixture.reassignedTaskId, fixture.peerId, fixture.memberId, 'assignment-before-reassign');

    const before = (await database.query<{ assigned_at: Date }>(
      `select assigned_at from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [fixture.reassignedTaskId, fixture.peerId],
    ))[0]!;
    await assign(fixture.reassignedTaskId, fixture.peerId, fixture.teammateId, 'assignment-after-reassign');

    const rows = await database.query<{
      src_id: string;
      assigned_by: string | null;
      assigned_at: Date;
      refreshed: boolean;
    }>(
      `select src_id, assigned_by, assigned_at,
              assigned_at > $3::timestamptz refreshed
         from public.edges
        where src_id = any($1::uuid[]) and dst_id = $2 and type = 'assigned_to'
        order by src_id`,
      [
        [fixture.memberTaskId, fixture.teammateTaskId, fixture.reassignedTaskId],
        fixture.peerId,
        before.assigned_at,
      ],
    );
    expect(new Map(rows.map((row) => [row.src_id, row.assigned_by]))).toEqual(new Map([
      [fixture.memberTaskId, fixture.memberId],
      [fixture.teammateTaskId, fixture.teammateId],
      [fixture.reassignedTaskId, fixture.teammateId],
    ]));
    expect(rows.every((row) => row.assigned_at instanceof Date)).toBe(true);
    expect(rows.find((row) => row.src_id === fixture.reassignedTaskId)?.refreshed).toBe(true);
  });

  it('publishes assignments without changing assignees on both summary projection arms', async () => {
    const { read, projected } = await asApp(async (q) => {
      const read = await loadEntitySummariesByIds(
        q,
        [fixture.memberTaskId, fixture.teammateTaskId],
        IDENTITY,
      );
      const projected = await new PgEntityProjector().entitySummaries(
        q,
        [fixture.memberTaskId, fixture.teammateTaskId],
      );
      return { read, projected };
    });

    for (const summaries of [new Map(read.map((item) => [item.id, item])), projected]) {
      const memberState = summaries.get(fixture.memberTaskId)?.state;
      expect(memberState).toMatchObject({
        kind: 'task',
        assignees: [{ id: fixture.peerId, displayName: 'Assignment peer' }],
        assignments: [{
          assignee: { id: fixture.peerId, displayName: 'Assignment peer' },
          assignedBy: { id: fixture.memberId, kind: 'member', displayName: 'Assignment owner' },
        }],
      });
      expect(memberState?.kind === 'task' ? memberState.assignments?.[0]?.assignedAt : null)
        .toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

      expect(summaries.get(fixture.teammateTaskId)?.state).toMatchObject({
        kind: 'task',
        assignees: [{ id: fixture.peerId }],
        assignments: [{
          assignee: { id: fixture.peerId },
          assignedBy: { id: fixture.teammateId, kind: 'team_member', displayName: 'Assignment agent' },
        }],
      });
    }
  });

  it('filters by current assigner and ANDs assignedByIds with status and assignee', async () => {
    const query = (filters: NonNullable<CollectionQuery['filters']>): CollectionQuery => ({
      spaceId: fixture.spaceId,
      kinds: ['task'],
      filters,
      sort: 'position',
      limit: 20,
    });

    const memberAnd = await asApp((q) => queryCollection(q, query({
      assignedByIds: [fixture.memberId],
      status: ['open'],
      assigneeIds: [fixture.peerId],
    }), IDENTITY));
    expect(memberAnd.page.items.map((item) => item.id)).toEqual([fixture.memberTaskId]);

    const teammate = await asApp((q) => queryCollection(q, query({
      assignedByIds: [fixture.teammateId],
    }), IDENTITY));
    expect(teammate.page.items.map((item) => item.id)).toEqual([
      fixture.teammateTaskId,
      fixture.reassignedTaskId,
    ]);

  });

  it('removes provenance with the assignment edge', async () => {
    await asApp(async (_q, client) => {
      const edge = (await client.query<{ id: string }>(
        `select id from public.edges
          where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
        [fixture.teammateTaskId, fixture.peerId],
      )).rows[0]!;
      await client.query(
        `select public.delete_edge($1, $2, $3)`,
        [edge.id, fixture.teammateId, 'assignment-delete'],
      );
    });

    expect(await database.query(
      `select assigned_by, assigned_at from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [fixture.teammateTaskId, fixture.peerId],
    )).toEqual([]);

    const summary = await asApp(async (q) => (
      await loadEntitySummariesByIds(q, [fixture.teammateTaskId], IDENTITY)
    )[0]!);
    expect(summary.state).toMatchObject({ kind: 'task', assignees: [], assignments: [] });

    const filtered = await asApp((q) => queryCollection(q, {
      spaceId: fixture.spaceId,
      kinds: ['task'],
      filters: { assignedByIds: [fixture.teammateId], assigneeIds: [fixture.peerId] },
      sort: 'position',
      limit: 20,
    }, IDENTITY));
    expect(filtered.page.items.map((item) => item.id)).toEqual([fixture.reassignedTaskId]);
  });

  it('refreshes provenance through execution_spawn without rewriting the existing assignment', async () => {
    const before = (await database.query<{ assigned_at: Date }>(
      `select assigned_at from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [fixture.otherAssigneeTaskId, fixture.teammateId],
    ))[0]!;

    await asApp(async (_q, client) => {
      await client.query(
        `select public.execution_spawn(
           p_space_id => $1,
           p_team_member_id => $2,
           p_task_ids => array[$3]::uuid[],
           p_mode => 'worker',
           p_actor_id => $2,
           p_client_mutation_id => $4
         )`,
        [fixture.spaceId, fixture.teammateId, fixture.otherAssigneeTaskId, 'assignment-spawn-reassign'],
      );
    });

    const after = (await database.query<{
      created_by: string;
      assigned_by: string | null;
      assigned_at: Date;
      props: Record<string, unknown>;
    }>(
      `select created_by, assigned_by, assigned_at, props from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [fixture.otherAssigneeTaskId, fixture.teammateId],
    ))[0]!;
    expect(after).toMatchObject({
      created_by: fixture.memberId,
      assigned_by: fixture.teammateId,
      props: {},
    });
    expect(after.assigned_at.getTime()).toBeGreaterThan(before.assigned_at.getTime());
  });
});

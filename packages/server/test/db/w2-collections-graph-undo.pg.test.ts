import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CollectionQuery, GraphQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { queryGraph } from '../../src/facade/handlers/w2/graph-undo.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// The WHOLE applied chain, not a hand-listed slice: this suite runs CURRENT
// src, whose shared read SQL references columns born in later migrations
// (ppd.name: 021, interaction_profiles' full set: 027) — a pinned slice
// re-breaks on every schema-coupled src change.
const MIGRATIONS = migrationFiles();

interface Fixture {
  identityId: string;
  outsiderIdentityId: string;
  peerIdentityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
  peerMemberId: string;
  rootId: string;
  childId: string;
  siblingId: string;
  deletedId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'g05-owner'::text as "identityId",
              'g05-outsider'::text as "outsiderIdentityId",
              'g05-peer'::text as "peerIdentityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "otherSpaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "outsiderMemberId",
              internal.new_id()::text as "peerMemberId",
              internal.new_id()::text as "rootId",
              internal.new_id()::text as "childId",
              internal.new_id()::text as "siblingId",
              internal.new_id()::text as "deletedId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G05 owner'), ($2, 'G05 outsider'), ($3, 'G05 peer')`,
      [fixture.identityId, fixture.outsiderIdentityId, fixture.peerIdentityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G05 graph', $3), ($2, 'G05 other', $4)`,
      [fixture.spaceId, fixture.otherSpaceId, fixture.identityId, fixture.outsiderIdentityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by, deleted_at)
       values ($1, $8, 'member', null, 0, $1, null),
              ($2, $9, 'member', null, 0, $2, null),
              ($3, $8, 'member', null, 0, $3, null),
              ($4, $8, 'task', null, 0, $1, null),
              ($5, $8, 'task', $4, 1, $1, null),
              ($6, $8, 'task', $4, 2, $1, null),
              ($7, $8, 'task', $4, 3, $1, now())`,
      [
        fixture.memberId,
        fixture.outsiderMemberId,
        fixture.peerMemberId,
        fixture.rootId,
        fixture.childId,
        fixture.siblingId,
        fixture.deletedId,
        fixture.spaceId,
        fixture.otherSpaceId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'G05 owner'),
              ($2, $5, $7, 'owner', 'G05 outsider'),
              ($3, $4, $8, 'member', 'G05 peer')`,
      [
        fixture.memberId,
        fixture.outsiderMemberId,
        fixture.peerMemberId,
        fixture.spaceId,
        fixture.otherSpaceId,
        fixture.identityId,
        fixture.outsiderIdentityId,
        fixture.peerIdentityId,
      ],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority)
       values ($1, 'Root', 'open', 'medium'),
              ($2, 'Child', 'open', 'high'),
              ($3, 'Sibling', 'open', 'low'),
              ($4, 'Deleted', 'open', 'urgent')`,
      [fixture.rootId, fixture.childId, fixture.siblingId, fixture.deletedId],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
       values ($1, $2, $3, 'depends_on', '{"hard":true}', $5),
              ($1, $3, $4, 'relates_to', '{}', $5),
              ($1, $2, $6, 'depends_on', '{"hard":true}', $5)`,
      [
        fixture.spaceId,
        fixture.rootId,
        fixture.childId,
        fixture.siblingId,
        fixture.memberId,
        fixture.deletedId,
      ],
    );
    return fixture;
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
              set_config('tm8.request_id', 'req-g05-pg', true)`,
      [identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <T>(fnName: string, args: readonly unknown[] = []): Promise<T> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        const result = await client.query(`select public.${fnName}(${placeholders}) result`, [...args]);
        return result.rows[0]?.result as T;
      },
    };
    return fn(q, client);
  });
}

describe.sequential('W2.G05 collection, graph, and undo PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g05');
    database.apply(MIGRATIONS);
    fixture = await seed(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('applies independently after 001-015 and exposes only the replacement undo RPC', async () => {
    const rows = await database.query<{ args: string; app_exec: boolean; public_exec: boolean }>(
      `select pg_get_function_identity_arguments(p.oid) args,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'undo_command'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app_exec: true, public_exec: false });
    expect(rows[0]!.args).toContain('p_client_mutation_id text');
  });

  it('executes collection filters, hierarchy, grouping, and fingerprinted keyset paging through RLS', async () => {
    const query: CollectionQuery = {
      spaceId: fixture.spaceId,
      kinds: ['task'],
      parentId: fixture.rootId,
      groupBy: 'workStatus',
      sort: 'position',
      limit: 1,
    };
    const first = await asApp(database, fixture.identityId, (q) => queryCollection(q, query, fixture.identityId));
    expect(first.page.items.map((item) => item.id)).toEqual([fixture.childId]);
    expect(first.groups?.map((group) => group.key)).toEqual(['open']);
    expect(first.page.nextCursor).toBeTruthy();

    const second = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { ...query, cursor: first.page.nextCursor! },
      fixture.identityId,
    ));
    expect(second.page.items.map((item) => item.id)).toEqual([fixture.siblingId]);
    await expect(asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { ...query, parentId: null, cursor: first.page.nextCursor! },
      fixture.identityId,
    ))).rejects.toMatchObject({ code: 'invalid_cursor' });

    const outsider = await asApp(database, fixture.outsiderIdentityId, (q) => queryCollection(
      q,
      { spaceId: fixture.spaceId, kinds: ['task'] },
      fixture.outsiderIdentityId,
    ));
    expect(outsider.page.items).toEqual([]);
  });

  it('filters and groups tasks by priority (Board tab wave)', async () => {
    // Fixture priorities: Root=medium, Child=high, Sibling=low, Deleted=urgent (soft-deleted).
    const high = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { spaceId: fixture.spaceId, kinds: ['task'], filters: { priority: ['high'] } },
      fixture.identityId,
    ));
    expect(high.page.items.map((item) => item.id)).toEqual([fixture.childId]);

    const widened = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { spaceId: fixture.spaceId, kinds: ['task'], filters: { priority: ['high', 'low'] } },
      fixture.identityId,
    ));
    expect(widened.page.items.map((item) => item.id).sort()).toEqual(
      [fixture.childId, fixture.siblingId].sort(),
    );

    // The only urgent task is soft-deleted; the default deleted filter must still apply.
    const urgent = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { spaceId: fixture.spaceId, kinds: ['task'], filters: { priority: ['urgent'] } },
      fixture.identityId,
    ));
    expect(urgent.page.items).toEqual([]);

    const grouped = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      { spaceId: fixture.spaceId, kinds: ['task'], groupBy: 'priority', limit: 10 },
      fixture.identityId,
    ));
    const byKey = new Map((grouped.groups ?? []).map((group) => [group.key, group]));
    expect([...byKey.keys()].sort()).toEqual(['high', 'low', 'medium']);
    expect(byKey.get('high')).toMatchObject({ label: 'High', total: 1 });
    expect(byKey.get('high')!.items.map((item) => item.id)).toEqual([fixture.childId]);
    expect(byKey.get('medium')!.items.map((item) => item.id)).toEqual([fixture.rootId]);

    // The filter ANDs with workStatus (both are task-narrowing predicates).
    const anded = await asApp(database, fixture.identityId, (q) => queryCollection(
      q,
      {
        spaceId: fixture.spaceId,
        kinds: ['task'],
        filters: { priority: ['high'], workStatus: ['done'] },
      },
      fixture.identityId,
    ));
    expect(anded.page.items).toEqual([]);
  });

  it('bounds graph traversal and excludes non-live or unreadable endpoints and edges', async () => {
    const query: GraphQuery = {
      spaceId: fixture.spaceId,
      focusId: fixture.rootId,
      hops: 1,
      mode: 'dependency',
      limit: 10,
    };
    const graph = await asApp(database, fixture.identityId, (q) => queryGraph(q, query, fixture.identityId));
    expect(graph.nodes.map((node) => node.id)).toEqual([fixture.rootId, fixture.childId]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      type: 'depends_on',
      source: { id: fixture.rootId },
      target: { id: fixture.childId },
    });
    expect(graph.clusters).toEqual([{ parentId: fixture.rootId, childIds: [fixture.childId] }]);

    const outsider = await asApp(database, fixture.outsiderIdentityId, (q) => queryGraph(
      q,
      query,
      fixture.outsiderIdentityId,
    ));
    expect(outsider).toEqual({ nodes: [], edges: [], clusters: [] });
  });

  it('redeems a registered inverse atomically and replays the same token idempotently by mutation id', async () => {
    const created = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { edge: { id: string }; undo: { token: string } } }>(
        `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, $4) result`,
        [fixture.rootId, fixture.siblingId, fixture.memberId, 'g05-edge-create'],
      )
    ).rows[0]!.result);

    const redeem = () => asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: Record<string, unknown> }>(
        `select public.undo_command($1, $2, $3) result`,
        [created.undo.token, fixture.memberId, 'g05-undo-replay'],
      )
    ).rows[0]!.result);
    const first = await redeem();
    const replay = await redeem();
    expect(replay).toEqual(first);

    const state = await database.query<{ edges: number; ledger: number; mutation_id: string | null }>(
      `select count(*) filter (where e.id = $1)::integer edges,
              (select count(*)::integer from public.command_ledger
                where operation = 'commands.undo' and client_mutation_id = $2) ledger,
              (select redemption_client_mutation_id from public.undo_tokens where token = $3) mutation_id
         from public.edges e`,
      [created.edge.id, 'g05-undo-replay', created.undo.token],
    );
    expect(state[0]).toEqual({ edges: 0, ledger: 1, mutation_id: 'g05-undo-replay' });
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command($1, $2, 'g05-different-replay')`,
      [created.undo.token, fixture.memberId],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('executes the shipped move and restore inverse registrations', async () => {
    const beforeMove = (await database.query<{
      parent_id: string | null;
      position: number;
      version: number;
    }>(
      `select parent_id::text, position, version from public.entities where id = $1`,
      [fixture.childId],
    ))[0]!;
    const moved = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { undo: { token: string } } }>(
        `select public.move_entity($1, null::uuid, 20, $2, $3, $4) result`,
        [fixture.childId, beforeMove.version, fixture.memberId, 'g05-move-create'],
      )
    ).rows[0]!.result);
    await asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command($1, $2, 'g05-move-undo')`,
      [moved.undo.token, fixture.memberId],
    ));
    const afterMoveUndo = (await database.query<{ parent_id: string | null; position: number }>(
      `select parent_id::text, position from public.entities where id = $1`,
      [fixture.childId],
    ))[0]!;
    expect(afterMoveUndo).toEqual({
      parent_id: beforeMove.parent_id,
      position: beforeMove.position,
    });

    const removed = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { undo: { token: string } } }>(
        `select public.delete_entity($1, $2, $3) result`,
        [fixture.siblingId, fixture.memberId, 'g05-delete-create'],
      )
    ).rows[0]!.result);
    const deleted = await database.query<{ deleted: boolean }>(
      `select deleted_at is not null deleted from public.entities where id = $1`,
      [fixture.siblingId],
    );
    expect(deleted[0]!.deleted).toBe(true);
    await asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command($1, $2, 'g05-restore-undo')`,
      [removed.undo.token, fixture.memberId],
    ));
    const restored = await database.query<{ deleted: boolean }>(
      `select deleted_at is not null deleted from public.entities where id = $1`,
      [fixture.siblingId],
    );
    expect(restored[0]!.deleted).toBe(false);
  });

  it('keeps invalid, expired, unauthorized, and irreversible tokens non-redeemable', async () => {
    const created = await asApp(database, fixture.identityId, async (_q, client) => (
      await client.query<{ result: { undo: { token: string } } }>(
        `select public.write_edge($1, $2, 'relates_to', '{}'::jsonb, $3, $4) result`,
        [fixture.childId, fixture.siblingId, fixture.memberId, 'g05-edge-auth'],
      )
    ).rows[0]!.result);

    await expect(asApp(database, fixture.peerIdentityId, async (_q, client) => client.query(
      `select public.undo_command($1, $2, 'g05-undo-stolen')`,
      [created.undo.token, fixture.peerMemberId],
    ))).rejects.toMatchObject({ code: '42501' });
    const stillLive = await database.query<{ redeemed_at: string | null }>(
      `select redeemed_at::text from public.undo_tokens where token = $1`,
      [created.undo.token],
    );
    expect(stillLive[0]!.redeemed_at).toBeNull();

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.undo_tokens set expires_at = now() - interval '1 second' where token = $1`, [
        created.undo.token,
      ]);
    });
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command($1, $2, 'g05-undo-expired')`,
      [created.undo.token, fixture.memberId],
    ))).rejects.toMatchObject({ code: '23514' });

    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command('g05-no-such-token', $1, 'g05-undo-missing')`,
      [fixture.memberId],
    ))).rejects.toMatchObject({ code: 'P0002' });

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.undo_tokens(
           token, space_id, actor_id, label, operation, arguments, expires_at)
         values (
           'g05-broken-inverse', $1, $2, 'Broken inverse', 'edges.delete',
           jsonb_build_object('edgeId', internal.new_id()), now() + interval '5 minutes')`,
        [fixture.spaceId, fixture.memberId],
      );
    });
    await expect(asApp(database, fixture.identityId, async (_q, client) => client.query(
      `select public.undo_command('g05-broken-inverse', $1, 'g05-undo-broken')`,
      [fixture.memberId],
    ))).rejects.toMatchObject({ code: 'P0002' });
    const atomic = await database.query<{ redeemed_at: string | null; ledgers: number }>(
      `select redeemed_at::text,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'g05-undo-broken') ledgers
         from public.undo_tokens where token = 'g05-broken-inverse'`,
    );
    expect(atomic[0]).toEqual({ redeemed_at: null, ledgers: 0 });

    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.undo_tokens(
           token, space_id, actor_id, label, operation, arguments, expires_at)
         values (
           'g05-handoff-token', $1, $2, 'Forbidden handoff undo',
           'handoffs.withdraw', '{}', now() + interval '5 minutes')`,
        [fixture.spaceId, fixture.memberId],
      );
    })).rejects.toMatchObject({ code: '23514' });
  });
});

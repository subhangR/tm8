/**
 * Migration 100 — collection membership writes (`collections.addItem` /
 * `collections.removeItem` over `set_collection_item` / `remove_collection_item`).
 *
 * What each block pins, mapped to the task's groomed acceptance tests:
 *
 * - **One record, whichever door** — both UI entry points (entity side,
 *   collection side) call the same RPC pair, so the SQL layer is where "the
 *   same record the other side would have created" is actually enforced: the
 *   `(src, dst, type)` uniqueness makes a re-add an UPSERT, never a duplicate.
 * - **Auto-position** — omitting `p_position` appends after the current max;
 *   this is the behavior the generic `write_edge` door does NOT provide, and
 *   the reason the sugar RPC exists.
 * - **Multi-membership** — one entity in two collections; removing it from one
 *   leaves the other intact (the edge case a single-parent model fails).
 * - **Durability** — the membership is a plain `public.edges` row, asserted
 *   as `tm8_graph_owner` outside the writing transaction. Surviving a server
 *   restart is the database's contract once the row exists; there is no
 *   process-local state to lose.
 * - **Forbidden** — a bound identity that is NOT a member of the Space is
 *   refused by `internal.require_space_member` (42501) at both doors.
 * - **Replay** — the remove door admits a same-cmid retry by returning the
 *   stored result instead of raising `not_found` on the already-deleted edge.
 */
import { type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const OWNER = 'collection-membership-owner';
const OUTSIDER = 'collection-membership-outsider';

describe.sequential('migration 100 — collection membership RPCs', () => {
  let database: W1ScratchDatabase;
  let spaceId: string;
  let collectionA: string;
  let collectionB: string;
  let task: string;

  async function asIdentity<T>(identity: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'collection-membership', true)`,
        [identity],
      );
      return fn(client);
    });
  }

  async function appValue<T>(sql: string, params: readonly unknown[] = [], identity = OWNER): Promise<T> {
    return asIdentity(identity, async (client) => {
      const r = await client.query<{ value: T }>(sql, [...params]);
      return r.rows[0]!.value;
    });
  }

  async function ownerRows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const r = await client.query<R>(sql, [...params]);
      return r.rows;
    });
  }

  const membership = async (collectionId: string): Promise<Array<{ dst_id: string; position: number }>> =>
    ownerRows<{ dst_id: string; position: number }>(
      `select dst_id, (props ->> 'position')::float8 as position
         from public.edges
        where src_id = $1 and type = 'contains'
        order by (props ->> 'position')::float8`,
      [collectionId],
    );

  beforeAll(async () => {
    database = await createW1ScratchDatabase('collection_membership');
    database.apply(migrationFiles());

    for (const identity of [OWNER, OUTSIDER]) {
      await ownerRows(
        `insert into public.user_profiles(identity_id, display_name) values ($1, $1)`,
        [identity],
      );
      await ownerRows(
        `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
         values ($1, $1, $1, false, $2)`,
        [identity, identity === OWNER],
      );
    }

    const created = await appValue<{ space: { id: string } }>(
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['collection membership space', 'collection-membership-space'],
    );
    spaceId = created.space.id;

    const a = await appValue<{ entity: { id: string } }>(
      `select public.create_collection(p_space_id => $1, p_name => $2, p_client_mutation_id => $3) value`,
      [spaceId, 'Collection A', 'cm-fixture-collection-a'],
    );
    collectionA = a.entity.id;
    const b = await appValue<{ entity: { id: string } }>(
      `select public.create_collection(p_space_id => $1, p_name => $2, p_client_mutation_id => $3) value`,
      [spaceId, 'Collection B', 'cm-fixture-collection-b'],
    );
    collectionB = b.entity.id;
    const t = await appValue<{ entity: { id: string } }>(
      `select public.create_task(p_space_id => $1, p_title => $2, p_client_mutation_id => $3) value`,
      [spaceId, 'Member task', 'cm-fixture-task'],
    );
    task = t.entity.id;
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('CONTROL: the harness binds a real identity and both RPCs exist', async () => {
    const bound = await asIdentity(OWNER, async (client) =>
      (await client.query<{ bound: string | null }>(`select internal.identity_id() bound`)).rows[0]!.bound,
    );
    expect(bound).toBe(OWNER);
    const fns = await ownerRows<{ proname: string }>(
      `select proname from pg_proc
        where proname in ('set_collection_item', 'remove_collection_item')
        order by proname`,
    );
    expect(fns.map((f) => f.proname)).toEqual(['remove_collection_item', 'set_collection_item']);
  });

  it('adds a member with an auto-appended position and upserts on re-add', async () => {
    const first = await appValue<{ edge?: unknown }>(
      `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
      [collectionA, task, 'cm-add-1'],
    );
    expect(first).toBeTruthy();

    let rows = await membership(collectionA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dst_id: task, position: 1 });

    // Re-add under a NEW cmid: the uniqueness makes it a re-position (max+1),
    // never a second row — this is "the same record the other side would have
    // created", enforced at the store.
    await appValue(
      `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
      [collectionA, task, 'cm-add-1-again'],
    );
    rows = await membership(collectionA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(2);
  });

  it('supports multi-membership, and removal from one collection leaves the other', async () => {
    await appValue(
      `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
      [collectionB, task, 'cm-add-2'],
    );
    expect((await membership(collectionA)).map((r) => r.dst_id)).toEqual([task]);
    expect((await membership(collectionB)).map((r) => r.dst_id)).toEqual([task]);

    await appValue(
      `select public.remove_collection_item($1, $2, p_client_mutation_id => $3) value`,
      [collectionA, task, 'cm-remove-1'],
    );
    expect(await membership(collectionA)).toHaveLength(0);
    // The durability half: the surviving membership is a committed edge row
    // read as the graph owner in a separate transaction — nothing about it
    // lives in server process state.
    expect((await membership(collectionB)).map((r) => r.dst_id)).toEqual([task]);
  });

  it('admits a same-cmid replay of a remove instead of raising on the missing edge', async () => {
    const replay = await appValue<{ patches?: unknown }>(
      `select public.remove_collection_item($1, $2, p_client_mutation_id => $3) value`,
      [collectionA, task, 'cm-remove-1'],
    );
    expect(replay).toBeTruthy();
    // Fresh cmid against the already-removed member is honestly not_found.
    await expect(
      appValue(
        `select public.remove_collection_item($1, $2, p_client_mutation_id => $3) value`,
        [collectionA, task, 'cm-remove-1-fresh'],
      ),
    ).rejects.toThrow(/not in this collection/);
  });

  it('refuses both doors to a non-member of the Space (forbidden)', async () => {
    await expect(
      appValue(
        `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
        [collectionB, task, 'cm-outsider-add'],
        OUTSIDER,
      ),
    ).rejects.toThrow(/not a member of this space/);
    await expect(
      appValue(
        `select public.remove_collection_item($1, $2, p_client_mutation_id => $3) value`,
        [collectionB, task, 'cm-outsider-remove'],
        OUTSIDER,
      ),
    ).rejects.toThrow(/not a member of this space/);
    // And the refusals changed nothing.
    expect((await membership(collectionB)).map((r) => r.dst_id)).toEqual([task]);
  });

  it('refuses to add to a non-collection source (the edge registry holds)', async () => {
    await expect(
      appValue(
        `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
        [task, collectionA, 'cm-wrong-kind'],
      ),
    ).rejects.toThrow();
  });

  it('refuses self-containment — a collection never lists itself', async () => {
    // `contains` is registered non-acyclic (nested collections are legal), so
    // `prevent_edge_cycle` never runs for it; without the RPC's own guard,
    // add(C, C) succeeded and C counted itself in its own itemCount.
    await expect(
      appValue(
        `select public.set_collection_item($1, $2, p_client_mutation_id => $3) value`,
        [collectionA, collectionA, 'cm-self-add'],
      ),
    ).rejects.toThrow(/cannot contain itself/);
  });

  it('the store refuses a non-numeric props.position — the position casts cannot be poisoned', async () => {
    // The exposure under review: `(props->>'position')::float8` runs bare in
    // both the auto-position max and the facade's items preview, and a
    // membership carrying `position: "top"` would 22P02 them (→ not_found —
    // a live collection answering 404). The 018 props-schema trigger is what
    // actually closes it: `contains` registers `position: number`, so the
    // poison cannot be WRITTEN — not even as the graph owner, not even by a
    // raw UPDATE that bypasses every RPC. This pin is what lets those casts
    // stay bare-ish; if the schema registration is ever dropped, this test
    // is the alarm (and the casts are additionally jsonb_typeof-guarded).
    await expect(
      ownerRows(
        `update public.edges set props = jsonb_build_object('position', 'top')
          where src_id = $1 and dst_id = $2 and type = 'contains'`,
        [collectionB, task],
      ),
    ).rejects.toThrow(/property position has the wrong type/);
  });

  it('revokes PUBLIC execute on both membership functions (definer hygiene)', async () => {
    // SECURITY DEFINER functions whose claims ride settable GUCs must not be
    // callable by arbitrary connectable roles. Postgres grants EXECUTE to
    // PUBLIC on new functions by default; migration 100 revokes it and grants
    // tm8_app alone, following the 007/018/020 convention.
    const rows = await ownerRows<{ proname: string; open_to_public: boolean }>(
      `select p.proname,
              coalesce(bool_or(a.grantee = 0), false) as open_to_public
         from pg_proc p
         left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
        where p.proname in ('set_collection_item', 'remove_collection_item')
        group by p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.open_to_public).toBe(false);
  });
});

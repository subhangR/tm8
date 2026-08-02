import type { CollectionQuery } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  olderId: string;
  newerId: string;
  commentedId: string;
  tieAId: string;
  tieBId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'docs-updated-owner'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "olderId", internal.new_id()::text "newerId",
              internal.new_id()::text "commentedId", internal.new_id()::text "tieAId",
              internal.new_id()::text "tieBId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Docs updated owner')`,
      [fixture.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Docs updated sort',$2)`,
      [fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1),
             ($3,$2,'doc',null,1,$1), ($4,$2,'doc',null,2,$1),
             ($5,$2,'doc',null,3,$1), ($6,$2,'doc',null,4,$1),
             ($7,$2,'doc',null,5,$1)`,
      [fixture.memberId, fixture.spaceId, fixture.olderId, fixture.newerId,
        fixture.commentedId, fixture.tieAId, fixture.tieBId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Docs updated owner')`,
      [fixture.memberId, fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.documents(entity_id,title,body)
       values($1,'Older','old'),($2,'Newer','new'),($3,'Commented','commented'),
             ($4,'Tie A','a'),($5,'Tie B','b')`,
      [fixture.olderId, fixture.newerId, fixture.commentedId, fixture.tieAId, fixture.tieBId],
    );
    await client.query(
      `update public.entities
          set created_at = case id
                when $1 then timestamptz '2026-01-01 00:00:00.000001+00'
                when $2 then timestamptz '2026-01-02 00:00:00.000001+00'
                else timestamptz '2025-12-01 00:00:00.000001+00' end,
              updated_at = case id
                when $1 then timestamptz '2026-01-03 00:00:00.000001+00'
                when $2 then timestamptz '2026-01-04 00:00:00.000001+00'
                when $3 then timestamptz '2026-01-02 12:00:00.000001+00'
                else timestamptz '2025-12-01 00:00:00.000001+00' end,
              activity_at = case id
                when $1 then timestamptz '2026-01-03 00:00:00.000001+00'
                when $2 then timestamptz '2026-01-04 00:00:00.000001+00'
                when $3 then timestamptz '2026-01-02 12:00:00.000001+00'
                else timestamptz '2025-12-01 00:00:00.000001+00' end
        where id = any($4::uuid[])`,
      [fixture.olderId, fixture.newerId, fixture.commentedId,
        [fixture.olderId, fixture.newerId, fixture.commentedId, fixture.tieAId, fixture.tieBId]],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  fixture: Fixture,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true), set_config('tm8.request_id','docs-updated-sort',true)`,
      [fixture.identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <TResult>(fnName: string, args: readonly unknown[] = []): Promise<TResult> => {
        const placeholders = args.map((_, index) => `$${index + 1}`).join(',');
        return (await client.query(`select public.${fnName}(${placeholders}) result`, [...args])).rows[0]?.result;
      },
    };
    return fn(q);
  });
}

describe.sequential('docs updatedAt collection ordering', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('docs_updated_sort');
    database.apply(migrationFiles());
    fixture = await seed(database);
  }, 180_000);

  afterAll(async () => database?.destroy(), 30_000);

  const query = (overrides: Partial<CollectionQuery> = {}): CollectionQuery => ({
    spaceId: fixture.spaceId, kinds: ['doc'], sort: 'updatedAt_desc', limit: 20, ...overrides,
  });

  it('orders docs by most recently updated first and puts a newly created doc first', async () => {
    const initial = await asApp(database, fixture, (q) => queryCollection(q, query(), fixture.identityId));
    expect(initial.page.items.slice(0, 3).map((item) => item.id))
      .toEqual([fixture.newerId, fixture.olderId, fixture.commentedId]);

    const createdId = (await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'doc',null,6,$3)`,
        [id, fixture.spaceId, fixture.memberId],
      );
      await client.query(`insert into public.documents(entity_id,title,body) values($1,'Just created','new')`, [id]);
      return id;
    }));
    const afterCreate = await asApp(database, fixture, (q) => queryCollection(q, query(), fixture.identityId));
    expect(afterCreate.page.items[0]!.id).toBe(createdId);
  });

  it('floats an edited older doc above a newer untouched doc', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.entities set version=version+1, activity_at=now(), updated_at=now() where id=$1`,
        [fixture.olderId],
      );
    });
    const result = await asApp(database, fixture, (q) => queryCollection(q, query(), fixture.identityId));
    expect(result.page.items.findIndex((item) => item.id === fixture.olderId))
      .toBeLessThan(result.page.items.findIndex((item) => item.id === fixture.newerId));
  });

  it('does not float a merely-commented doc by updatedAt, but does by activityAt', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const messageId = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'message',null,0,$3)`,
        [messageId, fixture.spaceId, fixture.memberId],
      );
      await client.query(
        `insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,'comment only')`,
        [messageId, fixture.commentedId, fixture.memberId],
      );
    });
    const modified = await asApp(database, fixture, (q) => queryCollection(q, query(), fixture.identityId));
    const activity = await asApp(database, fixture, (q) => queryCollection(
      q, query({ sort: 'activityAt_desc' }), fixture.identityId,
    ));
    expect(modified.page.items[0]!.id).not.toBe(fixture.commentedId);
    expect(activity.page.items[0]!.id).toBe(fixture.commentedId);
  });

  it('walks identical and adjacent microsecond timestamps across pages deterministically', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.entities set updated_at=timestamptz '2027-01-01 00:00:00.123456+00'
          where id=any($1::uuid[])`,
        [[fixture.tieAId, fixture.tieBId]],
      );
      await client.query(
        `update public.entities set updated_at=timestamptz '2027-01-01 00:00:00.123455+00' where id=$1`,
        [fixture.commentedId],
      );
    });
    const first = await asApp(database, fixture, (q) => queryCollection(q, query({ limit: 2 }), fixture.identityId));
    expect(first.page.nextCursor).toBeTruthy();
    const second = await asApp(database, fixture, (q) => queryCollection(
      q, query({ limit: 2, cursor: first.page.nextCursor! }), fixture.identityId,
    ));
    const ids = [...first.page.items, ...second.page.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 3)).toEqual([
      ...[fixture.tieAId, fixture.tieBId].sort().reverse(), fixture.commentedId,
    ]);
  });
});

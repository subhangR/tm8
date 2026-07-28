import { decodeCursor, getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { W2IdentitySpacesService } from '../../src/facade/services/w2/identity-spaces.js';
import { W2InboxReadMarksService } from '../../src/facade/services/w2/inbox-read-marks.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * W2 CURSOR PRECISION — the DESC sites, at the wire.
 *
 * WHY THE FIXTURE IS WRITTEN IN ONE TRANSACTION, and it is the whole design of
 * this file: rows written in a single transaction share an IDENTICAL `now()`,
 * because `now()` is transaction_timestamp. That is the ONLY condition under
 * which the defect is observable, and it is the condition batch writes produce
 * in production.
 *
 * A SEQUENTIAL FIXTURE CANNOT REPRODUCE IT AND WILL REPORT GREEN ON A BROKEN
 * SITE. That is not hypothetical — it happened twice in this program. A
 * forward-progress walk over six awards written by six separate requests
 * returned 6 of 6, zero duplicates, zero missing, on a site that had just been
 * PROVEN to truncate, because no two rows shared a millisecond so nothing ever
 * fell in the dropped window. On collections.query the two assertions
 * disagreed on the SAME row: exactly-once passed while precision failed.
 *
 * HENCE THE ORDERING BELOW, which is deliberate and inverted from the obvious:
 *
 *   1. NON-VACUOUSNESS FIRST. Assert the fixture actually produced rows sharing
 *      a sub-millisecond window. A row landing on an exact millisecond lets a
 *      TRUNCATED cursor compare equal, so every assertion after it would pass
 *      while proving nothing.
 *   2. MECHANISM. The carried cursor value, cast back, is the IDENTICAL INSTANT
 *      as the stored column. Asserted as instants IN THE DATABASE, not as
 *      strings in JavaScript — a digit-count assertion breaks on the `::text`
 *      spelling roughly one row in ten, because Postgres strips the trailing
 *      zero. This cannot be satisfied by a `Date` round-trip.
 *   3. SYMPTOM. Exactly-once and terminates.
 *
 * Mechanism outranks symptom because symptom can be bought by fixture luck and
 * mechanism cannot.
 *
 * Both sites here are DESC keysets, where truncation does NOT loop — it
 * SILENTLY SKIPS every row sharing the lost millisecond. There is no error, no
 * duplicate, and no signal of any kind; the rows simply never arrive.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  awardIds: string[];
  notificationIds: string[];
}

const ROW_COUNT = 6;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{ identityId: string; spaceId: string; memberId: string }>(
      `select 'cursorprec-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Cursor owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Cursor Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Cursor owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );

    // THE COLLIDING WRITES. One statement, one transaction — so every row takes
    // the SAME now() and they are indistinguishable at millisecond resolution.
    // This is what a batch write looks like, and what a per-row fixture cannot
    // produce.
    const awards = await client.query<{ id: string }>(
      `insert into public.point_events(space_id,entity_id,actor_id,amount,reason)
       select $1,$2,$2,generate_series,'award' from generate_series(1,${ROW_COUNT})
       returning id::text id`,
      [base.spaceId, base.memberId],
    );
    const notifications = await client.query<{ id: string }>(
      `insert into public.notifications(space_id,recipient_member_id,actor_id,kind,payload)
       select $1,$2,$2,'mention',jsonb_build_object('n',generate_series)
         from generate_series(1,${ROW_COUNT})
       returning id::text id`,
      [base.spaceId, base.memberId],
    );
    return {
      ...base,
      awardIds: awards.rows.map((row) => row.id),
      notificationIds: notifications.rows.map((row) => row.id),
    };
  });
}

function ctxFor(
  opName: OperationName,
  identityId: string,
  options: { params?: Record<string, string>; query?: string } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query ?? ''),
    body: undefined,
    requestId: `req-${opName}`,
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe.sequential('W2 cursor precision at the wire (DESC sites)', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let spaces: W2IdentitySpacesService;
  let inbox: W2InboxReadMarksService;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_cursor_prec');
    database.apply(migrationFiles());
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    const deps = {
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000555',
        username: 'cursorprec-owner', isNodeAdmin: false, isOwner: true,
      }),
    };
    spaces = new W2IdentitySpacesService(deps);
    inbox = new W2InboxReadMarksService(deps);
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  });

  // -------------------------------------------------------------------------
  // 1. NON-VACUOUSNESS — asserted FIRST, because everything below is worthless
  //    without it.
  // -------------------------------------------------------------------------

  it('GUARD: the fixture produced rows sharing a sub-millisecond window', async () => {
    for (const [table, column] of [
      ['public.point_events', 'space_id'],
      ['public.notifications', 'space_id'],
    ] as const) {
      const rows = await database.query<{ total: number; distinctMs: number; subMs: number }>(
        `select count(*)::integer total,
                count(distinct date_trunc('milliseconds', created_at))::integer "distinctMs",
                count(*) filter (where (extract(microseconds from created_at)::bigint % 1000) <> 0)::integer "subMs"
           from ${table} where ${column} = $1`,
        [fixture.spaceId],
      );
      const row = rows[0]!;
      expect(row.total, `${table}: fixture built nothing`).toBe(ROW_COUNT);
      // The collision. If every row had its own millisecond, a truncated cursor
      // would never drop one and the cases below would pass on a broken site.
      expect(row.distinctMs, `${table}: rows do NOT share a millisecond — the defect is unobservable here`)
        .toBeLessThan(ROW_COUNT);
      expect(row.subMs, `${table}: no sub-millisecond component — truncation would be a no-op`)
        .toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // 2. MECHANISM — cannot be bought by fixture luck.
  // -------------------------------------------------------------------------

  it('MECHANISM: spaces.awards carries the stored instant verbatim [G01]', async () => {
    const page = await spaces.spacesAwards(
      ctxFor('spaces.awards', fixture.identityId, { params: { spaceId: fixture.spaceId }, query: 'limit=1' }),
    ) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page.nextCursor).toBeTruthy();
    const carried = String(decodeCursor(page.nextCursor!).k[0]);

    // Compared as INSTANTS in the database, never as strings in JavaScript.
    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same from public.point_events where id = $2`,
      [carried, page.items[0]!.id],
    );
    expect(check[0]!.same, 'awards cursor is not the stored instant — precision lost').toBe(true);
  });

  it('MECHANISM: inbox.list carries the stored instant verbatim [G08]', async () => {
    const page = await inbox.list(
      ctxFor('inbox.list', fixture.identityId, { query: 'limit=1' }),
    ) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page.nextCursor).toBeTruthy();
    const carried = String(decodeCursor(page.nextCursor!).k[1]);

    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same from public.notifications where id = $2`,
      [carried, page.items[0]!.id],
    );
    expect(check[0]!.same, 'inbox cursor is not the stored instant — precision lost').toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. SYMPTOM — exactly-once and terminates. Meaningful only because the guard
  //    above proved the rows actually collide.
  // -------------------------------------------------------------------------

  async function walk(
    page: (cursor: string | null) => Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>,
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await page(cursor);
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
      pages += 1;
    } while (cursor && pages < ROW_COUNT * 3);
    expect(cursor, `walk did not terminate within ${ROW_COUNT * 3} pages`).toBeNull();
    return seen;
  }

  it('SYMPTOM: spaces.awards returns every award exactly once and terminates [G01]', async () => {
    const seen = await walk((cursor) => spaces.spacesAwards(ctxFor(
      'spaces.awards', fixture.identityId,
      { params: { spaceId: fixture.spaceId }, query: `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` },
    )) as Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>);
    expect(new Set(seen).size, 'an award was returned more than once').toBe(seen.length);
    expect([...seen].sort(), 'awards were SILENTLY SKIPPED — the DESC failure mode')
      .toEqual([...fixture.awardIds].sort());
  });

  it('SYMPTOM: inbox.list returns every notification exactly once and terminates [G08]', async () => {
    const seen = await walk((cursor) => inbox.list(ctxFor(
      'inbox.list', fixture.identityId,
      { query: `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` },
    )) as Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>);
    expect(new Set(seen).size, 'a notification was returned more than once').toBe(seen.length);
    expect([...seen].sort(), 'notifications were SILENTLY SKIPPED — the DESC failure mode')
      .toEqual([...fixture.notificationIds].sort());
  });
});

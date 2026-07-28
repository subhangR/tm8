import { decodeCursor } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbClaims } from '../../../src/db/types.js';
import { PgDb } from '../../../src/db/client.js';
import { loadActivity } from '../../../src/facade/handlers/activity.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../../db/w1-pg.js';

/**
 * W5 DUO B — `loadActivity`'s CURSOR, OBSERVED DIRECTLY AND ROUND-TRIPPED.
 *
 * WHY THIS EXISTS SEPARATELY FROM `home-activity-cursor.pg.test.ts`.
 * That file observes the truncation THROUGH `spaces.home`, and its honesty
 * assertion returns early when `nextCursor` is null — so a fix that WITHDRAWS
 * the cursor makes it assert nothing and go green while `activity.ts:80` still
 * truncates. A detector going quiet at precisely the transition it exists to
 * observe. I recorded that weakness against my own witness BEFORE the fix rather
 * than discovering it after; this file is the answer to it.
 *
 *   option 1 (MICROS the mint)   -> this goes GREEN.  TRUNCATION ACTUALLY FIXED.
 *   option 2 alone (null cursor) -> this STAYS RED.   WITHDRAWN, NOT FIXED.
 *
 * AND IT COVERS THE HALF A MINT-ONLY CHECK CANNOT — THE DECODE SIDE.
 * `activity.ts:46-51` pushes `String(k[0])` straight into a `$::timestamptz`
 * with NO `Date.parse` refusal, where `inbox-read-marks.ts:173` and
 * `identity-spaces.ts:527-529` both have one. That decode-side check is the ONLY
 * reason B1 surfaced as a loud 400 instead of silently — `activity.ts` is a
 * SILENT PRODUCER WITH NO LUCKY CONSUMER. So this walks page 1 -> page 2 and
 * requires page 2 to begin exactly where page 1 ended: the whole loop, not the
 * mint alone.
 *
 * ⚠ WHAT THIS FILE DOES NOT CLAIM. `loadActivity` is reached only by
 * `spaces.home`, which calls it WITHOUT a cursor, and no catalog operation
 * accepts the 2-part cursor it mints (`entities.activity` demands a 3-part
 * fingerprinted keyset and is served elsewhere). SO THE ROW LOSS DEMONSTRATED
 * HERE IS NOT REACHABLE THROUGH ANY v1 OPERATION TODAY. It is LATENT, and a
 * loaded gun: `handlers/commands.ts:127` `entitiesActivity` is already written,
 * exported and merely unregistered. One registry line makes it live, and the
 * truncation is already proven present with no warning period.
 * DO NOT RESTATE THIS AS LIVE DATA LOSS.
 *
 * WHAT THE ROUND TRIP CAN BE SATISFIED BY: a page 2 whose first row is the row
 * immediately following page 1's last, under the same DESC ordering. It is NOT
 * satisfied by a page 2 that drops rows sharing the truncated millisecond.
 */

vi.setConfig({ testTimeout: 120_000 });

interface Fixture { identityId: string; spaceId: string; memberId: string }

const ACTIVITY_ROWS = 9;
const PAGE_LIMIT = 3;

/**
 * FROZEN literal with a non-zero sub-millisecond component, incremented one
 * microsecond per row: `.891823 .. .891831`. Every row therefore has
 * microseconds `iso()` must destroy, AND every row shares the millisecond `.891`
 * while remaining distinct — the batch-write collision that is the ONLY
 * condition under which a truncated DESC cursor actually drops rows.
 * `default now()` cannot be used: it is one shared value for the whole
 * transaction, and ~1 run in 1000 it lands on an exact millisecond, which makes
 * every assertion below vacuous while the defect is fully present.
 */
const BASE_TS = '2026-07-25T14:59:01.891823Z';

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<Fixture>(
      `select 'w5-act-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'W5 activity owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'W5 Activity Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','W5 activity owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.activity(space_id,entity_id,actor_id,verb,summary,created_at)
       select $1,$2,$2,'created',jsonb_build_object('n',g),
              $3::timestamptz + (g - 1) * interval '1 microsecond'
         from generate_series(1,${ACTIVITY_ROWS}) g`,
      [base.spaceId, base.memberId, BASE_TS],
    );
    return base;
  });
}

interface ActivityPage { items: Array<{ id: string }>; nextCursor: string | null }

describe.sequential('W5 Duo B — loadActivity cursor round trip', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let claims: DbClaims;
  let appliedMigrations: string[];

  const page = (cursor?: string): Promise<ActivityPage> =>
    facadeDb.tx(claims, (q) => loadActivity(q, {
      spaceId: fixture.spaceId,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })) as Promise<ActivityPage>;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5_activity_rt');
    appliedMigrations = migrationFiles();
    database.apply(appliedMigrations);
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    claims = { identityId: fixture.identityId, nodeAdmin: false, requestId: 'req-w5-activity-rt' };
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
    // afterAll is configured INDEPENDENTLY of beforeAll; an overrun here is an
    // UNNAMED file-level abort, which no expected-failure set can match.
  }, 120_000);

  // -------------------------------------------------------------------------
  // NON-VACUOUSNESS FIRST. Every assertion below is free without this.
  // -------------------------------------------------------------------------

  it('applies the FULL migration chain from migrationFiles(), not a slice', () => {
    // `>=` deliberately, NOT an exact literal: this asserts "the fixture used
    // migrationFiles() rather than a hand-listed slice", which must survive a
    // legitimate landing. An exact count here would be a detector for the wrong
    // property and would red on every migration that lands.
    expect(appliedMigrations.length).toBeGreaterThanOrEqual(34);
    expect(appliedMigrations.every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  it('the fixture carries microseconds AND collides at millisecond resolution', async () => {
    const rows = await database.query<{ submilli: string; distinct_ms: string; distinct_us: string }>(
      `select count(*) filter (where (extract(microseconds from created_at)::bigint % 1000) <> 0)::text submilli,
              count(distinct date_trunc('milliseconds', created_at))::text distinct_ms,
              count(distinct created_at)::text distinct_us
         from public.activity where space_id = $1`,
      [fixture.spaceId],
    );
    const r = rows[0]!;
    // A row on an exact millisecond lets a TRUNCATED cursor compare EQUAL, which
    // would make the mechanism assertions pass while proving nothing.
    expect(Number(r.submilli)).toBe(ACTIVITY_ROWS);
    // Distinct at microsecond resolution...
    expect(Number(r.distinct_us)).toBe(ACTIVITY_ROWS);
    // ...but COLLIDING at millisecond resolution. Without this the truncated
    // cursor lands in a gap and skips nothing — the fixture luck that let
    // `collections.query` walk 6/6 exactly-once over a provably truncated cursor.
    expect(Number(r.distinct_ms)).toBeLessThan(Number(r.distinct_us));
  });

  // -------------------------------------------------------------------------
  // MECHANISM — primary.
  // -------------------------------------------------------------------------

  it('the minted cursor is the stored instant, not a millisecond-truncated copy', async () => {
    const first = await page();
    expect(first.items).toHaveLength(PAGE_LIMIT);
    expect(first.nextCursor).not.toBeNull();

    const keyset = decodeCursor(first.nextCursor!).k;
    const carried = keyset.map(String).find((v) => !Number.isNaN(Date.parse(v)));
    expect(carried).toBeDefined();

    // Compared as INSTANTS IN THE DATABASE, never as strings: `::text` drops a
    // trailing zero about one row in ten, and two renderings of one instant in
    // different offsets are equal but not identical as text. A correct fix in
    // ANY timezone spelling passes; no format lock.
    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same from public.activity where id = $2`,
      [carried!, first.items.at(-1)!.id],
    );
    expect(check[0]!.same).toBe(true);
  });

  // -------------------------------------------------------------------------
  // THE ROUND TRIP — the half a mint-only check cannot see.
  // -------------------------------------------------------------------------

  it('page 2 begins exactly where page 1 ended, losing no row to the boundary', async () => {
    const expected = (await database.query<{ id: string }>(
      `select id::text id from public.activity where space_id = $1
        order by created_at desc, id desc`,
      [fixture.spaceId],
    )).map((r) => r.id);
    expect(expected).toHaveLength(ACTIVITY_ROWS);

    const first = await page();
    expect(first.items.map((i) => i.id)).toEqual(expected.slice(0, PAGE_LIMIT));
    expect(first.nextCursor).not.toBeNull();

    const second = await page(first.nextCursor!);

    // With the cursor truncated DOWN to `.891`, EVERY remaining row is strictly
    // GREATER than the cursor value, so the DESC `<` keyset admits none of them
    // and page 2 comes back EMPTY — six rows lost with no error and no loop.
    // Asserted as non-empty first so the failure names the cause rather than
    // dying on an undefined index.
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items[0]!.id).toBe(expected[PAGE_LIMIT]);
  });
});

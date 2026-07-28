import { decodeCursor, getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../../src/db/client.js';
import { spacesHome } from '../../../src/facade/handlers/spaces.js';
import type { RequestContext } from '../../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../../db/w1-pg.js';

/**
 * W5 DUO B — `spaces.home` MINTS AN ACTIVITY CURSOR NO OPERATION ACCEPTS.
 *
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT.
 * It is NOT a claim that rows are being lost today. I checked consumability
 * before writing it and the truncation here is not reachable as data loss:
 *
 *   handlers/activity.ts is a genuine `iso()` cursor — `:55` selects raw
 *   `a.created_at` with no MICROS, `:58` orders DESC, `:50` is a strict `<`
 *   keyset, and `:80` mints `encodeCursor([iso(last.created_at), last.id])`.
 *   Rounded DOWN plus DESC `<` is the silent-skip shape exactly.
 *
 *   BUT its only live reachability is `spaces.ts:291`, inside `spaces.home`,
 *   which calls it WITHOUT a cursor. The one operation that pages activity —
 *   `entities.activity` — is served by `services/w2/entities-commands-tracking.ts`
 *   (registered at `handlers/w2/entities-commands-tracking.ts:28`), uses MICROS,
 *   and demands a THREE-part fingerprinted keyset. It would reject the TWO-part
 *   cursor minted here. So nothing consumes it and nothing skips.
 *
 * ⚠ THE TRAP THAT COST BOTH SEATS OF THIS DUO REAL TIME, RECORDED SO THE NEXT
 * READER DOES NOT PAY IT AGAIN: `handlers/commands.ts:126` carries the doc
 * comment `/** entities.activity — ... *​/` directly above `entitiesActivity`,
 * which reads a cursor (`:132`) and forwards it (`:138`) into the DEFECTIVE
 * `loadActivity`. A grep for "entities.activity" lands there. That function is
 * EXPORTED AND NEVER REGISTERED. Trace the registry, not the comment.
 *
 * SO THE HONEST ASSERTION, AND THE ONLY ONE THIS FILE MAKES: a `nextCursor` on
 * a v1 read surface must be either ABSENT or USABLE. `spaces.home` currently
 * advertises "there is more, here is your handle" and hands over a handle no
 * operation in the catalog will take.
 *
 * WHAT THIS CHECK CAN BE SATISFIED BY: `activity.nextCursor === null`, OR a
 * cursor whose keyset is the 3-part fingerprinted shape `entities.activity`
 * accepts. It is NOT satisfied by the current 2-part `[iso(created_at), id]`.
 * It makes NO claim about row loss and must not be restated as one.
 *
 * IT IS ALSO A LOADED GUN, which is why it is worth pinning now rather than
 * filing as prose: `entitiesActivity` is already written and exported. One line
 * in a registry converts this latent site into the live silent-skip defect.
 */

/**
 * `testTimeout` and `hookTimeout` are INDEPENDENT vitest defaults — 5s and 10s —
 * and a per-hook argument covers NEITHER of the per-TEST ones. The two failing
 * tests here are members of the coordinator's expected-failure set; if either
 * instead died on a 5s `testTimeout`, its diagnostic would change from an
 * assertion to `Test timed out in 5000ms` and the set member would be lost
 * while a same-named failure appeared for an unrelated reason.
 */
vi.setConfig({ testTimeout: 120_000 });

interface Fixture { identityId: string; spaceId: string; memberId: string }

/** `spaces.ts:291` calls loadActivity with limit 20, so >20 rows makes hasMore true. */
const ACTIVITY_ROWS = 25;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<Fixture>(
      `select 'w5-home-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'W5 home owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'W5 Home Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','W5 home owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );

    // EXPLICIT timestamps, not `default now()`. Two defects were fixed here and
    // both came from letting the clock choose:
    //
    //  1. now() is transaction_timestamp, so every row took ONE IDENTICAL value.
    //     Roughly 1 run in 1000 that value lands on an exact millisecond, iso()
    //     then loses NOTHING, and the mechanism assertion below passes while the
    //     defect is fully present. (Found by Duo B's developer.)
    //  2. WORSE, and mine: with every row identical, `distinct_ms < total` was
    //     1 < 25 — ALWAYS TRUE, incapable of failing. I copied that assertion's
    //     SHAPE from the W2 precision fixture without copying its PREMISE. There
    //     the rows collide within a millisecond while DIFFERING; here they were
    //     simply the same row 25 times, so the guard guarded nothing.
    //
    // The base value is a FROZEN LITERAL with a non-zero sub-millisecond
    // component, incremented ONE MICROSECOND per row: .891823 .. .891847. Every
    // row therefore (a) has microseconds iso() must destroy, and (b) shares the
    // millisecond .891 with all the others while remaining distinct — which is
    // the batch-write collision this defect class actually needs, and the premise
    // `distinct_ms < total` was written for. Deterministic: no run-to-run luck.
    await client.query(
      `insert into public.activity(space_id,entity_id,actor_id,verb,summary,created_at)
       select $1,$2,$2,'created',jsonb_build_object('n',g),
              timestamptz '2026-07-25T14:59:01.891823Z' + (g - 1) * interval '1 microsecond'
         from generate_series(1,${ACTIVITY_ROWS}) g`,
      [base.spaceId, base.memberId],
    );
    return base;
  });
}

function ctxFor(opName: OperationName, identityId: string, params: Record<string, string>): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName, params,
    query: new URLSearchParams(''),
    body: undefined,
    requestId: `req-${opName}`,
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

interface HomeSnapshot { activity: { items: unknown[]; nextCursor: string | null } }

describe.sequential('W5 Duo B — spaces.home activity cursor honesty', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let home: HomeSnapshot;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5_home_activity');
    database.apply(migrationFiles());
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    const handler = spacesHome({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000888',
        username: 'w5-home-owner',
        isNodeAdmin: false,
        isOwner: true,
      }),
    });
    home = await handler(
      ctxFor('spaces.home', fixture.identityId, { spaceId: fixture.spaceId }),
    ) as HomeSnapshot;
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
    // 120s, not the 10s vitest default and not the 30s this once carried.
    // `afterAll` is configured INDEPENDENTLY of `beforeAll` — a generous
    // beforeAll does not cover teardown. This teardown is four pool-lifecycle
    // round trips followed by a database drop, and `w1-pg.ts:114` drops WITHOUT
    // `with (force)`, so a lingering connection makes it ERROR rather than wait.
    // Either way the result is a FILE-LEVEL abort carrying no test name, which
    // is unmatched by any expected-failure set and is load-sensitive — invisible
    // idle, firing exactly inside a gate where load peaks.
  }, 120_000);

  // -------------------------------------------------------------------------
  // NON-VACUOUSNESS FIRST. Every assertion below is free if home returned a
  // short page, and free again if no two rows share a millisecond.
  // -------------------------------------------------------------------------

  it('seeded past the home activity limit, so a cursor is actually minted', () => {
    expect(home.activity.items).toHaveLength(20);
    expect(ACTIVITY_ROWS).toBeGreaterThan(20);
  });

  it('the fixture actually produced sub-millisecond collisions', async () => {
    const rows = await database.query<{ submilli: string; distinct_ms: string; total: string }>(
      `select count(*) filter (where (extract(microseconds from created_at)::bigint % 1000) <> 0)::text submilli,
              count(distinct date_trunc('milliseconds', created_at))::text distinct_ms,
              count(*)::text total
         from public.activity where space_id = $1`,
      [fixture.spaceId],
    );
    // A row landing on an exact millisecond lets a TRUNCATED cursor compare
    // EQUAL, which would make a precision check vacuous.
    expect(Number(rows[0]!.submilli)).toBeGreaterThan(0);
    expect(Number(rows[0]!.distinct_ms)).toBeLessThan(Number(rows[0]!.total));
  });

  // -------------------------------------------------------------------------
  // THE FINDING — honesty of the advertised handle.
  // -------------------------------------------------------------------------

  it('home advertises an activity nextCursor that is either absent or usable', () => {
    if (home.activity.nextCursor === null) return; // absent is honest

    // Usable means: the shape `entities.activity` accepts — [fingerprint, micros, id].
    // The current mint is [iso(created_at), id]: two slots, no fingerprint.
    const keyset = decodeCursor(home.activity.nextCursor).k;
    expect(keyset).toHaveLength(3);
  });

  it('the minted activity cursor, if present, carries microsecond precision', async () => {
    if (home.activity.nextCursor === null) return;
    const keyset = decodeCursor(home.activity.nextCursor).k;

    // Slot 0 on the CURRENT mint is the timestamp; on the shape we want it is
    // the fingerprint. Take whichever slot parses as an instant so this check
    // survives a fix that reshapes the keyset.
    const candidate = keyset.map(String).find((v) => !Number.isNaN(Date.parse(v)));
    expect(candidate).toBeDefined();

    // Instant equality IN THE DATABASE against the 20th row — never a string
    // compare, so a correct fix in any timezone spelling passes.
    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same from (
         select created_at from public.activity where space_id = $2
          order by created_at desc, id desc offset 19 limit 1) t`,
      [candidate!, fixture.spaceId],
    );
    expect(check[0]!.same).toBe(true);
  });
});

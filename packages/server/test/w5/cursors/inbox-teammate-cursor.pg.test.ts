import { decodeCursor, getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../../src/db/client.js';
import { W2InboxReadMarksService } from '../../../src/facade/services/w2/inbox-read-marks.js';
import type { RequestContext } from '../../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../../db/w1-pg.js';

/**
 * W5 DUO B — `inbox.list`, THE TEAMMATE-INSPECTION BRANCH.
 *
 * WHAT IS NEW HERE, AND WHY THE EXISTING COVERAGE DOES NOT REACH IT.
 * `test/db/w2-cursor-precision.pg.test.ts` proves `inbox.list` carries a
 * microsecond-exact cursor. It exercises the MEMBER branch only — the recipient
 * is a Member, so `list` takes `directInboxSql`, which formats its cursor with
 * `MICROS` (`inbox-read-marks.ts:243`) and is correct.
 *
 * `list` has a SECOND query path. At `inbox-read-marks.ts:349` an owner
 * INSPECTING A TEAMMATE'S inbox (recipient.type === 'team_member', and NOT
 * acting as that teammate) is served by `queryInbox`, which calls the RPC
 * `public.inspect_owned_teammate_inbox` (`:258-272`). That SELECT list has NO
 * `cursor_created_at` column at all.
 *
 * `page()` at `:420` then encodes `last.cursor_created_at` unconditionally.
 *
 * THIS IS NOT THE MICROSECOND CLASS. It is the same FAMILY — a cursor field an
 * invariant says is present and the wire says is not — but the failure is total
 * rather than sub-millisecond, so the fixture does NOT need colliding writes to
 * expose it. That is stated because it is the reason this file's fixture is
 * allowed to be sequential where the W2 file's may not be.
 *
 * `NotificationRow.cursor_created_at` is declared `string`, NON-optional
 * (`:49`). The compiler cannot see inside a SQL string literal, so the RPC
 * branch's `q.query<NotificationRow>` is an UNCHECKED CAST and the declared
 * invariant is not enforced anywhere. Recorded because W4's proposed remedy for
 * this class was "make the cursor column required in the row types so a future
 * producer that omits it fails to compile" — that remedy WOULD NOT HAVE CAUGHT
 * THIS SITE, and the type is already required today.
 *
 * WHAT THIS FILE'S CENTRAL CHECK CAN BE SATISFIED BY: any `nextCursor` whose
 * keyset slot 1 is a non-null string that Postgres accepts as a `timestamptz`
 * equal to the stored `created_at`. It is NOT satisfied by a `null` slot, and
 * it is NOT satisfied by a value that merely parses in JavaScript.
 *
 * MIGRATIONS: the full chain from `migrationFiles()` — every file matching
 * `NNN_name.sql` in `db/migrations`, never a hand-listed slice. Measured at
 * authoring time as 34 files / a799b7ef1b20a9b0.
 */

/**
 * `testTimeout` and `hookTimeout` are INDEPENDENT vitest defaults — 5s and 10s —
 * and a per-hook argument covers NEITHER of the per-TEST ones. The walk below
 * makes up to 20 sequential `inbox.list` round trips against a real database;
 * on a host measured at 2.7x-6x oversubscribed that is the one test here that
 * could plausibly cross 5s.
 *
 * WHY THAT MATTERS MORE THAN A HOOK TIMEOUT: a hook overrun aborts the file and
 * yields NO test name, which is loud. A `testTimeout` overrun yields a NAMED
 * failure, which a subset-of-expected-names check matches, finds absent, and
 * classifies as a REAL REGRESSION. This file is expected GREEN, so a named
 * timeout here would read as damage from a landing it has nothing to do with.
 */
vi.setConfig({ testTimeout: 120_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  teammateNotificationIds: string[];
  memberNotificationIds: string[];
}

/** Enough rows that a limit of 2 leaves a second page, so `hasMore` is true. */
const ROW_COUNT = 6;
const PAGE_LIMIT = 2;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{
      identityId: string; spaceId: string; memberId: string; teammateId: string;
    }>(
      `select 'w5-inbox-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "teammateId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'W5 inbox owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'W5 Inbox Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','W5 inbox owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );

    // The teammate the owner will INSPECT. `owner_member_id` is what makes the
    // owner authorized for the RPC branch at inbox-read-marks.ts:349.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'team_member',null,1,$3)`,
      [base.teammateId, base.spaceId, base.memberId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role)
       values($1,$2,'W5 Teammate','tester')`,
      [base.teammateId, base.memberId],
    );

    // Notifications addressed to the TEAMMATE — the rows the RPC branch reads.
    const teammateRows = await client.query<{ id: string }>(
      `insert into public.notifications(space_id,recipient_member_id,recipient_team_member_id,actor_id,kind,payload)
       select $1,$2,$3,$2,'mention',jsonb_build_object('n',generate_series)
         from generate_series(1,${ROW_COUNT})
       returning id::text id`,
      [base.spaceId, base.memberId, base.teammateId],
    );

    // Control rows addressed to the MEMBER — these drive the known-good half
    // through `directInboxSql`, the branch that formats with MICROS.
    const memberRows = await client.query<{ id: string }>(
      `insert into public.notifications(space_id,recipient_member_id,actor_id,kind,payload)
       select $1,$2,$2,'mention',jsonb_build_object('m',generate_series)
         from generate_series(1,${ROW_COUNT})
       returning id::text id`,
      [base.spaceId, base.memberId],
    );

    return {
      identityId: base.identityId,
      spaceId: base.spaceId,
      memberId: base.memberId,
      teammateId: base.teammateId,
      teammateNotificationIds: teammateRows.rows.map((r) => r.id),
      memberNotificationIds: memberRows.rows.map((r) => r.id),
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

interface WirePage { items: Array<{ id: string }>; nextCursor: string | null }

/**
 * `normalizeListQuery` REJECTS unknown query keys (`inbox-read-marks.ts:103`),
 * and the recipient arrives as one JSON-encoded discriminated object under the
 * key `recipient` (`:107-114`) — not as flat id parameters. Built here once so
 * a misspelling cannot silently fall through to the member branch and green.
 */
function recipientParam(recipient:
  | { type: 'member'; memberId: string }
  | { type: 'team_member'; teamMemberId: string }): string {
  return `recipient=${encodeURIComponent(JSON.stringify(recipient))}`;
}

describe.sequential('W5 Duo B — inbox.list teammate-inspection cursor', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let inbox: W2InboxReadMarksService;
  let fixture: Fixture;
  let appliedMigrations: string[];

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5_inbox_teammate');
    appliedMigrations = migrationFiles();
    database.apply(appliedMigrations);
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    inbox = new W2InboxReadMarksService({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000777',
        username: 'w5-inbox-owner',
        isNodeAdmin: false,
        isOwner: true,
      }),
    });
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
  // 0. THE FIXTURE ITSELF — a vacuous fixture makes every assertion below free.
  // -------------------------------------------------------------------------

  it('applies the FULL migration chain from migrationFiles(), not a slice', () => {
    expect(appliedMigrations.length).toBeGreaterThanOrEqual(34);
    expect(appliedMigrations.every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
    // 023 is the migration that defines inspect_owned_teammate_inbox; if a
    // future slice dropped it, this file would be testing a function that the
    // scratch database does not have.
    expect(appliedMigrations).toContain('023_w2_inbox.sql');
  });

  it('seeded enough teammate rows that a page boundary exists', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.notifications
        where recipient_team_member_id = $1`,
      [fixture.teammateId],
    );
    expect(Number(rows[0]!.n)).toBe(ROW_COUNT);
    expect(ROW_COUNT).toBeGreaterThan(PAGE_LIMIT);
  });

  // -------------------------------------------------------------------------
  // 1. GREEN ON KNOWN-GOOD — the MEMBER branch, which uses MICROS.
  //    Without this half the check below would be indistinguishable from a
  //    detector that simply fires on every inbox.list call.
  // -------------------------------------------------------------------------

  it('KNOWN-GOOD: the member branch carries a non-null instant equal to the stored column', async () => {
    const page = await inbox.list(ctxFor('inbox.list', fixture.identityId, {
      query: `limit=${PAGE_LIMIT}&${recipientParam({ type: 'member', memberId: fixture.memberId })}`,
    })) as WirePage;

    expect(page.nextCursor).not.toBeNull();
    const carried = decodeCursor(page.nextCursor!).k[1];
    expect(carried).not.toBeNull();

    // Instant equality IN THE DATABASE, never a string compare: `::text` drops a
    // trailing zero on roughly one row in ten, and two spellings of the same
    // instant in different offsets are equal but not identical as text.
    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same
         from public.notifications where id = $2`,
      [String(carried), page.items.at(-1)!.id],
    );
    expect(check[0]!.same).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. THE FINDING — the teammate-inspection branch.
  // -------------------------------------------------------------------------

  it('the teammate-inspection branch emits a cursor whose timestamp slot is present', async () => {
    const page = await inbox.list(ctxFor('inbox.list', fixture.identityId, {
      query: `limit=${PAGE_LIMIT}&${recipientParam({ type: 'team_member', teamMemberId: fixture.teammateId })}`,
    })) as WirePage;

    // Precondition: there IS a further page, so a cursor is meaningful.
    expect(page.items).toHaveLength(PAGE_LIMIT);
    expect(page.nextCursor).not.toBeNull();

    const keyset = decodeCursor(page.nextCursor!).k;
    expect(keyset).toHaveLength(3);

    // THE MECHANISM ASSERTION. `undefined` in the keyset array serialises to
    // JSON `null` — measured, not assumed:
    //   JSON.stringify({v:2,k:['fp',undefined,'id']}) === '{"v":2,"k":["fp",null,"id"]}'
    // so a missing `cursor_created_at` reaches the wire as a null slot.
    expect(keyset[1]).not.toBeNull();

    const check = await database.query<{ same: boolean }>(
      `select $1::timestamptz = created_at same
         from public.notifications where id = $2`,
      [String(keyset[1]), page.items.at(-1)!.id],
    );
    expect(check[0]!.same).toBe(true);
  });

  it('the cursor the teammate branch emits is accepted by the server that emitted it', async () => {
    // The consequence assertion, kept SEPARATE from the mechanism one so that a
    // fix which changes the failure mode cannot quietly green this file.
    const first = await inbox.list(ctxFor('inbox.list', fixture.identityId, {
      query: `limit=${PAGE_LIMIT}&${recipientParam({ type: 'team_member', teamMemberId: fixture.teammateId })}`,
    })) as WirePage;
    expect(first.nextCursor).not.toBeNull();

    const second = await inbox.list(ctxFor('inbox.list', fixture.identityId, {
      query: `limit=${PAGE_LIMIT}&${recipientParam({ type: 'team_member', teamMemberId: fixture.teammateId })}`
        + `&cursor=${encodeURIComponent(first.nextCursor!)}`,
    })) as WirePage;

    // Forward progress: page 2 must not re-serve page 1.
    const firstIds = first.items.map((i) => i.id);
    for (const item of second.items) expect(firstIds).not.toContain(item.id);
  });

  it('walks the teammate inbox exactly once, end to end', async () => {
    // SYMPTOM assertion, recorded as SECONDARY. Stated plainly: on a sequential
    // fixture this can pass over a truncated cursor, so it is evidence only in
    // combination with the mechanism check above — never on its own.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const query = `limit=${PAGE_LIMIT}&${recipientParam({ type: 'team_member', teamMemberId: fixture.teammateId })}`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page: WirePage = await inbox.list(
        ctxFor('inbox.list', fixture.identityId, { query }),
      ) as WirePage;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(fixture.teammateNotificationIds));
  });
});

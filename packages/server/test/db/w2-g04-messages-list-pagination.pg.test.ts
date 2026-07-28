import { decodeCursor, getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * W2.G04-FIX — `messages.list` keyset pagination must MAKE FORWARD PROGRESS.
 *
 * THE DEFECT. Following `nextCursor` returns the same message forever. The
 * client loops and the thread never advances past its first page.
 *
 * THE MECHANISM, measured rather than assumed — and it is NOT the one the
 * defect was first traced to. Two candidate causes were on the table:
 *
 *   1. THE SOURCE COLUMN. The cursor is encoded from `last.created_at`, and
 *      `last` is an `EntityRow` built from ENTITY_COLUMNS, which selects
 *      `e.created_at` and never `msg.created_at` — while the ORDER BY and the
 *      keyset predicate both compare `msg.created_at`. Two columns, two
 *      clocks. REAL, but LATENT: both rows are written in ONE transaction
 *      (019:452-458) and both columns default to `now()` (001:342, 001:945),
 *      and `now()` is transaction_timestamp — the START of the transaction,
 *      identical for every statement in it. So the two values are EQUAL today,
 *      not ordered, and equality makes the tuple compare behave correctly.
 *      The `pins the equality` case below exists to catch the day that stops
 *      being true.
 *
 *   2. MILLISECOND TRUNCATION — the one that actually bites. Postgres
 *      `timestamptz` holds MICROSECONDS. node-pg parses it into a JavaScript
 *      `Date`, which holds only MILLISECONDS, so the sub-millisecond part is
 *      gone before the handler sees the value; `toISOString()` then emits
 *      milliseconds. The cursor is therefore STRICTLY LESS than the stored
 *      timestamp, and `(msg.created_at, e.id) > (cursorTs, cursorId)` re-admits
 *      the very row the cursor was built from, deciding on the first tuple
 *      component alone. It fires whenever the microsecond remainder is
 *      non-zero — about 999 times in 1000, independent of ids.
 *
 * Fixing only (1) leaves the loop intact, because the truncation is downstream
 * of which column is read. That is why this file asserts EXHAUSTION rather than
 * just "page 2 differs from page 1": a fix that shifted the cursor by one
 * column would still satisfy a two-page check while looping later.
 *
 * THE DURABLE REQUIREMENT, being adopted for every cursor in the program:
 * following `nextCursor` to exhaustion returns each item EXACTLY ONCE and
 * TERMINATES.
 *
 * The fixture applies the whole chain via `migrationFiles()`, never a
 * hand-listed slice, and names no migration number.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  anchorId: string;
  messageIds: string[];
}

const MESSAGE_COUNT = 5;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{ identityId: string; spaceId: string; memberId: string; anchorId: string }>(
      `select 'g04pg-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "anchorId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'G04 owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'G04 Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'task',null,10,$1)`,
      [base.memberId, base.anchorId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','G04 owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority) values($1,'G04 anchor','open','medium')`,
      [base.anchorId],
    );

    // Each message gets its OWN transaction-like statement pair via distinct
    // clock values. Written exactly as the product writes them — entity row
    // then detail row, both taking their column default — so the timestamps
    // this test reasons about are the ones production produces, not values a
    // fixture chose.
    const messageIds: string[] = [];
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'message',null,null,$3)`,
        [id, base.spaceId, base.memberId],
      );
      await client.query(
        `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body)
         values($1,$2,null,$3,$4)`,
        [id, base.anchorId, base.memberId, `g04 message ${index}`],
      );
      messageIds.push(id);
    }
    return { ...base, messageIds };
  });
}

function listContext(anchorId: string, query: string, identityId: string): RequestContext {
  const opName: OperationName = 'messages.list';
  const op = getOperation(opName);
  return {
    op, opName,
    params: { anchorId },
    query: new URLSearchParams(query),
    body: undefined,
    requestId: 'req-g04-pagination',
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe.sequential('W2.G04-FIX messages.list keyset pagination makes forward progress', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let handler: ReturnType<typeof messagesList>;
  let appliedChain: string[];

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g04_page');
    appliedChain = migrationFiles();
    database.apply(appliedChain);
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    handler = messagesList({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000404',
        username: 'g04-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  });

  it('applies the whole migration chain, discovered rather than listed', () => {
    expect(appliedChain).toContain('019_w2_messages_handoffs.sql');
    expect(appliedChain.length).toBeGreaterThanOrEqual(28);
  });

  it('built a non-vacuous thread', async () => {
    // If the fixture built nothing, every case below would pass by reading
    // nothing. Fail loudly here first.
    const rows = await database.query<{ n: number }>(
      `select count(*)::integer n from public.messages where anchor_id=$1`, [fixture.anchorId]);
    expect(rows[0]!.n).toBe(MESSAGE_COUNT);
  });

  it('stores sub-millisecond precision that a JS Date cannot carry', async () => {
    // The mechanism, pinned at its root. If Postgres ever stored only
    // milliseconds here the truncation would be harmless and this file's
    // premise would be void — so the premise is asserted, not assumed.
    const rows = await database.query<{ subMs: number }>(
      `select count(*)::integer "subMs" from public.messages
        where anchor_id=$1 and (extract(microseconds from created_at)::bigint % 1000) <> 0`,
      [fixture.anchorId],
    );
    expect(rows[0]!.subMs).toBeGreaterThan(0);
  });

  it('pins that the entity and message timestamps are EQUAL, not ordered', async () => {
    // The latent half. Both rows are written in one transaction and both
    // columns default to now(), which is transaction_timestamp, so these are
    // equal today. The defect was first traced to an ORDERING between them;
    // that ordering does not exist. If this ever fails, the source-column
    // mix-up has become live and the cursor must already be reading
    // msg.created_at — which, after the fix, it does.
    const rows = await database.query<{ mismatched: number }>(
      `select count(*)::integer mismatched
         from public.messages m join public.entities e on e.id = m.entity_id
        where m.anchor_id = $1 and m.created_at is distinct from e.created_at`,
      [fixture.anchorId],
    );
    expect(rows[0]!.mismatched).toBe(0);
  });

  it('MECHANISM: the cursor carries the stored value verbatim, to six fractional digits', async () => {
    // THE PRIMARY ASSERTION, and it is deliberately ranked above the
    // forward-progress cases below.
    //
    // Symptom assertions can be fooled by fixture luck: a sequential fixture
    // writes each row in its own transaction, so no two rows share a
    // millisecond, nothing ever falls in the dropped window, and exactly-once
    // passes on a site that provably truncates. That has now happened twice in
    // this program — on spaces.awards and on collections.query, where
    // exactly-once passed and the precision assertion failed ON THE SAME ROW.
    //
    // This assertion cannot be fooled that way, and it is made AT THE WIRE —
    // decoded off the handler's own nextCursor — not at the SELECT. Formatting
    // microseconds in SQL is NOT sufficient on its own: iso() truncates on both
    // branches, so a correctly to_char'd value passed through it downstream is
    // destroyed just the same, and a fix verified at the query would look right
    // and change nothing.
    const page = await handler(listContext(fixture.anchorId, 'limit=1', fixture.identityId)) as
      { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page.nextCursor).toBeTruthy();

    const { k } = decodeCursor(page.nextCursor!);
    const carried = String(k[1]);

    // FORMAT-AGNOSTIC ON PURPOSE. Two renderings preserve microseconds equally
    // well — `msg.created_at::text` (Postgres' own, session-timezone, trailing
    // zeros stripped) and `to_char(... at time zone 'UTC', '...US"Z"')` (fixed
    // width, UTC). Asserting one spelling would pin a cosmetic choice and would
    // false-red on the other; worse, a six-digit regex fails on `::text`
    // roughly one row in ten, because Postgres strips the trailing zero.
    //
    // So assert the PROPERTY instead: cast the carried value back and require
    // it to be the identical instant. A truncated cursor cannot satisfy this —
    // that is precisely what truncation destroys — and it holds under either
    // rendering, at any timezone, for every site in the sweep.
    const check = await database.query<{ exactInstant: boolean; subMs: number }>(
      `select $1::timestamptz = created_at exact_instant,
              (extract(microseconds from created_at)::bigint % 1000) sub_ms
         from public.messages where entity_id=$2`
        .replace('exact_instant', '"exactInstant"').replace('sub_ms', '"subMs"'),
      [carried, page.items[0]!.id],
    );
    expect(check[0]!.exactInstant, 'cursor is not the stored instant — precision was lost').toBe(true);
    // Non-vacuousness: if this row had no sub-millisecond part the equality
    // above would hold even for a truncating encoder.
    expect(check[0]!.subMs, 'row has no sub-ms component; case proves nothing').not.toBe(0);
  });

  it('advances past the first page', async () => {
    const first = await handler(listContext(fixture.anchorId, 'limit=1', fixture.identityId)) as
      { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await handler(listContext(
      fixture.anchorId, `limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`, fixture.identityId,
    )) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id, 'page 2 returned the same message as page 1').not.toBe(first.items[0]!.id);
  });

  it('returns every message EXACTLY ONCE and TERMINATES when followed to exhaustion', async () => {
    // THE DURABLE REQUIREMENT. A two-page check can be satisfied by a cursor
    // that is merely shifted; only walking to the end proves the walk ends and
    // proves nothing is dropped or repeated along the way.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    // Bounded so a non-terminating walk FAILS instead of hanging the suite —
    // a hang reads as infrastructure trouble, a failure reads as the defect.
    const maxPages = MESSAGE_COUNT * 3;

    do {
      const query = cursor ? `limit=1&cursor=${encodeURIComponent(cursor)}` : 'limit=1';
      const page = await handler(listContext(fixture.anchorId, query, fixture.identityId)) as
        { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < maxPages);

    expect(cursor, `pagination did not terminate within ${maxPages} pages`).toBeNull();
    expect(new Set(seen).size, 'a message was returned more than once').toBe(seen.length);
    expect(seen).toHaveLength(MESSAGE_COUNT);
    expect([...seen].sort()).toEqual([...fixture.messageIds].sort());
  });

  it('walks the thread in the same order at every page size', async () => {
    // Ordering must not depend on how the walk was chunked. A cursor that is
    // subtly off can still return the right SET while reordering it.
    const walk = async (limit: number): Promise<string[]> => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = cursor ? `limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `limit=${limit}`;
        const page = await handler(listContext(fixture.anchorId, query, fixture.identityId)) as
          { items: Array<{ id: string }>; nextCursor: string | null };
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < MESSAGE_COUNT * 3);
      expect(cursor, `walk at limit=${limit} did not terminate`).toBeNull();
      return seen;
    };
    const byOne = await walk(1);
    const byTwo = await walk(2);
    const whole = await walk(MESSAGE_COUNT);
    expect(byTwo).toEqual(byOne);
    expect(whole).toEqual(byOne);
  });
});

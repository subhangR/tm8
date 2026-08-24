import { getOperation, type OperationName, type MessageView, type Page } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * A HEAVY CHAT THREAD MUST OPEN AT ALL.
 *
 * THE DEFECT, as reported: opening a long agentic thread failed with
 * `the tm8 node did not answer within 15000ms` and the thread never rendered.
 * Short threads were fine.
 *
 * THE CAUSE, measured against live prod rather than inferred — and it is NOT
 * the one the report suggests. It looks like a payload problem (the heaviest
 * thread assembles a ~2.6 MB body, ~85% of it `tool_result` blobs) and it is
 * not one. Three facts rule payload out:
 *
 *   - `limit=1` failed IDENTICALLY, at 30 s, returning 154 bytes of error. A
 *     one-message response cannot be too large.
 *   - The server never produced a body to send. It died on its own statement
 *     timeout: HTTP 503, SQLSTATE 57014 `query_canceled`. The 15 s client abort
 *     is only what the user saw first.
 *   - On the one heavy request that did complete, transfer was ~2 ms against
 *     21 s of server time — 0.009%.
 *
 * The real cause is the SHAPE of the page read. `ENTITY_FROM` left-joins ~25
 * detail tables. The read filtered on `msg` — a table INSIDE that chain —
 * rather than on `e.id`, so the planner had no id to drive from and rebuilt the
 * whole chain once per candidate row: `Seq Scan on entities` at `loops=71`, the
 * join degraded to a `Join Filter` discarding 588,093 rows, 5,880,086 shared
 * buffer hits, 37 s to return two rows. The RLS predicates are SECURITY DEFINER
 * and cannot be inlined, so their selectivity was guessed at one row where
 * there were 71, which is why the rescan looked free. And a `Sort` above the
 * join meant `limit` discarded nothing — hence limit=1 costing what limit=100
 * cost.
 *
 * THE DURABLE REQUIREMENT this file pins, and WHY IT IS PINNED AS SHAPE RATHER
 * THAN AS TIME.
 *
 * The obvious test is "the thread opens within N seconds". This file was
 * written that way first and it was a FALSE GREEN three times over: the fixture
 * was too small; then `alter database ... set statement_timeout` turned out to
 * be silently overridden by the startup parameter `PgDb` sets per connection;
 * and finally, with both of those corrected, the unfixed handler STILL passed —
 * because on synthetic rows the planner happens to pick a good plan anyway.
 *
 * That last one is the important one. Whether the bad plan is chosen depends on
 * a SELECTIVITY MISESTIMATE, which depends on the statistics of real data. A
 * timing assertion therefore tests the planner's mood, not the code — it would
 * pass on CI and keep failing in production, which is the exact failure this
 * file is supposed to prevent.
 *
 * So the regression is pinned STRUCTURALLY: the envelope select must never be
 * filtered on a `messages` column. That is the property the fix establishes, it
 * is true or false by inspection, and it cannot go flaky. The timing budget is
 * kept below only as a coarse backstop.
 *
 * WHY THE UNRELATED ENTITIES MATTER. The bad plan's cost is
 * (messages in page) x (rows in `entities`), so a populated space is what makes
 * the difference observable at all. They also keep the correctness cases honest
 * by ensuring the read has to discriminate rather than return everything.
 *
 * The fixture applies the whole chain via `migrationFiles()`, never a
 * hand-listed slice, and names no migration number.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  anchorId: string;
  rootId: string;
  replyIds: string[];
}

/** Replies under one root — the thread the user opens. */
const REPLY_COUNT = 40;
/**
 * Unrelated rows in `entities`, which the regressed plan rescans PER MESSAGE.
 *
 * These rows are the cheap half of the fixture on purpose: the bad plan costs
 * about (messages in page) x (rows in `entities`), so every filler row hurts
 * it, while the fixed plan reaches `entities` by id and never looks at them.
 * Kept modest because the guard here is structural, not timed — the fixture
 * only needs a space that is populated, not one tuned to trip a stopwatch.
 */
const FILLER_ENTITIES = 2_000;
/** Roughly the size of a real screenshot/tool dump, so the body is genuinely heavy. */
const TOOL_RESULT_BYTES = 24_000;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{
      identityId: string; spaceId: string; memberId: string; anchorId: string; rootId: string;
    }>(
      `select 'heavy-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "anchorId",
              internal.new_id()::text "rootId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Heavy owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Heavy Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'task',null,10,$1)`,
      [base.memberId, base.anchorId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Heavy owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority)
       values($1,'Heavy anchor','open','medium')`,
      [base.anchorId],
    );

    // The thread root.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'message',null,null,$3)`,
      [base.rootId, base.spaceId, base.memberId],
    );
    await client.query(
      `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body)
       values($1,$2,null,$3,'heavy thread root')`,
      [base.rootId, base.anchorId, base.memberId],
    );

    // Replies, each carrying a tool_call/tool_result/text triple — the shape an
    // agentic turn actually writes, and the shape whose bytes were blamed.
    const replyIds: string[] = [];
    const blob = 'x'.repeat(TOOL_RESULT_BYTES);
    for (let index = 0; index < REPLY_COUNT; index += 1) {
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      // Threading lives on the ENVELOPE: a reply's `entities.parent_id` names
      // the message it answers, and `messages.root_message_id` must then equal
      // that parent's thread root (001's `validate_message`). A reply whose
      // entity had no parent would be rejected as a top-level message.
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'message',$4,null,$3)`,
        [id, base.spaceId, base.memberId, base.rootId],
      );
      await client.query(
        `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body)
         values($1,$2,$3,$4,$5)`,
        [id, base.anchorId, base.rootId, base.memberId, `heavy reply ${index}`],
      );
      await client.query(
        `insert into public.message_parts(message_id,seq,kind,payload) values
         ($1,0,'tool_call',$2::jsonb),
         ($1,1,'tool_result',$3::jsonb),
         ($1,2,'text',$4::jsonb)`,
        [
          id,
          JSON.stringify({
            id: `call_${index}`, name: 'Bash',
            args: { command: 'ls -la' }, state: 'completed',
          }),
          JSON.stringify({ tool_call_id: `call_${index}`, content: blob, is_error: false }),
          JSON.stringify({ text: `reply ${index} narration` }),
        ],
      );
      replyIds.push(id);
    }

    // Population for `entities`. These are plain rows in the same space: the
    // regressed plan walks all of them once per message in the page.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       select internal.new_id(), $1, 'doc', null, null, $2 from generate_series(1,$3)`,
      [base.spaceId, base.memberId, FILLER_ENTITIES],
    );

    return { ...base, replyIds };
  });
}

/**
 * A `Db` that records the SQL its transactions issue and otherwise delegates.
 *
 * The structural assertions need the statements the handler actually ran, not
 * a reimplementation of them, so nothing here rewrites or inspects semantics —
 * it only keeps a transcript.
 */
function recording(inner: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const db: Db = {
    tx: (claims, fn) => inner.tx(claims, (q) => fn({
      query: (text, params) => { sql.push(text); return q.query(text, params); },
      rpc: (fn2, args) => q.rpc(fn2, args),
    })),
    rpc: (claims, fn, args) => inner.rpc(claims, fn, args),
    query: (claims, text, params) => { sql.push(text); return inner.query(claims, text, params); },
    end: () => inner.end(),
  };
  return { db, sql };
}

/**
 * `ENTITY_FROM`'s signature join. Any statement containing this is the ~25-table
 * envelope select, whatever else it says.
 */
const ENVELOPE_JOIN = /left join public\.entity_counters/i;
/**
 * A FILTER on the thread's message columns — the thing that must not co-occur
 * with the join above.
 *
 * Deliberately narrow. "a `msg.` anywhere after a `where`" is too loose to be
 * useful here: `ENTITY_COLUMNS` selects `msg.anchor_id` and `msg.root_message_id`
 * outright, and `ENTITY_FROM` both joins `public.messages msg` and contains a
 * lateral with its own `where`, so that shape matches the perfectly good
 * hydrate query and reports a false offender.
 *
 * These two columns followed by `=` cannot occur innocently: the select list
 * spells them bare, and the only join condition on `msg` is `msg.entity_id`.
 * So this matches a page predicate and nothing else.
 */
const MESSAGE_PREDICATE = /msg\.(anchor_id|root_message_id)\s*=/i;

function listContext(anchorId: string, query: string, identityId: string): RequestContext {
  const opName: OperationName = 'messages.list';
  const op = getOperation(opName);
  return {
    op, opName,
    params: { anchorId },
    query: new URLSearchParams(query),
    body: undefined,
    requestId: 'req-heavy-thread',
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe.sequential('a heavy agentic thread opens', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let handler: ReturnType<typeof messagesList>;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('chat_heavy_thread');
    database.apply(migrationFiles());
    fixture = await seed(database);

    // Statistics decide the plan. Without this the planner has none for the
    // rows just inserted and the comparison would be against an accident.
    await database.query('analyze');

    // THE ASSERTION MECHANISM: the SAME knob production runs on, turned down.
    // `PgDb` applies `statement_timeout` as a connection startup parameter
    // (default 30_000), which is why the user's failure surfaced as HTTP 503
    // with SQLSTATE 57014 rather than as a slow page. Setting it here means the
    // regression is caught by the very mechanism that reported it.
    //
    // It has to be set THROUGH `PgDb`. An `alter database ... set
    // statement_timeout` is silently overridden by that startup parameter — an
    // earlier draft of this file did exactly that and let the unfixed handler
    // run for 283 seconds and PASS.
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4, statementTimeoutMillis: 5_000 });
    handler = messagesList({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-00000000beef',
        username: 'heavy-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
  }, 300_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  });

  it('built a genuinely heavy thread, and a populated space to read it out of', async () => {
    // If the fixture built nothing, every case below would pass by reading
    // nothing, and the timeout case would pass for the wrong reason.
    const [replies] = await database.query<{ n: number }>(
      `select count(*)::integer n from public.messages where root_message_id=$1`, [fixture.rootId]);
    expect(replies!.n).toBe(REPLY_COUNT);

    const [parts] = await database.query<{ n: number; bytes: number }>(
      `select count(*)::integer n, sum(pg_column_size(payload))::integer bytes
         from public.message_parts mp
         join public.messages m on m.entity_id = mp.message_id
        where m.root_message_id=$1`, [fixture.rootId]);
    expect(parts!.n).toBe(REPLY_COUNT * 3);

    const [entities] = await database.query<{ n: number }>(
      `select count(*)::integer n from public.entities where space_id=$1`, [fixture.spaceId]);
    expect(entities!.n).toBeGreaterThan(FILLER_ENTITIES);
  });

  it('opens the whole thread inside the statement budget', async () => {
    // The bug, stated as a test. Before the query-shape fix this is the case
    // that fails — not with a wrong value but with `query_canceled`.
    const page = await handler(
      listContext(fixture.anchorId, `rootMessageId=${fixture.rootId}&limit=100`, fixture.identityId),
    ) as Page<MessageView>;

    expect(page.items).toHaveLength(REPLY_COUNT);
  });

  it('a one-message page costs like one message, not like the whole thread', async () => {
    // `limit` was decorative: a `Sort` above the join forced every row to
    // materialise, so limit=1 cost what limit=100 cost. This pins that `limit`
    // is load-bearing again.
    const page = await handler(
      listContext(fixture.anchorId, `rootMessageId=${fixture.rootId}&limit=1`, fixture.identityId),
    ) as Page<MessageView>;

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it('NEVER filters the 25-table envelope select on a message column', async () => {
    // THE REGRESSION GUARD. This is the defect stated as a property: filtering
    // `ENTITY_FROM` on `msg` is what left the planner with no id to drive from.
    // True or false by inspection, so it holds on any data and any planner.
    const { db, sql } = recording(facadeDb);
    const spied = messagesList({
      db, config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-00000000beef',
        username: 'heavy-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
    await spied(listContext(fixture.anchorId, `rootMessageId=${fixture.rootId}&limit=100`, fixture.identityId));

    expect(sql.length).toBeGreaterThan(0);
    const offenders = sql.filter((text) => ENVELOPE_JOIN.test(text) && MESSAGE_PREDICATE.test(text));
    expect(offenders).toEqual([]);

    // And the positive half: envelopes ARE fetched by id. Without this the
    // assertion above could be satisfied by not reading envelopes at all.
    expect(sql.some((text) => ENVELOPE_JOIN.test(text) && /e\.id = any\(/i.test(text))).toBe(true);
  });

  it('reads the keyset from `messages` alone, so `limit` can bound the work', async () => {
    // The other half of the split. The ordering read must not drag the join
    // chain along with it — that is what put a `Sort` above the join and made
    // `limit` decorative.
    const { db, sql } = recording(facadeDb);
    const spied = messagesList({
      db, config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-00000000beef',
        username: 'heavy-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
    await spied(listContext(fixture.anchorId, `rootMessageId=${fixture.rootId}&limit=5`, fixture.identityId));

    const keyset = sql.find((text) => /from public\.messages msg/i.test(text) && /limit/i.test(text));
    expect(keyset).toBeDefined();
    expect(ENVELOPE_JOIN.test(keyset!)).toBe(false);
  });

  it('returns every part intact, in seq order — the split must not lose or reorder content', async () => {
    // The restructure reads ids and envelopes in two statements and rejoins
    // them in JS. Dropping a row, or returning them in `any(...)` order rather
    // than thread order, is the failure mode it introduces, so both are pinned.
    const page = await handler(
      listContext(fixture.anchorId, `rootMessageId=${fixture.rootId}&limit=100`, fixture.identityId),
    ) as Page<MessageView>;

    expect(page.items.map((item) => item.id)).toEqual(fixture.replyIds);

    for (const item of page.items) {
      const parts = item.parts ?? [];
      expect(parts.map((part) => part.kind)).toEqual(['tool_call', 'tool_result', 'text']);
      expect(parts.map((part) => part.seq)).toEqual([0, 1, 2]);
    }

    // Wire compatibility: the heavy payload still arrives WHOLE. This is the
    // fact a bounded-summary change would deliberately break, so if that work
    // lands this expectation is the one that must be revisited on purpose.
    const [{ content }] = page.items[0]!.parts!
      .filter((part) => part.kind === 'tool_result')
      .map((part) => part.payload as { content: string });
    expect(content).toHaveLength(TOOL_RESULT_BYTES);
  });

  it('walks the heavy thread to exhaustion, each message exactly once', async () => {
    // Pagination has to survive the split too: the cursor is now built from the
    // keyset row rather than the hydrated envelope.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < REPLY_COUNT + 5; guard += 1) {
      const query = `rootMessageId=${fixture.rootId}&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await handler(
        listContext(fixture.anchorId, query, fixture.identityId),
      ) as Page<MessageView>;
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(fixture.replyIds);
    expect(new Set(seen).size).toBe(REPLY_COUNT);
  });
});

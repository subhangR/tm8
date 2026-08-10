import { getOperation, MessageViewSchema, type OperationName, type Page, type MessageView } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * THE THREAD FOOTER — `replyCount`, `lastReplyAt`, `replyParticipants`.
 *
 * These are the three facts behind "▸ 4 replies · Bhargav, Opus 5 · 2h ago",
 * the affordance that makes a thread discoverable from a roots-only channel.
 * They are asserted against a REAL database rather than a FakeDb because all
 * three come out of one `group by` over `public.messages` — a FakeDb would be
 * asserting the transcription, not the query.
 *
 * WHY THE ORDERING OF `replyParticipants` IS TESTED RATHER THAN ASSUMED. The
 * obvious spelling is `array_agg(distinct author_id)`, whose order Postgres
 * does not promise. A facepile that reshuffles between two reads of unchanged
 * data reads as activity that did not happen, so the query orders authors by
 * their FIRST reply and this file pins that choice with an author who replies
 * twice, second and last.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  anchorId: string;
  alice: string;
  bob: string;
  /** A root with three replies from two authors. */
  busyRootId: string;
  /** A root nobody answered — the null case. */
  quietRootId: string;
  replyIds: string[];
}

let database: W1ScratchDatabase;
let db: PgDb;
let fixture: Fixture;

async function seed(scratch: W1ScratchDatabase): Promise<Fixture> {
  return scratch.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{
      identityId: string; spaceId: string; anchorId: string; alice: string; bob: string;
    }>(
      `select 'threadfooter-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "anchorId", internal.new_id()::text "alice",
              internal.new_id()::text "bob"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Thread owner'),('threadfooter-bob','Bob')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Thread Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$4,'member',null,0,$1),($2,$4,'member',null,1,$1),($3,$4,'task',null,10,$1)`,
      [base.alice, base.bob, base.anchorId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$3,$4,'owner','Alice'),($2,$3,'threadfooter-bob','member','Bob')`,
      [base.alice, base.bob, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority)
       values($1,'Thread anchor','open','medium')`,
      [base.anchorId],
    );

    /*
     * `created_at` IS PASSED EXPLICITLY, and it has to be.
     *
     * The whole seed runs in ONE transaction, and `messages.created_at`
     * defaults to `now()` — which is `transaction_timestamp`, the start of the
     * transaction and therefore IDENTICAL for every row written here. (The G04
     * pagination test documents the same fact from the other side.) Under that
     * default all three replies tie, `min(created_at)` per author cannot order
     * anything, and this file would "pass" while asserting nothing about
     * ordering at all.
     *
     * Production writes each message in its own transaction, so the timestamps
     * really do differ; `offsetSeconds` is how that gets reproduced inside one.
     */
    const newMessage = async (
      rootId: string | null,
      authorId: string,
      body: string,
      offsetSeconds: number,
    ): Promise<string> => {
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by,created_at)
         values($1,$2,'message',$3,null,$4, now() + ($5 || ' seconds')::interval)`,
        [id, base.spaceId, rootId, authorId, String(offsetSeconds)],
      );
      await client.query(
        `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
         values($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
        [id, base.anchorId, rootId, authorId, body, String(offsetSeconds)],
      );
      return id;
    };

    const busyRootId = await newMessage(null, base.alice, 'auth is failing on staging', 0);
    const quietRootId = await newMessage(null, base.alice, 'nobody answered this one', 1);

    // Bob replies FIRST, Alice second, Bob again LAST. So ordering by first
    // reply gives [Bob, Alice]; ordering by LAST reply would give [Alice, Bob]
    // — the exact inversion — which is what makes this fixture discriminating
    // rather than merely populated.
    const replyIds = [
      await newMessage(busyRootId, base.bob, 'looks like the token refresh', 10),
      await newMessage(busyRootId, base.alice, 'agreed, checking the clock units', 20),
      await newMessage(busyRootId, base.bob, 'ms vs µs — that is the bug', 30),
    ];

    return { ...base, busyRootId, quietRootId, replyIds };
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
    requestId: 'req-thread-footer',
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

async function listRoots(): Promise<MessageView[]> {
  const handler = messagesList({
    db,
    owner: async () => ({ identityId: fixture.identityId, isNodeAdmin: true }),
  } as never);
  const page = await handler(listContext(fixture.anchorId, '', fixture.identityId)) as Page<MessageView>;
  return page.items;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('thread_footer');
  database.apply(migrationFiles());
  fixture = await seed(database);
  db = new PgDb({ databaseUrl: database.url, max: 4 });
}, 240_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe.sequential('thread footer metadata', () => {
  it('built a thread with two authors and an unanswered sibling', async () => {
    const roots = await listRoots();
    // Roots only — the three replies must not surface as peers.
    expect(roots.map((root) => root.id).sort())
      .toEqual([fixture.busyRootId, fixture.quietRootId].sort());
  });

  it('counts replies, names the last one, and orders the facepile by FIRST reply', async () => {
    const roots = await listRoots();
    const busy = roots.find((root) => root.id === fixture.busyRootId)!;

    expect(busy.replyCount).toBe(3);

    // Bob replied first and Alice second, so Bob leads — even though Bob also
    // wrote the LAST reply. Insertion order and last-reply order would both
    // put Bob first by accident, so the discriminating fact is that Alice is
    // present exactly ONCE despite three replies between two people.
    expect(busy.replyParticipants?.map((actor) => actor.displayName)).toEqual(['Bob', 'Alice']);
    expect(busy.replyParticipants).toHaveLength(2);

    // `lastReplyAt` is the newest reply's timestamp, not the root's.
    expect(busy.lastReplyAt).not.toBeNull();
    expect(new Date(busy.lastReplyAt!).getTime())
      .toBeGreaterThanOrEqual(new Date(busy.createdAt).getTime());
  });

  it('reports a replyless root as a measured zero, never as a missing fact', async () => {
    const roots = await listRoots();
    const quiet = roots.find((root) => root.id === fixture.quietRootId)!;

    expect(quiet.replyCount).toBe(0);
    // `null`, not `undefined` and not the root's own timestamp: there IS no
    // last reply. A footer reading "· just now" on a thread nobody answered is
    // the exact lie this pins shut.
    expect(quiet.lastReplyAt).toBeNull();
    expect(quiet.replyParticipants).toEqual([]);
  });

  it('emits a shape the published contract accepts', async () => {
    for (const root of await listRoots()) {
      expect(() => MessageViewSchema.parse(root)).not.toThrow();
    }
  });
});

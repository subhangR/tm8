/**
 * Can a client that only POLLS actually watch the G1A loop happen?
 *
 * This is not a unit test and deliberately not hermetic: it talks HTTP to a
 * LIVE server that has already been driven through the loop by
 * scripts/smoke-loop.mjs. That is the whole point. `poll.pg.test.ts` proves the
 * log projects correctly by calling `PgDurableEventLog` in-process; it cannot
 * prove that the mounted route, the real router, the real claims path and the
 * real loop agree — and "progress lands in the task thread" is a promise about
 * the deployed system, not about a class.
 *
 * There is no live WS push in this wave, so polling IS the delivery mechanism
 * for that promise. If these assertions fail, the user watching the UI sees a
 * blank or incomplete thread.
 *
 * RUN IT (one shell command — a backgrounded server is reaped between separate
 * invocations):
 *
 *   cd /Users/subhang/Desktop/Projects/tm8 && bun run build && \
 *   PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
 *   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_sirius node db/migrate.mjs reset --force && \
 *   (TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_sirius TM8_PORT=4613 \
 *    TM8_AGENT_CMD=echo-agent node packages/server/dist/index.js &) ; sleep 5 ; \
 *   TM8_BASE_URL=http://127.0.0.1:4613 node scripts/smoke-loop.mjs && \
 *   cd packages/server && TM8_BASE_URL=http://127.0.0.1:4613 \
 *   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_sirius \
 *   bunx vitest run test/events/loop-visibility.pg.test.ts
 *
 * Skips (rather than fails) with no TM8_BASE_URL, so the normal suite stays
 * runnable without a server.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, type DurableWorkspaceEvent } from '@tm8/contract';

import { createTestDb, TEST_DATABASE_URL, type TestDb } from './pg-harness.js';

const BASE = process.env['TM8_BASE_URL'];
const canRun = BASE !== undefined && TEST_DATABASE_URL !== undefined;
const describeIfLive = canRun ? describe : describe.skip;

interface EventPage {
  items: DurableWorkspaceEvent[];
  nextCursor: string | null;
}

describeIfLive('a polling client sees the G1A loop (live server)', () => {
  let db: TestDb;
  let spaceId: string;
  let taskId: string;
  let all: DurableWorkspaceEvent[];

  /** `events.poll` over HTTP — the same call a browser makes. */
  async function poll(since: number, limit?: number): Promise<EventPage> {
    const q = new URLSearchParams({ since: String(since) });
    if (limit !== undefined) q.set('limit', String(limit));
    const res = await fetch(`${BASE!}/v2/spaces/${spaceId}/events?${q.toString()}`);
    if (!res.ok) throw new Error(`events.poll ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data: EventPage };
    return body.data;
  }

  beforeAll(async () => {
    db = createTestDb(TEST_DATABASE_URL!);

    // Find the loop's space and task from the database rather than parsing the
    // driver's stdout: the ids are facts in the graph, and coupling this test to
    // console formatting would make it break for a cosmetic reason.
    const spaces = await db.asOwner((q) =>
      q.query<{ id: string }>(
        `select s.id from public.spaces s
           join public.entities e on e.space_id = s.id and e.kind = 'work_session'
          order by s.created_at desc limit 1`,
      ),
    );
    if (spaces.length === 0) {
      throw new Error('no space with a work_session — run scripts/smoke-loop.mjs against this database first');
    }
    spaceId = spaces[0]!.id;

    const tasks = await db.asOwner((q) =>
      q.query<{ entity_id: string }>(
        `select t.entity_id from public.tasks t
           join public.entities e on e.id = t.entity_id
          where e.space_id = $1 order by e.created_at asc limit 1`,
        [spaceId],
      ),
    );
    taskId = tasks[0]!.entity_id;

    all = (await poll(0, 500)).items;
  });

  /** Milestones identified by unambiguous signatures, not by position. */
  const taskCreated = (e: DurableWorkspaceEvent): boolean =>
    e.type === 'activity.created' && e.activity.verb === 'created' && e.activity.entityId === taskId;
  const progressPosted = (e: DurableWorkspaceEvent): boolean =>
    e.type === 'message.created' && e.anchorId === taskId;
  const taskCompleted = (e: DurableWorkspaceEvent): boolean =>
    e.type === 'activity.created' && e.activity.verb === 'completed' && e.activity.entityId === taskId;
  const sessionUpsert = (e: DurableWorkspaceEvent): boolean =>
    e.type === 'entity.upsert' && e.entity.kind === 'work_session';

  it('every event on the live feed is contract-shaped', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const [i, event] of all.entries()) {
      const parsed = WorkspaceEventSchema.safeParse(event);
      expect(
        parsed.success,
        `event[${String(i)}] (seq ${String(event.seq)}, ${event.type}) is off-contract: ` +
          JSON.stringify(event).slice(0, 400),
      ).toBe(true);
    }
  });

  it('the four loop milestones each appear exactly once, in commit order', () => {
    const created = all.filter(taskCreated);
    const progress = all.filter(progressPosted);
    const completed = all.filter(taskCompleted);

    expect(created, 'task creation must appear exactly once').toHaveLength(1);
    expect(progress, 'the thread message must appear exactly once').toHaveLength(1);
    expect(completed, 'completion must appear exactly once').toHaveLength(1);

    // The spawn is asserted by DISTINCT session, not by event count: a
    // work_session legitimately emits several upserts as it moves
    // spawning→running→exited, and asserting "one work_session event" would be
    // asserting that the status transitions do NOT reach the client — the
    // opposite of what the terminal panel needs.
    const sessions = new Set(all.filter(sessionUpsert).map((e) => (e.type === 'entity.upsert' ? e.entity.id : '')));
    expect(sessions.size, 'exactly one agent session was spawned').toBe(1);

    const spawnSeq = Math.min(...all.filter(sessionUpsert).map((e) => e.seq));
    expect(created[0]!.seq).toBeLessThan(spawnSeq);
    expect(spawnSeq).toBeLessThan(progress[0]!.seq);
    expect(progress[0]!.seq).toBeLessThan(completed[0]!.seq);
  });

  /**
   * The renderability assertion, and the reason point 4 was called out
   * separately: an event with an empty payload satisfies the schema while
   * rendering a blank line in the thread. "Progress lands in the task thread" is
   * a promise about what the user SEES.
   */
  it('the thread message carries enough to render without a refetch', () => {
    const event = all.find(progressPosted);
    expect(event).toBeDefined();
    if (event?.type !== 'message.created') throw new Error('unreachable');

    expect(event.anchorId, 'anchored to the task, so the thread knows where it goes').toBe(taskId);
    expect(event.message.content.body.length, 'a blank body renders a blank line').toBeGreaterThan(0);
    expect(event.message.title.length, 'the list/summary surfaces render the title').toBeGreaterThan(0);

    // WHO said it. A thread that cannot name its author is not a thread.
    expect(event.message.state.kind).toBe('message');
    if (event.message.state.kind !== 'message') throw new Error('unreachable');
    expect(event.message.state.author.id.length).toBeGreaterThan(0);
    expect(
      event.message.state.author.displayName.length,
      'an author with no display name renders as a blank byline',
    ).toBeGreaterThan(0);
    expect(typeof event.message.state.author.isAgent).toBe('boolean');

    // Optimistic reconciliation: the client must be able to match this event to
    // the command it issued and drop its placeholder.
    expect(event.clientMutationId, 'no cmid means the optimistic message never resolves').toBeTruthy();
  });

  /**
   * A poller that joins mid-loop must miss nothing and see nothing twice.
   *
   * This is the reconnect case, and it is where a cursor off-by-one hides:
   * `seq >= since` re-delivers one event per page, and a cursor of "last + 1"
   * skips one. Starting mid-stream (rather than at 0) is what makes it a
   * reconnect rather than a cold read.
   */
  it('a cursor-advancing poller joining mid-loop misses nothing and never duplicates', async () => {
    expect(all.length).toBeGreaterThan(6);
    const joinAt = all[Math.floor(all.length / 2)]!.seq;
    const expected = all.filter((e) => e.seq > joinAt).map((e) => e.seq);

    const seen: number[] = [];
    let cursor = joinAt;
    for (let page = 0; page < 100; page += 1) {
      const { items, nextCursor } = await poll(cursor, 2);
      if (items.length === 0) break;
      expect(items.length).toBeLessThanOrEqual(2);
      // Never hand back something at or before the cursor we asked from.
      expect(items.every((e) => e.seq > cursor)).toBe(true);
      seen.push(...items.map((e) => e.seq));
      cursor = Number(nextCursor);
    }

    expect(seen, 'the mid-loop poller saw a different set than the full read').toEqual(expected);
    expect(new Set(seen).size, 'an event was delivered twice across pages').toBe(seen.length);
  });

  it('the cursor the server hands back is a fixed point', async () => {
    const full = await poll(0, 500);
    const settled = await poll(Number(full.nextCursor), 500);
    expect(settled.items).toEqual([]);
    expect(settled.nextCursor).toBe(full.nextCursor);
  });

  it('the durable feed never carries presence or typing (DEV-4)', () => {
    expect(all.every((e) => e.type !== 'presence.changed' && e.type !== 'typing.changed')).toBe(true);
  });
});

/**
 * `events.poll` against a REAL database — the proof for this lane.
 *
 * The claim being tested is the lane's whole premise: the database already
 * captures every mutation, so a write RPC executed with no server involvement at
 * all must show up on the poll feed as a contract-shaped event. Every test here
 * therefore mutates through `public.*` RPCs ONLY — nothing calls a publisher,
 * nothing inserts into `workspace_events`, and no test constructs a seq. If the
 * events appear, they appear because the trigger put them there.
 *
 * Runs as `tm8_app` (see pg-harness.ts) so RLS is actually in force.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkspaceEventSchema, WORKSPACE_EVENT_SCHEMA_VERSION } from '@tm8/contract';

import { HandlerRegistry } from '../../src/facade/index.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from './pg-harness.js';

const url = TEST_DATABASE_URL;
const describeIfPg = url === undefined ? describe.skip : describe;

/** `internal.command_result` shape: `{entity, activity?, patches[]}` (007:49). */
interface CommandResult {
  entity: { id: string };
}

describeIfPg('events.poll over the captured log (real Postgres)', () => {
  let db: TestDb;
  let spaceId: string;
  let memberId: string;
  let identityId: string;
  let log: PgDurableEventLog;

  /** Claims for the space's owning member. */
  const claims = (): { identityId: string; actorId: string; nodeAdmin: boolean; requestId: string } => ({
    identityId,
    actorId: memberId,
    nodeAdmin: false,
    requestId: `req_${randomUUID()}`,
  });

  beforeAll(async () => {
    db = createTestDb(url!);
    identityId = `identity_${randomUUID()}`;

    // Fixture: an identity, then a space. `create_space` mints the owning member
    // and the default channel itself, so this is the whole setup.
    await db.rpc({ identityId }, 'public.upsert_user_profile', ['Sirius Test', null, null]);
    // `create_space` returns `{space, patches:[…]}` — the space row is nested.
    const created = await db.rpc<{ space: { id: string } }>({ identityId }, 'public.create_space', [
      'Events lane space',
      'poll proof',
      'private',
      null,
      null,
    ]);
    spaceId = created.space.id;

    const members = await db.query<{ entity_id: string }>(
      { identityId },
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [spaceId, identityId],
    );
    memberId = members[0]!.entity_id;

    log = new PgDurableEventLog(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  it('projects a write RPC into a contract-shaped event with a monotonic seq', async () => {
    const cmid = `cmid_${randomUUID()}`;
    const before = await log.since(spaceId, 0, 500, claims());

    // The ONLY thing this test does to produce an event: call the RPC.
    await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId,
      'Prove the log',
      memberId,
      'created by the RPC, captured by the trigger',
      null,
      null,
      null,
      'high',
      null,
      null,
      null,
      null,
      'attached_to',
      cmid,
    ]);

    const after = await log.since(spaceId, 0, 500, claims());
    expect(after.items.length).toBeGreaterThan(before.items.length);

    // Every event validates against the contract schema — the tripwire, from the
    // client's side this time.
    for (const [i, event] of after.items.entries()) {
      const parsed = WorkspaceEventSchema.safeParse(event);
      expect(parsed.success, `event[${String(i)}] is off-contract: ${JSON.stringify(event).slice(0, 300)}`).toBe(true);
    }

    const upsert = after.items.find(
      (e) => e.type === 'entity.upsert' && e.entity.title === 'Prove the log',
    );
    expect(upsert, 'the created task must appear as entity.upsert').toBeDefined();
    if (upsert?.type !== 'entity.upsert') throw new Error('unreachable');

    // The AM-2 §3 envelope, re-projected on every event.
    expect(upsert.spaceId).toBe(spaceId);
    expect(upsert.schemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
    expect(typeof upsert.occurredAt).toBe('string');
    expect(Number.isInteger(upsert.seq)).toBe(true);
    expect(upsert.seq).toBeGreaterThan(0);

    // clientMutationId threaded from the command, for optimistic reconciliation.
    expect(upsert.clientMutationId).toBe(cmid);

    // Hydration actually happened: this is the part the raw captured payload
    // cannot answer on its own.
    expect(upsert.entity.kind).toBe('task');
    expect(upsert.entity.state.kind).toBe('task');
    if (upsert.entity.state.kind === 'task') {
      expect(upsert.entity.state.priority).toBe('high');
      expect(upsert.entity.state.workStatus).toBe('open');
    }
    expect(upsert.entity.createdBy.id).toBe(memberId);
    expect(upsert.entity.counters.messages).toBe(0);

    // Ascending seq order, no duplicates — the two properties the cursor rests on.
    const seqs = after.items.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('polling with since = the last seq returns nothing new', async () => {
    const caught = await log.since(spaceId, 0, 500, claims());
    expect(caught.items.length).toBeGreaterThan(0);
    const cursor = Number(caught.nextCursor);
    expect(cursor).toBeGreaterThan(0);

    // The cursor the server just handed back must be a fixed point: replaying
    // from it returns an empty page, not the same page again.
    const empty = await log.since(spaceId, cursor, 500, claims());
    expect(empty.items).toEqual([]);
    // And it echoes the caller's position rather than losing it.
    expect(empty.nextCursor).toBe(String(cursor));

    // One more mutation, and only that one comes back. Anchored to a TASK,
    // because "progress lands in the task thread" is the G1A loop step this
    // operation exists to deliver.
    const task = await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId,
      'Thread anchor',
      memberId,
      '',
      null,
      null,
      null,
      'medium',
      null,
      null,
      null,
      null,
      'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    const afterTask = Number((await log.since(spaceId, 0, 500, claims())).nextCursor);

    await db.rpc(claims(), 'public.post_message', [
      task.entity.id,
      'progress in the thread',
      memberId,
      null,
      null,
      null,
      `cmid_${randomUUID()}`,
    ]);

    const next = await log.since(spaceId, afterTask, 500, claims());
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items.every((e) => e.seq > afterTask), 'since must exclude already-seen seqs').toBe(true);
    const posted = next.items.find((e) => e.type === 'message.created');
    expect(posted, 'the posted message must appear as message.created').toBeDefined();
    if (posted?.type !== 'message.created') throw new Error('unreachable');
    // The event carries the thread it belongs to and the message body — a client
    // renders the thread from this alone, with no refetch (AM-2 §3: no bare-id
    // variants).
    expect(posted.anchorId).toBe(task.entity.id);
    expect(posted.message.content.body).toBe('progress in the thread');
  });

  /**
   * Walking the log one page at a time must visit every event exactly once.
   *
   * This is the property a reconnecting client actually depends on, and it is
   * where an off-by-one in the cursor hides: `seq > since` with a cursor of "the
   * last seq I returned" is correct, while `seq >= since` would re-deliver one
   * event per page and a cursor of "last + 1" would skip one.
   */
  it('paging with a small limit visits every event exactly once', async () => {
    const all = await log.since(spaceId, 0, 500, claims());
    expect(all.items.length).toBeGreaterThan(3);

    const walked: number[] = [];
    let cursor = 0;
    // Bounded so a cursor bug becomes a failed assertion, not an infinite loop.
    for (let page = 0; page < 50; page += 1) {
      const { items, nextCursor } = await log.since(spaceId, cursor, 2, claims());
      if (items.length === 0) break;
      expect(items.length).toBeLessThanOrEqual(2);
      walked.push(...items.map((e) => e.seq));
      cursor = Number(nextCursor);
    }

    expect(walked).toEqual(all.items.map((e) => e.seq));
    expect(new Set(walked).size, 'an event was delivered twice across pages').toBe(walked.length);
  });

  it('the durable feed never carries presence or typing (DEV-4)', async () => {
    const { items } = await log.since(spaceId, 0, 500, claims());
    expect(items.every((e) => e.type !== 'presence.changed' && e.type !== 'typing.changed')).toBe(true);
  });

  /**
   * Monotonicity under concurrency — the property that makes `seq` usable as a
   * dedupe key at all.
   *
   * `internal.next_event_seq` does its increment with `insert … on conflict do
   * update`, which takes a row lock, so concurrent writers serialize on the
   * counter row rather than both reading the same value. This test would fail if
   * the seq were ever minted with a read-then-write in application code, which
   * is the mistake the no-`next()` rule in seq.ts exists to prevent.
   */
  it('interleaved concurrent writers never collide on a seq', async () => {
    const before = Number((await log.since(spaceId, 0, 1, claims())).nextCursor);

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.rpc(claims(), 'public.create_task', [
          spaceId,
          `concurrent ${String(i)}`,
          memberId,
          '',
          null,
          null,
          null,
          'medium',
          null,
          null,
          null,
          null,
          'attached_to',
          `cmid_${randomUUID()}`,
        ]),
      ),
    );

    const rows = await db.query<{ seq: string }>(
      claims(),
      'select seq from public.workspace_events where space_id = $1 order by seq asc',
      [spaceId],
    );
    const seqs = rows.map((r) => Number(r.seq));
    expect(new Set(seqs).size, 'two writers were handed the same seq').toBe(seqs.length);
    expect(seqs.length).toBeGreaterThan(before);
  });

  it('registers events.poll on the handler registry and answers through it', async () => {
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, { db, config: {} as never });
    expect(registry.has('events.poll')).toBe(true);

    const handler = registry.get('events.poll')!;
    const result = (await handler({
      params: { spaceId },
      query: new URLSearchParams({ since: '0', limit: '10' }),
      requestId: `req_${randomUUID()}`,
      identity: { kind: 'auto-owner', identityId, actorId: memberId },
    } as never)) as { kind: string; data: { items: unknown[]; nextCursor: string | null } };

    expect(result.kind).toBe('json');
    expect(Array.isArray(result.data.items)).toBe(true);
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(result.data.items.length).toBeLessThanOrEqual(10);
    expect(typeof result.data.nextCursor).toBe('string');
  });

  it('refuses a malformed since rather than answering an empty page', async () => {
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, { db, config: {} as never });
    const handler = registry.get('events.poll')!;

    // A 200 with [] here would tell a reconnecting client it had missed nothing.
    await expect(
      handler({
        params: { spaceId },
        query: new URLSearchParams({ since: 'not-a-seq' }),
        requestId: 'req_bad',
        identity: { kind: 'auto-owner', identityId, actorId: memberId },
      } as never),
    ).rejects.toThrow(/since must be a non-negative integer/);
  });

  /**
   * RLS is load-bearing on this path, and 009 exists because it was silently
   * broken: `workspace_events_select` calls claim accessors that sit on
   * `internal.claim_text`, which `tm8_app` could not execute — so the read
   * ABORTED with 42501 rather than filtering. A caller with no membership must
   * get an empty feed, not an error and not somebody else's events.
   */
  it('a non-member sees none of the space feed (RLS, not a filter in our code)', async () => {
    const strangerIdentity = `identity_${randomUUID()}`;
    await db.rpc({ identityId: strangerIdentity }, 'public.upsert_user_profile', ['Stranger', null, null]);

    const { items } = await log.since(spaceId, 0, 500, {
      identityId: strangerIdentity,
      nodeAdmin: false,
      requestId: `req_${randomUUID()}`,
    });
    expect(items).toEqual([]);
  });
});

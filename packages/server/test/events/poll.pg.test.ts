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
import { WorkspaceEventSchema, WORKSPACE_EVENT_SCHEMA_VERSION, type DurableWorkspaceEvent } from '@tm8/contract';

import { HandlerRegistry } from '../../src/facade/index.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
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
  /** A task to anchor messages to. Created once in `beforeAll`. */
  let firstTaskId: string;

  /**
   * Claims for a poll, shaped exactly as the handler builds them.
   *
   * Note what is NOT here: `actorId`. A member row belongs to ONE space, and
   * `internal.resolve_actor` coalesces to `current_member_id(space)`, so binding
   * an actor globally makes a cross-space request raise 42501 for the space's own
   * owner. Leaving it unset lets the database pick the right member row — and
   * this test asserting the read works WITHOUT an actor is what proves it does.
   */
  const claims = (): { identityId: string; nodeAdmin: boolean; requestId: string } => ({
    identityId,
    nodeAdmin: false,
    requestId: `req_${randomUUID()}`,
  });

  /**
   * The owner resolver the handler is given.
   *
   * The handler takes identity from the resolved loopback OWNER, not from
   * `ctx.identity` — that is the one-identity-path rule. So a test that wants the
   * handler to poll as its own fixture identity must inject that identity here;
   * faking it on `ctx` no longer has any effect, which is the point.
   */
  const testOwner = (): Promise<LoopbackOwner> =>
    Promise.resolve({
      identityId,
      accountId: '00000000-0000-0000-0000-000000000000',
      username: 'owner',
      isNodeAdmin: false,
      isOwner: true,
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

    const anchor = await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId,
      'Anchor task',
      memberId,
      '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    firstTaskId = anchor.entity.id;
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
      null, // 172: p_start_date is TWELFTH of fifteen
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
      expect(upsert.entity.state.status).toBe('open');
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
      null, // 172: p_start_date is TWELFTH of fifteen
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
   * REGRESSION: page-size-dependent event loss.
   *
   * `edge.upsert` requires its author hydrated. The mapper used to request only
   * the edge's endpoints, so the event survived ONLY when its author happened to
   * also be an endpoint of some other event in the SAME page. At a large limit
   * the author was practically always present, so the bug was invisible; at a
   * small limit the edge was silently skipped and a polling client lost it.
   *
   * THE PAGE SIZE IS THE ASSERTION, and it is pinned by ISOLATING the edge event
   * rather than by picking a small number and hoping.
   *
   * A first version of this test walked the log at limit=2 and PASSED with the
   * fix reverted — because the edge happened to share its 2-event page with an
   * `activity.created` whose actor was the same member, which hydrated the author
   * by luck. That is precisely the incidental-page-contents flakiness this test
   * must not have. So instead it locates the edge's own seq and polls
   * `since = seq - 1, limit = 1`: a page containing that edge and nothing else.
   * The author then CANNOT be hydrated as a side effect, so the event survives
   * only if the mapper asks for it explicitly. Verified to fail with the fix
   * reverted and pass with it. Do not widen the page.
   */
  it('delivers an edge event in a page that contains only that edge', async () => {
    // A `depends_on` edge between two TASKS, authored by the member.
    //
    // The edge type matters as much as the page size: `created_by` (the member)
    // is NOT either endpoint here, so the author can only be hydrated if the
    // mapper explicitly asks for it. An `assigned_to` edge would point AT the
    // member, hydrating the author as a side effect of the endpoint and hiding
    // the bug this test exists to catch.
    const other = await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId,
      'Dependency target',
      memberId,
      '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    await db.rpc(claims(), 'public.write_edge', [
      firstTaskId,
      other.entity.id,
      'depends_on',
      null,
      memberId,
      `cmid_${randomUUID()}`,
    ]);

    // Every edge event's seq, straight from the log.
    const edgeRows = await db.asOwner((q) =>
      q.query<{ seq: string }>(
        `select seq from public.workspace_events
          where space_id = $1 and event_type = 'edge.upsert' order by seq asc`,
        [spaceId],
      ),
    );
    expect(edgeRows.length, 'fixture must produce at least one edge event').toBeGreaterThan(0);

    for (const { seq } of edgeRows) {
      const edgeSeq = Number(seq);
      // A page of exactly one row: this edge, alone.
      const { items } = await log.since(spaceId, edgeSeq - 1, 1, claims());

      expect(
        items.length,
        `edge event seq ${String(edgeSeq)} was dropped when alone in its page — ` +
          `its author is not being hydrated, so delivery depends on page contents`,
      ).toBe(1);

      const event = items[0]!;
      expect(event.seq).toBe(edgeSeq);
      if (event.type !== 'edge.upsert') throw new Error('unreachable');
      // And the author is the edge's own, not whoever created that member.
      expect(event.edge.createdBy.id).toBe(memberId);
      expect(event.edge.createdBy.displayName.length).toBeGreaterThan(0);
    }
  });

  /**
   * REDACTION. `redact_message` overwrites the row, but the `message.created`
   * event captured at insert time still holds the original text in its payload —
   * so a client replaying from seq 0 would be handed the redacted words unless
   * the mapper reads the live row. This is the assertion that the payload is not
   * the source for message content.
   */
  it('never serves a redacted body, not even from the original captured event', async () => {
    const secret = `SECRET-${randomUUID()}`;
    const posted = await db.rpc<CommandResult>(claims(), 'public.post_message', [
      firstTaskId,
      secret,
      memberId,
      null,
      null,
      null,
      `cmid_${randomUUID()}`,
    ]);
    const messageId = posted.entity.id;

    // Present before redaction — otherwise the test proves nothing.
    const before = await log.since(spaceId, 0, 500, claims());
    expect(
      before.items.some((e) => e.type === 'message.created' && e.message.content.body === secret),
      'the message must be visible before redaction',
    ).toBe(true);

    await db.rpc(claims(), 'public.redact_message', [messageId, memberId, `cmid_${randomUUID()}`]);

    const after = await log.since(spaceId, 0, 500, claims());
    const everything = JSON.stringify(after.items);
    expect(everything.includes(secret), 'the redacted text is still on the event feed').toBe(false);

    const msgEvents = after.items.filter(
      (e) => (e.type === 'message.created' || e.type === 'message.updated') && e.message.id === messageId,
    );
    expect(msgEvents.length).toBeGreaterThan(0);
    for (const e of msgEvents) {
      if (e.type !== 'message.created' && e.type !== 'message.updated') continue;
      expect(e.message.content.body, 'redacted body must be blank, matching entity-read').toBe('');
      expect(e.message.content.mentions).toEqual([]);
      expect(e.message.content.attachments).toEqual([]);
      expect(e.message.excerpt, 'a redacted message has no excerpt').toBeUndefined();
      expect(e.message.state.redactedAt, 'redaction must be explicit to the renderer').toBeTruthy();
    }
  });

  /** TOMBSTONE: a deleted entity must stop announcing its real title. */
  it('a deleted entity is tombstoned on the feed, not titled', async () => {
    const title = `DOOMED-${randomUUID()}`;
    const doomed = await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId,
      title,
      memberId,
      'about to go',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);

    await db.rpc(claims(), 'public.delete_entity', [doomed.entity.id, memberId, `cmid_${randomUUID()}`]);

    const { items } = await log.since(spaceId, 0, 500, claims());
    const mine = items.filter(
      (e) => (e.type === 'entity.upsert' || e.type === 'entity.deleted') && e.entity.id === doomed.entity.id,
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      if (e.type !== 'entity.upsert' && e.type !== 'entity.deleted') continue;
      expect(e.entity.title, 'a deleted entity must be tombstoned').toBe('Deleted');
      expect(e.entity.excerpt, 'a deleted entity has no excerpt').toBeUndefined();
    }
    expect(JSON.stringify(items).includes(title), 'the deleted title is still on the feed').toBe(false);
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
          null, // 172: p_start_date is TWELFTH of fifteen
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
    registerEventHandlers(registry, { db, config: {} as never, owner: testOwner });
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
    registerEventHandlers(registry, { db, config: {} as never, owner: testOwner });
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

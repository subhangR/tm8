/**
 * ACCEPTANCE 3 (LLD §11 + §12): **cursor round-trip integrity on every paged
 * read, with a seeded-count control beside every page assertion.**
 *
 * The class this defends against is not hypothetical. W5 executed a live
 * instance: 9 rows seeded, 3 returned, 6 silently dropped, no error. Nothing
 * about that failure is visible from inside a single page — the page looked
 * complete, the call succeeded, and the caller had no second account to
 * disagree with. So every walk here is bracketed by a count the walk did not
 * produce, and every exact-set assertion compares against rows read straight
 * out of the table.
 *
 * Two paged surfaces are exercised, because they have DIFFERENT termination
 * contracts and only one of them matches the LLD's wording:
 *
 *   - `events.poll` — `nextCursor` is a decimal seq string that the server
 *     ECHOES back on an empty page (poll.ts:126-135). This feed has no end and
 *     never emits `nextCursor: null`, so "a short page without a terminal
 *     marker" cannot be the tripwire here; the empty page is, and the seeded
 *     count is the control.
 *   - `Page<T>` reads through the seam (`messages`) — these DO carry
 *     `nextCursor: Cursor | null`, so the LLD rule applies literally: the walk
 *     asserts termination happened by an explicit null.
 *
 * NEGATIVE CONTROL. Each walker is shown to FAIL on a known-bad input in the
 * same run — a single unpaged read of the same data. A detector that has never
 * been observed to fire responds to truncation exactly as well as it responds
 * to correctness, which is to say not at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MessageView, Page } from '@tm8/contract';

import {
  assertHarnessWiring,
  cmid,
  createSpace,
  createTask,
  groundTruth,
  pollSpine,
  startIntegrationNode,
  type IntegrationNode,
  type SpaceFixture,
} from './node-fixture';
import { createHttpClient } from '../real/http';
import { createOps } from '../real/ops';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

/** The W5 incident's own number, kept deliberately: 9 seeded, 3 returned. */
const SEEDED_MESSAGES = 9;

describe('cursor round-trip integrity (real node)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let anchorId: string;
  let seededMessageIds: string[];

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('cursor_integrity');
    space = await createSpace(node, 'b4 cursor integrity');
    anchorId = await createTask(node, space.spaceId, 'anchor for paged messages');

    seededMessageIds = [];
    for (let i = 1; i <= SEEDED_MESSAGES; i += 1) {
      const res = await node.request<{ messages: Array<{ id: string }> }>('POST', '/v2/messages', {
        anchorIds: [anchorId],
        body: `seeded message ${String(i)} of ${String(SEEDED_MESSAGES)}`,
        clientMutationId: cmid('msg'),
      });
      // MEASURED: `messages.post` answers 200 with a `MessageBatchResult`, not
      // the 201 the entity-creating routes use. Asserted as a range plus a
      // shape check rather than pinned to a literal, so a route that starts
      // answering 204-with-no-body fails here loudly instead of seeding zero
      // messages and letting every count assertion below agree on nothing.
      if (res.status >= 300 || res.data === undefined || !Array.isArray(res.data.messages)) {
        throw new Error(
          `message post failed: status=${String(res.status)} error=${JSON.stringify(res.error)} ` +
            `data=${JSON.stringify(res.data)}`,
        );
      }
      seededMessageIds.push(...res.data.messages.map((m) => m.id));
    }
  });

  afterAll(async () => {
    await node?.close();
  });

  it('the seeded count is real, and the table agrees with it before any walker runs', () => {
    // A positive control BEFORE the thing under test: "the walk returned 9" is
    // equally consistent with "only 9 were ever written". This settles which.
    const rows = node.sql(
      `select count(*) from public.messages where anchor_id = '${anchorId}'`,
    );
    expect(seededMessageIds.length).toBe(SEEDED_MESSAGES);
    expect(new Set(seededMessageIds).size, 'the fixture minted a duplicate message id').toBe(SEEDED_MESSAGES);
    expect(Number(rows[0]?.[0]), 'the table does not hold the number of messages the fixture seeded').toBe(
      SEEDED_MESSAGES,
    );
  });

  it('events.poll: a small-limit walk to exhaustion returns exactly the rows the table holds', async () => {
    const truth = groundTruth(node, space.spaceId, space.memberId, 0);
    expect(truth.visible.length, 'the fixture must have minted a multi-page spine').toBeGreaterThan(6);

    // limit=2 forces genuine paging over a spine of many rows.
    const walked = await pollSpine(node, space.spaceId, 0, 2);

    // (a) the control: paging actually happened. A walk that terminated on its
    //     first page would satisfy the set assertion below only by accident of
    //     a small fixture, and would prove nothing about paging.
    expect(walked.pages, 'the walk did not page — limit=2 returned everything at once').toBeGreaterThan(3);

    // (b) the exact set, against the table. Not a count: a transposition or a
    //     substitution preserves a count.
    expect(walked.spine.map(([seq]) => seq), 'the paged walk does not match the table').toEqual(truth.visible);

    // (c) the measured termination contract for THIS route, asserted rather
    //     than assumed. If a `null` ever appears here the server changed, and
    //     this assertion is where that gets noticed.
    expect(
      walked.sawNullCursor,
      'events.poll emitted nextCursor: null — the server termination contract changed; ' +
        'ops.ts and node-fixture.ts both document that it echoes the caller cursor instead',
    ).toBe(false);
  });

  it('events.poll: THE NEGATIVE CONTROL — a single unpaged read of the same data is caught', async () => {
    const truth = groundTruth(node, space.spaceId, space.memberId, 0);
    // Exactly the shape of the W5 incident: one call, a limit smaller than the
    // data, a successful response, silently short.
    const res = await node.request<{ items: Array<Record<string, unknown>>; nextCursor: string }>(
      'GET',
      `/v2/spaces/${space.spaceId}/events?since=0&limit=3`,
    );
    expect(res.status).toBe(200);
    const short = res.data!.items.map((item) => Number(item['seq']));

    // The read SUCCEEDED and is SHORT — no error anywhere on the path.
    expect(short.length).toBeLessThan(truth.visible.length);
    // …and the assertion the paged walk passes is the assertion this fails.
    // That is what makes the green above discriminating rather than automatic.
    expect(short).not.toEqual(truth.visible);
  });

  it('ops.pollEvents: the REAL client walker agrees with the table too', async () => {
    // The route was proven above; this proves the shipped client's own cursor
    // handling — `toCursor`, the string-to-number coercion, the Math.max
    // monotonicity guard — on the same data. A green route with a broken client
    // coercion would be a false all-clear for the data layer.
    const ops = createOps(createHttpClient({ baseUrl: node.baseUrl, fetch: (u, i) => fetch(u, i) }));
    const truth = groundTruth(node, space.spaceId, space.memberId, 0);

    const seen: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (; pages < 100; pages += 1) {
      const page = await ops.pollEvents(space.spaceId, cursor, 2);
      if (page.items.length === 0) break;
      for (const event of page.items) seen.push(event.seq);
      const next = Number(page.nextCursor);
      expect(Number.isFinite(next), `ops.pollEvents returned an unusable cursor: ${String(page.nextCursor)}`).toBe(true);
      expect(next, 'ops.pollEvents cursor did not advance — the stream would wedge here').toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(pages, 'the client walk did not page').toBeGreaterThan(3);
    expect(seen, 'the shipped client walker does not match the table').toEqual(truth.visible);
    expect(new Set(seen).size, 'the client walker re-delivered a seq across pages').toBe(seen.length);
  });

  it('Page<T> through the seam: messages page to exhaustion and terminate on an explicit null cursor', async () => {
    // This is the surface the LLD rule was written for: `Page<T>` really does
    // carry `nextCursor: Cursor | null`, so "a short page without a terminal
    // marker is a signal, not a pass" applies literally and is asserted.
    const http = createHttpClient({ baseUrl: node.baseUrl, fetch: (u, i) => fetch(u, i) });
    const ops = createOps(http);

    const collected: MessageView[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let terminatedOnNull = false;
    for (; pages < 50; pages += 1) {
      const page: Page<MessageView> = await ops.messages(anchorId, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      collected.push(...page.items);
      if (page.nextCursor === null || page.nextCursor === undefined) {
        terminatedOnNull = page.nextCursor === null;
        pages += 1;
        break;
      }
      expect(page.items.length, 'a non-terminal page came back empty while still offering a cursor').toBeGreaterThan(0);
      cursor = page.nextCursor;
    }

    expect(pages, 'the message walk did not page — limit=2 returned everything at once').toBeGreaterThan(3);
    expect(
      terminatedOnNull,
      'the message walk did not terminate on an explicit nextCursor: null — LLD §11 rules a short ' +
        'page without a terminal marker a signal, not a pass',
    ).toBe(true);

    // THE SEEDED-COUNT CONTROL, beside the page assertion as required.
    expect(collected.length, 'the paged message walk returned a different count than was seeded').toBe(
      SEEDED_MESSAGES,
    );
    // …and the exact set, because a count cannot detect a substitution.
    expect([...collected.map((m) => m.id)].sort()).toEqual([...seededMessageIds].sort());
  });

  it('Page<T>: THE NEGATIVE CONTROL — one unpaged messages read is short and is caught', async () => {
    const ops = createOps(createHttpClient({ baseUrl: node.baseUrl, fetch: (u, i) => fetch(u, i) }));
    const page = await ops.messages(anchorId, { limit: 3 });
    expect(page.items.length).toBeLessThan(SEEDED_MESSAGES);
    expect(page.items.length, 'the truncated read must still LOOK successful').toBe(3);
    // The page announces there is more — which is the honest case, and exactly
    // what a caller who ignores the cursor would silently drop.
    expect(page.nextCursor, 'a short page that claims to be terminal is the W5 defect itself').not.toBeNull();
    expect(page.items.map((m) => m.id)).not.toEqual(seededMessageIds);
  });
});

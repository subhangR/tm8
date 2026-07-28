/**
 * W5 Duo C — `messages.delivery.get`: THE FIRST BEHAVIOURAL GATE THIS OPERATION
 * HAS EVER HAD.
 *
 * ── WHY THIS OPERATION AND WHY IT IS FIRST ─────────────────────────────────
 * The never-gated list was characterised before anything was built here, and
 * this operation came out thinnest of all of them: its only test-tree mentions
 * are MOCK-DB WIRING (`test/w2/messages-handoffs.test.ts`, a `FakeDb` call
 * recorder) and ENUMERATION (mount-set and `INPUT_SCHEMAS`-defined lists in
 * `rolling-public.integration.test.ts`, plus the conformance manifests).
 * **ZERO real-Postgres mentions of any kind — not even as a string.** No
 * SQL-layer contact at all.
 *
 * ── WHAT THIS FILE ADDS THAT THE SWEEP DID NOT ─────────────────────────────
 * `sweep.test.ts` touches this operation exactly ONCE, with a nonexistent uuid,
 * and records that it reaches handler code. THAT IS REACH, NOT BEHAVIOUR. It
 * says nothing about which branch ran or whether the branch is correct. This
 * file drives the branches that exist in
 * `services/w2/messages-handoffs.ts:427-455`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT COVER, STATED SO NOBODY READS IT WIDER ───
 * It seeds NO `session_message_deliveries` rows. Producing one requires the
 * live delivery path, which needs a second database identity authenticating as
 * `tm8_delivery_worker` — the program exercised that exactly once, against a
 * hand-supplied credential on a TRUST-auth dev cluster, which is not a default
 * configuration. So this file gates the EMPTY-LIST and REFUSAL branches, and the
 * populated-page branch REMAINS UNGATED and is named here rather than left to be
 * discovered as an absence.
 *
 * The keyset ordering `(reserved_at, delivery_id)` at `:450` is a CURSOR
 * question and cursors are Duo B's surface. This file does not assert cursor
 * precision and any observation about it is routed there rather than duplicated.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';

import { encodeCursor } from '@tm8/contract';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

/**
 * Both defaults at one point — `testTimeout` 5s and `hookTimeout` 10s are set
 * independently and a generous `beforeAll` covers neither. This file drives a
 * real Server and its teardown drops a scratch database. Both spellings have
 * been mutation-proved in effect elsewhere in this directory.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ABSENT = '01900000-0000-7000-8000-000000000001';

interface DeliveryView {
  readonly message: { readonly id: string };
  readonly deliveries: readonly unknown[];
}

describe('W5.C G04 messages.delivery.get — behavioural branches', () => {
  let server: SurfaceServer;
  let messageId = '';
  let otherMessageId = '';

  beforeAll(async () => {
    server = await startSurfaceServer('g04delivery');

    const space = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-g04-space', name: 'W5C G04',
    });
    const sd = (space.json as {
      data?: { space?: { id?: string }; defaultChannelId?: string };
    }).data;

    const post = async (cmid: string, body: string): Promise<string> => {
      const posted = await server.request('POST', '/v2/messages', {
        clientMutationId: cmid, anchorIds: [sd?.defaultChannelId], body,
      });
      const id = (posted.json as { data?: { messages?: Array<{ id?: string }> } })
        .data?.messages?.[0]?.id;
      if (!id) throw new Error(`fixture could not post a message: ${JSON.stringify(posted.json)}`);
      return id;
    };

    messageId = await post('w5c-g04-msg-1', 'w5c delivery probe');
    otherMessageId = await post('w5c-g04-msg-2', 'w5c delivery probe two');
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  /**
   * The branch the existing sweep row actually exercised, now pinned with its
   * MESSAGE rather than only its status — `loadOneMessage` (`:273`) is the
   * thrower, and its text names the id.
   */
  it('refuses an unknown message with not_found, from loadOneMessage', async () => {
    const response = await server.request('GET', `/v2/messages/${ABSENT}/delivery`, undefined);
    expect(response.status).toBe(404);
    expect(response.errorCode).toBe('not_found');
    expect(response.errorMessage).toBe(`no readable message: ${ABSENT}`);
  });

  /**
   * THE BRANCH NOTHING HAS EVER EXERCISED: a REAL message with no deliveries.
   *
   * This is the one that matters, because it distinguishes "the operation
   * works and there is nothing to show" from "the operation cannot read its own
   * table". A handler that threw on an empty result would have been invisible to
   * every existing test, all of which either mock the db or never call it.
   */
  it('returns the message and an EMPTY delivery list for a real message', async () => {
    const response = await server.request('GET', `/v2/messages/${messageId}/delivery`, undefined);
    expect(
      response.status,
      `delivery.get on a real message: ${JSON.stringify(response.json)}`,
    ).toBe(200);

    const view = (response.json as { data?: DeliveryView }).data!;
    expect(view.deliveries).toEqual([]);
    // The message half of the view must be the message we asked for — a handler
    // that returned SOME message would satisfy an emptiness assertion alone.
    expect(view.message.id).toBe(messageId);
  });

  /**
   * THE FINGERPRINT GUARD AT `:437`, AND IT IS THE ONE WORTH HAVING.
   *
   * The cursor's first key is `fingerprint({operation, messageId})`. A cursor
   * minted for a DIFFERENT message is structurally valid, decodes cleanly, and
   * is refused only by that comparison. Without the guard it would page one
   * message's deliveries under another message's cursor.
   *
   * BOTH HALVES: the wrong-message cursor is REFUSED, and a structurally
   * identical cursor differing ONLY in the fingerprint field is refused too —
   * so the refusal tracks the fingerprint and not merely "an unfamiliar cursor".
   */
  it('refuses a cursor minted for a DIFFERENT message', async () => {
    // A cursor whose shape is exactly right (3 keys) but whose fingerprint
    // belongs to another message.
    const foreign = encodeCursor(['not-this-messages-fingerprint', '2026-01-01T00:00:00.000Z', ABSENT]);

    const response = await server.request(
      'GET', `/v2/messages/${messageId}/delivery?cursor=${encodeURIComponent(foreign)}`, undefined,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.errorCode).toBe('invalid_cursor');
    expect(response.errorMessage).toBe('cursor does not match this delivery list');
  });

  /**
   * ⚠ THE POSITIVE HALF OF THE FINGERPRINT GUARD, AND THE FILE WAS WORTHLESS
   * WITHOUT IT.
   *
   * Every cursor test above is a REFUSAL. **A GUARD CAN PASS EVERY NEGATIVE
   * EVER WRITTEN BY REFUSING EVERYONE** — a handler that rejected all cursors
   * unconditionally satisfies all of them. This mints a cursor with the CORRECT
   * fingerprint and requires it to be ACCEPTED.
   *
   * `fingerprint` is module-private in the service, so it is reproduced here:
   * `sha256(JSON.stringify({operation, messageId}))`, hex, with the key order
   * the production literal at `:431` uses. THAT RE-IMPLEMENTATION IS THIS
   * TEST'S OWN WEAK POINT and it is named rather than hidden — if the minted
   * cursor is refused with 'cursor does not match this delivery list', the most
   * likely cause is THIS RE-IMPLEMENTATION DRIFTING, not the guard breaking.
   * The failure message says so, so a future reader does not file a defect
   * against the handler for a defect in the probe.
   */
  it('POSITIVE: a cursor with the CORRECT fingerprint is ACCEPTED', async () => {
    const fp = createHash('sha256')
      .update(JSON.stringify({ operation: 'messages.delivery.get', messageId }))
      .digest('hex');
    // Keyset past every possible row, so acceptance yields an empty page rather
    // than depending on seeded data.
    const valid = encodeCursor([fp, '2099-01-01T00:00:00.000Z', ABSENT]);

    const response = await server.request(
      'GET', `/v2/messages/${messageId}/delivery?cursor=${encodeURIComponent(valid)}`, undefined,
    );

    expect(
      response.status,
      'A correctly-fingerprinted cursor was REFUSED. Before filing this against the handler, check '
        + 'whether this test\'s re-implementation of the private `fingerprint()` has drifted from '
        + 'services/w2/messages-handoffs.ts:186 — including the key ORDER of the object literal at '
        + `:431. Response: ${JSON.stringify(response.json)}`,
    ).toBe(200);
    expect(response.errorCode).toBeNull();
    expect((response.json as { data?: DeliveryView }).data!.deliveries).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL FOR THE GUARD ABOVE. A wrong-SHAPE cursor must be refused
   * by `decodeCursor` with a DIFFERENT message, proving the fingerprint check is
   * a distinct gate rather than the only thing rejecting everything.
   *
   * Without this, the previous test passes just as well against a handler that
   * refuses every cursor unconditionally.
   */
  it('CONTROL: a malformed cursor is refused by decodeCursor, not by the fingerprint check', async () => {
    const response = await server.request(
      'GET', `/v2/messages/${messageId}/delivery?cursor=not-base64url-json`, undefined,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.errorCode).toBe('invalid_cursor');
    // The decodeCursor path names WHY; the fingerprint path says "does not
    // match this delivery list". They must not be the same string, or the
    // previous test proves nothing about the fingerprint.
    expect(response.errorMessage).not.toBe('cursor does not match this delivery list');
    expect(response.errorMessage).toMatch(/invalid cursor:/);
  });

  /**
   * The offset-cursor refusal (DEV-5). A numeric cursor is a different class of
   * client error and `cursor.ts:52` names it specifically.
   */
  it('refuses an offset-shaped cursor by name (DEV-5)', async () => {
    const response = await server.request(
      'GET', `/v2/messages/${messageId}/delivery?cursor=42`, undefined,
    );
    expect(response.errorCode).toBe('invalid_cursor');
    expect(response.errorMessage).toMatch(/offset cursors are not part of the contract/);
  });

  /**
   * `limit` is clamped at `:430` — `Math.min(limitOf(raw, 50), 100)`. With no
   * rows seeded this cannot observe the clamp's EFFECT on a page, so it asserts
   * only what it can: an over-large limit is ACCEPTED rather than refused, which
   * is the branch a 400 would break.
   *
   * STATED PLAINLY: this does NOT prove the clamp works. It proves the clamp
   * does not reject. The populated-page assertion needs seeded deliveries and is
   * named in this file's header as ungated.
   */
  it('accepts an over-large limit rather than refusing it (clamp not observable without rows)', async () => {
    const response = await server.request(
      'GET', `/v2/messages/${messageId}/delivery?limit=100000`, undefined,
    );
    expect(response.status).toBe(200);
    expect((response.json as { data?: DeliveryView }).data!.deliveries).toEqual([]);
  });

  /**
   * Cross-message isolation, which the fingerprint guard exists to protect: two
   * distinct real messages each answer about THEMSELVES.
   */
  it('answers about the message in the path, not some other message', async () => {
    const first = await server.request('GET', `/v2/messages/${messageId}/delivery`, undefined);
    const second = await server.request('GET', `/v2/messages/${otherMessageId}/delivery`, undefined);

    expect((first.json as { data?: DeliveryView }).data!.message.id).toBe(messageId);
    expect((second.json as { data?: DeliveryView }).data!.message.id).toBe(otherMessageId);
    expect(messageId).not.toBe(otherMessageId);
  });
});

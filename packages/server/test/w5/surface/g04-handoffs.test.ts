/**
 * W5 Duo C — `handoffs.send` / `handoffs.list` / `handoffs.withdraw`: THE FIRST
 * BEHAVIOURAL GATE ANY OF THE THREE HAS EVER HAD.
 *
 * ── THE PREMISE, CHARACTERISED BEFORE ANYTHING WAS BUILT ───────────────────
 * Three operations, ZERO behavioural assertions at either layer. Their entire
 * test-tree presence is MOCK-DB WIRING (`test/w2/messages-handoffs.test.ts`,
 * `new FakeDb()` at :256 — proves the handler calls the right RPC with the right
 * args, not what happens), ENUMERATION (mount-set and `INPUT_SCHEMAS`-defined
 * lists in `rolling-public.integration.test.ts`; the conformance manifests), and
 * two sites in `test/db/**` where `'handoffs.withdraw'` is a STRING VALUE in an
 * `undo_tokens.operation` column — an undo-ledger gate that exercises no handoff
 * behaviour at all. The premise survived: this surface was genuinely ungated.
 *
 * ── WHAT IS REACHABLE HERE AND WHAT IS NOT, MEASURED NOT ASSUMED ───────────
 * `w2_prepare_handoff` and `w2_withdraw_handoff` are NOT among the functions
 * gated by `internal.require_delivery_principal`. That was measured from the
 * live catalog on the landed 37-chain: EXACTLY THREE functions call it —
 * `reserve_`, `claim_` and `settle_session_message_delivery` — with `--`
 * comments stripped before matching, because `pg_get_functiondef` returns
 * comments and a bare substring match counts a function that merely mentions the
 * guard.
 *
 * So the REFUSAL and EMPTY-LIST branches of all three are drivable with no
 * delivery principal. What is NOT drivable is a POPULATED handoff list: seeding
 * one needs the delivery path, and post-039 `require_delivery_principal` demands
 * `session_user` alone — measured: `pg_has_role('tm8_app','tm8_delivery_worker',
 * 'USAGE')` is FALSE, and EXECUTE on all three delivery RPCs is held only by
 * `tm8_graph_owner` and `tm8_delivery_worker`. THAT IS A MEASURED BOUNDARY, NOT
 * A GAP IN EFFORT, and it is named here rather than left to be discovered.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';

import { encodeCursor } from '@tm8/contract';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ABSENT = '01900000-0000-7000-8000-000000000001';

/**
 * Reproduces the service's module-private `fingerprint()` at `:186` —
 * `sha256(JSON.stringify(value))` hex — with the exact key order of the literal
 * at `:530-532`. THIS RE-IMPLEMENTATION IS THIS FILE'S OWN WEAK POINT: if a
 * cursor built from it is refused, suspect drift here before suspecting the
 * guard. Every assertion that depends on it says so in its failure message.
 */
function listFingerprint(
  targetWorkSessionId: string,
  deliveryStatuses: readonly string[],
  recordStatuses: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      operation: 'handoffs.list', targetWorkSessionId, deliveryStatuses, recordStatuses,
    }))
    .digest('hex');
}

const cursorFor = (fp: string): string =>
  encodeCursor([fp, '2099-01-01T00:00:00.000Z', 'zzzz']);

describe('W5.C G04 handoffs.* — behavioural branches', () => {
  let server: SurfaceServer;
  let channelId = '';

  beforeAll(async () => {
    server = await startSurfaceServer('g04handoffs');
    const space = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-ho-space', name: 'W5C Handoffs',
    });
    channelId = (space.json as { data?: { defaultChannelId?: string } }).data?.defaultChannelId ?? '';
    expect(channelId).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  // ── handoffs.list ────────────────────────────────────────────────────────

  /**
   * `handoffList` runs a plain filtered query and NEVER checks that the work
   * session exists. So an unknown session is an EMPTY PAGE, not a 404 — pinned
   * as an exact behaviour because it is the kind of thing a later "add a
   * not_found guard" change would silently alter, and because it differs from
   * `messages.delivery.get`, whose sibling read DOES 404 via `loadOneMessage`.
   */
  it('answers an unknown work session with an EMPTY PAGE, not not_found', async () => {
    const response = await server.request('GET', `/v2/work-sessions/${ABSENT}/handoffs`, undefined);
    expect(response.status).toBe(200);
    const page = (response.json as { data?: { items: unknown[]; nextCursor: string | null } }).data!;
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses an unsupported deliveryStatus by name', async () => {
    const response = await server.request(
      'GET', `/v2/work-sessions/${ABSENT}/handoffs?deliveryStatus=nonsense`, undefined,
    );
    expect(response.status).toBe(400);
    expect(response.errorCode).toBe('invalid_input');
    expect(response.errorMessage).toBe('deliveryStatus contains an unsupported status');
  });

  /**
   * CONTROL FOR THE ABOVE. A refusal test is worthless if EVERY value is
   * refused — the enum guard would then be indistinguishable from a broken
   * filter. These are the real members of `HANDOFF_DELIVERY_STATUSES` (`:171`)
   * and `HANDOFF_RECORD_STATUSES` (`:174`) and each must be ACCEPTED.
   */
  it('CONTROL: every declared status value is accepted', async () => {
    for (const status of ['prepared', 'dispatching', 'delivered', 'refused', 'unknown']) {
      const r = await server.request(
        'GET', `/v2/work-sessions/${ABSENT}/handoffs?deliveryStatus=${status}`, undefined,
      );
      expect(r.status, `deliveryStatus=${status} must be accepted`).toBe(200);
    }
    for (const status of ['pending', 'recorded', 'failed', 'withdrawn']) {
      const r = await server.request(
        'GET', `/v2/work-sessions/${ABSENT}/handoffs?recordStatus=${status}`, undefined,
      );
      expect(r.status, `recordStatus=${status} must be accepted`).toBe(200);
    }
  });

  /**
   * ⚠ THE ONE THAT MATTERS MOST IN THIS FILE — A DOCUMENTED INVARIANT THAT HAD
   * NO TEST.
   *
   * `enumFilter` at `:234-237` carries this comment, in the source, unwired:
   *
   *   "Canonical order. The SQL matches with `= any(...)`, which is order
   *    insensitive, so two spellings of one filter must not fingerprint
   *    differently or a keyset cursor would be rejected across an equivalent
   *    reordered request."
   *
   * That is a real correctness property — a client paging with
   * `?deliveryStatus=refused&deliveryStatus=prepared` and then re-issuing the
   * same filters in the other order would have its cursor REFUSED mid-walk —
   * and this program's dominant finding is that A COMMENT PREVENTS THE BUG IN
   * THE FILE IT IS WRITTEN IN AND NOWHERE ELSE. So it is wired to something that
   * fails: one cursor, minted once, ACCEPTED under both orderings and under a
   * duplicated spelling.
   */
  it('accepts one cursor across REORDERED and DUPLICATED equivalent filters (the :234 invariant)', async () => {
    // Canonical order is the declaration order of the Set, so the service
    // normalises both spellings to ['prepared','refused'].
    const fp = listFingerprint(ABSENT, ['prepared', 'refused'], []);
    const cursor = cursorFor(fp);
    const q = encodeURIComponent(cursor);

    const spellings = [
      'deliveryStatus=prepared&deliveryStatus=refused',
      'deliveryStatus=refused&deliveryStatus=prepared', // REORDERED
      'deliveryStatus=refused&deliveryStatus=prepared&deliveryStatus=refused', // DUPLICATED
    ];

    for (const spelling of spellings) {
      const r = await server.request(
        'GET', `/v2/work-sessions/${ABSENT}/handoffs?${spelling}&cursor=${q}`, undefined,
      );
      expect(
        r.status,
        `The :234-237 comment promises this cursor survives "${spelling}". It did not: `
          + `${r.errorCode} ${r.errorMessage}. Before filing against enumFilter, check whether this `
          + "file's copy of the private fingerprint() has drifted from :186/:530.",
      ).toBe(200);
    }
  });

  /**
   * THE NEGATIVE HALF OF THE SAME GUARD. A cursor minted for a GENUINELY
   * DIFFERENT filter set must be REFUSED — otherwise the acceptance above is
   * satisfied by a handler that ignores the fingerprint entirely, and the guard
   * would let one filter's keyset page another filter's rows.
   */
  it('refuses a cursor minted for a DIFFERENT filter set', async () => {
    const cursor = cursorFor(listFingerprint(ABSENT, ['prepared'], []));
    const response = await server.request(
      'GET',
      `/v2/work-sessions/${ABSENT}/handoffs?deliveryStatus=delivered&cursor=${encodeURIComponent(cursor)}`,
      undefined,
    );
    expect(response.status).toBe(400);
    expect(response.errorCode).toBe('invalid_cursor');
    expect(response.errorMessage).toBe('cursor does not match this handoff list');
  });

  /** And a different SESSION is a different fingerprint too, not just filters. */
  it('refuses a cursor minted for a DIFFERENT work session', async () => {
    const cursor = cursorFor(listFingerprint(
      '01900000-0000-7000-8000-0000000000ff', [], [],
    ));
    const response = await server.request(
      'GET', `/v2/work-sessions/${ABSENT}/handoffs?cursor=${encodeURIComponent(cursor)}`, undefined,
    );
    expect(response.errorCode).toBe('invalid_cursor');
    expect(response.errorMessage).toBe('cursor does not match this handoff list');
  });

  /**
   * CONTROL: a malformed cursor is refused by `decodeCursor` with a DIFFERENT
   * message, so the fingerprint refusals above are a distinct gate rather than
   * the only thing rejecting every cursor.
   */
  it('CONTROL: a malformed cursor fails in decodeCursor, not the fingerprint check', async () => {
    const response = await server.request(
      'GET', `/v2/work-sessions/${ABSENT}/handoffs?cursor=not-base64url`, undefined,
    );
    expect(response.errorCode).toBe('invalid_cursor');
    expect(response.errorMessage).not.toBe('cursor does not match this handoff list');
    expect(response.errorMessage).toMatch(/invalid cursor:/);
  });

  // ── handoffs.withdraw ────────────────────────────────────────────────────

  it('refuses withdrawing an unknown handoff with not_found', async () => {
    const response = await server.request('POST', `/v2/handoffs/${ABSENT}/withdraw`, {
      clientMutationId: 'w5c-ho-withdraw', expectedRecordVersion: 1,
    });
    expect(response.status).toBe(404);
    expect(response.errorCode).toBe('not_found');
    expect(response.errorMessage).toBe('handoff not found');
  });

  // ── handoffs.send ────────────────────────────────────────────────────────

  /**
   * `w2_prepare_handoff` resolves the TARGET work session first. With a
   * nonexistent target it answers `not_found` naming the target specifically —
   * distinct from `handoffs.withdraw`'s "handoff not found", which is what makes
   * this an assertion about THIS operation rather than about a shared error.
   */
  it('refuses sending to an unknown target work session, naming the TARGET', async () => {
    const response = await server.request('POST', `/v2/work-sessions/${ABSENT}/handoffs`, {
      clientMutationId: 'w5c-ho-send', sourceEntityId: channelId,
    });
    expect(response.status).toBe(404);
    expect(response.errorCode).toBe('not_found');
    expect(response.errorMessage).toBe('handoff target not found');
    // The two operations must not be collapsing to one shared message.
    expect(response.errorMessage).not.toBe('handoff not found');
  });

  /**
   * `handoffs.send` IS schema-bound (`SendHandoffInputSchema`), unlike
   * `handoffs.list`. So a missing required field is refused at `server.ts:166`
   * with the validation frame's own literal, BEFORE the handler runs — which
   * distinguishes it from the `not_found` above and pins which layer refuses.
   */
  it('refuses a schema-invalid send body at :166, before the handler', async () => {
    const response = await server.request('POST', `/v2/work-sessions/${ABSENT}/handoffs`, {
      clientMutationId: 'w5c-ho-send-bad',
      // sourceEntityId omitted
    });
    expect(response.status).toBe(400);
    expect(response.errorCode).toBe('invalid_input');
    expect(response.errorMessage).toBe('request body failed contract validation');
  });
});

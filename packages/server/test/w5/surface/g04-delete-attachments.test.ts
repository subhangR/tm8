/**
 * W5 Duo C — `messages.delete` + `messages.attachments.add` / `.remove`: THE
 * FIRST BEHAVIOURAL GATE ANY OF THE THREE HAS EVER HAD.
 *
 * ── THE PREMISE, AND THE TRAP IN ITS COUNTER-EVIDENCE ──────────────────────
 * `messages.delete` appears in 14 files and THREE of them are real-Postgres or
 * real-public-surface, which looks like coverage. IT IS NOT.
 * `test/w3/g03-public.test.ts:231,264,286` uses `'messages.delete'` as the VALUE
 * of an `undo_tokens.operation` COLUMN while exercising `place_entity`'s embed
 * branch and undo redemption — **it never calls `DELETE /v2/messages/:id`.** The
 * same shape holds at five more `test/db/**` sites. Every "real" hit is the
 * operation NAME USED AS DATA, not the operation invoked. A file-level coverage
 * reading gets this exactly backwards.
 *
 * ── WHAT "DELETE" ACTUALLY IS HERE ─────────────────────────────────────────
 * Measured, not assumed: a successful delete sets `messages.redacted_at`, blanks
 * the body to `[redacted]`, and bumps `entities.version` — but leaves
 * `entities.deleted_at` **NULL**. It is a REDACTION, not a row tombstone, which
 * matters because `deleted_at is null` is the predicate other reads filter on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ABSENT = '01900000-0000-7000-8000-000000000001';

interface MessageRow { readonly id: string; readonly version: number }

describe('W5.C G04 messages.delete + attachments — behavioural branches', () => {
  let server: SurfaceServer;
  let spaceId = '';
  let channelId = '';

  async function post(cmid: string): Promise<MessageRow> {
    const r = await server.request('POST', '/v2/messages', {
      clientMutationId: cmid, anchorIds: [channelId], body: `w5c delete probe ${cmid}`,
    });
    const m = (r.json as { data?: { messages?: MessageRow[] } }).data?.messages?.[0];
    if (!m) throw new Error(`fixture could not post a message: ${JSON.stringify(r.json)}`);
    return m;
  }

  const del = (id: string, cmid: string, expectedVersion: number) =>
    server.request('DELETE', `/v2/messages/${id}`, { clientMutationId: cmid, expectedVersion });

  async function dbRow(id: string) {
    const rows = await server.database.query<{
      version: number; deleted_at: string | null; redacted_at: string | null; body: string;
    }>(
      `select e.version, e.deleted_at::text, m.redacted_at::text, m.body
         from public.entities e join public.messages m on m.entity_id = e.id
        where e.id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    server = await startSurfaceServer('g04del');
    const sp = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-del-space', name: 'W5C Delete',
    });
    const sd = (sp.json as { data?: { space?: { id: string }; defaultChannelId?: string } }).data;
    spaceId = sd?.space?.id ?? '';
    channelId = sd?.defaultChannelId ?? '';
    expect(channelId).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  // ── messages.delete ──────────────────────────────────────────────────────

  it('refuses deleting an unknown message with not_found', async () => {
    const r = await del(ABSENT, 'w5c-del-unknown', 1);
    expect(r.status).toBe(404);
    expect(r.errorCode).toBe('not_found');
    expect(r.errorMessage).toBe('message not found');
  });

  it('refuses a WRONG expectedVersion on a LIVE message with version_conflict', async () => {
    const m = await post('w5c-del-live-ver');
    const r = await del(m.id, 'w5c-del-live-ver-try', 99);
    expect(r.status).toBe(409);
    expect(r.errorCode).toBe('version_conflict');
  });

  /**
   * The happy path, asserted AT THE ROW rather than only in the envelope, and
   * recording that this is a REDACTION: `redacted_at` set, body blanked,
   * version bumped, `deleted_at` STILL NULL.
   */
  it('redacts on delete — body blanked, redacted_at set, deleted_at still NULL', async () => {
    const m = await post('w5c-del-happy');
    const before = await dbRow(m.id);
    expect(before?.redacted_at).toBeNull();
    expect(before?.deleted_at).toBeNull();

    const r = await del(m.id, 'w5c-del-happy-go', m.version);
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const after = await dbRow(m.id);
    expect(after?.body).toBe('[redacted]');
    expect(after?.redacted_at).not.toBeNull();
    expect(after?.version).toBe(m.version + 1);
    // NOT a row tombstone. Pinned because `deleted_at is null` is the predicate
    // other reads filter on, so this distinction is load-bearing elsewhere.
    expect(after?.deleted_at).toBeNull();
  });

  /** The ledger path: the SAME cmid replayed is admitted and does not re-redact. */
  it('admits a same-cmid replay of a delete (idempotent retry)', async () => {
    const m = await post('w5c-del-replay');
    const first = await del(m.id, 'w5c-del-replay-go', m.version);
    expect(first.status).toBe(200);
    const afterFirst = await dbRow(m.id);

    const replay = await del(m.id, 'w5c-del-replay-go', m.version);
    expect(replay.status).toBe(200);

    const afterReplay = await dbRow(m.id);
    expect(afterReplay?.version, 'a replay must not bump the version again').toBe(afterFirst?.version);
    expect(afterReplay?.redacted_at).toBe(afterFirst?.redacted_at);
  });

  /**
   * ⚠ CHARACTERISATION OF A MEASURED ASYMMETRY — READ THE DISPOSITION BEFORE
   * CHANGING THIS TEST.
   *
   * MECHANISM, read from `019_w2_messages_handoffs.sql:316-321`: BOTH the
   * version check AND the authorization check sit INSIDE
   * `if message.redacted_at is null then`:
   *
   *     if message.redacted_at is null then
   *       perform internal.assert_version(p_message_id, p_expected_version);
   *       if message.author_id <> actor and not can_act_as(...) and not is_space_admin(...)
   *         then raise 'only the author or a space admin may tombstone this message';
   *       end if;
   *       ... redact ...
   *     end if;
   *
   * SO ON AN ALREADY-REDACTED MESSAGE, A **FRESH** cmid WITH **ANY**
   * `expectedVersion` — measured at 999 — RETURNS 200. Both checks are skipped.
   *
   * WHAT THIS IS **NOT**: it is not a data-loss or content-disclosure defect.
   * The second call changes nothing, the body is already `[redacted]`, and
   * `internal.require_space_member` at `:314` sits OUTSIDE the branch and is
   * still enforced — so a non-member cannot reach it at all.
   *
   * WHAT IT **IS**: the API reports 200 to a request whose stated precondition
   * is false. A caller cannot use `expectedVersion` to detect that its view is
   * stale, on this operation, once the message is redacted. **THE CONTRAST IS
   * THE EVIDENCE:** `entities.patch` refuses the structurally identical case
   * with `409 version_conflict` — asserted below so this is a measured
   * asymmetry between two operations, not an opinion about one.
   *
   * ⚠ AND THE GOVERNING AUTHORITY IS EXPLICIT, WHICH LIFTS THIS ABOVE AN
   * INTERNAL INCONSISTENCY. `TM8-W0-AMENDMENT-DOSSIER.md:82` — the frozen
   * contract, not a plan document — records the amendment for these operations
   * verbatim as:
   *
   *     | `messages.edit`, `messages.delete` | required `expectedVersion` … |
   *
   * and `TM8-W0-CONSISTENCY-MATRICES.md:99` row 47 tags `messages.delete`
   * `A expectedVersion` / `CR,W0-VERSION`. **REQUIRED, WITH NO EXCEPTION FOR AN
   * ALREADY-REDACTED MESSAGE.** So this is a contract-versus-implementation
   * divergence measured at the public boundary, and §21.3 governs it: when a
   * document and the frozen contract disagree, THE CONTRACT WINS.
   *
   * CHECKED AGAINST `docs/` BEFORE FILING, per the rule that a gap register is a
   * finding already filed: the 14-row gap register in
   * `docs/plans/TM8-CHAT-SYSTEM-DESIGN.md` §8 carries NO row for this, and no
   * doc mentions `w2_tombstone_message`'s version behaviour. NOT A REDISCOVERY.
   *
   * DISPOSITION (pin class: PRODUCTION state, so a disposition is mandatory).
   * If this is ruled DELIBERATE IDEMPOTENCY, keep this test as the record of
   * the asymmetry and rename it to say so. If it is ruled a DEFECT, the fix is
   * to hoist `assert_version` above the `redacted_at is null` guard, and THIS
   * TEST THEN GOES RED — invert it to expect 409 and record before/after. Do
   * NOT relax it to accept either outcome: that would make it satisfied by both
   * worlds and it would stop being evidence about anything.
   */
  it('CHARACTERISATION: delete skips expectedVersion once redacted, unlike entities.patch', async () => {
    const m = await post('w5c-del-asym');
    expect((await del(m.id, 'w5c-del-asym-1', m.version)).status).toBe(200);

    // FRESH cmid, absurd version, on the already-redacted message.
    const bogus = await del(m.id, 'w5c-del-asym-2-FRESH', 999);
    expect(
      bogus.status,
      'If this is now 409, the version check has been hoisted above the redacted_at guard at '
        + '019:316. That is the fix arriving — invert this test to expect 409, record before/after.',
    ).toBe(200);

    // THE CONTRAST, driven in the same run so the asymmetry is measured rather
    // than recalled: entities.patch refuses the identical shape.
    const e = await server.request('POST', '/v2/entities', {
      clientMutationId: 'w5c-del-asym-doc', spaceId, kind: 'doc', title: 'Asym',
    });
    const eid = (e.json as { data?: { entity?: { id: string } } }).data!.entity!.id;
    await server.request('PATCH', `/v2/entities/${eid}`, {
      clientMutationId: 'w5c-del-asym-p1', expectedVersion: 1, title: 'once',
    });
    const patchStale = await server.request('PATCH', `/v2/entities/${eid}`, {
      clientMutationId: 'w5c-del-asym-p2-FRESH', expectedVersion: 1, title: 'twice',
    });
    expect(patchStale.status, 'the contrast operation must still enforce').toBe(409);
    expect(patchStale.errorCode).toBe('version_conflict');
  });

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * ⚠ THE HANDLER'S OWN VALIDATION IS SHADOWED ON THE HTTP PATH.
   *
   * `updateAttachments` checks `fileIds.length === 0` (`:417`) and `uniqueIds`
   * enforces at-most-16-unique (`:213-218`). BOTH ARE UNREACHABLE VIA HTTP:
   * `AddMessageAttachmentsInputSchema` is bound in `INPUT_SCHEMAS`, so an empty
   * array, a duplicate and a 17-element array are all refused at
   * `server.ts:166` with the validation frame's own literal, BEFORE the handler
   * runs. The handler checks still guard a non-HTTP caller; they are not
   * redundant. Same shape as `027:1022`'s confirm check, which the contract
   * literal shadows on the HTTP path.
   */
  it('refuses empty / duplicate / oversized fileEntityIds at :166, before the handler', async () => {
    const m = await post('w5c-att-shadow');
    const cases: ReadonlyArray<readonly [string, string[]]> = [
      ['empty', []],
      ['duplicate', [ABSENT, ABSENT]],
      ['seventeen', Array.from({ length: 17 }, (_, i) =>
        `01900000-0000-7000-8000-0000000${(i + 256).toString(16).padStart(5, '0')}`)],
    ];
    for (const [label, fileEntityIds] of cases) {
      const r = await server.request('POST', `/v2/messages/${m.id}/attachments`, {
        clientMutationId: `w5c-att-${label}`, expectedVersion: m.version, fileEntityIds,
      });
      expect(r.status, `${label}: ${JSON.stringify(r.json)}`).toBe(400);
      expect(r.errorCode, label).toBe('invalid_input');
      // The `:166` literal — proving the CONTRACT refused it, not the handler.
      expect(r.errorMessage, label).toBe('request body failed contract validation');
      // And NOT the handler's own message, which would mean it got past :166.
      expect(r.errorMessage, label).not.toBe('fileEntityIds must not be empty');
    }
  });

  it('refuses attaching a file that is not finalized, live and readable', async () => {
    const m = await post('w5c-att-notfinal');
    const r = await server.request('POST', `/v2/messages/${m.id}/attachments`, {
      clientMutationId: 'w5c-att-bogus', expectedVersion: m.version, fileEntityIds: [ABSENT],
    });
    expect(r.status).toBe(404);
    expect(r.errorCode).toBe('not_found');
    expect(r.errorMessage).toBe(
      'attachment file is not finalized, live, readable, or audience compatible',
    );
  });

  it('refuses attachments on an unknown message with not_found', async () => {
    const r = await server.request('POST', `/v2/messages/${ABSENT}/attachments`, {
      clientMutationId: 'w5c-att-nomsg', expectedVersion: 1, fileEntityIds: [ABSENT],
    });
    expect(r.status).toBe(404);
    expect(r.errorMessage).toBe('message not found');
  });

  /**
   * ASYMMETRY BETWEEN add AND remove, pinned because it is genuinely surprising:
   * ADD of a non-attachable file is REFUSED 404, while REMOVE of a file that was
   * never attached SUCCEEDS with 200. Removing a non-attachment is a no-op, so
   * this is defensible — but it is exactly the kind of shape a reader assumes is
   * symmetric, and nothing recorded it before.
   */
  it('remove of a never-attached file is a 200 no-op, unlike add', async () => {
    const m = await post('w5c-att-rm');
    const removed = await server.request('DELETE', `/v2/messages/${m.id}/attachments`, {
      clientMutationId: 'w5c-att-rm-go', expectedVersion: m.version, fileEntityIds: [ABSENT],
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);

    const added = await server.request('POST', `/v2/messages/${m.id}/attachments`, {
      clientMutationId: 'w5c-att-rm-add', expectedVersion: m.version, fileEntityIds: [ABSENT],
    });
    expect(added.status, 'add and remove differ on an unknown file — this is the asymmetry').toBe(404);
  });
});

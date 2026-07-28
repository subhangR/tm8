import { decodeCursor } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.G04-CHAR — behavioural CHARACTERIZATION of `messages.list`.
 *
 * WHY THIS FILE EXISTS, AND WHY ITS ORIGINAL PREMISE WAS WRONG.
 *
 * It was commissioned as a PRE-COMPOSITION baseline, on the reasoning that G04
 * replaces `messages.list` and that after the handover the "before" would be
 * unreconstructable. That reasoning was sound in general and FALSE for this
 * operation, which the author verified rather than assumed:
 * `handlers/w2/messages-handoffs.ts:2` imports `{ messagesList }` from
 * `../messages.js` and registers it verbatim at `:17`. It is the SAME function
 * object before and after composition — same cursor fingerprint recipe, same
 * ordering, same branch structure. There was nothing to lose and no diff to take.
 *
 * The file is kept, and rewritten to the purpose that survives that correction:
 * `messages.list` has NEVER held a W3 verdict — there is no G04 entry in the
 * evidence ledger's §6 — so it is a LIVE, user-visible surface with zero
 * independent public coverage. That hole is real whether or not composition ever
 * touched it, and it must be closed for G04's verdict regardless.
 *
 * CHARACTERIZATION, NOT LAW. Several expectations below record what the
 * production boundary DOES rather than what a dossier says it must. Those are
 * labelled OBSERVED. An OBSERVED value changing is a finding to be judged, not
 * automatically a regression — but it will not change SILENTLY, which is the
 * whole point. The branches prioritised here are the ones where a divergence
 * would never surface as an error to anybody: the roots/replies switch, the
 * cursor accept/reject pair, thread ordering, and the projection's
 * skip-without-signal path.
 *
 * MIGRATIONS: the full official chain via `migrationFiles()`, applied by
 * `startW3PublicServer` -> `createW1ScratchDatabase`. The applied list is
 * asserted below rather than described, so the fixture cannot drift out of the
 * verdict silently.
 */
describe.sequential('W3.G04-CHAR messages.list behavioural characterization', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let anchorId = '';
  let otherAnchorId = '';
  const rootIds: string[] = [];

  /** Bodies in send order, so ordering assertions read as intent not as ids. */
  const ROOT_BODIES = ['char root one', 'char root two', 'char root three'];
  const REPLY_BODIES = ['char reply alpha', 'char reply beta'];

  /** Records a probe without asserting a law, so the value lands in the report. */
  const observed: Record<string, unknown> = {};

  async function makeAnchor(suffix: string): Promise<string> {
    const created = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: `w3-g04char-anchor-${suffix}`,
        spaceId,
        kind: 'task',
        title: `G04-CHAR anchor ${suffix}`,
        content: { priority: 'medium' },
      }),
    );
    return created.entity.id;
  }

  beforeAll(async () => {
    harness = await startW3PublicServer('g04char');

    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g04char-space',
        name: 'W3 G04-CHAR Space',
      }),
    );
    spaceId = space.space.id;
    anchorId = await makeAnchor('primary');
    otherAnchorId = await makeAnchor('secondary');

    // Fixtures go through the PUBLIC boundary. `messages.post` is composed as of
    // tranche-v3; before it, this path was an unconditional 501 stub, so the
    // fixture route is recorded as a dependency rather than assumed stable.
    for (const [index, body] of ROOT_BODIES.entries()) {
      const posted = await harness.request('POST', '/v2/messages', {
        clientMutationId: `w3-g04char-root-${index}`,
        anchorIds: [anchorId],
        body,
      });
      observed[`postRoot${index}Status`] = posted.status;
    }

    // Message ids are read from STORAGE, not scraped out of the response body.
    // An earlier revision regexed the last UUID-shaped string out of the DTO and
    // picked up a non-message id, which produced a red that looked like a
    // product defect and was a test defect. Named here because that is exactly
    // the class of false red this file exists to avoid producing.
    const stored = await harness.rows<{ entity_id: string }>(
      'select entity_id::text from public.messages where anchor_id = $1 order by created_at, entity_id',
      [anchorId],
    );
    rootIds.push(...stored.map((row) => row.entity_id));
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('records the fixture route and the thread it actually built', async () => {
    // NON-VACUOUSNESS. Every branch below reads a thread; if the fixture never
    // built one, they would all pass by reading nothing. Fail loudly here first.
    const rows = await harness.rows<{ n: number }>(
      'select count(*)::integer n from public.messages where anchor_id = $1',
      [anchorId],
    );
    expect({ ...observed, messageRowsOnAnchor: rows[0]?.n ?? 0 }).toMatchObject({
      postRoot0Status: 200,
    });
    expect(rows[0]?.n, 'no message rows exist — every case below would be vacuous').toBeGreaterThan(0);
  });

  it('OBSERVED: thread roots come back oldest-first with reply counts', async () => {
    const page = successData<{ items: Array<{ id: string; replyCount: number; content: unknown }>; nextCursor: string | null }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages`),
    );
    const bodies = page.items.map((item) => JSON.stringify(item.content));

    // Threads read oldest-first — the opposite of feed order. A silent flip here
    // would reorder every conversation in the product and raise no error.
    expect(bodies.length).toBe(ROOT_BODIES.length);
    for (const [index, expected] of ROOT_BODIES.entries()) {
      expect(bodies[index], `root ${index} out of send order`).toContain(expected);
    }
    // Every root is a root: none of them carries a reply yet.
    expect(page.items.map((item) => item.replyCount)).toEqual(ROOT_BODIES.map(() => 0));
    expect(page.nextCursor, 'a complete page must not emit a cursor').toBeNull();
  });

  it('OBSERVED: the ?rootMessageId= switch selects replies instead of roots', async () => {
    const root = rootIds[0] ?? '';
    expect(root, 'no root id captured from the fixture').toBeTruthy();

    for (const [index, body] of REPLY_BODIES.entries()) {
      const posted = await harness.request('POST', '/v2/messages', {
        clientMutationId: `w3-g04char-reply-${index}`,
        anchorIds: [anchorId],
        parentMessageId: root,
        body,
      });
      observed[`postReply${index}Status`] = posted.status;
    }

    const roots = successData<{ items: Array<{ id: string; replyCount: number }> }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages`),
    );
    const replies = successData<{ items: Array<{ content: unknown }> }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages?rootMessageId=${root}`),
    );

    // THE SWITCH. Roots must still be roots-only, and the replies view must not
    // return the roots. If a replacement collapsed these into one flat list the
    // UI would still render, which is exactly why this is asserted.
    expect(roots.items.length, 'replies leaked into the roots view').toBe(ROOT_BODIES.length);
    expect({
      repliesReturned: replies.items.length,
      replyCountOnParent: roots.items.find((item) => item.id === root)?.replyCount ?? null,
      postStatuses: [observed['postReply0Status'], observed['postReply1Status']],
    }).toMatchObject({ repliesReturned: REPLY_BODIES.length });
  });

  it('OBSERVED: a cursor pages forward without overlap and stops cleanly', async () => {
    const first = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages?limit=1`),
    );
    expect(first.items.length).toBe(1);
    expect(first.nextCursor, 'an incomplete page must emit a cursor').toBeTruthy();

    const second = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await harness.request(
        'GET',
        `/v2/entities/${anchorId}/messages?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
    );
    expect(second.items.length).toBe(1);

    // DIAGNOSTIC, kept in the file: when this went red against a fix that read
    // correctly, guessing at the cause was the wrong move. These three readings
    // localise it — what the cursor actually carries, versus what the column
    // actually holds, versus whether the walk advanced at all.
    const carried = decodeCursor(first.nextCursor!).k;
    const stored = await harness.rows<{ id: string; ts: string }>(
      `select m.entity_id::text id, m.created_at::text ts
         from public.messages m where m.anchor_id = $1
        order by m.created_at, m.entity_id`,
      [anchorId],
    );
    // eslint-disable-next-line no-console
    console.log('[G04-CHAR cursor diagnostic]', JSON.stringify({
      carriedTimestamp: carried[1],
      carriedId: carried[2],
      storedRows: stored,
      page1Id: first.items[0]?.id,
      page2Id: second.items[0]?.id,
      page2Cursor: second.nextCursor,
      cursorsIdentical: first.nextCursor === second.nextCursor,
    }, null, 2));

    // A fingerprint that is too LOOSE silently resumes from the wrong position,
    // which §7.6 records as worse than a rejection. Overlap is how that shows.
    expect(second.items[0]?.id, 'the cursor resumed at the wrong position').not.toBe(
      first.items[0]?.id,
    );

    // MECHANISM GUARD, ASSERTED AS AN INSTANT RATHER THAN AS A SPELLING.
    //
    // The live cause of the original defect was a `timestamptz` round-tripped
    // through a JavaScript `Date`, which keeps MILLISECONDS while Postgres
    // stores MICROSECONDS, so the encoded value landed strictly before the row
    // it came from and the keyset re-admitted it.
    //
    // TWO EARLIER SHAPES OF THIS GUARD WERE BOTH WRONG, AND BOTH WRONG THE SAME
    // WAY — they pinned an ARTIFACT instead of the PROPERTY:
    //   - requiring six fractional digits false-RED about one run in ten,
    //     because `::text` TRIMS TRAILING ZEROS and is variable width;
    //   - requiring byte-identity with `msg.created_at::text` pinned a SPELLING.
    //     `::text` renders in the SESSION TIMEZONE, so it was configuration
    //     dependent, and it was incompatible with the `to_char(… 'US')` idiom
    //     the other seven cursor sites use — it would have gone red on a
    //     correct change and held this one operation on a non-standard spelling.
    //
    // So assert the INSTANT. Cast the carried value back and require it to be
    // the identical point in time as the stored column. That holds under EITHER
    // rendering and ANY timezone, and it cannot be satisfied by a truncated
    // value: a millisecond-truncated cursor is a DIFFERENT instant from a
    // microsecond-precise row.
    const carriedTimestamp = String(carried[1]);
    const fidelity = await harness.rows<{ same_instant: boolean; has_sub_ms: boolean }>(
      `select (m.created_at = $2::timestamptz)                        as same_instant,
              ((extract(microseconds from m.created_at)::bigint % 1000) <> 0) as has_sub_ms
         from public.messages m
        where m.entity_id = $1`,
      [String(carried[2]), carriedTimestamp],
    );

    // NON-VACUOUSNESS. If the stored row happened to land on an exact
    // millisecond, a truncated cursor would compare EQUAL and this guard would
    // pass while proving nothing. Prove the row has a sub-millisecond component
    // BEFORE believing the equality below.
    expect(
      fidelity[0]?.has_sub_ms,
      `the cursor row has no sub-millisecond component, so a truncated value would `
        + `compare equal and this guard would be vacuous (carried ${carriedTimestamp})`,
    ).toBe(true);

    expect(
      fidelity[0]?.same_instant,
      `the cursor does not carry the stored instant — a Date round-trip has truncated it `
        + `(carried ${carriedTimestamp})`,
    ).toBe(true);
  });

  it('OBSERVED: a cursor is rejected across a different anchor and across the roots/replies switch', async () => {
    const source = successData<{ nextCursor: string | null }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages?limit=1`),
    );
    const cursor = encodeURIComponent(source.nextCursor ?? '');
    expect(cursor).toBeTruthy();

    // The fingerprint binds BOTH anchorId and rootMessageId, so both of these
    // must be refused. The negative direction is the half W3 already had; it is
    // asserted here because this operation never had it at all.
    const crossAnchor = await harness.request(
      'GET',
      `/v2/entities/${otherAnchorId}/messages?limit=1&cursor=${cursor}`,
    );
    const crossScope = await harness.request(
      'GET',
      `/v2/entities/${anchorId}/messages?limit=1&rootMessageId=${rootIds[0] ?? ''}&cursor=${cursor}`,
    );

    expect({
      crossAnchorStatus: crossAnchor.status,
      crossAnchorCode: crossAnchor.body.error?.code ?? null,
      crossScopeStatus: crossScope.status,
      crossScopeCode: crossScope.body.error?.code ?? null,
    }).toMatchObject({
      crossAnchorCode: 'invalid_cursor',
      crossScopeCode: 'invalid_cursor',
    });
  });

  /**
   * OBSERVED BASELINE, EXPLICITLY NOT A DEFECT CLAIM.
   *
   * `handlers/messages.ts` raises `not_found` for a malformed `rootMessageId`
   * rather than an input-validation error. Whether that is the right code is a
   * CONTRACT question, not a bug this file adjudicates. It is recorded so that
   * if a replacement changes it, the change is visible and can be judged.
   */
  it('OBSERVED BASELINE: a malformed rootMessageId is answered as not_found, not invalid input', async () => {
    const malformed = await harness.request(
      'GET',
      `/v2/entities/${anchorId}/messages?rootMessageId=not-a-uuid`,
    );
    expect({
      status: malformed.status,
      code: malformed.body.error?.code ?? null,
    }).toMatchObject({ code: 'not_found' });
  });

  /**
   * THE SKIP-WITHOUT-SIGNAL PATH — the branch the closure coordinator singled
   * out, because a projection that drops a row with no error and no signal is
   * exactly what a replacement can change without anyone noticing.
   *
   * `toMessageViews` runs `if (state.kind !== 'message' || content.kind !==
   * 'message') continue;`. This case does not claim to force that specific
   * condition — it MEASURES what the public thread projection does to a message
   * that has been removed, and records whether the row vanishes silently, is
   * tombstoned in place, or raises. Whichever it is, it is now pinned.
   */
  it('OBSERVED: what the thread projection does with a deleted message', async () => {
    const target = rootIds[rootIds.length - 1] ?? '';
    expect(target, 'no root id captured for the deletion probe').toBeTruthy();

    const before = successData<{ items: Array<{ id: string }> }>(
      await harness.request('GET', `/v2/entities/${anchorId}/messages`),
    );
    const deleted = await harness.request('DELETE', `/v2/messages/${target}`, {
      clientMutationId: 'w3-g04char-delete-probe',
    });
    const after = await harness.request<{ items: Array<{ id: string }> }>(
      'GET',
      `/v2/entities/${anchorId}/messages`,
    );

    const stillListed = (after.body.data?.items ?? []).some((item) => item.id === target);
    const dbRow = await harness.rows<{ deleted_at: string | null }>(
      'select deleted_at from public.entities where id = $1',
      [target],
    );

    // A measurement, asserted only for self-consistency: a row the database
    // marks deleted must not still be listed, and a row it does not mark
    // deleted must not have silently disappeared. Either combination alone
    // would be a real finding.
    const rowIsDeleted = dbRow[0]?.deleted_at != null;
    expect({
      deleteStatus: deleted.status,
      deleteCode: deleted.body.error?.code ?? null,
      countBefore: before.items.length,
      countAfter: after.body.data?.items.length ?? null,
      rowMarkedDeletedInDb: rowIsDeleted,
      stillListedInThread: stillListed,
      consistent: deleted.status >= 400 ? true : rowIsDeleted !== stillListed,
    }).toMatchObject({ consistent: true });
  });
});

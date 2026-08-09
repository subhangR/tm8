import { decodeCursor } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.G13 — `entities.context` continuation-token precision.
 *
 * WHY THIS FILE EXISTS, AND WHY THE SWEEP DID NOT CATCH IT. The cursor
 * truncation class was closed by moving every builder onto the shared `MICROS`
 * SQL helper, and `feed-context.ts` adopted it at `:412`, `:614` and `:1007`.
 * But `cursorsFor` builds two continuation tokens side by side and they do NOT
 * share a source:
 *
 *   :1169  cursors['messages']  = encodeCursor([fp, last.createdAt, last.id])
 *   :1173  cursors['activity']  = encodeCursor([fp, loaded.newestActivity.cursor_created_at, ...])
 *
 * `activity` reads the microsecond-safe SQL column and even carries the comment
 * "Carried verbatim — never through a JS Date". `messages` reads
 * `MessageView.createdAt`, which is a DTO field the entity assembler already
 * produced with `iso()` — a JavaScript `Date` round trip, and therefore
 * MILLISECONDS.
 *
 * IT IS INVISIBLE TO BOTH DETECTORS BUILT FOR THIS CLASS. A grep for `MICROS`
 * shows the file adopted the fix. A grep for `iso(` inside an `encodeCursor`
 * argument finds nothing, because the `iso()` call is upstream in the assembler,
 * not inline at the cursor. The truncation is inherited through a DTO rather
 * than performed locally, which is a third disguise for the same defect.
 *
 * WHY IT MATTERS RATHER THAN BEING COSMETIC: these tokens are consumed by
 * `entities.feed` — they carry `feedCursorFingerprint`, not a `messages.list`
 * one. Feed's default order is `newest`, i.e. DESCENDING with a `<` keyset. A
 * value truncated DOWNWARD excludes every row between the truncated value and
 * the real one, and those are precisely the rows that belonged on the next page.
 * That is the SILENT variant: paging terminates cleanly and simply loses rows.
 *
 * BOTH HALVES IN ONE MEASUREMENT. The `activity` token from the SAME response,
 * built by the SAME function four lines away, is the GREEN control. If both were
 * red the finding would be environmental; if both were green there would be no
 * finding. One red beside one green in one function is the controlled result.
 */
describe.sequential('W3.G13 entities.context continuation-token precision', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let anchorId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g13ctx');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g13ctx-space',
        name: 'W3 G13 context Space',
      }),
    );
    spaceId = space.space.id;

    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g13ctx-anchor',
        spaceId,
        kind: 'task',
        title: 'G13 context cursor anchor',
        content: { priority: 'medium' },
      }),
    );
    anchorId = anchor.entity.id;

    // Enough messages that the section overfetches and emits a continuation.
    for (let index = 0; index < 4; index += 1) {
      await harness.request('POST', '/v2/messages', {
        clientMutationId: `w3-g13ctx-msg-${index}`,
        anchorIds: [anchorId],
        body: `G13 context cursor message ${index}`,
      });
    }
  }, 180_000);

  // 30s -> 120s. `harness.close()` ends with `database.destroy()`, which DROPS a
  // scratch database, and a drop is exactly the operation that slows down under
  // the parallel load this suite runs in — w2-execution.pg.test.ts measured the
  // same thing and raised its own teardown budget for it. All twenty w3 suites
  // shared this 30s, so whichever one lost the race reported `Hook timed out in
  // 30000ms` and the identity of the loser rotated between runs. A larger budget
  // costs nothing when teardown is fast.
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it('CONTROL: the fixture built messages with sub-millisecond timestamps', async () => {
    // Truncation is only observable when the microsecond remainder is non-zero.
    const rows = await harness.rows<{ ts: string }>(
      `select created_at::text ts from public.messages where anchor_id = $1 order by created_at`,
      [anchorId],
    );
    expect(rows.length, 'no messages were created').toBeGreaterThan(2);
    expect(
      rows.filter((row) => /\.\d{4,6}/.test(row.ts) && !/\.\d{3}000\+/.test(row.ts)).length,
      `no message has a non-zero microsecond remainder: ${rows.map((r) => r.ts).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  it('carries FULL microseconds in the messages continuation token, as its activity sibling does', async () => {
    const context = successData<{ cursors?: Record<string, string | null> }>(
      await harness.request(
        'GET',
        `/v2/entities/${anchorId}/context?sections=messages,activity`,
      ),
    );
    const cursors = context.cursors ?? {};

    const decode = (token: string | null | undefined): string | null => {
      if (!token) return null;
      const parts = decodeCursor(token).k.map(String);
      return parts.find((part) => /^\d{4}-\d{2}-\d{2}[T ]/.test(part)) ?? null;
    };
    const messagesAt = decode(cursors['messages']);
    const activityAt = decode(cursors['activity']);

    // eslint-disable-next-line no-console
    console.log('[W3.G13 context cursors]', JSON.stringify({
      cursorKeys: Object.keys(cursors),
      messagesTimestamp: messagesAt,
      activityTimestamp: activityAt,
    }, null, 2));

    // Non-vacuous: a token that was never emitted cannot evidence anything.
    expect(
      cursors['messages'],
      'no messages continuation token was emitted — this measurement is vacuous',
    ).toBeTruthy();
    expect(messagesAt, 'the messages token carries no timestamp component').toBeTruthy();

    // THE GREEN HALF, from the same response and the same function: the activity
    // token reads the microsecond-safe SQL column. If this is also red the cause
    // is environmental and the finding below does not stand.
    if (activityAt !== null) {
      expect(
        activityAt,
        'the activity token — the fixed sibling — also lost precision, so this is not a '
          + 'messages-specific finding',
      ).not.toMatch(/\.\d{3}Z$/);
    }

    // THE ASSERTION. A JavaScript Date ISO string carries EXACTLY three
    // fractional digits before a terminal Z; MICROS always emits six.
    expect(
      messagesAt,
      'entities.context emits a messages continuation token truncated to milliseconds — it is '
        + 'built from the MessageView DTO field, which the assembler already passed through '
        + 'iso(), while the activity token four lines away reads the microsecond-safe column. '
        + 'entities.feed consumes this token with a DESCENDING keyset, so the truncation SKIPS '
        + 'rows silently rather than looping',
    ).not.toMatch(/\.\d{3}Z$/);
  }, 120_000);
});

import { decodeCursor } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3 — CURSOR FORWARD PROGRESS, the third direction.
 *
 * §7.6 mandates two directions for every cursor: equivalent filters must accept
 * each other's cursor, and a genuinely different filter/sort must reject it.
 * Neither catches a keyset that is ACCEPTED, whose fingerprint MATCHES, and which
 * still resumes at the wrong row — which is what `messages.list` did. Fingerprint
 * correctness and keyset correctness are different properties.
 *
 * THE MECHANISM, already proven once. Postgres `timestamptz` holds MICROSECONDS.
 * `iso()` (entity-read.ts:179-181) is `value instanceof Date ? value.toISOString()
 * : new Date(value).toISOString()` — BOTH branches route through a JavaScript
 * `Date`, which holds only MILLISECONDS. Any cursor built by `iso()` over a
 * timestamptz therefore carries a value strictly LESS than the row it came from,
 * whenever the microsecond remainder is non-zero (~999 times in 1000).
 *
 * WHICH WAY IT FAILS DEPENDS ON THE SORT, AND THE QUIETER DIRECTION IS THE WORSE
 * ONE:
 *   - ASCENDING with `>` — the truncated value is below the row, so the keyset
 *     RE-ADMITS it. The walk never advances. LOUD: paging does not terminate.
 *   - DESCENDING with `<` — the truncated value is below the row, so the keyset
 *     excludes everything between the truncated value and the real one. Those are
 *     exactly the rows that belonged on the next page. They are SKIPPED. SILENT:
 *     paging terminates cleanly and simply omits rows, with no error and no loop.
 * A terminates-only assertion is blind to the second case. So this file asserts
 * EXACTLY-ONCE **and** COMPLETENESS against the unpaged truth, not just
 * termination.
 *
 * SITE UNDER TEST: `entities.activity`, whose SQL orders
 * `a.created_at desc, a.id desc` (activity.ts:58) with keyset
 * `(a.created_at, a.id) < ($n::timestamptz, $n::uuid)` (activity.ts:51) and whose
 * cursor is `encodeCursor([iso(last.created_at), last.id])` (activity.ts:80). It
 * carries no microsecond-safe column, unlike the three sites that DO —
 * edges-placements.ts:166, entities-commands-tracking.ts:522 and :1215, all of
 * which use `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. That split is the
 * §7.6 architecture repeating: the knowledge exists in this repository and did
 * not generalise.
 *
 * MIGRATIONS: full official chain via `migrationFiles()`.
 */
describe.sequential('W3 cursor forward progress (third direction)', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let entityId = '';

  /** How many activity rows the fixture aims to produce. */
  const PATCHES = 6;

  beforeAll(async () => {
    harness = await startW3PublicServer('cursorfwd');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-cursorfwd-space',
        name: 'W3 cursor forward-progress Space',
      }),
    );
    spaceId = space.space.id;

    const created = successData<{ entity: { id: string; version: number } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-cursorfwd-entity',
        spaceId,
        kind: 'task',
        title: 'cursor forward-progress subject',
        content: { priority: 'medium' },
      }),
    );
    entityId = created.entity.id;

    // Each patch appends an activity row. Distinct transactions, so each lands
    // with its own microsecond-precision timestamp.
    let version = created.entity.version;
    for (let index = 0; index < PATCHES; index += 1) {
      const patched = await harness.request<{ version: number }>(
        'PATCH',
        `/v2/entities/${entityId}`,
        {
          clientMutationId: `w3-cursorfwd-patch-${index}`,
          expectedVersion: version,
          title: `cursor forward-progress subject r${index}`,
        },
      );
      if (patched.status < 200 || patched.status >= 300) break;
      version = patched.body.data?.version ?? version + 1;
    }
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('activity rows carry sub-millisecond timestamps, so the probe is not vacuous', async () => {
    // NON-VACUOUSNESS. Truncation is only observable when the microsecond
    // remainder is non-zero. If every row landed on an exact millisecond this
    // whole file would pass for the wrong reason, so prove otherwise FIRST.
    const rows = await harness.rows<{ ts: string }>(
      `select created_at::text ts from public.activity where entity_id = $1 order by created_at`,
      [entityId],
    );
    expect(rows.length, 'fixture produced too few activity rows to page').toBeGreaterThan(2);
    const subMillisecond = rows.filter((row) => !/\.\d{3}000\+/.test(row.ts) && /\.\d{4,6}/.test(row.ts));
    expect(
      subMillisecond.length,
      `no activity row has a non-zero microsecond remainder; truncation would be invisible: ${
        rows.map((r) => r.ts).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  it('pages entities.activity to exhaustion returning each row EXACTLY ONCE and losing NONE', async () => {
    // The unpaged truth, read through the same public operation with a limit
    // large enough to take everything in one page.
    const whole = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await harness.request('GET', `/v2/entities/${entityId}/activity?limit=200`),
    );
    const truth = whole.items.map((item) => item.id);
    expect(whole.nextCursor, 'the unpaged read was itself paginated').toBeNull();
    expect(truth.length).toBeGreaterThan(2);

    // Walk it one row at a time. A LOOP shows up as the iteration guard tripping;
    // a SKIP shows up as a short collected set. Both are failures here.
    const collected: string[] = [];
    let cursor: string | null = null;
    let carried: unknown[] | null = null;
    const MAX_STEPS = truth.length * 3 + 5;
    let steps = 0;

    for (;;) {
      steps += 1;
      expect(
        steps,
        `paging did not terminate after ${steps} steps for ${truth.length} rows — the keyset ` +
          're-admitted the row its own cursor came from',
      ).toBeLessThanOrEqual(MAX_STEPS);

      const query: string = `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: { items: Array<{ id: string }>; nextCursor: string | null } = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
        await harness.request('GET', `/v2/entities/${entityId}/activity?${query}`),
      );
      for (const item of page.items) collected.push(item.id);
      if (!page.nextCursor) break;
      if (carried === null) carried = decodeCursor(page.nextCursor).k;
      cursor = page.nextCursor;
    }

    // eslint-disable-next-line no-console
    console.log('[W3 cursor forward-progress: entities.activity]', JSON.stringify({
      unpagedCount: truth.length,
      walkedCount: collected.length,
      duplicates: collected.filter((id, index) => collected.indexOf(id) !== index),
      missing: truth.filter((id) => !collected.includes(id)),
      firstCursorCarried: carried,
      steps,
    }, null, 2));

    // EXACTLY ONCE.
    expect(new Set(collected).size, 'the walk returned a duplicate row').toBe(collected.length);
    // AND NOTHING LOST. This is the assertion a terminates-only test does not
    // have, and it is the one that catches the silent descending-skip variant.
    expect(
      [...collected].sort(),
      'the paged walk LOST rows the unpaged read returned — silent cursor skip',
    ).toEqual([...truth].sort());
  }, 120_000);

  /**
   * DISPROOF, recorded as a disproof rather than deleted.
   *
   * The static hypothesis was that `entities.activity` is exposed, because
   * `handlers/activity.ts:80` builds its cursor with `encodeCursor([iso(...),
   * id])` over a DESCENDING keyset. MEASURED, that is WRONG: the composed route
   * is served by G02's `entities-commands-tracking.ts`, which carries a
   * microsecond-safe `to_char(... 'US')` column (`:1215`) and emits a THREE-part
   * fingerprinted cursor (`:1236`). `handlers/activity.ts` is reached only from
   * `commands.ts:113` and `spaces.ts:291`, neither of which pages.
   *
   * The lesson is the reason this is kept: reading a file that LOOKS like it
   * serves an operation is not the same as tracing what the composition
   * registers. The cursor shape is what settled it — three elements and six
   * fractional digits could not have come from `activity.ts`.
   */
  it('DISPROOF: entities.activity is served by the microsecond-safe G02 encoder', async () => {
    const first = successData<{ nextCursor: string | null }>(
      await harness.request('GET', `/v2/entities/${entityId}/activity?limit=1`),
    );
    expect(first.nextCursor).toBeTruthy();
    const carried = decodeCursor(first.nextCursor!).k;

    // Three parts (fingerprint, timestamp, id) — activity.ts emits two.
    expect(carried).toHaveLength(3);
    expect(String(carried[1]), 'entities.activity cursor lost sub-millisecond precision').toMatch(
      /\.\d{6}/,
    );
  }, 60_000);

  /**
   * WIRE VERIFICATION OF THE THREE "DEFENDED" SITES — and an explicit correction
   * to how this file previously justified that label.
   *
   * The DEFENDED verdict was originally established by SOURCE ENUMERATION: every
   * query feeding each encoder was enumerated and confirmed to carry the
   * `to_char(… 'US')` column. That establishes WHY the value is right AT THE
   * SELECT. It does NOT establish that it is still right at the WIRE, because
   * `iso()` (entity-read.ts:179-181) truncates on BOTH branches and would destroy
   * microsecond precision that had already survived as a string, if it were
   * applied anywhere downstream of the encoder. Enumeration is upstream of that
   * trap.
   *
   * So this case measures the boundary instead: decode `nextCursor` off the wire
   * and require six fractional digits. Six digits arriving at the client proves
   * `iso()` was not applied anywhere on that path, whatever the SELECT said.
   *
   * SIX DIGITS IS THE RIGHT ASSERTION *HERE* AND NOT ELSEWHERE: these sites emit
   * `to_char(… 'US')`, which always pads to exactly six. Sites that carry
   * `timestamptz::text` legitimately trim trailing zeros, so a digit-count
   * assertion would false-red on them — which is why the messages.list guard uses
   * byte-identity plus the truncation signature instead. Same property, two
   * assertion shapes, chosen per site.
   *
   * THIS IS ALSO THE GREEN HALF of the truncation detector. A detector only ever
   * seen red proves it RESPONDS, never that it DISCRIMINATES.
   */
  it('GREEN CONTROL: defended cursor sites deliver full microseconds AT THE WIRE', async () => {
    const mk = async (suffix: string): Promise<string> => {
      const created = successData<{ entity: { id: string } }>(
        await harness.request('POST', '/v2/entities', {
          clientMutationId: `w3-cursorfwd-edge-${suffix}`,
          spaceId,
          kind: 'task',
          title: `cursor defended-site ${suffix}`,
          content: { priority: 'medium' },
        }),
      );
      return created.entity.id;
    };
    const target = await mk('target');
    for (const suffix of ['a', 'b', 'c']) {
      const source = await mk(suffix);
      await harness.request('POST', '/v2/placements', {
        clientMutationId: `w3-cursorfwd-attach-${suffix}`,
        sourceId: source,
        targetId: target,
        intent: 'attach',
      });
    }

    const measured: Record<string, unknown> = {};
    for (const [label, path] of [
      ['entities.connections', `/v2/entities/${target}/connections?limit=1`],
      ['edges.list', `/v2/edges?spaceId=${spaceId}&limit=1`],
    ] as Array<[string, string]>) {
      const page = await harness.request<{ nextCursor: string | null }>('GET', path);
      const next = page.body.data?.nextCursor ?? null;
      measured[label] = {
        status: page.status,
        carried: next ? decodeCursor(next).k : null,
      };
    }

    // eslint-disable-next-line no-console
    console.log('[W3 defended-site wire decode]', JSON.stringify(measured, null, 2));

    for (const [label, value] of Object.entries(measured)) {
      const carried = (value as { carried: unknown[] | null }).carried;
      // A site that produced no second page cannot be evidence either way; say so
      // rather than counting an absent cursor as a pass.
      expect(carried, `${label} produced no cursor — this control is vacuous for it`).not.toBeNull();
      const timestamp = (carried ?? []).map(String).find((part) => /^\d{4}-\d{2}-\d{2}T/.test(part));
      expect(timestamp, `${label} carried no timestamp component`).toBeTruthy();
      expect(
        String(timestamp),
        `${label} lost microsecond precision AT THE WIRE — the DEFENDED verdict is falsified`,
      ).toMatch(/\.\d{6}Z?$/);
      expect(
        String(timestamp),
        `${label} bears the JavaScript Date truncation signature`,
      ).not.toMatch(/\.\d{3}Z$/);
    }
  }, 120_000);

  /**
   * THE REAL TARGET. `spaces.awards` (G01 — a group that already holds a public
   * PASS verdict) reads `public.point_events` ordered
   * `created_at DESC, id DESC` with keyset
   * `(created_at, id) < ($2::timestamptz, $3::uuid)` (identity-spaces.ts:517,
   * :525) and builds its cursor as `encodeCursor([iso(last.created_at), last.id])`
   * (`:551`) — a two-part, unfingerprinted, `iso()`-truncated cursor.
   *
   * DESCENDING plus `<` plus a value truncated DOWNWARD is the SILENT variant:
   * every row whose timestamp lies between the truncated value and the real one
   * is excluded from the next page. Those are precisely the rows that belonged
   * on it. Paging terminates cleanly and simply loses them.
   */
  it('pages spaces.awards to exhaustion returning each row EXACTLY ONCE and losing NONE', async () => {
    const member = await harness.rows<{ id: string }>(
      `select id::text from public.entities
        where space_id = $1 and kind = 'member' and deleted_at is null limit 1`,
      [spaceId],
    );
    const recipient = member[0]?.id ?? '';
    expect(recipient, 'no member entity to receive an award').toBeTruthy();

    for (let index = 0; index < 6; index += 1) {
      await harness.request('POST', `/v2/entities/${recipient}/points`, {
        clientMutationId: `w3-cursorfwd-award-${index}`,
        amount: index + 1,
        reason: 'award',
      });
    }

    const stored = await harness.rows<{ ts: string }>(
      `select created_at::text ts from public.point_events
        where space_id = $1 and reason = 'award' order by created_at`,
      [spaceId],
    );
    expect(stored.length, 'fixture produced too few award rows to page').toBeGreaterThan(2);
    // Non-vacuousness for THIS site: truncation is invisible on an exact millisecond.
    expect(
      stored.filter((row) => /\.\d{4,6}/.test(row.ts) && !/\.\d{3}000\+/.test(row.ts)).length,
      `no award row has a non-zero microsecond remainder: ${stored.map((r) => r.ts).join(', ')}`,
    ).toBeGreaterThan(0);

    const whole = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await harness.request('GET', `/v2/spaces/${spaceId}/awards?limit=200`),
    );
    const truth = whole.items.map((item) => item.id);
    expect(whole.nextCursor).toBeNull();
    expect(truth.length).toBeGreaterThan(2);

    const collected: string[] = [];
    let cursor: string | null = null;
    let carried: unknown[] | null = null;
    const MAX_STEPS = truth.length * 3 + 5;
    let steps = 0;

    for (;;) {
      steps += 1;
      expect(steps, 'spaces.awards paging did not terminate').toBeLessThanOrEqual(MAX_STEPS);
      const query: string = `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: { items: Array<{ id: string }>; nextCursor: string | null } = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
        await harness.request('GET', `/v2/spaces/${spaceId}/awards?${query}`),
      );
      for (const item of page.items) collected.push(item.id);
      if (!page.nextCursor) break;
      if (carried === null) carried = decodeCursor(page.nextCursor).k;
      cursor = page.nextCursor;
    }

    // eslint-disable-next-line no-console
    console.log('[W3 cursor forward-progress: spaces.awards]', JSON.stringify({
      storedAwardTimestamps: stored.map((r) => r.ts),
      unpagedCount: truth.length,
      walkedCount: collected.length,
      duplicates: collected.filter((id, index) => collected.indexOf(id) !== index),
      missing: truth.filter((id) => !collected.includes(id)),
      firstCursorCarried: carried,
      steps,
    }, null, 2));

    expect(new Set(collected).size, 'the walk returned a duplicate row').toBe(collected.length);
    expect(
      [...collected].sort(),
      'spaces.awards LOST rows the unpaged read returned — SILENT cursor skip',
    ).toEqual([...truth].sort());
    // WHY A FORMAT SIGNATURE HERE, WHEN g04-messages-list-characterization.test.ts
    // asserts the same property as an INSTANT COMPARISON instead. Not
    // inconsistency — different available evidence. That file has a paired
    // storage read for the exact row its cursor came from, so it can cast the
    // carried value back and compare instants in the database, which is
    // idiom-agnostic and strictly stronger. This file measures sites through the
    // WIRE with no paired storage read, so a format check is the only mechanism
    // signal available. Same property, two instruments, chosen by what each site
    // can actually evidence.
    //
    // THE TRUNCATION SIGNATURE, not a digit count. A digit-count guard false-REDs
    // on correct sites because Postgres trims trailing zeros from
    // `timestamptz::text`. A JavaScript Date ISO string, by contrast, carries
    // EXACTLY three fractional digits before a terminal Z — while `to_char(…
    // 'US')` always emits six and `::text` never ends in Z. So this matches a
    // Date round-trip and nothing else, on every site in the sweep.
    expect(
      String((carried ?? [])[0]),
      'spaces.awards cursor bears the JavaScript Date truncation signature — '
        + 'iso() has reduced a microsecond timestamptz to milliseconds',
    ).not.toMatch(/\.\d{3}Z$/);
  }, 120_000);
});

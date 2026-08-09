import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3 — 037's absent-means-merge, gated at the PUBLIC boundary.
 *
 * Migration 037 fixed `set_work_state`, which previously did
 * `props = excluded.props` — a WHOLESALE REPLACEMENT — so a transition that
 * omitted `note` wrote `note: null` over a stored value, silently, at exit 0.
 * After 037 the database distinguishes three cases: ABSENT preserves, an
 * explicit `p_clear_note` clears, and a new value replaces.
 *
 * THAT IS A DATABASE-SIDE CLAIM AND THIS FILE MEASURES THE API SIDE, which is
 * not the same surface. `handlers/commands.ts:33-40` passes SIX positional
 * arguments to `set_work_state` and `p_clear_note` is not among them:
 *
 *     input.note ?? null
 *
 * `??` collapses ABSENT and EXPLICIT NULL to the same wire value. So the
 * three-way distinction 037 built exists in the database and cannot be
 * addressed through this handler. The contract nevertheless ACCEPTS an explicit
 * null — `WorkInputSchema` at schemas.ts:976 declares
 * `note: z.string().nullable().optional()`.
 *
 * Two branches are therefore worth separating, and no existing test separates
 * them:
 *  - ABSENT must PRESERVE. That is 037's fix and the data-loss half.
 *  - EXPLICIT NULL is ACCEPTED BY THE SCHEMA. What does it DO? Whatever the
 *    answer, it is recorded here rather than assumed, because an input the
 *    contract accepts and the server cannot act on is a capability the API
 *    advertises and does not deliver — and the caller receives a success.
 *
 * This file asserts the first as LAW and MEASURES the second, because which
 * behaviour is correct for an explicit null is a contract question this gate
 * does not own.
 *
 * MIGRATIONS: full official chain via `migrationFiles()`.
 */
describe.sequential('W3 037 absent-means-merge at the public boundary', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let taskId = '';

  const STORED_NOTE = 'W3-037 note that must survive an omitting transition';

  async function workNote(): Promise<unknown> {
    // The note lives on the `working_on` EDGE's props (037:34-52), not on
    // public.tasks. An earlier revision of this helper read public.tasks.props
    // and raised 42703 — a column-does-not-exist red that looks like a product
    // failure and is a test defect, which is exactly the shape the SEC-1b suite
    // warned about in its own comments.
    const rows = await harness.rows<{ note: string | null }>(
      `select props ->> 'note' as note from public.edges
        where dst_id = $1 and type = 'working_on'`,
      [taskId],
    );
    return rows[0]?.note ?? null;
  }

  beforeAll(async () => {
    harness = await startW3PublicServer('w3037');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-037-space',
        name: 'W3 037 Space',
      }),
    );
    spaceId = space.space.id;
    const task = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-037-task',
        spaceId,
        kind: 'task',
        title: 'W3 037 absent-means-merge subject',
        content: { priority: 'medium' },
      }),
    );
    taskId = task.entity.id;
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

  it('CONTROL: a transition carrying a note stores it', async () => {
    const res = await harness.request('POST', `/v2/entities/${taskId}/commands/work`, {
      clientMutationId: 'w3-037-set-note',
      status: 'working',
      note: STORED_NOTE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Without this the preservation case below could pass by there being
    // nothing to preserve.
    expect(String(await workNote())).toContain('must survive');
  }, 60_000);

  it('LAW: a transition that OMITS note PRESERVES the stored note (037)', async () => {
    const before = await workNote();
    const res = await harness.request('POST', `/v2/entities/${taskId}/commands/work`, {
      clientMutationId: 'w3-037-omit-note',
      status: 'in_review',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await workNote();
    expect(
      after,
      'a transition omitting note destroyed the stored note — 037 absent-means-merge has '
        + 'regressed, and it destroys data silently at exit 0',
    ).toEqual(before);
    expect(String(after)).toContain('must survive');
  }, 60_000);

  /**
   * MEASUREMENT, not a law. `WorkInputSchema` accepts `note: null`, and
   * `handlers/commands.ts:38` reduces it with `??` to the same argument an
   * absent note produces. So the server cannot distinguish them, and 037 made
   * the database side PRESERVE on that argument.
   *
   * The consequence, if it holds: a caller that explicitly asks to clear the
   * note receives a 200 and the note is still there. Before 037 that same
   * request DID clear it, because everything overwrote. So the observable API
   * behaviour of an input the contract accepts has changed from "clears" to
   * "silently preserves" — a real consequence of a correct fix, not a defect in
   * its intent.
   */
  it('MEASURES what an explicit note:null does through the public API', async () => {
    const before = await workNote();
    const res = await harness.request('POST', `/v2/entities/${taskId}/commands/work`, {
      clientMutationId: 'w3-037-explicit-null-note',
      status: 'blocked',
      note: null,
    });
    const after = await workNote();

    const outcome = res.status >= 400
      ? 'REFUSED'
      : after === null || after === undefined
        ? 'CLEARED'
        : String(after) === String(before)
          ? 'SILENTLY PRESERVED'
          : 'CHANGED';

    // eslint-disable-next-line no-console
    console.log('[W3 037 explicit note:null]', JSON.stringify({
      status: res.status,
      errorCode: res.body.error?.code ?? null,
      noteBefore: before,
      noteAfter: after,
      outcome,
    }, null, 2));

    // The only outcome this gate rules out is a SUCCESS that also destroys
    // something the caller did not name. Refusing is defensible, clearing is
    // defensible, preserving is defensible — silently doing a fourth thing is
    // not. Asserted for self-consistency so the recorded value cannot be
    // internally contradictory.
    expect(['REFUSED', 'CLEARED', 'SILENTLY PRESERVED']).toContain(outcome);
  }, 60_000);
});

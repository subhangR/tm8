/**
 * W5 Duo C — MIGRATION 038 AT THE PUBLIC HTTP BOUNDARY.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 * 038 binds `entities.patch`'s ELEVEN replay doors to their own resource. It is
 * verified at the SQL layer, as `tm8_app`, with seeded rows. IT HAS NEVER BEEN
 * DRIVEN THROUGH THE PUBLIC HTTP BOUNDARY.
 *
 * ── WHY THIS DUO'S OWN 98-OPERATION SWEEP CANNOT CLOSE IT ──────────────────
 * BLIND BY CONSTRUCTION, not by omission. Every 038-bound RPC sits BELOW
 * `kindFor` (`services/w2/entities-commands-tracking.ts:757`, call site `:959`),
 * which throws `not_found` on a nonexistent uuid. The sweep sends nonexistent
 * uuids by design, so no probe it makes has ever reached a door 038 binds — and
 * the sweep's 98-row table is byte-identical across the landing of 038 FOR THAT
 * REASON. That identity is a property of the instrument, never evidence about
 * the fix. **The whole job of this fixture is to make `kindFor` RETURN.**
 *
 * ── THE MECHANISM UNDER TEST ───────────────────────────────────────────────
 * `internal.ledger_replay` is keyed on the caller-supplied `clientMutationId`
 * ALONE — not on identity, Space or input. Returning its stored result without a
 * resource check hands one caller's command result to any caller who names the
 * same cmid. 038 binds each door to its own first argument: `p_entity_id` for
 * ten of them, and `p_task_id` for `update_task_content` — NOT a uniform
 * `p_space_id`. A fixture written against the uniform assumption would exercise
 * ten doors and silently skip the eleventh.
 *
 * ── BOTH HALVES ────────────────────────────────────────────────────────────
 * NEGATIVE: a cmid recorded against one resource, replayed naming a DIFFERENT
 *           resource, must be REFUSED — same-door cross-space, and cross-door.
 * POSITIVE: the SAME cmid replayed naming the SAME resource must be ADMITTED.
 *           Without this, every negative is satisfied by a guard that refuses
 *           everyone, which is the failure mode 038's own verification had.
 * CONTROL:  the positive is discriminated by a STALE `expectedVersion`. "The
 *           replay returned the same entity" is weak — an ordinary re-execution
 *           does that too. Only the ledger path can succeed at a version that is
 *           no longer current. And a FRESH cmid at that same stale version must
 *           be REFUSED with a version conflict, or "the replay succeeded at v1"
 *           is equally consistent with the version check simply not enforcing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface EntityView { readonly id: string; readonly version: number; readonly title?: string }

/**
 * THE EXACT REFUSAL 038 PRODUCES, measured rather than assumed.
 *
 * `status >= 400` WOULD NOT BE EVIDENCE ABOUT 038 — it is satisfiable by a
 * version conflict, a not_found, or any other refusal, which is this program's
 * headline defect class applied to my own assertion. Measured at the boundary,
 * the three refusals are cleanly distinguishable:
 *
 *   binding (038)     409 `invariant_violation` · sqlstate 23514 · the W2.SEC-1 detail below
 *   version conflict  409 `version_conflict`    · sqlstate 40001
 *   missing entity    404 `not_found`
 *
 * So every negative below asserts the BINDING refusal specifically, and the
 * controls assert they are NOT it.
 */
const BINDING_CODE = 'invariant_violation';
const BINDING_MESSAGE = 'clientMutationId belongs to another entity';
const BINDING_DETAIL =
  'a replay may not be returned to a request that addresses a different resource '
  + 'than the one it was recorded against (W2.SEC-1)';

function expectBindingRefusal(
  label: string,
  r: {
    status: number;
    errorCode: string | null;
    errorMessage: string | null;
    errorDetails: unknown;
    json: unknown;
  },
): void {
  expect(r.status, `${label}: ${JSON.stringify(r.json ?? r.errorMessage)}`).toBe(409);
  expect(r.errorCode, label).toBe(BINDING_CODE);
  expect(r.errorMessage, label).toBe(BINDING_MESSAGE);
  const detail = (r.errorDetails as { detail?: string; sqlstate?: string } | undefined);
  expect(detail?.detail, `${label}: must be the resource-binding detail, not some other 409`)
    .toBe(BINDING_DETAIL);
  expect(detail?.sqlstate, label).toBe('23514');
}

describe('W5.C migration 038 — resource binding at the PUBLIC HTTP boundary', () => {
  let server: SurfaceServer;
  let spaceA = '';
  let spaceB = '';

  /** Create an entity of `kind` in `spaceId`, returning its id. */
  async function create(spaceId: string, kind: string, title: string, cmid: string): Promise<string> {
    const r = await server.request('POST', '/v2/entities', {
      clientMutationId: cmid, spaceId, kind, title,
    });
    const id = (r.json as { data?: { entity?: EntityView } }).data?.entity?.id;
    if (!id) throw new Error(`fixture could not create ${kind}: ${r.status} ${JSON.stringify(r.json)}`);
    return id;
  }

  async function patch(id: string, cmid: string, expectedVersion: number, title: string) {
    return server.request('PATCH', `/v2/entities/${id}`, {
      clientMutationId: cmid, expectedVersion, title,
    });
  }

  beforeAll(async () => {
    server = await startSurfaceServer('patch038');

    const mk = async (cmid: string, name: string): Promise<string> => {
      const r = await server.request('POST', '/v2/spaces', { clientMutationId: cmid, name });
      const id = (r.json as { data?: { space?: { id?: string } } }).data?.space?.id;
      if (!id) throw new Error(`fixture could not create a space: ${JSON.stringify(r.json)}`);
      return id;
    };
    spaceA = await mk('w5c-038-space-a', 'W5C 038 A');
    spaceB = await mk('w5c-038-space-b', 'W5C 038 B');

    // Two DISTINCT spaces, asserted. If a fixture quirk made them equal, every
    // cross-space negative below would be a same-space case wearing the label.
    expect(spaceA).not.toBe(spaceB);

    /**
     * ⚠ SAME-PRINCIPAL, ASSERTED — THE PRECONDITION THAT MAKES 038 THE ONLY
     * THING THAT CAN REFUSE.
     *
     * Duo A's SQL seed makes ONE identity own both spaces on purpose: if the two
     * probes ran as DIFFERENT principals, `033`'s shared principal pin would
     * refuse the replay and the negatives below would be evidence about 033
     * rather than about 038. This harness reaches the server as the loopback
     * auto-owner, so both spaces have the same owner by construction — measured
     * here rather than assumed, because "by construction" is how a confound
     * survives.
     *
     * The refusal DETAIL asserted in each negative is the second, independent
     * discriminator: 038's binding raises 23514 with the W2.SEC-1 resource text,
     * which is not what a principal violation produces.
     */
    const owners = await server.database.query<{ n: string; spaces: string }>(
      // `public.members.identity_id` is the IDENTITY. An earlier version of this
      // check counted `entities.created_by` over member entities and got 2 —
      // each space has its own member ROW, so that counts members, not
      // identities. A false red from my own query, recorded rather than
      // silently fixed: the confound it was written to exclude was never present.
      `select count(distinct identity_id)::text as n,
              count(distinct space_id)::text as spaces
         from public.members where space_id in ($1, $2)`,
      [spaceA, spaceB],
    );
    expect(owners[0]?.spaces, 'both spaces must have members').toBe('2');
    expect(
      owners[0]?.n,
      'both spaces must be owned by ONE identity, or a refusal below could come from 033\'s '
        + 'principal pin instead of 038\'s resource binding',
    ).toBe('1');
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  /**
   * FAMILY (a) — SAME DOOR, CROSS SPACE. Record via a channel patch in Space A;
   * replay the identical cmid naming a channel in Space B, through the same
   * `update_channel` door.
   *
   * Before 038 this class returned another Space's projection under a success
   * status. THAT IS THE MEASURED DEFECT THE MIGRATION EXISTS TO CLOSE, and this
   * is the first time it is driven at the public boundary.
   */
  it('(a) same-door cross-space replay is REFUSED, not served another Space projection', async () => {
    // `create_channel` validates the name against ^[a-z0-9][a-z0-9_-]{0,79}$,
    // so channels are created with slugs.
    const chanA = await create(spaceA, 'channel', 'w5c-038-chan-a', 'w5c-038-mk-chan-a');
    const chanB = await create(spaceB, 'channel', 'w5c-038-chan-b', 'w5c-038-mk-chan-b');
    expect(chanA).not.toBe(chanB);

    const cmid = 'w5c-038-family-a';
    const recorded = await patch(chanA, cmid, 1, 'renamed-a');
    expect(
      recorded.status,
      `recording patch must succeed: ${JSON.stringify(recorded.json)}`,
    ).toBeLessThan(300);

    const replay = await server.request('PATCH', `/v2/entities/${chanB}`, {
      clientMutationId: cmid, expectedVersion: 1, title: 'renamed-b',
    });

    expectBindingRefusal('(a) same-door cross-space', replay);
    // And nothing of Space A may leak in the refusal body.
    expect(JSON.stringify(replay.json)).not.toContain(chanA);
  });

  /**
   * FAMILY (b) — CROSS DOOR. Record via `update_channel`; replay the SAME cmid
   * through `update_document`.
   *
   * THIS IS THE FAMILY A PER-DOOR FIX WOULD MISS, and it is why 038 had to bind
   * eleven doors rather than one.
   */
  it('(b) cross-door replay is REFUSED (channel-recorded cmid replayed at a document)', async () => {
    const chan = await create(spaceA, 'channel', 'w5c-038-chan-x', 'w5c-038-mk-chan-x');
    const doc = await create(spaceA, 'doc', 'W5C 038 Doc', 'w5c-038-mk-doc');

    const cmid = 'w5c-038-family-b';
    const recorded = await patch(chan, cmid, 1, 'renamed-x');
    expect(recorded.status, JSON.stringify(recorded.json)).toBeLessThan(300);

    const replay = await patch(doc, cmid, 1, 'renamed-doc');
    expectBindingRefusal('(b) cross-door channel->document', replay);
    expect(JSON.stringify(replay.json)).not.toContain(chan);
  });

  /**
   * FAMILY (c) — THE `p_task_id` DOOR. `update_task_content` is the one door
   * whose first argument is NOT `p_entity_id`, so a binding written against
   * `p_entity_id` would silently skip it. Driving it explicitly is the whole
   * point of naming it as its own family.
   */
  it('(c) the p_task_id door (update_task_content) is bound like the other ten', async () => {
    const task = await create(spaceA, 'task', 'W5C 038 Task', 'w5c-038-mk-task');
    const otherTask = await create(spaceB, 'task', 'W5C 038 Task B', 'w5c-038-mk-task-b');

    const cmid = 'w5c-038-family-c';
    const recorded = await patch(task, cmid, 1, 'renamed-task');
    expect(recorded.status, JSON.stringify(recorded.json)).toBeLessThan(300);

    const replay = await patch(otherTask, cmid, 1, 'renamed-task-b');
    expectBindingRefusal('(c) the p_task_id door', replay);
    expect(JSON.stringify(replay.json)).not.toContain(task);
  });

  /**
   * ⚠ THE POSITIVE HALF. WITHOUT THIS EVERY NEGATIVE ABOVE IS SATISFIED BY A
   * GUARD THAT REFUSES EVERYONE — and a blanket-refusing guard would ALSO break
   * legitimate idempotent retries, which is a worse outcome than the defect.
   *
   * DISCRIMINATED BY A STALE `expectedVersion`, because "the replay returned the
   * same entity" is weak evidence — an ordinary re-execution returns the same
   * entity too. Only the LEDGER path can succeed at a version that is no longer
   * current: after the recording patch the entity is at v2, so a replay naming
   * v1 can only be served from the stored result.
   */
  it('POSITIVE: same cmid, SAME resource, at a now-STALE version is ADMITTED (the ledger path)', async () => {
    const chan = await create(spaceA, 'channel', 'w5c-038-chan-pos', 'w5c-038-mk-chan-pos');

    const cmid = 'w5c-038-positive';
    const first = await patch(chan, cmid, 1, 'renamed-once');
    expect(first.status, JSON.stringify(first.json)).toBeLessThan(300);
    const afterFirst = (first.json as { data?: { entity?: EntityView } }).data?.entity;
    expect(afterFirst?.version, 'the recording patch must advance the version').toBeGreaterThan(1);

    // Same cmid, same entity, at the STALE version 1.
    const replay = await patch(chan, cmid, 1, 'renamed-once');
    expect(
      replay.status,
      'A legitimate same-principal same-resource replay must still be ADMITTED. If this is '
        + 'refused, 038 has over-bound and idempotent retry is broken — which is worse than the '
        + `defect it closed. Got ${replay.status}: ${JSON.stringify(replay.json)}`,
    ).toBeLessThan(300);
  });

  /**
   * ⚠ POSITIVES AT MORE THAN ONE DOOR — THE DIRECTION THE SQL-LAYER EVIDENCE
   * CANNOT EXCLUDE.
   *
   * 038's own SQL-layer positive control was driven at ONE door of eleven, and
   * the failure mode a projection mismatch produces there FAILS CLOSED. So a
   * door that OVER-REFUSES a legitimate replay is exactly what that evidence is
   * blind to — and an over-refusing door is arguably worse than the defect,
   * because it breaks idempotent retry for every well-behaved client.
   *
   * Four distinct doors driven here: `update_channel`, `update_document`,
   * `update_task_content` (the `p_task_id` door) and `update_collection`. Each
   * must ADMIT its own legitimate replay at a now-stale version.
   */
  it('POSITIVE ACROSS FOUR DOORS: none over-refuses a legitimate same-resource replay', async () => {
    const doors: ReadonlyArray<readonly [kind: string, title: string]> = [
      ['channel', 'w5c-038-chan-multi'],
      ['doc', 'W5C 038 Doc Multi'],
      ['task', 'W5C 038 Task Multi'],
      ['collection', 'W5C 038 Collection Multi'],
    ];

    const refused: string[] = [];
    for (const [kind, title] of doors) {
      const id = await create(spaceA, kind, title, `w5c-038-multi-mk-${kind}`);
      const cmid = `w5c-038-multi-${kind}`;
      // `create_channel`/`update_channel` validate the name against
      // ^[a-z0-9][a-z0-9_-]{0,79}$ — a space in the new title is refused by
      // `channels_name_check`, which is a FIXTURE error and would masquerade as
      // an over-refusal. Slug titles for channels; free text elsewhere.
      const renamed = kind === 'channel' ? `${title}-renamed` : `${title} renamed`;

      const first = await patch(id, cmid, 1, renamed);
      if (first.status >= 300) {
        throw new Error(`fixture: recording patch failed for ${kind}: ${JSON.stringify(first.json)}`);
      }

      // Same cmid, same resource, at the now-stale version 1.
      const replay = await patch(id, cmid, 1, renamed);
      if (replay.status >= 300) {
        refused.push(`${kind}: ${replay.status} ${replay.errorCode} ${replay.errorMessage}`);
      }
    }

    expect(
      refused,
      'These doors REFUSED a legitimate same-principal, same-resource replay. That is 038 '
        + 'OVER-BINDING, which breaks idempotent retry — the failure direction the SQL-layer '
        + 'positive control (driven at one door, failing closed) could not exclude.',
    ).toEqual([]);
  });

  /**
   * THE CONTROL THAT MAKES THE POSITIVE MEAN SOMETHING.
   *
   * A FRESH cmid at the same stale version must be REFUSED with a version
   * conflict. Without this, "the replay succeeded at v1" is equally consistent
   * with the version check simply not enforcing — in which case the positive
   * above would prove nothing about the ledger path at all.
   */
  it('CONTROL: a FRESH cmid at the same stale version is REFUSED (so the positive is not vacuous)', async () => {
    const chan = await create(spaceA, 'channel', 'w5c-038-chan-ctl', 'w5c-038-mk-chan-ctl');

    const first = await patch(chan, 'w5c-038-control-record', 1, 'ctl-once');
    expect(first.status, JSON.stringify(first.json)).toBeLessThan(300);

    const fresh = await patch(chan, 'w5c-038-control-fresh', 1, 'ctl-twice');
    expect(
      fresh.status,
      'A FRESH cmid at a stale expectedVersion must be refused with a version conflict. If this '
        + 'succeeds, the version check is not enforcing and the POSITIVE test above proves nothing '
        + `about the ledger path. Got ${fresh.status}: ${JSON.stringify(fresh.json)}`,
    ).toBe(409);
    // AND IT MUST BE A DIFFERENT REFUSAL FROM THE BINDING. If a version conflict
    // and a resource-binding violation were the same code, the three negatives
    // above would not be evidence about 038 at all.
    expect(fresh.errorCode, 'the version check is a DISTINCT gate from the binding').toBe('version_conflict');
    expect(fresh.errorCode).not.toBe(BINDING_CODE);
    expect((fresh.errorDetails as { sqlstate?: string } | undefined)?.sqlstate).toBe('40001');
  });
});

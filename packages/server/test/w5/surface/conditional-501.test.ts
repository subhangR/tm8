/**
 * W5 Duo C — CONDITIONAL 501s: the reachable ones, and the one that is an
 * epitaph.
 *
 * WHY THIS FILE EXISTS AT ALL. `sweep.test.ts` sends ONE schema-valid body per
 * operation and found zero 501s. That green is worth exactly nothing unless the
 * pipeline can report a 501 WHEN ONE GENUINELY OCCURS — an instrument that
 * cannot see the thing it is looking for reports "absent" and "blind"
 * identically. This file is the sweep's missing RED-ON-KNOWN-BAD half: it drives
 * inputs that MUST produce a handler 501 and requires the same harness, the same
 * classification and the same wire path to surface them.
 *
 * It also settles the taxonomy question the close document's canonical example
 * rests on, and the answer is not the one anybody predicted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

/**
 * ⚠ BOTH DEFAULTS, SET AT ONE POINT. VITEST SHIPS TWO INDEPENDENT TIMEOUTS AND A
 * GENEROUS `beforeAll` ARGUMENT COVERS NEITHER:
 *   testTimeout   5s  -> a NAMED test failure
 *   hookTimeout  10s  -> an UNNAMED file-level abort
 *
 * This file drives a real HTTP Server against a real scratch database, and its
 * teardown DROPS that database. On a host measured swinging between 2.7x and 6x
 * oversubscribed — ~92% of it this wave measuring itself — neither default is
 * survivable, and BOTH failure modes are load-sensitive: invisible on a quiet
 * machine, firing precisely inside a landing gate where load is highest and
 * where they would be attributed to the migration rather than to the clock.
 *
 * THE NAMED VARIANT IS THE DANGEROUS ONE. An unnamed abort is loud and cannot be
 * mistaken for an assertion. A `Test timed out in 5000ms` arrives WITH A TEST
 * NAME, so a subset-of-expected-names check matches it, finds it absent, and
 * classifies it as a regression from the landing.
 *
 * Spelling follows the in-tree precedent at
 * `packages/cli/test/integration/inbox.test.ts:39`. Explicit per-hook and
 * per-test arguments still override these, so the values already written at
 * individual call sites stand.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });


const ABSENT = '01900000-0000-7000-8000-000000000001';

describe('W5.C conditional 501s and the create/patch taxonomy', () => {
  let server: SurfaceServer;

  beforeAll(async () => {
    server = await startSurfaceServer('cond501');
  }, 180_000);

  // Explicit: `afterAll` is configured independently of `beforeAll` and defaults
  // to 10s. This teardown drops a scratch database over a fresh admin
  // connection, which does not fit in 10s under load — and a teardown timeout
  // aborts the FILE with no failing test name, so it cannot be subset-matched
  // against an expected-failure set. See sweep.test.ts for the full note.
  afterAll(async () => {
    await server?.close();
  }, 120_000);

  /**
   * POSITIVE CONTROL FOR THE ENTIRE SWEEP.
   *
   * `execution-handlers.ts:556,559` throw `notImplemented(...)` at handler
   * entry, before any database work, on inputs their schema fully accepts.
   * These are genuine, reachable, per-input handler 501s.
   *
   * NOTE WHAT THE MESSAGE LOOKS LIKE. Both go through the SAME
   * `notImplemented()` helper (`errors.ts:135-138`) the ROUTER uses at `:164`,
   * so a handler 501 and a router 501 are textually identical in format —
   * `operation <X> is not implemented on this node`. This is the concrete
   * demonstration that message text could never have been the discriminator,
   * and it is why the sweep attributes by reading the live registry instead.
   */
  it('CONTROL: reachable handler 501s exist and this harness reports them', async () => {
    const base = {
      clientMutationId: 'w5c-control',
      spaceId: ABSENT,
      teamMemberId: ABSENT,
    };

    const scratch = await server.request('POST', '/v2/execution/spawn', {
      ...base, workdir: { mode: 'scratch' },
    });
    expect(scratch.status).toBe(501);
    expect(scratch.errorCode).toBe('not_implemented');
    expect(scratch.errorMessage).toBe(
      'operation execution.spawn workdir.mode=scratch is not implemented on this node',
    );

    const profile = await server.request('POST', '/v2/execution/spawn', {
      ...base, interactionProfileId: ABSENT,
    });
    expect(profile.status).toBe(501);
    expect(profile.errorCode).toBe('not_implemented');
    expect(profile.errorMessage).toBe(
      'operation execution.spawn interactionProfileId is not implemented on this node',
    );

    // The registry says `execution.spawn` IS mounted, so these 501s are
    // attributable to the handler — the exact classification the sweep would
    // have applied. The sweep's zero is therefore an absence, not a blindness.
    expect(server.production.server.registry.has('execution.spawn')).toBe(true);
  });

  /**
   * THE TAXONOMY QUESTION, SETTLED — AND THE ANSWER OVERTURNS THE PREMISE.
   *
   * The question as posed: `entities-commands-tracking.ts:940` refuses an
   * unhandled kind on CREATE with `forbidden` (403) while `:1018` refuses the
   * structurally identical case on PATCH with `not_implemented` (501). Two
   * identical guards, two taxonomies.
   *
   * MEASURED: THEY DO NOT DISAGREE, BECAUSE `:1018` NEVER RUNS.
   * `entities.patch` calls `assertGenericLifecycle(kind, 'entities.patch')` at
   * `:960` — BEFORE the switch — and `RESTRICTED_LIFECYCLE_KINDS` (`:49-55`) is
   * EXACTLY {member, message, work_session, project, interaction_profile},
   * which is EXACTLY the set of core kinds the switch does not case on. The 15
   * core kinds partition with no remainder: 10 handled by the switch, 5 refused
   * at `:960` with 403. A `c:` kind passes the `startsWith('c:')` test. Nothing
   * is left to reach the throw.
   */
  it('entities.patch answers 403 from :960, never the 501 at :1018', async () => {
    const space = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-tax-space', name: 'W5C Taxonomy',
    });
    expect(space.status).toBe(201);
    const sd = (space.json as {
      data?: { space?: { id?: string }; memberId?: string; defaultChannelId?: string };
    }).data;
    const memberId = sd?.memberId;
    const channelId = sd?.defaultChannelId;
    expect(memberId, 'spaces.create must yield a member entity').toBeTruthy();

    // A `message` entity, the second restricted kind reachable via the API.
    const posted = await server.request('POST', '/v2/messages', {
      clientMutationId: 'w5c-tax-msg', anchorIds: [channelId], body: 'w5c taxonomy probe',
    });
    expect(posted.status).toBe(200);
    const messageId = (posted.json as { data?: { messages?: Array<{ id?: string }> } })
      .data?.messages?.[0]?.id;
    expect(messageId).toBeTruthy();

    for (const [kind, id] of [['member', memberId], ['message', messageId]] as const) {
      const patched = await server.request('PATCH', `/v2/entities/${id}`, {
        clientMutationId: `w5c-tax-patch-${kind}`, expectedVersion: 1, title: 'renamed',
      });
      expect(patched.status, `entities.patch on kind=${kind}`).toBe(403);
      expect(patched.errorCode).toBe('forbidden');
      expect(patched.errorMessage).toBe(`entities.patch is owned by the ${kind} lifecycle`);
      expect(patched.errorCode, 'the :1018 not_implemented must never surface').not.toBe(
        'not_implemented',
      );
    }
  }, 180_000);

  /**
   * The other half of the same partition: CREATE cannot reach `:940` either,
   * for a DIFFERENT reason — the contract schema excludes the five restricted
   * kinds outright (`schemas.ts:853`), so they are refused at `server.ts:166`
   * and never arrive at the switch.
   *
   * So the two operations agree on OBSERVABLE BEHAVIOUR (403 for a restricted
   * kind on patch; 400 on create) and their two default arms are BOTH dead for
   * core kinds. The close document's "entities.create returns 501 on an
   * unsupported kind" describes NEITHER live arm — it matches only the deleted
   * `handlers/entities.ts:516`, which gates on an allow-list rather than the
   * `c:` prefix and has no call sites.
   */
  it('entities.create refuses restricted kinds at :166, never reaching :940', async () => {
    for (const kind of ['message', 'member', 'work_session', 'project', 'interaction_profile']) {
      const created = await server.request('POST', '/v2/entities', {
        clientMutationId: `w5c-tax-create-${kind}`, spaceId: ABSENT, kind, title: 'w5c',
      });
      expect(created.status, `entities.create kind=${kind}`).toBe(400);
      // The :166 literal, positively identifying the gate that refused it.
      expect(created.errorMessage).toBe('request body failed contract validation');
    }
  }, 180_000);

  /**
   * THE LIMIT ON THE UNREACHABILITY CLAIM, STATED INLINE BECAUSE IT IS THE
   * REASSURING DIRECTION.
   *
   * `public.entities.kind` is plain `text` with NO check constraint — verified
   * by `pg_catalog` introspection rather than by reading migrations, because a
   * constraint could have come from any of the 34 files. So the database
   * PERMITS a kind that is neither core nor `c:`-prefixed, and such a row WOULD
   * reach `:1018`.
   *
   * The claim is therefore precisely: `:1018` is unreachable THROUGH THE PUBLIC
   * API, not unreachable absolutely. No API path writes such a kind. A direct
   * database insert, or a future writer that does, would revive the branch —
   * and this test is what would then go red.
   */
  it('records the exact basis of the unreachability claim: kind is unconstrained text', async () => {
    const columns = await server.database.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'entities' and column_name = 'kind'`,
    );
    expect(columns[0]?.data_type).toBe('text');

    const checks = await server.database.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'entities' and c.contype = 'c'`,
    );
    const kindChecks = checks.filter((c) => c.def.includes('kind'));
    expect(
      kindChecks.map((c) => c.def),
      'a CHECK on kind would make the unreachability claim absolute rather than API-scoped',
    ).toEqual([]);
  }, 180_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * CROSS-GROUP: idempotency identity and authorization ordering.
 *
 * W2/INV-1 reported that `public.w2_update_space` (migration 016, the RPC behind
 * `spaces.update`) returns `internal.ledger_replay(cmid, 'spaces.update')` at
 * `016:83-84` with a BARE RETURN and zero authorization, while
 * `internal.require_space_admin(p_space_id)` is only reached at `016:113`.
 * `internal.ledger_replay` selects `where client_mutation_id = p_cmid` with no
 * identity, Space, or actor predicate — it is keyed GLOBALLY on a caller-supplied
 * string, checking only that the stored operation name matches.
 *
 * W2 proved that at the SQL layer and explicitly did NOT prove reachability through
 * the public HTTP boundary. That reachability question is what this file answers,
 * and W2 asked for it either way: if the facade constrains the cmid so the replay is
 * NOT publicly reachable, that is good news and materially lowers severity.
 *
 * The decisive observation does not require a second identity. If a caller names
 * Space B but receives Space A's stored projection, then the replay is not bound to
 * the Space named in the request, and authorization ordering has been bypassed
 * through the public boundary. Phase-1 identity is the single loopback auto-owner,
 * so this file deliberately establishes the SPACE-BINDING half; the
 * non-member-identity half is a severity question that Phase-1 identity cannot pose.
 */
describe.sequential('W3.XG01 ledger replay is bound to the request it replays', () => {
  let harness: W3PublicServer;
  let spaceA = '';
  let spaceB = '';

  const SHARED_CMID = 'w3-xg01-shared-replay-cmid';
  const SPACE_A_NAME = 'W3 XG01 Space A renamed';

  beforeAll(async () => {
    harness = await startW3PublicServer('xg01');
    const a = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-xg01-space-a',
        name: 'W3 XG01 Space A',
      }),
    );
    spaceA = a.space.id;
    const b = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-xg01-space-b',
        name: 'W3 XG01 Space B',
      }),
    );
    spaceB = b.space.id;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('does not hand Space A\'s stored projection to a request that names Space B', async () => {
    // 1. A legitimate admin update on Space A, establishing the ledger row.
    const onA = successData<{ id: string; name: string }>(
      await harness.request('PATCH', `/v2/spaces/${spaceA}`, {
        clientMutationId: SHARED_CMID,
        name: SPACE_A_NAME,
        githubRepo: null,
      }),
    );
    expect(onA).toMatchObject({ id: spaceA, name: SPACE_A_NAME });

    // 2. The SAME clientMutationId, now aimed at a DIFFERENT Space.
    const onB = await harness.request<{ id: string; name: string }>(
      'PATCH',
      `/v2/spaces/${spaceB}`,
      { clientMutationId: SHARED_CMID, name: 'W3 XG01 Space B renamed' },
    );

    const leaked =
      JSON.stringify(onB.body).includes(SPACE_A_NAME)
      || JSON.stringify(onB.body).includes(spaceA);

    // Whatever the Server chooses to do here — refuse the reuse, or act on Space B —
    // it must NOT return Space A's identity or stored projection to a request that
    // named Space B. That is the assertion under test.
    expect({
      status: onB.status,
      errorCode: onB.body.error?.code ?? null,
      returnedId: onB.body.data?.id ?? null,
      returnedName: onB.body.data?.name ?? null,
      spaceA,
      spaceB,
      leakedSpaceAProjection: leaked,
    // A REFUSAL is a correct outcome here, as is acting on Space B. The only
    // forbidden outcome is returning Space A's identity or projection. SEC-1's
    // migration 031 now refuses this with 409, which satisfies the law.
    }).toMatchObject({ leakedSpaceAProjection: false });

    // Authoritative DB check: Space B must not have been renamed to Space A's name,
    // and Space A must not have been mutated by a request that named Space B.
    const rows = await harness.rows<{ id: string; name: string }>(
      'select id::text, name from public.spaces where id = any($1::uuid[]) order by name',
      [[spaceA, spaceB]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    expect(byId.get(spaceA)).toBe(SPACE_A_NAME);
    expect(byId.get(spaceB)).not.toBe(SPACE_A_NAME);
  });

  /**
   * SEVERITY INPUT. The replay bypass requires knowing a clientMutationId another
   * principal recorded, so severity turns on whether a cmid can be HARVESTED. If any
   * readable projection carries the cmid, then every principal who can read that
   * projection can collect them, and the exploit stops requiring a guess.
   *
   * Phase-1 identity is a single loopback auto-owner, so this cannot pose
   * "echoed to a NON-recorder" directly. It poses the necessary precondition
   * instead: does the cmid appear in a read projection AT ALL? A negative here is a
   * genuine severity reduction; a positive is a severity escalation.
   */
  it('does not surface a recorded clientMutationId in any composed read projection', async () => {
    const secret = 'w3-xg01-harvestable-cmid-marker';
    const entity = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: secret,
        spaceId: spaceA,
        kind: 'task',
        title: 'XG01 cmid harvest probe',
        content: { priority: 'medium' },
      }),
    );
    const id = entity.entity.id;

    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/v2/entities/${id}`],
      ['GET', `/v2/entities/${id}/activity`],
      ['GET', `/v2/entities/${id}/versions`],
      ['GET', `/v2/entities/${id}/children`],
      ['GET', `/v2/entities/${id}/connections`],
      ['GET', `/v2/entities/${id}/hierarchy`],
      ['GET', `/v2/spaces/${spaceA}`],
      ['GET', `/v2/spaces/${spaceA}/navigation`],
      ['GET', `/v2/inbox`],
      ['GET', `/v2/actions?entityId=${id}`],
      ['POST', '/v2/collections/query', { spaceId: spaceA, kinds: ['task'], limit: 20 }],
    ];

    const exposures: string[] = [];
    for (const [method, path, body] of probes) {
      const res = await harness.request(method, path, body);
      if (res.status < 400 && JSON.stringify(res.body).includes(secret)) {
        exposures.push(`${method} ${path}`);
      }
    }

    // A cmid recorded by one principal must not be readable back out of any
    // projection, or it becomes harvestable material for the replay bypass.
    expect(exposures).toEqual([]);

    // Non-vacuousness: prove the probe CAN detect the marker, so an empty result
    // means "absent" rather than "the probe never looked at anything".
    const ledgerHasIt = await harness.rows<{ n: number }>(
      `select count(*)::integer n from public.command_ledger where client_mutation_id = $1`,
      [secret],
    );
    expect(ledgerHasIt[0]?.n).toBe(1);
  });

  /**
   * MESSAGE-PATH RE-PROBE. The sweep above recorded its marker via `entities.create`,
   * where `messageBatchId` is null by construction — so it could not have surfaced the
   * exposure W4 found in frozen source: the dossier mandates
   * `messages.message_batch_id = clientMutationId` (019:6, 019:491), and
   * `messageBatchId` is a published field on message entity state
   * (contract.ts:93, schemas.ts:164) already projected by the composed read path
   * (facade/entity-read.ts:583).
   *
   * That is a named, specific gap in the sweep. This case measures the message path
   * rather than reasoning about it, and it deliberately sends a VALID body — a
   * no-body probe fails input validation before reaching the handler and would
   * misreport the operation as implemented.
   */
  it('measures whether the composed message path publishes a clientMutationId', async () => {
    const marker = 'w3-xg01-message-batch-marker';
    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-xg01-msg-anchor',
        spaceId: spaceA,
        kind: 'task',
        title: 'XG01 message anchor',
        content: { priority: 'medium' },
      }),
    );

    const posted = await harness.request('POST', '/v2/messages', {
      clientMutationId: marker,
      anchorIds: [anchor.entity.id],
      body: 'XG01 message path probe',
    });

    // Record the measured reality rather than asserting a presumed one.
    const composedMessagePathLive = posted.status >= 200 && posted.status < 300;

    let exposures: string[] = [];
    if (composedMessagePathLive) {
      const probes: Array<[string, string, unknown?]> = [
        ['GET', `/v2/entities/${anchor.entity.id}/messages`],
        ['GET', `/v2/entities/${anchor.entity.id}`],
        ['GET', `/v2/entities/${anchor.entity.id}/children`],
        ['POST', '/v2/collections/query', { spaceId: spaceA, kinds: ['message'], limit: 20 }],
      ];
      for (const [method, path, body] of probes) {
        const res = await harness.request(method, path, body);
        if (res.status < 400 && JSON.stringify(res.body).includes(marker)) {
          exposures.push(`${method} ${path}`);
        }
      }
    }

    const batchRows = await harness.rows<{ n: number }>(
      `select count(*)::integer n from public.messages where message_batch_id = $1`,
      [marker],
    );

    // This case is a MEASUREMENT, not a pass/fail law. It asserts the two outcomes
    // are consistent with each other so the recorded result cannot be self-contradictory:
    // a cmid can only be published through a read if a message carrying it exists.
    expect({
      postStatus: posted.status,
      postErrorCode: posted.body.error?.code ?? null,
      composedMessagePathLive,
      messagesCarryingTheCmid: batchRows[0]?.n ?? 0,
      cmidExposedInReads: exposures,
    }).toMatchObject({
      cmidExposedInReads: batchRows[0]?.n === 0 ? [] : exposures,
    });

    // If the message path is NOT live, the exposure is LATENT, not absent: migration
    // 019 mandates the equality and it activates when G04 composes.
    if (!composedMessagePathLive) {
      expect(posted.status).toBe(501);
      expect(posted.body.error?.code).toBe('not_implemented');
      expect(batchRows[0]?.n).toBe(0);
    }
  });

  /**
   * PREDICTION TEST, via the EMBED path — the only composed route that actually
   * creates a message row (composed `messages.post` is a 501 stub).
   *
   * Three independent source readings (W2, W4, program coordinator) predict
   * messageBatchId is NULL here, because `place_entity`'s embed branch calls
   * `public.post_message` (007:1680) whose INSERT column list omits
   * `message_batch_id`, and only G04's 019 populates it. If this measures a
   * POPULATED batch id, all three readings are wrong and it is a major finding.
   * Either way it converts source reasoning into an executed result.
   */
  it('measures messageBatchId on a message created through the composed embed path', async () => {
    const mk = async (suffix: string): Promise<string> => {
      const r = successData<{ entity: { id: string } }>(
        await harness.request('POST', '/v2/entities', {
          clientMutationId: `w3-xg01-embed-${suffix}`,
          spaceId: spaceA,
          kind: 'task',
          title: `XG01 embed ${suffix}`,
          content: { priority: 'medium' },
        }),
      );
      return r.entity.id;
    };
    const src = await mk('src');
    const tgt = await mk('tgt');

    const embedCmid = 'w3-xg01-embed-placement-cmid';
    const placed = await harness.request<{ entity?: { id: string } }>(
      'POST',
      '/v2/placements',
      { clientMutationId: embedCmid, sourceId: src, targetId: tgt, intent: 'embed' },
    );
    expect(placed.status).toBe(200);
    const messageId = placed.body.data?.entity?.id ?? '';
    expect(messageId).toBeTruthy();

    // Authoritative DB state for the message the composed path actually created.
    const row = await harness.rows<{ batch: string | null; client_msg: string | null }>(
      'select message_batch_id as batch, client_msg_id as client_msg from public.messages where entity_id = $1',
      [messageId],
    );

    // Public read projections that expose message entity state.
    const reads: Array<[string, string, unknown?]> = [
      ['GET', `/v2/entities/${messageId}`],
      ['GET', `/v2/entities/${tgt}/messages`],
      ['POST', '/v2/collections/query', { spaceId: spaceA, kinds: ['message'], limit: 20 }],
    ];
    const cmidExposures: string[] = [];
    let projectedBatchIds: unknown[] = [];
    for (const [method, path, body] of reads) {
      const res = await harness.request(method, path, body);
      if (res.status >= 400) continue;
      const text = JSON.stringify(res.body);
      if (text.includes(embedCmid)) cmidExposures.push(`${method} ${path}`);
      for (const m of text.matchAll(/"messageBatchId":(null|"[^"]*")/g)) {
        projectedBatchIds.push(m[1]);
      }
    }

    expect({
      storedBatchId: row[0]?.batch ?? null,
      storedClientMsgId: row[0]?.client_msg ?? null,
      projectedBatchIds: [...new Set(projectedBatchIds)],
      cmidExposedInReads: cmidExposures,
    }).toMatchObject({
      storedBatchId: null,
      cmidExposedInReads: [],
    });
  });

  /**
   * PRIVILEGE-ESCALATION CHAIN. `create_invite` (007:583) returns
   * `internal.ledger_replay(cmid,'spaces.invites.create')` with a BARE RETURN before
   * `internal.require_space_admin`, and its stored result is
   * `jsonb_build_object('invite', to_jsonb(invite), ...)` — the FULL `space_invites`
   * row INCLUDING the live `code`. `redeem_invite(p_code)` consumes exactly that code
   * to grant membership.
   *
   * SEC-1's migration 031 does NOT redefine `create_invite`. Its six replaced
   * functions are w2_update_space, grant_stream_attach, join_public_space,
   * redeem_invite, set_space_default_channel and update_space_menu. So this site
   * survives Stage 1 of the fix.
   *
   * Measured here rather than argued: does a replay aimed at a DIFFERENT Space hand
   * back the first Space's live invite code through the public boundary?
   */
  it('does not hand Space A\'s live invite CODE to a create-invite replay naming Space B', async () => {
    const inviteCmid = 'w3-xg01-invite-escalation-cmid';

    const first = await harness.request<{ invite?: Record<string, unknown> }>(
      'POST',
      `/v2/spaces/${spaceA}/invites`,
      { clientMutationId: inviteCmid, maxUses: 1 },
    );
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    // Measure the actual public DTO rather than assuming its shape.
    const firstBodyText = JSON.stringify(first.body);
    const codeMatch = firstBodyText.match(/inv_[a-f0-9]+/);
    const codeA = codeMatch ? codeMatch[0] : '';
    const publicDtoExposesCode = codeA.length > 0;

    // Authoritative: the code that actually exists in storage for Space A.
    const storedA = await harness.rows<{ code: string }>(
      'select code from public.space_invites where space_id = $1 order by created_at desc limit 1',
      [spaceA],
    );
    const storedCodeA = storedA[0]?.code ?? '';
    expect(storedCodeA).toMatch(/^inv_/);

    // Same clientMutationId, aimed at a DIFFERENT Space.
    const replayOnB = await harness.request<{ invite?: Record<string, unknown> }>(
      'POST',
      `/v2/spaces/${spaceB}/invites`,
      { clientMutationId: inviteCmid, maxUses: 1 },
    );

    const leakedCode = storedCodeA.length > 0
      && JSON.stringify(replayOnB.body).includes(storedCodeA);

    // Authoritative: how many invites actually exist per Space?
    const counts = await harness.rows<{ space_id: string; n: number }>(
      `select space_id::text, count(*)::integer n from public.space_invites
        where space_id = any($1::uuid[]) group by space_id`,
      [[spaceA, spaceB]],
    );
    const bySpace = new Map(counts.map((r) => [r.space_id, r.n]));

    expect({
      status: replayOnB.status,
      errorCode: replayOnB.body.error?.code ?? null,
      leakedSpaceAInviteCode: leakedCode,
      invitesInSpaceA: bySpace.get(spaceA) ?? 0,
      invitesInSpaceB: bySpace.get(spaceB) ?? 0,
      publicDtoExposesInviteCodeOnCreate: publicDtoExposesCode,
    }).toMatchObject({ leakedSpaceAInviteCode: false });
  });

  /**
   * CONCURRENT PUBLIC-BOUNDARY RACE. W3's other replay cases are SEQUENTIAL, and
   * SEC-1 proved executably that a full sequential suite can pass on a build whose
   * concurrent path leaks. This closes the half of that gap W3 can actually reach.
   *
   * SCOPE, stated because it is narrower than SEC-1's DB-level race test:
   *  - REACHABLE here: two CONCURRENT public requests carrying the SAME cmid at
   *    DIFFERENT resources. `ledger_replay` takes an advisory xact lock on the cmid,
   *    so one blocks on the other; the loser then meets the replay branch with a
   *    committed row present. That exercises the resource binding under contention
   *    through the real production boundary — the actual attack surface.
   *  - NOT REACHABLE here: a cross-PRINCIPAL race (Phase-1 is a single loopback
   *    auto-owner, so both requests carry one identity), and controlled
   *    uncommitted-transaction interleaving (each HTTP request commits before it
   *    responds, so W3 cannot park a victim mid-transaction). SEC-1's two-connection
   *    test with the pg_locks assertion covers those; this does not replace it.
   */
  it('holds the resource binding when two concurrent requests share one clientMutationId', async () => {
    const raceCmid = 'w3-xg01-concurrent-race-cmid';
    const nameA = 'W3 XG01 race A';
    const nameB = 'W3 XG01 race B';

    const [resA, resB] = await Promise.all([
      harness.request<{ id: string; name: string }>('PATCH', `/v2/spaces/${spaceA}`, {
        clientMutationId: raceCmid, name: nameA,
      }),
      harness.request<{ id: string; name: string }>('PATCH', `/v2/spaces/${spaceB}`, {
        clientMutationId: raceCmid, name: nameB,
      }),
    ]);

    // Exactly one may succeed; the loser must be REFUSED, never handed the winner's
    // projection. A cross-resource leak under contention is the failure mode.
    const ok = [resA, resB].filter((r) => r.status >= 200 && r.status < 300);
    const crossLeak =
      (resA.body.data?.id != null && resA.body.data.id !== spaceA)
      || (resB.body.data?.id != null && resB.body.data.id !== spaceB);

    const rows = await harness.rows<{ id: string; name: string }>(
      'select id::text, name from public.spaces where id = any($1::uuid[])',
      [[spaceA, spaceB]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.name]));

    expect({
      statuses: [resA.status, resB.status],
      successes: ok.length,
      crossResourceLeak: crossLeak,
      // Neither Space may end up carrying the OTHER request's intended name.
      spaceAName: byId.get(spaceA),
      spaceBName: byId.get(spaceB),
    }).toMatchObject({ crossResourceLeak: false });

    expect(byId.get(spaceA)).not.toBe(nameB);
    expect(byId.get(spaceB)).not.toBe(nameA);
  });

  it('binds a replayed clientMutationId to its original operation', async () => {
    // Non-vacuousness probe for the ledger machinery itself: reusing the same cmid
    // under a DIFFERENT operation must be refused, proving the ledger is consulted
    // at all on this path rather than the previous case passing by inertia.
    const wrongOperation = await harness.request('POST', '/v2/spaces', {
      clientMutationId: SHARED_CMID,
      name: 'W3 XG01 operation-mismatch probe',
    });
    expect(wrongOperation.status).toBeGreaterThanOrEqual(400);

    const spaceCount = await harness.rows<{ n: number }>(
      `select count(*)::integer n from public.spaces
        where name = 'W3 XG01 operation-mismatch probe'`,
    );
    expect(spaceCount[0]?.n).toBe(0);
  });
});

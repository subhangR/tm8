import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.XG02 — IS A clientMutationId HARVESTABLE NOW THAT messages.post IS LIVE?
 *
 * WHY THIS FILE EXISTS. §8.3 reduced the severity of the ledger-replay bypass on
 * the ground that a cmid is NOT harvestable, and the evidence document calls that
 * finding "load-bearing". That result was measured when `messages.post` was an
 * unconditional 501 stub, so no message could carry a batch id.
 *
 * `xg01` anticipated this and armed a branch for it — but in its ACTIVATED state
 * its assertion is
 *     toMatchObject({ cmidExposedInReads: batchRows[0]?.n === 0 ? [] : exposures })
 * which, once any message carries the cmid, compares `exposures` TO ITSELF. It is
 * a tautology in exactly the condition it was written to detect. The foresight was
 * real; the assertion does not survive its own trigger. This file supplies the
 * assertion that does.
 *
 * THE PUBLICATION CHAIN, read in source before being measured here:
 *   019:5-6    "A batch is correlation only (messages.message_batch_id = clientMutationId)"
 *   019:491    result carries 'messageBatchId', p_client_mutation_id
 *   contract.ts:93 / schemas.ts:164   messageBatchId is a PUBLISHED field on message state
 *   entity-read.ts:80   msg.message_batch_id is selected into ENTITY_COLUMNS
 *   entity-read.ts:583  it is projected into every composed message read
 *
 * WHAT A RED HERE MEANS. Not a new defect — a SEVERITY INPUT. If a cmid is
 * readable, the replay bypass stops requiring out-of-band knowledge, and §8.3's
 * "reachable, but not self-serving" framing no longer holds.
 */
describe.sequential('W3.XG02 clientMutationId harvestability through composed reads', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let anchorId = '';
  let messageId = '';

  /** Distinctive enough that a substring hit cannot be a coincidence. */
  const SECRET_CMID = 'w3-xg02-harvestable-secret-cmid-marker';

  beforeAll(async () => {
    harness = await startW3PublicServer('xg02');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-xg02-space',
        name: 'W3 XG02 Space',
      }),
    );
    spaceId = space.space.id;

    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-xg02-anchor',
        spaceId,
        kind: 'task',
        title: 'XG02 harvest anchor',
        content: { priority: 'medium' },
      }),
    );
    anchorId = anchor.entity.id;

    const posted = await harness.request<{ messages: Array<{ id: string }> }>(
      'POST',
      '/v2/messages',
      { clientMutationId: SECRET_CMID, anchorIds: [anchorId], body: 'XG02 harvest probe body' },
    );
    messageId = posted.body.data?.messages?.[0]?.id ?? '';
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

  it('CONTROL: the message path is live and the cmid really is stored against the message', async () => {
    // Without this, an empty exposure list below would be indistinguishable from
    // "nothing was ever posted".
    expect(messageId, 'messages.post did not return a message — every probe below is vacuous').toBeTruthy();
    const rows = await harness.rows<{ n: number }>(
      'select count(*)::integer n from public.messages where message_batch_id = $1',
      [SECRET_CMID],
    );
    expect(rows[0]?.n, 'no stored message carries the cmid — the probe would be vacuous').toBe(1);
  });

  it('measures whether composed READ projections publish the recorded clientMutationId', async () => {
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/v2/entities/${messageId}`],
      ['GET', `/v2/entities/${anchorId}/messages`],
      ['GET', `/v2/entities/${anchorId}`],
      ['GET', `/v2/entities/${anchorId}/children`],
      ['GET', `/v2/entities/${anchorId}/activity`],
      ['GET', `/v2/entities/${anchorId}/feed`],
      ['GET', `/v2/entities/${anchorId}/context`],
      ['GET', '/v2/inbox'],
      ['POST', '/v2/collections/query', { spaceId, kinds: ['message'], limit: 20 }],
    ];

    const exposures: string[] = [];
    const statuses: Record<string, number> = {};
    for (const [method, path, body] of probes) {
      const res = await harness.request(method, path, body);
      statuses[`${method} ${path}`] = res.status;
      if (res.status < 400 && JSON.stringify(res.body).includes(SECRET_CMID)) {
        exposures.push(`${method} ${path}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log('[W3.XG02 harvestability]', JSON.stringify({ statuses, exposures }, null, 2));

    // THE MEASUREMENT, RE-DISPOSITIONED 2026-07-31. This assertion was
    // `toEqual([])` and it fired — the severity input this file exists to
    // measure has flipped, and the flip is DELIBERATE, not a leak:
    // `messageBatchId = clientMutationId` is a PUBLISHED contract field
    // (019:5-6 "correlation only"; schemas.ts MessageState), and the live UI
    // depends on reading it back (optimistic reconcile matches
    // clientMutationId on event frames — tm8-ui chat-mutations/domain-store).
    // Consequence, recorded where §8.3 pointed: non-harvestability is
    // SUPERSEDED, the ledger-replay bypass no longer requires out-of-band
    // knowledge, and any future severity argument must not cite §8.3's
    // "reachable, but not self-serving" framing.
    //
    // The pin is the exact route SET that projects the message DTO — a sixth
    // exposure (or a lost one) is a surface change someone must look at.
    //
    // THE SIXTH ARRIVED, and it was looked at rather than absorbed.
    // `GET /v2/entities/:anchorId` is the anchor's OWN read, which publishes no
    // message field of its own. It exposes the cmid through `connections`:
    // 065_derived_edges_phase1.sql made every message carry a derived
    // `anchored_to` edge to its anchor, so the anchor's `connections.incoming`
    // now lists that edge — and an edge endpoint is projected as a FULL entity
    // summary, whose `state.messageBatchId` is the clientMutationId. Verified by
    // dumping the body, not inferred: the value appears at
    // connections.incoming[anchored_to].edges[].source.state.messageBatchId.
    //
    // It is the same disposition as the five above and not a new one: the field
    // is published by contract, and the route reaches it through a derived edge
    // that is itself a published relationship. Nothing became reachable that a
    // caller could not already read from `GET /v2/entities/:messageId`.
    const exposedRoutes = exposures.map((label) =>
      label
        .replace(messageId, ':messageId')
        .replace(anchorId, ':anchorId'));
    expect(exposedRoutes).toEqual([
      'GET /v2/entities/:messageId',
      'GET /v2/entities/:anchorId/messages',
      'GET /v2/entities/:anchorId',
      'GET /v2/entities/:anchorId/feed',
      'GET /v2/entities/:anchorId/context',
      'POST /v2/collections/query',
    ]);
  }, 120_000);

  /**
   * NEGATIVE CONTROL — the green half, without which the red above is half a proof.
   *
   * A detector that fires on everything passes a mutation test exactly as well as
   * a correct one: firing proves it RESPONDS, never that it DISCRIMINATES. This
   * case runs the IDENTICAL sweep over the IDENTICAL routes with a cmid recorded
   * by `entities.create` instead of `messages.post`. That cmid is stored in
   * `public.command_ledger` just as the other one is, but it is not published on
   * any DTO — so a correct probe must return an EMPTY exposure list here while
   * returning five for the message cmid.
   *
   * If this case ever goes red alongside the one above, the probe is matching
   * something incidental (an echoed request field, a log line, a debug envelope)
   * and the harvestability finding must be withdrawn until it is re-derived.
   */
  it('CONTROL: the same sweep finds NOTHING for a cmid that is not published', async () => {
    const unpublished = 'w3-xg02-control-unpublished-cmid-marker';
    const created = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: unpublished,
        spaceId,
        kind: 'task',
        title: 'XG02 control entity',
        content: { priority: 'medium' },
      }),
    );

    // Same storage-side control as the positive case: the cmid really was
    // recorded, so an empty sweep means "absent from projections" rather than
    // "nothing was ever created".
    const ledger = await harness.rows<{ n: number }>(
      'select count(*)::integer n from public.command_ledger where client_mutation_id = $1',
      [unpublished],
    );
    expect(ledger[0]?.n, 'the control cmid was never recorded — this control is vacuous').toBe(1);

    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/v2/entities/${created.entity.id}`],
      ['GET', `/v2/entities/${anchorId}/messages`],
      ['GET', `/v2/entities/${anchorId}`],
      ['GET', `/v2/entities/${anchorId}/children`],
      ['GET', `/v2/entities/${anchorId}/activity`],
      ['GET', `/v2/entities/${anchorId}/feed`],
      ['GET', `/v2/entities/${anchorId}/context`],
      ['GET', '/v2/inbox'],
      ['POST', '/v2/collections/query', { spaceId, kinds: ['message', 'task'], limit: 20 }],
    ];

    const controlExposures: string[] = [];
    for (const [method, path, body] of probes) {
      const res = await harness.request(method, path, body);
      if (res.status < 400 && JSON.stringify(res.body).includes(unpublished)) {
        controlExposures.push(`${method} ${path}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log('[W3.XG02 negative control]', JSON.stringify({ controlExposures }, null, 2));

    expect(
      controlExposures,
      'the probe reported an exposure for a cmid that is NOT published — it is matching '
        + 'something incidental and the harvestability finding must be re-derived',
    ).toEqual([]);
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.XG03 — SAME-PRINCIPAL RESOURCE CONFUSION AT A SITE OUTSIDE 032's SEVEN.
 *
 * WHAT IS AND IS NOT CLOSED AFTER THE BATCH:
 *   - 033 pins the PRINCIPAL inside internal.ledger_replay, covering ~92 sites
 *     fail-closed. Cross-principal replay is closed GLOBALLY.
 *   - 032 adds RESOURCE binding at exactly SEVEN functions: create_invite,
 *     revoke_invite, w2_revoke_invite, update_project_w2, w2_edit_message,
 *     w2_tombstone_message, post_message.
 *   - 033 structurally CANNOT bind the resource: `internal.ledger_replay`
 *     receives only a cmid and an operation label, so it cannot know which
 *     resource the current request addresses.
 * Therefore SAME-PRINCIPAL resource confusion remains structurally open at every
 * ledgered site OUTSIDE those seven. Phase-1 identity is a single loopback
 * auto-owner, which makes same-principal the TRIVIAL case rather than an exotic
 * one — the attacker and the victim are the same account by construction.
 *
 * SITE CHOICE IS LOAD-BEARING. `entities.create` is NOT one of 032's seven, and
 * it is the site SEC-1b used precisely because 031 does not touch it either. Its
 * stored projection carries the created entity's identity, including its Space.
 * If a replay aimed at Space B returns Space A's entity, authorization ordering
 * has been bypassed for a resource the request did not name.
 *
 * WHY THIS IS NOT A DUPLICATE OF xg01. xg01 measures `spaces.update` and
 * `spaces.invites.create` — the latter now COVERED by 032. This measures a site
 * deliberately left uncovered, which is where the residual risk actually lives.
 *
 * HARVESTABILITY MAKES THIS REACHABLE RATHER THAN THEORETICAL. W3.XG02 measured
 * that a recorded clientMutationId is readable back out of five composed read
 * routes, so an attacker no longer needs to guess one. §8.3's non-harvestability
 * mitigation is superseded and must not be cited here.
 */
describe.sequential('W3.XG03 same-principal replay across resources, outside 032', () => {
  let harness: W3PublicServer;
  let spaceA = '';
  let spaceB = '';

  const SHARED_CMID = 'w3-xg03-cross-space-entities-create';
  const TITLE_A = 'XG03 entity that belongs to Space A';

  beforeAll(async () => {
    harness = await startW3PublicServer('xg03');
    for (const [name, assign] of [
      ['W3 XG03 Space A', (id: string) => { spaceA = id; }],
      ['W3 XG03 Space B', (id: string) => { spaceB = id; }],
    ] as Array<[string, (id: string) => void]>) {
      const created = successData<{ space: { id: string } }>(
        await harness.request('POST', '/v2/spaces', {
          clientMutationId: `w3-xg03-${name}`,
          name,
        }),
      );
      assign(created.space.id);
    }
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('does not hand Space A\'s created entity to an entities.create replay naming Space B', async () => {
    const first = successData<{ entity: { id: string; spaceId: string; title: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: SHARED_CMID,
        spaceId: spaceA,
        kind: 'task',
        title: TITLE_A,
        content: { priority: 'medium' },
      }),
    );
    expect(first.entity.spaceId).toBe(spaceA);

    // CONTROL, and it is what makes a refusal below meaningful rather than a
    // blanket denial: the SAME principal replaying the SAME cmid at the SAME
    // Space must still get its stored result back. A guard that refuses everyone
    // would pass the negative and fail this.
    const sameResource = await harness.request<{ entity: { id: string } }>(
      'POST',
      '/v2/entities',
      {
        clientMutationId: SHARED_CMID,
        spaceId: spaceA,
        kind: 'task',
        title: TITLE_A,
        content: { priority: 'medium' },
      },
    );
    expect(
      sameResource.body.data?.entity?.id,
      'legitimate same-principal same-resource idempotency was traded away',
    ).toBe(first.entity.id);

    // THE NEGATIVE. Same principal — Phase-1 has only one — but a DIFFERENT
    // Space named in the request.
    const crossResource = await harness.request<{ entity: { id: string; spaceId: string; title: string } }>(
      'POST',
      '/v2/entities',
      {
        clientMutationId: SHARED_CMID,
        spaceId: spaceB,
        kind: 'task',
        title: 'XG03 entity that should belong to Space B',
        content: { priority: 'medium' },
      },
    );

    const text = JSON.stringify(crossResource.body);
    const leaked = text.includes(first.entity.id) || text.includes(TITLE_A);

    // Authoritative storage check: Space B must not have acquired Space A's
    // entity, and Space A's entity must still live in Space A.
    const rows = await harness.rows<{ id: string; space_id: string }>(
      'select id::text, space_id::text from public.entities where id = $1',
      [first.entity.id],
    );

    // eslint-disable-next-line no-console
    console.log('[W3.XG03 cross-resource replay]', JSON.stringify({
      status: crossResource.status,
      errorCode: crossResource.body.error?.code ?? null,
      returnedEntityId: crossResource.body.data?.entity?.id ?? null,
      returnedSpaceId: crossResource.body.data?.entity?.spaceId ?? null,
      spaceA,
      spaceB,
      originalEntityId: first.entity.id,
      originalEntityStillInSpaceA: rows[0]?.space_id === spaceA,
      leakedSpaceAProjection: leaked,
    }, null, 2));

    // THE LAW. A refusal is a correct outcome, and so is genuinely acting on
    // Space B. The forbidden outcome is handing back Space A's entity to a
    // request that named Space B.
    expect(
      leaked,
      'a same-principal replay aimed at Space B returned Space A\'s stored entity — '
        + 'resource confusion is open at entities.create, which 032 does not cover '
        + 'and 033 structurally cannot',
    ).toBe(false);
    expect(rows[0]?.space_id, 'Space A\'s entity moved').toBe(spaceA);
  }, 120_000);
});

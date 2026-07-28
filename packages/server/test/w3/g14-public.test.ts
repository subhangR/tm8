import { SpaceSettingsViewSchema } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.G14 — menu and default channel, at the composed public boundary.
 *
 * §7.3 gave this group an unusual and explicit instruction: RE-DERIVE, DO NOT
 * INHERIT. W2 self-reported two failing `spaces.defaultChannel.set` tests and
 * classified them as a STALE-TEST defect rather than a production one — the
 * dossier freezes the response as the strict 8-key `SpaceSettingsView`, while the
 * group's own tests still asserted a superseded 2-key acknowledgement. A fresh
 * session repaired the expectations and was BARRED from loosening an assertion to
 * reach green.
 *
 * An independent public check is precisely what would surface a loosened
 * assertion if one slipped through, so this file does not read W2's tests and
 * does not restate their shape. It validates the live response against the FROZEN
 * CONTRACT SCHEMA ITSELF — `SpaceSettingsViewSchema`, which is `.strict()`. That
 * is stronger than hand-listing eight key names, because it fails on a MISSING
 * key, on an EXTRA key, and on a wrong inner type, and it cannot drift out of
 * sync with the contract the way a hand-written list can.
 *
 * PER-BRANCH, NOT PER-OPERATION. §8.4 records that this gate's own recorded
 * weakness is that per-operation coverage was never per-branch coverage, twice
 * caught by someone else's inventory. So the cases below are branches: clear
 * versus set, stale revision, replay, and the menu read/write pair.
 *
 * MIGRATIONS: full official chain via `migrationFiles()`.
 */
describe.sequential('W3.G14 menu and default channel through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let channelId = '';
  let settingsRevision = 0;

  beforeAll(async () => {
    harness = await startW3PublicServer('g14');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g14-space',
        name: 'W3 G14 Space',
      }),
    );
    spaceId = space.space.id;

    const channels = await harness.rows<{ id: string }>(
      `select id::text from public.entities
        where space_id = $1 and kind = 'channel' and deleted_at is null
        order by created_at limit 1`,
      [spaceId],
    );
    channelId = channels[0]?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('has a channel to work with, so the branches below are not vacuous', () => {
    expect(channelId, 'the Space bootstrap produced no channel entity').toBeTruthy();
  });

  /**
   * THE §7.3 RE-DERIVATION. Validated against the frozen schema rather than a
   * hand-written key list, so a loosened W2 expectation cannot hide here.
   */
  it('spaces.defaultChannel.set answers the strict SpaceSettingsView, not an acknowledgement', async () => {
    const current = await harness.rows<{ rev: number; ch: string | null }>(
      'select settings_revision rev, default_channel_id::text ch from public.spaces where id = $1',
      [spaceId],
    );
    settingsRevision = current[0]?.rev ?? 1;

    // THE TARGET MUST DIFFER FROM THE CURRENT VALUE, and an earlier revision of
    // this test did not check that. The RPC guards its write with
    // `if space_row.default_channel_id is distinct from p_channel_id` (031), so
    // writing the value a Space ALREADY holds is a deliberate no-op that
    // correctly does not burn a settings revision. The Space bootstrap already
    // points at its first channel, so naively "setting" that channel measured
    // nothing and looked like an inert concurrency guard. Choose a genuine change.
    const target = current[0]?.ch === channelId ? null : channelId;

    const response = await harness.request<Record<string, unknown>>(
      'PUT',
      `/v2/spaces/${spaceId}/default-channel`,
      {
        clientMutationId: 'w3-g14-set-default-channel',
        expectedSettingsRevision: settingsRevision,
        channelId: target,
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const data = successData<unknown>(response);

    // THE ASSERTION. `.strict()` means an extra key fails, a missing key fails,
    // and a wrong inner type fails. A 2-key acknowledgement cannot pass this.
    const parsed = SpaceSettingsViewSchema.safeParse(data);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      'the response does not satisfy the frozen strict SpaceSettingsView',
    ).toEqual([]);

    // And it must actually reflect the write, not merely be well-shaped.
    expect((data as { defaultChannelId: string | null }).defaultChannelId).toBe(target);

    // Authoritative: the database agrees, and the revision advanced.
    const after = await harness.rows<{ ch: string | null; rev: number }>(
      'select default_channel_id::text ch, settings_revision rev from public.spaces where id = $1',
      [spaceId],
    );
    expect(after[0]?.ch).toBe(target);
    expect(after[0]?.rev, 'settings revision did not advance').toBeGreaterThan(settingsRevision);
    settingsRevision = after[0]?.rev ?? settingsRevision;
  }, 60_000);

  it('BRANCH: a stale expectedSettingsRevision conflicts without writing', async () => {
    const before = await harness.rows<{ ch: string | null; rev: number }>(
      'select default_channel_id::text ch, settings_revision rev from public.spaces where id = $1',
      [spaceId],
    );

    const stale = await harness.request(
      'PUT',
      `/v2/spaces/${spaceId}/default-channel`,
      {
        clientMutationId: 'w3-g14-stale-revision',
        expectedSettingsRevision: 1,
        channelId: null,
      },
    );

    const after = await harness.rows<{ ch: string | null; rev: number }>(
      'select default_channel_id::text ch, settings_revision rev from public.spaces where id = $1',
      [spaceId],
    );

    expect({
      status: stale.status,
      code: stale.body.error?.code ?? null,
      channelUnchanged: after[0]?.ch === before[0]?.ch,
      revisionUnchanged: after[0]?.rev === before[0]?.rev,
    }).toMatchObject({
      code: 'version_conflict',
      channelUnchanged: true,
      revisionUnchanged: true,
    });
  }, 60_000);

  it('BRANCH: replaying the same clientMutationId does not apply a second effect', async () => {
    const before = await harness.rows<{ rev: number }>(
      'select settings_revision rev from public.spaces where id = $1',
      [spaceId],
    );
    // The ORIGINAL cmid, with its ORIGINAL intent. A replay must not advance the
    // revision a second time.
    const replay = await harness.request(
      'PUT',
      `/v2/spaces/${spaceId}/default-channel`,
      {
        clientMutationId: 'w3-g14-set-default-channel',
        expectedSettingsRevision: before[0]?.rev ?? 1,
        channelId,
      },
    );
    const after = await harness.rows<{ rev: number }>(
      'select settings_revision rev from public.spaces where id = $1',
      [spaceId],
    );

    expect({
      status: replay.status,
      revisionAdvanced: (after[0]?.rev ?? 0) > (before[0]?.rev ?? 0),
    }).toMatchObject({ revisionAdvanced: false });
  }, 60_000);

  it('BRANCH: the menu read/write pair round-trips and rejects a stale revision', async () => {
    const menu = successData<{ schemaVersion: number; revision: number; groups: unknown[] }>(
      await harness.request('GET', `/v2/spaces/${spaceId}/menu`),
    );
    expect(menu.schemaVersion).toBe(1);
    expect(Array.isArray(menu.groups)).toBe(true);

    // Echoing the current menu back is the identity write — it must be accepted,
    // which proves the read projection is a VALID input to the write.
    const echoed = await harness.request(
      'PUT',
      `/v2/spaces/${spaceId}/menu`,
      {
        clientMutationId: 'w3-g14-menu-echo',
        expectedRevision: menu.revision,
        payload: { schemaVersion: menu.schemaVersion, groups: menu.groups },
      },
    );
    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);

    // And the same body a second time, now with a stale revision, must conflict.
    const staleMenu = await harness.request(
      'PUT',
      `/v2/spaces/${spaceId}/menu`,
      {
        clientMutationId: 'w3-g14-menu-stale',
        expectedRevision: menu.revision,
        payload: { schemaVersion: menu.schemaVersion, groups: menu.groups },
      },
    );
    expect(staleMenu.status).toBeGreaterThanOrEqual(400);
    // OBSERVED DIVERGENCE, recorded rather than adjudicated. spaces.menu.update
    // and spaces.defaultChannel.set both raise SQLSTATE 40001 for the SAME
    // failure class -- a stale expected revision -- yet reach the wire as
    // DIFFERENT contract codes: 'conflict' here, 'version_conflict' there. The
    // cause is above the database: spacesMenuUpdate wraps its RPC and remaps via
    // normalizeMenuError (menu-default-channel.ts:145, :156-158), while
    // spacesDefaultChannelSet has no wrapper and lets translateDbError map 40001
    // straight through. Two sibling operations in ONE group, so a client cannot
    // handle optimistic conflict uniformly. Pinned so it cannot drift further.
    expect(staleMenu.body.error?.code).toBe('conflict');
  }, 60_000);
});

/**
 * ACCEPTANCE 4 (LLD §7, Delta 1 v1 set): **`menu.updated` and
 * `space.default_channel.updated` flow LIVE, verbatim, on both transports.**
 *
 * THIS IS THE SUITE THE WHOLE FIXTURE DESIGN EXISTS FOR. The Delta 1 mapper
 * passthrough arm landed in `packages/server/src` with no rebuild since, so a
 * node booted from `packages/server/dist` reports these two types as NOT
 * flowing — a red that reads exactly like the Delta 1 MERGED signal being
 * wrong, aimed at the wrong lane. `node-fixture.ts` boots from SOURCE
 * precisely so this suite's answer means what it says. (server-owner, relayed
 * [bridge->B4 2].)
 *
 * "Verbatim" is asserted three ways, because a passthrough arm can be wrong in
 * three different places and only one of them is visible from the wire alone:
 *
 *   1. the event the SEAM delivers carries the same payload the COMMAND
 *      returned  — the projector did not reshape it;
 *   2. the event the seam delivers carries the same payload the TABLE stored
 *      — the mapper did not reshape it either (this is the passthrough claim
 *      itself, and the table is the only account no instrument here produced);
 *   3. the same event, re-read over `events.poll`, is identical — the two
 *      transports project one payload, not two.
 *
 * The dormant half of the set is NOT asserted by absence here. Absence of an
 * event nobody generated is vacuous; the dormancy claim is pinned by
 * server-owner's own unit suite over `RPC_AUTHORED_PASSTHROUGH`. What this
 * suite adds is the live half — that the two v1 members genuinely traverse the
 * whole path into a consumer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MenuConfig } from '@tm8/contract';

import {
  QUIET_MS,
  assertHarnessWiring,
  cmid,
  createChannel,
  createSeamHarness,
  createSpace,
  expectQuiet,
  groundTruthOfType,
  startIntegrationNode,
  waitFor,
  type IntegrationNode,
  type SeamHarness,
  type SpaceFixture,
} from './node-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

/**
 * A menu the contract will actually accept: group ids match
 * `^[a-z0-9][a-z0-9-]{0,31}$`, labels are 1–32 chars, refs are globally unique
 * across the whole config, and the required `settings` view is present
 * (`validateMenu`, schemas.ts:1059). Written out rather than generated so a
 * schema change fails here as a named 400 instead of as a mystery.
 */
const MENU_PAYLOAD = {
  schemaVersion: 1 as const,
  groups: [
    {
      id: 'b4-primary',
      label: 'B4 Primary',
      items: [
        { type: 'view' as const, ref: 'dashboard' as const },
        { type: 'view' as const, ref: 'workspace' as const },
        { type: 'view' as const, ref: 'settings' as const },
      ],
    },
    {
      id: 'b4-secondary',
      label: 'B4 Secondary',
      items: [{ type: 'view' as const, ref: 'inbox' as const }],
    },
  ],
};

describe('Delta 1 v1 passthrough flows live (real node, booted from src)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let harness: SeamHarness;

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('delta1');
    space = await createSpace(node, 'b4 delta1');
    harness = createSeamHarness(node);
    await harness.seam.openSpace(space.spaceId);
    await waitFor(
      () => harness.seam.getConnection().phase === 'live',
      () => `phase is ${harness.seam.getConnection().phase}, expected live`,
    );
  });

  afterAll(async () => {
    harness?.dispose();
    await node?.close();
  });

  it('menu.updated reaches seam.onEvent with the MenuConfig the command returned, verbatim', async () => {
    const current = await node.request<MenuConfig>('GET', `/v2/spaces/${space.spaceId}/menu`);
    expect(current.status, JSON.stringify(current.error)).toBe(200);
    const expectedRevision = current.data!.revision;

    const updated = await node.request<MenuConfig>('PUT', `/v2/spaces/${space.spaceId}/menu`, {
      clientMutationId: cmid('menu'),
      expectedRevision,
      payload: MENU_PAYLOAD,
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    const commandMenu = updated.data!;
    // The command really did change something — otherwise "the event matches
    // the command" could be satisfied by a no-op.
    expect(commandMenu.revision).toBeGreaterThan(expectedRevision);
    expect(commandMenu.groups.map((g) => g.id)).toEqual(['b4-primary', 'b4-secondary']);

    // (1) it arrives at a CONSUMER, through the real socket.
    await waitFor(
      () => harness.events.some((e) => e.type === 'menu.updated'),
      () => `no menu.updated among [${[...new Set(harness.events.map((e) => e.type))].join(',')}]`,
    );
    const delivered = harness.events.filter((e) => e.type === 'menu.updated');
    expect(delivered.length, 'menu.updated was delivered more than once').toBe(1);
    const event = delivered[0]!;

    // (2) the payload equals the command's own answer.
    expect(event.raw['menu'], 'the delivered menu is not the menu the command returned').toEqual(commandMenu);

    // (3) …and equals what the TABLE stored. This is the passthrough claim:
    //     the mapper projected the stored row without reshaping it.
    const stored = groundTruthOfType(node, space.spaceId, 'menu.updated');
    expect(stored.length, 'the table holds no menu.updated row').toBe(1);
    expect(stored[0]!.seq, 'the delivered seq is not the stored seq').toBe(event.seq);
    const storedPayload = stored[0]!.payload as Record<string, unknown>;
    expect(storedPayload['type']).toBe('menu.updated');
    expect(event.raw['menu'], 'the mapper reshaped the stored menu payload').toEqual(storedPayload['menu']);

    // (4) the envelope the contract requires is present and consistent.
    expect(event.spaceId).toBe(space.spaceId);
    expect(typeof event.raw['occurredAt']).toBe('string');
    expect(typeof event.raw['schemaVersion']).toBe('number');
  });

  it('space.default_channel.updated reaches seam.onEvent with channelId and settingsRevision', async () => {
    const channelId = await createChannel(node, space.spaceId, 'b4-default-channel');

    const settings = await node.request<{ settingsRevision: number }>(
      'GET',
      `/v2/spaces/${space.spaceId}/settings`,
    );
    expect(settings.status, JSON.stringify(settings.error)).toBe(200);
    const expectedSettingsRevision = settings.data!.settingsRevision;

    const set = await node.request<{ defaultChannelId: string; settingsRevision: number }>(
      'PUT',
      `/v2/spaces/${space.spaceId}/default-channel`,
      { clientMutationId: cmid('chan'), expectedSettingsRevision, channelId },
    );
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    expect(set.data!.defaultChannelId, 'the command did not actually set the channel').toBe(channelId);

    await waitFor(
      () => harness.events.some((e) => e.type === 'space.default_channel.updated'),
      () => `no space.default_channel.updated among [${[...new Set(harness.events.map((e) => e.type))].join(',')}]`,
    );
    const delivered = harness.events.filter((e) => e.type === 'space.default_channel.updated');
    expect(delivered.length).toBe(1);
    const event = delivered[0]!;

    expect(event.raw['channelId'], 'the delivered channelId is not the one that was set').toBe(channelId);
    expect(event.raw['settingsRevision']).toBe(set.data!.settingsRevision);

    const stored = groundTruthOfType(node, space.spaceId, 'space.default_channel.updated');
    expect(stored.length).toBe(1);
    expect(stored[0]!.seq).toBe(event.seq);
    const storedPayload = stored[0]!.payload as Record<string, unknown>;
    expect(storedPayload['type']).toBe('space.default_channel.updated');
    expect(event.raw['channelId']).toEqual(storedPayload['channelId']);
    expect(event.raw['settingsRevision']).toEqual(storedPayload['settingsRevision']);
  });

  it('both v1 members project IDENTICALLY over events.poll — one payload, two transports', async () => {
    await expectQuiet(harness.events, QUIET_MS);

    const res = await node.request<{ items: Array<Record<string, unknown>> }>(
      'GET',
      `/v2/spaces/${space.spaceId}/events?since=0&limit=500`,
    );
    expect(res.status).toBe(200);
    const polled = new Map(res.data!.items.map((item) => [Number(item['seq']), item]));

    for (const type of ['menu.updated', 'space.default_channel.updated']) {
      const fromSocket = harness.events.find((e) => e.type === type);
      expect(fromSocket, `${type} never reached the socket`).toBeDefined();
      const fromPoll = polled.get(fromSocket!.seq);
      expect(fromPoll, `${type} at seq ${String(fromSocket!.seq)} is missing from the poll feed`).toBeDefined();
      // Byte-for-byte after JSON normalisation: the poll route and the socket
      // must not be projecting two different shapes of the same row.
      expect(fromPoll, `${type} differs between the socket and the poll feed`).toEqual(fromSocket!.raw);
    }
  });

  it('the two v1 members are the ONLY passthrough-family types that appeared', () => {
    // A guard on the membership claim rather than on absence-in-general: if a
    // dormant family started flowing without a published amendment, the seam
    // would be relying on data the LLD says it must not. Named types, so the
    // failure message says which one arrived.
    const dormant = new Set([
      'message.delivery_reserved',
      'message.delivery_settled',
      'message.attachments.updated',
      'handoff.prepared',
      'handoff.delivery_settled',
      'handoff.recorded',
      'handoff.withdrawn',
      'project.association.corrected',
    ]);
    const arrived = [...new Set(harness.events.map((e) => e.type))].filter((t) => dormant.has(t));
    expect(
      arrived,
      'a Delta-1 DORMANT family arrived on the wire — the v1 membership set changed without an amendment',
    ).toEqual([]);
  });
});

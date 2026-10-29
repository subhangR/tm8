/**
 * The push worker against an in-memory store and the fake relay (ac1–ac4).
 *
 * ac1  a claimed notification becomes one relay message per live device, each
 *      a valid PushPayloadV1 from the contract
 * ac2  each device's previews setting decides its text (full · sender · none)
 * ac3  a device the relay reports dead (ticket or receipt) is deleted, and only
 *      while it still holds the token the push went to
 * ac4  the only relay here is FakePushRelay
 * Plus: retries, refusals, unreadable rows, unopenable tokens, chunking, quiet
 * hours, and no token in any settlement or log line.
 */
import { describe, expect, it } from 'vitest';

import { PushPayloadV1Schema } from '@tm8/contract';

import { PushDispatcher, PushReceiptChecker } from '../../src/push/dispatcher.js';
import { createPushDispatchJob, createPushReceiptJob } from '../../src/push/jobs.js';
import type { ClaimedPush, PushDevice } from '../../src/push/types.js';
import { FakePushRelay } from './fake-relay.js';
import { MESSAGE, ORIGIN, SPACE, actor, device, expoToken, notification, sha256, stubOpen, target, uuid } from './fixtures.js';
import { MemoryPushStore } from './memory-store.js';

function claimed(devices: readonly PushDevice[], attempt = 1): ClaimedPush {
  return {
    outboxId: uuid(),
    notificationId: uuid(),
    spaceId: SPACE,
    recipientIdentityId: 'subhang',
    attempt,
    devices,
  };
}

function setup(options: { maxBatch?: number; now?: number } = {}) {
  const store = new MemoryPushStore();
  const relay = new FakePushRelay(options.maxBatch);
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const logger = { warn: (message: string, meta?: unknown) => warnings.push({ message, meta }) };
  const dispatcher = new PushDispatcher({
    store, relay, openToken: stubOpen, origin: ORIGIN, logger,
    ...(options.now !== undefined ? { now: () => options.now! } : {}),
  });
  const receipts = new PushReceiptChecker({ store, relay, logger });
  return { store, relay, dispatcher, receipts, warnings };
}

describe('ac1: a notification for a registered member becomes relay calls with PushPayloadV1', () => {
  it('sends one valid PushPayloadV1 per live device, to that device\'s own token', async () => {
    const { store, relay, dispatcher } = setup();
    const phone = device({ platform: 'ios' });
    const tablet = device({ platform: 'android' });
    const item = notification();
    const row = claimed([phone, tablet]);
    store.add(row, { item, messageId: MESSAGE });

    const result = await dispatcher.tick();

    expect(relay.sends).toHaveLength(1);
    expect(relay.messages.map((m) => m.to)).toEqual([phone.token, tablet.token]);
    for (const message of relay.messages) {
      expect(PushPayloadV1Schema.parse(message.payload)).toEqual(message.payload);
      expect(message.payload.data).toMatchObject({ v: 1, o: ORIGIN, sp: SPACE, n: item.id, k: 'mention' });
    }
    expect(result).toMatchObject({ claimed: 1, accepted: 2, skipped: 0, retried: 0, failed: 0 });
    const settlement = store.settlementOf(row.outboxId);
    expect(settlement?.outcome).toBe('sent');
    expect(settlement?.outcome === 'sent' && settlement.tickets.map((t) => t.deviceId)).toEqual([phone.deviceId, tablet.deviceId]);
    expect(settlement?.outcome === 'sent' && settlement.error).toBeNull();
  });

  it('a row read before its turn is settled without a push', async () => {
    const { store, relay, dispatcher } = setup();
    const row = claimed([device()]);
    store.add(row, { item: notification({ readAt: '2026-10-29T12:00:01.000Z' }), messageId: null });
    const result = await dispatcher.tick();
    expect(relay.sends).toHaveLength(0);
    expect(store.settlementOf(row.outboxId)).toEqual({ outcome: 'skipped', error: 'skipped: read before dispatch' });
    expect(result.skipped).toBe(1);
  });

  it('a row its recipient can no longer read is settled without a push', async () => {
    const { store, relay, dispatcher } = setup();
    const row = claimed([device()]);
    store.add(row, null);
    await dispatcher.tick();
    expect(relay.sends).toHaveLength(0);
    expect(store.settlementOf(row.outboxId)?.outcome).toBe('skipped');
  });

  it('nothing claimed, nothing sent', async () => {
    const { relay, dispatcher } = setup();
    expect(await dispatcher.tick()).toMatchObject({ claimed: 0, accepted: 0 });
    expect(relay.sends).toHaveLength(0);
  });
});

describe('ac2: the text follows each device\'s previews setting', () => {
  it('full, sender only and none, on three devices of the same person, for the same notification', async () => {
    const { store, relay, dispatcher } = setup();
    const full = device({ previews: 'full' });
    const sender = device({ previews: 'sender' });
    const none = device({ previews: 'none' });
    store.add(claimed([full, sender, none]), { item: notification(), messageId: MESSAGE });

    await dispatcher.tick();

    const byToken = new Map(relay.messages.map((m) => [m.to, m.payload]));
    expect(byToken.get(full.token)).toMatchObject({
      title: 'Priya mentioned you in #mobile', body: '@subhang can you look at the tablet overflow?',
    });
    expect(byToken.get(sender.token)).toMatchObject({ title: 'Priya mentioned you', body: '' });
    expect(byToken.get(none.token)).toMatchObject({ title: '', body: 'New notification' });
    // The routing record is the same for all three.
    expect(byToken.get(sender.token)!.data).toEqual(byToken.get(full.token)!.data);
    expect(byToken.get(none.token)!.data).toEqual(byToken.get(full.token)!.data);
  });

  it('an assignment under sender only never carries the task title', async () => {
    const { store, relay, dispatcher } = setup();
    const sender = device({ previews: 'sender' });
    store.add(claimed([sender]), {
      item: notification({ kind: 'assignment', actor: actor('Marco'), target: target('task', 'Acquisition plan'), message: undefined }),
      messageId: null,
    });
    await dispatcher.tick();
    expect(relay.messages[0]!.payload.title).toBe('Marco assigned you');
    expect(JSON.stringify(relay.messages[0]!.payload)).not.toContain('Acquisition plan');
  });

  it('inside a device\'s quiet window the push goes passive on the quiet channel; outside it, not', async () => {
    const now = Date.parse('2026-10-29T23:00:00.000Z');
    const { store, relay, dispatcher } = setup({ now });
    const quiet = device({ quietUntil: '2026-10-30T07:30:00.000Z' });
    const awake = device({ quietUntil: '2026-10-29T22:00:00.000Z' });
    store.add(claimed([quiet, awake]), { item: notification(), messageId: MESSAGE });
    await dispatcher.tick();
    const byToken = new Map(relay.messages.map((m) => [m.to, m.route]));
    expect(byToken.get(quiet.token)).toEqual({ categoryId: 'tm8.reply', androidChannelId: 'quiet', interruptionLevel: 'passive' });
    expect(byToken.get(awake.token)).toEqual({ categoryId: 'tm8.reply', androidChannelId: 'mentions', interruptionLevel: 'active' });
  });
});

describe('ac3: dead tokens the relay reports are deleted', () => {
  it('a DeviceNotRegistered ticket deletes that device, by id and the token hash it was sent to', async () => {
    const { store, relay, dispatcher } = setup();
    const gone = device();
    const alive = device();
    relay.dead.add(gone.token);
    const row = claimed([gone, alive]);
    store.add(row, { item: notification(), messageId: MESSAGE });

    const result = await dispatcher.tick();

    expect(store.deletedDevices).toEqual([gone.deviceId]);
    expect(store.devices.has(alive.deviceId)).toBe(true);
    expect(result).toMatchObject({ accepted: 1, devicesDeleted: 1, refused: { DeviceNotRegistered: 1 } });
    const settlement = store.settlementOf(row.outboxId);
    expect(settlement).toMatchObject({
      outcome: 'sent',
      dead: [{ deviceId: gone.deviceId, tokenHash: sha256(gone.token) }],
      error: 'DeviceNotRegistered×1',
    });
  });

  it('a device that rotated its token since the send is not deleted by the stale report', async () => {
    const { store, relay, dispatcher } = setup();
    const phone = device();
    relay.dead.add(phone.token);
    store.add(claimed([phone]), { item: notification(), messageId: MESSAGE });
    store.rotate(phone, sha256(expoToken(424242)));
    const result = await dispatcher.tick();
    expect(store.devices.has(phone.deviceId)).toBe(true);
    expect(result.devicesDeleted).toBe(0);
  });

  it('a DeviceNotRegistered receipt deletes the device its ticket went to; other receipts are just forgotten', async () => {
    const { store, relay, dispatcher, receipts } = setup();
    const gone = device();
    const fine = device();
    const pending = device();
    store.add(claimed([gone, fine, pending]), { item: notification(), messageId: MESSAGE });
    await dispatcher.tick();
    const ticketOf = (token: string) => [...relay.ticketTokens].find(([, t]) => t === token)![0];
    relay.receiptAnswers.set(ticketOf(gone.token), { status: 'error', error: 'DeviceNotRegistered' });
    relay.receiptAnswers.set(ticketOf(fine.token), { status: 'ok' });

    const result = await receipts.tick();

    expect(result).toMatchObject({ checked: 3, answered: 2, pending: 1, devicesDeleted: 1 });
    expect(store.deletedDevices).toEqual([gone.deviceId]);
    expect([...store.tickets.keys()]).toEqual([ticketOf(pending.token)]);
  });

  it('receipts the relay cannot be asked for wait for the next pass', async () => {
    const { store, relay, dispatcher, receipts, warnings } = setup();
    store.add(claimed([device()]), { item: notification(), messageId: MESSAGE });
    await dispatcher.tick();
    relay.failNextReceipts();
    const result = await receipts.tick();
    expect(result).toMatchObject({ checked: 1, deferred: true, devicesDeleted: 0 });
    expect(store.tickets.size).toBe(1);
    expect(warnings.map((w) => w.message)).toContain('push: receipts could not be fetched; they are asked again later');
  });
});

describe('when the relay fails', () => {
  it('unreachable or 429: the row is tried again with backoff, honouring Retry-After', async () => {
    const { store, relay, dispatcher } = setup();
    const first = claimed([device()], 1);
    const third = claimed([device()], 3);
    store.add(first, { item: notification(), messageId: null });
    store.add(third, { item: notification(), messageId: null });
    relay.failNext('unavailable');
    const result = await dispatcher.tick();
    expect(result).toMatchObject({ retried: 2, failed: 0, accepted: 0 });
    expect(store.settlementOf(first.outboxId)).toMatchObject({ outcome: 'retry', retryAfterSeconds: 30 });
    expect(store.settlementOf(third.outboxId)).toMatchObject({ outcome: 'retry', retryAfterSeconds: 120 });

    const later = claimed([device()], 1);
    store.add(later, { item: notification(), messageId: null });
    relay.failNext('unavailable', 600_000);
    await dispatcher.tick();
    expect(store.settlementOf(later.outboxId)).toMatchObject({ outcome: 'retry', retryAfterSeconds: 600 });
  });

  it('the last attempt dead-letters instead of retrying', async () => {
    const { store, relay, dispatcher } = setup();
    const last = claimed([device()], 5);
    store.add(last, { item: notification(), messageId: null });
    relay.failNext('unavailable');
    const result = await dispatcher.tick();
    expect(result.failed).toBe(1);
    expect(store.settlementOf(last.outboxId)?.outcome).toBe('failed');
  });

  it('a refused request is not retried', async () => {
    const { store, relay, dispatcher } = setup();
    const row = claimed([device()], 1);
    store.add(row, { item: notification(), messageId: null });
    relay.failNext('rejected');
    await dispatcher.tick();
    expect(store.settlementOf(row.outboxId)).toMatchObject({ outcome: 'failed' });
  });

  it('a per-device error is final for that device; the accepted ones are kept', async () => {
    const { store, relay, dispatcher } = setup();
    const big = device();
    const ok = device();
    relay.ticketErrors.set(big.token, 'MessageTooBig');
    const row = claimed([big, ok]);
    store.add(row, { item: notification(), messageId: null });
    await dispatcher.tick();
    expect(store.settlementOf(row.outboxId)).toMatchObject({ outcome: 'sent', error: 'MessageTooBig×1' });
    expect(store.deletedDevices).toEqual([]);
    expect(relay.sends).toHaveLength(1);
  });

  it('a failed notification read retries the row instead of dropping it', async () => {
    const { store, relay, dispatcher } = setup();
    const row = claimed([device()]);
    store.add(row, { item: notification(), messageId: null });
    store.failNotificationRead = true;
    await dispatcher.tick();
    expect(relay.sends).toHaveLength(0);
    expect(store.settlementOf(row.outboxId)?.outcome).toBe('retry');
  });
});

describe('tokens', () => {
  it('a token that will not open is skipped; the person\'s other devices still get the push', async () => {
    const { store, relay, dispatcher, warnings } = setup();
    const moved = device({ identityId: 'subhang' });
    // Sealed for another identity: the opener refuses it, as 392's AAD would.
    const tampered = { ...moved, identityId: 'mallory' };
    const good = device();
    store.add(claimed([tampered, good]), { item: notification(), messageId: null });
    const result = await dispatcher.tick();
    expect(result.unopenable).toBe(1);
    expect(relay.messages.map((m) => m.to)).toEqual([good.token]);
    expect(warnings.some((w) => w.message.includes('would not open'))).toBe(true);
  });

  it('when no token opens, nothing is sent and the row is settled', async () => {
    const { store, relay, dispatcher } = setup();
    const row = claimed([{ ...device(), identityId: 'mallory' }]);
    store.add(row, { item: notification(), messageId: null });
    await dispatcher.tick();
    expect(relay.sends).toHaveLength(0);
    expect(store.settlementOf(row.outboxId)).toEqual({ outcome: 'skipped', error: 'skipped: no device token could be opened' });
  });

  it('no token appears in any settlement, ticket or log line', async () => {
    const { store, relay, dispatcher, receipts, warnings } = setup();
    const devices = [device(), device(), device(), { ...device(), identityId: 'mallory' }];
    relay.dead.add(devices[0]!.token);
    store.add(claimed(devices), { item: notification(), messageId: MESSAGE });
    const failing = claimed([device()]);
    store.add(failing, { item: notification(), messageId: null });
    await dispatcher.tick();
    relay.failNext('unavailable');
    store.add(claimed([device()]), { item: notification(), messageId: null });
    await dispatcher.tick();
    await receipts.tick();
    const persisted = JSON.stringify({ settlements: store.settlements, tickets: [...store.tickets.values()], warnings });
    expect(persisted).not.toContain('ExponentPushToken');
    for (const message of relay.messages) expect(persisted).not.toContain(message.to);
  });
});

describe('chunking', () => {
  it('never sends more than the relay takes, and never splits one notification across requests', async () => {
    const { store, relay, dispatcher } = setup({ maxBatch: 4 });
    const rows = [claimed([device(), device(), device()]), claimed([device(), device()]), claimed([device()])];
    for (const row of rows) store.add(row, { item: notification(), messageId: null });
    const result = await dispatcher.tick();
    expect(relay.sends.map((s) => s.length)).toEqual([3, 3]);
    expect(result.accepted).toBe(6);
    expect(store.settlements.map((s) => s.settlement.outcome)).toEqual(['sent', 'sent', 'sent']);
  });
});

describe('the scheduler jobs', () => {
  it('dispatch reports an idle tick as skipped, and a busy one with what it sent', async () => {
    const idle = createPushDispatchJob({ dispatcher: { tick: async () => setup().dispatcher.tick() } });
    expect(await idle.run({} as never)).toEqual({ skipped: true, reason: 'no push to send' });

    const { store, dispatcher } = setup();
    store.add(claimed([device()]), { item: notification(), messageId: null });
    const busy = createPushDispatchJob({ dispatcher });
    expect(await busy.run({} as never)).toMatchObject({ affected: 1 });
    expect(busy).toMatchObject({ name: 'push.dispatch', intervalMs: 2_000, quietSkips: true });
  });

  it('receipts report an idle pass as skipped', async () => {
    const job = createPushReceiptJob({ checker: setup().receipts });
    expect(await job.run({} as never)).toEqual({ skipped: true, reason: 'no receipt due' });
    expect(job).toMatchObject({ name: 'push.receipts', intervalMs: 300_000 });
  });
});

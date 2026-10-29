/**
 * The push worker's two passes (s-lld §11, Dispatch).
 *
 * DISPATCH, every few seconds: claim queued notifications (393 enqueues each
 * unread inbox row of a person with a live device once), read each one as its
 * recipient's inbox shows it, build one PushPayloadV1 per device under that
 * device's previews setting, open the device tokens in memory, send, and settle
 * every row with what the relay said. A device the relay reports dead is
 * deleted in the same settle.
 *
 * RECEIPTS, every few minutes: ask the relay about tickets old enough to have
 * a receipt, delete the devices whose receipt says DeviceNotRegistered, and
 * forget the tickets that answered.
 *
 * RETRIES. Only a send that failed as a whole (relay unreachable, 429, 5xx) is
 * tried again, with backoff, up to `maxAttempts`; a refusal (400, credentials)
 * dead-letters the row. A per-device error in an accepted request is final for
 * that device and that notification: sending it again would duplicate the push
 * on every device that did get it.
 *
 * TOKENS. Opened tokens live in the RelayMessage for one `send` and nowhere
 * else. Logs and settlements carry ids, counts and error codes only.
 */
import { PushPayloadV1Schema, pushRouteOf } from '@tm8/contract';

import { scrubPushTokens } from './expo-relay.js';
import { buildPushPayload } from './payload.js';
import {
  RelayRejectedError,
  RelayUnavailableError,
  type ClaimedPush,
  type OpenDeviceToken,
  type PushDeadDevice,
  type PushDevice,
  type PushNotification,
  type PushRelay,
  type PushSettlement,
  type PushStore,
  type PushTicketRef,
  type RelayMessage,
  type RelayTicket,
} from './types.js';

export interface PushLogger {
  warn(message: string, meta?: unknown): void;
}

export const DEFAULT_PUSH_BATCH = 25;
export const DEFAULT_PUSH_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 900;

export interface PushDispatcherOptions {
  readonly store: PushStore;
  readonly relay: PushRelay;
  readonly openToken: OpenDeviceToken;
  /** The server's origin as the phone knows it (TM8_PUBLIC_ORIGIN). */
  readonly origin: string;
  readonly batch?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly logger?: PushLogger;
}

export interface PushDispatchResult {
  /** Rows 393 queued on this tick. */
  enqueued: number;
  claimed: number;
  /** Messages the relay accepted. */
  accepted: number;
  /** Per-device relay error codes, counted. */
  refused: Record<string, number>;
  /** Devices deleted because the relay reported them dead. */
  devicesDeleted: number;
  /** Rows settled without a push (read first, unreadable, nothing to open), here or in SQL. */
  skipped: number;
  retried: number;
  failed: number;
  /** Device tokens that would not open (a moved or tampered row). */
  unopenable: number;
  /** Rows 393 expired because they were still unsent long after they happened. */
  expired: number;
}

interface PreparedMessage {
  readonly device: PushDevice;
  readonly message: RelayMessage;
}

interface PreparedPush {
  readonly item: ClaimedPush;
  readonly messages: readonly PreparedMessage[];
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return scrubPushTokens(text).slice(0, 300);
}

function countCodes(codes: readonly string[]): string | null {
  if (codes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${code}×${n}`).join(', ');
}

export class PushDispatcher {
  private readonly batch: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(private readonly options: PushDispatcherOptions) {
    this.batch = options.batch ?? DEFAULT_PUSH_BATCH;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_PUSH_MAX_ATTEMPTS;
    this.now = options.now ?? Date.now;
  }

  async tick(): Promise<PushDispatchResult> {
    const result: PushDispatchResult = {
      enqueued: 0, claimed: 0, accepted: 0, refused: {}, devicesDeleted: 0,
      skipped: 0, retried: 0, failed: 0, unopenable: 0, expired: 0,
    };
    const claim = await this.options.store.claim(this.batch);
    result.enqueued = claim.enqueued;
    result.claimed = claim.items.length;
    result.skipped += claim.skippedRead + claim.skippedNoDevice;
    result.expired = claim.expired;

    const prepared: PreparedPush[] = [];
    for (const item of claim.items) {
      const ready = await this.prepare(item, result);
      if (ready) prepared.push(ready);
    }
    for (const chunk of this.chunks(prepared)) await this.send(chunk, result);
    return result;
  }

  /** One row → its messages, or a settlement when there is nothing to send. */
  private async prepare(item: ClaimedPush, result: PushDispatchResult): Promise<PreparedPush | null> {
    let notification: PushNotification | null;
    try {
      notification = await this.options.store.notification(item);
    } catch (error) {
      await this.settleFailure(item, error, true, result);
      return null;
    }
    if (!notification) {
      await this.settle(item, { outcome: 'skipped', error: 'skipped: not readable by its recipient' });
      result.skipped += 1;
      return null;
    }
    if (notification.item.readAt !== null) {
      await this.settle(item, { outcome: 'skipped', error: 'skipped: read before dispatch' });
      result.skipped += 1;
      return null;
    }

    const messages: PreparedMessage[] = [];
    let invalid = 0;
    const now = this.now();
    for (const device of item.devices.slice(0, this.options.relay.maxBatch)) {
      let token: string;
      try {
        token = this.options.openToken(device.identityId, device.sealed);
      } catch (error) {
        result.unopenable += 1;
        this.options.logger?.warn('push: a device token would not open; skipped', {
          deviceId: device.deviceId, outboxId: item.outboxId, error: describe(error),
        });
        continue;
      }
      const payload = buildPushPayload({
        notification: notification.item,
        messageId: notification.messageId,
        previews: device.previews,
        origin: this.options.origin,
      });
      if (!PushPayloadV1Schema.safeParse(payload).success) {
        invalid += 1;
        continue;
      }
      const quiet = device.quietUntil !== null && Date.parse(device.quietUntil) > now;
      messages.push({ device, message: { to: token, payload, route: pushRouteOf(notification.item.kind, { quiet }) } });
    }
    if (messages.length === 0) {
      const why = invalid > 0 ? 'failed: the payload did not satisfy PushPayloadV1' : 'skipped: no device token could be opened';
      if (invalid > 0) {
        await this.settle(item, { outcome: 'failed', error: why });
        result.failed += 1;
      } else {
        await this.settle(item, { outcome: 'skipped', error: why });
        result.skipped += 1;
      }
      return null;
    }
    return { item, messages };
  }

  /** Whole rows per relay request, never more messages than the relay takes. */
  private *chunks(prepared: readonly PreparedPush[]): Generator<PreparedPush[]> {
    let chunk: PreparedPush[] = [];
    let size = 0;
    for (const push of prepared) {
      if (size + push.messages.length > this.options.relay.maxBatch && chunk.length > 0) {
        yield chunk;
        chunk = [];
        size = 0;
      }
      chunk.push(push);
      size += push.messages.length;
    }
    if (chunk.length > 0) yield chunk;
  }

  private async send(chunk: readonly PreparedPush[], result: PushDispatchResult): Promise<void> {
    const messages = chunk.flatMap((push) => push.messages.map((m) => m.message));
    let tickets: RelayTicket[];
    try {
      tickets = await this.options.relay.send(messages);
    } catch (error) {
      for (const push of chunk) await this.settleFailure(push.item, error, !(error instanceof RelayRejectedError), result);
      return;
    }

    let offset = 0;
    for (const push of chunk) {
      const mine = tickets.slice(offset, offset + push.messages.length);
      offset += push.messages.length;
      const accepted: PushTicketRef[] = [];
      const dead: PushDeadDevice[] = [];
      const codes: string[] = [];
      mine.forEach((ticket, index) => {
        const { device } = push.messages[index]!;
        if (ticket.status === 'ok') {
          accepted.push({ ticketId: ticket.id, deviceId: device.deviceId, tokenHash: device.sealed.tokenHash });
          return;
        }
        codes.push(ticket.error);
        result.refused[ticket.error] = (result.refused[ticket.error] ?? 0) + 1;
        if (ticket.error === 'DeviceNotRegistered') {
          dead.push({ deviceId: device.deviceId, tokenHash: device.sealed.tokenHash });
        }
      });
      result.accepted += accepted.length;
      const settled = await this.settle(push.item, { outcome: 'sent', tickets: accepted, dead, error: countCodes(codes) });
      if (settled) result.devicesDeleted += settled.devicesDeleted;
    }
  }

  private async settleFailure(
    item: ClaimedPush,
    error: unknown,
    retryable: boolean,
    result: PushDispatchResult,
  ): Promise<void> {
    const reason = describe(error);
    if (retryable && item.attempt < this.maxAttempts) {
      const backoff = Math.min(BASE_BACKOFF_SECONDS * 2 ** (item.attempt - 1), MAX_BACKOFF_SECONDS);
      const asked = error instanceof RelayUnavailableError && error.retryAfterMs !== undefined
        ? Math.ceil(error.retryAfterMs / 1000)
        : 0;
      await this.settle(item, { outcome: 'retry', error: reason, retryAfterSeconds: Math.max(backoff, asked) });
      result.retried += 1;
      return;
    }
    await this.settle(item, { outcome: 'failed', error: reason });
    result.failed += 1;
  }

  /** Settle one row; a failure to settle is logged, and the row's lease brings it back. */
  private async settle(item: ClaimedPush, settlement: PushSettlement): Promise<{ devicesDeleted: number } | null> {
    try {
      return await this.options.store.settle(item.outboxId, settlement);
    } catch (error) {
      this.options.logger?.warn('push: could not settle a claimed row; it returns when its lease ends', {
        outboxId: item.outboxId, outcome: settlement.outcome, error: describe(error),
      });
      return null;
    }
  }
}

// -- receipts ------------------------------------------------------------------

export const DEFAULT_RECEIPT_BATCH = 1000;

export interface PushReceiptCheckerOptions {
  readonly store: PushStore;
  readonly relay: PushRelay;
  readonly batch?: number;
  readonly logger?: PushLogger;
}

export interface PushReceiptResult {
  checked: number;
  /** Tickets whose receipt arrived (ok or not), now forgotten. */
  answered: number;
  /** Tickets with no receipt yet; they come back after their lease. */
  pending: number;
  devicesDeleted: number;
  /** Tickets past the relay's 24 hours, forgotten unanswered. */
  expired: number;
  refused: Record<string, number>;
  /** The relay could not be asked; the tickets come back after their lease. */
  deferred: boolean;
}

export class PushReceiptChecker {
  constructor(private readonly options: PushReceiptCheckerOptions) {}

  async tick(): Promise<PushReceiptResult> {
    const result: PushReceiptResult = {
      checked: 0, answered: 0, pending: 0, devicesDeleted: 0, expired: 0, refused: {}, deferred: false,
    };
    const claimed = await this.options.store.claimReceipts(this.options.batch ?? DEFAULT_RECEIPT_BATCH);
    result.expired = claimed.expired;
    result.checked = claimed.ticketIds.length;
    if (claimed.ticketIds.length === 0) return result;

    let receipts;
    try {
      receipts = await this.options.relay.receipts(claimed.ticketIds);
    } catch (error) {
      result.deferred = true;
      this.options.logger?.warn('push: receipts could not be fetched; they are asked again later', {
        tickets: claimed.ticketIds.length, error: describe(error),
      });
      return result;
    }

    const done: string[] = [];
    const dead: string[] = [];
    for (const id of claimed.ticketIds) {
      const receipt = receipts.get(id);
      if (!receipt) {
        result.pending += 1;
        continue;
      }
      if (receipt.status === 'error') {
        result.refused[receipt.error] = (result.refused[receipt.error] ?? 0) + 1;
        if (receipt.error === 'DeviceNotRegistered') {
          dead.push(id);
          continue;
        }
      }
      done.push(id);
    }
    result.answered = done.length + dead.length;
    if (result.answered > 0) {
      const settled = await this.options.store.settleReceipts(done, dead);
      result.devicesDeleted = settled.devicesDeleted;
    }
    return result;
  }
}

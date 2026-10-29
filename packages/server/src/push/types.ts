/**
 * Push dispatch (TM8 Mobile S6, s-lld §11): the seams between the queue in SQL
 * (393), the device tokens S1 seals (392), and the relay (Expo, decide Q5).
 *
 * A token is a credential that reaches a phone. It is opened in-process, held
 * in memory for one relay call and never stored, returned or logged: everything
 * persisted about a push is ids, counters, error CODES and the token's sha256.
 */
import type { NotificationItem, PushKindRoute, PushPayloadV1, PushPreviews } from '@tm8/contract';

/**
 * One device's sealed token, as S1's `devices/device-token.ts` names it: the
 * three `public.devices` columns tm8_app is never granted.
 */
export interface SealedDeviceToken {
  readonly tokenHash: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

/**
 * Opens one token: S1's `openDeviceToken` bound to the node key at the
 * composition root. It throws on a moved, re-hashed or tampered row, and its
 * error never carries the token.
 */
export type OpenDeviceToken = (identityId: string, sealed: SealedDeviceToken) => string;

/** One live device of a notification's recipient (393's push_devices_for). */
export interface PushDevice {
  readonly deviceId: string;
  readonly identityId: string;
  readonly platform: string;
  readonly previews: PushPreviews;
  readonly locale: string;
  /** ISO time; a quiet window ends here (s-lld §11, Quiet hours). */
  readonly quietUntil: string | null;
  readonly sealed: SealedDeviceToken;
}

/** One claimed outbox row: a notification, its recipient and their devices. */
export interface ClaimedPush {
  readonly outboxId: string;
  readonly notificationId: string;
  readonly spaceId: string;
  readonly recipientIdentityId: string;
  /** This claim's attempt number, from 1. */
  readonly attempt: number;
  readonly devices: readonly PushDevice[];
}

/**
 * The notification as the recipient's inbox shows it, read under the
 * recipient's own claims, plus the message it is about when it names one (the
 * inbox row does not carry that id; the web address needs it for `?msg=`).
 */
export interface PushNotification {
  readonly item: NotificationItem;
  readonly messageId: string | null;
}

export interface PushTicketRef {
  readonly ticketId: string;
  readonly deviceId: string;
  readonly tokenHash: string;
}

export interface PushDeadDevice {
  readonly deviceId: string;
  readonly tokenHash: string;
}

/** What became of one claimed row (393's settle_push_dispatch). */
export type PushSettlement =
  | {
      readonly outcome: 'sent';
      /** Accepted tickets, kept for the receipt pass. */
      readonly tickets: readonly PushTicketRef[];
      /** Devices the relay reported dead in this send. */
      readonly dead: readonly PushDeadDevice[];
      /** Per-device error codes, e.g. `MessageTooBig×1`; null when all were accepted. */
      readonly error: string | null;
    }
  | { readonly outcome: 'skipped'; readonly error: string }
  | { readonly outcome: 'retry'; readonly error: string; readonly retryAfterSeconds: number }
  | { readonly outcome: 'failed'; readonly error: string };

export interface PushClaimBatch {
  readonly items: readonly ClaimedPush[];
  readonly enqueued: number;
  readonly skippedRead: number;
  readonly skippedNoDevice: number;
  readonly expired: number;
}

export interface PushStore {
  claim(limit: number): Promise<PushClaimBatch>;
  /** Null when the recipient can no longer read the row (deleted, left the space). */
  notification(item: ClaimedPush): Promise<PushNotification | null>;
  /** `devicesDeleted`: dead devices actually deleted (a rotated token is not). */
  settle(outboxId: string, settlement: PushSettlement): Promise<{ readonly devicesDeleted: number }>;
  /** `expired`: tickets past the relay's 24 hours; `pruned`: settled queue rows past 7 days. */
  claimReceipts(limit: number): Promise<{
    readonly ticketIds: readonly string[];
    readonly expired: number;
    readonly pruned: number;
  }>;
  settleReceipts(
    done: readonly string[],
    dead: readonly string[],
  ): Promise<{ readonly devicesDeleted: number; readonly forgotten: number }>;
}

// -- the relay -----------------------------------------------------------------

/** One push for one device. `to` is the opened token: memory only. */
export interface RelayMessage {
  readonly to: string;
  readonly payload: PushPayloadV1;
  readonly route: PushKindRoute;
}

/**
 * The relay's per-message verdicts. Only the CODE is kept: Expo's messages
 * quote the token they are about.
 */
export type RelayErrorCode =
  | 'DeviceNotRegistered'
  | 'MessageTooBig'
  | 'MessageRateExceeded'
  | 'MismatchSenderId'
  | 'InvalidCredentials'
  | 'Unknown';

export type RelayTicket =
  | { readonly status: 'ok'; readonly id: string }
  | { readonly status: 'error'; readonly error: RelayErrorCode };

export type RelayReceipt =
  | { readonly status: 'ok' }
  | { readonly status: 'error'; readonly error: RelayErrorCode };

export interface PushRelay {
  readonly name: string;
  /** The most messages one `send` accepts. */
  readonly maxBatch: number;
  /**
   * One ticket per message, in order. Throws `RelayUnavailableError` when
   * nothing can be known to have been sent (try again later) and
   * `RelayRejectedError` when the relay refused the request as a whole.
   */
  send(messages: readonly RelayMessage[]): Promise<RelayTicket[]>;
  /** Receipts by ticket id; a ticket with no receipt yet is absent. */
  receipts(ticketIds: readonly string[]): Promise<ReadonlyMap<string, RelayReceipt>>;
}

/** The relay could not be reached or asked us to slow down: send again later. */
export class RelayUnavailableError extends Error {
  override readonly name = 'RelayUnavailableError';
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** The relay refused the request itself (400, credentials): sending again will not help. */
export class RelayRejectedError extends Error {
  override readonly name = 'RelayRejectedError';
}

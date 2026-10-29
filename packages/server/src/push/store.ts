/**
 * The push worker's database side.
 *
 * Two authorities, never mixed in one transaction:
 *   * the PUSH WORKER's claims (node owner, nodeAdmin, backgroundJob
 *     'push.dispatch') open 393's four doors, which are the only way to the
 *     queue, the tickets and the devices' sealed tokens;
 *   * the RECIPIENT's own claims read the notification through the inbox's
 *     assembler (`hydrateNotifications`), so the push says exactly what that
 *     person's inbox row says and carries no title, channel or message they
 *     cannot read themselves.
 */
import { PUSH_PREVIEWS, type PushPreviews } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { MICROS } from '../facade/entity-read.js';
import { hydrateNotifications, type NotificationRow } from '../facade/services/w2/inbox-read-marks.js';
import type {
  ClaimedPush,
  PushClaimBatch,
  PushDevice,
  PushNotification,
  PushSettlement,
  PushStore,
} from './types.js';

export const PUSH_LEASE_SECONDS = 120;
/** Only notifications this recent are queued: a node that was down does not push the past. */
export const PUSH_WINDOW_SECONDS = 15 * 60;
/** A queued push still unsent after this long is no longer news. */
export const PUSH_MAX_AGE_SECONDS = 60 * 60;
/** Expo: check a receipt about 15 minutes after the send. */
export const RECEIPT_MIN_AGE_SECONDS = 15 * 60;
export const RECEIPT_LEASE_SECONDS = 10 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const HEX_RE = /^(?:[0-9a-f]{2})+$/i;

export interface PgPushStoreOptions {
  readonly db: Pick<Db, 'rpc' | 'tx'>;
  /** The push worker: the node owner's claims with nodeAdmin and backgroundJob 'push.dispatch'. */
  readonly claims: () => Promise<DbClaims>;
  readonly leaseSeconds?: number;
  readonly windowSeconds?: number;
  readonly maxAgeSeconds?: number;
  readonly receiptMinAgeSeconds?: number;
  readonly receiptLeaseSeconds?: number;
}

export class PgPushStore implements PushStore {
  constructor(private readonly options: PgPushStoreOptions) {}

  async claim(limit: number): Promise<PushClaimBatch> {
    const raw = await this.options.db.rpc<unknown>(await this.options.claims(), 'public.claim_push_dispatch', [
      limit,
      this.options.leaseSeconds ?? PUSH_LEASE_SECONDS,
      this.options.windowSeconds ?? PUSH_WINDOW_SECONDS,
      this.options.maxAgeSeconds ?? PUSH_MAX_AGE_SECONDS,
    ]);
    return normalizeClaimBatch(raw);
  }

  async notification(item: ClaimedPush): Promise<PushNotification | null> {
    const recipient: DbClaims = {
      identityId: item.recipientIdentityId,
      requestId: `push.dispatch:${item.notificationId}`,
    };
    return this.options.db.tx(recipient, async (q) => {
      // The inbox's own row shape (inbox-read-marks.ts), under the recipient's
      // RLS: notifications_select admits only their own, unacted-as rows.
      const rows = await q.query<NotificationRow>(
        `select n.id, n.space_id, n.recipient_member_id, n.recipient_team_member_id,
                n.target_entity_id, n.actor_id, n.kind, n.payload, n.read_at, n.created_at,
                ${MICROS('n.created_at')} cursor_created_at
           from public.notifications n
          where n.id = $1
            and n.recipient_team_member_id is null`,
        [item.notificationId],
      );
      const row = rows[0];
      if (!row) return null;
      const [notification] = await hydrateNotifications(q, [row], item.recipientIdentityId);
      if (!notification) return null;
      const messageId = row.payload?.['messageId'];
      return {
        item: notification,
        messageId: typeof messageId === 'string' && UUID_RE.test(messageId) ? messageId : null,
      };
    });
  }

  async settle(outboxId: string, settlement: PushSettlement): Promise<{ readonly devicesDeleted: number }> {
    const sent = settlement.outcome === 'sent' ? settlement : null;
    const raw = await this.options.db.rpc<{ devicesDeleted?: unknown } | null>(
      await this.options.claims(),
      'public.settle_push_dispatch',
      [
        outboxId,
        settlement.outcome,
        settlement.error,
        JSON.stringify(sent?.tickets ?? []),
        JSON.stringify(sent?.dead ?? []),
        settlement.outcome === 'retry' ? Math.max(1, Math.round(settlement.retryAfterSeconds)) : null,
      ],
    );
    return { devicesDeleted: Number(raw?.devicesDeleted ?? 0) };
  }

  async claimReceipts(limit: number): Promise<{
    readonly ticketIds: readonly string[];
    readonly expired: number;
    readonly pruned: number;
  }> {
    const raw = await this.options.db.rpc<{ ticketIds?: unknown; expired?: unknown; pruned?: unknown } | null>(
      await this.options.claims(),
      'public.claim_push_receipts',
      [
        limit,
        this.options.receiptMinAgeSeconds ?? RECEIPT_MIN_AGE_SECONDS,
        this.options.receiptLeaseSeconds ?? RECEIPT_LEASE_SECONDS,
      ],
    );
    const ids = Array.isArray(raw?.ticketIds) ? raw.ticketIds.filter((id): id is string => typeof id === 'string') : [];
    return { ticketIds: ids, expired: Number(raw?.expired ?? 0), pruned: Number(raw?.pruned ?? 0) };
  }

  async settleReceipts(
    done: readonly string[],
    dead: readonly string[],
  ): Promise<{ readonly devicesDeleted: number; readonly forgotten: number }> {
    const raw = await this.options.db.rpc<{ devicesDeleted?: unknown; forgotten?: unknown } | null>(
      await this.options.claims(),
      'public.settle_push_receipts',
      [[...done], [...dead]],
    );
    return { devicesDeleted: Number(raw?.devicesDeleted ?? 0), forgotten: Number(raw?.forgotten ?? 0) };
  }
}

// -- parsing 393's jsonb -------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function previewsOf(value: unknown): PushPreviews {
  // 392's check admits only these; anything else shows nothing (fail closed).
  return (PUSH_PREVIEWS as readonly unknown[]).includes(value) ? (value as PushPreviews) : 'none';
}

function deviceOf(value: unknown): PushDevice | null {
  if (value === null || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  const deviceId = str(d['deviceId']);
  const identityId = str(d['identityId']);
  const tokenHash = str(d['tokenHash']);
  const ciphertext = str(d['tokenCiphertext']);
  const nonce = str(d['tokenNonce']);
  if (!deviceId || !identityId || !tokenHash || !SHA256_RE.test(tokenHash)) return null;
  if (!ciphertext || !HEX_RE.test(ciphertext) || !nonce || !HEX_RE.test(nonce)) return null;
  return {
    deviceId,
    identityId,
    platform: str(d['platform']) ?? 'unknown',
    previews: previewsOf(d['previews']),
    locale: str(d['locale']) ?? 'en',
    quietUntil: str(d['quietUntil']),
    sealed: { tokenHash, ciphertext: Buffer.from(ciphertext, 'hex'), nonce: Buffer.from(nonce, 'hex') },
  };
}

export function normalizeClaimBatch(raw: unknown): PushClaimBatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items: ClaimedPush[] = [];
  for (const value of Array.isArray(r['items']) ? r['items'] : []) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const outboxId = str(v['outboxId']);
    const notificationId = str(v['notificationId']);
    const spaceId = str(v['spaceId']);
    const recipientIdentityId = str(v['recipientIdentityId']);
    if (!outboxId || !notificationId || !spaceId || !recipientIdentityId) continue;
    const devices = (Array.isArray(v['devices']) ? v['devices'] : [])
      .map(deviceOf)
      .filter((device): device is PushDevice => device !== null);
    items.push({
      outboxId,
      notificationId,
      spaceId,
      recipientIdentityId,
      attempt: typeof v['attempt'] === 'number' && v['attempt'] > 0 ? v['attempt'] : 1,
      devices,
    });
  }
  const count = (key: string): number => (typeof r[key] === 'number' ? (r[key] as number) : 0);
  return {
    items,
    enqueued: count('enqueued'),
    skippedRead: count('skippedRead'),
    skippedNoDevice: count('skippedNoDevice'),
    expired: count('expired'),
  };
}

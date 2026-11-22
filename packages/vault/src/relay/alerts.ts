import { z } from 'zod';
import { VAULT_ALERT_KINDS, type VaultAlert } from '../core-types.js';

/**
 * Real-time owner alerts (brief MSG 6) leave the broker in this header on an
 * attested response. Only the relay reads it: the relay passes back an
 * explicit header allowlist that never includes it, then notifies each
 * alert's `memberId` in tm8. The header can carry alerts raised by OTHER
 * requests, so it must never reach a caller.
 *
 *   x-tm8-vault-alerts: b64url(JSON {"v":1,"dropped":n,"alerts":[VaultAlert...]})
 */
export const VAULT_ALERTS_HEADER = 'x-tm8-vault-alerts';
/** Encoded budget per response. The relay's HTTP client accepts 16 KiB of headers in total. */
export const VAULT_ALERTS_HEADER_MAX_CHARS = 6 * 1024;
export const VAULT_ALERTS_MAX_PER_HEADER = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Id = z.string().regex(UUID);
const Text = z.string().max(512).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const Param = z.union([Text, z.number().finite(), z.boolean(), z.null(), z.array(Text).max(32)]);

export const VaultAlertSchema = z.object({
  kind: z.enum(VAULT_ALERT_KINDS),
  memberId: Id,
  spaceId: Id,
  itemId: Id.nullable(),
  params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), Param)
    .refine((params) => Object.keys(params).length <= 16),
  at: z.string().datetime({ offset: false }),
}).strict();

const HeaderSchema = z.object({
  v: z.literal(1),
  dropped: z.number().int().nonnegative(),
  alerts: z.array(VaultAlertSchema).max(VAULT_ALERTS_MAX_PER_HEADER),
}).strict();

export interface VaultAlertBatch {
  dropped: number;
  alerts: VaultAlert[];
}

export class VaultAlertHeaderError extends Error {
  constructor() {
    super('vault alerts: malformed header');
    this.name = 'VaultAlertHeaderError';
  }
}

/** Broker side. Throws a fixed message when an alert does not fit the schema. */
export function encodeVaultAlerts(batch: VaultAlertBatch): string {
  const parsed = HeaderSchema.safeParse({ v: 1, dropped: batch.dropped, alerts: batch.alerts });
  if (!parsed.success) throw new VaultAlertHeaderError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** Relay side. Never echoes the header: every failure is the same error. */
export function decodeVaultAlerts(header: string | string[] | undefined): VaultAlertBatch | null {
  if (header === undefined) return null;
  if (typeof header !== 'string' || header.length === 0 || header.length > VAULT_ALERTS_HEADER_MAX_CHARS
    || !/^[A-Za-z0-9_-]+$/.test(header)) throw new VaultAlertHeaderError();
  let value: unknown;
  try {
    const bytes = Buffer.from(header, 'base64url');
    if (bytes.toString('base64url') !== header) throw new VaultAlertHeaderError();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new VaultAlertHeaderError(); }
  const parsed = HeaderSchema.safeParse(value);
  if (!parsed.success) throw new VaultAlertHeaderError();
  return { dropped: parsed.data.dropped, alerts: parsed.data.alerts as VaultAlert[] };
}

/**
 * W0 B1 — Server-internal system-delivery-principal seam.
 *
 * This module does not parse request data and is not an authentication path.
 * Minted object identity is retained in a module-private WeakSet so JSON,
 * headers, actorId, bearer claims, and structurally identical records cannot
 * manufacture this authority. W2 must still validate the stored reservation
 * and call this guard before queue admission.
 */

import type {
  SystemDeliveryPrincipal,
  SystemDeliveryPrincipalBinding,
  SystemDeliveryPrincipalClaims,
} from './types.js';

const PRINCIPAL_TYPE = 'system_delivery_adapter' as const;
const CLAIM_KEYS = [
  'deliveryId',
  'messageId',
  'targetWorkSessionId',
  'reservationVersion',
  'expiresAt',
] as const;
const BINDING_KEYS = CLAIM_KEYS.slice(0, 4);
const INVALID_CLAIMS_MESSAGE = 'invalid system delivery principal claims';

const mintedPrincipals = new WeakSet<object>();

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value: Record<PropertyKey, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isReservationVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isExpiry(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isClaims(value: unknown): value is SystemDeliveryPrincipalClaims {
  return (
    isPlainRecord(value) &&
    hasExactOwnKeys(value, CLAIM_KEYS) &&
    isOpaqueId(value.deliveryId) &&
    isOpaqueId(value.messageId) &&
    isOpaqueId(value.targetWorkSessionId) &&
    isReservationVersion(value.reservationVersion) &&
    isExpiry(value.expiresAt)
  );
}

function isBinding(value: unknown): value is SystemDeliveryPrincipalBinding {
  return (
    isPlainRecord(value) &&
    hasExactOwnKeys(value, BINDING_KEYS) &&
    isOpaqueId(value.deliveryId) &&
    isOpaqueId(value.messageId) &&
    isOpaqueId(value.targetWorkSessionId) &&
    isReservationVersion(value.reservationVersion)
  );
}

/**
 * Mint one in-memory principal from Server-owned delivery state.
 *
 * The input is runtime-validated and copied so callers cannot add claims or
 * mutate authority after minting. The generic error deliberately excludes
 * supplied identifiers and other values from logs.
 */
export function mintSystemDeliveryPrincipal(
  input: SystemDeliveryPrincipalClaims,
): SystemDeliveryPrincipal {
  if (!isClaims(input)) throw new TypeError(INVALID_CLAIMS_MESSAGE);

  const frozenClaims = Object.freeze({
    deliveryId: input.deliveryId,
    messageId: input.messageId,
    targetWorkSessionId: input.targetWorkSessionId,
    reservationVersion: input.reservationVersion,
    expiresAt: input.expiresAt,
  });
  const principal = Object.freeze({
    principalType: PRINCIPAL_TYPE,
    claims: frozenClaims,
  }) as SystemDeliveryPrincipal;

  mintedPrincipals.add(principal);
  return principal;
}

/**
 * Validate mint provenance, the complete reservation tuple, and live expiry.
 *
 * This is intentionally not a public parser: only object identities produced
 * by `mintSystemDeliveryPrincipal` in this module can pass. Expiry is exclusive;
 * a principal is invalid at `expiresAt` itself.
 */
export function isSystemDeliveryPrincipalFor(
  value: unknown,
  expected: SystemDeliveryPrincipalBinding,
  nowMs: number = Date.now(),
): value is SystemDeliveryPrincipal {
  if (
    typeof value !== 'object' ||
    value === null ||
    !mintedPrincipals.has(value) ||
    !isBinding(expected) ||
    !Number.isFinite(nowMs)
  ) {
    return false;
  }

  const candidate = value as { principalType?: unknown; claims?: unknown };
  if (candidate.principalType !== PRINCIPAL_TYPE || !isClaims(candidate.claims)) return false;

  const candidateClaims = candidate.claims;
  return (
    Date.parse(candidateClaims.expiresAt) > nowMs &&
    candidateClaims.deliveryId === expected.deliveryId &&
    candidateClaims.messageId === expected.messageId &&
    candidateClaims.targetWorkSessionId === expected.targetWorkSessionId &&
    candidateClaims.reservationVersion === expected.reservationVersion
  );
}

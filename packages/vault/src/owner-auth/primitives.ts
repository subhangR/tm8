import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditParam, VaultCaller, VaultSessionRecord, VaultTx } from '../core-types.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function equalHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function expiresAfter(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

export function liveSession(row: VaultSessionRecord, now: string): boolean {
  return row.revokedAt === null && Date.parse(row.expiresAt) > Date.parse(now)
    && Date.parse(row.familyExpiresAt) > Date.parse(now);
}

/** Names are attribution in tm8, but never copied into vault audit records. */
export async function audit(tx: VaultTx, caller: VaultCaller, action: string, params: Record<string, AuditParam> = {}): Promise<void> {
  await tx.audit.append({
    action,
    actor: { kind: caller.kind, memberId: caller.memberId, sessionId: caller.sessionId, name: null },
    subjectMemberId: caller.memberId, spaceId: caller.spaceId, itemId: null, params,
  });
}

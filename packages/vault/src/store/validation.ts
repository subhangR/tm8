import { AsyncLocalStorage } from 'node:async_hooks';
import { VAULT_AUDIT_ACTIONS, VAULT_ITEM_TYPES, VAULT_STEP_UP_ACTIONS } from '@tm8/contract';
import { AUDIT_GENESIS_HASH, sealAuditEvent } from '../audit/chain.js';
import { VAULT_CIPHER_SUITE, type EncryptedSecretVersion } from '../crypto/aead.js';
import { APPROVAL_KINDS, digestEquals } from '../intent/hash.js';
import {
  AuditUnavailableError,
  SYSTEM_ACTOR,
  StoreDuplicateError,
  StoreNotFoundError,
  StoreScopeError,
  StoreStateError,
  StoreUnavailableError,
  StoreVersionConflictError,
  VaultError,
  effectiveApprovalState,
  isoNow,
  systemClock,
  type ActorRecord,
  type ApprovalKind,
  type ApprovalRecord,
  type ApprovalState,
  type ApprovalsRepo,
  type AuditBody,
  type AuditEventRecord,
  type AuditParam,
  type AuditRepo,
  type CaptureLinkRecord,
  type CaptureLinksRepo,
  type ChallengePurpose,
  type ChallengeRecord,
  type ChallengesRepo,
  type CheckpointRecord,
  type Clock,
  type CodeRecord,
  type DeletionLedgerEntry,
  type DeletionLedgerRepo,
  type EnrollmentCodeRecord,
  type EnrollmentCodesRepo,
  type GrantConstraints,
  type GrantRecord,
  type GrantsRepo,
  type IsoTime,
  type ItemMetadataFields,
  type ItemRecord,
  type ItemsRepo,
  type NewApproval,
  type NewItem,
  type OperationKind,
  type OperationRecord,
  type OperationState,
  type OperationsRepo,
  type Page,
  type PageQuery,
  type PasskeyRecord,
  type PasskeysRepo,
  type PoliciesRepo,
  type PolicyInput,
  type PolicyRecord,
  type RecoveryCodesRepo,
  type RefreshRotation,
  type SecretVersionRecord,
  type SessionEndReason,
  type SpendRepo,
  type SpendRequestRecord,
  type StoreScope,
  type VaultSessionRecord,
  type VaultSessionsRepo,
  type VaultStore,
  type VaultTx,
} from '../core-types.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const B64URL_RE = /^[A-Za-z0-9_-]+$/;
export const ARGON2ID_RE = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
export const PRINTABLE_RE = /^[\x20-\x7e]+$/;
export const ITEM_TYPES = VAULT_ITEM_TYPES;
export const EXPOSURE_TIERS = ['a', 'b', 'c'] as const;
export const SESSION_END_REASONS = ['ended', 'revoked', 'refresh_reuse', 'recovery', 'passkey_revoked', 'expired'] as const;
export const CHALLENGE_PURPOSES = ['sign_in', 'step_up', 'registration'] as const;
export const OPERATION_KINDS = ['fill', 'call_api', 'spend'] as const;
export const FINAL_OPERATION_STATES = ['done', 'refused', 'approval_required', 'unknown'] as const;
export const SYSTEM_PURPOSES = ['reconcile', 'expire', 'audit', 'deletion_ledger', 'enrollment', 'cleanup'] as const;
export const AUDIT_ACTIONS: ReadonlySet<string> = new Set(VAULT_AUDIT_ACTIONS);

export function bad(what: string): never {
  throw new TypeError(`vault store: invalid ${what}`);
}

export function uuid(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) bad(what);
  return value.toLowerCase();
}

export function nullableUuid(value: unknown, what: string): string | null {
  return value === null ? null : uuid(value, what);
}

export function hex64(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) bad(what);
  return value;
}

/** `toISOString()` form exactly. Month 13 matches the pattern but is an invalid Date, whose toISOString() throws. */
export function isIsoMs(value: unknown): value is IsoTime {
  if (typeof value !== 'string' || !ISO_MS_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function iso(value: unknown, what: string): IsoTime {
  if (!isIsoMs(value)) bad(what);
  return value;
}

export function text(value: unknown, what: string, max = 1000): string {
  if (typeof value !== 'string' || value.length > max) bad(what);
  return value;
}

export function nullableText(value: unknown, what: string, max = 1000): string | null {
  return value === null ? null : text(value, what, max);
}

export function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') bad(what);
  return value;
}

export function int(value: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) bad(what);
  return value;
}

export function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, what: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) bad(what);
  return value as T[number];
}

export function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) bad(what);
  return [...(value as string[])];
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function actorRecord(value: ActorRecord): ActorRecord {
  if (value === null || typeof value !== 'object') bad('actor');
  return {
    kind: oneOf(value.kind, ['member', 'agent', 'system'] as const, 'actor kind'),
    memberId: nullableUuid(value.memberId, 'actor memberId'),
    sessionId: nullableUuid(value.sessionId, 'actor sessionId'),
    name: nullableText(value.name, 'actor name', 200),
  };
}

/** A member or agent actor that is the scope member. Attribution must not name someone else. */
export function scopeActor(value: ActorRecord, memberId: string): ActorRecord {
  const actor = actorRecord(value);
  if (actor.kind === 'system' || actor.memberId !== memberId) bad('actor (not the scope member)');
  return actor;
}

/** AuditParam values only: metadata, never a nested object. */
export function auditParams(value: Record<string, AuditParam>, what: string): Record<string, AuditParam> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(what);
  const out: Record<string, AuditParam> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') out[key] = entry;
    else if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
    else if (Array.isArray(entry) && entry.every((part) => typeof part === 'string')) out[key] = [...entry];
    else bad(`${what}.${key}`);
  }
  return out;
}

/** What Postgres jsonb keeps: JSON only. `undefined` is stored as null. */
export function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) bad('result');
  return JSON.parse(encoded);
}

export function metadataPatch(patch: Partial<ItemMetadataFields>): Partial<ItemMetadataFields> {
  const out: Partial<ItemMetadataFields> = {};
  if (patch.name !== undefined) out.name = text(patch.name, 'name', 500);
  if (patch.username !== undefined) out.username = nullableText(patch.username, 'username', 500);
  if (patch.last4 !== undefined) {
    if (patch.last4 !== null && (typeof patch.last4 !== 'string' || !/^\d{4}$/.test(patch.last4))) bad('last4');
    out.last4 = patch.last4;
  }
  if (patch.expMonth !== undefined) out.expMonth = patch.expMonth === null ? null : int(patch.expMonth, 'expMonth', 1, 12);
  if (patch.expYear !== undefined) out.expYear = patch.expYear === null ? null : int(patch.expYear, 'expYear', 1970, 9999);
  if (patch.connector !== undefined) out.connector = nullableText(patch.connector, 'connector', 100);
  if (patch.hasTotp !== undefined) out.hasTotp = bool(patch.hasTotp, 'hasTotp');
  if (patch.hasNotes !== undefined) out.hasNotes = bool(patch.hasNotes, 'hasNotes');
  if (patch.fieldNames !== undefined) out.fieldNames = strings(patch.fieldNames, 'fieldNames');
  return out;
}

export function secretVersion(secret: EncryptedSecretVersion, itemId: string, version: number, now: IsoTime): SecretVersionRecord {
  if (secret === null || typeof secret !== 'object' || secret.suite !== VAULT_CIPHER_SUITE) bad('secret suite');
  for (const part of [secret.wrappedDek, secret.nonce, secret.ciphertext]) {
    if (!Buffer.isBuffer(part) || part.length === 0) bad('secret version');
  }
  return Object.freeze({
    suite: secret.suite,
    kekId: text(secret.kekId, 'kekId', 500),
    wrappedDek: Buffer.from(secret.wrappedDek),
    nonce: Buffer.from(secret.nonce),
    ciphertext: Buffer.from(secret.ciphertext),
    itemId,
    version,
    createdAt: now,
  });
}

export function earliest(a: IsoTime, b: IsoTime): IsoTime {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Records out: deep-frozen inside, cloned outside.
// ---------------------------------------------------------------------------

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

export function out<T>(value: T): T {
  return structuredClone(value);
}

export function outSecret(record: SecretVersionRecord): SecretVersionRecord {
  return {
    ...record,
    wrappedDek: Buffer.from(record.wrappedDek),
    nonce: Buffer.from(record.nonce),
    ciphertext: Buffer.from(record.ciphertext),
  };
}

// ---------------------------------------------------------------------------
// Paging: newest first, opaque cursors.
// ---------------------------------------------------------------------------

type TimeKey = readonly [IsoTime, string];

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(limit)));
}

export function encodeCursor(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: unknown): unknown[] {
  const invalid = new VaultError('invalid_cursor');
  if (typeof cursor !== 'string' || cursor.length > 512 || !B64URL_RE.test(cursor)) throw invalid;
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid;
  }
  if (!Array.isArray(parsed)) throw invalid;
  return parsed;
}

export function timeCursor(cursor: unknown): TimeKey {
  const key = decodeCursor(cursor);
  const [at, id] = key;
  if (key.length !== 2 || typeof at !== 'string' || typeof id !== 'string'
    || !isIsoMs(at) || !UUID_RE.test(id)) {
    throw new VaultError('invalid_cursor');
  }
  return [at, id];
}

export function seqCursor(cursor: unknown): number {
  const key = decodeCursor(cursor);
  const [seq] = key;
  if (key.length !== 1 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new VaultError('invalid_cursor');
  return seq;
}

export function compareTimeKey(a: TimeKey, b: TimeKey): number {
  return (Date.parse(a[0]) - Date.parse(b[0])) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

export const newestFirst = <T extends { createdAt: IsoTime; id: string }>(a: T, b: T): number =>
  compareTimeKey([b.createdAt, b.id], [a.createdAt, a.id]);

export function pageByTime<T extends { createdAt: IsoTime; id: string }>(rows: T[], query: PageQuery, view: (row: T) => T): Page<T> {
  const limit = clampLimit(query.limit);
  const after = query.cursor === undefined ? null : timeCursor(query.cursor);
  const ordered = rows.slice().sort(newestFirst);
  const remaining = after ? ordered.filter((row) => compareTimeKey([row.createdAt, row.id], after) < 0) : ordered;
  const page = remaining.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(view),
    nextCursor: remaining.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null,
  };
}

export function pageBySeq(rows: AuditEventRecord[], query: PageQuery): Page<AuditEventRecord> {
  const limit = clampLimit(query.limit);
  const before = query.cursor === undefined ? null : seqCursor(query.cursor);
  const ordered = rows.slice().sort((a, b) => b.seq - a.seq);
  const remaining = before === null ? ordered : ordered.filter((row) => row.seq < before);
  const page = remaining.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page.map(out), nextCursor: remaining.length > limit && last ? encodeCursor([last.seq]) : null };
}


export function checkScope(scope: StoreScope): StoreScope {
  if (scope === null || typeof scope !== 'object') bad('scope');
  if (scope.kind === 'member') {
    return Object.freeze({ kind: 'member', memberId: uuid(scope.memberId, 'scope memberId'), spaceId: uuid(scope.spaceId, 'scope spaceId') });
  }
  if (scope.kind === 'system') return Object.freeze({ kind: 'system', purpose: oneOf(scope.purpose, SYSTEM_PURPOSES, 'scope purpose') });
  return bad('scope');
}


export function argon2idHash(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !ARGON2ID_RE.test(value)) bad('code hash (Argon2id only)');
  return value;
}

export const oldestCodeFirst = (a: CodeRecord, b: CodeRecord): number => compareTimeKey([a.createdAt, a.id], [b.createdAt, b.id]);


export function oldestOperationFirst(a: OperationRecord, b: OperationRecord): number {
  return compareTimeKey([a.createdAt, a.operationId], [b.createdAt, b.operationId]) || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
}


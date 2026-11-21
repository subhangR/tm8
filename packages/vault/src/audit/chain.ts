import { createHash } from 'node:crypto';
import { canonicalJson } from '../intent/hash.js';
import { CheckpointReadError, type AuditBody, type AuditEventRecord, type IsoTime, type RetainedCheckpoint } from '../core-types.js';

/**
 * The tamper-evident audit chain (brief MSG 11, acceptance test 16). Pure
 * functions, so the Postgres SECURITY DEFINER append, the memory store and
 * every verifier compute exactly the same bytes.
 *
 *   bodyText  = JCS({action, actor{kind, memberId, sessionId, name}, itemId, params, spaceId, subjectMemberId})
 *   entryHash = hex(SHA-256("tm8-vault-audit|v1|" + seq + "|" + prevHash + "|" + at + "|" + bodyText))
 *
 * `seq` is the decimal sequence number from 1, `prevHash` the previous entry's
 * hash (`AUDIT_GENESIS_HASH` for seq 1), and `at` is
 * `Date.prototype.toISOString()` form, so exactly millisecond precision.
 * Postgres must produce the same text:
 * `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` over a
 * value already truncated to milliseconds. The store keeps `bodyText`
 * verbatim. jsonb is not byte-stable, so it is never the hashed form.
 */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

const ENTRY_PREFIX = 'tm8-vault-audit|v1|';
const CHECKPOINT_PREFIX = 'tm8-vault-checkpoint|v1|';
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class AuditChainError extends Error {
  constructor(reason: string) {
    super(`audit chain: ${reason}`);
    this.name = 'AuditChainError';
  }
}

function checkSeq(seq: number): number {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new AuditChainError('seq must be a positive integer');
  return seq;
}

function checkHash(hash: string): string {
  if (typeof hash !== 'string' || !HEX64.test(hash)) throw new AuditChainError('hash must be 64 lowercase hex chars');
  return hash;
}

function checkAt(at: IsoTime): IsoTime {
  // Month 13 matches ISO_MS but is an invalid Date, whose toISOString() would throw a RangeError.
  if (typeof at !== 'string' || !ISO_MS.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new AuditChainError('at must be toISOString() form');
  }
  return at;
}

/** The hashed form of an event. Only these six fields: anything else on the object is neither hashed nor stored. */
export function auditBodyText(body: AuditBody): string {
  return canonicalJson({
    action: body.action,
    actor: { kind: body.actor.kind, memberId: body.actor.memberId, sessionId: body.actor.sessionId, name: body.actor.name },
    itemId: body.itemId,
    subjectMemberId: body.subjectMemberId,
    spaceId: body.spaceId,
    params: body.params,
  });
}

export function auditEntryHash(seq: number, prevHash: string, at: IsoTime, bodyText: string): string {
  const input = `${ENTRY_PREFIX}${checkSeq(seq)}|${checkHash(prevHash)}|${checkAt(at)}|${bodyText}`;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Builds the stored record for an append. The caller assigns `seq`, `prevHash` and `at` under the head lock. */
export function sealAuditEvent(body: AuditBody, seq: number, prevHash: string, at: IsoTime): AuditEventRecord {
  const bodyText = auditBodyText(body);
  const parsed = JSON.parse(bodyText) as AuditBody;
  return {
    action: parsed.action,
    actor: parsed.actor,
    itemId: parsed.itemId,
    subjectMemberId: parsed.subjectMemberId,
    spaceId: parsed.spaceId,
    params: parsed.params,
    seq,
    at,
    prevHash,
    entryHash: auditEntryHash(seq, prevHash, at, bodyText),
    bodyText,
  };
}

export interface ChainCursor {
  seq: number;
  hash: string;
}

export type AuditRunResult =
  | { ok: true; head: ChainCursor }
  /** `head` is the last entry that verified. */
  | { ok: false; firstBrokenSeq: number; head: ChainCursor };

/**
 * Verifies a contiguous ascending run that continues from `from`
 * (`{seq: 0, hash: AUDIT_GENESIS_HASH}` for the whole chain). Each event must
 * have the next seq, link to the previous hash, recompute to its own hash, and
 * carry structured fields whose canonical form IS its stored `bodyText`, so an
 * edit to an indexed column is caught as well as an edit to the text.
 */
export function verifyAuditRun(from: ChainCursor, events: readonly AuditEventRecord[]): AuditRunResult {
  let head: ChainCursor = { seq: from.seq, hash: from.hash };
  for (const event of events) {
    const expectedSeq = head.seq + 1;
    let ok = event.seq === expectedSeq && event.prevHash === head.hash;
    if (ok) {
      try {
        ok = auditBodyText(event) === event.bodyText
          && auditEntryHash(event.seq, event.prevHash, event.at, event.bodyText) === event.entryHash;
      } catch {
        ok = false;
      }
    }
    if (!ok) return { ok: false, firstBrokenSeq: expectedSeq, head };
    head = { seq: event.seq, hash: event.entryHash };
  }
  return { ok: true, head };
}

/** The exact bytes a checkpoint signer signs. */
export function checkpointSigningInput(checkpoint: { seq: number; headHash: string; at: IsoTime; keyId: string }): Buffer {
  if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0) throw new AuditChainError('checkpoint seq must be a non-negative integer');
  if (typeof checkpoint.keyId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(checkpoint.keyId) || checkpoint.keyId.includes('|')) {
    throw new AuditChainError('checkpoint keyId must be 1..200 printable chars without "|"');
  }
  return Buffer.from(
    `${CHECKPOINT_PREFIX}${checkpoint.seq}|${checkHash(checkpoint.headHash)}|${checkAt(checkpoint.at)}|${checkpoint.keyId}`,
    'utf8',
  );
}

/** The largest retained checkpoint object either sink reads back; both write well under 1 KiB. */
export const RETAINED_CHECKPOINT_MAX_BYTES = 4_096;
const RETAINED_KEYS = ['at', 'headHash', 'keyId', 'seq', 'signature'];

/**
 * Parses a checkpoint object read back from a sink (review F01). Exactly the
 * five fields the sinks write, a seq that matches the object's name, a
 * well-formed signing input and a canonical base64url signature; anything
 * else throws CheckpointReadError('invalid') and nothing is guessed.
 */
export function parseRetainedCheckpoint(bytes: Buffer, expected: { seq: number; headHash?: string }, location: string): RetainedCheckpoint {
  const invalid = () => new CheckpointReadError('invalid');
  if (bytes.length === 0 || bytes.length > RETAINED_CHECKPOINT_MAX_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== RETAINED_KEYS.join(',')) throw invalid();
  const { seq, headHash, at, keyId, signature } = record;
  if (seq !== expected.seq || typeof headHash !== 'string' || (expected.headHash !== undefined && headHash !== expected.headHash) ||
      typeof at !== 'string' || typeof keyId !== 'string' || typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{1,1024}$/.test(signature) || Buffer.from(signature, 'base64url').toString('base64url') !== signature) throw invalid();
  try { checkpointSigningInput({ seq, headHash, at, keyId }); } catch { throw invalid(); }
  return { seq, headHash, at, keyId, signature, location };
}

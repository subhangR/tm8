import { randomBytes, randomUUID } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { SYSTEM_ACTOR, VaultError, type CodeRecord, type VaultStore } from '../core-types.js';
import { expiresAfter } from './primitives.js';

export const CODE_ARGON2 = Object.freeze({ memorySize: 65_536, iterations: 3, parallelism: 1, hashLength: 32 });
function prefix(id: string): string {
  return id.replaceAll('-', '').slice(-12);
}

export async function newCode(): Promise<{ code: string; id: string; hash: string }> {
  const id = randomUUID();
  // The public 48-bit lookup prefix is separate from the 160-bit secret.
  const code = `${prefix(id)}.${randomBytes(20).toString('base64url')}`;
  const hash = await argon2id({ ...CODE_ARGON2, password: code, salt: randomBytes(16), outputType: 'encoded' });
  return { code, id, hash };
}

/** A malformed, missing or colliding prefix never makes us hash every row. */
export async function findCode<T extends CodeRecord>(rows: T[], code: string): Promise<T | null> {
  const lookup = code.slice(0, 12);
  const matches = /^[a-f0-9]{12}\.[A-Za-z0-9_-]{27}$/.test(code) ? rows.filter((row) => prefix(row.id) === lookup) : [];
  const row = matches.length === 1 ? matches[0]! : null;
  // Refuse weaker hashes, and cap parameters before passing database text to WASM.
  const hash = row && /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(row.hash) ? row.hash : DUMMY_HASH;
  try {
    const verified = await argon2Verify({ password: code, hash });
    return verified ? row : null;
  } catch {
    return null;
  }
}

// Hash of the fixed text "invalid-vault-code" and 16 zero salt bytes. Not a credential.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$qPg1Qgd+9awLiQNQNEt/e/VWFcTBZL7+9qSkBdSSBpk';

export async function newCodeBatch(count: number): Promise<Awaited<ReturnType<typeof newCode>>[]> {
  for (;;) {
    const fresh: Awaited<ReturnType<typeof newCode>>[] = [];
    for (let i = 0; i < count; i += 1) fresh.push(await newCode());
    if (new Set(fresh.map((row) => prefix(row.id))).size === count) return fresh;
  }
}

/** Only an out-of-band broker operator receives this result. Never an operation handler. */
export async function mintEnrollmentCode(store: VaultStore, options: { memberId: string; spaceId: string; ttlSeconds: number }): Promise<string> {
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 86_400) {
    throw new VaultError('invalid_input');
  }
  const fresh = await newCode();
  await store.transaction({ kind: 'system', purpose: 'enrollment' }, async (tx) => {
    await tx.enrollmentCodes.create({
      id: fresh.id, memberId: options.memberId, spaceId: options.spaceId,
      hash: fresh.hash, expiresAt: expiresAfter(tx.now, options.ttlSeconds), mintedBy: 'broker_operator',
    });
    await tx.audit.append({ action: 'admin.enrollment_code_minted', actor: SYSTEM_ACTOR,
      subjectMemberId: options.memberId, spaceId: options.spaceId, itemId: null, params: {} });
  });
  return fresh.code;
}

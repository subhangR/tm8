/**
 * The one place tm8 turns a third-party secret into bytes it is willing to
 * store, and back.
 *
 * AES-256-GCM, because the requirement is not merely confidentiality: a
 * ciphertext that could be MOVED between rows would let anyone with write
 * access to `public.account_git_credentials` (which nobody has — see 081) point
 * one account's row at another account's token. GCM's additional authenticated
 * data closes that by construction: the AAD is `<accountId>|<provider>`, so a
 * ciphertext decrypted under the wrong row's AAD fails the tag check and
 * throws, rather than quietly yielding someone else's credential.
 *
 * There is deliberately no "decrypt without AAD" entry point. A caller that
 * cannot say which row it is opening has no business opening it.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256. The key file is exactly this long or it is not a key. */
export const SECRET_KEY_BYTES = 32;
/** GCM's canonical nonce length; anything else weakens the construction. */
export const SECRET_NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  /** ciphertext || 16-byte GCM tag. */
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

/** The row a sealed secret belongs to. Anything else must not open it. */
export interface SecretBinding {
  readonly accountId: string;
  readonly provider: string;
}

function aad(binding: SecretBinding): Buffer {
  return Buffer.from(`${binding.accountId}|${binding.provider}`, 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`credential key must be ${String(SECRET_KEY_BYTES)} bytes`);
  }
}

/** Encrypt `plaintext` so that only this node's key file can read it back. */
export function sealSecret(key: Buffer, plaintext: string, binding: SecretBinding): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/**
 * Decrypt a sealed secret, or throw. Never returns a partially-verified
 * plaintext: GCM authenticates before `final()` returns.
 */
export function openSecret(key: Buffer, sealed: SealedSecret, binding: SecretBinding): string {
  assertKey(key);
  if (sealed.nonce.length !== SECRET_NONCE_BYTES) {
    throw new Error('sealed credential has a malformed nonce');
  }
  if (sealed.ciphertext.length <= TAG_BYTES) {
    throw new Error('sealed credential is too short to carry an authentication tag');
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Constant-time comparison, exported because a test that proves two ciphertexts
 * of the same plaintext DIFFER should not itself introduce a timing oracle in
 * production code that later copies it.
 */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

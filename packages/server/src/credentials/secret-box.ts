/** AES-256-GCM storage shared with staging's account_git_credentials design. */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const SECRET_KEY_BYTES = 32;
export const SECRET_NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

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

export function sealSecret(key: Buffer, plaintext: string, binding: SecretBinding): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

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

export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

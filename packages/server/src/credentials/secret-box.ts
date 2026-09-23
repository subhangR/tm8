/** AES-256-GCM sealing for string-shaped third-party credentials. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SECRET_KEY_BYTES = 32;
export const SECRET_NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SealedSecret {
  /** ciphertext || authentication tag. */
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

/** A member's credential (079, 203): AAD `<account_id>|<provider>`. */
export interface AccountSecretBinding {
  readonly accountId: string;
  readonly provider: string;
}

/**
 * A space credential (206): AAD `<space_id>|<credential_id>|<provider>`. Two
 * separators against the account form's one, so the two binding spaces cannot
 * collide: an account-bound ciphertext never opens as a space one, or back.
 */
export interface SpaceSecretBinding {
  readonly spaceId: string;
  readonly credentialId: string;
  readonly provider: string;
}

export type SecretBinding = AccountSecretBinding | SpaceSecretBinding;

function bindingBytes(binding: SecretBinding): Buffer {
  const aad = 'spaceId' in binding
    ? `${binding.spaceId}|${binding.credentialId}|${binding.provider}`
    : `${binding.accountId}|${binding.provider}`;
  return Buffer.from(aad, 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`credential key must be ${String(SECRET_KEY_BYTES)} bytes`);
  }
}

export function sealSecret(
  key: Buffer,
  plaintext: string,
  binding: SecretBinding,
): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(bindingBytes(binding));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function openSecret(
  key: Buffer,
  sealed: SealedSecret,
  binding: SecretBinding,
): string {
  assertKey(key);
  if (sealed.nonce.length !== SECRET_NONCE_BYTES) {
    throw new Error('sealed credential has a malformed nonce');
  }
  if (sealed.ciphertext.length <= AUTH_TAG_BYTES) {
    throw new Error('sealed credential is too short to carry an authentication tag');
  }

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - AUTH_TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(bindingBytes(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretMaterial, zeroize } from '../secret-material.js';
import { openGcm } from './gcm.js';
import type { KmsProvider, WrappedDek } from './kms.js';

/**
 * Per-item envelope encryption (brief MSG 4, R3).
 *
 * - Every secret VERSION gets a fresh random 256-bit DEK, and that DEK seals
 *   exactly one plaintext. A (key, nonce) pair can therefore never repeat, and
 *   the random 96-bit GCM nonce is safe without a counter.
 * - The DEK is wrapped by the KMS KEK and zeroized. Postgres stores only
 *   `wrapped_dek`, `nonce`, `ciphertext` and the ids, so a stolen DB or backup
 *   without the KMS yields nothing (acceptance test 14).
 * - AAD binds the ciphertext to item, owner, version and KEK id. A row
 *   swapped between items, owners or versions fails authentication instead of
 *   decrypting to the wrong secret. The DEK wrap uses a DIFFERENT prefix, so a
 *   wrapped DEK can never stand in for a value ciphertext or the reverse.
 */
export const VAULT_CIPHER_SUITE = 'A256GCM' as const;
export const DEK_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

const VALUE_AAD_PREFIX = 'vault-item|v1';
const DEK_AAD_PREFIX = 'vault-dek|v1';

export interface VaultAadParts {
  itemId: string;
  ownerId: string;
  version: number;
}

export class VaultCryptoError extends Error {
  constructor(
    readonly code: 'invalid_aad' | 'decrypt_failed' | 'invalid_record',
    message: string,
  ) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

function checkPart(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[|\u0000-\u001f]/.test(value)) {
    throw new VaultCryptoError('invalid_aad', `AAD part ${name} must be 1..200 printable chars without "|"`);
  }
  return value;
}

function checkVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new VaultCryptoError('invalid_aad', 'AAD version must be a positive integer');
  }
  return version;
}

export function valueAad(parts: VaultAadParts, kekId: string): Buffer {
  return Buffer.from(
    [
      VALUE_AAD_PREFIX,
      checkPart('itemId', parts.itemId),
      checkPart('ownerId', parts.ownerId),
      String(checkVersion(parts.version)),
      checkPart('kekId', kekId),
    ].join('|'),
    'utf8',
  );
}

export function dekAad(parts: VaultAadParts): Buffer {
  return Buffer.from(
    [
      DEK_AAD_PREFIX,
      checkPart('itemId', parts.itemId),
      checkPart('ownerId', parts.ownerId),
      String(checkVersion(parts.version)),
    ].join('|'),
    'utf8',
  );
}

/** What Postgres stores for one secret version. Contains no plaintext and no usable key. */
export interface EncryptedSecretVersion {
  suite: typeof VAULT_CIPHER_SUITE;
  kekId: string;
  wrappedDek: Buffer;
  nonce: Buffer;
  /** ciphertext || 16-byte GCM tag */
  ciphertext: Buffer;
}

export function sealWithKey(key: Buffer, plaintext: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  if (key.length !== DEK_BYTES) throw new VaultCryptoError('invalid_record', 'key must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function openWithKey(key: Buffer, nonce: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  if (key.length !== DEK_BYTES || nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) {
    throw new VaultCryptoError('invalid_record', 'malformed sealed value');
  }
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return openGcm(decipher, body);
  } catch {
    // One message for every failure: tampering, wrong AAD and wrong key look the same.
    throw new VaultCryptoError('decrypt_failed', 'sealed value failed authentication');
  }
}

/** Encrypts one secret version under a fresh DEK wrapped by `kms`. Disposes nothing it did not create. */
export async function encryptSecretVersion(
  kms: KmsProvider,
  plaintext: SecretMaterial,
  parts: VaultAadParts,
): Promise<EncryptedSecretVersion> {
  const dek = randomBytes(DEK_BYTES);
  try {
    const wrapped: WrappedDek = await kms.wrap(dek, dekAad(parts));
    const { nonce, ciphertext } = plaintext.use((bytes) => sealWithKey(dek, bytes, valueAad(parts, wrapped.kekId)));
    return { suite: VAULT_CIPHER_SUITE, kekId: wrapped.kekId, wrappedDek: wrapped.ciphertext, nonce, ciphertext };
  } finally {
    zeroize(dek);
  }
}

/** Decrypts one stored version. The caller owns (and must dispose) the result. */
export async function decryptSecretVersion(
  kms: KmsProvider,
  record: EncryptedSecretVersion,
  parts: VaultAadParts,
): Promise<SecretMaterial> {
  if (record.suite !== VAULT_CIPHER_SUITE) throw new VaultCryptoError('invalid_record', 'unknown cipher suite');
  const dek = await kms.unwrap({ kekId: record.kekId, ciphertext: record.wrappedDek }, dekAad(parts));
  try {
    return SecretMaterial.adopt(openWithKey(dek, record.nonce, record.ciphertext, valueAad(parts, record.kekId)));
  } finally {
    zeroize(dek);
  }
}

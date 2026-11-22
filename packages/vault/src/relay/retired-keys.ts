import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * The retired-key denylist (review F03; design doc 01a1fe13, section 4, checks R7 and B2).
 *
 * Every key a pre_review relay held is treated as exposed: agents ran as the relay's user and
 * could read it. At cutover the keys are rotated, and the fingerprints of the old ones go on this
 * list, on both sides. The relay refuses to load a signing key or a TLS client key that is on it
 * (R7). The broker refuses a relay public key that is on it (B2).
 *
 * A fingerprint is the SHA-256 of the key's public half as DER SubjectPublicKeyInfo. A private
 * key and its public key have the same fingerprint, and it is not secret:
 *
 *   openssl pkey -in relay.key -pubout -outform DER | sha256sum       (from a private key)
 *   openssl pkey -pubin -in relay.pub -outform DER | sha256sum        (from a public key)
 *
 * The list ships empty. Nothing in this repository generates, rotates or lists a deployed key.
 */
export const RETIRED_KEY_KNOB = 'TM8_VAULT_RETIRED_KEY_SHA256';
export const MAX_RETIRED_KEYS = 256;

const FINGERPRINT = /^(?:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})$/;
/** The longest entry is the colon form, 95 characters, plus a comma and some spaces. */
const MAX_LIST_CHARS = MAX_RETIRED_KEYS * 100;

/**
 * Comma-separated fingerprints, each 64 hex digits or 32 colon-separated pairs, as lowercase hex.
 * Unset or blank is the empty list. Anything else returns null, including an empty entry and more
 * than MAX_RETIRED_KEYS entries, so a typo never shortens the list without a refusal.
 */
export function parseRetiredKeys(value: string | undefined): ReadonlySet<string> | null {
  const text = value?.trim() ?? '';
  if (text === '') return new Set();
  if (text.length > MAX_LIST_CHARS) return null;
  const entries = text.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_RETIRED_KEYS || entries.some((entry) => !FINGERPRINT.test(entry))) return null;
  return new Set(entries.map((entry) => entry.replaceAll(':', '').toLowerCase()));
}

/** The SHA-256 of an asymmetric key's public half as DER SubjectPublicKeyInfo, in lowercase hex. */
export function publicKeySha256(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

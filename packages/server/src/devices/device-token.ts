/**
 * A phone's push token at rest (migration 392, `public.devices`; TM8 Mobile
 * s-lld §11 registration).
 *
 * A push token is a credential: whoever holds it can make the relay put a
 * notification on that phone. So it is stored the way every member credential
 * is (093, 203): AES-256-GCM under the node key at `<dataDir>/.git-credential.key`
 * (`credential-key.ts`), never as text, never in a column `tm8_app` may select,
 * and never in a log line, an error message or a command-ledger result.
 *
 * THE BINDING LIVES HERE. The AAD is `push-device|<identity_id>|<token_hash>`
 * (`DeviceTokenSecretBinding` in secret-box.ts). `devices.register` and
 * `devices.update` seal with `sealDeviceToken`. The push dispatcher opens with
 * `openDeviceToken`, and deletes a token the relay reports dead
 * `WHERE id = $1 AND token_hash = $2` with `deviceTokenHash(reported)`, so a token
 * rotated since the report is never deleted by it.
 */
import { createHash } from 'node:crypto';

import { openSecret, sealSecret } from '../credentials/secret-box.js';

/** The three `public.devices` columns that carry the token. */
export interface SealedDeviceToken {
  /** Hex sha256 of the token: `devices.token_hash`. */
  readonly tokenHash: string;
  /** ciphertext || authentication tag: `devices.token_ciphertext`. */
  readonly ciphertext: Buffer;
  /** `devices.token_nonce`. */
  readonly nonce: Buffer;
}

/** Hex sha256 of `token`, the value `devices.token_hash` holds. */
export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Seal `token` for the device row of `identityId`. */
export function sealDeviceToken(key: Buffer, identityId: string, token: string): SealedDeviceToken {
  const tokenHash = deviceTokenHash(token);
  const sealed = sealSecret(key, token, { identityId, tokenHash });
  return { tokenHash, ciphertext: sealed.ciphertext, nonce: sealed.nonce };
}

/**
 * Open a stored token. Throws when the row was moved to another identity, when
 * its hash was changed, or when the bytes were tampered with. The error never
 * carries the token.
 */
export function openDeviceToken(key: Buffer, identityId: string, sealed: SealedDeviceToken): string {
  const token = openSecret(
    key,
    { ciphertext: sealed.ciphertext, nonce: sealed.nonce },
    { identityId, tokenHash: sealed.tokenHash },
  );
  // The tag proves which hash the sealer bound; re-deriving it proves the sealer
  // bound the right one, so a reader can trust `token_hash` without trusting
  // whoever wrote the row.
  if (deviceTokenHash(token) !== sealed.tokenHash) {
    throw new Error('stored device token does not match its hash');
  }
  return token;
}

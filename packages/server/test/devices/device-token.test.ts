/**
 * The push-token box (migration 392, `devices/device-token.ts`), without a
 * database: what a stored token is bound to, and that nothing it throws
 * carries the token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { bindingAad, SECRET_KEY_BYTES } from '../../src/credentials/secret-box.js';
import { deviceTokenHash, openDeviceToken, sealDeviceToken } from '../../src/devices/device-token.js';

const key = randomBytes(SECRET_KEY_BYTES);
const TOKEN = 'ExponentPushToken[S1devicetokenAAAAAAAAA1]';
const ANA = 'identity-ana';
const BEN = 'identity-ben';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error('expected a throw');
}

describe('device token box', () => {
  it('hashes with sha256 hex and round-trips under the same identity', () => {
    expect(deviceTokenHash(TOKEN)).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    const sealed = sealDeviceToken(key, ANA, TOKEN);
    expect(sealed.tokenHash).toBe(deviceTokenHash(TOKEN));
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN))).toBe(false);
    expect(openDeviceToken(key, ANA, sealed)).toBe(TOKEN);
  });

  it('seals with a fresh nonce every time, so equal tokens never share ciphertext', () => {
    const a = sealDeviceToken(key, ANA, TOKEN);
    const b = sealDeviceToken(key, ANA, TOKEN);
    expect(a.tokenHash).toBe(b.tokenHash);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('does not open on another identity, another hash, another key or tampered bytes', () => {
    const sealed = sealDeviceToken(key, ANA, TOKEN);
    const other = sealDeviceToken(key, ANA, 'ExponentPushToken[S1devicetokenBBBBBBBBB2]');
    expect(() => openDeviceToken(key, BEN, sealed)).toThrow();
    expect(() => openDeviceToken(key, ANA, { ...sealed, tokenHash: other.tokenHash })).toThrow();
    expect(() => openDeviceToken(randomBytes(SECRET_KEY_BYTES), ANA, sealed)).toThrow();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => openDeviceToken(key, ANA, { ...sealed, ciphertext: flipped })).toThrow();
  });

  it('never puts the token in an error', () => {
    const sealed = sealDeviceToken(key, ANA, TOKEN);
    for (const message of [
      messageOf(() => openDeviceToken(key, BEN, sealed)),
      messageOf(() => openDeviceToken(randomBytes(SECRET_KEY_BYTES), ANA, sealed)),
    ]) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('S1devicetoken');
    }
  });

  it('has a prefixed AAD that collides with no other secret-box form', () => {
    const hash = deviceTokenHash(TOKEN);
    const aad = bindingAad({ identityId: ANA, tokenHash: hash });
    expect(aad).toBe(`push-device|${ANA}|${hash}`);
    // Two separators, like the space form: the prefix is what keeps them apart.
    expect(aad).not.toBe(bindingAad({ spaceId: ANA, credentialId: hash, provider: 'x' }));
    expect(aad).not.toBe(bindingAad({ accountId: ANA, provider: hash }));
    expect(() => bindingAad({ identityId: 'a|b', tokenHash: hash })).toThrow(/identity id/);
    expect(() => bindingAad({ identityId: ANA, tokenHash: 'not-a-hash' })).toThrow(/token hash/);
  });
});

import { VAULT_MAX_CAPTURE_CIPHERTEXT, VAULT_MAX_IMPORT_CIPHERTEXT } from './contract.js';
import type { CapturePublicKey, SealedCapture } from './contract.js';
import { base64url, unbase64url } from './encoding.js';
import type { Bytes } from './encoding.js';
import { PageError } from './errors.js';

export const CAPTURE_SCHEME = 'tm8-vault-capture-v1';

/** Caller owns plaintext and MUST clear it in finally, including seal failures. */
export async function webCryptoSeal(
  plaintext: Bytes,
  recipient: CapturePublicKey,
  bindingId: string,
  crypto: Crypto = globalThis.crypto,
  maxCiphertextBytes = VAULT_MAX_CAPTURE_CIPHERTEXT,
): Promise<SealedCapture> {
  let shared: Bytes | undefined;
  try {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(bindingId) || !/^[0-9a-f]{32}$/.test(recipient.kid)) throw new PageError('invalid_key');
    if (!Number.isSafeInteger(maxCiphertextBytes) || maxCiphertextBytes < 17 || maxCiphertextBytes > VAULT_MAX_IMPORT_CIPHERTEXT || plaintext.length + 16 > maxCiphertextBytes) {
      throw new PageError('too_large');
    }
    const subtle = crypto.subtle;
    let publicKey: CryptoKey;
    if (recipient.jwk) {
      if (recipient.jwk.kty !== 'EC' || recipient.jwk.crv !== 'P-256' || Object.hasOwn(recipient.jwk, 'd')) throw new PageError('invalid_key');
      // Copy only public members, never an unexpected private coordinate.
      publicKey = await subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256', x: recipient.jwk.x, y: recipient.jwk.y, ext: true,
      }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    } else if (recipient.raw) {
      publicKey = await subtle.importKey('raw', unbase64url(recipient.raw, 65), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    } else { throw new PageError('invalid_key'); }
    const point = new Uint8Array(await subtle.exportKey('raw', publicKey));
    const digest = new Uint8Array(await subtle.digest('SHA-256', point));
    const kid = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (point.length !== 65 || point[0] !== 4 || kid !== recipient.kid || (recipient.raw !== undefined && base64url(point) !== recipient.raw)) throw new PageError('invalid_key');
    const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, ephemeral.privateKey, 256));
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    shared.fill(0);
    const encoder = new TextEncoder();
    const key = await subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: await subtle.digest('SHA-256', encoder.encode(kid)),
      info: encoder.encode(`${CAPTURE_SCHEME}|${bindingId}`),
    }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({
      name: 'AES-GCM', iv: nonce, tagLength: 128,
      additionalData: encoder.encode(`${CAPTURE_SCHEME}|${bindingId}|${kid}`),
    }, key, plaintext);
    return {
      v: 1, kid, epk: base64url(new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey))),
      nonce: base64url(nonce), ct: base64url(new Uint8Array(ct)),
    };
  } catch (error) {
    throw error instanceof PageError ? error : new PageError('invalid_key');
  } finally { shared?.fill(0); }
}

import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { openGcm } from '../crypto/gcm.js';
import { zeroize } from '../secret-material.js';

/**
 * Browser-to-broker sealing for capture and import (brief MSG 6, R1, R12).
 *
 * The capture page encrypts the secret IN THE OWNER'S BROWSER to a broker
 * public key. The tm8 server, its logs, its agents and any proxy only ever see
 * this envelope, never the value.
 *
 * Scheme (ECIES, every primitive available in WebCrypto):
 *   Z    = ECDH-P256(ephemeral_private, broker_public)          32-byte x coordinate
 *   key  = HKDF-SHA256(ikm = Z, salt = SHA-256(kid), info = "tm8-vault-capture-v1|" + captureId, 32 bytes)
 *   ct   = AES-256-GCM(key, nonce = 12 random bytes, aad = "tm8-vault-capture-v1|" + captureId + "|" + kid)
 *   kid  = first 32 hex chars of SHA-256(broker public point, 65-byte uncompressed)
 *
 * The broker key pair is generated in memory at broker start and never
 * persisted. A restart invalidates outstanding links, which then fail with
 * `unknown_kid` and are re-issued. The captureId inside the HKDF info and the
 * AAD binds an envelope to one capture link, so it cannot be replayed into
 * another one.
 */
export const CAPTURE_SCHEME = 'tm8-vault-capture-v1';
export const MAX_CAPTURE_CIPHERTEXT = 64 * 1024;
export const MAX_IMPORT_CIPHERTEXT = 8 * 1024 * 1024;

export interface SealedCapture {
  v: 1;
  kid: string;
  /** base64url of the 65-byte uncompressed ephemeral P-256 point */
  epk: string;
  /** base64url of the 12-byte GCM nonce */
  nonce: string;
  /** base64url of ciphertext || 16-byte tag */
  ct: string;
}

export interface CapturePublicKey {
  kid: string;
  /** For WebCrypto `importKey('jwk', ...)`. */
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; ext: true };
  /** base64url of the 65-byte uncompressed point */
  raw: string;
}

export class CaptureSealError extends Error {
  constructor(readonly code: 'malformed' | 'unknown_kid' | 'too_large' | 'decrypt_failed') {
    super(`sealed capture refused: ${code}`);
    this.name = 'CaptureSealError';
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function fromB64url(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || !B64URL.test(value)) throw new CaptureSealError('malformed');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new CaptureSealError('malformed');
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new CaptureSealError('malformed');
  return bytes;
}

export function captureKid(publicPoint: Buffer): string {
  return createHash('sha256').update(publicPoint).digest('hex').slice(0, 32);
}

function deriveKey(sharedSecret: Buffer, kid: string, captureId: string): Buffer {
  const salt = createHash('sha256').update(kid, 'utf8').digest();
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(`${CAPTURE_SCHEME}|${captureId}`, 'utf8'), 32));
}

function aadFor(kid: string, captureId: string): Buffer {
  return Buffer.from(`${CAPTURE_SCHEME}|${captureId}|${kid}`, 'utf8');
}

function checkCaptureId(captureId: string): void {
  if (typeof captureId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(captureId)) throw new CaptureSealError('malformed');
}

/** The broker's in-memory capture key pair. One per broker process. */
export class CaptureKeyPair {
  readonly kid: string;
  readonly publicPoint: Buffer;
  #ecdh: ECDH | null;

  private constructor(ecdh: ECDH) {
    this.#ecdh = ecdh;
    this.publicPoint = ecdh.getPublicKey();
    this.kid = captureKid(this.publicPoint);
  }

  static generate(): CaptureKeyPair {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return new CaptureKeyPair(ecdh);
  }

  publicKey(): CapturePublicKey {
    return {
      kid: this.kid,
      raw: this.publicPoint.toString('base64url'),
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: this.publicPoint.subarray(1, 33).toString('base64url'),
        y: this.publicPoint.subarray(33, 65).toString('base64url'),
        ext: true,
      },
    };
  }

  /** Decrypts an envelope. The caller takes ownership of the returned bytes and must zeroize them. */
  open(sealed: SealedCapture, captureId: string, maxCiphertext = MAX_CAPTURE_CIPHERTEXT): Buffer {
    if (this.#ecdh === null) throw new CaptureSealError('unknown_kid');
    checkCaptureId(captureId);
    if (sealed === null || typeof sealed !== 'object' || sealed.v !== 1) throw new CaptureSealError('malformed');
    if (sealed.kid !== this.kid) throw new CaptureSealError('unknown_kid');
    if (typeof sealed.ct !== 'string' || sealed.ct.length > Math.ceil((maxCiphertext * 4) / 3) + 4) {
      throw new CaptureSealError('too_large');
    }
    const epk = fromB64url(sealed.epk, 65);
    const nonce = fromB64url(sealed.nonce, 12);
    const ct = fromB64url(sealed.ct);
    if (ct.length < 17 || ct.length > maxCiphertext) throw new CaptureSealError(ct.length > maxCiphertext ? 'too_large' : 'malformed');
    if (epk[0] !== 0x04) throw new CaptureSealError('malformed');
    let shared: Buffer;
    try {
      shared = this.#ecdh.computeSecret(epk); // throws on a point that is not on the curve
    } catch {
      throw new CaptureSealError('malformed');
    }
    const key = deriveKey(shared, this.kid, captureId);
    zeroize(shared);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(aadFor(this.kid, captureId));
      decipher.setAuthTag(ct.subarray(ct.length - 16));
      return openGcm(decipher, ct.subarray(0, ct.length - 16));
    } catch {
      throw new CaptureSealError('decrypt_failed');
    } finally {
      zeroize(key);
    }
  }

  /** Forgets the private key. Every envelope sealed to this kid becomes undecryptable. */
  destroy(): void {
    this.#ecdh = null;
  }
}

/**
 * Reference sealer in Node. The capture page implements the same steps with
 * WebCrypto. Tests use this one to prove that the two agree byte for byte in
 * format, and to produce test vectors.
 */
export function sealCapture(plaintext: Buffer, recipient: { kid: string; raw: string }, captureId: string): SealedCapture {
  checkCaptureId(captureId);
  const recipientPoint = fromB64url(recipient.raw, 65);
  if (captureKid(recipientPoint) !== recipient.kid) throw new CaptureSealError('unknown_kid');
  const eph = createECDH('prime256v1');
  eph.generateKeys();
  const shared = eph.computeSecret(recipientPoint);
  const key = deriveKey(shared, recipient.kid, captureId);
  zeroize(shared);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aadFor(recipient.kid, captureId));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { v: 1, kid: recipient.kid, epk: eph.getPublicKey().toString('base64url'), nonce: nonce.toString('base64url'), ct: ct.toString('base64url') };
  } finally {
    zeroize(key);
  }
}

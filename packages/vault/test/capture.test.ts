import { describe, expect, it } from 'vitest';
import {
  CaptureKeyPair,
  CapturePayloadError,
  CaptureSealError,
  parseCapturePayload,
  sealCapture,
  type CapturePublicKey,
  type SealedCapture,
} from '../src/index.js';

const CANARY = 'tm8-canary-pw-91c2';
const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

/** The capture page's algorithm, written against WebCrypto only. WS-D ports this verbatim. */
async function webCryptoSeal(plaintext: Uint8Array, pub: CapturePublicKey, captureId: string): Promise<SealedCapture> {
  const subtle = globalThis.crypto.subtle;
  const brokerKey = await subtle.importKey('jwk', pub.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const z = await subtle.deriveBits({ name: 'ECDH', public: brokerKey }, eph.privateKey, 256);
  const salt = await subtle.digest('SHA-256', enc.encode(pub.kid));
  const ikm = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`tm8-vault-capture-v1|${captureId}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(`tm8-vault-capture-v1|${captureId}|${pub.kid}`), tagLength: 128 },
    key,
    // A copy backed by a plain ArrayBuffer: WebCrypto's BufferSource type refuses a SharedArrayBuffer view.
    new Uint8Array(plaintext),
  );
  return { v: 1, kid: pub.kid, epk: b64url(await subtle.exportKey('raw', eph.publicKey)), nonce: b64url(nonce), ct: b64url(ct) };
}

const login = (extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ type: 'login', name: 'GitHub', origin: 'https://github.com', username: 'octo', password: CANARY, ...extra }));

describe('capture sealing (MSG 6)', () => {
  it('opens what the WebCrypto capture page seals', async () => {
    const broker = CaptureKeyPair.generate();
    const sealed = await webCryptoSeal(login(), broker.publicKey(), 'cap_0123456789');
    const opened = broker.open(sealed, 'cap_0123456789');
    expect(JSON.parse(opened.toString('utf8')).password).toBe(CANARY);
  });

  it('opens what the Node reference seals', () => {
    const broker = CaptureKeyPair.generate();
    const sealed = sealCapture(login(), broker.publicKey(), 'cap_0123456789');
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(broker.open(sealed, 'cap_0123456789').toString('utf8')).toContain(CANARY);
  });

  it('binds an envelope to its capture link', () => {
    const broker = CaptureKeyPair.generate();
    const sealed = sealCapture(login(), broker.publicKey(), 'cap_0123456789');
    expect(() => broker.open(sealed, 'cap_9999999999')).toThrow(CaptureSealError);
  });

  it('refuses another broker key, a restarted broker and tampering', () => {
    const broker = CaptureKeyPair.generate();
    const other = CaptureKeyPair.generate();
    const sealed = sealCapture(login(), broker.publicKey(), 'cap_0123456789');
    expect(() => other.open(sealed, 'cap_0123456789')).toThrow(/unknown_kid/);
    const flipped = Buffer.from(sealed.ct, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(() => broker.open({ ...sealed, ct: flipped.toString('base64url') }, 'cap_0123456789')).toThrow(/decrypt_failed/);
    broker.destroy();
    expect(() => broker.open(sealed, 'cap_0123456789')).toThrow(/unknown_kid/);
  });

  it('refuses malformed points, encodings and oversized envelopes', () => {
    const broker = CaptureKeyPair.generate();
    const sealed = sealCapture(login(), broker.publicKey(), 'cap_0123456789');
    const offCurve = Buffer.alloc(65, 7);
    offCurve[0] = 4;
    expect(() => broker.open({ ...sealed, epk: offCurve.toString('base64url') }, 'cap_0123456789')).toThrow(/malformed/);
    expect(() => broker.open({ ...sealed, nonce: 'AA==' }, 'cap_0123456789')).toThrow(/malformed/);
    expect(() => broker.open({ ...sealed, ct: 'A'.repeat(100_000) }, 'cap_0123456789')).toThrow(/too_large/);
    expect(() => broker.open({ ...sealed, v: 2 } as unknown as SealedCapture, 'cap_0123456789')).toThrow(/malformed/);
  });
});

describe('capture payload (R1, R9)', () => {
  it('splits a login into metadata and secret', () => {
    const parsed = parseCapturePayload(login(), 'login');
    expect(parsed.metadata).toEqual({ type: 'login', name: 'GitHub', origin: 'https://github.com', username: 'octo', hasTotp: false });
    expect(JSON.stringify(parsed.metadata)).not.toContain(CANARY);
    expect(JSON.parse(parsed.secret.utf8())).toEqual({ password: CANARY });
  });

  it('keeps login notes in the secret part only', () => {
    const notes = `recovery ${CANARY}`;
    const body = { type: 'login', name: 'GitHub', origin: 'https://github.com', password: 'pw-value-1', notes };
    const parsed = parseCapturePayload(Buffer.from(JSON.stringify(body)), 'login');
    expect(parsed.metadata.hasNotes).toBe(true);
    expect(JSON.stringify(parsed.metadata)).not.toContain(CANARY);
    expect(JSON.parse(parsed.secret.utf8())).toEqual({ password: 'pw-value-1', notes });
    parsed.secret.dispose();
    expect(() => parseCapturePayload(Buffer.from(JSON.stringify({ ...body, notes: '' })), 'login')).toThrow(/invalid_payload/);
  });

  it.each(['cvv', 'CVC', 'cvv2', 'security_code', 'securityCode', 'card-verification-value'])('refuses a card with %s', (key) => {
    const card = { type: 'card', name: 'Visa', pan: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, [key]: '123' };
    const error = (() => {
      try {
        parseCapturePayload(Buffer.from(JSON.stringify(card)), 'card');
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CapturePayloadError);
    expect((error as CapturePayloadError).code).toBe('cvv_refused');
  });

  it('stops checking a payload of thousands of bad identity fields at its issue budget (review addendum 2, C4)', () => {
    const refusal = (fields: Record<string, string>) => {
      try {
        parseCapturePayload(Buffer.from(JSON.stringify({ type: 'identity', name: 'Synthetic', fields })), 'identity');
      } catch (e) {
        return e as CapturePayloadError;
      }
      return undefined;
    };
    const many = refusal(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`!${index}`, 'x'])));
    expect(many?.code).toBe('invalid_payload');
    expect(many?.detail).toBe('more than 32 issues');
    // Within the budget the detail still names each issue, by path and code only.
    const few = refusal({ '!a': 'x', '!b': 'y' });
    expect(few?.code).toBe('invalid_payload');
    expect(few?.detail).toBe('fields.!a:invalid_string,fields.!b:invalid_string');
  });

  it('keeps card metadata to last 4 and expiry', () => {
    const card = { type: 'card', name: 'Visa', pan: '4242-4242-4242-4242', expMonth: 12, expYear: 2030 };
    const parsed = parseCapturePayload(Buffer.from(JSON.stringify(card)), 'card');
    expect(parsed.metadata).toEqual({ type: 'card', name: 'Visa', last4: '4242', expMonth: 12, expYear: 2030 });
  });

  it('refuses a bad Luhn, a type mismatch and an unsafe origin without echoing values', () => {
    const bad = { type: 'card', name: 'X', pan: '4242424242424241', expMonth: 1, expYear: 2030 };
    const e1 = (() => { try { parseCapturePayload(Buffer.from(JSON.stringify(bad)), 'card'); } catch (e) { return e as CapturePayloadError; } })();
    expect(e1?.code).toBe('invalid_payload');
    expect(e1?.detail).not.toContain('4242');
    expect(() => parseCapturePayload(login(), 'api_key')).toThrow(/type_mismatch/);
    const e2 = (() => { try { parseCapturePayload(login({ origin: 'http://github.com' }), 'login'); } catch (e) { return e as CapturePayloadError; } })();
    expect(e2?.code).toBe('origin_refused');
    expect(e2?.detail).toBe('scheme_not_https');
  });

  it('refuses unknown fields', () => {
    expect(() => parseCapturePayload(login({ note: 'x' }), 'login')).toThrow(/invalid_payload/);
  });
});

import { randomUUID, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CaptureKeyPair } from '../../src/capture/seal.js';
import { parseCapturePayload } from '../../src/capture/payload.js';
import { webCryptoSeal } from '../src/seal.js';
import { PageError } from '../src/errors.js';
import { base64url, unbase64url } from '../src/encoding.js';
import type { ItemType } from '../src/contract.js';
import { payloadFixture } from './fixtures.js';

const crypto = webcrypto as unknown as Crypto;

describe('WebCrypto / broker interop under Node 22', () => {
  it.each(['login', 'api_key', 'card', 'note', 'identity'] as const)('opens and parses a %s payload', async (type: ItemType) => {
    const broker = CaptureKeyPair.generate();
    const bytes = new TextEncoder().encode(JSON.stringify(payloadFixture(type)));
    let opened: Buffer | undefined;
    try {
      const id = randomUUID();
      const sealed = await webCryptoSeal(bytes, broker.publicKey(), id, crypto);
      opened = broker.open(sealed, id);
      expect(opened.equals(Buffer.from(bytes))).toBe(true);
      const parsed = parseCapturePayload(opened, type);
      try { expect(parsed.metadata.type).toBe(type); } finally { parsed.secret.dispose(); }
      expect(sealed.epk).toHaveLength(87);
      expect(sealed.nonce).toHaveLength(16);
    } finally { bytes.fill(0); opened?.fill(0); broker.destroy(); }
  });

  it.each(['raw', 'jwk'] as const)('supports a recipient represented by %s alone', async (representation) => {
    const broker = CaptureKeyPair.generate();
    const publicKey = broker.publicKey();
    const bytes = new TextEncoder().encode('synthetic interop fixture');
    const id = randomUUID();
    try {
      const sealed = await webCryptoSeal(bytes, { kid: publicKey.kid, [representation]: publicKey[representation] }, id, crypto);
      const opened = broker.open(sealed, id);
      try { expect(opened.equals(Buffer.from(bytes))).toBe(true); } finally { opened.fill(0); }
    } finally { bytes.fill(0); broker.destroy(); }
  });

  it.each(['kid', 'binding', 'nonce', 'ct', 'epk'] as const)('rejects tampering with %s', async (part) => {
    const broker = CaptureKeyPair.generate();
    const bytes = new TextEncoder().encode('synthetic tamper fixture');
    const id = randomUUID();
    try {
      const sealed = await webCryptoSeal(bytes, broker.publicKey(), id, crypto);
      if (part === 'kid') sealed.kid = '0'.repeat(32);
      else if (part !== 'binding') {
        const value = unbase64url(sealed[part]); value[value.length - 1] = (value[value.length - 1] ?? 0) ^ 1;
        sealed[part] = base64url(value);
      }
      expect(() => broker.open(sealed, part === 'binding' ? randomUUID() : id)).toThrow();
    } finally { bytes.fill(0); broker.destroy(); }
  });

  it('refuses a mismatched kid, inconsistent public encodings and a private JWK', async () => {
    const broker = CaptureKeyPair.generate();
    const other = CaptureKeyPair.generate();
    const bytes = new TextEncoder().encode('synthetic verification fixture');
    const id = randomUUID();
    try {
      await expect(webCryptoSeal(bytes, { ...broker.publicKey(), kid: '0'.repeat(32) }, id, crypto)).rejects.toEqual(new PageError('invalid_key'));
      await expect(webCryptoSeal(bytes, { ...broker.publicKey(), raw: other.publicKey().raw }, id, crypto)).rejects.toEqual(new PageError('invalid_key'));
      const key = broker.publicKey();
      await expect(webCryptoSeal(bytes, { ...key, jwk: { ...key.jwk, d: base64url(new Uint8Array(32)) } } as typeof key, id, crypto)).rejects.toEqual(new PageError('invalid_key'));
    } finally { bytes.fill(0); broker.destroy(); other.destroy(); }
  });

  it('counts the 16-byte tag against the ciphertext cap', async () => {
    const broker = CaptureKeyPair.generate();
    try {
      const bytes = new Uint8Array(32);
      await expect(webCryptoSeal(bytes, broker.publicKey(), randomUUID(), crypto, 47)).rejects.toEqual(new PageError('too_large'));
      const id = randomUUID();
      const sealed = await webCryptoSeal(bytes, broker.publicKey(), id, crypto, 48);
      expect(unbase64url(sealed.ct).length).toBe(48);
    } finally { broker.destroy(); }
  });

  it('uses the import id as the cryptographic binding', async () => {
    const broker = CaptureKeyPair.generate();
    const bytes = new TextEncoder().encode('synthetic export bytes');
    const importId = randomUUID();
    try {
      const sealed = await webCryptoSeal(bytes, broker.publicKey(), importId, crypto, 8 * 1024 * 1024);
      const opened = broker.open(sealed, importId, 8 * 1024 * 1024);
      try { expect(opened.equals(Buffer.from(bytes))).toBe(true); } finally { opened.fill(0); }
      expect(() => broker.open(sealed, randomUUID())).toThrow();
    } finally { bytes.fill(0); broker.destroy(); }
  });
});

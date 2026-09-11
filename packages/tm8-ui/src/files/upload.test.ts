/**
 * THE UPLOAD'S FIRST STEP, and the message it leaves behind when it fails.
 *
 * Both halves of the attachment bug are asserted here: the checksum must still
 * be computed where `crypto.subtle` does not exist (the failure that produced
 * "Upload failed. Try again." on two chips with nothing in the node's log),
 * and the reason a caller shows must name what actually happened.
 */
import { describe, expect, it } from 'vitest';

import { randomMutationId, sha256Hex, safeUploadReason, UploadCancelledError } from './upload';
import { sha256HexOfBytes } from './sha256';

/** The three FIPS 180-4 fixtures, so the fallback is checked against the
 *  published vectors and not merely against WebCrypto agreeing with itself. */
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sha256HexOfBytes', () => {
  it.each(VECTORS)('matches the published digest for %j', (input, digest) => {
    expect(sha256HexOfBytes(bytesOf(input))).toBe(digest);
  });

  it('matches WebCrypto across block boundaries', async () => {
    // 55/56/64/119/120 are the lengths where the padding block count changes —
    // the only place a hand-written padding routine goes wrong.
    for (const length of [55, 56, 63, 64, 65, 119, 120, 200]) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => (index * 37) % 256);
      const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = [...expected].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(sha256HexOfBytes(bytes)).toBe(hex);
    }
  });
});

describe('sha256Hex', () => {
  it('uses WebCrypto when it is there', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(VECTORS[1]![1]);
  });

  it('still answers when crypto.subtle is absent — the non-secure-origin case', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try {
      expect(await sha256Hex(new Blob(['abc']))).toBe(VECTORS[1]![1]);
    } finally {
      if (real) Object.defineProperty(globalThis.crypto, 'subtle', real);
    }
  });
});

describe('safeUploadReason', () => {
  it('names a cancellation', () => {
    expect(safeUploadReason(new UploadCancelledError())).toBe('Upload cancelled.');
  });

  it('names the codes this path raises instead of the generic failure', () => {
    expect(safeUploadReason(Object.assign(new Error('x'), { code: 'payload_too_large' })))
      .toBe('This file is larger than the allowed upload size.');
    expect(safeUploadReason(Object.assign(new Error('x'), { code: 'not_found' })))
      .toBe('What this file was being attached to no longer exists.');
    expect(safeUploadReason(Object.assign(new Error('x'), { code: 'not_implemented' })))
      .toBe('This node does not support file uploads.');
  });

  it('promises a retry only when the error says one is possible', () => {
    expect(safeUploadReason(Object.assign(new Error('x'), { code: 'forbidden', retryable: false })))
      .toBe('You do not have permission to upload this file.');
    expect(safeUploadReason(
      Object.assign(new Error('x'), { code: 'upstream_unavailable', retryable: true }),
    )).toBe('The node could not be reached. Try again.');
    expect(safeUploadReason(Object.assign(new Error('x'), { retryable: false })))
      .toBe('Upload failed.');
  });

  it('never surfaces server prose or a transport path', () => {
    expect(safeUploadReason(new Error('s3://private-bucket/token')))
      .toBe('Upload failed. Try again.');
  });
});

describe('randomMutationId', () => {
  it('uses crypto.randomUUID when the context grants it', () => {
    expect(randomMutationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('still returns a unique id when crypto.randomUUID is absent', () => {
    // The measured non-secure-origin condition: `randomUUID` is secure-context
    // gated exactly as `subtle` is, and an unguarded call threw a TypeError on
    // every upload before the first request.
    const real = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 200 }, () => randomMutationId()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id.length).toBeGreaterThan(8);
    } finally {
      if (real) Object.defineProperty(globalThis.crypto, 'randomUUID', real);
    }
  });
});

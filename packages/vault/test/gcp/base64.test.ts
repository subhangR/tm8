import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64Bytes, GcpTransportError } from '../../src/gcp/http.js';

/** The standard alphabet, as Node's own encoder writes the 64 six-bit values 0..63 in order. */
const ALPHABET = Buffer.from(Array.from({ length: 48 }, (_, byte) => {
  let value = 0;
  for (let bit = byte * 8; bit < byte * 8 + 8; bit++) value = (value << 1) | ((Math.floor(bit / 6) >> (5 - (bit % 6))) & 1);
  return value;
})).toString('base64');

/** The rule decodeBase64 enforced before review F05, by re-encoding the decoded bytes. */
function reencodeAccepts(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function accepts(value: unknown): boolean {
  try { decodeBase64(value); return true; }
  catch (error) {
    if (!(error instanceof GcpTransportError)) throw error;
    return false;
  }
}

describe('strict base64 (review F05)', () => {
  it('accepts exactly what the re-encoding check accepted, over every possible final group', () => {
    let accepted = 0;
    for (const a of ALPHABET) for (const b of ALPHABET) {
      for (const value of [`QUJD${a}${b}==`, ...Array.from(ALPHABET, (c) => `QUJD${a}${b}${c}=`)]) {
        const expected = reencodeAccepts(value);
        if (accepts(value) !== expected) throw new Error(`decodeBase64 disagrees with the re-encoding rule on ${value}`);
        if (expected) accepted += 1;
      }
    }
    // 64 * 4 canonical two-character groups and 64 * 64 * 16 canonical three-character groups.
    expect(accepted).toBe(64 * 4 + 64 * 64 * 16);
  });

  it('round-trips random bytes and matches the runtime encoder byte for byte', () => {
    for (let length = 0; length <= 96; length += 1) {
      const bytes = randomBytes(length);
      const encoded = encodeBase64Bytes(bytes);
      expect(encoded.toString('latin1')).toBe(bytes.toString('base64'));
      expect(decodeBase64(bytes.toString('base64'))).toEqual(bytes);
    }
  });

  it('refuses non-strings, other alphabets, whitespace and bad padding', () => {
    for (const value of [undefined, null, 42, ['QUJD'], 'QUJD-_==', 'QU JD', 'QUJD\n', 'QUJ', 'QUJDRA', 'QUJDRA=', 'QUJDR===', '=QUJD']) {
      expect(accepts(value)).toBe(false);
    }
    expect(accepts('')).toBe(true);
  });

  it('checks the text, so the decoded bytes are never turned back into a string', () => {
    const value = Buffer.from('test-only-bytes!');
    const text = value.toString('base64');
    const toString = vi.spyOn(Buffer.prototype, 'toString');
    let decoded: Buffer;
    let calls: number;
    try {
      decoded = decodeBase64(text);
      calls = toString.mock.calls.length;
    } finally {
      toString.mockRestore();
    }
    expect(calls).toBe(0);
    expect(decoded).toEqual(value);
  });
});

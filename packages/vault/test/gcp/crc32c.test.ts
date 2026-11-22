import { describe, expect, it } from 'vitest';
import { crc32c, matchesCrc32c } from '../../src/gcp/crc32c.js';

describe('CRC32C Castagnoli', () => {
  // RFC 3720 B.4 lists the checksum bytes in little-endian wire order.
  // https://www.rfc-editor.org/rfc/rfc3720#appendix-B.4
  it.each([
    [Buffer.alloc(32), 0x8a9136aa],
    [Buffer.alloc(32, 0xff), 0x62a8ab43],
    [Buffer.from(Array.from({ length: 32 }, (_, i) => i)), 0x46dd794e],
    [Buffer.from(Array.from({ length: 32 }, (_, i) => 31 - i)), 0x113fdb5c],
    [Buffer.from('01c000000000000000000000000000001400000000000400000000140000001828000000000000000200000000000000', 'hex'), 0xd9963a56],
    [Buffer.from('123456789'), 0xe3069283],
    [Buffer.alloc(0), 0],
  ])('matches independent vector %#', (bytes, expected) => {
    expect(crc32c(bytes)).toBe(expected);
  });

  it('checks only uint32 decimal CRC fields', () => {
    const bytes = Buffer.from('123456789');
    expect(matchesCrc32c(bytes, 0xe3069283)).toBe(true);
    expect(matchesCrc32c(bytes, String(0xe3069283))).toBe(true);
    for (const invalid of [undefined, null, true, {}, [], '', '1e3', -1, 0x100000000, NaN, Infinity, '4294967296']) {
      expect(matchesCrc32c(bytes, invalid)).toBe(false);
    }
    expect(matchesCrc32c(Buffer.alloc(0), null)).toBe(false);
  });
});

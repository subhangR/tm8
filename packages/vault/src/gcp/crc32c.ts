/** Reflected Castagnoli polynomial, initial/final XOR of all ones (RFC 3720 B.4). */
const TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  return crc >>> 0;
});

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** REST int64 wrappers can be decimal strings or JSON numbers. Never coerce null/booleans. */
export function matchesCrc32c(bytes: Uint8Array, value: unknown): boolean {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,10}$/.test(value))) return false;
  const checksum = Number(value);
  return Number.isInteger(checksum) && checksum >= 0 && checksum <= 0xffffffff && checksum === crc32c(bytes);
}

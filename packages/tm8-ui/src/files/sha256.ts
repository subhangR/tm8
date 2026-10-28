/**
 * SHA-256 IN PLAIN TYPESCRIPT — the fallback for when `crypto.subtle` is not
 * there.
 *
 * WHY THIS EXISTS AT ALL, given every browser we support ships WebCrypto.
 * `crypto.subtle` is exposed ONLY in a secure context. `https://…`,
 * `http://localhost` and `http://127.0.0.1` are secure; `http://<hostname>` and
 * `http://<lan-ip>` are not — and those are supported ways to reach a tm8 node
 * (`TM8_ALLOWED_HOSTNAMES`, `TM8_BIND`). On such an origin `crypto.subtle` is
 * `undefined`, so the FIRST step of every upload threw before a single request
 * was made: no bytes on the wire, nothing in the node's log, and two chips
 * reading "Upload failed. Try again." — a retry that could never succeed.
 *
 * The checksum is not optional and cannot be skipped: `files.uploadInit` binds
 * `checksumSha256` in the contract and the node verifies the staged bytes
 * against it. So the choice was "compute it another way" or "lose file upload
 * on a deployment shape the server explicitly supports". This is the first.
 *
 * It is the FALLBACK, never the default — `upload.ts` reaches for WebCrypto
 * first and only lands here when there is none. On the paths that matter
 * (localhost, https) not a line of this runs.
 *
 * FIPS 180-4, the textbook construction, deliberately unclever: `>>> 0` after
 * every add keeps the words unsigned in a language whose bitwise operators are
 * signed, and the message schedule is a flat 64-entry array because a rolling
 * 16-word window saves 192 bytes and costs the reader the one thing that makes
 * this auditable — looking like the spec.
 */

/** FIPS 180-4 §4.2.2 — the first 32 bits of the fractional parts of the cube
 *  roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** §5.3.3 — the first 32 bits of the fractional parts of the square roots of
 *  the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

/** The padded message: the bytes, a `0x80`, zeroes, and the 64-bit bit length
 *  (§5.1.1). The length is written as two 32-bit halves because a JS bitwise
 *  op would truncate a 64-bit value, and `Math.floor(bits / 2**32)` is exact
 *  for every length a Blob can have. */
function padded(bytes: Uint8Array): Uint8Array {
  const blocks = Math.floor((bytes.length + 8) / 64) + 1;
  const out = new Uint8Array(blocks * 64);
  out.set(bytes);
  out[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(out.length - 4, bits >>> 0, false);
  return out;
}

/** Lowercase hex, the spelling `SHA256_HEX_RE` in the contract accepts. */
function hex(words: Uint32Array): string {
  let out = '';
  for (const word of words) out += word.toString(16).padStart(8, '0');
  return out;
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
  const message = padded(bytes);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let block = 0; block < message.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return hex(h);
}

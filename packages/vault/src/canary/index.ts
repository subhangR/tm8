import { randomBytes } from 'node:crypto';
import type { CanarySet } from '../types.js';
import { DECODINGS, compileMatcher, decodedView, decodingApplies, encodedPatterns } from './encodings.js';

/** Fresh decoys only: none of these values belongs to an account or a card. */
export function mintCanary(kind: 'api_key' | 'password' | 'card'): string {
  const bytes = randomBytes(32);
  try {
    if (kind === 'api_key') return ['sk', bytes.toString('base64url')].join('-');
    if (kind === 'password') return `${bytes.toString('base64url')}!aA7`;
    if (kind !== 'card') throw new Error('invalid canary kind');
    const digits = [4, ...Array.from(bytes.subarray(0, 14), (byte) => byte % 10)];
    const sum = digits.reduce((total, digit, i) => {
      const weighted = i % 2 === 0 ? digit * 2 : digit;
      return total + (weighted > 9 ? weighted - 9 : weighted);
    }, 0);
    return [...digits, (10 - sum % 10) % 10].join('');
  } finally { bytes.fill(0); }
}

/**
 * O(n) matching for n input bytes, including the fixed decoding views; no regex
 * alternation, repeated per-canary scan, decoding loop or unbounded backtrack.
 * The precompiled Aho-Corasick automaton takes O(p) space for p pattern bytes.
 * Only fully known sextets are matched at offsets 0, 1 and 2 in a base64 stream,
 * so arbitrary bytes on either side do not hide a decoy. Decoys must be >=12
 * characters to keep these partial-alignment patterns usefully selective.
 * The decoded views are of the UTF-8 text. A body or URL is valid UTF-8: the response filter
 * withholds anything else as binary before it gets here. A header value can also arrive as the
 * Latin-1 bytes Node sends (headerMatches); where those are not valid UTF-8, the views read
 * U+FFFD for each invalid sequence, as a UTF-8 receiver does, and the raw check reads the bytes.
 */
export function buildCanarySet(values: readonly string[]): CanarySet {
  const unique = [...new Set(values)];
  if (unique.some((value) => typeof value !== 'string' || value.length < 12)) {
    throw new Error('canary values must contain at least 12 characters');
  }
  const patterns = unique.flatMap(encodedPatterns).map((pattern) => ({
    text: Buffer.from(pattern.text, 'utf8').toString('latin1'),
  }));
  const matcher = compileMatcher(patterns);
  return Object.freeze({
    size: unique.length,
    matches(data: string | Buffer): boolean {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      if (matcher.has(bytes.toString('latin1'))) return true;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      for (const encoding of DECODINGS) {
        if (!decodingApplies(text, encoding)) continue;
        if (matcher.has(Buffer.from(decodedView(text, encoding).text, 'utf8').toString('latin1'))) return true;
      }
      return false;
    },
  });
}

/**
 * A header value, read both ways a receiver may read it. Node writes each code unit of a header
 * value as one Latin-1 byte, so `\u00c3\u00a9` goes out as the bytes C3 A9, which a receiver that
 * reads header bytes as UTF-8 takes as `é` (review F02 follow-up, task 01a1fe78). The response
 * side is the same: Node reads an upstream header's bytes back as Latin-1 text.
 */
export function headerMatches(canaries: CanarySet, value: string): boolean {
  return canaries.matches(value) || (/[^\x00-\x7f]/.test(value) && canaries.matches(Buffer.from(value, 'latin1')));
}

import { randomBytes } from 'node:crypto';
import type { CanarySet } from '../types.js';
import { compileMatcher, encodedPatterns } from './encodings.js';

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
 * O(n) matching for n input bytes, including the byte-to-latin1 view; no regex
 * alternation, repeated per-canary scan, decoding loop or unbounded backtrack.
 * The precompiled Aho-Corasick automaton takes O(p) space for p pattern bytes.
 * Only fully known sextets are matched at offsets 0, 1 and 2 in a base64 stream,
 * so arbitrary bytes on either side do not hide a decoy. Decoys must be >=12
 * characters to keep these partial-alignment patterns usefully selective.
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
      return matcher.has((Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')).toString('latin1'));
    },
  });
}

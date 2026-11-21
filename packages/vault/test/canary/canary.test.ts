import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCanarySet, mintCanary } from '../../src/canary/index.js';

export function encodings(value: string): string[] {
  const bytes = Buffer.from(value);
  return [...new Set([
    value, bytes.toString('hex'), bytes.toString('hex').toUpperCase(),
    encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+'),
    new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1),
    ...[0, 1, 2].flatMap((offset) => {
      const embedded = Buffer.concat([Buffer.from('q'.repeat(offset)), bytes, Buffer.from('tail')]);
      return [embedded.toString('base64'), embedded.toString('base64url')];
    }),
  ])];
}

describe('canaries', () => {
  it.each(['api_key', 'password', 'card'] as const)('mints fresh %s decoys', (kind) => {
    const values = new Set(Array.from({ length: 30 }, () => mintCanary(kind)));
    expect(values.size).toBe(30);
    for (const value of values) {
      expect(value.length).toBeGreaterThanOrEqual(12);
      if (kind === 'api_key') expect(value).toMatch(/^sk-[A-Za-z0-9_-]{43}$/);
      if (kind === 'password') expect(value).toMatch(/[!A-Z]/);
      if (kind === 'card') {
        expect(value).toMatch(/^4[0-9]{15}$/);
        const sum = [...value].reverse().reduce((total, char, i) => {
          let digit = Number(char) * (i % 2 ? 2 : 1); if (digit > 9) digit -= 9;
          return total + digit;
        }, 0);
        expect(sum % 10).toBe(0);
      }
    }
  });

  it('refuses short decoys without returning their values', () => {
    expect(() => buildCanarySet(['x'.repeat(11)])).toThrow('canary values must contain at least 12 characters');
    expect(buildCanarySet([]).matches('anything')).toBe(false);
  });

  it('matches raw, URL/form, JSON, hex and all base64 alignments', () => {
    const value = ['decoy', ' spaces/+?"\\\n', 'long enough'].join('');
    const set = buildCanarySet([value]);
    for (const encoded of encodings(value)) {
      expect(set.matches(`before:${encoded}:after`)).toBe(true);
      expect(set.matches(Buffer.concat([Buffer.from([0xff]), Buffer.from(encoded), Buffer.from([0xfe])]))).toBe(true);
    }
    expect(set.matches('ordinary harmless content')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('finds randomized byte alignments and arbitrary adjacent bytes', () => {
    for (let run = 0; run < 70; run += 1) {
      const value = randomBytes(12 + run).toString('base64url');
      const set = buildCanarySet([value]);
      for (let offset = 0; offset < 3; offset += 1) {
        const combined = Buffer.concat([randomBytes(9 + offset), Buffer.from(value), randomBytes(9)]);
        for (const encoding of ['base64', 'base64url'] as const) expect(set.matches(combined.toString(encoding))).toBe(true);
      }
    }
  });

  it('handles Unicode and matches a large input with many planted decoys', () => {
    const values = Array.from({ length: 200 }, (_, i) => `unique-${i}-${'x'.repeat(16)}`);
    values.push('été-🔒-canary-"\\end');
    const set = buildCanarySet(values);
    expect(set.matches('z'.repeat(500_000))).toBe(false);
    expect(set.matches(`prefix ${JSON.stringify(values.at(-1)).slice(1, -1)} suffix`)).toBe(true);
  });

  it('matches mixed JSON escapes and percent-escape casing without repeated decoding', () => {
    const value = 'unicode-é-🔒/quote"-long-value';
    const set = buildCanarySet([value]);
    const json = JSON.stringify(value).slice(1, -1).replace('unicode', '\\u0075nicode').replace('é', '\\u00e9');
    expect(set.matches(`{"value":"${json}"}`)).toBe(true);
    const url = encodeURIComponent(value).replace('%2F', '%2f').replace('%C3', '%c3');
    expect(set.matches(`data=${url}`)).toBe(true);
    expect(set.matches('invalid escapes %GG \\uZZZZ')).toBe(false);
  });
});

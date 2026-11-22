import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, digestEquals, intentHash } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['Date', { a: new Date(0) }],
    ['bigint', { a: 1n }],
    ['function', { a: () => 1 }],
    ['lone surrogate', { a: '\ud800' }],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });
});

describe('intentHash (MSG 11)', () => {
  const spend = { itemId: 'card-1', merchant: 'example.com', amountMinor: 1299, currency: 'USD', operationId: 'op-1' };

  it('is independent of key order', () => {
    const reordered = { operationId: 'op-1', currency: 'USD', amountMinor: 1299, merchant: 'example.com', itemId: 'card-1' };
    expect(intentHash('spend', spend)).toBe(intentHash('spend', reordered));
  });

  it('changes with any bound parameter and with the kind', () => {
    const base = intentHash('spend', spend);
    expect(intentHash('spend', { ...spend, amountMinor: 1300 })).not.toBe(base);
    expect(intentHash('spend', { ...spend, currency: 'EUR' })).not.toBe(base);
    expect(intentHash('spend', { ...spend, amountMinor: '1299' })).not.toBe(base);
    expect(intentHash('grant', spend)).not.toBe(base);
  });

  it('compares digests safely', () => {
    const h = intentHash('use', { a: 1 });
    expect(digestEquals(h, h)).toBe(true);
    expect(digestEquals(h, h.replace(/.$/, h.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(digestEquals(h, h.slice(1))).toBe(false);
  });
});

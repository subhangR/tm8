import { describe, expect, it } from 'vitest';
import { assessLookalike, editDistance, normalizeOrigin, OriginRefusal, sameOrigin, skeleton } from '../src/index.js';

function refusal(input: string, options = {}): string {
  try {
    normalizeOrigin(input, options);
    return 'accepted';
  } catch (error) {
    return error instanceof OriginRefusal ? error.code : 'other';
  }
}

describe('normalizeOrigin (R4)', () => {
  it.each([
    ['https://GitHub.com', 'https://github.com'],
    ['https://github.com/', 'https://github.com'],
    ['https://github.com.', 'https://github.com'],
    ['https://github.com:443', 'https://github.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://bücher.de', 'https://xn--bcher-kva.de'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeOrigin(input).origin).toBe(expected);
  });

  it('marks IDNs and keeps both forms', () => {
    const n = normalizeOrigin('https://bücher.de');
    expect(n.idn).toBe(true);
    expect(n.displayHost).toBe('bücher.de');
    expect(n.host).toBe('xn--bcher-kva.de');
  });

  it.each([
    ['http://github.com', 'scheme_not_https'],
    ['ftp://github.com', 'scheme_not_https'],
    ['javascript:alert(1)', 'scheme_not_https'],
    ['https://user:pw@github.com', 'has_credentials'],
    ['https://github.com/login', 'has_path'],
    ['https://github.com/?a=1', 'has_query_or_fragment'],
    ['https://github.com/#x', 'has_query_or_fragment'],
    ['https://127.0.0.1', 'ip_literal'],
    ['https://0x7f.1', 'ip_literal'],
    ['https://[::1]', 'ip_literal'],
    ['https://localhost', 'localhost'],
    ['https://app.localhost', 'localhost'],
    ['https://intranet', 'private_name'],
    ['https://printer.local', 'private_name'],
    ['https://svc.internal', 'private_name'],
    ['github.com', 'invalid_url'],
    ['https://git hub.com', 'invalid_url'],
  ])('refuses %s (%s)', (input, code) => {
    expect(refusal(input)).toBe(code);
  });

  it('allows development origins only in item dev mode', () => {
    expect(refusal('http://localhost:3000', { devMode: true })).toBe('accepted');
    expect(normalizeOrigin('http://localhost:3000', { devMode: true }).origin).toBe('http://localhost:3000');
    expect(refusal('https://10.0.0.5', { devMode: true })).toBe('accepted');
  });

  it('keeps only the origin of a page URL when allowPath is set', () => {
    expect(normalizeOrigin('https://github.com/login?return_to=%2F', { allowPath: true }).origin).toBe('https://github.com');
  });

  it('acceptance 3: a subdomain is a different origin', () => {
    expect(sameOrigin('https://github.com', 'https://gist.github.com')).toBe(false);
    expect(sameOrigin('https://github.com', 'https://github.com:8443')).toBe(false);
    expect(sameOrigin('https://github.com', 'https://GITHUB.com./login')).toBe(true);
  });
});

describe('assessLookalike (acceptance 4)', () => {
  const bound = ['https://github.com', 'https://accounts.google.com'];

  it('flags a one-edit typo', () => {
    const findings = assessLookalike('https://githhub.com', bound);
    expect(findings).toEqual([{ kind: 'edit_distance', similarTo: 'https://github.com', distance: 1 }]);
  });

  it('flags a transposition', () => {
    expect(assessLookalike('https://gtihub.com', bound)[0]?.kind).toBe('edit_distance');
  });

  it('flags a Cyrillic homograph as confusable and mixed-script', () => {
    const origin = normalizeOrigin('https://gіthub.com').origin; // U+0456
    expect(origin.startsWith('https://xn--')).toBe(true);
    const kinds = assessLookalike(origin, bound).map((f) => f.kind);
    expect(kinds).toContain('confusable');
    expect(kinds).toContain('mixed_script');
  });

  it('flags ASCII lookalikes and brand embedding', () => {
    expect(assessLookalike('https://glthub.com', bound)[0]?.kind).toMatch(/confusable|edit_distance/);
    expect(assessLookalike('https://github-login.com', bound)[0]?.kind).toBe('brand_embedding');
    expect(assessLookalike('https://github.com.evil.io', bound)[0]?.kind).toBe('brand_embedding');
  });

  it('does not flag the same site or unrelated sites', () => {
    expect(assessLookalike('https://gist.github.com', bound)).toEqual([]);
    expect(assessLookalike('https://example.org', bound)).toEqual([]);
  });

  it('helpers behave', () => {
    expect(editDistance('github', 'gihtub')).toBe(1);
    expect(editDistance('abc', 'abcdefg', 2)).toBe(3);
    expect(skeleton('rnicrosoft.com')).toBe(skeleton('microsoft.com'));
  });
});

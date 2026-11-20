import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createPasteDetector, tokenSpanScanner } from '../../src/paste/index.js';
import type { PasteKind } from '../../src/types.js';

const detector = createPasteDetector();
const mixed = () => 'aB3dE7gH9kL2mN4pQ6rS8tU0vW5xY1z';
const github = () => 'gh' + 'p_' + 'A'.repeat(36);
const aws = () => 'AK' + 'IA' + 'A'.repeat(16);
const uuid = () => ['01a1fac1', 'd7f0', '7219', '9e24', '77ac6f4daad8'].join('-');
const jwt = (header: unknown = { alg: 'HS256' }) => [Buffer.from(JSON.stringify(header)).toString('base64url'), 'e30', Buffer.alloc(32, 5).toString('base64url')].join('.');
const pem = (label = 'PRIVATE KEY') => ['-----BEGIN ' + label + '-----', Buffer.alloc(48, 1).toString('base64'), '-----END ' + label + '-----'].join('\n');
const card = () => ['4111', '1111', '1111', '1111'].join(' ');

const cases: { kind: PasteKind; positive: () => string; negative: () => string; confidence?: 'medium' }[] = [
  { kind: 'private_key', positive: () => pem('OPENSSH PRIVATE KEY'), negative: () => pem('PUBLIC KEY') },
  { kind: 'aws_access_key', positive: aws, negative: () => 'AK' + 'IA' + 'a'.repeat(16) },
  { kind: 'aws_secret_key', positive: () => aws() + '\n' + Buffer.alloc(30, 11).toString('base64'), negative: () => Buffer.alloc(30, 11).toString('base64'), confidence: 'medium' },
  { kind: 'github_token', positive: github, negative: () => github().slice(0, -1) },
  { kind: 'gitlab_token', positive: () => 'gl' + 'pat-' + 'A'.repeat(20), negative: () => 'gl' + 'pat-' + 'A'.repeat(19) },
  { kind: 'openai_key', positive: () => 's' + 'k-proj-' + 'A'.repeat(48), negative: () => 's' + 'k-' + 'A'.repeat(19) },
  { kind: 'anthropic_key', positive: () => 's' + 'k-ant-api03-' + 'A'.repeat(80), negative: () => 's' + 'k-ant-' + 'A'.repeat(19) },
  { kind: 'google_api_key', positive: () => 'AI' + 'za' + 'A'.repeat(35), negative: () => 'AI' + 'za' + 'A'.repeat(34) },
  { kind: 'slack_token', positive: () => 'xo' + 'xb-' + '1'.repeat(12) + '-' + '2'.repeat(12) + '-' + 'A'.repeat(24), negative: () => 'xo' + 'xz-' + 'A'.repeat(32) },
  { kind: 'stripe_key', positive: () => 's' + 'k_live_' + 'A'.repeat(24), negative: () => 's' + 'k_live_' + 'A'.repeat(23) },
  { kind: 'twilio_key', positive: () => 'S' + 'K' + 'a'.repeat(32), negative: () => 'S' + 'K' + 'a'.repeat(31) },
  { kind: 'tm8_token', positive: () => 'tm' + '8s_' + uuid() + '.' + Buffer.alloc(32, 5).toString('base64url'), negative: () => 'tm' + '8s_' + uuid() + '.' + 'A'.repeat(42) },
  { kind: 'jwt', positive: () => jwt(), negative: () => jwt({ typ: 'JWT' }) },
  { kind: 'connection_string', positive: () => 'postgres://' + 'fixture:demo-value@db.example.com/app', negative: () => 'postgres://db.example.com/app' },
  { kind: 'card_number', positive: card, negative: () => card().slice(0, -1) + '2' },
  { kind: 'password_assignment', positive: () => 'password="' + 'demo value' + '"', negative: () => 'password=', confidence: 'medium' },
  { kind: 'generic_secret_assignment', positive: () => 'export FOO_TOKEN=' + 'demo-value', negative: () => 'export FOO_LABEL=demo-value', confidence: 'medium' },
  { kind: 'high_entropy', positive: mixed, negative: () => 'a'.repeat(30), confidence: 'medium' },
];

describe('paste detector: all 18 kinds', () => {
  for (const fixture of cases) {
    it(`recognizes ${fixture.kind} at the specified confidence`, () => {
      const finding = detector.scan(fixture.positive()).findings.find((entry) => entry.kind === fixture.kind);
      expect(finding?.confidence).toBe(fixture.confidence ?? 'high');
    });
    it(`refuses the ${fixture.kind} near miss`, () => {
      expect(detector.scan(fixture.negative()).findings.some((entry) => entry.kind === fixture.kind)).toBe(false);
    });
  }

  it('covers provider variants without putting key-shaped literals in git', () => {
    const variants = [
      ...['p', 'o', 'u', 's', 'r'].map((part) => 'gh' + part + '_' + 'A'.repeat(36)),
      'github' + '_pat_' + 'A'.repeat(22) + '_' + 'B'.repeat(59),
      's' + 'k-' + 'A'.repeat(48),
      'AS' + 'IA' + 'A'.repeat(16),
      ...['a', 'b', 'p', 's', 'r'].map((part) => 'xo' + 'x' + part + '-' + 'A'.repeat(32)),
      'https://hooks.slack.com/services/' + 'T'.repeat(9) + '/' + 'B'.repeat(9) + '/' + 'A'.repeat(24),
      ...['sk_live_', 'rk_live_', 'sk_test_'].map((prefix) => prefix + 'A'.repeat(24)),
      'tm' + '8m_' + uuid() + '.' + Buffer.alloc(32).toString('base64url'),
      'tm' + '8c_' + Buffer.alloc(32).toString('base64url'),
      ...['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'].map(pem),
    ];
    for (const token of variants) expect(detector.scan(token).findings.some((finding) => finding.confidence === 'high')).toBe(true);
    expect(detector.scan('tm' + '8_' + 'A'.repeat(43)).findings.some((finding) => finding.kind === 'tm8_token')).toBe(false);
  });

  it('returns UTF-16 offsets and exact redacted text around astral characters', () => {
    const prefix = '😀𝄞 before ';
    const token = github();
    const result = detector.scan(prefix + token + ' after 🚀');
    expect(result.findings).toEqual([{ start: prefix.length, end: prefix.length + token.length, kind: 'github_token', confidence: 'high' }]);
    expect(result.redacted).toBe(prefix + '[redacted:github_token] after 🚀');
  });

  it('merges overlapping evidence with high confidence and the longer span winning', () => {
    const token = github();
    const result = detector.scan('password="' + token + '"');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('github_token');
    expect(result.redacted).toBe('password="[redacted:github_token]"');
    const connection = 'postgres://fixture:' + mixed() + '@db.example.com/app';
    expect(detector.scan(connection).findings).toEqual([{ kind: 'connection_string', confidence: 'high', start: 0, end: connection.length }]);
    expect(detector.scan('api_key="' + mixed() + '"').findings[0]?.kind).toBe('generic_secret_assignment');
  });

  it('scans only high-confidence spans for the response filter', () => {
    const text = github() + ' password=fixture-value ' + mixed();
    expect(tokenSpanScanner(detector)(text)).toEqual([{ start: 0, end: github().length }]);
  });

  it('guards UUIDs, contextual git digests, image data, URLs and prose', () => {
    const digest = 'a1b2c3d4e5f60789'.repeat(4);
    const inputs = [uuid(), 'commit ' + digest, 'sha ' + digest.slice(0, 40), 'hash: ' + digest,
      'data:image/png;base64,' + mixed().repeat(5), 'https://example.com/' + mixed() + '?v=' + mixed(),
      'This is ordinary prose about the project and its documentation.'];
    for (const input of inputs) expect(detector.scan(input).findings).toEqual([]);
  });

  it('requires card digit-run boundaries, Luhn and a known IIN', () => {
    for (const input of ['1' + card(), card() + '1', '0'.repeat(16), '1234'.repeat(4), '4111-1111-1111-1112']) {
      expect(detector.scan(input).findings.some((finding) => finding.kind === 'card_number')).toBe(false);
    }
    expect(detector.scan(card().replaceAll(' ', '-')).findings[0]?.kind).toBe('card_number');
  });

  it('keeps window-spanning tokens and large PEM/JWT runs whole', () => {
    const token = github();
    const prefix = ' '.repeat(1024 * 1024 - 10);
    const result = detector.scan(prefix + token + ' ');
    expect(result.findings).toEqual([{ kind: 'github_token', confidence: 'high', start: prefix.length, end: prefix.length + token.length }]);
    const longPem = ['-----BEGIN PRIVATE KEY-----', 'A'.repeat(1024 * 1024 + 3), '-----END PRIVATE KEY-----'].join('\n');
    expect(detector.scan(longPem).findings).toEqual([{ kind: 'private_key', confidence: 'high', start: 0, end: longPem.length }]);
    const longJwt = jwt().split('.')[0] + '.' + 'A'.repeat(1024 * 1024 + 3) + '.AAAA';
    expect(detector.scan(longJwt).findings[0]?.end).toBe(longJwt.length);
  });

  it('scans each adversarial 1 MiB input in under 500 ms', () => {
    const size = 1024 * 1024;
    const inputs = ['a'.repeat(size), mixed().repeat(Math.ceil(size / mixed().length)).slice(0, size), ('gh' + 'p_').repeat(size / 4)];
    detector.scan('warmup');
    for (const input of inputs) {
      const start = performance.now();
      detector.scan(input);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });
});

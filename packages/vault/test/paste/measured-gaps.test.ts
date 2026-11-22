import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createPasteDetector, tokenSpanScanner } from '../../src/paste/index.js';
import type { PasteFinding } from '../../src/types.js';

const detector = createPasteDetector();
const scanner = tokenSpanScanner(detector);
const mixed = () => 'aB3dE7gH9kL2mN4pQ6rS8tU0vW5xY1z';
// Deterministic, synthetic material assembled at runtime; no credential-shaped
// literal or complete private-key fixture is stored in the repository.
const hex = (length: number) => createHash('sha256').update('paste fixture ' + length).digest('hex').slice(0, length);
const bytes = (length: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 37 + 11) % 256));
const body = () => bytes(48).toString('base64');
const marker = (direction: 'BEGIN' | 'END', label: string) => '-----' + direction + ' ' + label + '-----';
const armored = (label: string, headers: string[] = [], ending = true, newline = '\n') => [
  marker('BEGIN', label), ...headers, body(), body(),
  ...(label.startsWith('PGP ') ? ['=' + bytes(3).toString('base64')] : []),
  ...(ending ? [marker('END', label)] : []),
].join(newline);
const uuid = () => {
  const value = hex(32);
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
};
const discord = () => 'https://' + 'discord.com/api/webhooks/' + '1'.repeat(18) + '/' + mixed();
const teams = () => 'https://' + 'fixture.webhook.office.com/webhookb2/' + uuid() + '@' + uuid()
  + '/IncomingWebhook/' + hex(32) + '/' + uuid();

function onlyFinding(value: string, kind: PasteFinding['kind'], confidence: PasteFinding['confidence']): void {
  const prefix = '😀 before ';
  const result = detector.scan(prefix + value + ' after');
  expect(result.findings).toEqual([{ kind, confidence, start: prefix.length, end: prefix.length + value.length }]);
  expect(result.redacted).toBe(prefix + `[redacted:${kind}] after`);
  expect(scanner(prefix + value + ' after')).toEqual(confidence === 'high'
    ? [{ start: prefix.length, end: prefix.length + value.length }] : []);
}

describe('paste detector: measured hex gaps and digest near misses', () => {
  for (const length of [32, 64]) {
    for (const uppercase of [false, true]) {
      it(`recognizes a bare ${length}-hex token, uppercase=${uppercase}, at medium confidence`, () => {
        const token = hex(length);
        onlyFinding(uppercase ? token.toUpperCase() : token, 'high_entropy', 'medium');
      });
    }
  }

  const contextual: [string, () => string][] = [
    ['40-hex commit sha', () => 'commit ' + hex(64).slice(0, 40)],
    ['64-hex sha', () => 'sha256 ' + hex(64)],
    ['64-hex hash', () => 'hash: ' + hex(64)],
    ['64-hex digest', () => 'digest ' + hex(64)],
    ['preceding context within 48 characters', () => 'commit' + ' '.repeat(42) + hex(64)],
    ['following context within 48 characters', () => hex(64) + ' '.repeat(42) + 'digest'],
    ['git log --oneline output', () => hex(64).slice(0, 40) + ' Add paste coverage\n' + hex(32).slice(0, 7) + ' Fix scanner'],
    ['sha with a numeric substring that passes Luhn', () => 'commit ab' + ['4111', '1111', '1111', '1111'].join('') + 'cd' + hex(32).slice(0, 20)],
    ['sha256 image digest', () => 'sha256:' + hex(64)],
    ['@sha256 image reference', () => 'registry.example/app@sha256:' + hex(64)],
    ['npm sha512 integrity', () => 'integrity: sha512-' + bytes(64).toString('base64')],
    ['sha384 SRI', () => '<script integrity="sha384-' + bytes(48).toString('base64') + '">'],
    ['dashed UUID', uuid],
    ['low entropy 32-hex', () => 'a'.repeat(32)],
    ['low entropy 64-hex', () => 'a'.repeat(60) + 'bcde'],
    ['repeated short hex', () => 'a1b2'.repeat(8)],
    ['repeated full hex alphabet', () => Array.from({ length: 16 }, (_, index) => index.toString(16)).join('').repeat(4)],
  ];
  for (const [name, input] of contextual) {
    it(`ignores ${name}`, () => {
      expect(detector.scan(input()).findings).toEqual([]);
    });
  }
});

describe('paste detector: webhook and token-only userinfo URLs', () => {
  for (const [name, input] of [['Discord', discord], ['Teams', teams]] as const) {
    it(`recognizes the whole ${name} webhook URL as one high span`, () => {
      onlyFinding(input(), 'webhook_url', 'high');
      onlyFinding(input() + '?signature=' + mixed(), 'webhook_url', 'high');
    });
  }

  it('recognizes userinfo-only tokens, including the 20-character boundary and percent encoding', () => {
    for (const token of [mixed(), mixed().slice(0, 20), Array.from(mixed(), (ch) => '%' + ch.charCodeAt(0).toString(16)).join('')]) {
      onlyFinding('https://' + token + '@host.example/path', 'connection_string', 'high');
    }
  });

  it('retains the existing username/password URL rule', () => {
    onlyFinding('postgres://' + 'fixture:demo-value@db.example/app', 'connection_string', 'high');
  });

  const nearMisses: [string, () => string][] = [
    ['git username', () => 'https://git@host.example/path'],
    ['deploy username', () => 'https://deploy@host.example/path'],
    ['19-character username', () => 'https://' + mixed().slice(0, 19) + '@host.example/path'],
    ['low-entropy long username', () => 'https://' + 'a'.repeat(64) + '@host.example/path'],
    ['encoded short username', () => 'https://' + '%41'.repeat(10) + '@host.example/path'],
    ['ordinary URL', () => 'https://host.example/' + mixed()],
    ['Discord lookalike host', () => discord().replace('discord.com', 'discord.com.example')],
    ['Discord non-webhook route', () => discord().replace('/webhooks/', '/channels/')],
    ['Discord missing token', () => discord().slice(0, -mixed().length)],
    ['Teams lookalike host', () => teams().replace('office.com', 'office.com.example')],
    ['Teams non-webhook route', () => teams().replace('/webhookb2/', '/ordinary/')],
  ];
  for (const [name, input] of nearMisses) {
    it(`ignores ${name}`, () => {
      expect(detector.scan(input()).findings).toEqual([]);
    });
  }
});

describe('paste detector: signature query values', () => {
  const names = ['sig', 'signature', 'X-Amz-Signature', 'X-Goog-Signature', 'X-Amz-Security-Token'];
  for (const name of names) {
    it(`recognizes only the ${name} value at medium confidence`, () => {
      for (const delimiter of ['?', '&']) {
        const value = mixed() + '?part=ordinary%2B%2F%3D';
        const prefix = '😀 https://example.com/path' + delimiter + name + '=';
        const suffix = '&next=ordinary#fragment';
        const result = detector.scan(prefix + value + suffix);
        expect(result.findings).toEqual([{ kind: 'generic_secret_assignment', confidence: 'medium', start: prefix.length, end: prefix.length + value.length }]);
        expect(result.redacted).toBe(prefix + '[redacted:generic_secret_assignment]' + suffix);
        expect(scanner(prefix + value + suffix)).toEqual([]);
      }
    });
  }

  it('handles adjacent parameters and empty values without consuming their neighbors', () => {
    const prefix = 'https://example.com/?sig=&signature=';
    const value = mixed();
    const middle = '&X-Amz-Security-Token=';
    const input = prefix + value + middle + value + '&next=ordinary';
    expect(detector.scan(input).findings).toEqual([
      { kind: 'generic_secret_assignment', confidence: 'medium', start: prefix.length, end: prefix.length + value.length },
      { kind: 'generic_secret_assignment', confidence: 'medium', start: prefix.length + value.length + middle.length, end: prefix.length + value.length + middle.length + value.length },
    ]);
  });

  it('does not treat query names as prose assignments, name prefixes or empty credentials', () => {
    for (const input of [
      'signature=fixture-value', 'sig: fixture-value', 'https://example.com/?signature=',
      'https://example.com/?signature_hint=' + mixed(), 'https://example.com/?design=' + mixed(),
    ]) expect(detector.scan(input).findings).toEqual([]);
  });
});

describe('paste detector: complete and truncated private-key armor', () => {
  const variants: [string, () => string][] = [
    ['PGP private-key armor', () => armored('PGP PRIVATE KEY BLOCK')],
    ['PGP armor with metadata and CRLF', () => armored('PGP PRIVATE KEY BLOCK', ['Version: fixture', 'Comment: synthetic', ''], true, '\r\n')],
    ['RFC 1421 PEM headers', () => armored('RSA PRIVATE KEY', ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-256-CBC,' + hex(32), ''])],
    ['truncated PEM', () => armored('PRIVATE KEY', [], false)],
    ['truncated encrypted PEM', () => armored('EC PRIVATE KEY', ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-256-CBC,' + hex(32), ''], false)],
    ['truncated PGP armor', () => armored('PGP PRIVATE KEY BLOCK', [], false)],
  ];
  for (const [name, input] of variants) {
    it(`recognizes ${name} as one high private-key span`, () => {
      // Separate trailing prose onto its own line so truncated armor ends at
      // the last contiguous armor line, rather than in the prose.
      const prefix = '😀 before\n';
      const value = input();
      const suffix = '\nThis is ordinary prose.';
      expect(detector.scan(prefix + value + suffix).findings).toEqual([
        { kind: 'private_key', confidence: 'high', start: prefix.length, end: prefix.length + value.length },
      ]);
      expect(scanner(prefix + value + suffix)).toEqual([{ start: prefix.length, end: prefix.length + value.length }]);
    });
  }

  it('does not absorb a following key when the previous key is truncated', () => {
    const first = armored('PRIVATE KEY', [], false);
    const second = armored('PGP PRIVATE KEY BLOCK');
    const input = first + '\n' + second;
    expect(detector.scan(input).findings).toEqual([
      { kind: 'private_key', confidence: 'high', start: 0, end: first.length },
      { kind: 'private_key', confidence: 'high', start: first.length + 1, end: input.length },
    ]);
  });

  it('stops truncated armor before prose after a blank line', () => {
    const value = armored('PRIVATE KEY', [], false);
    expect(detector.scan(value + '\n\nThanks\n').findings).toEqual([
      { kind: 'private_key', confidence: 'high', start: 0, end: value.length },
    ]);
    expect(scanner(value + '\n\nThanks\n')).toEqual([{ start: 0, end: value.length }]);
  });

  it('requires private armor and at least 16 body characters', () => {
    for (const input of [
      armored('PUBLIC KEY'), armored('PGP PUBLIC KEY BLOCK'),
      marker('BEGIN', 'PRIVATE KEY'),
      [marker('BEGIN', 'PRIVATE KEY'), 'Proc-Type: 4,ENCRYPTED', '', marker('END', 'PRIVATE KEY')].join('\n'),
      [marker('BEGIN', 'PRIVATE KEY'), 'A'.repeat(15), marker('END', 'PRIVATE KEY')].join('\n'),
    ]) expect(detector.scan(input).findings.some((finding) => finding.kind === 'private_key')).toBe(false);
  });
});

describe('paste detector: measured-gap linear-time bounds', () => {
  const size = 1024 * 1024;
  const inputs: [string, () => string][] = [
    ['hex run', () => Array.from({ length: 16 }, (_, index) => index.toString(16)).join('')],
    ['repeated PEM BEGIN without END', () => marker('BEGIN', 'PRIVATE KEY')],
    ['repeated PGP BEGIN without END', () => marker('BEGIN', 'PGP PRIVATE KEY BLOCK')],
    ['repeated signature query', () => '?sig='],
    ['repeated userinfo URL', () => 'https://a@'],
    ['repeated webhook prefix', () => 'https://' + 'fixture.webhook.office.com/webhookb2/'],
  ];
  for (const [name, unit] of inputs) {
    it(`scans 1 MiB of ${name} in under 500 ms`, () => {
      const part = unit();
      const input = part.repeat(Math.ceil(size / part.length)).slice(0, size);
      detector.scan('warmup');
      const start = performance.now();
      detector.scan(input);
      expect(performance.now() - start).toBeLessThan(500);
    });
  }
});

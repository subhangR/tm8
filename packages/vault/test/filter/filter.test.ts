import { describe, expect, it } from 'vitest';
import { createResponseFilter } from '../../src/filter/index.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { SecretMaterial } from '../../src/secret-material.js';
import type { ResponseFilterInput } from '../../src/types.js';

const keyValue = ['fixture', '/+ ?"\\\n', 'value-123456789'].join('');
const filter = createResponseFilter();
function run(body: string | Buffer, overrides: Partial<ResponseFilterInput> = {}) {
  const key = SecretMaterial.fromUtf8(JSON.stringify({ key: keyValue }));
  try {
    const result = filter({ status: 200, body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      contentType: 'text/plain', headers: {}, maxBytes: 100_000, key, canaries: buildCanarySet([]), ...overrides });
    expect(key.disposed).toBe(false);
    return result;
  } finally { key.dispose(); }
}

describe('response filter (acceptance 10)', () => {
  const forms = [
    ['raw', keyValue], ['hex lower', Buffer.from(keyValue).toString('hex')],
    ['hex upper', Buffer.from(keyValue).toString('hex').toUpperCase()],
    ['url', encodeURIComponent(keyValue)], ['form plus', encodeURIComponent(keyValue).replace(/%20/g, '+')],
    ['form', new URLSearchParams({ v: keyValue }).toString().slice(2)],
    ['json escaped', JSON.stringify(keyValue).slice(1, -1)],
    ...[0, 1, 2].flatMap((alignment) => (['base64', 'base64url'] as const).map((encoding) => [
      `${encoding} offset ${alignment}`, Buffer.from(`${'q'.repeat(alignment)}${keyValue}tail`).toString(encoding),
    ])),
  ];

  it.each(forms)('redacts %s as one span per occurrence', (_name, encoded) => {
    const result = run(`!${encoded}! ${encoded}!`);
    expect(result.redactions).toBe(2);
    expect(result.body.kind).toBe('text');
    if (result.body.kind === 'text') {
      expect(result.body.value.split('[redacted]')).toHaveLength(3);
      expect(result.body.value.includes(encoded!)).toBe(false);
    }
  });

  it('widens partial base64 matches to enclosing four-character quanta', () => {
    for (let alignment = 0; alignment < 3; alignment += 1) {
      const bytes = Buffer.from(`${'q'.repeat(alignment)}${keyValue}abcdefgh`);
      const encoded = bytes.toString('base64');
      const width = Math.ceil((alignment + Buffer.byteLength(keyValue)) / 3) * 4;
      expect(run(`!${encoded}!`).body).toEqual({ kind: 'text', value: `![redacted]${encoded.slice(width)}!` });
    }
  });

  it('redacts complete HTTP Basic credentials for arbitrary usernames', () => {
    for (const username of ['', 'a', 'ab', 'service-user']) {
      const basic = Buffer.from(`${username}:${keyValue}`).toString('base64');
      expect(run(`Basic ${basic}`).body).toEqual({ kind: 'text', value: 'Basic [redacted]' });
      expect(run(basic).redactions).toBe(1);
    }
  });

  it.each(forms)('withholds a canary in %s', (_name, encoded) => {
    expect(run(encoded!, { canaries: buildCanarySet([keyValue]) }).body).toEqual({ kind: 'withheld', reason: 'canary' });
  });

  it('withholds in size, binary, canary order', () => {
    const canaries = buildCanarySet([keyValue]);
    expect(run(keyValue, { canaries, maxBytes: 1, contentType: 'image/png' }).body).toEqual({ kind: 'withheld', reason: 'too_large' });
    expect(run(keyValue, { canaries, contentType: 'image/png' }).body).toEqual({ kind: 'withheld', reason: 'binary' });
    expect(run(Buffer.from([0xff, 0xfe])).body).toEqual({ kind: 'withheld', reason: 'binary' });
    expect(run(`hello\0${keyValue}`, { canaries }).body).toEqual({ kind: 'withheld', reason: 'binary' });
  });

  it.each(['application/json', 'application/problem+json', 'text/plain', 'text/xml', 'application/xml',
    'image/svg+xml', 'application/x-www-form-urlencoded', 'application/javascript'])('accepts text MIME %s', (contentType) => {
    expect(run('hello', { contentType }).body).toEqual({ kind: 'text', value: 'hello' });
  });

  it('returns JSON after redaction, text when redaction prevents parsing, and empty for 204', () => {
    expect(run(JSON.stringify({ echoed: keyValue }), { contentType: 'application/json' }).body)
      .toEqual({ kind: 'json', value: { echoed: '[redacted]' } });
    expect(run('', { status: 204, contentType: null }).body).toEqual({ kind: 'empty' });
    const key = SecretMaterial.fromUtf8(JSON.stringify({ key: '123456789012' }));
    try {
      expect(run('123456789012', { key, contentType: 'application/json' }).body).toEqual({ kind: 'text', value: '[redacted]' });
    } finally { key.dispose(); }
  });

  it('uses scanner spans in UTF-16 coordinates, merges overlaps and counts adjacent spans', () => {
    const body = `🔒token-one${keyValue}token-two`;
    const scanTokens = (text: string) => text === body ? [{ start: 2, end: 11 }, { start: 11 + keyValue.length, end: text.length }] : [];
    const outcome = run(body, { scanTokens });
    expect(outcome.body).toEqual({ kind: 'text', value: '🔒[redacted][redacted][redacted]' });
    expect(outcome.redactions).toBe(3);
    expect(run(keyValue, { scanTokens: (text) => [{ start: 0, end: text.length }] }).redactions).toBe(1);
  });

  it('allowlists headers, drops cookies/location, and redacts allowed values', () => {
    const headers = Object.fromEntries(['content-type', 'content-language', 'etag', 'last-modified', 'cache-control',
      'expires', 'date', 'retry-after', 'link', 'x-request-id', 'request-id', 'x-ratelimit-remaining',
      'ratelimit-limit', 'x-github-request-id'].map((name) => [name, keyValue]));
    const result = run('okay', { headers: { ...headers, 'set-cookie': keyValue, location: keyValue, authorization: keyValue, server: keyValue } });
    expect(result.headers).toEqual(Object.fromEntries(Object.keys(headers).map((name) => [name, '[redacted]'])));
    expect(result.redactions).toBe(Object.keys(headers).length);
  });

  it('withholds canaries in allowed headers too', () => {
    expect(run('okay', { canaries: buildCanarySet([keyValue]), headers: { etag: keyValue } }).body)
      .toEqual({ kind: 'withheld', reason: 'canary' });
  });

  it('never throws for malformed key material or a failing scanner', () => {
    const key = SecretMaterial.fromUtf8('malformed');
    try {
      expect(run('hello', { key }).body).toEqual({ kind: 'withheld', reason: 'binary' });
      expect(run('hello', { scanTokens: () => { throw new Error('scanner failed'); } }).body).toEqual({ kind: 'withheld', reason: 'binary' });
    } finally { key.dispose(); }
  });

  it('redacts mixed JSON and URL escapes with exact original-source spans', () => {
    const escaped = JSON.stringify(keyValue).slice(1, -1).replace('fixture', '\\u0066ixture');
    const json = run(`{"value":"${escaped}","other":"safe"}`, { contentType: 'application/json' });
    expect(json.body).toEqual({ kind: 'json', value: { value: '[redacted]', other: 'safe' } });
    expect(json.redactions).toBe(1);
    const mixedUrl = encodeURIComponent(keyValue).replace('%2F', '%2f');
    expect(run(`x=${mixedUrl}&y=safe`).body).toEqual({ kind: 'text', value: 'x=[redacted]&y=safe' });
    expect(run(`x=${mixedUrl}&y=${mixedUrl}`).redactions).toBe(2);
  });

  it('preserves exact Unicode source positions when decoding form escapes', () => {
    const value = 'é-🔒-more-than-twelve';
    const key = SecretMaterial.fromUtf8(JSON.stringify({ key: value }));
    try {
      const encoded = `prefix+${encodeURIComponent(value).replace('%C3', '%c3')}+suffix`;
      const outcome = run(encoded, { key });
      expect(outcome.body).toEqual({ kind: 'text', value: 'prefix+[redacted]+suffix' });
      expect(outcome.redactions).toBe(1);
    } finally { key.dispose(); }
  });
});

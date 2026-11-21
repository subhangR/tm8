import * as querystring from 'node:querystring';
import { describe, expect, it } from 'vitest';
import { createResponseFilter } from '../../src/filter/index.js';
import { buildCanarySet, mintCanary } from '../../src/canary/index.js';
import { SecretMaterial } from '../../src/secret-material.js';
import type { ApiResponseOutcome, ResponseFilterInput } from '../../src/types.js';
import { decoders, disguise, escapeAll, hex, lastEscaped, lowByteAlias, receiversSeeing, seeded, type Receiver } from '../support/receivers.js';

// Review F02 follow-up (task 01a1fe78; brief addendum 5). The response filter reads the same
// decoded views as the canary matcher, so the escape-run mismatch reached it too: an upstream that
// echoed the provider key percent-encoded next to an invalid byte the agent chose (`...%39%C3`)
// handed the agent a key that every decoder below reads. These tests hold what the agent is
// handed, in a text body, inside a JSON body and in an allowed header, to what a receiver reads.
// Every value here is synthetic.

const providerKey = ['fixture', 'provider', 'key', '0123456789'].join('-');
const decoy = ['fixture', 'canary', 'ABCdef0123'].join('-');
const ALL: Receiver[] = ['form', 'component', 'node-form', 'node-component', 'bytes'];
const NODE: Receiver[] = ['node-form', 'node-component'];
const filter = createResponseFilter();

function run(body: string, overrides: Partial<ResponseFilterInput> = {}, keyValue = providerKey): ApiResponseOutcome {
  const key = SecretMaterial.fromUtf8(JSON.stringify({ key: keyValue }));
  try {
    const result = filter({ status: 200, body: Buffer.from(body, 'utf8'), contentType: 'text/plain', headers: {}, maxBytes: 100_000, key,
      canaries: buildCanarySet([]), ...overrides });
    expect(key.disposed).toBe(false);
    return result;
  } finally { key.dispose(); }
}

/**
 * Where an upstream puts a value, and the text the agent reads it from: the body text, the URL a
 * JSON body carries after the agent parses it, or a header value. `around` is that text with the
 * value in place, so the same function gives what was sent and what the filter must hand over.
 */
interface Position {
  ascii: boolean;
  send(value: string): { body: string; overrides: Partial<ResponseFilterInput> };
  read(outcome: ApiResponseOutcome): string;
  around(value: string): string;
}
const url = (value: string) => `https://api.example.com/items?cursor=${value}&page=2`;
const positions: Record<string, Position> = {
  'a text body': {
    ascii: false,
    send: (value) => ({ body: `cursor=${value}&page=2`, overrides: {} }),
    read: (outcome) => (outcome.body.kind === 'text' ? outcome.body.value : `unexpected ${outcome.body.kind}`),
    around: (value) => `cursor=${value}&page=2`,
  },
  'a URL in a JSON body': {
    ascii: false,
    send: (value) => ({ body: JSON.stringify({ next: url(value) }), overrides: { contentType: 'application/json' } }),
    read: (outcome) => (outcome.body.kind === 'json' ? String((outcome.body.value as { next?: unknown }).next) : `unexpected ${outcome.body.kind}`),
    around: url,
  },
  // Node reads header bytes as Latin-1, so an upstream header cannot carry a code unit above 0xFF.
  'a link header': {
    ascii: true,
    send: (value) => ({ body: '', overrides: { headers: { link: `<${url(value)}>; rel="next"` } } }),
    read: (outcome) => outcome.headers.link ?? 'missing',
    around: (value) => `<${url(value)}>; rel="next"`,
  },
};
const placed = Object.entries(positions);

describe('the response filter redacts what a receiver reads (Addendum 5)', () => {
  // (a) The decoy class: a run of escapes that is not valid UTF-8, with the key inside or beside it.
  // Then Node's class: a literal character whose low byte is the key's, read once decodeURIComponent throws.
  const hidden: [string, string, string, Receiver[]][] = [
    ['the last character escaped, then a truncated lead byte', lastEscaped(providerKey, '%C3'), '[redacted]%C3', ALL],
    ['a broken lead byte before the escaped first character', `%C3%${hex(providerKey[0]!)}${providerKey.slice(1)}`, '%C3[redacted]', ALL],
    ['every byte escaped, then an invalid byte', `${escapeAll(providerKey)}%FF`, '[redacted]%FF', ALL],
    ['lowercase escapes between overlong bytes', `%c0%af${escapeAll(providerKey, true)}%c0%af`, '%c0%af[redacted]%c0%af', ALL],
    ['a surrogate escape after the key', `${lastEscaped(providerKey)}%ED%A0%80`, '[redacted]%ED%A0%80', ALL],
    ['a low-byte alias of the first character, then a truncated lead byte', `${lowByteAlias(providerKey[0]!)}${providerKey.slice(1)}%C3`, '[redacted]%C3', NODE],
  ];
  const cases = hidden.flatMap(([label, value, redacted, readers]) => placed
    .filter(([, position]) => position.ascii === false || /^[\x00-\x7f]*$/.test(value))
    .map(([where, position]) => [`${label}, in ${where}`, position, value, redacted, readers] as const));

  it.each(cases)('redacts %s', (_label, position, value, redacted, readers) => {
    // What the agent would read without the filter: the key, by the receivers named.
    expect(receiversSeeing(position.around(value), providerKey)).toEqual(readers);
    const { body, overrides } = position.send(value);
    const outcome = run(body, overrides);
    expect(outcome.redactions).toBe(1);
    const handed = position.read(outcome);
    expect(handed).toBe(position.around(redacted));
    // What it reads with the filter: no receiver finds the key.
    expect(receiversSeeing(handed, providerKey)).toEqual([]);
  });

  it('reads the body as the agent\'s own form parsers do, before and after', () => {
    const body = `cursor=${lastEscaped(providerKey, '%C3')}&page=2`;
    // Node's parsers and the WHATWG reading all take the key out of the cursor field.
    expect(new URLSearchParams(body).get('cursor')).toBe(`${providerKey}�`);
    expect(querystring.parse(body).cursor).toBe(`${providerKey}�`);
    expect(decoders.form(body)).toBe(`cursor=${providerKey}�&page=2`);
    const outcome = run(body);
    expect(outcome.body).toEqual({ kind: 'text', value: 'cursor=[redacted]%C3&page=2' });
    if (outcome.body.kind !== 'text') return;
    expect(new URLSearchParams(outcome.body.value).get('cursor')).toBe('[redacted]�');
    expect(querystring.parse(outcome.body.value).cursor).toBe('[redacted]�');
    expect(new URLSearchParams(outcome.body.value).get('page')).toBe('2');
  });

  it('redacts a key with a literal +, which only the component readers keep as +', () => {
    const plusKey = ['fixture', 'provider+key', '0123456789'].join('-');
    for (const [value, redacted] of [[lastEscaped(plusKey), '[redacted]'], [lastEscaped(plusKey, '%C3'), '[redacted]%C3']] as const) {
      expect(receiversSeeing(value, plusKey)).toEqual(['component', 'node-component', 'bytes']);
      const outcome = run(`cursor=${value}&page=2`, {}, plusKey);
      expect(outcome).toMatchObject({ body: { kind: 'text', value: `cursor=${redacted}&page=2` }, redactions: 1 });
      if (outcome.body.kind === 'text') expect(receiversSeeing(outcome.body.value, plusKey)).toEqual([]);
    }
  });

  // A canary in a response is withheld whole, in the body and in an allowed header.
  const canaryForms: [string, string, Receiver[]][] = [
    ['the last character escaped, then a truncated lead byte', lastEscaped(decoy, '%C3'), ALL],
    ['a broken lead byte before the escaped first character', `%C3%${hex(decoy[0]!)}${decoy.slice(1)}`, ALL],
    ['every byte escaped, then an invalid byte', `${escapeAll(decoy)}%FF`, ALL],
    ['a low-byte alias of the first character, then a truncated lead byte', `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}%C3`, NODE],
  ];
  const canaryPlaces: Record<string, Position> = {
    ...positions,
    'an etag header': {
      ascii: true,
      send: (value) => ({ body: '', overrides: { headers: { etag: `"${value}"` } } }),
      read: (outcome) => outcome.headers.etag ?? 'missing',
      around: (value) => `"${value}"`,
    },
  };
  const canaryCases = canaryForms.flatMap(([label, value, readers]) => Object.entries(canaryPlaces)
    .filter(([, position]) => position.ascii === false || /^[\x00-\x7f]*$/.test(value))
    .map(([where, position]) => [`${label}, in ${where}`, position, value, readers] as const));

  it.each(canaryCases)('withholds a canary hidden as %s', (_label, position, value, readers) => {
    expect(receiversSeeing(position.around(value), decoy)).toEqual(readers);
    const { body, overrides } = position.send(value);
    expect(run(body, { ...overrides, canaries: buildCanarySet([decoy]) })).toEqual({
      status: 200, headers: {}, body: { kind: 'withheld', reason: 'canary' }, redactions: 0,
    });
  });

  it('withholds a minted decoy behind an invalid escape run', () => {
    const minted = mintCanary('api_key');
    const body = `cursor=${lastEscaped(minted, '%C3')}&page=2`;
    expect(receiversSeeing(body, minted)).toEqual(ALL);
    expect(run(body, { canaries: buildCanarySet([minted]) }).body).toEqual({ kind: 'withheld', reason: 'canary' });
  });

  // Node reads an upstream header's bytes as Latin-1 text. The agent can read the same bytes as UTF-8.
  const wire = (text: string) => Buffer.from(text, 'utf8').toString('latin1');
  it('redacts a header that carries the key only when its bytes are read as UTF-8', () => {
    const accented = ['fixture', 'cl\u00e9', 'provider', '0123'].join('-');
    const link = `<${url(wire(accented))}>; rel="next"`;
    expect(link).not.toContain(accented);
    expect(Buffer.from(link, 'latin1').toString('utf8')).toContain(accented);
    expect(run('', { headers: { link } }, accented)).toMatchObject({ headers: { link: '[redacted]' }, redactions: 1 });
    // The same bytes without the key pass unchanged.
    const other = `<${url(wire('caf\u00e9'))}>; rel="next"`;
    expect(run('', { headers: { link: other } }, accented)).toMatchObject({ headers: { link: other }, redactions: 0 });
  });

  it('withholds a canary that an allowed header carries only when its bytes are read as UTF-8', () => {
    const accented = ['fixture', 'caf\u00e9', 'canary', '0123'].join('-');
    const etag = `"${wire(accented)}"`;
    expect(etag).not.toContain(accented);
    expect(run('', { headers: { etag }, canaries: buildCanarySet([accented]) }).body).toEqual({ kind: 'withheld', reason: 'canary' });
    expect(run('', { headers: { etag: `"${wire('caf\u00e9')}"` }, canaries: buildCanarySet([accented]) }).body).toEqual({ kind: 'empty' });
  });

  // (b) No over-blocking: ordinary escapes, near misses and the key broken by an invalid byte.
  const harmless: [string, string][] = [
    ['a two-byte character', 'Ren%C3%A9e'],
    ['a form space', 'S%C3%A3o+Paulo'],
    ['an escaped percent sign', '100%25+sure'],
    ['a four-byte character', '%F0%9F%98%80'],
    ['literal non-ASCII with valid escapes', '東京%E2%82%AC+Ren%C3%A9e'],
    ['ordinary non-ASCII with a malformed escape', '東京タワー 100%FF'],
    ['a near miss: the last escape is another digit', lastEscaped(`${providerKey.slice(0, -1)}8`, '%C3')],
    ['an invalid byte inside the key', `${providerKey.slice(0, 8)}%C3${providerKey.slice(8)}`],
    ['an alias in a value decodeURIComponent accepts', `${lowByteAlias(providerKey[0]!)}${lastEscaped(providerKey.slice(1))}`],
  ];
  const harmlessCases = harmless.flatMap(([label, value]) => placed
    .filter(([, position]) => position.ascii === false || /^[\x00-\x7f]*$/.test(value))
    .map(([where, position]) => [`${label}, in ${where}`, position, value] as const));

  it.each(harmlessCases)('passes %s unchanged', (_label, position, value) => {
    expect(receiversSeeing(position.around(value), providerKey)).toEqual([]);
    const { body, overrides } = position.send(value);
    const outcome = run(body, { ...overrides, canaries: buildCanarySet([decoy]) });
    expect(outcome.redactions).toBe(0);
    expect(position.read(outcome)).toBe(position.around(value));
  });

  it('passes a body of ordinary escapes whole, as a receiver decodes it', () => {
    const body = 'name=Ren%C3%A9e&city=S%C3%A3o+Paulo&price=10%E2%82%AC&note=100%25+sure';
    const outcome = run(body, { contentType: 'application/x-www-form-urlencoded' });
    expect(outcome).toEqual({ status: 200, headers: {}, body: { kind: 'text', value: body }, redactions: 0 });
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ name: 'Renée', city: 'São Paulo', price: '10€', note: '100% sure' });
  });

  it.each([
    ['the provider key', providerKey],
    ['a key with + and a space', 'fixture+provider key-0123'],
  ])('hands over %s to no receiver, and changes nothing no receiver reads as it', (_label, keyValue) => {
    const random = seeded(0x0f05);
    let seen = 0;
    let nodeOnly = 0;
    for (let i = 0; i < 1500; i += 1) {
      const value = disguise(keyValue, random, random() < 0.4, random() < 0.35);
      const body = `cursor=${value}&page=2`;
      const readers = receiversSeeing(body, keyValue);
      const outcome = run(body, {}, keyValue);
      expect(outcome.body.kind, body).toBe('text');
      if (outcome.body.kind !== 'text') continue;
      expect(receiversSeeing(outcome.body.value, keyValue), body).toEqual([]);
      if (readers.length === 0) expect(outcome.body.value, body).toBe(body);
      else expect(outcome.redactions, body).toBeGreaterThan(0);
      if (readers.length) seen += 1;
      if (readers.length && readers.every((reader) => NODE.includes(reader))) nodeOnly += 1;
    }
    expect(seen).toBeGreaterThan(300);
    expect(seen).toBeLessThan(1400);
    expect(nodeOnly).toBeGreaterThan(25);
  });
});

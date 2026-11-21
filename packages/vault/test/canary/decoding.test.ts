import * as querystring from 'node:querystring';
import { describe, expect, it } from 'vitest';
import { buildCanarySet, mintCanary } from '../../src/canary/index.js';
import { DECODINGS, decodedView, decodingApplies } from '../../src/canary/encodings.js';
import { decoders, disguise, escapeAll, hex, lastEscaped, lowByteAlias, receiversSeeing, seeded, type Receiver } from '../support/receivers.js';

// Review F02 follow-up (task 01a1fe78; brief addenda 4 and 5). An escape run that was not valid
// UTF-8 used to be read raw as a whole, so `...012%33%C3` hid the `3` that every receiver decodes
// and the decoy got past the canary check. Node's decoders add a second class: when
// decodeURIComponent throws, they read each literal code unit by its low byte. These tests hold
// the decoded views to the decoders a receiver uses, and the matcher's verdict to what a receiver
// would read. Every value here is synthetic.

const decoy = ['fixture', 'canary', 'ABCdef0123'].join('-');
/** Node's exported fallback; @types/node does not declare it. */
const { unescapeBuffer } = querystring as unknown as { unescapeBuffer(text: string, spaces?: boolean): Buffer };
const ALL: Receiver[] = ['form', 'component', 'node-form', 'node-component', 'bytes'];
const NODE: Receiver[] = ['node-form', 'node-component'];

const EDGE_BYTES = [0x00, 0x09, 0x20, 0x25, 0x2b, 0x33, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xdf,
  0xe0, 0xe2, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];
const CODE_POINTS = ['é', '€', '😀', '\ufeff', '�', '\u{10FFFF}', '\ud7ff', '\ue000', '\u0080', '߿', 'ࠀ'];

/** Escapes biased to UTF-8's edges, valid sequences, literals and broken escapes, mixed. */
function escapedText(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const escape = (byte: number) => {
    const pair = byte.toString(16).padStart(2, '0');
    return `%${random() < 0.5 ? pair.toUpperCase() : pair}`;
  };
  const parts: string[] = [];
  for (let count = 1 + Math.floor(random() * 12); count > 0; count -= 1) {
    const roll = random();
    if (roll < 0.4) parts.push(escape(pick(EDGE_BYTES)));
    else if (roll < 0.6) parts.push([...Buffer.from(pick(CODE_POINTS), 'utf8')].map(escape).join(''));
    else if (roll < 0.75) parts.push(pick(['a', '3', '+', ' ', '-', '_']));
    else if (roll < 0.85) parts.push(pick(['é', '🔒', 'Ã', 'Ŧ', '東']));
    else if (roll < 0.92) parts.push(pick(['%', '%4', '%G1', '%%']));
    else parts.push(escape(Math.floor(random() * 256)));
  }
  return parts.join('');
}

describe('decoded views agree with the decoders a receiver uses', () => {
  it('each view equals the decoder it models: the WHATWG algorithm, and Node\'s byte fallback', () => {
    const random = seeded(0x01a1fe78);
    let invalid = 0;
    let nonAscii = 0;
    for (let run = 0; run < 3000; run += 1) {
      const source = escapedText(random);
      try { decodeURIComponent(source); } catch { invalid += 1; }
      if (/[^\x00-\x7f]/.test(source)) nonAscii += 1;
      expect(decodedView(source, 'url').text, source).toBe(decoders.form(source));
      expect(decodedView(source, 'uri').text, source).toBe(decoders.component(source));
      expect(decodedView(source, 'url-node').text, source).toBe(unescapeBuffer(source, true).toString('utf8'));
      expect(decodedView(source, 'uri-node').text, source).toBe(unescapeBuffer(source).toString('utf8'));
    }
    // Both kinds of input were exercised: runs that are valid UTF-8 and runs that are not, with and without literal non-ASCII.
    expect(invalid).toBeGreaterThan(1000);
    expect(3000 - invalid).toBeGreaterThan(300);
    expect(nonAscii).toBeGreaterThan(500);
  });

  it('every receiver reads the raw text or one of the views the matcher reads', () => {
    const random = seeded(0x7e57);
    let fallback = 0;
    for (let run = 0; run < 3000; run += 1) {
      const source = escapedText(random);
      const read = [source, ...DECODINGS.filter((encoding) => decodingApplies(source, encoding)).map((encoding) => decodedView(source, encoding).text)];
      for (const [name, decode] of Object.entries(decoders)) expect(read, `${name} ${source}`).toContain(decode(source));
      if (decodingApplies(source, 'url-node')) fallback += 1;
    }
    expect(fallback).toBeGreaterThan(300);
  });

  it('maps each decoded character to the whole sequence it came from, and the spans tile the source', () => {
    const random = seeded(0x5eed);
    for (let run = 0; run < 1500; run += 1) {
      const source = escapedText(random);
      for (const encoding of DECODINGS) {
        const view = decodedView(source, encoding);
        expect(view.starts).toHaveLength(view.text.length);
        expect(view.ends).toHaveLength(view.text.length);
        let cursor = 0;
        for (let i = 0; i < view.text.length;) {
          const start = view.starts[i]!;
          const end = view.ends[i]!;
          let next = i;
          while (next < view.text.length && view.starts[next] === start && view.ends[next] === end) next += 1;
          expect(start, `${encoding} ${source}`).toBe(cursor);
          expect(decodedView(source.slice(start, end), encoding).text, `${encoding} ${source}`).toBe(view.text.slice(i, next));
          cursor = end;
          i = next;
        }
        expect(cursor, `${encoding} ${source}`).toBe(source.length);
      }
    }
  });

  it('skips a WHATWG view only when it would equal one already read', () => {
    const random = seeded(0x0a11);
    for (let run = 0; run < 1500; run += 1) {
      const source = escapedText(random) + (random() < 0.2 ? '\\u0041\\n' : '');
      if (!decodingApplies(source, 'json')) expect(decodedView(source, 'json').text).toBe(source);
      if (!decodingApplies(source, 'url')) expect(decodedView(source, 'url').text).toBe(source);
      if (!decodingApplies(source, 'uri')) {
        expect(decodedView(source, 'uri').text).toBe(source.includes('%') ? decodedView(source, 'url').text : source);
      }
    }
  });
});

describe('canary matching follows what a receiver reads (Addendum 5)', () => {
  const set = buildCanarySet([decoy]);
  const contexts = (text: string) => [text, `note=${text}&page=2`, `{"callback":"https://collector.example/cb?token=${text}"}`];

  // (a) The decoy class: each receiver that decodes escapes reads the decoy; the raw text does not hold it.
  const decoyClass: [string, string][] = [
    ['a truncated two-byte sequence after the last character', lastEscaped(decoy, '%C3')],
    ['a truncated three-byte sequence', lastEscaped(decoy, '%E2%82')],
    ['a truncated four-byte sequence', lastEscaped(decoy, '%F0%9F%98')],
    ['a lone continuation byte', lastEscaped(decoy, '%80')],
    ['a byte that is never UTF-8', lastEscaped(decoy, '%FF')],
    ['a broken lead before the first character', `%C3%${hex(decoy[0]!)}${decoy.slice(1)}`],
    ['every character escaped, then an invalid byte', `${escapeAll(decoy)}%FF`],
    ['lowercase escapes between overlong pairs', `%c0%af${escapeAll(decoy, true)}%c0%af`],
    ['an encoded surrogate before it', `%ED%A0%80${escapeAll(decoy)}`],
  ];
  it.each(decoyClass)('finds a decoy behind %s', (_label, text) => {
    expect(text.includes(decoy)).toBe(false);
    expect(receiversSeeing(text, decoy)).toEqual(ALL);
    for (const context of contexts(text)) {
      expect(set.matches(context), context).toBe(true);
      expect(set.matches(Buffer.from(context)), context).toBe(true);
    }
  });

  // (a) Node's class: only Node's decoders read the decoy, and only because decodeURIComponent throws on the value.
  const astral = String.fromCharCode(0xd800 | decoy.charCodeAt(0), 0xdc00 | decoy.charCodeAt(1));
  const nodeClass: [string, string, Receiver[]][] = [
    ['a character whose low byte is the first one, then an invalid byte', `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}%FF`, NODE],
    ['an astral character whose surrogates spell the first two', `${astral}${decoy.slice(2)}%C3`, NODE],
    ['aliases throughout, with an escaped character and a truncated sequence',
      `${[...decoy.slice(0, -1)].map((char, i) => (i % 3 ? char : lowByteAlias(char, 0x4e))).join('')}%${hex(decoy.slice(-1))}%E2%82`, NODE],
    ['an alias and a stray % that decodeURIComponent refuses', `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}%`, ['node-component']],
  ];
  it.each(nodeClass)('finds a decoy behind %s', (_label, text, readers) => {
    expect(receiversSeeing(text, decoy)).toEqual(readers);
    for (const context of contexts(text)) {
      expect(set.matches(context), context).toBe(true);
      expect(set.matches(Buffer.from(context)), context).toBe(true);
    }
  });

  it('finds a decoy completed by a literal Latin-1 lead byte and an escaped continuation', () => {
    const value = ['fixture', 'café', 'canary', '0123'].join('-');
    const text = value.replace('é', 'Ã%A9');
    expect(receiversSeeing(text, value)).toEqual(NODE);
    expect(buildCanarySet([value]).matches(`note=${text}`)).toBe(true);
  });

  it.each(['api_key', 'password', 'card'] as const)('finds a freshly minted %s decoy behind a truncated sequence or an alias', (kind) => {
    const value = mintCanary(kind);
    const values = buildCanarySet([value]);
    expect(receiversSeeing(lastEscaped(value, '%C3'), value)).toEqual(ALL);
    expect(values.matches(`note=${lastEscaped(value, '%C3')}`)).toBe(true);
    const aliased = `${lowByteAlias(value[0]!)}${value.slice(1)}%C3`;
    expect(receiversSeeing(aliased, value)).toEqual(NODE);
    expect(values.matches(`note=${aliased}`)).toBe(true);
  });

  // Canary values come from the operator's file, so a decoy can hold `+` or a space. A form parser
  // reads `+` as a space and a component decoder keeps it, so each needs its own view.
  it.each([
    ['a literal + kept by a component decoder', ['fixture+canary', 'ABCdef0123'].join('-'), (value: string) => lastEscaped(value), ['component', 'node-component', 'bytes']],
    ['a space sent as + to a form parser', ['fixture canary', 'ABCdef0123'].join('-'), (value: string) => lastEscaped(value.replace(' ', '+')), ['form', 'node-form']],
    ['an escaped + with a literal +', 'fixture+canary+ABCdef0123', (value: string) => value.replace('+', '%2B'), ['component', 'node-component', 'bytes']],
    ['a space as + with an alias, to Node\'s form parser', ['fixture canary', 'ABCdef0123'].join('-'), (value: string) => `${lowByteAlias('f')}${value.slice(1).replace(' ', '+')}%C3`, ['node-form']],
    ['a literal + with an alias, to querystring.unescape', ['fixture+canary', 'ABCdef0123'].join('-'), (value: string) => `${lowByteAlias('f')}${value.slice(1)}%C3`, ['node-component']],
  ] as const)('finds a decoy written with %s', (_label, value, write, readers) => {
    const text = write(value);
    expect(receiversSeeing(text, value)).toEqual(readers);
    expect(buildCanarySet([value]).matches(text)).toBe(true);
  });

  // (b) No over-blocking: valid escapes, near misses and a decoy broken by an invalid byte, which no receiver reads as the decoy.
  const harmless: [string, string, string, string][] = [
    ['a two-byte character', 'Ren%C3%A9e', 'Renée', 'Renée'],
    ['an escaped space', 'S%C3%A3o%20Paulo', 'São Paulo', 'São Paulo'],
    ['a form space', 'S%C3%A3o+Paulo', 'São Paulo', 'São+Paulo'],
    ['an escaped percent sign', '100%25+sure', '100% sure', '100%+sure'],
    ['a four-byte character', '%F0%9F%98%80', '😀', '😀'],
    ['lowercase escapes', 'caf%c3%a9', 'café', 'café'],
    ['literal non-ASCII with valid escapes', '東京%E2%82%AC+Ren%C3%A9e', '東京€ Renée', '東京€+Renée'],
    ['a near miss: the last escape is another digit', lastEscaped(`${decoy.slice(0, -1)}4`, '%C3'), `${decoy.slice(0, -1)}4�`, `${decoy.slice(0, -1)}4�`],
    ['an invalid byte inside the decoy', `${decoy.slice(0, 10)}%C3${decoy.slice(10)}`, `${decoy.slice(0, 10)}�${decoy.slice(10)}`, `${decoy.slice(0, 10)}�${decoy.slice(10)}`],
    ['an alias in a value decodeURIComponent accepts', `${lowByteAlias(decoy[0]!)}${lastEscaped(decoy.slice(1))}`, `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}`, `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}`],
  ];
  it.each(harmless)('passes %s', (_label, text, form, component) => {
    expect(decoders.form(text)).toBe(form);
    expect(decoders.component(text)).toBe(component);
    // Node agrees with the WHATWG decoders wherever decodeURIComponent accepts the value, or it is ASCII.
    expect(decoders['node-form'](text)).toBe(form);
    expect(decoders['node-component'](text)).toBe(component);
    expect(receiversSeeing(text, decoy)).toEqual([]);
    expect(set.matches(text)).toBe(false);
    expect(set.matches(`note=${text}&page=2`)).toBe(false);
  });

  it('passes ordinary non-ASCII text with a malformed escape, which Node reads by low bytes', () => {
    const text = '東京タワー 100%FF';
    expect(decoders['node-component'](text)).not.toBe(decoders.component(text));
    expect(receiversSeeing(text, decoy)).toEqual([]);
    expect(set.matches(`note=${text}&page=2`)).toBe(false);
  });

  it.each([
    ['a plain decoy', decoy],
    ['a decoy with + and a space', 'fixture+canary value-0123'],
    ['a minted API key decoy', mintCanary('api_key')],
  ])('matches exactly when some receiver reads %s', (_label, value) => {
    const values = buildCanarySet([value]);
    const random = seeded(0x0f02);
    let seen = 0;
    let nodeOnly = 0;
    for (let run = 0; run < 3000; run += 1) {
      const text = disguise(value, random, random() < 0.4, random() < 0.35);
      const readers = receiversSeeing(text, value);
      expect(values.matches(text), text).toBe(readers.length > 0);
      if (readers.length) seen += 1;
      if (readers.length && readers.every((reader) => NODE.includes(reader))) nodeOnly += 1;
    }
    expect(seen).toBeGreaterThan(600);
    expect(seen).toBeLessThan(2800);
    expect(nodeOnly).toBeGreaterThan(50);
  });
});

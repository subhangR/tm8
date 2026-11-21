import { unescape as querystringUnescape } from 'node:querystring';

/**
 * How a downstream receiver reads percent-encoded text it is sent (review F02 follow-up,
 * task 01a1fe78; brief addendum 5). Each model is a platform decoder, or the WHATWG algorithm on
 * the platform's TextDecoder, never the vault's own code, so a test that asserts what a receiver
 * sees does not grade the vault against itself.
 * - raw: a receiver that does not decode the field at all.
 * - form: the WHATWG application/x-www-form-urlencoded parser, as browsers, Bun and Deno run it
 *   and Python's parse_qs reads it: `+` is a space; escapes are UTF-8, each invalid run replaced.
 * - component: the same with `+` kept, as Python's unquote reads it.
 * - node-form: Node's URLSearchParams; querystring.parse and Express's urlencoded parser read the same.
 * - node-component: Node's querystring.unescape.
 *   Both Node decoders run decodeURIComponent and, when it throws, fall back to a byte decoder
 *   that reads each literal UTF-16 code unit by its low byte: `Ŧ` reads as `f`.
 * - bytes: a byte-level percent decoder, like Go's QueryUnescape or PHP's rawurldecode, which
 *   keeps invalid bytes as they are.
 */
export type Receiver = 'raw' | 'form' | 'component' | 'node-form' | 'node-component' | 'bytes';

export function percentDecodeBytes(text: string): Buffer {
  const source = Buffer.from(text, 'utf8');
  const out: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const pair = source.subarray(i + 1, i + 3).toString('latin1');
    if (source[i] === 0x25 && /^[0-9a-f]{2}$/i.test(pair)) { out.push(parseInt(pair, 16)); i += 2; } else out.push(source[i]!);
  }
  return Buffer.from(out);
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

export const decoders: Record<Exclude<Receiver, 'bytes'>, (text: string) => string> = {
  raw: (text) => text,
  form: (text) => utf8.decode(percentDecodeBytes(text.replace(/\+/g, ' '))),
  component: (text) => utf8.decode(percentDecodeBytes(text)),
  // Literal `&` would split the pair; escaping it keeps the whole text as one value.
  'node-form': (text) => new URLSearchParams(`v=${text.replace(/&/g, '%26')}`).get('v')!,
  'node-component': (text) => querystringUnescape(text),
};

/** The receivers that would find `value` in `text`, in a fixed order. */
export function receiversSeeing(text: string, value: string): Receiver[] {
  const seen: Receiver[] = (Object.keys(decoders) as (keyof typeof decoders)[]).filter((name) => decoders[name](text).includes(value));
  if (percentDecodeBytes(text).includes(Buffer.from(value, 'utf8'))) seen.push('bytes');
  return seen;
}

/** Every character as an escape, in upper or lower hex. */
export function escapeAll(value: string, lower = false): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const escaped = hex.replace(/(..)/g, '%$1');
  return lower ? escaped : escaped.toUpperCase();
}

/** A character's UTF-8 bytes in upper-case hex. */
export const hex = (char: string): string => Buffer.from(char, 'utf8').toString('hex').toUpperCase();

/** The value with its last character escaped, then `tail`. */
export const lastEscaped = (value: string, tail = ''): string => `${value.slice(0, -1)}%${hex(value.slice(-1))}${tail}`;

/** A character whose low byte is `char`'s: Node's fallback reads it as `char` (see above). */
export function lowByteAlias(char: string, high = 0x01): string {
  return String.fromCharCode(high * 0x100 + char.charCodeAt(0));
}

/** A seeded generator, so a failing case can be replayed. */
export function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The value written with random escapes, aliases and invalid runs around it, and optionally inside it. */
export function disguise(value: string, random: () => number, broken: boolean, aliases: boolean): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const invalid = ['%C3', '%E2%82', '%F0%9F%98', '%80', '%BF', '%FF', '%C0%AF', '%ED%A0%80', '%F4%90%80%80', '%e0%80%af'];
  const noise = () => {
    const roll = random();
    return roll < 0.5 ? pick(invalid) : roll < 0.7 ? pick(['%C3%A9', '%E2%82%AC', '%F0%9F%98%80']) : pick(['x', '_', ' ', '+', 'é', 'Ã', '東']);
  };
  const write = (char: string) => {
    if (aliases && char < '\u0080' && random() < 0.15) return lowByteAlias(char, 1 + Math.floor(random() * 0xd7));
    const roll = random();
    if (char === ' ' && roll < 0.3) return '+';
    if (roll < 0.45) return char;
    return [...Buffer.from(char, 'utf8')].map((byte) => {
      const pair = byte.toString(16).padStart(2, '0');
      return `%${random() < 0.6 ? pair.toUpperCase() : pair}`;
    }).join('');
  };
  const out: string[] = [];
  for (let count = Math.floor(random() * 3); count > 0; count -= 1) out.push(noise());
  const inside = broken ? 1 + Math.floor(random() * (value.length - 1)) : -1;
  [...value].forEach((char, i) => { if (i === inside) out.push(noise()); out.push(write(char)); });
  for (let count = Math.floor(random() * 3); count > 0; count -= 1) out.push(noise());
  return out.join('');
}

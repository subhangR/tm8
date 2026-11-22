/** Internal shared encoding vocabulary; the filter and canaries must agree. */
export interface EncodedPattern {
  text: string;
  /** A base64 match contains only sextets wholly determined by the value. */
  base64?: { left: number; width: number };
}

export interface Span { start: number; end: number }

export interface DecodedView {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * The single-layer decodings a receiver may apply to text it is sent. The canary matcher and
 * the response filter read the same views, after the raw text.
 * - `json`: JSON string escapes.
 * - `url`: form decoding, as the WHATWG URLSearchParams and form parsers do it: `+` is a space.
 * - `uri`: component decoding, as decodeURIComponent, Python's unquote and Go's PathUnescape do
 *   it: `+` stays `+`. Without it, a value that mixes a literal `+` with escapes would be read as
 *   a space by every view (review F02 follow-up).
 * - `url-node`, `uri-node`: Node's URLSearchParams, querystring.parse (Express's urlencoded
 *   parser) and querystring.unescape run decodeURIComponent, and when it throws on a value they
 *   fall back to a byte decoder that reads each literal UTF-16 code unit by its low byte. So
 *   `\u0166ixture...%FF` reads as `fixture...`, and a literal `\u00c3` completes an escaped
 *   continuation byte. These views read that fallback, with `+` as a space and as itself.
 */
export const DECODINGS = ['json', 'url', 'uri', 'url-node', 'uri-node'] as const;
export type Decoding = typeof DECODINGS[number];

/** False when no receiver reads the view or it would equal one already read, so the pass can be skipped. */
export function decodingApplies(text: string, encoding: Decoding): boolean {
  if (encoding === 'json') return text.includes('\\');
  if (encoding === 'url') return text.includes('%') || text.includes('+');
  if (encoding === 'uri') return text.includes('%') && text.includes('+');
  // Node falls back only where decodeURIComponent throws, and the fallback reads ASCII exactly as
  // `url` and `uri` do. For a value with no valid escape URLSearchParams decodes nothing, so there
  // `url-node` reads more than it does; that can only match more.
  if (!/[^\x00-\x7f]/.test(text) || !escapesMalformed(text)) return false;
  return encoding === 'url-node' || text.includes('+');
}

type Push = (value: string, start: number, end: number) => void;

const hexPair = (source: string, at: number): boolean => /^[0-9a-f]{2}$/i.test(source.slice(at + 1, at + 3));

/**
 * The WHATWG UTF-8 decoder, with replacement: each valid sequence decodes, and each maximal
 * invalid subpart becomes one U+FFFD. This is what URLSearchParams, TextDecoder, Node's Buffer
 * and Python's unquote produce, and a byte-oriented receiver (Go, PHP) keeps the same valid
 * bytes. Byte k starts at source offset `offset(k)`; the last ends at `offset(bytes.length)`.
 * Returns false when any subpart was invalid.
 *
 * Review F02 follow-up (task 01a1fe78). A run of escapes used to be decoded with a fatal decoder
 * and kept raw whenever any byte in it was invalid. So `...012%33%C3` hid the `3` that every
 * receiver decodes, and a decoy ending in `3` passed the canary check and the filter.
 */
function decodeBytes(bytes: readonly number[], offset: (k: number) => number, push: Push): boolean {
  let valid = true;
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at]!;
    let needed = 0;
    let point = lead;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) { needed = 1; point = lead & 0x1f; }
    else if (lead >= 0xe0 && lead <= 0xef) {
      needed = 2; point = lead & 0x0f;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      needed = 3; point = lead & 0x07;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else if (lead > 0x7f) needed = -1;
    let next = at + 1;
    for (let seen = 0; needed > 0 && seen < needed; seen += 1, next += 1) {
      const byte = bytes[next];
      // A byte outside the range ends the sequence unconsumed: it starts the next one.
      if (byte === undefined || byte < lower || byte > upper) { needed = -1; break; }
      point = (point << 6) | (byte & 0x3f);
      lower = 0x80; upper = 0xbf;
    }
    if (needed < 0) valid = false;
    push(needed < 0 ? '\uFFFD' : String.fromCodePoint(point), offset(at), offset(next));
    at = next;
  }
  return valid;
}

/** True where decodeURIComponent throws: a `%` without two hex digits, or escapes that are not UTF-8. */
function escapesMalformed(text: string): boolean {
  for (let i = text.indexOf('%'); i >= 0; i = text.indexOf('%', i)) {
    if (!hexPair(text, i)) return true;
    const bytes: number[] = [];
    while (text[i] === '%' && hexPair(text, i)) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 3; }
    try { if (!decodeBytes(bytes, () => 0, () => undefined)) return true; } finally { bytes.fill(0); }
  }
  return false;
}

/**
 * Node's fallback, querystring.unescapeBuffer read as UTF-8: one byte per escape and one per
 * literal UTF-16 code unit, its low byte, with `+` as a space when `spaces`. A lone surrogate
 * reads by its low byte too, where a sender's UTF-8 encoder would have sent U+FFFD: more than a
 * receiver reads, so it can only match more.
 */
function nodeFallback(source: string, spaces: boolean, push: Push): void {
  const bytes: number[] = [];
  const offsets: number[] = [];
  try {
    for (let i = 0; i < source.length;) {
      offsets.push(i);
      if (source[i] === '%' && hexPair(source, i)) { bytes.push(parseInt(source.slice(i + 1, i + 3), 16)); i += 3; }
      else { bytes.push(spaces && source[i] === '+' ? 0x20 : source.charCodeAt(i) & 0xff); i += 1; }
    }
    offsets.push(source.length);
    decodeBytes(bytes, (k) => offsets[k]!, push);
  } finally { bytes.fill(0); }
}

/** One decoding pass, with UTF-16 source coordinates for redaction. */
export function decodedView(source: string, encoding: Decoding): DecodedView {
  const chunks: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push: Push = (value, start, end) => {
    chunks.push(value);
    for (let j = 0; j < value.length; j += 1) { starts.push(start); ends.push(end); }
  };
  if (encoding === 'url-node' || encoding === 'uri-node') {
    nodeFallback(source, encoding === 'url-node', push);
    return { text: chunks.join(''), starts, ends };
  }
  for (let i = 0; i < source.length;) {
    if (encoding === 'json' && source[i] === '\\') {
      const escaped = source[i + 1];
      if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(i + 2, i + 6))) {
        push(String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16)), i, i + 6); i += 6; continue;
      }
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escaped !== undefined && Object.hasOwn(simple, escaped)) {
        push(simple[escaped]!, i, i + 2); i += 2; continue;
      }
    }
    if (encoding !== 'json' && source[i] === '%' && hexPair(source, i)) {
      const start = i;
      const bytes: number[] = [];
      while (source[i] === '%' && hexPair(source, i)) { bytes.push(parseInt(source.slice(i + 1, i + 3), 16)); i += 3; }
      try { decodeBytes(bytes, (k) => start + k * 3, push); } finally { bytes.fill(0); }
      continue;
    }
    push(encoding === 'url' && source[i] === '+' ? ' ' : source[i]!, i, i + 1); i += 1;
  }
  return { text: chunks.join(''), starts, ends };
}

export function sourceSpan(view: DecodedView, span: Span): Span {
  return { start: view.starts[span.start]!, end: view.ends[span.end - 1]! };
}

export function encodedPatterns(value: string): EncodedPattern[] {
  const patterns: EncodedPattern[] = [];
  const seen = new Set<string>();
  const add = (text: string, base64?: EncodedPattern['base64']) => {
    if (!text) return;
    const id = `${base64?.left ?? -1}:${base64?.width ?? -1}:${text}`;
    if (!seen.has(id)) { seen.add(id); patterns.push({ text, ...(base64 ? { base64 } : {}) }); }
  };
  const bytes = Buffer.from(value, 'utf8');
  try {
    add(value);
    const hex = bytes.toString('hex');
    add(hex); add(hex.toUpperCase());
    const uri = encodeURIComponent(value);
    const form = new URLSearchParams({ v: value }).toString().slice(2);
    for (const encoded of [uri, uri.replace(/%20/g, '+'), form]) {
      add(encoded);
      add(encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    }
    const json = JSON.stringify(value).slice(1, -1);
    add(json); add(json.replace(/\//g, '\\/'));
    // Also accept JSON serializers that escape every UTF-16 code unit.
    const escaped = Array.from({ length: value.length }, (_, i) =>
      `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');
    add(escaped); add(escaped.replace(/[a-f]/g, (letter) => letter.toUpperCase()));
    for (let alignment = 0; alignment < 3; alignment += 1) {
      const prefixed = Buffer.concat([Buffer.alloc(alignment), bytes]);
      try {
        const left = Math.ceil(alignment * 8 / 6);
        const end = Math.floor((alignment + bytes.length) * 8 / 6);
        const width = Math.ceil((alignment + bytes.length) / 3) * 4;
        const known = prefixed.toString('base64').slice(left, end);
        add(known, { left, width });
        add(known.replace(/\+/g, '-').replace(/\//g, '_'), { left, width });
      } finally { prefixed.fill(0); }
    }
    return patterns;
  } finally { bytes.fill(0); }
}

interface Node {
  next: Map<string, number>;
  fail: number;
  output: number[];
  outputLink: number;
  terminal: boolean;
}

/**
 * Aho-Corasick, with output links instead of copying suffix output lists.
 * Scanning is O(n) for has(), O(n + z) for occurrences(), independent of the
 * number/length of patterns. Space is O(p), where p is total pattern length.
 * Construction's conservative sparse-transition bound is O(p * longestPattern).
 */
export function compileMatcher(patterns: readonly EncodedPattern[]) {
  const makeNode = (): Node => ({ next: new Map(), fail: 0, output: [], outputLink: 0, terminal: false });
  const nodes: Node[] = [makeNode()];
  patterns.forEach(({ text }, id) => {
    let state = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      let child = nodes[state]!.next.get(char);
      if (child === undefined) {
        child = nodes.length; nodes.push(makeNode()); nodes[state]!.next.set(char, child);
      }
      state = child;
    }
    nodes[state]!.output.push(id); nodes[state]!.terminal = true;
  });
  const queue = [...nodes[0]!.next.values()];
  for (let i = 0; i < queue.length; i += 1) {
    const state = queue[i]!;
    for (const [char, child] of nodes[state]!.next) {
      let fail = nodes[state]!.fail;
      while (fail && !nodes[fail]!.next.has(char)) fail = nodes[fail]!.fail;
      const target = nodes[fail]!.next.get(char) ?? 0;
      nodes[child]!.fail = target;
      nodes[child]!.terminal ||= nodes[target]!.terminal;
      nodes[child]!.outputLink = nodes[target]!.output.length ? target : nodes[target]!.outputLink;
      queue.push(child);
    }
  }
  function advance(state: number, char: string): number {
    while (state && !nodes[state]!.next.has(char)) state = nodes[state]!.fail;
    return nodes[state]!.next.get(char) ?? 0;
  }
  return {
    has(text: string): boolean {
      let state = 0;
      for (let i = 0; i < text.length; i += 1) {
        state = advance(state, text[i]!);
        if (nodes[state]!.terminal) return true;
      }
      return false;
    },
    occurrences(text: string): Span[] {
      const spans: Span[] = [];
      let state = 0;
      for (let i = 0; i < text.length; i += 1) {
        state = advance(state, text[i]!);
        for (let output = state; output; output = nodes[output]!.outputLink) {
          for (const id of nodes[output]!.output) {
            const pattern = patterns[id]!;
            let start = i + 1 - pattern.text.length;
            let end = i + 1;
            if (pattern.base64) {
              const desiredStart = start - pattern.base64.left;
              const desiredEnd = desiredStart + pattern.base64.width;
              // Widen only across base64 characters, never into adjacent JSON
              // punctuation. URL-safe unpadded final quanta can be shorter.
              while (start > Math.max(0, desiredStart) && /[A-Za-z0-9+/_-]/.test(text[start - 1]!)) start -= 1;
              while (end < Math.min(text.length, desiredEnd) && /[A-Za-z0-9+/_=-]/.test(text[end]!)) end += 1;
            }
            spans.push({ start, end });
          }
        }
      }
      return spans;
    },
  };
}

export function mergeSpans(spans: readonly Span[], length: number): Span[] {
  const sorted = spans.filter(({ start, end }) =>
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= length)
    .map((span) => ({ ...span })).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

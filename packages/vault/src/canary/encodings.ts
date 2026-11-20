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

/** One decoding pass, with UTF-16 source coordinates for redaction. */
export function decodedView(source: string, encoding: 'json' | 'url'): DecodedView {
  const chunks: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (value: string, start: number, end: number) => {
    chunks.push(value);
    for (let j = 0; j < value.length; j += 1) { starts.push(start); ends.push(end); }
  };
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
    if (encoding === 'url' && source[i] === '%' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
      const start = i;
      const bytes: number[] = [];
      while (source[i] === '%' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
        bytes.push(parseInt(source.slice(i + 1, i + 3), 16)); i += 3;
      }
      const buffer = Buffer.from(bytes);
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
        let offset = start;
        for (const char of decoded) {
          const end = offset + Buffer.byteLength(char) * 3;
          push(char, offset, end); offset = end;
        }
      } catch {
        for (let at = start; at < i; at += 1) push(source[at]!, at, at + 1);
      } finally { buffer.fill(0); }
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

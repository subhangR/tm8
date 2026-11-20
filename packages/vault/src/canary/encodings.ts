/** Internal shared encoding vocabulary; the filter and canaries must agree. */
export interface EncodedPattern {
  text: string;
  /** A base64 match contains only sextets wholly determined by the value. */
  base64?: { left: number; width: number };
}

export interface Span { start: number; end: number }

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

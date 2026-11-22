/**
 * Aho-Corasick membership matcher. Preview metadata must not accidentally repeat
 * a secret copied into a name/username, including a secret from a later row.
 * Only patterns that can fit in a metadata field need to be indexed.
 */
interface Node { next: Map<string, number>; fail: number; hit: boolean }

export function previewGuard(values: Iterable<string>): (text: string) => boolean {
  const nodes: Node[] = [{ next: new Map(), fail: 0, hit: false }];
  const add = (value: string) => {
    if (value.length === 0 || value.length > 512) return;
    let state = 0;
    for (const ch of value) {
      let next = nodes[state]!.next.get(ch);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.next.set(ch, next);
        nodes.push({ next: new Map(), fail: 0, hit: false });
      }
      state = next;
    }
    nodes[state]!.hit = true;
  };
  for (const value of values) {
    // The raw limit also avoids encoding bodies too long to fit in a preview.
    if (value.length === 0 || value.length > 512) continue;
    add(value);
    const bytes = Buffer.from(value, 'utf8');
    try {
      add(bytes.toString('base64'));
      add(bytes.toString('base64url'));
      add(bytes.toString('hex'));
      add(bytes.toString('hex').toUpperCase());
      try { add(encodeURIComponent(value)); } catch { /* Lone JSON surrogates have no URL encoding. */ }
    } finally { bytes.fill(0); }
  }
  const queue = [...nodes[0]!.next.values()];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor]!;
    for (const [ch, child] of nodes[parent]!.next) {
      let fallback = nodes[parent]!.fail;
      while (fallback !== 0 && !nodes[fallback]!.next.has(ch)) fallback = nodes[fallback]!.fail;
      nodes[child]!.fail = nodes[fallback]!.next.get(ch) ?? 0;
      nodes[child]!.hit ||= nodes[nodes[child]!.fail]!.hit;
      queue.push(child);
    }
  }
  return (text) => {
    let state = 0;
    for (const ch of text) {
      while (state !== 0 && !nodes[state]!.next.has(ch)) state = nodes[state]!.fail;
      state = nodes[state]!.next.get(ch) ?? 0;
      if (nodes[state]!.hit) return true;
    }
    return false;
  };
}

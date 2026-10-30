/**
 * `diff -u` text for two stored tool sources, with no dependency and no I/O.
 *
 * Lines keep their terminator, so a source that only gained or lost its final
 * newline is a changed line (printed with `\ No newline at end of file`, as
 * GNU diff does) rather than an empty diff. The common prefix and suffix are
 * trimmed first; Myers' O(ND) walk handles the middle. Past MAX_EDITS the
 * middle is replaced wholesale: still a correct diff, never a minimal one, and
 * it keeps memory bounded when a 256 KiB source is rewritten end to end.
 */
type Op = { op: ' ' | '-' | '+'; line: string };

const MAX_EDITS = 2000;

function splitLines(text: string): string[] {
  const lines = text.split('\n').map((line, index, all) => index < all.length - 1 ? `${line}\n` : line);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const replaced = (a: readonly string[], b: readonly string[]): Op[] =>
  [...a.map(line => ({ op: '-' as const, line })), ...b.map(line => ({ op: '+' as const, line }))];

function middle(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length, m = b.length, limit = Math.min(n + m, MAX_EDITS), offset = limit + 1;
  if (!n || !m) return replaced(a, b);
  // v[offset + k] is the furthest x reached on diagonal k; trace[d] keeps the
  // slice [-d-1, d+1] step d reads, which is all the walk back needs.
  const v = new Int32Array(2 * limit + 3), trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= limit && !done; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  if (!done) return replaced(a, b);
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const at = (k: number): number => trace[d]![k + d + 1]!;
    const k = x - y;
    const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(previous), py = px - previous;
    while (x > px && y > py) { x--; y--; ops.push({ op: ' ', line: a[x]! }); }
    // The one edit of step d: down from diagonal k+1 inserts, right from k-1 deletes.
    if (d > 0 && x === px) { y--; ops.push({ op: '+', line: b[y]! }); }
    else if (d > 0) { x--; ops.push({ op: '-', line: a[x]! }); }
  }
  return ops.reverse();
}

/** GNU's range spelling: an empty range names the line before it, a single line omits its count. */
const range = (start: number, count: number): string => count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`;

/** Unified diff of `before` → `after`; the empty string when the two are identical. */
export function unifiedDiff(before: string, after: string, labels: { from: string; to: string }, context = 3): string {
  const a = splitLines(before), b = splitLines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return '';
  const ops: Op[] = [...a.slice(0, start).map(line => ({ op: ' ' as const, line })),
    ...middle(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(line => ({ op: ' ' as const, line }))];
  const oldAt: number[] = [], newAt: number[] = [];
  let lineA = 0, lineB = 0;
  for (const { op } of ops) { oldAt.push(lineA); newAt.push(lineB); if (op !== '+') lineA++; if (op !== '-') lineB++; }
  const changes = ops.flatMap(({ op }, index) => op === ' ' ? [] : [index]);
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  for (let index = 0; index < changes.length; index++) {
    const first = changes[index]!;
    // Two changes share a hunk when the context between them would touch.
    while (index + 1 < changes.length && changes[index + 1]! - changes[index]! <= 2 * context + 1) index++;
    const from = Math.max(0, first - context), to = Math.min(ops.length, changes[index]! + context + 1);
    const hunk = ops.slice(from, to);
    out.push(`@@ -${range(oldAt[from]!, hunk.filter(({ op }) => op !== '+').length)} +${range(newAt[from]!, hunk.filter(({ op }) => op !== '-').length)} @@`);
    for (const { op, line } of hunk) {
      out.push(`${op}${line.endsWith('\n') ? line.slice(0, -1) : line}`);
      if (!line.endsWith('\n')) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}

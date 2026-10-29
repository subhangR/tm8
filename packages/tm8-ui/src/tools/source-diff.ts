/**
 * Two stored sources → the unified diff text `kit/DiffView` renders, so a tool's
 * version compare reuses the one diff renderer instead of forking a second one.
 *
 * Myers' O(ND) line diff after trimming the common prefix and suffix, which is
 * where an ordinary edit spends nearly all of its lines. Past `maxEdits` the
 * changed middle is shown as one replacement: still exact, just not minimal.
 */
export type SourceEdit = { kind: 'context' | 'del' | 'add'; text: string };

export function sourceLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The shortest edit script of the middle, or null once it needs more than `maxEdits` edits. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): SourceEdit[] | null {
  const n = a.length, m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // Only k in [-d-1, d+1] is read at step d, so each step keeps just that window.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], depth: number): SourceEdit[] {
  const out: SourceEdit[] = [];
  let x = a.length, y = b.length;
  for (let d = depth; d > 0; d -= 1) {
    const window = trace[d]!;
    const at = (k: number) => window[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK), previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; out.push({ kind: 'context', text: a[x]! }); }
    if (x === previousX) { y -= 1; out.push({ kind: 'add', text: b[y]! }); }
    else { x -= 1; out.push({ kind: 'del', text: a[x]! }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; out.push({ kind: 'context', text: a[x]! }); }
  return out.reverse();
}

export function diffSourceLines(before: readonly string[], after: readonly string[], maxEdits = 1000): SourceEdit[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const a = before.slice(start, endBefore), b = after.slice(start, endAfter);
  const middle = myers(a, b, maxEdits) ?? [
    ...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text })),
  ];
  return [
    ...before.slice(0, start).map(text => ({ kind: 'context' as const, text })), ...middle,
    ...before.slice(endBefore).map(text => ({ kind: 'context' as const, text })),
  ];
}

/** `git diff -U<context>`-shaped text for one file; empty when the line sequences match. */
export function unifiedSourceDiff(before: string, after: string, paths: { from: string; to: string }, context = 3): string {
  const edits = diffSourceLines(sourceLines(before), sourceLines(after));
  const changed = edits.flatMap((edit, index) => edit.kind === 'context' ? [] : [index]);
  if (!changed.length) return '';
  // Group changes whose context windows touch into one hunk.
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context), to = Math.min(edits.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  // 1-based line numbers of the first old/new line at each edit index.
  const oldAt: number[] = [], newAt: number[] = [];
  let oldLine = 1, newLine = 1;
  for (const edit of edits) {
    oldAt.push(oldLine); newAt.push(newLine);
    if (edit.kind !== 'add') oldLine += 1;
    if (edit.kind !== 'del') newLine += 1;
  }
  const out = [`--- a/${paths.from}`, `+++ b/${paths.to}`];
  for (const [from, to] of ranges) {
    const slice = edits.slice(from, to + 1);
    const oldCount = slice.filter(edit => edit.kind !== 'add').length;
    const newCount = slice.filter(edit => edit.kind !== 'del').length;
    // An empty side names the line before it, as diff -u does (`-0,0` for an insertion at the top).
    const oldStart = oldCount ? oldAt[from]! : oldAt[from]! - 1;
    const newStart = newCount ? newAt[from]! : newAt[from]! - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const edit of slice) out.push(`${edit.kind === 'add' ? '+' : edit.kind === 'del' ? '-' : ' '}${edit.text}`);
  }
  return `${out.join('\n')}\n`;
}

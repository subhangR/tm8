import { describe, expect, it } from 'vitest';
import {
  buildSubsetPatch,
  digestHunks,
  parseUnifiedDiff,
  selectHunks,
} from '../src/worktree/hunks.js';

/**
 * A two-hunk diff shaped like git's own output. Hunk 1 ADDS two lines, which
 * is what makes hunk 2's `newStart` (12) differ from its `oldStart` (10) —
 * the offset the subset builder has to put back when hunk 1 is dropped.
 */
const TWO_HUNKS = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@ export function app() {',
  ' const a = 1;',
  '+const added1 = 1;',
  '+const added2 = 2;',
  ' const b = 2;',
  ' const c = 3;',
  '@@ -10,3 +12,3 @@ function tail() {',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 99;',
  ' const z = 3;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('splits preamble from hunks and reads both ranges', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(parsed.binary).toBe(false);
    expect(parsed.preamble).toEqual([
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
    ]);
    expect(parsed.hunks).toHaveLength(2);
    const [h1, h2] = parsed.hunks;
    expect({ s: h1!.oldStart, c: h1!.oldCount, ns: h1!.newStart, nc: h1!.newCount })
      .toEqual({ s: 1, c: 3, ns: 1, nc: 5 });
    expect({ s: h2!.oldStart, c: h2!.oldCount, ns: h2!.newStart, nc: h2!.newCount })
      .toEqual({ s: 10, c: 3, ns: 12, nc: 3 });
    expect(h1!.index).toBe(1);
    expect(h2!.index).toBe(2);
  });

  it('reads an omitted count as 1, not 0', () => {
    // `@@ -5 +5 @@` is git's spelling for a single-line hunk. Defaulting the
    // absent count to 0 would silently corrupt every recomputed offset after it.
    const parsed = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -5 +5 @@', '-old', '+new', ''].join('\n'),
    );
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]!.oldCount).toBe(1);
    expect(parsed.hunks[0]!.newCount).toBe(1);
  });

  it('keeps the no-newline marker attached to its own hunk', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file', ''].join('\n'),
    );
    expect(parsed.hunks[0]!.body).toContain('\\ No newline at end of file');
  });

  it('names a binary diff instead of reporting zero hunks', () => {
    const parsed = parseUnifiedDiff(
      ['diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ', ''].join('\n'),
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toHaveLength(0);
  });

  it('refuses a multi-file diff rather than silently reading the first file', () => {
    const two = TWO_HUNKS + ['diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n');
    expect(() => parseUnifiedDiff(two)).toThrow(/single file diff/);
  });
});

describe('selectHunks', () => {
  it('refuses an out-of-range index rather than clamping it', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(() => selectHunks(parsed, [3])).toThrow(/out of range/);
    expect(() => selectHunks(parsed, [0])).toThrow(/out of range/);
    expect(() => selectHunks(parsed, [])).toThrow(/no hunks selected/);
  });

  it('sorts and de-duplicates so tick order cannot reorder the patch', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    expect(selectHunks(parsed, [2, 1, 2]).map((h) => h.index)).toEqual([1, 2]);
  });
});

describe('buildSubsetPatch', () => {
  it('rebuilds the whole diff unchanged when every hunk is selected', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    const patch = buildSubsetPatch(parsed, selectHunks(parsed, [1, 2]));
    expect(patch).toBe(TWO_HUNKS);
  });

  it('RECOMPUTES the new-side offset when an earlier hunk is dropped', () => {
    // Hunk 2 was written as `+12` because hunk 1 added two lines ahead of it.
    // Staging hunk 2 ALONE means those two lines are not there, so the correct
    // post-image start is 10 — the pre-image start, with no delta.
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    const patch = buildSubsetPatch(parsed, selectHunks(parsed, [2]));
    expect(patch).toContain('@@ -10,3 +10,3 @@');
    expect(patch).not.toContain('+12');
    // The preamble must survive, or git apply has no path to write to.
    expect(patch).toContain('--- a/src/app.ts');
    expect(patch).toContain('+++ b/src/app.ts');
    // and only the selected hunk's body came along
    expect(patch).toContain('+const y = 99;');
    expect(patch).not.toContain('+const added1 = 1;');
  });

  it('accumulates the delta across several included hunks', () => {
    const three = [
      '--- a/f', '+++ b/f',
      '@@ -1,1 +1,2 @@', ' a', '+added',
      '@@ -5,1 +6,2 @@', ' b', '+added2',
      '@@ -9,1 +11,1 @@', '-c', '+d',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(three);
    // Selecting 1 and 3: hunk 1 contributes +1, so hunk 3 starts at 9+1 = 10.
    const patch = buildSubsetPatch(parsed, selectHunks(parsed, [1, 3]));
    expect(patch).toContain('@@ -1,1 +1,2 @@');
    expect(patch).toContain('@@ -9,1 +10,1 @@');
  });

  it('preserves the function-context suffix after the closing @@', () => {
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    const patch = buildSubsetPatch(parsed, selectHunks(parsed, [1]));
    expect(patch).toContain('@@ -1,3 +1,5 @@ export function app() {');
  });

  it('refuses to split a binary diff', () => {
    const parsed = parseUnifiedDiff(
      ['diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ', ''].join('\n'),
    );
    expect(() => buildSubsetPatch(parsed, [])).toThrow(/binary/);
  });
});

describe('digestHunks', () => {
  it('is stable for the same bytes and changes when a body line changes', () => {
    const a = parseUnifiedDiff(TWO_HUNKS);
    const b = parseUnifiedDiff(TWO_HUNKS);
    expect(digestHunks(a.hunks)).toBe(digestHunks(b.hunks));
    const edited = parseUnifiedDiff(TWO_HUNKS.replace('const y = 99;', 'const y = 98;'));
    expect(digestHunks(edited.hunks)).not.toBe(digestHunks(a.hunks));
  });

  it('ignores a pure line-number shift, which is the whole point', () => {
    // An edit EARLIER in the file moves every later `@@` header without
    // changing the hunk the reviewer approved. Refusing that would make the
    // feature unusable in a live lane, which is the only place it is used.
    const parsed = parseUnifiedDiff(TWO_HUNKS);
    const shifted = parseUnifiedDiff(TWO_HUNKS.replace('@@ -10,3 +12,3 @@', '@@ -40,3 +42,3 @@'));
    expect(digestHunks(shifted.hunks)).toBe(digestHunks(parsed.hunks));
  });
});

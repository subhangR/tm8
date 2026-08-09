import { describe, expect, it } from 'vitest';
import { fileRowCount, parseUnifiedDiff } from './diff-parse';
import { SAMPLE_DIFF, makeLargeDiff } from '../fixtures/diff';

describe('parseUnifiedDiff', () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);

  it('splits the fixture into its five files, in source order', () => {
    expect(parsed.files.map((f) => f.path)).toEqual([
      'packages/server/src/facade/handlers/projects.ts',
      'packages/server/src/git/branch-topology.ts',
      'packages/server/src/git/legacy-branches.ts',
      'docs/features/git-topology.md',
      'packages/tm8-ui/public/diff-icon.png',
    ]);
  });

  it('reads status from the extended header, not from a guess about the path', () => {
    expect(parsed.files.map((f) => f.status)).toEqual([
      'modified',
      'added',
      'deleted',
      'renamed',
      'added',
    ]);
    expect(parsed.files[3].oldPath).toBe('docs/git/topology.md');
    expect(parsed.files[3].newPath).toBe('docs/features/git-topology.md');
  });

  it('never colours a file header as a change — `+++ b/x` is not an addition', () => {
    // The defect this parser exists to prevent: a renderer keyed on the first
    // character paints `---`/`+++` red and green and inflates every count.
    const texts = parsed.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.text)));
    expect(texts.some((t) => t.startsWith('++ b/'))).toBe(false);
    expect(texts.some((t) => t.startsWith('-- a/'))).toBe(false);
    // The new file is 6 lines of body, not 6 + its two header lines.
    expect(parsed.files[1].additions).toBe(6);
    expect(parsed.files[1].deletions).toBe(0);
  });

  it('counts adds and deletes per file and in total', () => {
    expect(parsed.files[0].additions).toBe(8);
    expect(parsed.files[0].deletions).toBe(3);
    expect(parsed.files[2].deletions).toBe(4);
    expect(parsed.additions).toBe(
      parsed.files.reduce((sum, f) => sum + f.additions, 0),
    );
    expect(parsed.deletions).toBe(
      parsed.files.reduce((sum, f) => sum + f.deletions, 0),
    );
  });

  it('numbers lines from the hunk header, skipping the side a line is absent from', () => {
    const hunk = parsed.files[0].hunks[0];
    expect(hunk.oldStart).toBe(12);
    expect(hunk.newStart).toBe(12);
    const first = hunk.lines[0];
    expect(first).toMatchObject({ kind: 'context', oldLine: 12, newLine: 12 });
    const add = hunk.lines.find((l) => l.kind === 'add');
    expect(add?.oldLine).toBeNull();
    const del = hunk.lines.find((l) => l.kind === 'del');
    expect(del?.newLine).toBeNull();
  });

  it('keeps every hunk of a multi-hunk file with its own header', () => {
    expect(parsed.files[0].hunks).toHaveLength(2);
    expect(parsed.files[0].hunks[1].header).toContain('@@ -40,3 +42,4 @@');
  });

  it('marks a binary file and gives it no hunks to render', () => {
    const binary = parsed.files[4];
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toEqual([]);
  });

  it('attaches "no newline at end of file" to the line it annotates', () => {
    const lines = parsed.files[3].hunks[0].lines;
    expect(lines[lines.length - 1].noNewline).toBe(true);
  });

  it('reads a plain `diff -u` with no `diff --git` header', () => {
    const plain = ['--- old.txt', '+++ new.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
    const out = parseUnifiedDiff(plain);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('new.txt');
    expect(out.files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('defaults a hunk length of 1 when the header omits it', () => {
    const one = ['--- a/x', '+++ b/x', '@@ -3 +3 @@', '-a', '+b', ''].join('\n');
    const hunk = parseUnifiedDiff(one).files[0].hunks[0];
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
  });

  it('returns an empty result rather than throwing on empty or non-diff text', () => {
    expect(parseUnifiedDiff('').files).toEqual([]);
    expect(parseUnifiedDiff('just some prose\nwith no markers\n').files).toEqual([]);
  });

  it('stops at maxLines and SAYS it stopped', () => {
    // A silent truncation is worse than no cap: the reader believes they have
    // seen the whole change.
    const out = parseUnifiedDiff(makeLargeDiff(4000), { maxLines: 100 });
    expect(out.truncated).toBe(true);
    expect(fileRowCount(out.files[0])).toBeLessThanOrEqual(100);
    expect(parseUnifiedDiff(SAMPLE_DIFF).truncated).toBe(false);
  });

  it('counts a rendered row per hunk header plus one per line', () => {
    const file = parseUnifiedDiff(makeLargeDiff(10)).files[0];
    expect(fileRowCount(file)).toBe(11);
  });
});

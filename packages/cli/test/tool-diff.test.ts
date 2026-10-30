import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/commands/tool-diff.js';

const labels = { from: 'demo@v1', to: 'demo@v2' };
const lines = (...values: string[]): string => values.map(value => `${value}\n`).join('');

/** Apply a unified diff produced above; any context or deletion mismatch throws. */
function apply(before: string, patch: string): string {
  if (!patch) return before;
  const source = before.split('\n').map((line, index, all) => index < all.length - 1 ? `${line}\n` : line);
  if (source.at(-1) === '') source.pop();
  const rows = patch.split('\n').slice(2, -1), out: string[] = [];
  let at = 0;
  for (let index = 0; index < rows.length;) {
    const [, start, count] = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(rows[index++]!)!;
    for (const end = count === '0' ? Number(start) : Number(start) - 1; at < end;) out.push(source[at++]!);
    while (index < rows.length && !rows[index]!.startsWith('@@')) {
      const row = rows[index++]!, eol = rows[index] === '\\ No newline at end of file' ? (index++, '') : '\n';
      const text = row.slice(1) + eol;
      if (row[0] !== '+' && source[at] !== text) throw new Error(`mismatch at line ${at + 1}`);
      if (row[0] === ' ') out.push(source[at++]!);
      else if (row[0] === '-') at++;
      else out.push(text);
    }
  }
  return [...out, ...source.slice(at)].join('');
}

describe('unifiedDiff', () => {
  it('is empty for identical sources', () => {
    expect(unifiedDiff(lines('a', 'b'), lines('a', 'b'), labels)).toBe('');
  });
  it('prints one hunk with three lines of context around a change', () => {
    expect(unifiedDiff(lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), lines('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'), labels)).toBe([
      '--- demo@v1', '+++ demo@v2', '@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', '',
    ].join('\n'));
  });
  it('splits distant changes into hunks and merges changes whose context touches', () => {
    const before = lines(...'abcdefghijklmnopqrst'.split(''));
    const apart = unifiedDiff(before, before.replace('b\n', 'B\n').replace('s\n', 'S\n'), labels);
    expect(apart.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,5 +1,5 @@', '@@ -16,5 +16,5 @@']);
    const close = unifiedDiff(before, before.replace('b\n', 'B\n').replace('i\n', 'I\n'), labels);
    expect(close.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,12 +1,12 @@']);
  });
  it('treats a gained or lost final newline as a changed line', () => {
    expect(unifiedDiff('a\nb', 'a\nb\n', labels)).toBe(['--- demo@v1', '+++ demo@v2', '@@ -1,2 +1,2 @@', ' a', '-b',
      '\\ No newline at end of file', '+b', ''].join('\n'));
    expect(unifiedDiff('a\nb\n', 'a\nc', labels)).toContain('-b\n+c\n\\ No newline at end of file\n');
  });
  it('spells empty and single-line ranges as GNU diff does', () => {
    expect(unifiedDiff(lines('a', 'b'), lines('z', 'a', 'b'), labels, 0)).toBe('--- demo@v1\n+++ demo@v2\n@@ -0,0 +1 @@\n+z\n');
    expect(unifiedDiff(lines('a', 'b', 'c'), lines('a', 'c'), labels, 0)).toBe('--- demo@v1\n+++ demo@v2\n@@ -2 +1,0 @@\n-b\n');
  });
  it('replaces the middle wholesale past the edit bound and stays applicable', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `old ${index}\n`).join('');
    const after = Array.from({ length: 2500 }, (_, index) => `new ${index}\n`).join('');
    const patch = unifiedDiff(`keep\n${before}keep\n`, `keep\n${after}keep\n`, labels);
    expect(patch.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,2502 +1,2502 @@']);
    expect(patch.indexOf('+new 0')).toBeGreaterThan(patch.lastIndexOf('-old 2499'));
    expect(apply(`keep\n${before}keep\n`, patch)).toBe(`keep\n${after}keep\n`);
  });
  it('reconstructs the newer source from every generated patch (seeded)', () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const text = (): string => {
      const body = Array.from({ length: Math.floor(random() * 14) }, () => ['a', 'b', 'c', 'd', 'e', ''][Math.floor(random() * 6)]).join('\n');
      return body && random() < 0.7 ? `${body}\n` : body;
    };
    for (let round = 0; round < 500; round++) {
      const before = text(), after = random() < 0.15 ? before : text();
      const patch = unifiedDiff(before, after, labels);
      expect(patch === '', JSON.stringify([before, after])).toBe(before === after);
      expect(apply(before, patch), JSON.stringify([before, after])).toBe(after);
    }
  });
});

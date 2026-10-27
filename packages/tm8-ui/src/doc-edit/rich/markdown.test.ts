import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { encodeMinimal, renderedShape, reserialise, roundTrips } from './markdown';

const SAME_MEANING = [
  'plain words',
  '# One\n\n## Two\n\n### Three',
  '- a\n- b\n  - nested',
  '3. three\n4. four',
  '- [ ] open\n- [x] done',
  '> quoted\n> still',
  '```ts\nconst a = 1 < 2 && b;\n```',
  '```mermaid\ngraph TD; A-->B\n```',
  'one\n\n---\n\ntwo',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '![chart](tm8://file/abc)',
  '**bold** *em* ~~gone~~ `code`',
  'see [/review](tm8://skill/abc)',
  'R&D, 1 < 2 and a > b',
  'snake_case and __init__',
  'line one  \nline two',
];

describe('rich editor markdown', () => {
  it.each(SAME_MEANING)('keeps the meaning of %j', (md) => {
    expect(roundTrips(md)).toBe(true);
  });

  it('respells without changing meaning', () => {
    expect(roundTrips('* star\n* list')).toBe(true);
    expect(roundTrips('Setext\n======')).toBe(true);
  });

  it('refuses a body with raw HTML, which TipTap would drop', () => {
    expect(roundTrips('before\n\n<details><summary>more</summary>hidden</details>\n\nafter')).toBe(false);
  });

  it('stores an ampersand and a less-than as typed, not as entities', () => {
    expect(reserialise('R&D and 1 < 2')).toBe('R&D and 1 < 2');
    expect(reserialise('snake_case')).toBe('snake_case');
  });

  it('escapes only what would start markup', () => {
    expect(encodeMinimal('a <b> tag')).toBe('a &lt;b> tag');
    expect(encodeMinimal('&amp; literal')).toBe('&amp;amp; literal');
    expect(encodeMinimal('> not a quote')).toBe('&gt; not a quote');
    expect(encodeMinimal('*not em*')).toBe('\\*not em\\*');
    expect(encodeMinimal('_lead and trail_')).toBe('\\_lead and trail\\_');
  });

  it('leaves the global marked usable', () => {
    roundTrips('- [ ] a task');
    expect(() => marked.parse('- [ ] a task')).not.toThrow();
    expect(renderedShape('a\n\nb')).toBe('<p>a</p><p>b</p>');
  });
});

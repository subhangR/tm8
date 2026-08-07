/**
 * Excerpt derivation (`src/excerpt.ts`).
 *
 * The property under test is not "the regexes are pretty" — it is that a
 * preview spends its cap on WORDS, and that it never comes back emptier or
 * more markup-laden than plain whitespace flattening already managed.
 */
import { describe, expect, it } from 'vitest';
import { plainExcerpt, stripMarkdown } from '../src/index.js';

describe('stripMarkdown — block markers', () => {
  it('drops ATX heading markers, keeping the heading text', () => {
    expect(stripMarkdown('## Result\ntext')).toBe('Result\ntext');
    expect(stripMarkdown('###### deep')).toBe('deep');
  });

  it('leaves a bare # that is not a heading alone', () => {
    expect(stripMarkdown('#nothashtag')).toBe('#nothashtag');
    expect(stripMarkdown('see issue #5')).toBe('see issue #5');
  });

  it('drops bullet, ordered and task-list markers', () => {
    expect(stripMarkdown('- one\n* two\n+ three')).toBe('one\ntwo\nthree');
    expect(stripMarkdown('1. first\n2) second')).toBe('first\nsecond');
    expect(stripMarkdown('- [ ] todo\n- [x] done')).toBe('todo\ndone');
  });

  it('drops blockquote markers, however deeply nested', () => {
    expect(stripMarkdown('> quoted')).toBe('quoted');
    expect(stripMarkdown('>> deep')).toBe('deep');
  });

  it('drops fence delimiters but keeps the code between them', () => {
    expect(stripMarkdown('```ts\nconst x = 1;\n```')).toBe('\nconst x = 1;\n');
    expect(stripMarkdown('~~~\nplain\n~~~')).toBe('\nplain\n');
  });

  it('drops thematic breaks and setext underlines', () => {
    expect(stripMarkdown('a\n---\nb')).toBe('a\n\nb');
    expect(stripMarkdown('a\n***\nb')).toBe('a\n\nb');
    expect(stripMarkdown('Title\n=====')).toBe('Title\n');
  });

  it('keeps table cell text and drops only the pipes and the delimiter row', () => {
    expect(plainExcerpt('| Surface | File |\n|---|---|\n| feed | FeedRow |', 200))
      .toBe('Surface File feed FeedRow');
  });
});

describe('stripMarkdown — inline markup', () => {
  it('unwraps emphasis, strong and strikethrough', () => {
    expect(stripMarkdown('**bold** and *italic* and ~~gone~~')).toBe('bold and italic and gone');
    expect(stripMarkdown('***both***')).toBe('both');
    expect(stripMarkdown('__strong__ and _em_')).toBe('strong and em');
  });

  it('does not treat arithmetic or snake_case as emphasis', () => {
    expect(stripMarkdown('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(stripMarkdown('snake_case_name')).toBe('snake_case_name');
    expect(stripMarkdown('call plain_excerpt_helper()')).toBe('call plain_excerpt_helper()');
  });

  it('unwraps inline code', () => {
    expect(stripMarkdown('run `tm8 message list` now')).toBe('run tm8 message list now');
  });

  it('keeps link and image text, discarding the target', () => {
    expect(stripMarkdown('see [the design](https://example.com/d)')).toBe('see the design');
    expect(stripMarkdown('![a diagram](x.png)')).toBe('a diagram');
    expect(stripMarkdown('a [ref link][1]')).toBe('a ref link');
    expect(stripMarkdown('<https://example.com/x>')).toBe('https://example.com/x');
  });

  it('resolves backslash escapes, which were markup too', () => {
    expect(stripMarkdown('a literal \\* star')).toBe('a literal * star');
  });
});

describe('plainExcerpt', () => {
  it('flattens to a single line', () => {
    expect(plainExcerpt('a\n\n  b\tc  ', 200)).toBe('a b c');
  });

  it('strips before truncating, so the cap is spent on words', () => {
    const body = '**Lane A starting.** The `excerpt()` helper now strips markdown.';
    expect(plainExcerpt(body, 30)).toBe('Lane A starting. The excerpt(…');
    // The old behaviour flattened only, so the same cap bought less prose.
    expect(body.replace(/\s+/g, ' ').slice(0, 29)).toBe('**Lane A starting.** The `exc');
  });

  it('caps at max characters INCLUDING the ellipsis', () => {
    const capped = plainExcerpt('x'.repeat(500), 200);
    expect(capped).toHaveLength(200);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('does not truncate a body that already fits', () => {
    expect(plainExcerpt('short', 200)).toBe('short');
    expect(plainExcerpt('x'.repeat(200), 200)).toBe('x'.repeat(200));
  });

  it('falls back to the flattened original when a body is nothing but markup', () => {
    // Stripping alone would leave an unlabelled row, which is worse than
    // punctuation. Never return less than flattening did.
    expect(plainExcerpt('---', 200)).toBe('---');
    expect(plainExcerpt('```\n```', 200)).toBe('``` ```');
  });

  it('is empty only for an empty body', () => {
    expect(plainExcerpt('', 200)).toBe('');
    expect(plainExcerpt('   \n\t ', 200)).toBe('');
  });

  it('agrees between the server cap and the CLI cap on the same body', () => {
    const body = '## Status\n\n**Done.** See `entity-read.ts` and [the doc](http://x/y).';
    expect(plainExcerpt(body, 200)).toBe('Status Done. See entity-read.ts and the doc.');
    expect(plainExcerpt(body, 20)).toBe('Status Done. See en…');
  });
});

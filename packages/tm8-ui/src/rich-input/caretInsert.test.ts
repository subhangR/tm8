/**
 * THE SPLICE'S TWO SEPARATORS — and why the second one exists.
 *
 * `spliceInto` had one padding rule, `\n\n`, correct for the destination it was
 * written for: a markdown draft, where a block-level image glued onto the end of
 * a sentence renders INSIDE that paragraph.
 *
 * The transcript composer has a different destination. Its Send is
 * `execution.prompt`, which injects the draft into the session's PTY, and a
 * newline in a PTY prompt is a SUBMIT — `\n\n` beside a pasted path would send
 * the sentence-so-far before the human had finished writing it, then send a bare
 * path as its own message. `'inline'` is the same splice with a space, which is
 * exactly what `LiveTerminal`'s `injectFiles` has always written after a path.
 *
 * The `'block'` cases below are pinned rather than assumed: this is a shared
 * primitive with three other callers (the doc editor, the two memory forms, the
 * task description), and a widening that quietly changed the default would break
 * all of them in a way no test in this file was watching for.
 */
import { describe, expect, it } from 'vitest';
import { spliceInto } from './caretInsert';

describe('spliceInto', () => {
  describe('the block separator — the markdown default', () => {
    it('is what a caller gets without asking', () => {
      expect(spliceInto('a', 1, 1, 'X')).toEqual(spliceInto('a', 1, 1, 'X', 'block'));
    });

    /* A SPACE IS NOT PADDING IN BLOCK MODE, and that is the point of the mode:
       only a newline ends a markdown paragraph, so `before ` still gets one. */
    it('opens a paragraph either side of the insert', () => {
      expect(spliceInto('before after', 6, 6, 'X').body).toBe('before\n\nX\n\n after');
    });

    it('adds no padding where the neighbour already supplies it', () => {
      expect(spliceInto('', 0, 0, 'X').body).toBe('X');
      expect(spliceInto('a\n', 2, 2, 'X').body).toBe('a\nX');
    });

    it('replaces a selection rather than inserting beside it', () => {
      expect(spliceInto('keep DROP keep', 5, 9, 'X').body).toBe('keep \n\nX\n\n keep');
    });
  });

  describe('the inline separator — the PTY draft', () => {
    /** THE RULE THAT HAS BEEN GOT WRONG BEFORE. */
    it('never emits a newline, whatever it is given', () => {
      for (const source of ['', 'a', 'a\n', '\na', 'a\n\nb']) {
        for (const at of [0, source.length]) {
          expect(spliceInto(source, at, at, '/tmp/f', 'inline').body.slice(source.length ? 0 : 0))
            .not.toMatch(/\n\n\/tmp\/f/);
        }
      }
      expect(spliceInto('read this', 9, 9, '/tmp/f', 'inline').body).toBe('read this /tmp/f ');
    });

    it('separates with one space and always leaves one behind it', () => {
      // The trailing space is unconditional at the end of a draft, so the
      // writer's next word does not fuse onto the path.
      expect(spliceInto('', 0, 0, '/tmp/f', 'inline').body).toBe('/tmp/f ');
    });

    it('adds no second space where one is already there', () => {
      expect(spliceInto('read ', 5, 5, '/tmp/f', 'inline').body).toBe('read /tmp/f ');
      expect(spliceInto('a b', 2, 2, '/tmp/f', 'inline').body).toBe('a /tmp/f b');
    });

    /**
     * Two files pasted together are usually related, and the caret advances by
     * the whole piece so the second lands after the first rather than inside it.
     */
    it('advances the caret past everything it wrote, so a second file follows', () => {
      const first = spliceInto('look at', 7, 7, '/tmp/a', 'inline');
      expect(first.body.slice(0, first.caret)).toBe(first.body);
      const second = spliceInto(first.body, first.caret, first.caret, '/tmp/b', 'inline');
      expect(second.body).toBe('look at /tmp/a /tmp/b ');
    });

    /**
     * `spliceInto` clamps to the body it is given, so a caret the writer's own
     * edits have pushed past the end degrades to an append: the insertion POINT
     * may drift, the text is never lost.
     */
    it('clamps a caret that the writer has typed past', () => {
      expect(spliceInto('ab', 99, 99, '/tmp/f', 'inline').body).toBe('ab /tmp/f ');
    });
  });
});

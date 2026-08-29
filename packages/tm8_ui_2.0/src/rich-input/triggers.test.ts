/**
 * The trigger grammar (`triggers.ts`) — pure, so every rule the composer's
 * `@` behaviour established is pinned here where it can be tested without a
 * DOM: start-of-word only, later sigil wins, prefix-not-substring filtering,
 * and the commit splice with its caret.
 */
import { describe, expect, it } from 'vitest';
import { activeTrigger, commitTrigger, filterTriggerOptions } from './triggers';

const SIGILS = ['@', '/'];

describe('activeTrigger', () => {
  it('fires at the start of the text and after whitespace', () => {
    expect(activeTrigger('@', 1, SIGILS)).toMatchObject({ sigil: '@', query: '', range: { start: 0, end: 1 } });
    expect(activeTrigger('hi @al', 6, SIGILS)).toMatchObject({ sigil: '@', query: 'al', range: { start: 3, end: 6 } });
    expect(activeTrigger('line\n/rev', 9, SIGILS)).toMatchObject({ sigil: '/', query: 'rev' });
  });

  it('does not fire mid-word — a sigil inside a token is content', () => {
    expect(activeTrigger('foo/bar', 7, SIGILS)).toBeNull();
    expect(activeTrigger('a@b.com', 7, SIGILS)).toBeNull();
    expect(activeTrigger('http://x', 8, SIGILS)).toBeNull();
  });

  it('the trigger nearest the caret wins when two are live', () => {
    expect(activeTrigger('@alice /rev', 11, SIGILS)).toMatchObject({ sigil: '/', query: 'rev' });
  });

  it('closes at whitespace — typing past the word ends the trigger', () => {
    expect(activeTrigger('@alice hello', 12, SIGILS)).toBeNull();
  });

  it('a doubled sigil is not a trigger — the query refuses its own sigil', () => {
    expect(activeTrigger('@@', 2, SIGILS)).toBeNull();
  });

  it('reads only up to the caret — text after it is not the trigger', () => {
    expect(activeTrigger('@al and more', 3, SIGILS)).toMatchObject({ query: 'al' });
  });

  it('only registered sigils fire', () => {
    expect(activeTrigger('#tag', 4, SIGILS)).toBeNull();
    expect(activeTrigger('/rev', 4, ['@'])).toBeNull();
  });
});

describe('commitTrigger', () => {
  it('splices the committed text over the trigger and lands the caret after it', () => {
    const next = commitTrigger('hi @al there', { start: 3, end: 6 }, '@alice ');
    expect(next.text).toBe('hi @alice there');
    expect(next.caret).toBe(10);
  });

  it('absorbs whitespace that followed the trigger — the insert carries its own separator', () => {
    const next = commitTrigger('@al  tail', { start: 0, end: 3 }, '@alice ');
    expect(next.text).toBe('@alice tail');
  });

  it('works at the end of the text', () => {
    const next = commitTrigger('see /re', { start: 4, end: 7 }, '[/review](tm8://skill/abc) ');
    expect(next.text).toBe('see [/review](tm8://skill/abc) ');
    expect(next.caret).toBe(next.text.length);
  });
});

describe('filterTriggerOptions', () => {
  const options = [
    { id: '1', display: 'Alice Chen' },
    { id: '2', display: 'Bob' },
    { id: '3', display: 'code review' },
  ];

  it('returns everything for an empty query', () => {
    expect(filterTriggerOptions(options, '')).toHaveLength(3);
    expect(filterTriggerOptions(options, '  ')).toHaveLength(3);
  });

  it('matches by prefix, case-insensitively', () => {
    expect(filterTriggerOptions(options, 'al').map((o) => o.id)).toEqual(['1']);
    expect(filterTriggerOptions(options, 'CODE').map((o) => o.id)).toEqual(['3']);
  });

  it('matches any word start, so a surname still reaches its row', () => {
    expect(filterTriggerOptions(options, 'chen').map((o) => o.id)).toEqual(['1']);
    expect(filterTriggerOptions(options, 'review').map((o) => o.id)).toEqual(['3']);
  });

  it('never matches mid-word — that reads as "the filter is broken"', () => {
    expect(filterTriggerOptions(options, 'lice')).toHaveLength(0);
    expect(filterTriggerOptions(options, 'eview')).toHaveLength(0);
  });
});

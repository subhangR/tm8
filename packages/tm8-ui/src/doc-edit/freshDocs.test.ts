import { afterEach, describe, expect, it } from 'vitest';
import { FRESH_DOC_TITLE, forgetFreshDoc, freshDocTitle, isEmptyDoc, markFreshDoc } from './freshDocs';

describe('fresh docs', () => {
  afterEach(() => {
    forgetFreshDoc('d1');
    forgetFreshDoc('d2');
  });

  it("remembers the placeholder each doc was created with (New doc's, or add-child's)", () => {
    markFreshDoc('d1');
    markFreshDoc('d2', 'Untitled doc');
    expect(freshDocTitle('d1')).toBe(FRESH_DOC_TITLE);
    expect(freshDocTitle('d2')).toBe('Untitled doc');
  });

  it('a doc still wearing its own placeholder, with no body, is empty', () => {
    expect(isEmptyDoc('Untitled doc', '', 'Untitled doc')).toBe(true);
    expect(isEmptyDoc('  ', '\n')).toBe(true);
    expect(isEmptyDoc(FRESH_DOC_TITLE, '')).toBe(true);
  });

  it('a title or a body makes it a doc', () => {
    expect(isEmptyDoc('Rounding rules', '', 'Untitled doc')).toBe(false);
    expect(isEmptyDoc('Untitled doc', 'one line', 'Untitled doc')).toBe(false);
    // Another doc's placeholder is a real title here.
    expect(isEmptyDoc('Untitled doc', '')).toBe(false);
  });
});

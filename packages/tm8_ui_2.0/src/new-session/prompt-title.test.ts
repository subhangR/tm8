import { describe, expect, it } from 'vitest';

import { TITLE_MAX, canDeriveTitle, deriveTitle, promptBody } from './prompt-title';

/**
 * These are the rules a reviewer should be able to check by reading: the title
 * is cosmetic and may lose characters, the BODY may never lose any.
 */
describe('New Session — prompt to title', () => {
  it('takes the first sentence, dropping the terminator', () => {
    expect(deriveTitle('Fix the login bug. It started after the deploy.')).toBe('Fix the login bug');
  });

  it('treats ? and ! as sentence ends', () => {
    expect(deriveTitle('Why is the terminal blank? It renders after a resize.')).toBe('Why is the terminal blank');
    expect(deriveTitle('Ship it! Then tell the team.')).toBe('Ship it');
  });

  it('treats a line break as the end of a thought', () => {
    expect(deriveTitle('Add a New Session page\n\nit should have a composer')).toBe('Add a New Session page');
  });

  it('uses the whole prompt when no sentence was ever terminated', () => {
    expect(deriveTitle('add a workdir chip to the composer')).toBe('add a workdir chip to the composer');
  });

  it('caps a long sentence at TITLE_MAX and marks the cut', () => {
    const long = `${'a'.repeat(40)} ${'b'.repeat(60)} tail`;
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX + 1); // +1 for the ellipsis
    expect(title.endsWith('…')).toBe(true);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';
    expect(words.length).toBeGreaterThan(TITLE_MAX); // guard: the case only means something over the cap
    const title = deriveTitle(words);
    expect(title.endsWith('…')).toBe(true);
    // The character before the ellipsis must not be mid-token: the cut lands
    // where a space was, so the last word is whole.
    const body = title.slice(0, -1);
    expect(words.startsWith(body)).toBe(true);
    expect(words[body.length]).toBe(' ');
  });

  it('does not add an ellipsis to a sentence that already fits', () => {
    expect(deriveTitle('Short enough.')).toBe('Short enough');
  });

  it('never returns empty for a prompt that has any content — schema requires min(1)', () => {
    // Leading punctuation makes the sentence search hit index 0; the fallback
    // must still produce a usable title rather than ''.
    expect(deriveTitle('...ok so fix the thing').length).toBeGreaterThan(0);
    expect(deriveTitle('!').length).toBeGreaterThan(0);
  });

  it('refuses only whitespace, which is what withholds Enter', () => {
    expect(canDeriveTitle('   \n\t ')).toBe(false);
    expect(canDeriveTitle('')).toBe(false);
    expect(canDeriveTitle('x')).toBe(true);
    expect(deriveTitle('   ')).toBe('');
  });

  it('keeps the body verbatim — the agent reads this as its instructions', () => {
    const prompt = 'Fix the bug.\n\n  - keep the indent\n  - and the blank line above\n\nDone?';
    // Only the outer edges are trimmed; internal structure is untouched.
    expect(promptBody(`  ${prompt}  `)).toBe(prompt);
  });

  it('does not truncate the body even when the title is cut', () => {
    const long = `${'word '.repeat(100)}end.`;
    expect(promptBody(long)).toBe(long.trim());
    expect(promptBody(long).length).toBeGreaterThan(TITLE_MAX);
  });
});

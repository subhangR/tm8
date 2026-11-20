import { describe, expect, it } from 'vitest';
import { TITLE_MAX, canDeriveTitle, deriveTitle, promptBody } from './prompt-title';

// The label may be compact; the prompt that becomes the task body may not.
describe('New Session — prompt to title', () => {
  it('uses a short intent label rather than the full first paragraph', () => {
    expect(deriveTitle('Please fix the login bug in the new Safari version. Keep every reproduction step.'))
      .toBe('fix the login bug');
    expect(deriveTitle('Why is the terminal blank? It renders after a resize.'))
      .toBe('Why is the terminal blank');
    expect(deriveTitle('Add a New Session page\n\nit should have a composer'))
      .toBe('Add a New Session page');
  });

  it('bounds long labels while keeping short labels intact', () => {
    expect(Array.from(deriveTitle('long_identifier_'.repeat(30))).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(deriveTitle('Short enough.')).toBe('Short enough');
    expect(deriveTitle('...ok so fix the thing')).not.toBe('');
    expect(deriveTitle('!')).toBe('Work session');
  });

  it('refuses only whitespace, which withholds Enter', () => {
    expect(canDeriveTitle('   \n\t ')).toBe(false);
    expect(canDeriveTitle('')).toBe(false);
    expect(canDeriveTitle('x')).toBe(true);
    expect(deriveTitle('   ')).toBe('');
  });

  it('keeps the complete body and internal structure when its label is shortened', () => {
    const prompt = 'Please fix the login bug in the new Safari version.\n\n  - keep the indent\n  - and the blank line above\n\n' + 'detail '.repeat(100) + 'Done?';
    expect(deriveTitle(prompt)).toBe('fix the login bug');
    expect(promptBody(`  ${prompt}  `)).toBe(prompt);
    expect(promptBody(prompt).length).toBeGreaterThan(TITLE_MAX);
  });
});

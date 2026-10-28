import { describe, expect, it } from 'vitest';
import { titleFromBody } from './autoTitle';

describe('titleFromBody', () => {
  it('takes the first line of text, without its markdown', () => {
    expect(titleFromBody('# Launch plan\n\nbody')).toBe('Launch plan');
    expect(titleFromBody('\n\n- [ ] **ship** the [api](https://x.dev)')).toBe('ship the api');
    expect(titleFromBody('> quoted `code` line')).toBe('quoted code line');
    expect(titleFromBody('1. first step')).toBe('first step');
  });

  it('skips blank lines and rules, and is empty when there is no text', () => {
    expect(titleFromBody('---\n\n  \nreal line')).toBe('real line');
    expect(titleFromBody('')).toBe('');
    expect(titleFromBody('#   \n***')).toBe('');
  });

  it('cuts a long line at a word, with an ellipsis', () => {
    const long = `${'word '.repeat(30)}end`;
    const title = titleFromBody(long);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title).not.toContain('wor…');
  });
});

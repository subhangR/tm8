import { describe, expect, it } from 'vitest';
import { INTENT_TITLE_MAX_CHARS, INTENT_TITLE_MAX_WORDS, shortIntentTitle } from '../src/intent-title.js';

describe('automatic intent titles', () => {
  it.each([
    ['Hi, could you please help me fix the login bug in Safari? More detail follows.', 'fix the login bug in Safari'],
    ['I would like you to add upload retries. Preserve the complete file.', 'add upload retries'],
    ["I'd like to review task access visibility\nKeep all role details.", 'review task access visibility'],
    ['## Please fix `upload_task.ts` retries.\n\nPreserve this paragraph.', 'fix upload_task.ts retries'],
    ['Compare [Vue](https://vuejs.org) and **React** for our next app', 'Compare Vue and React'],
    ['Why is the terminal blank? It renders after resize.', 'Why is the terminal blank'],
    ['Fix the login bug in the new Safari version', 'Fix the login bug'],
    ['短い会話のタイトルを作る。完全な依頼文を残す', '短い会話のタイトルを作る。完全な依頼文を残す'],
    ['Ship it!', 'Ship it'],
  ])('labels %j from intent', (prompt, expected) => {
    expect(shortIntentTitle(prompt)).toBe(expected);
  });

  it('bounds labels by words and Unicode characters, including long identifiers', () => {
    for (const prompt of [
      'word '.repeat(200),
      'long_identifier_'.repeat(20),
      '🧭'.repeat(80) + ' exploration',
      '修'.repeat(80),
      'Please ' + 'first second third fourth fifth sixth seventh eighth',
    ]) {
      const title = shortIntentTitle(prompt);
      expect(title.trim()).toBe(title);
      expect(title.split(/\s+/u).length).toBeLessThanOrEqual(INTENT_TITLE_MAX_WORDS);
      expect(Array.from(title).length).toBeLessThanOrEqual(INTENT_TITLE_MAX_CHARS);
      expect(title).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });

  it.each(['', '  \n\t ', '!!!', '🙂'])('uses an intentional fallback for %j', (prompt) => {
    expect(shortIntentTitle(prompt, 'New chat')).toBe('New chat');
  });

  it('keeps short labels without rewriting the source', () => {
    expect(shortIntentTitle('Upload recovery')).toBe('Upload recovery');
    const prompt = 'Please implement resilient uploads with retries and cancellation.';
    expect(shortIntentTitle(prompt)).toBe('implement resilient uploads with retries');
    expect(prompt).toBe('Please implement resilient uploads with retries and cancellation.');
  });
});

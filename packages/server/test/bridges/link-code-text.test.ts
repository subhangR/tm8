/**
 * Bridges B3 follow-up (D59): the words a /link hands its SQL door. A phone
 * may split TM8-XXXXXX at the hyphen, so the words are taken until they hold a
 * whole code; the door normalizes the separators (migration 410).
 */
import { describe, expect, it } from 'vitest';
import { linkCodeText } from '../../src/bridges/commands/executor.js';

describe('linkCodeText', () => {
  it.each([
    ['TM8-ABCDEF', 'TM8-ABCDEF'],
    ['TM8-ABCDEF please', 'TM8-ABCDEF'],
    ['TM8 ABCDEF', 'TM8 ABCDEF'],
    ['TM8–ABCDEF', 'TM8–ABCDEF'],
    ['tm8 – abc def thanks', 'tm8 – abc def'],
    ['ABCDEF', 'ABCDEF'],
    ['TM8-ABCDEF from my phone', 'TM8-ABCDEF'],
    ['TM8-ABCDEFG', 'TM8-ABCDEFG'],
    ['', ''],
  ])('%j -> %j', (args, code) => {
    expect(linkCodeText(args)).toBe(code);
  });
});

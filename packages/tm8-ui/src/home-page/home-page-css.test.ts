/**
 * HOME'S CHAT RULES MUST NOT REACH A NESTED CHAT — asserted on the stylesheet
 * text, because jsdom applies no cascade and every component test would pass
 * with the defect in place.
 *
 * Opening a chat ENTITY from Home puts its panel in the centre, and that
 * panel's Chat tab mounts a second `ChatHomeScreen` (solo) inside `.hp-chat`.
 * `.hp-chat--full .tch-root` matched it too and, at (0,3,0), beat its
 * `.tch-root--solo` single track — the nested chat was drawn in the 340px list
 * column with the rest of the panel empty (task 01a0d9a3). Every `.tch-*`
 * selector here has to reach Home's own screen through `>` alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(fileURLToPath(new URL('./home-page.css', import.meta.url)), 'utf8');
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector in the sheet that names a `.tch-` class. */
function tchSelectors(): string[] {
  const out: string[] = [];
  for (const match of RULES.matchAll(/([^{}]+)\{/g)) {
    for (const selector of match[1]!.split(',')) {
      const trimmed = selector.trim().replace(/\s+/g, ' ');
      if (trimmed.includes('.tch-')) out.push(trimmed);
    }
  }
  return out;
}

describe('home-page.css scopes its chat rules to the chat Home hosts', () => {
  it('finds the rules it guards (the scan is not vacuous)', () => {
    expect(tchSelectors()).toEqual(
      expect.arrayContaining([
        '.cv2-root .hp-chat--full > .tch-root',
        ".cv2-root .hp-root--chat[data-focus='true'] .hp-chat--full > .tch-root",
      ]),
    );
  });

  it('reaches every .tch-* class from .hp-chat by child combinators only', () => {
    for (const selector of tchSelectors()) {
      const fromChat = selector.slice(selector.search(/\.hp-chat(--full)?\b/));
      // `.hp-chat[--full] > .tch-root[ > .tch-x]` — no descendant space anywhere.
      expect(fromChat, selector).toMatch(/^\.hp-chat(--full)? > \.tch-root( > \.tch-[a-z-]+)?$/);
    }
  });
});

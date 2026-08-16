/**
 * THE DETECTOR for "one list paints its own colour and the others do not".
 *
 * WHY THIS TEST EXISTS. `--pn-card` is literally #FFFFFF (tokens.css). The
 * session row `pn-st` has always declared NO background, so it shows
 * `--pn-surface` — the `.lp` panel it sits in — and reads as part of the paper.
 * `lp__tile` (every kind that is not a task or a session: docs, channels,
 * members, projects, files, memories, PRs, commits…) and `pn-tt` (tasks) both
 * declared `background: var(--pn-card)`, so ~30 lists drew pure white rows on a
 * warm panel while the one list beside them did not. In dark the same two
 * declarations invert the defect: `--pn-card` #221E15 is LIGHTER than the panel
 * #1B1810, so those rows read as raised slabs and session rows stay flat.
 *
 * WHY IT SCANS THE SOURCE RATHER THAN THE DOM. jsdom loads no stylesheets, so
 * `getComputedStyle(tile).backgroundColor` is empty for every row in the suite —
 * a rendering test is structurally unable to answer "what colour is this tile".
 * The whole suite was green over the live defect. Reading the declaration is the
 * only thing in-repo that can see it. (`row-height-parity.test.ts` next door
 * exists for the same reason and scans the same two files.)
 *
 * THE INVARIANT. A list tile's colour AT REST is the panel's, so no tile root
 * rule may declare a background of its own. State is a different question and
 * still paints: hover, selected and attention each set one, and this test
 * requires that too — a tile that lost its states would otherwise "pass" by
 * having no backgrounds anywhere.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sources: Record<string, string> = {
  'panels.css': readFileSync(fileURLToPath(new URL('../panels.css', import.meta.url)), 'utf8'),
  'maestro-task-tile.css': readFileSync(
    fileURLToPath(new URL('./maestro-task-tile.css', import.meta.url)),
    'utf8',
  ),
};

/** The three list-tile anatomies the registry selects between (`list.tile.anatomy`). */
const TILE_ROOTS = [
  { anatomy: 'standard', selector: '.cv2-root .lp__tile', file: 'panels.css' },
  { anatomy: 'control-card', selector: '.cv2-root .pn-tt', file: 'maestro-task-tile.css' },
  { anatomy: 'session-tree', selector: '.cv2-root .pn-st', file: 'panels.css' },
] as const;

/** The body of `selector { ... }`, matched exactly — `.pn-tt` must not find `.pn-tt__main`. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : null;
}

const declaresBackground = (body: string) => /(^|[;{\s])background(-color)?\s*:/.test(body);

describe('list tile fill', () => {
  for (const { anatomy, selector, file } of TILE_ROOTS) {
    it(`${anatomy} (${selector}) takes its colour from the panel, not from itself`, () => {
      const body = ruleBody(sources[file]!, selector);
      expect(body, `${selector} not found in ${file}`).not.toBeNull();
      expect(declaresBackground(body!)).toBe(false);
    });

    it(`${anatomy} (${selector}) still paints hover, selected and attention`, () => {
      // Without this half the invariant above is satisfiable by a tile with no
      // colour at all, which is a worse list than the one we started with.
      const states = [...sources[file]!.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
        .filter(([, sel]) => {
          const s = sel.trim().replace(/\s+/g, ' ');
          return s.startsWith(`${selector}:`) || s.startsWith(`${selector}--`);
        })
        .filter(([, , body]) => declaresBackground(body));
      expect(states.length).toBeGreaterThanOrEqual(3);
    });
  }
});

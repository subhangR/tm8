/**
 * THE LIVE ROW'S VISUAL CONTRACT, READ FROM THE STYLESHEET.
 *
 * jsdom loads no stylesheets, so no render test can see that the row sticks
 * to the bottom, that nothing ticking can wrap, that silence is never painted
 * as an error, or that reduced motion stills it. Each of those is a ruling
 * (advisor D1–D5, D16, D20) and a regression none of the vitest renders would
 * notice, so each is asserted here against the source text.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('./live-turn-status.css', import.meta.url), 'utf8');

/** The body of the FIRST rule whose selector list is exactly `selector`. */
function rule(selector: string, source = CSS): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(source);
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

function reducedMotionBlock(): string {
  const start = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('\n}', start) + 2);
}

describe('live-turn-status.css', () => {
  it('the dock sticks to the bottom of the transcript (D1)', () => {
    const dock = rule('.tch-dock');
    expect(dock).toMatch(/position:\s*sticky/);
    expect(dock).toMatch(/bottom:\s*4px/);
  });

  it('the card is D1’s card', () => {
    const card = rule(".tch-dock[data-live]");
    expect(card).toMatch(/background:\s*var\(--pn-card\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--pn-line\)/);
    expect(card).toMatch(/border-radius:\s*var\(--pn-r-md\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--pn-sh-md\)/);
    expect(card).toMatch(/padding:\s*9px 14px/);
  });

  /** Nothing that ticks may wrap: the transcript re-follows its end only when
   *  the SCREEN re-renders, not when the row's own clock does. */
  it('the ticking meta and the sentences never wrap', () => {
    expect(rule('.tch-live__meta')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.tch-live__now,\n.tch-live__aside')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.tch-live__now,\n.tch-live__aside')).toMatch(/text-overflow:\s*ellipsis/);
  });

  /** Advisor ruling 3: 74s of silence is normal, so silence is never red. */
  it('long silence turns the meta to the wait tone, never to the error one', () => {
    const quiet = rule(".tch-live[data-quiet='long'] .tch-live__meta");
    expect(quiet).toMatch(/color:\s*var\(--pn-wait\)/);
    expect(quiet).not.toMatch(/--pn-block/);
  });

  it('a failed turn gets the 3px block edge (D2)', () => {
    expect(rule(".tch-dock[data-phase='failed']")).toMatch(/border-left:\s*3px solid var\(--pn-block\)/);
  });

  it('the pill is D5’s pill', () => {
    const pill = rule('.tch-jump');
    expect(pill).toMatch(/background:\s*var\(--pn-ink\)/);
    expect(pill).toMatch(/color:\s*var\(--pn-surface\)/);
    expect(pill).toMatch(/border-radius:\s*var\(--pn-r-pill\)/);
  });

  /** In `sending` / `waiting` the row also wears `.tch-wait`; the row's own
   *  rule must outrank that one whichever stylesheet loads last. */
  it('the row rule outranks `.tch-wait` by specificity, not by load order', () => {
    expect(rule('.tch-dock .tch-live')).toMatch(/font:/);
  });

  it('reduced motion stills the ribbon (no fade either — D20) and the entrance', () => {
    const block = reducedMotionBlock();
    expect(block).toMatch(/\.cv2-root \.tch-live__ribbon\s*\{\s*animation:\s*none/);
    expect(block).toMatch(/\.tch-dock\[data-live\]\s*\{\s*animation:\s*none/);
  });
});

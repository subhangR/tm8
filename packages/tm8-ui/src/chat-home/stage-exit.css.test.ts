/**
 * THE STAGE LINE IS ACTUALLY STYLED, in the tokens ruling D18 names.
 *
 * jsdom loads no stylesheets, so `stage-exit.test.tsx` passes as well with a
 * dot nothing paints; this reads the sheet as text. Node environment on
 * purpose — see `third-party-turns.css.test.ts` for why a file read cannot
 * live in a jsdom suite.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(new URL('.', import.meta.url).pathname, 'stage-exit.css'), 'utf8');

describe('the stage exit line (D18)', () => {
  it('draws the live dot as every live dot: 6px `--pn-run`, a 1.6s fade to .35', () => {
    expect(css).toMatch(/\.tch-stage-exit__dot\s*\{[^}]*width:\s*6px[^}]*background:\s*var\(--pn-run\)[^}]*animation:\s*tch-stage-exit-pulse 1\.6s/);
    expect(css).toMatch(/@keyframes tch-stage-exit-pulse\s*\{\s*from\s*\{\s*opacity:\s*1;\s*\}\s*to\s*\{\s*opacity:\s*0\.35;/);
  });

  it('holds the dot solid `--pn-idle` once finished, and still under reduced motion', () => {
    expect(css).toMatch(/\[data-state='finished'\] \.tch-stage-exit__dot\s*\{[^}]*var\(--pn-idle\)[^}]*animation:\s*none/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.tch-stage-exit__dot\s*\{\s*animation:\s*none/);
  });

  it('sets the words in fine `--pn-ink-3`, and the exit in 600 `--pn-ink-2` with the brand focus ring', () => {
    expect(css).toMatch(/\.tch-stage-exit\s*\{[^}]*font-size:\s*var\(--pn-fs-fine\)/);
    expect(css).toMatch(/\.tch-stage-exit__status\s*\{[^}]*color:\s*var\(--pn-ink-3\)/);
    expect(css).toMatch(/\.tch-stage-exit__back\s*\{[^}]*font-weight:\s*600[^}]*color:\s*var\(--pn-ink-2\)/);
    expect(css).toMatch(/\.tch-stage-exit__back:hover\s*\{\s*color:\s*var\(--pn-ink\)/);
    expect(css).toMatch(/\.tch-stage-exit__back:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--pn-brand\)[^}]*outline-offset:\s*2px/);
    expect(css).toMatch(/\.tch-stage-exit__sep\s*\{\s*color:\s*var\(--pn-ink-4\)/);
  });
});

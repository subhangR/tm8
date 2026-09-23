// @vitest-environment node
/**
 * THE STYLESHEET HALF of the third-party-turn feature — see
 * `third-party-turns.test.tsx` for the DOM half and for why the two are paired.
 *
 * A SEPARATE FILE BECAUSE OF THE ENVIRONMENT. Under `@vitest-environment jsdom`
 * `import.meta.url` is not a file URL, so `new URL('.', import.meta.url).pathname`
 * resolves to nonsense and `readFileSync` opens the wrong path — silently, since
 * the ENOENT surfaces as a suite-level error rather than as a failing assertion.
 * A file read belongs in the node environment, and this file has no DOM to
 * render anyway.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the third-party treatment is actually STYLED', () => {
  /*
   * jsdom loads no stylesheets, so every assertion above passes just as well
   * with a marker nothing paints. This reads the sheet as text — the only
   * instrument in this package that can tell a shipped visual difference from
   * a `data-` attribute nobody styled.
   */
  /* Resolved from THIS FILE, not from the runner's cwd — same spelling
     `chat-home-css-coverage.test.ts` uses, and it works here for the reason
     the header gives: this file runs in the node environment. */
  const css = readFileSync(join(new URL('.', import.meta.url).pathname, 'chat-home.css'), 'utf8');

  it('keys a rule on the marker the component writes', () => {
    expect(css).toMatch(/\.tch-turn\[data-third-party=['"]true['"]\]/);
  });

  it('gives the bubble a treatment of its own, not just the byline', () => {
    // Two rules, and both matter: the byline stops taking a side, and the
    // BUBBLE gets the rule that reads as "from elsewhere". A marker that only
    // moved the byline would leave the message itself indistinguishable.
    const bubbleRule = css.match(
      /\.tch-turn\[data-third-party=['"]true['"]\][^{]*\.tch-user-body\s*\{[^}]*\}/,
    );
    expect(bubbleRule, 'no bubble rule for a third-party turn').not.toBeNull();
    expect(bubbleRule![0]).toContain('border-left');
  });

  it('styles the source chip row it renders', () => {
    expect(css).toMatch(/\.tch-turn__source\s*\{/);
    expect(css).toMatch(/\.tch-turn__source-word\s*\{/);
  });
});

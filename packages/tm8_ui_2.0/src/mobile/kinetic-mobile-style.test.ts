import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * KINETIC WAVE 2 — the phone surfaces, read off the stylesheets, because
 * nothing else in this package can read them.
 *
 * Same pattern and same reasons as `msheet-size.test.ts` and
 * `entity-fab-style.test.ts` next door: jsdom loads no stylesheets and lays
 * nothing out, so the glass, the radius, the snap and the type scale are
 * invisible to a render test. The rule text is the only assertable artefact,
 * and these pins are what keep the Kinetic pass from being silently reverted
 * by a refactor that leaves every DOM test green.
 *
 * NODE ENVIRONMENT, DELIBERATELY — no environment pragma, so the runner's
 * `environment: 'node'` default applies and `import.meta.url` resolves against
 * this file. (Do not name the pragma in prose here; vitest scans the leading
 * comment for the bare word.)
 *
 * COMMENTS ARE STRIPPED FIRST, and it matters more than usually: the blocks
 * asserted below carry comments that NAME the numbers they justify (28px, 92%,
 * 220ms), so a match over raw text could be satisfied by the explanation of a
 * rule that had been deleted.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const screens = strip(readFileSync(new URL('./mobile-screens.css', import.meta.url), 'utf8'));
const chrome = strip(readFileSync(new URL('./mobile-chrome.css', import.meta.url), 'utf8'));
const drawerTsx = strip(readFileSync(new URL('./MobileDrawer.tsx', import.meta.url), 'utf8'));

/** The declarations of one rule in one sheet, so a claim about a selector
    cannot be satisfied by a match elsewhere in a 1300-line stylesheet. */
function block(css: string, selector: string, sheet: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is not in ${sheet}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the sheet is Kinetic glass (Master Spec §6)', () => {
  const panel = () => block(screens, '.msheet__panel {', 'mobile-screens.css');

  it('rounds its top corners at the spec’s 28px', () => {
    /* 28 has no token — the radius scale tops out at --pn-r-lg (14) — so the
       spec's number is a deliberate local literal. Both corners, or the sheet
       is lopsided in a way jsdom cannot see. */
    expect(panel()).toMatch(/border-top-left-radius:\s*28px/);
    expect(panel()).toMatch(/border-top-right-radius:\s*28px/);
  });

  it('is translucent card over a live blur, through tokens only', () => {
    /* The same 92% + 12px recipe as `shell/palette.css .pal` — one glass in
       the product, not two. `color-mix` over `var(--pn-card)` is what keeps
       the hex ban satisfied and both themes correct from one rule. */
    expect(panel()).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--pn-card\)\s*92%,\s*transparent\)/);
    expect(panel()).toMatch(/backdrop-filter:\s*blur\(12px\)/);
    /* The -webkit- prefix is not decoration: the phone this shell exists for
       is most often a WebKit, and unprefixed-only glass is opaque exactly
       there. */
    expect(panel()).toMatch(/-webkit-backdrop-filter:\s*blur\(12px\)/);
  });

  it('lifts on the pop elevation token', () => {
    expect(panel()).toMatch(/box-shadow:\s*var\(--pn-sh-pop\)/);
  });

  it('enters as a 220ms ease-out slide-up, and reduced motion kills it', () => {
    /* 220ms is the spec's entrance duration; the token ramp stops at
       --pn-dur-base (180ms), so the literal is deliberate. The easing stays
       the token. */
    expect(panel()).toMatch(/animation:\s*msheet-rise\s+220ms\s+var\(--pn-ease-out\)/);
    /* The keyframes still travel UP — a rise, not a fade. */
    expect(screens).toMatch(/@keyframes msheet-rise\s*\{\s*from\s*\{\s*transform:\s*translateY\(/);
    /* Motion off, end state kept: the panel is named inside the
       reduced-motion media block. */
    expect(screens).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.msheet,\s*\.msheet__panel\s*\{\s*animation:\s*none/,
    );
  });

  it('draws the drag handle as a 36x4 hairline pill', () => {
    const grip = block(screens, '.msheet__grip', 'mobile-screens.css');
    expect(grip).toMatch(/width:\s*36px/);
    expect(grip).toMatch(/height:\s*4px/);
    expect(grip).toMatch(/border-radius:\s*var\(--pn-r-pill\)/);
    expect(grip).toMatch(/background:\s*var\(--pn-line-2\)/);
  });

  it('keeps the sizes the size contract pins — glass changed the skin, not the geometry', () => {
    /* Belt beside `msheet-size.test.ts`: the Kinetic edit touched the same
       block those cases read, so restate the two numbers that make a sheet a
       sheet rather than a navigation. */
    expect(panel()).toMatch(/height:\s*72%/);
    expect(panel()).toMatch(/max-height:\s*88%/);
  });
});

describe('the drawer rows wear the kit grammar (delivered in mobile-chrome.css — mobile-drawer.css is swept)', () => {
  const scoped = (selector: string) => block(chrome, selector, 'mobile-chrome.css');

  it('sets the row face at ui 15/600 in the full ink', () => {
    const row = scoped(".cv2-root[data-shell='mobile'] .mdrawer__row {");
    /* --pn-fs-title IS 15px — the token, not a literal, so the row face and
       the header title face cannot drift apart. */
    expect(row).toMatch(/font-size:\s*var\(--pn-fs-title\)/);
    expect(row).toMatch(/font-weight:\s*600/);
    expect(row).toMatch(/color:\s*var\(--pn-ink\)/);
  });

  it('fills the current row with brand-soft, not the shared press tint', () => {
    const current = scoped(".cv2-root[data-shell='mobile'] .mdrawer__row[aria-current]");
    expect(current).toMatch(/background:\s*var\(--pn-brand-soft\)/);
    expect(current).toMatch(/color:\s*var\(--pn-brand\)/);
  });

  it('sets the group eyebrows in the caps grammar, never micro type', () => {
    const label = scoped(".cv2-root[data-shell='mobile'] .mdrawer__label");
    expect(label).toMatch(/font-family:\s*var\(--pn-caps\)/);
    expect(label).toMatch(/font-weight:\s*700/);
    /* DEF-040: 11px was measured off this shell for good. The override must
       not re-introduce it. */
    expect(label).not.toMatch(/--pn-fs-micro/);
  });

  it('boxes the row mark at 20px square, and the component draws at 20 to match', () => {
    const mark = scoped(".cv2-root[data-shell='mobile'] .mdrawer__mark");
    expect(mark).toMatch(/inline-size:\s*20px/);
    expect(mark).toMatch(/block-size:\s*20px/);
    /* Every mark inside the drawer renders at the box's own size — a 16px
       glyph centred in a 20px box would be the header rhythm broken quietly. */
    expect(drawerTsx).not.toMatch(/mdrawer__mark[\s\S]{0,160}size=\{16\}/);
    const at20 = drawerTsx.match(/size=\{20\}/g) ?? [];
    expect(at20.length).toBeGreaterThanOrEqual(4);
  });

  it('overrides type and ink ONLY — the 44px floor stays where the contract pins it', () => {
    /* `mobile-drawer.css` ships the touch floor and `shell-contract.test.ts`
       pins it there. The Kinetic block must not restate geometry it does not
       own: a second min-block-size here would be a number that could silently
       diverge from the pinned one. */
    const from = chrome.indexOf(".cv2-root[data-shell='mobile'] .mdrawer__row {");
    expect(from).toBeGreaterThan(-1);
    const kinetic = chrome.slice(from);
    expect(kinetic).not.toMatch(/min-block-size/);
    expect(kinetic).not.toMatch(/::(after|before)/);
  });
});

describe('the board snaps by column on the phone (Master Spec §6)', () => {
  it('snaps the horizontal axis, mandatorily, on the shell-scoped scroller', () => {
    const cols = block(screens, ".cv2-root[data-shell='mobile'] .lp__board-cols", 'mobile-screens.css');
    expect(cols).toMatch(/scroll-snap-type:\s*x mandatory/);
    /* NOT `both`: the scroller pans vertically too, and a Y snap would fight
       the reader mid-column. */
    expect(cols).not.toMatch(/scroll-snap-type:\s*both/);
    /* The snap position honours the scroller's own 8px gutter, so a snapped
       column lands at the visible edge rather than under it. */
    expect(cols).toMatch(/scroll-padding-inline-start:\s*8px/);
  });

  it('aligns each column to start', () => {
    /* `.lp__board-col {` with the brace, or the prefix would match the
       scroller (`.lp__board-cols`) instead of the column. */
    const col = block(screens, ".cv2-root[data-shell='mobile'] .lp__board-col {", 'mobile-screens.css');
    expect(col).toMatch(/scroll-snap-align:\s*start/);
  });

  it('never reaches the desktop board — every snap rule is shell-scoped', () => {
    /* The scroller class lives in `panels.css`, a swept file this wave may
       not edit; the snap is delivered here by restatement, so an unscoped
       `.lp__board*` rule in this sheet would be a desktop change smuggled
       through the phone file. */
    expect(screens).not.toMatch(/^\.lp__board/m);
  });
});

describe('the primary verb is brand-filled and presses like the grammar’s brand button', () => {
  it('fills the FAB with the brand token', () => {
    const fab = block(screens, ".cv2-root[data-shell='mobile'] .ev-fab {", 'mobile-screens.css');
    expect(fab).toMatch(/background:\s*var\(--pn-brand\)/);
    expect(fab).toMatch(/color:\s*var\(--pn-paper\)/);
    expect(fab).toMatch(/box-shadow:\s*var\(--pn-sh-pop\)/);
  });

  it('answers a press with the kit grammar’s brand-press mix', () => {
    /* The same mix `kit.css .k-btn--brand:active` ships — one press ink for
       the product's brand verbs, phone included. */
    const active = block(screens, ".cv2-root[data-shell='mobile'] .ev-fab:active", 'mobile-screens.css');
    expect(active).toMatch(/color-mix\(in srgb,\s*var\(--pn-brand-2\)\s*88%,\s*var\(--pn-ink\)\)/);
  });
});

describe('PWA polish — the manifest’s colours are the tokens’ colours', () => {
  /* The manifest cannot reference CSS custom properties, so its two colour
     fields are unavoidable copies of the light-theme tokens. This is the sync
     test that makes those copies safe to leave as copies: if the byte-locked
     palette ever moves, this names the two fields that must follow. */
  const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'),
  ) as { theme_color?: string; background_color?: string };

  const tokenValue = (name: string): string => {
    const m = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    expect(m, `${name} is not a hex entry in styles/tokens.css`).not.toBeNull();
    return m![1]!.toLowerCase();
  };

  it('theme_color is the light --pn-surface', () => {
    expect(manifest.theme_color?.toLowerCase()).toBe(tokenValue('--pn-surface'));
  });

  it('background_color is the light --pn-paper', () => {
    expect(manifest.background_color?.toLowerCase()).toBe(tokenValue('--pn-paper'));
  });
});

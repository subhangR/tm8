import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const homeCss = strip(readFileSync(new URL('./home-page.css', import.meta.url), 'utf8'));
const metricsCss = strip(
  readFileSync(new URL('../navigation/entity-navigation-metrics.css', import.meta.url), 'utf8'),
);
const pageTsx = strip(readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8'));
const railTsx = strip(readFileSync(new URL('../views/HomeRail.tsx', import.meta.url), 'utf8'));

describe('Home entity navigation surface contract', () => {
  /* The workspace map's own contract retired with the map (2026-08-30). It
     pinned `.hp-overview`'s 38% ceiling, the families scroller, the head's
     `flex: none`, the map's forced-colours selected state, the Kinetic classes
     on its rows, the count budget and its container-query ladder. Those are
     claims about a surface Home no longer draws; the taxonomy lives in the
     rail now, and the rail's half of every one of those rules is kept below.
     Every deleted assertion is listed in the PR body. */

  it('keeps the surviving surfaces in forced colours', () => {
    expect(metricsCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.enav-metric--live/);
    expect(metricsCss).toContain('.enav-metric__unit');
  });

  it('introduces no literal colours outside the token sheet', () => {
    expect(homeCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(metricsCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('sizes Home from its parent, never from the viewport', () => {
    expect(homeCss).not.toMatch(/calc\(\s*100vh/i);
  });
});

/**
 * THE NAME BEATS THE COUNT (owner ruling, 2026-08-29).
 *
 * His expanded rail rendered a nav row as `: 577 · 471 new · 17 live` — the
 * word "Sessions" squeezed off its own row by its own counters. The rail sized
 * the count to its content and left the name as the only thing that could
 * absorb a deficit, so the name is what died.
 *
 * The map carried the same law and the same fix; the map is gone (2026-08-30)
 * and its half of these assertions went with it. What remains is the RAIL,
 * which is now the one home for the kind list — so these matter more than
 * before, not less: they are no longer one of two renderings pinned, they are
 * the only one.
 *
 * Each is a silent regression if it breaks: the layout still renders, it just
 * renders the wrong word missing, and jsdom cannot see it.
 */
describe('a name is never truncated by its own count', () => {
  it('never clips a count, because a sliced number is a wrong number', () => {
    /* `overflow: hidden` on a count is the trap this pins shut. An ellipsis
       tells the reader a WORD was cut; nothing tells them `577` was cut to
       `57`, and both render as a perfectly plausible number. */
    const cap = homeCss.match(
      /\.cv2-root \.hr-rail__row > \.hr-rail__metrics[\s\S]*?\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(cap).toContain('flex: none');
    expect(cap).toContain('white-space: nowrap');
    expect(cap).not.toContain('overflow: hidden');
    expect(cap).not.toMatch(/max-width/);
    for (const selector of [
      '.cv2-root .hr-rail__grouphead > .enav-metrics',
      '.cv2-root .hr-rail__row > .hr-rail__metrics',
    ]) {
      expect(homeCss).toContain(selector);
    }
  });

  it('lets every name take the remaining room and clip inside it', () => {
    const block = homeCss.match(/\.cv2-root \.hr-rail__label\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(block).toContain('flex: 1 1 auto');
    expect(block).toContain('min-width: 0');
    expect(block).toContain('text-overflow: ellipsis');
    /* `WORK2281`: the group eyebrow shrank to nothing and its letters kept
       painting across the gap into the count, because nothing clipped them. */
    const eyebrow = homeCss.match(/\.cv2-root \.hr-rail__eyebrow\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(eyebrow).toContain('overflow: hidden');
    expect(eyebrow).toContain('text-overflow: ellipsis');
  });

  /* `gives each row ONE number by never passing the unseen count to a row`
     is DELETED, not fixed, and the reversal is deliberate.

     It encoded an owner ruling from 2026-08-29 — "2078 new out of 2283 was
     never the fact anyone wanted" — by asserting neither source passes
     `unseen`. The 2026-08-30 target design puts `N new` on every row, and the
     ruling behind it is sharper than the one it replaces: `N new` is not a
     quantity, it is UNATTENDED WORK, and it changes what you do next. That is
     the test colour and prominence have to pass, and a count of unread rows
     passes it where a raw total does not.

     So the assertion is removed rather than inverted. Inverting it would claim
     the new behaviour was always required; deleting it with this note records
     that a ruling was superseded by a later one, which is the only form in
     which the next reader can tell the difference. The rail is unchanged and
     still passes no `unseen` — that is now HomeRail's business, not a rule
     this file pins for both surfaces. */

  it('states the create verbs and no longer states an inventory', () => {
    /*
     * WHAT THIS REPLACED, and why the old assertions are gone rather than
     * relaxed. Until 2026-08-30 Home rendered WORK / LIBRARY / PEOPLE cards —
     * nineteen kind rows with their counts — and two `it` blocks here pinned
     * their noun/count width budget and their container-query drop order.
     *
     * The owner removed the cards, on the deployed build, in these words:
     * "why cant it be simplified ... i dont need make home dashboard clean
     * have one create new chat, New SESSIONS AND New Task first and their
     * screens while running".
     *
     * THE CARDS AND THEIR TESTS WENT IN ONE COMMIT. Deleting the component and
     * leaving these assertions would have left them GREEN against a surface
     * that renders nowhere — which this fleet catalogued seven times on
     * 2026-08-30 and named as the failure mode to stop repeating. A passing
     * test about a deleted screen is worse than no test: it reports coverage
     * that cannot fail.
     */
    expect(homeCss).not.toContain('hp-group');
    expect(homeCss).not.toContain('hp-hero');
    expect(homeCss).not.toContain('container-name: hp-card');

    // And the row that replaced them exists, so this is not merely an absence.
    const start = homeCss.match(/\.cv2-root \.hp-start\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(start, 'no .hp-start rule — the verbs have no row').not.toBe('');
    // THE TRACK IS FLOORED. `repeat(auto-fit, minmax(148px, 1fr))` — at the
    // 320px floor three cards cannot sit side by side, and a floored track
    // drops to one whole column instead of crushing all three. An unfloored
    // `minmax(0, …)` is banned by name in this package because it collapses a
    // region to nothing.
    expect(start).toContain('minmax(150px, 1fr)');
    expect(start).not.toContain('minmax(0');

    // ONE SURFACE, NOT A BOX PER VERB. The owner, on the first render:
    // "why is the line in between create chat and create task". The frame
    // belongs to the SET; the only rule inside it separates two verbs, and it
    // falls away on the first so a wrapped grid never opens with a stray line.
    const card = homeCss.match(/\.cv2-root \.hp-start__card\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(card, 'no .hp-start__card rule').not.toBe('');
    expect(card).toContain('border: 0');

    /* THE BOX MUST NOT YIELD. It sits in a flex column beside a much taller
     * strip and carries `overflow: hidden` for its corners — which by Flexbox
     * §4.5 sets its automatic minimum size to ZERO. Without `flex: none` the
     * column crushes it to its two border pixels, cards and all: measured at
     * exactly 2px on the live build 2026-08-30, with both buttons present in
     * the DOM and their text intact. Nothing in 4,974 tests could see it.
     */
    expect(start, 'the create box will be crushed by the flex column').toContain('flex: none');
    expect(card).toContain('border-left: 1px solid');
    expect(homeCss).toContain('.hp-start__card:first-child');

    // A REFUSED VERB IS SHOWN, NOT HIDDEN. If this rule disappears the verb
    // silently vanishes when the server refuses it, which reads as a missing
    // feature rather than a known state.
    expect(homeCss).toContain('.hp-start__card--off');

    // PROGRESS AND ACTIVITY — the two facts a running card carries. Tabular,
    // because these numbers stack down a column and must not dance.
    const facts = homeCss.match(/\.cv2-root \.hp-attention__facts\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(facts, 'no .hp-attention__facts rule — the running cards show no progress').not.toBe('');
    expect(facts).toContain('tabular-nums');
  });

  it('stacks the ways-in and the active work above the conversation', () => {
    /*
     * THIS PINNED `grid-template-columns: 4fr 8fr` — the side-by-side split
     * that WAS the brief expressed as screen area. The owner replaced it on
     * 2026-08-30, choosing a mix of two drawn layouts: the create cards and the
     * active work run across the FULL WIDTH, and the conversation takes what is
     * left beneath them.
     *
     * The old assertion is not relaxed, it is REPLACED — a test that still
     * demanded columns would have made the owner's own layout a failure.
     */
    const home = homeCss.match(/\.cv2-root \.hp-home\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(home).toContain('grid-template-rows');
    expect(home).not.toContain('grid-template-columns');
    expect(home).toContain('min-height: 0');

    /* THE CONVERSATION ROW IS FLOORED. `minmax(0, 1fr)` — an unfloored track
     * lets a long transcript grow the row and push the cards off the top,
     * which is the same collapse L4 bans by name elsewhere in this package. */
    expect(home).toContain('minmax(0, 1fr)');
  });

  it('gives the tail past ten a row, not another card', () => {
    /* Owner, 2026-08-30: "displaying top 10 rest everything as expansion button
       like row items". The SELECTION rule is tested as behaviour in
       home-active-tail.test.ts; what is pinned here is that the tail has its
       own shape at all, because a tail rendered as more cards is the crowded
       screen the whole pass exists to undo. */
    expect(pageTsx).toContain('hp-arows');
    expect(pageTsx, 'the expansion control lost its state for assistive tech').toContain(
      'aria-expanded',
    );

    const row = homeCss.match(/\.cv2-root \.hp-arow\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(row, 'no .hp-arow rule — the tail is unstyled').not.toBe('');
    /* FOUR COLUMNS AND ONLY THE TITLE GIVES WAY. The name is the sole track
       floored at 0; kind and time are `auto` and stay whole. CSS flex/grid
       yields whatever CAN yield, not whatever should, so the floor is how the
       choice is made rather than hoped for. */
    expect(row).toContain('minmax(0, 1fr)');
    expect(row).toContain('grid-template-columns');

    const title = homeCss.match(/\.cv2-root \.hp-arow__title\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(title).toContain('min-width: 0');
    expect(title).toContain('text-overflow: ellipsis');

    /* THE TIME IS A NUMBER IN A COLUMN. Same tabular rule the cards keep. */
    const when = homeCss.match(/\.cv2-root \.hp-arow__when\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(when).toContain('tabular-nums');

    /* One kind→colour language at two volumes: a ground on the cards, a 6px
       dot on the rows. All three must be spelt, or the tail loses the kind. */
    for (const kind of ['sessions', 'tasks', 'chats']) {
      expect(homeCss, `the tail rows lost the colour for ${kind}`).toContain(
        `.hp-arow__dot--${kind}`,
      );
    }

    /* THE TAIL SCROLLS IN ITS OWN BOX. `.hp-home`'s first row is `auto`, so
       fifty-three expanded rows take the whole grid and the conversation row
       resolves to nothing. Measured, not feared: `.hp-live` was 2px on the
       live build when this row grew unchecked. */
    const tailRules = [...homeCss.matchAll(/\.cv2-root \.hp-arows\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .join('\n');
    expect(tailRules, 'no .hp-arows rule at all').not.toBe('');
    expect(tailRules, 'the expanded tail can grow without limit').toMatch(/max-height/);
    expect(tailRules, 'a capped box that does not scroll just clips').toMatch(/overflow-y:\s*auto/);
  });

  it('draws no divider for a panel that is not there', () => {
    /* `.hp-listsep` is the LIST panel's drag handle. On this surface the list
       panel is `display: none` — measured at 0px wide while its handle was
       9px x 901px at x=370, a hairline down a third of the screen dividing
       nothing from nothing and painted over the cards. Both halves of the
       hidden pair are pinned together so neither can come back alone. */
    expect(homeCss).toMatch(/\.hp-live \.tch-sidebar\s*\{\s*display:\s*none/);
    expect(homeCss).toMatch(/\.hp-live \.hp-listsep\s*\{\s*display:\s*none/);

    /* HIDING AN ITEM DOES NOT REMOVE ITS TRACK. `.tch-root` measured
       `280px 1005.82px` with the sidebar hidden, so the conversation took the
       sidebar's 280px column and overflowed it at 308px beside a thousand
       empty pixels. The column collapse has to travel with the hide, and the
       replacement track must be floored — an unfloored `1fr` lets a long
       unbroken line in the transcript set the minimum (L4). */
    const root = homeCss.match(/\.cv2-root \.hp-live \.tch-root\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(root, 'the hidden sidebar still reserves its column').toContain(
      'grid-template-columns',
    );
    expect(root).toContain('minmax(0, 1fr)');
  });

  it('states the active work once, not once as cards and again as rows', () => {
    /* THE DUPLICATION THE OWNER NAMED THREE TIMES. The strip carries sessions,
       chats and tasks in one capped list; `MY LIVE SESSIONS` and `MY TASKS`
       below it were the same five sessions and three tasks a second time on
       the same screen. NEEDS YOU stays — it answers "what is waiting on YOU",
       which the strip does not. */
    expect(pageTsx, 'the live sessions are drawn twice again').not.toContain('liveStrip');
    expect(pageTsx, 'the tasks are drawn twice again').not.toContain('tasksStrip');
    expect(pageTsx).toContain('needsYouStrip');
  });
});

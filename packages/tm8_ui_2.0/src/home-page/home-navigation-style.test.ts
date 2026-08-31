import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const homeCss = strip(readFileSync(new URL('./home-page.css', import.meta.url), 'utf8'));
const metricsCss = strip(
  readFileSync(new URL('../navigation/entity-navigation-metrics.css', import.meta.url), 'utf8'),
);
const pageTsx = strip(readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8'));
const railTsx = strip(readFileSync(new URL('../views/HomeRail.tsx', import.meta.url), 'utf8'));
/* The host is read too: after the 2026-08-30 restructure the claim "no divider
   for a panel that is not there" is about what is NOT BUILT, and the builder is
   `HomeView`. A CSS-only assertion could only pin that it is painted out. */
const viewTsx = strip(readFileSync(new URL('../views/HomeView.tsx', import.meta.url), 'utf8'));

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

  it('scrolls the whole grid instead of capping it', () => {
    /*
     * THIS PINNED A TAIL: ten cards, everything past them as rows behind a
     * button. The owner replaced it on 2026-08-30 — "grid idea bane undi kani,
     * showing only top few is not scalable and limiting" — so the assertion is
     * REPLACED rather than relaxed. A test still demanding `.hp-arows` would
     * have made the owner's own decision a failure.
     */
    expect(pageTsx, 'the tail rows came back').not.toContain('hp-arows');
    expect(pageTsx, 'the top-N cap came back').not.toContain('splitActive');

    const grid = homeCss.match(/\.cv2-root \.hp-active__grid\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(grid, 'no .hp-active__grid rule').not.toBe('');
    /* BOUNDED AND SCROLLING. Unbounded, row one of `.hp-home` is `auto` and
       sixty cards take the whole grid — which is measurably how the
       conversation ended up at 2px once already. */
    expect(grid, 'the grid can grow until it eats the conversation').toMatch(/max-height/);
    expect(grid, 'a bounded grid that does not scroll just hides work').toMatch(
      /overflow-y:\s*auto/,
    );
    /* A short list sits at the top of the region rather than stretching two
       cards down its whole height. */
    expect(grid).toMatch(/align-content:\s*start/);
    /* AND THE ROWS COME FROM THEIR CONTENT, NOT FROM THE BOX. `max-height`
       makes the grid's block size definite, and with implicit `auto` rows the
       browser divided that height across them: measured live, eleven rows at
       11.8182px holding cards 87-156px tall, every card painting through the
       one below it. A scroller whose rows are sized by its own height is not a
       scroller. */
    /* THE ROWS MUST BE PINNED, and `max-content` is no longer enough. With
       `max-height` making the grid's block size definite, implicit `auto` rows
       were DIVIDED across it rather than taken from their content — measured
       live at eleven rows of 11.8182px holding cards 87 to 156px tall, every
       one painting through the row below. `max-content` cured the overlap and
       left rows of UNEQUAL height, so the bounded region still cut its second
       row through the middle of its cards. A fixed row cures both, and the
       card's chips are capped to one line so the fixed row is honest. */
    expect(grid, 'the rows will be divided across the box and the cards will overlap').toMatch(
      /grid-auto-rows:\s*\d+px/,
    );
    expect(grid, 'the region no longer shows a whole number of rows').toMatch(
      /max-height:\s*\d+px/,
    );

    /* THE FLOOR SURVIVED THE REWRITE. L4: never an unfloored track. */
    expect(grid).toContain('minmax(200px, 1fr)');
  });

  it('lets a card carry links without nesting them in a button', () => {
    /* The PR chips render an `<a>` each. An anchor inside a button is invalid
       HTML and the nested interactive swallows its own clicks, so the card is
       a container and the open gesture is an inner button. */
    expect(pageTsx).toContain('hp-acard__open');
    expect(pageTsx).toContain('LinkedPullRequestChips');

    const open = homeCss.match(/\.cv2-root \.hp-acard__open\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(open, 'no .hp-acard__open rule — the card body is unstyled').not.toBe('');
    expect(open).toContain('cursor: pointer');

    /* A CHAT NEVER GETS A PR ROW. It is keyed by its root message and carries
       no PR edges, so the index can only answer "none" — and a row that said
       so would be a claim about the world rather than about our read. */
    expect(pageTsx).toMatch(/row\.lens === 'chats' \? \[\]/);
  });

  it('draws no divider for a panel that is not there', () => {
    /* SUPERSEDED, AND REPLACED RATHER THAN DELETED — the 2026-08-30 Home
       restructure (two modes, never both). This case used to pin the pair of
       `:not([data-kind])` hides: the middle column `.tch-sidebar` and its drag
       handle `.hp-listsep` were switched off on the dashboard and switched
       back ON when the rail picked a kind, because that column was where the
       kind's list rendered.

       It is not where it renders any more. A selected kind takes the WHOLE
       working area (`.hp-listmain`), so the middle column never comes back and
       the condition has no subject. The claim that survives is stronger, not
       weaker: the column is retired UNCONDITIONALLY, which is the thing the
       `:not()` could only approximate. The hairline that this case is named
       for — measured 9px x 901px at x=370 against a 0px panel — is now
       impossible for a better reason than a hide: nothing renders it. */
    /* THE HIDE IS GONE, AND ITS ABSENCE IS THE CLAIM. Home used to switch the
       chat's thread column off with `display: none`, which hides a column the
       screen is still building and still reasoning about — and that belief is
       load-bearing: `soloConversation` is what makes a null selection mean
       "the new-chat composer". Hiding it left New chat dead. Home declares
       solo now, so there is no column to hide. */
    expect(homeCss, 'the CSS hide came back and New chat will be dead again').not.toMatch(
      /\.hp-live \.tch-sidebar\s*\{\s*display:\s*none/,
    );
    expect(
      homeCss,
      'the column is conditioned again — a third column that can come back is the one that was removed twice',
    ).not.toMatch(/:not\(\[data-kind\]\)/);

    /* THE DIVIDER IS GONE FROM THE TREE, NOT PAINTED OUT. `HomeView` used to
       build a `PanelResizer` + chevron strip for column A and hand it to the
       page as `listRail`; both the prop and the strip are retired. A control
       that cannot move anything should not exist — hiding it in CSS leaves it
       in the a11y tree, focusable, announcing that it resizes a region that is
       not on the screen. This is the assertion that keeps it out. */
    expect(viewTsx, 'column A’s drag handle is back').not.toContain('hp-listsep');
    expect(pageTsx, 'the page takes a separator for a panel it does not draw').not.toContain(
      'listRail',
    );

    /* WHAT THE RAIL'S SELECTION REACHES INSTEAD. `data-kind` still rides the
       page — the root carries the kind — but what it switches is which of the
       two modes renders, not whether a hidden column is allowed back. */
    expect(pageTsx, 'the rail selection never reaches the page').toContain('data-kind=');
    expect(pageTsx, 'the kind’s list is not the working area').toContain('hp-listmain');

    /* HIDING AN ITEM DOES NOT REMOVE ITS TRACK. `.tch-root` measured
       `280px 1005.82px` with the sidebar hidden, so the conversation took the
       sidebar's 280px column and overflowed it at 308px beside a thousand
       empty pixels. The column collapse has to travel with the hide, and the
       replacement track must be floored — an unfloored `1fr` lets a long
       unbroken line in the transcript set the minimum (L4). Unconditional now,
       for the same reason the hide above is. */
/* THE TRACK OVERRIDE WENT WITH THE HIDE, and its absence is the claim.
       Home used to collapse `.tch-root` to one column because it had hidden the
       sidebar and `display: none` removes a grid ITEM but not its TRACK — the
       conversation landed in the sidebar's 280px column and overflowed it at
       308px beside a thousand empty pixels. None of that arises now: the screen
       is told it is solo, so it renders `.tch-root--solo` (its own one-column
       rule) and never builds the column at all. An override here would be Home
       correcting a layout the screen no longer produces. */
    expect(homeCss, 'Home is overriding a grid the chat screen no longer builds').not.toMatch(
      /\.hp-live \.tch-root\s*\{/,
    );
  });

  it('gives the kind’s list the whole working area, and floors both tracks when B opens', () => {
    /* THE REPLACEMENT FOR EVERYTHING THE `:not([data-kind])` PAIR USED TO SAY.
       Selecting a kind means "show me all of those" — it always did; what
       changed is that the answer is the working area rather than a third
       column restating the rail's taxonomy. Pinned here because jsdom cannot
       see a track, and because the alternative arrangement (a column beside
       the dashboard) is the one the owner removed twice. */
    const main = homeCss.match(/\.cv2-root \.hp-listmain\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(main, 'no .hp-listmain rule — the kind list has no working area').not.toBe('');
    expect(main).toMatch(/flex:\s*1 1 auto/);
    /* L4 + Flexbox 4.5: an unfloored child of a flex column with `overflow`
       set collapses to nothing, which this package has shipped once already. */
    expect(main).toContain('min-height: 0');
    expect(main).toContain('min-width: 0');

    /* AND R6a SURVIVES INSIDE IT: a row click roots an entity in region B, and
       region B is no longer the chat surface's centre on this mode, so the
       list and the entity share the area. Both tracks floored (L4). */
    const split = homeCss.match(/\.cv2-root \.hp-listmain__split\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(split, 'no .hp-listmain__split rule — a list click has nowhere to land').not.toBe('');
    expect(split).toContain('minmax(240px, 340px)');
    expect(split).toContain('minmax(0, 1fr)');
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

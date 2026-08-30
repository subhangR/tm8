/**
 * THE SHELL CONTRACT'S MACHINE FLOORS.
 *
 * Ten of this gate's rows are human-gate, and nine of those ten also carry a
 * machine floor precisely so that "a person looked once" does not have to hold
 * the line forever. This file is those floors.
 *
 * WHAT A FLOOR IS AND IS NOT. It cannot prove the copy is honest, that a sheet
 * feels like a sheet, or that a control is reachable by a thumb — those need a
 * device and a person. What it CAN do is make the specific regression that
 * produced each defect unable to return silently: a card that reads its copy
 * from the wrong place, a `title=` creeping back into the shell's own chrome,
 * an entity arm that stops checking the kind.
 *
 * SOURCE-TEXT ASSERTIONS, deliberately, for the rules whose failure is
 * structural rather than behavioural. jsdom cannot see layout (DEF-037) and
 * rendering the whole shell to prove "there is no `title=` on the header" would
 * test the fixture as much as the rule. Comments are stripped first, exactly as
 * `mobile-frame.test.ts` and `no-router-fork.test.ts` do it and for the same
 * reason: THIS FILE FAMILY EXPLAINS THE THINGS IT FORBIDS, and a negative
 * assertion over raw text would fail on the explanation rather than the defect.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { landingOfRoute, routeViewOf } from '../domain/nav-targets';
import { slugOfKind } from '../domain/registry';

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = (path: string) => strip(readFileSync(new URL(path, import.meta.url), 'utf8'));

const shell = read('../views/MobileShell.tsx');
const screens = read('./mobile-screens.css');
const frame = read('./mobile.css');
const contract = readFileSync(new URL('./CONTRACT.md', import.meta.url), 'utf8');
const gate = read('../views/GateApp.tsx');

describe('DEF-012 — the refusal card cannot render a sentence that is false', () => {
  it('derives its copy from the view-ref classification, not from a constant', () => {
    // THE DEFECT: one hard-coded sentence — "This link still works on a
    // desktop — nothing about it is broken" — rendered for EVERY default-arm
    // route, including `feed`, which `view-ref-screens.ts` classifies
    // `unbuilt`. The card whose entire job is honesty was lying on it.
    //
    // The fix is structural rather than a reworded string: the "works on a
    // desktop" branch is only reachable when the ref is NOT unbuilt, so a new
    // `unbuilt` ref gets honest copy without anyone remembering to check.
    expect(shell).toContain('isUnbuiltViewRef');
  });

  it('says "does not exist anywhere" and "no phone layout" as DIFFERENT statements', () => {
    // The card's own comment has always said these are different claims. It
    // just made the wrong one. Both sentences must exist for the branch to be
    // meaningful — one of each.
    expect(shell).toMatch(/doesn’t have a phone layout yet/);
    expect(shell).toMatch(/isn’t built in this app yet/);
    // And the false sentence must NOT be reachable from the unbuilt branch:
    // it appears exactly once, in the arm that is about screen SIZE.
    const stillWorks = shell.match(/This link still works on a desktop/g) ?? [];
    expect(stillWorks).toHaveLength(1);
  });
});

describe('DEF-033 — the shell does not ship the pattern it asks the lanes to remove', () => {
  it('carries no `title=` attribute anywhere in the phone chrome', () => {
    // `title=` renders on HOVER. A phone has none, so a truncated header
    // explaining itself with one offered a recourse no user of that device
    // could reach. DEF-032 asks every lane to replace hover-only reasons with
    // `useReasonDisclosure`; the shell must not be a first-party offender.
    expect(shell).not.toMatch(/\stitle=/);
  });
});

describe('DEF-032 — a refused control explains itself to a FINGER, not only to a mouse', () => {
  /*
   * FINDING, RECORDED RATHER THAN RE-IMPLEMENTED: the adoption this row asks
   * for is ALREADY DONE on main. `DisabledWithReason` routes BOTH of its
   * variants — the inline one and the tooltip one — through
   * `useReasonDisclosure`, which adds an explicit tap alongside hover and
   * `:focus-visible`. The row's machine floor is therefore satisfied by the
   * tree as it stands, and the honest action is to PIN it so it cannot
   * silently regress, not to write a second mechanism beside the first.
   *
   * What was genuinely outstanding in this row's neighbourhood was the shell's
   * own first-party offence — a bare `title=` in the phone header — and that
   * is DEF-033 above. The human-gate half (does a real thumb actually reveal
   * the reason on a device) is on the real-device checklist and no assertion
   * here substitutes for it.
   */
  it('every DisabledWithReason variant goes through useReasonDisclosure', () => {
    const disabled = read('../panels/honesty/DisabledWithReason.tsx');
    const uses = disabled.match(/useReasonDisclosure\(\)/g) ?? [];
    // Two variants, two disclosures. A new variant that forgets one would
    // reintroduce a refusal that is silent on touch.
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it('does not carry a bare title= as an interactive control’s only explanation', () => {
    // SCOPE OF THIS ASSERTION, narrowed after a measurement contradicted the
    // comment that used to sit here. It covers INTERACTIVE controls only.
    const disabled = read('../panels/honesty/DisabledWithReason.tsx');
    expect(disabled).not.toMatch(/role="button"[\s\S]{0,200}\stitle=/);
    //
    // WHAT IT DOES NOT COVER, stated so the pass is not read as a clean bill.
    // `CheckingPermission` keeps a `title`, and this file used to claim that
    // was "NOT this defect" because the element is non-interactive and carries
    // an `aria-label`. The aria-label half is true — a screen reader IS told.
    // The rest was too comfortable: driving the populated tier showed EVERY
    // task row sitting in that placeholder state, so a SIGHTED TOUCH user gets
    // a 16x16 mark whose only explanation is a hover tooltip they cannot open.
    // That is the DEF-032/033 fault class, and it has its own row now.
    //
    // Left as an observation rather than an assertion because the fix is not
    // this contract's: the element belongs to the honesty vocabulary, and
    // whether the state is a product defect or an artifact of a seam that never
    // answers the capability query cannot be told from a capture — the same
    // state would appear on a real node under a slow answer.
    expect(disabled).toContain('CHECKING_CAPTION');
  });
});

describe('DEF-034 — an entity screen is named by the entity, never by its id', () => {
  it('resolves a name before falling back, and the fallback is the KIND', () => {
    // The header printed the raw uuid as the screen title on the channel
    // route, with the real name in a second header directly beneath it.
    // Confirmed at BOTH phone widths, which rules out a hydration artifact.
    expect(shell).toContain('nameOfEntity');
    // The fallback is a kind label. `getKind(...).label` is a word; the ref is
    // a uuid. Asserting the lookup exists is what stops a future edit from
    // "simplifying" it back to `activeTarget.ref`.
    expect(shell).toMatch(/getKind\(activeTarget\.kind\)/);
  });
});

describe('DEF-035 — the entity arm checks the KIND, as the desktop arm does', () => {
  it('does not render ChannelView for every entity target', () => {
    // The arm tested `type === 'entity'` and nothing else, so a voice room
    // would have opened a message feed against something that has none — and
    // the feed would have looked EMPTY rather than wrong. `landingOfRoute`
    // carries the kind on the target for exactly this discrimination.
    //
    // EVIDENCE STATUS, stated here as it is in the ledger: this is the one row
    // not grounded in a capture. No voice-room route was driven. The row does
    // not close until the build service drives one and confirms this guard;
    // this assertion is the floor under that, not a substitute for it.
    expect(shell).toContain('activeTarget.kind !== CHANNEL_KIND');
  });
});

describe('DEF-038 — the loading state is honest about what is happening', () => {
  it('does not render the bare word "Loading…" on blank paper', () => {
    // The shell hydrates by paging the whole space event log: 25s+ on a large
    // space, and on cellular that is one word on an empty screen with nothing
    // saying whether it is working. It has already cost this program evidence
    // — one before-run capture photographed exactly this and is VOID.
    //
    // The PAGING STRATEGY is not fixed by this row and this assertion does not
    // pretend otherwise. What is fixed is the shell's honesty while it waits.
    expect(shell).not.toMatch(/>\s*Loading…\s*</);
    expect(shell).toContain('data-testid="mobile-loading"');
  });

  it('the wait MOVES — the kit boot loader, not two static sentences', () => {
    // Honest and static is still a screen with no evidence it is working. The
    // phone waits longest of any surface (see the component's note: the whole
    // event log, 500 rows a round trip, before `ready` can flip) and was the
    // one surface not drawing the turning 8 the desktop gate has always used.
    expect(shell).toMatch(/<BootLoader\b/);
    // Imported through the kit BARREL, never a deep path: the barrel is what
    // pulls `kit.css` in, and `../kit/BootLoader` would mount the mark with no
    // stylesheet behind it on any screen that had not already loaded one.
    expect(shell).toMatch(/import \{[^}]*\bBootLoader\b[^}]*\} from '\.\.\/kit'/);
    // Told, not just drawn: a screen reader on a silent screen learns nothing.
    // The role now rides `BootLoader` itself — asserted where it lives, in
    // `kit/kit.test.tsx`, on a RENDER rather than on this file's text. A regex
    // here would match the docblock above it and pass on a comment.
  });
});

describe('DEF-003 — the phone can reach the account, the space and the theme', () => {
  it('mounts an account affordance with the testid the ledger names', () => {
    // No geometric instrument will ever flag this: a control that does not
    // exist has no bounding box, so every tap census scored these screens as
    // PASSING. Absence measures as health.
    expect(shell).toContain('data-testid="mobile-account-menu"');
    expect(shell).toContain('MobileAccountSheet');
  });

  it('renders the affordance only when there is something behind it', () => {
    // A trigger opening a sheet with no identity and no sign-out verb is the
    // enabled-inert defect this ledger files three separate rows about.
    expect(shell).toMatch(/props\.viewerActor \?/);
  });
});

describe('the drawer replaced the tab bar, and the bar cannot come back by halves', () => {
  /*
   * THESE ARE THE FLOORS UNDER OWNER RULINGS 1–7 (2026-08-19). They replace the
   * tab bar's own assertions rather than deleting them — the property each one
   * protected still matters, it just has a different carrier now.
   *
   * WHY SOURCE TEXT AND NOT A RENDER. Same reason as every other case in this
   * file: jsdom loads no stylesheets and sees no layout, so "the drawer is the
   * desktop rail" and "the ☰ is on every screen" are structural claims about
   * where the words come from, not behavioural ones. A render test here would
   * prove the fixture.
   */
  const drawer = read('./MobileDrawer.tsx');

  it('the shell stops FILLING the tab bar region, and does not remove the region', () => {
    // Ruling 1, both halves. The bar is gone from the shell; the slot survives
    // in the frame, because removing a region is a different change with a
    // different blast radius and `mobile-frame.test.ts` owns that contract.
    expect(shell).not.toContain('mobile-tabs');
    expect(shell).not.toMatch(/tabBar=/);
    expect(read('./MobileFrame.tsx')).toMatch(/\{tabBar\s*\?/);
  });

  it('draws its words and marks from the DESKTOP registries, not from a phone list', () => {
    // Ruling 2. Two navigation vocabularies for one product is how it starts
    // feeling like two products. `TABS` was a third copy of two registries and
    // it is what this asserts cannot return: the destinations come from
    // `VIEW_PRESENTATION`, the entity rows from `homeRailGroups()` — the very
    // table the desktop Home rail renders — and the marks from `KindIcon`,
    // which reads `KIND_ART`.
    expect(drawer).toContain('VIEW_PRESENTATION');
    expect(drawer).toContain('homeRailGroups');
    expect(drawer).toContain('KindIcon');
    // No kind literals: §15.2 makes one outside `domain/` a build failure, and
    // the rule is doing real work here — a hand-written kind list is exactly
    // how the two shells would drift.
    expect(drawer).not.toMatch(/'(task|work_session|channel|doc|pull_request)'/);
  });

  it('names its four sections in the ruled order', () => {
    // Ruling 3. Chats first because it is what a reader returns to; Settings
    // and the account at the foot rather than lost at the bottom of a long
    // scroll.
    const order = ['"Chats"', '"Destinations"'].map((label) => drawer.indexOf(label));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(drawer).toContain('mdrawer__foot');
    expect(drawer).toContain('SETTINGS_REF');
  });

  it('is opened by the header ☰ on EVERY screen, not on the chat screen alone', () => {
    // Ruling 4. The ☰ used to be gated on `onChatScreen`; it is the only
    // navigation this shell has left, so a gate there would strand every other
    // screen with no way to reach anything.
    //
    // ASSERTED AS THE ABSENCE OF A TERNARY IMMEDIATELY AROUND THE TRIGGER, and
    // the shape is exact rather than a proximity match on purpose: the header's
    // own root element carries `data-chrome={onChatScreen ? …}` a few lines up,
    // so anything looser passes on the wrong text. What must not return is the
    // `{cond ? (<button className="mobile-header__menu" …` form the ☰ shipped
    // in before this change.
    expect(shell).toContain('data-testid="mobile-drawer-menu"');
    expect(shell).not.toMatch(/\?\s*\(\s*<button[^>]*mobile-header__menu/);
  });

  it('carries unseen, and ABSENT IS NOT ZERO', () => {
    // Ruling 5, and it is the row that decides whether this change is an
    // improvement or a regression: Inbox left the always-visible row, so
    // without a carrier the drawer would be a strictly worse Inbox.
    //
    // THE THREE-VALUED ANSWER IS THE POINT. `useGateData` swallows a failed
    // `spaces.counts` so the counters can never cost the boot, which means
    // "could not count" is a real and common state. A `boolean` return would
    // fold it into `false` and the ☰ would draw an all-clear nobody
    // established — and a row would draw a `0` nobody counted.
    expect(shell).toContain('anyUnseen');
    expect(drawer).toMatch(/anyUnseen\([^)]*\): boolean \| null/);
    expect(drawer).toMatch(/counts && counts\.unseen > 0/);
    // The `null` arm is reachable: a count that never landed is not zero.
    expect(drawer).toMatch(/return counted \? false : null/);
  });

  it('still names the screen everywhere except the chat screen', () => {
    // Ruling 6. With no highlighted tab, the header is the only thing that says
    // where you are — so the title band matters MORE than it did, not less. The
    // chat screen stays bare (PR #427): a blank canvas with a composer needs no
    // caption.
    expect(shell).toMatch(/onChatScreen \? null : \(/);
    expect(shell).toContain('mobile-header__title');
  });

  it('opens a kind FULL-SCREEN and closes, rather than listing inside itself', () => {
    // Ruling 7. A drawer that expanded a kind into rows beside itself is a
    // two-pane phone UI, which is the arrangement the whole mobile shell exists
    // to refuse. Every row goes through one `go()` that navigates AND dismisses,
    // so "a row that forgot to dismiss" is not a shape this file has.
    expect(drawer).toMatch(/navigateTo\(target\);\s*onDismiss\(\);/);
    // And it renders no list: `EntityListPanel` has no business in here.
    expect(drawer).not.toContain('EntityListPanel');
  });

  it('grows its targets with real geometry, never a pseudo-element', () => {
    // The audit measures `getBoundingClientRect()` OF THE ELEMENT, so an
    // `::after` hit area scores as fixed while the thumb still misses. Same
    // rule the shell sheets are held to above, applied to the new sheet.
    const drawerCss = read('./mobile-drawer.css');
    expect(drawerCss).not.toMatch(/::(after|before)[^{]*\{[^}]*min-(block-size|height)/);
    expect(drawerCss).toMatch(/\.mdrawer__row\s*\{[\s\S]{0,200}min-block-size:\s*var\(--mobile-touch-min\)/);
  });
});

describe('the FAB — a create verb on the list, and an ABSENCE where there is none', () => {
  const entityView = read('../views/EntityView.tsx');
  const screensCss = screens;

  it('is the SAME verb the header + performs, not a second create path', () => {
    // Owner answer B. `createFlow` is the one `useNewTask` handle, with the one
    // `onCreated` that opens the new entity with its title focused (D3). Two
    // create paths is two chances to make differently-shaped entities.
    expect(entityView).toMatch(/className="ev-fab"[\s\S]{0,400}createFlow\.create\(\)/);
  });

  it('is ABSENT, not inert, for a kind with no wired create', () => {
    // Owner answer C. Commits, worktrees and PRs are observed rather than
    // authored. The gate is registry data and it is DELIBERATELY the same
    // expression `createSlot` is gated on, so the FAB and the header ＋ cannot
    // disagree about whether this kind can be born.
    expect(entityView).toMatch(/oneSurface && !selectedId && config\.list\.quickCreate \?/);
  });

  it('never renders on a desktop, by construction rather than by a selector', () => {
    // `oneSurface` is false wherever there is no `MobileSurfaceProvider`, which
    // is every desktop mount — so the element is not in the desktop DOM at all,
    // and the styling is additionally scoped to the phone shell.
    expect(screensCss).toMatch(/\.cv2-root\[data-shell='mobile'\] \.ev-fab/);
    expect(screensCss).not.toMatch(/^\.ev-fab/m);
  });

  it('leaves the list room, so the last row is never trapped underneath', () => {
    // Owner answer D. A pinned control over a scrolling list eats the final row
    // unless the list ends above it — and NO metric in this program can see
    // that: the row is present, laid out and measurable, it is simply covered.
    expect(screensCss).toMatch(/\.lp__body\s*\{[^}]*padding-bottom:\s*var\(--mobile-fab-reserve\)/);
    expect(frame).toMatch(/--mobile-fab-reserve:/);
  });
});

describe('DEF-030 — the list chrome is a BUDGET, and it is spent in three bands', () => {
  const listPanel = read('../panels/EntityListPanel.tsx');
  const entityView = read('../views/EntityView.tsx');

  /*
   * The measured before/after this block exists to keep true, at 390x844 in
   * Chrome with `isMobile`/`hasTouch` (`e2e/capture-list-chrome.mjs`):
   *
   *   header 53 · selector 53 · new-task 55 · search 44 · tabs 50 · filters 101
   *     → first row at 372px, 44.1% of the screen, list 478px, ~9 rows
   *   header 53 · selector+search 48 · tabs 48
   *     → first row at 155px, 18.4% of the screen, list 695px, ~14 rows
   *
   * Every assertion below is one of the three moves that bought the 217px. A
   * band that quietly comes back is a band nobody measured, so each is pinned
   * by the rule that removed it rather than by the total.
   */

  it('places the bands explicitly, so an optional one cannot re-flow the grid', () => {
    // Auto-placement is a function of WHICH optional bands rendered — the lens
    // note is absent on most kinds and present on a collection lens. Explicit
    // `grid-row`/`grid-column` is indifferent to that; auto-placement is not,
    // and the failure is a phone-only reordering no unit test can see.
    expect(screens).toMatch(/\.lp\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(screens).toMatch(/\.lp__selector\s*\{\s*grid-row:\s*1;\s*grid-column:\s*1;/);
    expect(screens).toMatch(/\.lp__searchrow\s*\{\s*grid-row:\s*1;\s*grid-column:\s*2;/);
  });

  it('retires the three bands it retired by DISPLAY, not by not rendering them', () => {
    // `display: none` keeps every class string, every floor rule and every
    // sheet host in the tree, which is what lets the filter bar's four menus
    // still mount into `MobileSheet` from a hidden subtree. Deleting the JSX
    // would have deleted the desktop's bands with it.
    expect(screens).toMatch(/\.lp__actions\s*\{\s*display:\s*none/);
    expect(screens).toMatch(/\.lp__filterbar\s*\{\s*display:\s*none/);
  });

  it('gives the two surviving rows a REAL floor, not a pseudo-element', () => {
    expect(screens).toMatch(/\.lp__selector\s*\{[^}]*min-height:\s*48px/);
    expect(screens).toMatch(/\.lp__tierrow\s*\{[^}]*min-block-size:\s*48px/);
    // The search input is the target, not the row that pads it: a padded
    // parent scored 244x23 in the tap census while the row read as 44.
    expect(screens).toMatch(/\.lp__searchinput\s*\{[^}]*min-block-size:\s*var\(--mobile-touch-min\)/);
  });

  it('costs the tier row no layout for its hairline', () => {
    // No `border-box` reset in this package, so `border-bottom` ADDS to the
    // 48px floor and the band measures 49. An inset shadow draws the same
    // hairline for free — that pixel is the difference between 150 and 149.
    expect(screens).toMatch(/\.lp__tierrow\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 0 var\(--pn-line\)/);
    expect(screens).not.toMatch(/\.lp__tierrow\s*\{[^}]*border-bottom:\s*1px/);
  });

  it('draws the four categories as MARKS but still says their counts aloud', () => {
    // Labels and counts came off the screen, not out of the accessibility
    // tree. A row of four unlabelled rings is a row of four unnamed buttons
    // to a screen reader, which is a worse screen than the one we shrank.
    expect(listPanel).toMatch(/oneSurface \? <CategoryGlyph category=\{tab\.id\} \/>/);
    expect(listPanel).toMatch(/'aria-label': `\$\{tab\.label\}, \$\{tabLabel\(tab\)\}`/);
  });

  it('sends the narrowing verbs to sheets rather than back onto the header', () => {
    // The filter bar's 101px is not deleted work, it is RELOCATED work: the
    // same four menu bodies render into `MobileSheet` from a second control
    // beside the FAB. `picker` is lifted so the panel keeps owning the bodies
    // while the view owns the opening.
    expect(listPanel).toMatch(/const narrowing = \(/);
    expect(listPanel).toMatch(/<MobileSheet title=\{title\}/);
    expect(entityView).toMatch(/picker=\{picker\}[\s\S]{0,80}onPicker=\{setPicker\}/);
    expect(screens).toMatch(/\.cv2-root\[data-shell='mobile'\] \.ev-narrow/);
    expect(screens).not.toMatch(/^\.ev-narrow/m);
  });

  it('clears the row verbs off the STANDARD tile too, not just the task tile', () => {
    // §7j did this for `.pn-tt__actions` — the tasks screen and nothing else.
    // Sessions, channels and every other kind render `.lp__rowactions`, which
    // kept Archive · Collections · Run pinned open on every row AND kept the
    // float, so on a 390px channel row the opaque backing sat on top of the
    // meta: `12 unread · 2 working` rendered as `12 unre`. Laid out, measurable
    // and covered — `overflowCount` scores 0 on it, which is why only the
    // capture found it.
    expect(screens).toMatch(
      /\.lp__tile:not\(\[data-details='open'\]\) \.lp__rowactions > \*:not\(\.lp__rowaction--ind\)\s*\{\s*display:\s*none/,
    );
    // In the flow, or the lone opener goes on covering what it sits beside.
    expect(screens).toMatch(/\.lp__rowactions,[\s\S]{0,400}position:\s*static/);
  });

  it('keeps the opener the tile knows about, and the tile says when it is open', () => {
    // A structural `:not(:last-child)` would break the day a verb is added
    // after the disclosure, and `data-details` is a fact only the tile holds —
    // no descendant selector can read a sibling's `useState`.
    expect(listPanel).toMatch(/data-details=\{detailsExpanded \? 'open' : undefined\}/);
    expect(listPanel).toMatch(/'lp__rowaction lp__rowaction--ind'/);
  });

  it('keeps the kind TOTAL, by moving it to the drawer rather than dropping it', () => {
    const drawer = read('./MobileDrawer.tsx');
    expect(screens).toMatch(/\.lp__total/);
    expect(drawer).toMatch(/className="mdrawer__total"/);
  });
});

describe('DEF-013…020 — the shared touch floor is a token, and it is not a blanket rule', () => {
  it('names the floor once', () => {
    expect(frame).toMatch(/--mobile-touch-min:\s*44px/);
  });

  it('never applies a blanket floor to every button', () => {
    // A blanket rule inflates the desktop-shared dense components that render
    // inside sheets and re-triggers the fixed-height clipping class of bug
    // that `.lp__actions` documents. Per-class overrides only — that is part
    // of the ledger's acceptance string, not advice.
    expect(screens).not.toMatch(/^\s*button\s*\{/m);
    expect(screens).not.toMatch(/\]\s+button\s*\{/);
  });

  it('never extends a hit area with a pseudo-element', () => {
    // The instrument measures getBoundingClientRect() OF THE ELEMENT, so an
    // `::after` hit area is invisible to it AND to the after-run diff: it
    // would score as fixed while the thumb still missed.
    expect(screens).not.toMatch(/::(after|before)[^{]*\{[^}]*min-(block-size|height)/);
  });

  it('unpins the fixed-height containers before growing what is inside them', () => {
    // The lesson of section 4, applied forward: `.lp__selector` is 36px and
    // `.lp__filters` is 32px + `overflow: hidden`. Growing a control inside a
    // pinned box passes the tap census and slices the row in half — and no
    // metric in this program can see vertical clipping (DEF-037).
    expect(screens).toMatch(/\.lp__selector[\s\S]{0,200}height:\s*auto/);
    expect(screens).toMatch(/\.lp__filters[\s\S]{0,220}overflow:\s*visible/);
  });

  it('covers every offender class the ledger enumerated from evidence', () => {
    // Enumerated from the run's per-element offender lists rather than
    // guessed: DEF-013 lp__view, 014 lp__tab, 015 lp__chip, 016 the row title
    // on both trees, 017 lp__statedot, 018 lp__disclosure, 019 the selector
    // actions, 020 ibx-chip.
    //
    // DEF-013 (`lp__view`) is ABSENT from this list, not forgotten: the view
    // switcher was removed from every entity list (2026-08-19), so the class
    // no longer renders and a rule sizing it would be dead CSS. An offender
    // that no longer exists is fixed in the only way that cannot regress.
    for (const cls of [
      'lp__tab',
      'lp__chip',
      'pn-tt__title',
      'lp__title',
      'lp__statedot',
      'lp__disclosure',
      'lp__kind',
      'lp__quick',
      'lp__new',
      'ibx-chip',
    ]) {
      expect(screens).toContain(`.${cls}`);
    }
  });

  it('grows the STATUS COLUMN with the state dot, so the target is not clipped', () => {
    // `.pn-tt__status` is a 16px grid cell. A 44px button inside it hangs 14px
    // past the cell on each side and is clipped by `.lp__tile`'s
    // `overflow: hidden` — while getBoundingClientRect() still reports a clean
    // 44x44 and the instrument passes it. A target that MEASURES 44 and DRAWS
    // 16 is worse than one that measures 16: it closes the row and leaves the
    // thumb exactly where it was.
    expect(screens).toMatch(/\.pn-tt__status\s*\{[\s\S]{0,160}--mobile-touch-min/);
  });

  it('does NOT grow the honestly-disabled primitive (ledger RULE R2)', () => {
    // A disabled control is excluded from the 44px bar because there is
    // nothing to tap. Growing it to 44px produces a BIGGER DEAD CONTROL — the
    // defect there is affordance (DEF-031/032), fixed in the component, not a
    // sizing override. This asserts the ruling was applied rather than
    // forgotten.
    expect(screens).not.toMatch(/\.hon-disabled[^{]*\{[^}]*min-(block-size|inline-size|height|width)/);
  });
});

describe('DEF-043 — the way out of the files refusal reaches a screen that exists', () => {
  /*
   * THE TRAP THIS PINS, and it is a real one that the build service caught in
   * the ledger's own wording rather than in the code: the URL is `k/files`,
   * the KIND is `file`, and `MenuTarget` carries the KIND. Driving `k/file`
   * directly does NOT resolve — it lands on the unrouted card, which would
   * have pointed a reader out of an honest refusal into "this link doesn't
   * name a screen this build has". A strictly worse dead end than the one the
   * row exists to remove.
   *
   * So the affordance passes `ref: 'file'` and `routeViewOf` produces the
   * `files` slug. Passing `ref: 'files'` — the slug — would make
   * `slugOfKind('files')` return null, and `navigateTo` REFUSES a target with
   * no route: the button would render, be pressed, and do nothing. Both
   * failure modes are asserted below so neither can be "fixed" into the other.
   */
  it('navigates by KIND, and that produces the files slug', () => {
    expect(slugOfKind('file')).toBe('files');
    expect(routeViewOf({ type: 'kind', ref: 'file' })).toMatchObject({ view: 'kind', slug: 'files' });
  });

  it('the slug is NOT a valid target ref — passing it would make the button inert', () => {
    expect(slugOfKind('files')).toBeNull();
    expect(routeViewOf({ type: 'kind', ref: 'files' })).toBeNull();
  });

  it('the round trip lands back on the file kind', () => {
    const route = routeViewOf({ type: 'kind', ref: 'file' });
    expect(route).not.toBeNull();
    expect(landingOfRoute(route!)).toMatchObject({ target: { type: 'kind', ref: 'file' } });
  });

  it('the card still refuses — the affordance is beside the refusal, not instead of it', () => {
    // Silently aliasing `files` to `k/files` would violate the shell's own
    // honesty law, one row after fixing a card that lies (DEF-012).
    expect(shell).toContain('mobile-refusal-out');
    expect(shell).toMatch(/data-testid="mobile-not-on-phone"/);
  });
});

describe('UP is defined for an entity screen, not only for a kind screen', () => {
  /*
   * THE GAP: `stackKey` is empty for anything that is not a KIND target, so an
   * `entity` target selected the empty stack and the chevron did not render AT
   * ALL. A cold arrival on a channel link — the most shared address this product
   * has — had no up affordance whatsoever.
   *
   * Pop needs a stack and only a kind screen hosts one. An entity's parent is
   * not on a stack; it is a fact about the entity. So UP is SYNTHESIZED here.
   */
  it('derives the parent from the entity kind rather than popping', () => {
    expect(shell).toContain('upTarget');
    expect(shell).toMatch(/activeTarget\?\.type === 'entity' && slugOfKind\(activeTarget\.kind\)/);
  });

  it('goes through onStepUp, never navigateTo — R15 requires a REPLACE', () => {
    // `navigateTo` pushes. Pushing here would put the entity behind you, so the
    // phone's back gesture returns to it and a link-follower is trapped in a
    // two-item loop with no exit — the exact failure R15 exists to prevent,
    // recreated on the exact entry path it was written for.
    expect(shell).toContain('props.onStepUp?.(upTarget)');
    expect(gate).toContain('stepUpTo');
    expect(gate).toMatch(/coldEntry\.current[\s\S]{0,400}history: 'replace'/);
  });

  it('is NOT drawn for a kind with no collection to go up to', () => {
    // `slugOfKind` is null for the `special` and `anchored` strategies
    // (voice_channel, message) — there is genuinely nowhere up to go, and a
    // chevron there would be a control that cannot perform. Absent, not inert.
    expect(shell).toMatch(/upTarget && props\.onStepUp/);
  });
});

describe('the contract closes the specificity loophole, not just the edit one', () => {
  it('rules that outweighing a shell rule IS a shell change', () => {
    // Every rule in mobile-screens.css is (0,2,1) BY DESIGN. A lane that needs a
    // floor changed and gets no timely ruling restates it at (0,3,1) in its own
    // stylesheet — not an edit of a shell file, legal by the letter of the old
    // rule, and exactly the collision the gate exists to prevent. It is also
    // silent: nothing fails, the shell rule just stops winning.
    expect(contract).toMatch(/specificity\s+exists\s+to\s+outweigh\s+a\s+shell\s+rule\s+is\s+a\s+shell\s+change/i);
  });

  it('names an arbiter and an SLA, because a ledger row notifies nobody', () => {
    // `\s+` rather than a literal space throughout: this file is prose wrapped
    // at ~100 columns, so any multi-word assertion can land across a newline.
    // A test that fails on where a paragraph happens to wrap is testing the
    // formatter, not the rule.
    expect(contract).toMatch(/direct\s+message/i);
    expect(contract).toMatch(/within\s+one\s+working\s+session/i);
  });

  it('rules the one lane-amendable seam once, rather than three times', () => {
    // Two of three lanes need MobileShell.tsx in week one. Adjudicating per
    // collision is how bad precedent gets set.
    expect(contract).toMatch(/LANE-AMENDABLE/);
    expect(contract).toMatch(/screenFor/);
    // And the honest-absence rule survives the amendment.
    expect(contract).toMatch(/\?\? \(\(\) => undefined\)/);
  });
});

describe('every shell stylesheet parses — comments are balanced', () => {
  /*
   * A GUARD FOR A DEFECT THIS CONTRACT SHIPPED TO MAIN.
   *
   * `mobile.css` carried a DANGLING `*​/`: an edit closed one comment block and
   * left the following paragraph as bare top-level text ending in a second
   * `*​/`. A CSS parser reads that text as the beginning of a selector, runs on
   * until the next `{`, and DISCARDS the whole rule as an invalid selector — so
   * `.mobile-frame[data-keyboard='up'] .mobile-frame__tabbar { padding-bottom: 0 }`
   * never applied. The keyboard's home-indicator fix was dead from the day it
   * landed.
   *
   * IT IS INVISIBLE TO EVERYTHING ELSE THIS PACKAGE RUNS. There is no CSS parse
   * step in the test suite, `tsc` does not read stylesheets, and the tap census
   * cannot see a rule that was never in the cascade — the frame simply keeps its
   * safe-area padding, which looks exactly like a device with no keyboard up.
   * A comment-balance check is the cheapest thing that could have failed.
   *
   * IT IS A DEPTH SCAN, NOT A COUNT, AND THE DIFFERENCE IS THE WHOLE POINT.
   * Counting openers against terminators and comparing totals passes a file
   * where a terminator with no opener is later rebalanced by a stray opener:
   * the totals match and the parser is still wrong, because CSS breaks at the
   * POSITION of the unmatched terminator, not at the end of the file. So this
   * walks the text and fails the moment depth goes negative — that assertion
   * fires at the offending offset — and separately requires depth to land on
   * zero, which catches the unclosed block the first assertion cannot see.
   * Two assertions, two distinct failure modes; do not collapse them into a
   * total. The defect that shipped to main happened to be catchable either
   * way (10 openers, 11 terminators); the next one will not be.
   */
  const SHEETS = ['./mobile.css', './mobile-chrome.css', './mobile-screens.css'] as const;

  /**
   * Walks CSS comment delimiters and reports the two numbers that matter:
   * the LOWEST depth reached (negative means a terminator with no opener, at
   * `firstNegativeAt`) and the FINAL depth (non-zero means an unclosed block).
   * Extracted so the assertions below can be run against synthetic text and
   * shown to fail — a guard nobody has watched fail is a guard nobody has
   * tested.
   */
  const scanComments = (text: string) => {
    let depth = 0;
    let minDepth = 0;
    let firstNegativeAt = -1;
    for (let i = 0; i < text.length - 1; i += 1) {
      if (text.startsWith('/*', i)) {
        depth += 1;
        i += 1;
      } else if (text.startsWith('*/', i)) {
        depth -= 1;
        if (depth < minDepth) {
          minDepth = depth;
          if (firstNegativeAt < 0) firstNegativeAt = i;
        }
        i += 1;
      }
    }
    return { minDepth, finalDepth: depth, firstNegativeAt };
  };

  for (const sheet of SHEETS) {
    it(`${sheet} has no dangling comment terminator`, () => {
      const { minDepth, finalDepth, firstNegativeAt } = scanComments(
        readFileSync(new URL(sheet, import.meta.url), 'utf8'),
      );
      // A negative depth is a terminator with no opener — the exact defect.
      expect(minDepth, `dangling comment terminator at offset ${firstNegativeAt} in ${sheet}`).toBe(0);
      expect(finalDepth, `unclosed comment in ${sheet}`).toBe(0);
    });
  }

  /*
   * THE CONTROL. These are the cases the guard exists for, asserted against
   * the same function the sheets run through. The middle one is the case a
   * count-based check gets WRONG, and it is here so that nobody "simplifies"
   * this back into a count without a red test.
   */
  it('fires on a dangling terminator that equal counts would call balanced', () => {
    // Two openers, two terminators — TOTALS MATCH — but the first terminator
    // is unmatched, so the parser is already broken before the second opener.
    const rebalanced = 'a{} */ .dead{x:1} /* still open';
    const scan = scanComments(rebalanced);
    expect(scan.minDepth).toBeLessThan(0);
    expect(scan.firstNegativeAt).toBeGreaterThanOrEqual(0);
  });

  it('fires on the shape that actually shipped, and passes clean text', () => {
    // The mobile.css defect: block closed, prose left bare, second terminator.
    const shipped = '/* one */\n * bare prose\n */\n.rule{a:1}';
    expect(scanComments(shipped).minDepth).toBeLessThan(0);
    // An unclosed block is invisible to the depth-floor check and needs its own.
    const unclosed = '/* opened and never closed\n.rule{a:1}';
    const openScan = scanComments(unclosed);
    expect(openScan.minDepth).toBe(0);
    expect(openScan.finalDepth).toBeGreaterThan(0);
    // And well-formed text trips neither assertion.
    const clean = '/* a */\n.rule{a:1}\n/* b */\n.other{b:2}';
    expect(scanComments(clean)).toMatchObject({ minDepth: 0, finalDepth: 0 });
  });
});

describe('the contract is written down, because the lanes are gated on it', () => {
  it('states what a lane may not touch', () => {
    // After this lands, a lane changing shell CSS is a defect rather than a
    // lane decision — which is only fair if the boundary is written somewhere
    // a lane can read.
    expect(contract).toContain('mobile-screens.css');
    expect(contract).toMatch(/through\s+the\s+ledger/);
    // The three shared facts a lane is most likely to break by accident.
    expect(contract).toContain("data-shell");
    expect(contract).toContain('zoom');
    expect(contract).toContain('--mobile-touch-min');
  });

  it('records the shellFor ruling AND its consequence, with an owner', () => {
    // DEF-041's acceptance forces a stated outcome either way. The cut did not
    // move, so the tablet failure must be recorded as known and owned — the
    // owner being a task id rather than a name, because a task outlives prose.
    expect(contract).toContain('01a016b4-9359-77c6-9078-4354ba8202db');
    expect(contract).toMatch(/known,\s+recorded\s+failure/i);
  });
});

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
    // Told, not just drawn: a screen reader on a silent screen learns nothing.
    expect(shell).toMatch(/role="status"/);
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

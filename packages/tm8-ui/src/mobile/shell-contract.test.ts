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
    // `CheckingPermission` keeps a `title`, and that is NOT this defect: it is
    // not interactive (no `role="button"`, not focusable) and it already
    // carries an `aria-label` saying the same thing. The rule is about a
    // control whose ONLY recourse is a hover tooltip.
    const disabled = read('../panels/honesty/DisabledWithReason.tsx');
    expect(disabled).not.toMatch(/role="button"[\s\S]{0,200}\stitle=/);
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
    for (const cls of [
      'lp__view',
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

describe('the contract is written down, because the lanes are gated on it', () => {
  it('states what a lane may not touch', () => {
    // After this lands, a lane changing shell CSS is a defect rather than a
    // lane decision — which is only fair if the boundary is written somewhere
    // a lane can read.
    expect(contract).toContain('mobile-screens.css');
    expect(contract).toContain('through the ledger');
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
    expect(contract).toMatch(/known, recorded failure/i);
  });
});

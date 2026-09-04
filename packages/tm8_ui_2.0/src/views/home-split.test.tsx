// @vitest-environment jsdom
/**
 * THE DASHBOARD SPLIT — the two panes, the seam between them, and the three
 * things a reader can do to it (owner, 2026-08-31).
 *
 *   "ideally we want sessions and chats and task to be occupying max height
 *    width adjustable up and down"
 *   "Need horizontal split full height is compulsory strictly"
 *   "Priority is vertical split with full height"
 *   "if i adjust width of chat these cards become a list?"
 *   "let's not squash."
 *
 * WHAT IS ASSERTED HERE AND WHAT IS NOT. jsdom applies no stylesheet and
 * reports every box as 0x0 (the standing tm8-ui law), so nothing in this file
 * can see a rendered pixel. What it CAN see is the arrangement the host solved
 * and published — the axis attribute, the custom properties, the separator's
 * announced range, which control is drawn — and the DOM identity of the panes
 * across a flip, which is the one claim a screenshot could never make. The
 * pixels are the render gate's job (`scripts/render-gate.mjs`, rule 7) and the
 * CSS-source claims are `home-page/home-navigation-style.test.ts`'s.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { HOME_SIDE_H_MIN, HOME_SIDE_W_MIN, homeSplitFits } from './HomeView';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

beforeEach(() => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  resetNav();
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

async function openHome() {
  const view = render(<GateApp />);
  await waitFor(() => view.getByTestId('home-page'), { timeout: 5000 });
  await waitFor(() => view.getByTestId('hp-home'));
  return view;
}

const host = (view: ReturnType<typeof render>) =>
  view.container.querySelector('.hp-host') as HTMLElement;

describe('the dashboard split', () => {
  it('opens SIDE BY SIDE — the ruled default, and each pane full height', async () => {
    /* The owner's correction on 2026-08-31 made vertical the default: "Priority
       is vertical split with full height". A reader with nothing remembered
       gets side by side, and the seam is the x-axis handle (`side="left"` — the
       pane it moves sits to its left). */
    const view = await openHome();
    expect(view.getByTestId('hp-home').getAttribute('data-split')).toBe('vertical');
    const handle = view.getByTestId('panel-resizer-left');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    /* IT NAMES THE ELEMENT IT ACTUALLY MOVES. A handle whose target is not on
       the page is the 9px x 901px defect the render gate fails on. */
    expect(handle.getAttribute('aria-controls')).toBe('hp-side');
    expect(view.getByTestId('hp-side').id).toBe('hp-side');
    view.unmount();
  });

  it('FLIPS to stacked from the seam, and the flip persists', async () => {
    const view = await openHome();
    fireEvent.click(view.getByTestId('hp-split-flip'));
    await waitFor(() =>
      expect(view.getByTestId('hp-home').getAttribute('data-split')).toBe('horizontal'),
    );
    /* Stacked, the seam is the y-axis handle and announces itself as the
       HORIZONTAL rule it now is. */
    const handle = view.getByTestId('panel-resizer-top');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-controls')).toBe('hp-side');
    view.unmount();

    /* The choice is a preference, so it follows the reader across a reload —
       and it is a CHOICE FROM A CLOSED SET, so `usePanelChoice` is the shape
       that holds it. */
    const second = await openHome();
    expect(second.getByTestId('hp-home').getAttribute('data-split')).toBe('horizontal');
    second.unmount();
  });

  it('flips WITHOUT REMOUNTING either pane — the claim a screenshot cannot make', async () => {
    /*
     * THIS IS THE REASON THE ARRANGEMENT IS AN ATTRIBUTE AND NOT A BRANCH.
     * The conversation pane holds a scroll position, a draft in its composer
     * and possibly an in-flight read. A JSX branch that rendered two different
     * trees would drop all three every time the reader changed their mind about
     * the shape — a loss that reads as "it broke", not as "it re-laid out".
     *
     * Asserted as NODE IDENTITY, because that is what "did not remount" means
     * in the DOM. Same element objects before and after; only the attribute on
     * their parent changed.
     */
    const view = await openHome();
    const sideBefore = view.getByTestId('hp-side');
    const chatBefore = view.container.querySelector('.hp-live');
    const screenBefore = view.getByTestId('chat-home-screen');

    fireEvent.click(view.getByTestId('hp-split-flip'));
    await waitFor(() =>
      expect(view.getByTestId('hp-home').getAttribute('data-split')).toBe('horizontal'),
    );

    expect(view.getByTestId('hp-side')).toBe(sideBefore);
    expect(view.container.querySelector('.hp-live')).toBe(chatBefore);
    expect(view.getByTestId('chat-home-screen')).toBe(screenBefore);
    view.unmount();
  });

  it('publishes an extent per axis, each floored, and remembers them separately', async () => {
    /* The host solves both and publishes both, so the flip is a change of which
       TRACK is read rather than a repaint of a different number. */
    const view = await openHome();
    const style = host(view).style;
    expect(Number.parseInt(style.getPropertyValue('--hp-side-w'), 10)).toBeGreaterThanOrEqual(
      HOME_SIDE_W_MIN,
    );
    expect(Number.parseInt(style.getPropertyValue('--hp-side-h'), 10)).toBeGreaterThanOrEqual(
      HOME_SIDE_H_MIN,
    );
    /* AND THEY ARE DIFFERENT NUMBERS. 480 is a sensible width for this pane and
       a preposterous height for it; one slot per key would have made them the
       same and then overwritten one with the other. */
    expect(style.getPropertyValue('--hp-side-w')).not.toBe(style.getPropertyValue('--hp-side-h'));
    view.unmount();
  });

  it('COLLAPSES past the floor and draws the way back — never a closed pane with no door', async () => {
    /* Band 3. The floor still clamps `onResize`; a drag WELL past it is a
       different gesture and it closes the pane. Driven with the pointer here
       because the collapse is the one behaviour the keyboard has no key for. */
    const view = await openHome();
    const handle = view.getByTestId('panel-resizer-left');
    const before = host(view).style.getPropertyValue('--hp-side-w');

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });

    await waitFor(() =>
      expect(view.getByTestId('hp-home').getAttribute('data-side-collapsed')).toBe('true'),
    );
    expect(host(view).style.getPropertyValue('--hp-side-w')).toBe('0px');
    /* THE HANDLE IS GONE AND A REVEAL STANDS IN ITS PLACE. A separator that
       moves a pane which is not drawn is the defect this package measured at
       9px x 901px; the reveal is the permanently visible way back that
       Subhang's ruling 3 (2026-08-16) requires — never hover-only, never a
       shortcut only. */
    expect(view.queryByTestId('panel-resizer-left')).toBeNull();
    const reveal = view.getByTestId('hp-side-reveal');
    expect(reveal.getAttribute('aria-expanded')).toBe('false');
    expect(reveal.getAttribute('aria-controls')).toBe('hp-side');

    /* AND THE PANE IS STILL MOUNTED, so its scroll position, its lens and any
       loaded page survive the round trip. */
    expect(view.getByTestId('hp-side')).toBeTruthy();

    fireEvent.click(reveal);
    await waitFor(() =>
      expect(view.getByTestId('hp-home').getAttribute('data-side-collapsed')).toBeNull(),
    );
    /* THE REMEMBERED EXTENT SURVIVED THE COLLAPSE UNCHANGED. Collapsing must
       not be a write of zero — that would be a floor of zero by the back door,
       and the reader would get the default back instead of their own width. */
    expect(host(view).style.getPropertyValue('--hp-side-w')).toBe(before);
    view.unmount();
  });

  it('opens a card in the OTHER PANE, not in the right-hand aside', async () => {
    /*
     * Owner, 2026-08-31: "session or task when clicking how it shows — ideally
     * horizontal split like this?". It used to open in region C — a 440px
     * column bolted to the right edge — while the widest pane went on showing a
     * conversation the reader had just left.
     *
     * The observable consequence is that the ASIDE does not appear: the entity
     * lands in region B, which the chat surface renders in its centre berth,
     * and that berth IS the other pane. Nothing new is mounted for it.
     */
    const view = await openHome();
    const strip = view.container.querySelector('.hp-active__grid');
    const card = strip?.querySelector('.hp-acard__open') as HTMLElement | null;
    if (!card) {
      /* An empty ACTIVE strip is a fixture fact, not a layout claim — and
         absence is not a claim. Nothing to drive; the case above covers the
         seam and `home-open-entity-seam` covers the aside's remaining route. */
      view.unmount();
      return;
    }
    fireEvent.click(card);
    await waitFor(() => expect(view.getByTestId('hp-center-trail-host')).toBeTruthy());
    expect(view.queryByTestId('hp-aside'), 'the card still opens the right-hand aside').toBeNull();
    view.unmount();
  });
});

describe('the narrow-viewport fallback', () => {
  /*
   * MEASURED, NOT A MEDIA QUERY. Both panes have floors; below their sum plus
   * the rail there is no honest side-by-side arrangement left, so the layout
   * falls back to stacked, where the panes share the HEIGHT and both floors are
   * payable again.
   *
   * AND THE FALLBACK NEVER WRITES. That is the half worth a test of its own: a
   * narrow window that persisted "stacked" would answer the reader's remembered
   * choice with the accident of one session's window size, and widening again
   * would not give it back. Same law as `usePanelWidth`'s no-clamp-on-write.
   */
  const RAIL = 72;

  it('affords side by side only while both floors and the rail fit', () => {
    expect(homeSplitFits(1512, RAIL, 0)).toBe(true);
    /* 72 + 240 + 8 + 360 = 680 — exactly affordable, and one pixel under is
       not. The numbers are the constants', so a floor change moves this. */
    expect(homeSplitFits(680, RAIL, 0)).toBe(true);
    expect(homeSplitFits(679, RAIL, 0)).toBe(false);
  });

  it('moves with the rail and with the aside, because it is computed from them', () => {
    /* An expanded rail costs 136 more, so the same window can afford side by
       side with the rail collapsed and not with it open. A hard-coded
       breakpoint would have been wrong the moment either changed. */
    expect(homeSplitFits(700, RAIL, 0)).toBe(true);
    expect(homeSplitFits(700, 208, 0)).toBe(false);
    /* And an open aside reserves its own floor out of the same row. */
    expect(homeSplitFits(900, RAIL, 329)).toBe(false);
  });

  it('imposes no fallback on an unmeasurable row', () => {
    /* 0 is jsdom, which cannot measure. The same law the aside's overlay
       demotion follows: an unmeasurable row imposes no fallback rather than a
       fabricated one. */
    expect(homeSplitFits(0, RAIL, 0)).toBe(true);
  });
});

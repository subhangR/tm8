import { expect, test } from '@playwright/test';

/**
 * THE MEASURE RAIL, CHECKED WHERE IT IS ACTUALLY DECIDED.
 *
 * `channel-screen.responsive.test.ts` pins the RULES — the token exists, the
 * feed's children and the composer both point at it — and that is all jsdom
 * can ever do: it evaluates no container queries and lays nothing out, so a
 * rail that resolves to the wrong number, or that a host's padding quietly
 * knocks off centre, passes there without a murmur. That is how the transcript
 * and the composer spent months on rails 296px apart while the composer's own
 * comment claimed they were "centred on the feed".
 *
 * So this measures boxes in a browser, in the panel host that reported the
 * defect (`e2e/chat-rail-harness.tsx`).
 *
 * The zoom: `.cv2-root` carries `zoom: 1.1`, the surface's one global type
 * lever, so every number `getBoundingClientRect` returns here is 1.1× the CSS
 * pixel the stylesheet names. 1100px of measure reads as 1210.
 */

const ZOOM = 1.1;
const MEASURE_CSS_PX = 1100;

async function boxes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, width: r.width, centre: r.left + r.width / 2 };
    };
    return {
      list: rect('.chs-list'),
      card: rect('.chs-composer > :not(.chs-mention-picker)'),
      feed: rect('.chs-feed'),
    };
  });
}

test('transcript and composer share one measure rail in a wide panel', async ({ page }) => {
  await page.setViewportSize({ width: 1492, height: 900 });
  await page.goto('/e2e/chat-rail-harness.html?rows=15&host=hub');
  await page.getByRole('region', { name: 'Chat history' }).waitFor();

  const { list, card } = await boxes(page);
  expect(list).not.toBeNull();
  expect(card).not.toBeNull();

  // Both are capped at the rail, not at the panel and not at 760px.
  expect(list!.width).toBeCloseTo(MEASURE_CSS_PX * ZOOM, 0);
  expect(card!.width).toBeCloseTo(MEASURE_CSS_PX * ZOOM, 0);

  /*
   * And both are CENTRED on the same axis, which is the half the old rule
   * never had. The tolerance is a classic scrollbar: the feed is the scroller,
   * so on a platform that reserves gutter for one its content box is ~15px
   * narrower than the composer's and its centre shifts half that. Overlay
   * scrollbars make it zero. It is a residual of a few px against the 296px
   * this test was written for.
   */
  expect(Math.abs(list!.centre - card!.centre)).toBeLessThan(12);
});

test('the rail degrades to the full width in a narrow host', async ({ page }) => {
  // `min(1100px, 100%)`, deliberately: inside the ~360px thread pane and under
  // the 440px phone container the rail must get out of the way entirely and
  // leave those blocks the last word. A bare 1100px or a clamp with a floor
  // would overflow them.
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto('/e2e/chat-rail-harness.html?rows=15&host=hub');
  await page.getByRole('region', { name: 'Chat history' }).waitFor();

  const { list, card, feed } = await boxes(page);
  expect(list!.width).toBeLessThan(MEASURE_CSS_PX * ZOOM);
  expect(list!.width).toBeGreaterThan(feed!.width - 60); // the feed's padding, nothing more
  expect(Math.abs(list!.centre - card!.centre)).toBeLessThan(12);
});

/*
 * THE THIRD DEFECT IS NOT GATED HERE, AND SAYING WHERE IT IS GATED IS THE
 * POINT OF THIS NOTE.
 *
 * "The composer card covers the trailing USAGE … tokens line" comes from the
 * open-at-newest pin choosing a scrollTop before the rows finish growing —
 * measured 14px short of the maximum in the panel host, against a 12px bottom
 * padding. A test for it was written here and DELETED: it passed against the
 * unfixed source, because Playwright launches Chromium with
 * `--hide-scrollbars`, and without a classic scrollbar the feed's metrics
 * settle early enough that the pin lands true. A browser test that cannot
 * fail on the defect it names is worse than none.
 *
 * The re-pin is gated in `ChannelScreen.test.tsx` instead ("re-pins the newest
 * message when the feed grows after commit"), which drives the ResizeObserver
 * directly and also pins the half that matters more — that it does NOT fire
 * when the reader has scrolled up to read history.
 */

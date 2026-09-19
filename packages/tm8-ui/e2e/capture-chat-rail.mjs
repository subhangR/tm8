/**
 * Photograph and MEASURE the chat surface's measure rail (task 01a0b32e-bb92).
 *
 * Subhang's report was three photographs and one sentence: the transcript hugs
 * the left edge, the composer sits on a different rail, and the composer card
 * covers the trailing `USAGE | … tokens` line. None of those three is a claim
 * jsdom can adjudicate — it evaluates no container queries and lays nothing
 * out — so this reads the boxes out of a browser and writes the screenshots
 * that make the fix evidence rather than assertion.
 *
 * The number it exists to print is `railOffsetPx`: the distance between where
 * the transcript starts and where the composer card starts. That was 296px at
 * a 1492 viewport before the shared token, and it is what a future re-tune of
 * `--chs-measure` should re-check.
 *
 * `.cv2-root` carries `zoom: 1.1`, so every number here is 1.1× the CSS pixel
 * the stylesheet names: a 1100px rail reads as 1210.
 *
 * Usage: node e2e/capture-chat-rail.mjs [origin] [outDir] [rows] [hub|conversation]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const outDir = process.argv[3] ?? '/tmp/chat-rail';
const rows = process.argv[4] ?? '15';
const host = process.argv[5] ?? 'hub';

/* A BROWSER PER VIEWPORT, not one for all three. `--single-process` is what
   makes Chromium start at all on a host without a GPU or a session bus, and a
   single-process Chromium here does not reliably survive its own page closing:
   the second `newPage` gets "Target page, context or browser has been closed"
   and the run dies holding one of the three screenshots it was asked for.
   Three launches cost a couple of seconds and always produce all three. */
async function probe(width, label) {
  const browser = await chromium.launch({
    executablePath: process.env.TM8_CHROME,
    args: ['--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${origin}/e2e/chat-rail-harness.html?rows=${rows}&host=${host}`);
  await page.getByRole('region', { name: 'Chat history' }).waitFor();
  /* The pin re-asks for the bottom once the rows stop growing (a font swap
     re-wraps every paragraph). Measuring before that settles is measuring the
     race, not the layout. */
  await page.waitForTimeout(700);

  const measured = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), bottom: Math.round(r.bottom) };
    };
    const root = document.querySelector('.chs-root');
    const feed = document.querySelector('.chs-feed');
    const rowEls = document.querySelectorAll('.chs-row');
    const lastKid = rowEls[rowEls.length - 1]?.lastElementChild;
    const composer = document.querySelector('.chs-composer');
    return {
      measureToken: getComputedStyle(root).getPropertyValue('--chs-measure').trim() || '(unset)',
      list: box('.chs-list'),
      composerCard: box('.chs-composer > :not(.chs-mention-picker)'),
      feed: box('.chs-feed'),
      /* How far the pin fell short of the true bottom. Anything over the
         feed's 12px bottom padding is the newest row touching the composer,
         which is defect three. */
      atMax: Math.round(feed.scrollHeight - feed.clientHeight - feed.scrollTop),
      lastKindClass: lastKid?.className ?? null,
      clearancePx:
        lastKid && composer
          ? Math.round(composer.getBoundingClientRect().top - lastKid.getBoundingClientRect().bottom)
          : null,
    };
  });

  measured.railOffsetPx =
    measured.list && measured.composerCard ? measured.composerCard.x - measured.list.x : null;

  console.log(`\n--- ${label} (viewport ${width}, rows=${rows}, host=${host}) ---`);
  console.log(JSON.stringify(measured, null, 1));
  await page.screenshot({ path: `${outDir}/${label}.png` });
  await browser.close();
  return measured;
}

await probe(1492, 'panel-wide');
await probe(1100, 'panel-mid');
await probe(420, 'panel-narrow');

/**
 * capture-visual-quality.mjs — Lane D before/after captures of the channel
 * chat surface, light + dark, plus computed-style measurements.
 *
 * RUN, from packages/tm8-ui (vite already on :4622 with VITE_TM8_REAL_SEAM=0):
 *   FF=$HOME/.cache/ms-playwright/firefox-1509/firefox
 *   FR=$HOME/.local/ff-libs/root; R=$HOME/.local/pw-libs/root
 *   LD_LIBRARY_PATH="$FF:$FR/usr/lib/x86_64-linux-gnu:$FR/lib/x86_64-linux-gnu:$R/usr/lib/x86_64-linux-gnu" \
 *   FONTCONFIG_PATH=/etc/fonts SHOTS=<outdir> TAG=before BASE=http://127.0.0.1:4622 \
 *   node e2e/capture-visual-quality.mjs
 */
import { firefox } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS ?? '/tmp/shots';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4622';
const TAG = process.env.TAG ?? 'before';
mkdirSync(OUT, { recursive: true });

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('tm8-ui:real-seam', '0');
    const pass = {
      token: 'e2e-fixture-token',
      account: { handle: 'visualcheck', displayName: 'Visual Check', id: 'e2e-account' },
    };
    localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [location.origin]: pass }));
    localStorage.setItem(
      'tm8ui.auth.known.v1',
      JSON.stringify({ [location.origin]: [{ handle: 'visualcheck', displayName: 'Visual Check' }] }),
    );
  } catch { /* gate handles blocked storage */ }
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
page.on('requestfailed', (r) => errors.push('REQFAIL ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText ?? '')));

const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
  console.log(`[shot] ${TAG}-${name}.png`);
};

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(6000);
await shot('landing');
console.log('[landing-text]', (await page.locator('body').textContent())?.slice(0, 400));
console.log('[early-errors]', errors.slice(0, 10).join('\n') || '(none)');

// rail → Channels → open a channel with a feed
await page.getByText('Channels', { exact: true }).first().click();
await page.waitForTimeout(2000);
await page.getByText('design', { exact: true }).first().click();
await page.waitForTimeout(3000);
await shot('channel');

// measurements of the resting feed
const m = await page.evaluate(() => {
  const gcs = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
  };
  return {
    feedRows: document.querySelectorAll('.chs-row').length,
    feed: gcs('.chs-feed', ['padding']),
    row: gcs('.chs-row', ['margin-top', 'padding']),
    text: gcs('.chs-text', ['font-size', 'line-height', 'color']),
    who: gcs('.chs-byline__who', ['font-size', 'font-weight', 'color']),
    kind: gcs('.chs-byline__kind', ['font-size', 'color', 'background-color', 'border-color']),
    time: gcs('.chs-byline__time', ['font-size', 'color']),
    gutter: gcs('.chs-gutter', ['width']),
    day: gcs('.chs-day__label', ['font-size', 'color']),
    composer: gcs('.chs-composer', ['padding', 'background-color', 'border-top-color']),
    input: gcs('.chs-composer__input', ['height', 'font-size', 'border-color', 'background-color']),
    send: gcs('.chs-composer__send', ['background-color', 'color', 'font-size']),
    root: gcs('.chs-root', ['background-color']),
    bodyW: document.querySelector('.chs-row__body')?.getBoundingClientRect().width ?? null,
  };
});
console.log('[measure]', JSON.stringify(m, null, 1));

// scroll the feed to its top to see day dividers / provenance
await page.evaluate(() => { const f = document.querySelector('.chs-feed'); if (f) f.scrollTop = 0; });
await shot('channel-feed-top');

// hover a row to reveal actions
const rows = page.locator('.chs-row');
if (await rows.count() > 2) {
  await rows.nth(2).hover();
  await page.waitForTimeout(400);
  await shot('channel-row-hover');
}

// the thread pane, via the busiest footer
const footer = page.locator('.chs-thread-footer__open').first();
if (await footer.count()) {
  await footer.click();
  await page.waitForTimeout(1200);
  await shot('thread-open');
  const closeBtn = page.locator('.chs-thread__close');
  if (await closeBtn.count()) await closeBtn.click();
  await page.waitForTimeout(500);
}

// composer focused
await page.locator('.chs-composer__input').click();
await page.keyboard.type('Typing a reply to see the focused composer…');
await page.waitForTimeout(300);
await shot('composer-focus');
await page.locator('.chs-composer__input').fill('');

// dark theme
await page.evaluate(() => {
  document.querySelector('.cv2-root')?.setAttribute('data-theme', 'dark');
});
await shot('channel-dark');
await page.evaluate(() => {
  document.querySelector('.cv2-root')?.removeAttribute('data-theme');
});

// SESSION CHAT — same surface, other host. Reach a session via the rail.
try {
  await page.getByText('Sessions', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  // an exited session hosts the chat surface directly (no live terminal)
  await page.getByText('Done', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByText('forge · tokens transplant').first().click();
  await page.waitForTimeout(2500);
  await shot('session-chat');
  console.log('[session-chs-rows]', await page.locator('.chs-row').count());
} catch (e) {
  console.log('[session-chat] skipped:', String(e).slice(0, 160));
}

// The m7 harness: richest feed states (edited, tombstone, artifact card) and
// the Terminal/Chat surface switch that hosts the SESSION chat.
try {
  await page.goto(`${BASE}/e2e/m7-harness.html?scenario=presentation`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Chat history' }).waitFor({ timeout: 20_000 });
  await shot('m7-presentation');
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', 'dark');
  });
  await shot('m7-presentation-dark');
  await page.goto(`${BASE}/e2e/m7-harness.html?scenario=surface`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByRole('region', { name: 'Chat history' }).waitFor({ timeout: 20_000 });
  await shot('m7-session-chat');
} catch (e) {
  console.log('[m7] skipped:', String(e).slice(0, 160));
}

console.log('[errors]', errors.length ? errors.slice(0, 8).join('\n') : '(none)');
await browser.close();

/**
 * thread-verify.mjs — drive the SLICE-2 THREAD flows in a real browser.
 *
 * Same Firefox recipe and fixture seam as `channel-verify.mjs` (its header has
 * the launch env). Walks: channel opens as roots-only, footer on the replied
 * root (none on the quiet one), footer click opens the pane, pane shows root +
 * divider + branch + its own composer, a reply posts to the root, and the
 * narrow container collapses the feed behind the `← #channel` breadcrumb.
 *
 * RUN, from packages/tm8-ui:
 *   VITE_TM8_REAL_SEAM=0 npx vite --port 4617 --strictPort &
 *   FF=$HOME/.cache/ms-playwright/firefox-1509/firefox
 *   FR=$HOME/.local/ff-libs/root; R=$HOME/.local/pw-libs/root
 *   LD_LIBRARY_PATH="$FF:$FR/usr/lib/x86_64-linux-gnu:$FR/lib/x86_64-linux-gnu:$R/usr/lib/x86_64-linux-gnu" \
 *   FONTCONFIG_PATH=/etc/fonts SHOTS=/tmp/shots BASE=http://127.0.0.1:4617 \
 *   node e2e/thread-verify.mjs
 */
import { firefox } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS ?? '/tmp/shots';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4617';
mkdirSync(OUT, { recursive: true });

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('tm8-ui:real-seam', '0');
    const pass = {
      token: 'e2e-fixture-token',
      account: { handle: 'threadcheck', displayName: 'Thread Check', id: 'e2e-account' },
    };
    localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [location.origin]: pass }));
    localStorage.setItem(
      'tm8ui.auth.known.v1',
      JSON.stringify({ [location.origin]: [{ handle: 'threadcheck', displayName: 'Thread Check' }] }),
    );
  } catch { /* the gate handles blocked storage */ }
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e).slice(0, 200)}`));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/thread-${name}.png` });
  console.log(`[shot] thread-${name}.png`);
};

// ---------------------------------------------------------------------------
// Click-nav, not a deep link: the hash route boots to the workspace default
// in this harness, and the click path (rail → channel list → row) is the
// ruling's own path anyway — a channel opens in the Entity List Panel.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(8000);
await page.getByText('Channels', { exact: true }).first().click();
await page.waitForTimeout(2000);
await page.getByText('design', { exact: true }).first().click();
await page.waitForTimeout(4000);

// 1 — the channel reads as ROOTS ONLY: both roots visible, replies not drawn
//     as peers, and the replied root carries a persistent footer.
const rootVisible = await page.getByText('Do we ship the thread pane', { exact: false }).first().isVisible().catch(() => false);
const quietVisible = await page.getByText('Standup moves to 09:30', { exact: false }).first().isVisible().catch(() => false);
const replyAsPeer = await page.locator('.chs-feed').getByText('registry row only', { exact: false }).first().isVisible().catch(() => false);
check('roots visible in channel feed', rootVisible && quietVisible);
check('replies NOT drawn as feed peers', !replyAsPeer);

const footer = page.getByRole('button', { name: /open thread · 2 replies/i }).first();
const footerVisible = await footer.isVisible().catch(() => false);
check('persistent footer on the replied root (no hover)', footerVisible);
const footerCount = await page.locator('[data-testid="chs-thread-footer"]').count();
check('exactly one footer — the quiet root draws none', footerCount === 1, `count=${footerCount}`);
await shot('01-channel-roots');

// 2 — the footer opens the pane: root pinned, divider, branch oldest-first,
//     own composer.
if (footerVisible) {
  await footer.click();
  await page.waitForTimeout(1200);
  const pane = page.locator('[data-testid="chs-thread"]');
  check('thread pane opened', await pane.isVisible().catch(() => false));
  const divider = await pane.locator('[data-testid="chs-thread-divider"]').textContent().catch(() => '');
  check('N-replies divider', /2 replies/.test(divider ?? ''), divider ?? '');
  const bodies = await pane.locator('[data-testid="chs-text"]').allTextContents().catch(() => []);
  check('root pinned above branch, branch oldest-first',
    bodies.length === 3
      && /thread pane/.test(bodies[0])
      && /registry row only/.test(bodies[1])
      && /unseen thread/.test(bodies[2]),
    JSON.stringify(bodies));
  const composer = pane.getByRole('textbox', { name: /message this thread/i });
  check('thread pane owns a composer', await composer.isVisible().catch(() => false));
  await shot('02-thread-pane');

  // 3 — a reply composed in the pane lands in the branch (fixture seam stores
  //     it and the reload draws it), and the footer count moves.
  await composer.fill('Composed from the thread pane itself.');
  await composer.press('Enter');
  await page.waitForTimeout(1500);
  const after = await pane.locator('[data-testid="chs-text"]').allTextContents().catch(() => []);
  check('reply stored into the branch', after.some((b) => /Composed from the thread pane/.test(b)), JSON.stringify(after));
  const bumped = await page.getByRole('button', { name: /open thread · 3 replies/i }).first().isVisible().catch(() => false);
  check('footer rollup moved 2 → 3', bumped);
  await shot('03-reply-posted');

  // 4 — narrow container: the pane replaces the feed; the breadcrumb leads back.
  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForTimeout(900);
  const feedGone = await page.locator('.chs-main').first().isHidden().catch(() => false);
  const crumb = page.getByRole('button', { name: /← #?design/i }).first();
  check('collapsed: feed replaced by the pane', feedGone);
  check('collapsed: ← breadcrumb visible', await crumb.isVisible().catch(() => false));
  await shot('04-collapsed');
  if (await crumb.isVisible().catch(() => false)) {
    await crumb.click();
    await page.waitForTimeout(700);
    check('breadcrumb returns to the channel', await page.locator('.chs-main').first().isVisible().catch(() => false));
    await shot('05-back-to-channel');
  }
}

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * FIRST-RUN CLAIM, END TO END — headless Chrome against two REAL, UNCLAIMED
 * scratch servers (each path burns its node's claim, so each needs its own).
 *
 *   LOCAL  — the person on the server's own machine opens the plain URL. The
 *            node answers `tokenRequired: false`, the card shows no code field,
 *            and Enter in the password field lands them in the app.
 *   REMOTE — a browser that came through another hop (simulated with an
 *            `x-forwarded-for` header, which turns the loopback auto-owner off
 *            exactly as a reverse proxy does). Without the link: one SETUP CODE
 *            field, a disabled action, and a wrong code refused AS A CODE. With
 *            the printed `#claim=` link: the code is used unseen, scrubbed from
 *            the address bar, survives a reload and the back button, and claims.
 *
 * Layout is asserted, not eyeballed: the action never sticks out of the card,
 * and a card taller than the viewport keeps its head reachable.
 *
 * Usage (servers from a lane: see the "Scratch server real E2E" recipe):
 *   FIRST_RUN_LOCAL_URL=http://127.0.0.1:7791 \
 *   FIRST_RUN_REMOTE_URL=http://127.0.0.1:7792 \
 *   FIRST_RUN_REMOTE_TOKEN="$(cat <remote data dir>/setup-token)" \
 *   [FIRST_RUN_OUT=/tmp/first-run] [CHROME=/path/to/chrome] node e2e/first-run-claim.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const LOCAL = process.env.FIRST_RUN_LOCAL_URL;
const REMOTE = process.env.FIRST_RUN_REMOTE_URL;
const TOKEN = process.env.FIRST_RUN_REMOTE_TOKEN;
const OUT = process.env.FIRST_RUN_OUT ?? '/tmp/first-run-claim';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!LOCAL || !REMOTE || !TOKEN) {
  console.error('set FIRST_RUN_LOCAL_URL, FIRST_RUN_REMOTE_URL and FIRST_RUN_REMOTE_TOKEN');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME });

async function open(url, { remote = false, mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 375, height: 760 } : { width: 1280, height: 720 },
    ...(remote ? { extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.9' } } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(url);
  return { ctx, page };
}

const card = (page) => page.getByTestId('auth-frame');
const codeField = (page) => page.getByLabel('SETUP CODE', { exact: true });
const createButton = (page) => page.getByRole('button', { name: /create account/i });

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

/** The action sits inside the card, and the card's head is on screen. */
async function checkLayout(page, label) {
  const geo = await page.evaluate(() => {
    const cardEl = document.querySelector('.auth-card');
    const btn = document.querySelector('.auth-card .auth-btn--lg');
    const scroller = document.querySelector('.auth-stage__body');
    if (scroller) scroller.scrollTop = 0;
    const c = cardEl?.getBoundingClientRect();
    const b = btn?.getBoundingClientRect();
    return c && b ? { cardLeft: c.left, cardRight: c.right, cardTop: c.top, btnLeft: b.left, btnRight: b.right } : null;
  });
  check(`${label}: action inside the card`, !!geo && geo.btnLeft >= geo.cardLeft && geo.btnRight <= geo.cardRight, JSON.stringify(geo));
  check(`${label}: card head reachable`, !!geo && geo.cardTop >= 0, `top ${geo?.cardTop}`);
}

async function fillAccount(page, name) {
  await page.getByLabel('YOUR NAME', { exact: true }).fill(name);
  await page.getByLabel('PASSWORD', { exact: true }).fill('correct horse battery');
}

async function inTheApp(page) {
  try {
    await card(page).waitFor({ state: 'detached', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// ── LOCAL: the server's own machine ─────────────────────────────────────
{
  const { ctx, page } = await open(`${LOCAL}/`);
  await card(page).waitFor({ timeout: 20_000 });
  await shot(page, 'local-1-card');
  check('local: no setup code field', (await codeField(page).count()) === 0);
  check('local: says no code is needed', /no setup code is needed/i.test(await card(page).innerText()));
  check('local: name field has real focus', await page.getByLabel('YOUR NAME', { exact: true }).evaluate((el) => el === document.activeElement));
  check('local: create account enabled', (await createButton(page).getAttribute('aria-disabled')) !== 'true');
  await checkLayout(page, 'local');
  await fillAccount(page, 'Local Owner');
  await page.getByLabel('PASSWORD', { exact: true }).press('Enter');
  check('local: Enter claims and lands in the app', await inTheApp(page));
  await page.waitForTimeout(1500);
  await shot(page, 'local-2-app');
  await page.reload();
  await page.waitForTimeout(3000);
  check('local: reload stays in the app', (await card(page).count()) === 0);
  await ctx.close();
}

// ── REMOTE, no link: one field, a disabled action, a refused code says so ─
{
  const { ctx, page } = await open(`${REMOTE}/`, { remote: true, mobile: true });
  await card(page).waitFor({ timeout: 20_000 });
  await shot(page, 'remote-nolink-1-card-mobile');
  check('remote/no link: SETUP CODE field shown', (await codeField(page).count()) === 1);
  check('remote/no link: code field has focus', await codeField(page).evaluate((el) => el === document.activeElement));
  check('remote/no link: action disabled', (await createButton(page).getAttribute('aria-disabled')) === 'true');
  check('remote/no link: no horizontal overflow at 375px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await checkLayout(page, 'remote/no link mobile');
  await codeField(page).fill('tm8c_not-the-real-one');
  await fillAccount(page, 'Mallory');
  await createButton(page).click();
  await page.getByText(/setup code did not work/i).waitFor({ timeout: 10_000 }).catch(() => {});
  const text = await card(page).innerText();
  check('remote/no link: wrong code refused AS A CODE', /setup code did not work/i.test(text) && !/handle and password/i.test(text));
  await shot(page, 'remote-nolink-2-wrong-code-mobile');
  await ctx.close();
}

// ── REMOTE, via the printed link: used unseen, survives reload + back ────
{
  const { ctx, page } = await open(`${REMOTE}/#claim=${encodeURIComponent(TOKEN)}`, { remote: true });
  await card(page).waitFor({ timeout: 20_000 });
  await shot(page, 'remote-link-1-card');
  check('remote/link: fragment scrubbed', !page.url().includes('#claim='), page.url());
  check('remote/link: code used without a field', (await codeField(page).count()) === 0 && (await page.getByTestId('claim-link-used').count()) === 1);
  check('remote/link: action enabled', (await createButton(page).getAttribute('aria-disabled')) !== 'true');
  await checkLayout(page, 'remote/link');

  await page.reload();
  await card(page).waitFor({ timeout: 20_000 });
  check('remote/link: code survives a reload', (await page.getByTestId('claim-link-used').count()) === 1);
  await shot(page, 'remote-link-2-after-reload');

  await page.goto(`${REMOTE}/?v=2`);
  await page.goBack();
  await card(page).waitFor({ timeout: 20_000 });
  check('remote/link: back button never shows the token in the URL', !page.url().includes('claim='), page.url());
  check('remote/link: code still there after back', (await page.getByTestId('claim-link-used').count()) === 1);

  await fillAccount(page, 'Remote Owner');
  await createButton(page).click();
  check('remote/link: claims and lands in the app', await inTheApp(page));
  await page.waitForTimeout(1500);
  await shot(page, 'remote-link-3-app');
  check('remote/link: kept code forgotten after the claim', (await page.evaluate(() => sessionStorage.getItem('tm8ui.auth.claim-token.v1'))) === null);
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall first-run checks passed');
console.log(`screenshots: ${OUT}`);
process.exit(failures.length ? 1 : 0);

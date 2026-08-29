/**
 * channel-verify.mjs — drive the CHANNEL flows in a real browser.
 *
 * Same Firefox recipe and same fixture seam as `capture-audit.mjs` (read its
 * header for why not Chromium, and for the rootless GTK prefix). This one is
 * not a pixel audit: it walks the two flows this branch ships and asserts what
 * is on screen at each step, so "the tests pass" and "it works in the app" are
 * two different pieces of evidence rather than one.
 *
 * RUN IT, from packages/tm8-ui:
 *   VITE_TM8_REAL_SEAM=0 npx vite --port 4613 --strictPort &
 *   FF=$HOME/.cache/ms-playwright/firefox-1509/firefox
 *   FR=$HOME/.local/ff-libs/root; R=$HOME/.local/pw-libs/root
 *   LD_LIBRARY_PATH="$FF:$FR/usr/lib/x86_64-linux-gnu:$FR/lib/x86_64-linux-gnu:$R/usr/lib/x86_64-linux-gnu" \
 *   FONTCONFIG_PATH=/etc/fonts SHOTS=/tmp/shots BASE=http://127.0.0.1:4613 \
 *   node e2e/channel-verify.mjs
 */
import { firefox } from '@playwright/test';

const OUT = process.env.SHOTS ?? '/tmp/shots';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4613';
const TAG = process.env.TAG ?? 'chan';

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('tm8-ui:real-seam', '0');
    /*
     * SEED THE GATE, because it no longer opens on a local account.
     * `capture-audit.mjs`'s recipe — fill the first-run form and press Create
     * — signs up against a REAL node now (`auth.signup`), so on a box with no
     * dev server it dies on HTTP 500 before any screen renders, and on a box
     * with one it would write a real account into a real database. Neither is
     * something a verification run should do. The seam beneath is already
     * `fixture` (asserted, not assumed: `seamSource()` returns 'fixture' with
     * this flag set), so the pass only has to satisfy the gate's own shape.
     */
    const pass = {
      token: 'e2e-fixture-token',
      account: { handle: 'channelcheck', displayName: 'Channel Check', id: 'e2e-account' },
    };
    localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [location.origin]: pass }));
    localStorage.setItem(
      'tm8ui.auth.known.v1',
      JSON.stringify({ [location.origin]: [{ handle: 'channelcheck', displayName: 'Channel Check' }] }),
    );
  } catch { /* the gate handles blocked storage */ }
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e).slice(0, 200)}`));

const shot = async (name) => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
  console.log(`[shot] ${TAG}-${name}.png`);
};
const say = (k, v) => console.log(`[${k}] ${typeof v === 'string' ? v : JSON.stringify(v)}`);

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(5000);
await shot('00-landing');

// The channels collection — the surface the ticket was reported against.
// Reached the way a user reaches it, through the rail, rather than by building
// a URL: the route is the thing under test as much as the panel is.
await page.getByText('Channels', { exact: true }).first().click();
await page.waitForTimeout(2500);
say('route', await page.evaluate(() => location.hash));
await shot('01-channels-list');

// Open the fixture channel.
await page.getByText('design', { exact: true }).first().click();
await page.waitForTimeout(2500);
await shot('02-channel-open');

const bar = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="panel-action-bar"]');
  if (!el) return { found: false };
  return {
    found: true,
    live: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()),
    refused: [...el.querySelectorAll('[data-testid="disabled-with-reason"]')]
      .map((n) => n.textContent.trim().slice(0, 40)),
  };
});
say('action-bar', bar);

// THE EDIT DIALOG.
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await page.waitForTimeout(800);
await shot('03-edit-dialog');

const dialog = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="edit-entity-dialog"]');
  if (!el) return { found: false };
  return {
    found: true,
    title: el.getAttribute('aria-label'),
    labels: [...el.querySelectorAll('.au-dialog__label')].map((n) => n.textContent.trim()),
    fields: [...el.querySelectorAll('[data-testid^="edit-field-"]')]
      .map((n) => ({ id: n.dataset.testid, tag: n.tagName, value: n.value })),
    buttons: [...el.querySelectorAll('button')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`),
  };
});
say('dialog', dialog);

// Slug normalisation, visible as you type.
const name = page.locator('[data-testid="edit-field-title"]');
await name.fill('');
await name.type('Design Review Room');
await page.waitForTimeout(400);
say('normalised-name', await name.inputValue());

// Topic is OPTIONAL: clear it and confirm Save stays live.
const topic = page.locator('[data-testid="edit-field-content.topic"]');
await topic.fill('');
await page.waitForTimeout(300);
const saveState = await page.evaluate(() => {
  const b = [...document.querySelectorAll('[data-testid="edit-entity-dialog"] button')]
    .find((x) => x.textContent.trim().startsWith('Save'));
  return { disabled: b?.disabled ?? null };
});
say('save-with-empty-topic', saveState);
await shot('04-empty-topic-save-live');

// Required refuses, visibly.
await name.fill('');
await page.waitForTimeout(300);
const required = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="edit-entity-dialog"]');
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Save'));
  return {
    saveDisabled: b?.disabled ?? null,
    alert: el.querySelector('[role="alert"]')?.textContent.trim() ?? null,
  };
});
say('empty-required-name', required);
await shot('05-required-refusal');

// Save a real edit and confirm it lands on the entity.
await name.fill('design-review');
await topic.fill('what we are shipping this week');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Save/ }).click();
await page.waitForTimeout(2500);
await shot('06-after-save');

const after = await page.evaluate(() => ({
  dialogGone: document.querySelector('[data-testid="edit-entity-dialog"]') === null,
  header: document.querySelector('[data-testid="panel-header"]')?.textContent.trim().slice(0, 80) ?? null,
  hubDescription: document.querySelector('[data-testid="hub-description"]')?.textContent.trim() ?? null,
}));
say('after-save', after);

// SUBCHANNELS.
const before = await page.evaluate(() => document.querySelectorAll('.lp__row').length);
await page.getByRole('button', { name: /Add child/ }).click();
await page.waitForTimeout(2500);
await shot('07-subchannel-created');
const afterAdd = await page.evaluate(() => ({
  rows: document.querySelectorAll('.lp__row').length,
  header: document.querySelector('[data-testid="panel-header"]')?.textContent.trim().slice(0, 80) ?? null,
}));
say('subchannel', { rowsBefore: before, ...afterAdd });

console.log('[errors]', errors.length ? errors.slice(0, 12).join('\n') : '(none)');
await browser.close();

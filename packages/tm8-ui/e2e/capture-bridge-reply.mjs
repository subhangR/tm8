// Pixel evidence for the composer's reply target under a bridged message (§4.5, D77). NOT a spec.
// Serve: ./node_modules/.bin/vite --port 4699 --strictPort ; run: node e2e/capture-bridge-reply.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4699';
const OUT = process.env.OUT ?? 'gate-evidence/bridge-reply';
mkdirSync(OUT, { recursive: true });

// On this host: LD_LIBRARY_PATH=~/chromedeps/root/usr/lib/x86_64-linux-gnu, and the renderer needs one process.
const browser = await chromium.launch({ args: ['--disable-gpu', '--single-process', '--no-zygote'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/e2e/bridge-reply-harness.html`);
const pane = page.getByTestId('chs-thread');
await pane.getByTestId('bridge-reply').waitFor();
await page.waitForTimeout(400);

const shoot = async (name, locator) => {
  await (locator ?? page).screenshot({ path: `${OUT}/${name}.png`, ...(locator ? {} : { fullPage: true }) });
  console.log('saved', `${OUT}/${name}.png`);
};
const composer = pane.locator('.chs-composer');
const input = pane.getByRole('textbox', { name: /message this thread/i });
const state = async () => ({
  target: await pane.getByTestId('bridge-reply').getAttribute('data-target'),
  placeholder: await input.getAttribute('placeholder'),
});

// 1. The default: Reply in WhatsApp.
console.log('default', await state());
await shoot('thread-reply-in-whatsapp');
await shoot('composer-reply-in-whatsapp', composer);
await input.fill('yes, 1.4.2 since 10:30');
await input.press('Enter');
await page.waitForTimeout(200);
console.log('posted (default)', await page.evaluate(() => document.body.dataset.posted));

// 2. One tap: Reply here only.
await pane.getByRole('button', { name: /reply here only/i }).click();
console.log('here only', await state());
await shoot('thread-reply-here-only');
await shoot('composer-reply-here-only', composer);
await input.fill('noting the cache delay for the postmortem');
await input.press('Enter');
await page.waitForTimeout(200);
console.log('posted (here only)', await page.evaluate(() => document.body.dataset.posted));
console.log('after send', await state());
console.log('page errors', errors.length ? errors : 'none');
await browser.close();

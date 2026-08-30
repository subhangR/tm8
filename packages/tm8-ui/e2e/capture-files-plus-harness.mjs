/**
 * capture-files-plus-harness — THE PIXEL PROOF that ＋ on Files uploads.
 *
 * WHAT IT ASSERTS, in order, against a REAL node:
 *   1. the root header's ＋ for a staged kind opens an OS FILE PICKER — on
 *      origin/main it did not, it committed an entity and opened it;
 *   2. the bytes actually travel — uploadInit 200, content 204, complete 200;
 *   3. the caller is handed the COMPLETION's own result — the harness prints
 *      `patches N`, and N > 0 is the fix for the fabricated `{patches: []}`;
 *   4. the ＋ TITLE matches what pressing it does. That one is here because it
 *      is what this instrument caught: the button was wired correctly and went
 *      on promising "Create an Untitled file … type its name there". Every
 *      unit assertion passed. `panels/root-header-birth-promise.test.tsx` now
 *      holds the line, but a printed attribute beside a real click is what
 *      found it.
 *
 * WHY THE HARNESS AND NOT THE APP. `capture-files-plus.mjs` drives the whole
 * app and is the better instrument when there is memory for it. On a loaded
 * box there is not — the headless renderer is OOM-killed composing a
 * screenshot of the full surface, and a crash there reads as a failure of the
 * thing under test rather than of the box. This mounts the same
 * `ListRootHeader` over the same `stagedBirthFor` and little else.
 *
 * THREE ACCOMMODATIONS, each of which cost an hour to find, so none of them is
 * left to be rediscovered:
 *   - `--single-process`. With a separate renderer, chromium is OOM-killed at
 *     `newPage` or at `screenshot` under load. One process survives.
 *   - JPEG, small viewport. A full-page PNG is the largest allocation in the
 *     run and the first thing the kernel refuses.
 *   - the ORIGIN PROXY (`files-plus-origin-proxy.mjs`). The node runs an exact
 *     -origin allowlist and answers 403 to a dev origin before any handler
 *     runs; it allows an ABSENT Origin, which is the door the CLI uses.
 *     Playwright cannot drop that header — `route.continue({headers})` is
 *     overridden by the network stack — so a proxy does it.
 *
 * IT UPLOADS FOR REAL. Each run leaves one file entity behind, with bytes.
 *
 * Run it:
 *   TM8_SERVER_ORIGIN=http://127.0.0.1:17777 npx vite --port 4620 &
 *   node e2e/files-plus-origin-proxy.mjs &          # fronts both on :4630
 *   export TM8_AGENT_TOKEN=… TM8_SPACE_ID=…
 *   node e2e/capture-files-plus-harness.mjs --ui http://127.0.0.1:4630
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';

const log = (...a) => writeSync(1, a.join(' ') + '\n');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const UI = argOf('ui', 'http://127.0.0.1:4630');
const OUT = argOf('out', '/tmp/files-plus');
const SPACE = process.env.TM8_SPACE_ID;
const TOKEN = process.env.TM8_AGENT_TOKEN;
if (!SPACE || !TOKEN) throw new Error('set TM8_SPACE_ID and TM8_AGENT_TOKEN');
mkdirSync(OUT, { recursive: true });

const PAYLOAD = `${OUT}/files-plus-proof.txt`;
writeFileSync(PAYLOAD,
  'Uploaded through the Files + button by tm8 UI Builder, task 01a04730.\n'
  + 'If this entity has bytes, the staged create door is wired.\n');

/* Playwright's own resolution picks the bundled browser; an explicit path
   only when the environment supplies one, so this is not pinned to one box. */
const CHROME = process.env.TM8_CHROME ?? undefined;
const LEAN = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage',
  '--renderer-process-limit=1', '--js-flags=--max-old-space-size=384', '--disable-accelerated-2d-canvas',
  '--force-device-scale-factor=1', '--disable-lcd-text', '--num-raster-threads=1', '--single-process', '--disable-features=site-per-process'];

const URLP = `${UI}/e2e/files-plus-harness.html?space=${SPACE}`;

async function attempt(n) {
  log(`--- attempt ${n}`);
  const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: LEAN, timeout: 60_000 });
  try {
    const ctx = await browser.newContext({ viewport: { width: 520, height: 420 } });
    await ctx.addInitScript(([origin, token]) => {
      localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [origin]: { token } }));
      localStorage.setItem('tm8-ui:active-server', 'local');
    }, [new URL(UI).origin, TOKEN]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('  [pageerror]', String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') log('  [console]', m.text().slice(0, 300)); });
    page.on('response', async (r) => {
      if (!r.url().includes('/v2/')) return;
      const body = r.status() >= 400 ? await r.text().catch(() => '') : '';
      log('  [http]', r.status(), r.url().replace(UI, ''), body.slice(0, 240));
    });
    const shot = async (name) => {
      await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 70 });
      log('  shot', `${OUT}/${name}.jpg`);
    };

    await page.goto(URLP, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForSelector('.tch-rootbar', { timeout: 90_000 });
    log('  header mounted');
    log('  isSecureContext:', await page.evaluate(() => window.isSecureContext));
    log('  crypto.subtle:', await page.evaluate(() => typeof crypto?.subtle));
    log('  token present:', await page.evaluate(() => !!JSON.parse(localStorage.getItem('tm8ui.auth.passes.v1') || '{}')[location.origin]?.token));
    await shot('h1-header');

    const plus = page.locator('.tch-rootcell--kind button.tch-rootcell__plus').first();
    const label = await plus.getAttribute('aria-label');
    const title = await plus.getAttribute('title');
    log('  cell + label:', label);
    log('  cell + title:', title);
    // ASSERTED, not merely printed — this is the check that caught the lying
    // tooltip, and a run that only logged it would have gone green over it.
    if (/Untitled|type its name/i.test(title ?? '')) {
      throw new Error(`the staged ＋ promises the immediate create: ${title}`);
    }

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20_000 }),
      plus.click(),
    ]);
    log('  FILE CHOOSER OPENED');
    await shot('h2-picker-open');
    await chooser.setFiles(PAYLOAD);
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="harness-log"]')?.textContent ?? '').length > 0,
      { timeout: 45_000 },
    );
    const outcome = await page.locator('[data-testid="harness-log"]').innerText();
    log('  HARNESS LOG:', outcome.replace(/\s+/g, ' '));
    await shot('h3-created');
    return true;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

let ok = false;
for (let n = 1; n <= 5 && !ok; n += 1) {
  try { ok = await attempt(n); }
  catch (e) { log('  attempt failed:', String(e).split('\n')[0]); await new Promise((r) => setTimeout(r, 6_000)); }
}
log(ok ? 'CAPTURED' : 'GAVE UP');
process.exit(ok ? 0 : 1);

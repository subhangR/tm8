/**
 * capture-files-plus — DOES ＋ ON FILES ACTUALLY UPLOAD?
 *
 * jsdom cannot answer this. The unit suite proves the action never commits an
 * entity before bytes exist; it cannot prove the ROOT HEADER'S ＋ reaches that
 * action in the shipped app, which is the exact seam Tarkesh bug 01a04730
 * lived in. So this drives the real dev server for THIS worktree against the
 * real node on :17777 through vite's same-origin /v2 proxy.
 *
 * NOT :4612 by default. That port is charter-fixed for this package, which
 * means whatever tree happens to be serving there is the one you drive — and
 * on a machine running several worktrees that is routinely SOMEBODY ELSE'S.
 * Confirm which bundle you are driving before believing a fix.
 *
 * Run it:
 *   TM8_SERVER_ORIGIN=http://127.0.0.1:17777 npx vite --port 4620 &
 *   export TM8_AGENT_TOKEN=… TM8_ACCOUNT_ID=… TM8_IDENTITY_ID=…   # auth session
 *   node e2e/capture-files-plus.mjs --ui http://127.0.0.1:4620 --out /tmp/files-plus
 *
 * IT UPLOADS FOR REAL, into whatever space that node opens on. That is the
 * point — the whole defect was a create door that never reached the node — but
 * it means each run leaves one real file entity behind, with bytes.
 *
 * The retry loop is not superstition: on a loaded box the headless renderer is
 * OOM-killed mid-navigation, and a single-shot capture reports that as a
 * failure of the thing under test.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';

const log = (...a) => writeSync(1, a.join(' ') + '\n');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const UI = argOf('ui', 'http://127.0.0.1:4620');
const OUT = argOf('out', '/tmp/files-plus');
/**
 * THE PASS THIS BROWSER SIGNS IN WITH. Everything comes from the environment
 * rather than the file, because a capture script that carries one operator's
 * account id in the repository is a credential-shaped thing nobody audits.
 * Fill them from `tm8 auth session --format json` before running.
 */
const TOKEN = process.env.TM8_AGENT_TOKEN;
const ACCOUNT_ID = process.env.TM8_ACCOUNT_ID;
const IDENTITY_ID = process.env.TM8_IDENTITY_ID;
const HANDLE = process.env.TM8_HANDLE ?? 'operator';
if (!TOKEN || !ACCOUNT_ID || !IDENTITY_ID) {
  throw new Error(
    'set TM8_AGENT_TOKEN, TM8_ACCOUNT_ID and TM8_IDENTITY_ID '
    + '(read them from `tm8 auth session --format json`)',
  );
}
mkdirSync(OUT, { recursive: true });

const STAMP = argOf('stamp', 'run');
const PAYLOAD = `${OUT}/files-plus-proof-${STAMP}.txt`;
writeFileSync(PAYLOAD,
  `Uploaded through the Files ＋ button by tm8 UI Builder, task 01a04730.\n`
  + `If this entity has bytes, the staged create door is wired.\n`);

const CHROME = '/home/tm8/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell';
const LEAN = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--disable-dev-shm-usage', '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=512', '--disable-accelerated-2d-canvas'];

async function attempt(n) {
  log(`--- attempt ${n}`);
  log('  launching browser');
  const browser = await chromium.launch({ executablePath: CHROME, args: LEAN, timeout: 60_000 });
  log('  browser up');
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(([origin, token, sessionId, handle, accountId, identityId]) => {
      const account = {
        handle, displayName: handle, accountId, identityId,
        isOwner: false, isNodeAdmin: true,
      };
      const pass = {
        token, sessionId, account,
        expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        signedInAt: new Date().toISOString(),
      };
      localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [origin]: pass }));
      localStorage.setItem('tm8ui.auth.known.v1', JSON.stringify({
        [origin]: [{ handle, displayName: handle, lastSignedInAt: new Date().toISOString() }],
      }));
      localStorage.setItem('tm8-ui:active-server', 'local');
    }, [new URL(UI).origin, TOKEN, TOKEN.split('.')[0].replace(/^tm8s_/, ''), HANDLE, ACCOUNT_ID, IDENTITY_ID]);

    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('  [pageerror]', String(e).slice(0, 160)));
    const shot = async (name) => {
      await page.screenshot({ path: `${OUT}/${name}.png` });
      log('  shot', `${OUT}/${name}.png`);
    };

    await page.goto(UI, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForTimeout(8_000);
    log('  at', page.url());
    await shot('01-landing');
    log('  TEXT:', (await page.locator('body').innerText()).slice(0, 260).replace(/\s+/g, ' '));

    // The root header's caret opens the kind menu; every row carries its own ＋.
    const caret = page.getByRole('button', { name: 'Choose which list to show' }).first();
    await caret.waitFor({ timeout: 20_000 });
    await caret.click();
    await page.waitForTimeout(1200);
    await shot('02-kind-menu');

    // The Files row's ＋. `birthVerbFor` labels it "New file" — registry data,
    // so the selector names the LABEL and not a kind string.
    const filesPlus = page.locator('li.tch-rootitem', { hasText: 'Files' })
      .locator('button.tch-rootopt__birth').first();
    await filesPlus.waitFor({ timeout: 10_000 });
    log('  files ＋ title:', await filesPlus.getAttribute('title'));
    log('  files ＋ aria-disabled:', await filesPlus.getAttribute('aria-disabled'));

    // THE ASSERTION: pressing it must open an OS file picker. On origin/main
    // it does not — it commits an entity and opens it.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      filesPlus.click(),
    ]);
    log('  FILE CHOOSER OPENED');
    await chooser.setFiles(PAYLOAD);
    await page.waitForTimeout(9_000);
    await shot('03-after-upload');
    log('  TEXT after:', (await page.locator('body').innerText()).slice(0, 400).replace(/\s+/g, ' '));
    log('  url after:', page.url());
    return true;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

let ok = false;
for (let n = 1; n <= 20 && !ok; n += 1) {
  try { ok = await attempt(n); }
  catch (e) { log('  attempt failed:', String(e).split('\n')[0]); await new Promise((r) => setTimeout(r, 30_000)); }
}
log(ok ? 'CAPTURED' : 'GAVE UP');
process.exit(ok ? 0 : 1);

/**
 * LIVE PROOF for fix/onboarding-loopback-gate.
 *
 * The gate used to read the stored pass — a browser-local value — so the owner
 * on the node's own machine saw a password card forever, even though the server
 * waves a credential-free loopback caller through as the auto-owner. This drives
 * a REAL browser against a REAL node to prove the fix, and to prove it did not
 * open the gate for a remote caller.
 *
 * Run the modified UI (this worktree's source) via vite dev, proxied at
 * TM8_SERVER_ORIGIN to the live node, so the browser exercises MY code against
 * the node's real auto-owner arm:
 *   TM8_SERVER_ORIGIN=http://127.0.0.1:7779 bun run dev
 *   node e2e/verify-loopback-gate.mjs
 *
 * Every step uses a FRESH context and a COLD goto: this SPA reads state in
 * useState initialisers, so navigating in one document measures a stale mount.
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const OUT = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch({ channel: 'chrome' });

/** Wait until either the app shell or the gate has painted, and report which. */
async function classify(page) {
  await page
    .waitForFunction(
      () => {
        const gate = document.querySelector('[data-testid="auth-frame"]');
        const pw = document.querySelector('input[type="password"]');
        const root = document.getElementById('root');
        const appish =
          !!document.querySelector('[data-testid="live-session-bar"]') ||
          !!document.querySelector('[data-testid="live-bar-idle"]') ||
          !!document.querySelector('.cv2-root') ||
          (!!root && root.childElementCount > 0 && !gate && !pw);
        return gate || pw || appish;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  return page.evaluate(() => {
    const gate = document.querySelector('[data-testid="auth-frame"]');
    const pw = document.querySelector('input[type="password"]');
    return {
      gatePresent: !!gate,
      gateFrame: gate?.getAttribute('data-frame') ?? null,
      passwordFieldPresent: !!pw,
      rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      hasLiveBar: !!document.querySelector('[data-testid="live-session-bar"], [data-testid="live-bar-idle"]'),
    };
  });
}

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}

/* ── STEP 1 — cold loopback: land IN THE APP, no password card ───────────── */
{
  console.log('\nSTEP 1 — cold browser, loopback origin (the owner on their own box)');
  const ctx = await browser.newContext(); // fresh: no storage, no cookies
  const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const r = await classify(page);
  console.log('  observed:', JSON.stringify(r));
  check('no auth gate is shown', !r.gatePresent);
  check('no password field is shown', !r.passwordFieldPresent);
  check('the app rendered (root has content)', r.rootChildren > 0);
  await page.screenshot({ path: `${OUT}loopback-gate-STEP1-in-the-app.png`, fullPage: false });
  console.log(`  screenshot: ${OUT}loopback-gate-STEP1-in-the-app.png`);
  await ctx.close();
}

/* ── STEP 2 — a forwarded (remote) caller must still be GATED ─────────────── */
{
  console.log('\nSTEP 2 — cold browser, a FORWARDED caller (simulated remote/proxied origin)');
  // X-Forwarded-For makes the node treat the caller as non-loopback, exactly as
  // a real reverse-proxied remote request does — the auto-owner arm goes off.
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.7' } });
  const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const r = await classify(page);
  console.log('  observed:', JSON.stringify(r));
  check('the gate IS shown (remote origin is not auto-owner)', r.gatePresent);
  check('the app did NOT render for a remote caller', !r.hasLiveBar);
  await page.screenshot({ path: `${OUT}loopback-gate-STEP2-remote-gated.png`, fullPage: false });
  console.log(`  screenshot: ${OUT}loopback-gate-STEP2-remote-gated.png`);
  await ctx.close();
}

/* ── STEP 3 — sign-out must not loop back into auto-owner ─────────────────── */
{
  console.log('\nSTEP 3 — sign-out on the loopback node stays signed out (the trap)');
  const ctx = await browser.newContext();
  const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const before = await classify(page);
  check('started IN the app', !before.gatePresent && before.rootChildren > 0);

  // Drive the app's own sign-out: set the "signed out on purpose" flag exactly
  // as the account menu's Sign out does (session.ts writes this key), then
  // reload COLD. If the fix is wrong, the loopback probe signs us straight back
  // in; if it is right, the gate stays.
  await page.evaluate(() => {
    const serverId = 'local';
    const key = 'tm8ui.auth.autoowner-suppressed.v1';
    const raw = window.localStorage.getItem(key);
    const all = raw ? JSON.parse(raw) : {};
    all[serverId] = true;
    window.localStorage.setItem(key, JSON.stringify(all));
    window.localStorage.removeItem('tm8ui.auth.autoowner.v1'); // forget the cached auto-owner too
  });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' }); // cold reload
  const after = await classify(page);
  console.log('  observed after sign-out + cold reload:', JSON.stringify(after));
  check('the gate is shown after a deliberate sign-out', after.gatePresent);
  check('the app did NOT re-sign-in via the loopback arm', !after.hasLiveBar);
  await page.screenshot({ path: `${OUT}loopback-gate-STEP3-signed-out.png`, fullPage: false });
  console.log(`  screenshot: ${OUT}loopback-gate-STEP3-signed-out.png`);
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

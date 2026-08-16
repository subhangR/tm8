/**
 * LIVE PROOF for fix/onboarding-loopback-gate — the BEHAVIOURAL bar.
 *
 * "Owner login onboarding everything should work seamlessly." On the server's
 * own machine the owner never meets a password card. This drives a REAL browser
 * (fresh contexts, cold navigations) against a REAL node and proves the six
 * acceptance criteria the lead set:
 *
 *   1. cold open, already-claimed loopback node -> lands IN THE APP, no flash
 *   2. reload -> still in, no gate
 *   3. a brand-new profile -> also straight in (the NODE's answer decides)
 *   4. sign out (real UI) -> land at the gate and STAY (no bounce-back)
 *   5. after sign-out, explicit handle/password sign-in -> back in
 *   6. a caller the server will not vouch for (forwarded/remote origin, or the
 *      auto-owner arm disabled) -> the sign-in card, driven by the server
 *
 * Run the modified UI (this worktree's source) via vite dev, proxied to the
 * node, so the browser exercises MY code against the node's real auto-owner arm.
 * The vite proxy uses changeOrigin:false and adds no X-Forwarded-* header, so it
 * preserves the loopback peer:
 *   TM8_SERVER_ORIGIN=http://127.0.0.1:7788 bun run dev
 *   node e2e/verify-loopback-gate.mjs [origin] [handle] [password]
 *
 * Every step uses a FRESH context and a COLD goto: this SPA reads state in
 * useState initialisers, so navigating in one document measures a stale mount.
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const HANDLE = process.argv[3] ?? 'owner';
const PASSWORD = process.argv[4] ?? 'correct-horse-battery';
const OUT = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch({ channel: 'chrome' });

/** Wait until either the app shell or the gate has painted, then report which. */
async function classify(page) {
  await page
    .waitForFunction(
      () => {
        const gate = document.querySelector('[data-testid="auth-frame"]');
        const pw = document.querySelector('input[type="password"]');
        const root = document.getElementById('root');
        const appish =
          !!document.querySelector('[data-testid="account-menu-trigger"]') ||
          !!document.querySelector('[data-testid="live-session-bar"]') ||
          !!document.querySelector('[data-testid="live-bar-idle"]');
        return gate || pw || appish || (!!root && root.childElementCount > 0);
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  return page.evaluate(() => {
    const gate = document.querySelector('[data-testid="auth-frame"]');
    const pw = document.querySelector('input[type="password"]');
    // Past the gate = the app shell painted. `space-tab-bar` is the shell's
    // top bar and is present whenever children render, whether or not the
    // account menu (which needs a hydrated space membership) has mounted yet.
    return {
      inApp: !!document.querySelector('[data-testid="space-tab-bar"]'),
      accountMenu: !!document.querySelector('[data-testid="account-menu-trigger"]'),
      gatePresent: !!gate,
      gateFrame: gate?.getAttribute('data-frame') ?? null,
      passwordFieldPresent: !!pw,
      rootChildren: document.getElementById('root')?.childElementCount ?? 0,
    };
  });
}

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}
async function coldOpen(ctx) {
  const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  return page;
}

/* ── 1 — cold open, claimed loopback node -> IN THE APP, no flash ─────────── */
{
  console.log('\n[1] cold browser, loopback origin, already-claimed node');
  const ctx = await browser.newContext(); // fresh: no storage, no cookies
  // The no-flash proof: the gate must NEVER have been in the document.
  const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
  let gateAppeared = false;
  await page.addInitScript(() => {
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.querySelector?.('[data-testid="auth-frame"]')) window.__gateAppeared = true;
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const r = await classify(page);
  gateAppeared = await page.evaluate(() => !!window.__gateAppeared);
  console.log('  observed:', JSON.stringify(r));
  check('lands in the app', r.inApp);
  check('no sign-in gate shown', !r.gatePresent);
  check('no password field shown', !r.passwordFieldPresent);
  check('NO card ever flashed (gate never mounted)', !gateAppeared);
  await page.screenshot({ path: `${OUT}loopback-gate-1-in-the-app.png` });
  await ctx.close();
}

/* ── 2 — reload -> still in, no gate ──────────────────────────────────────── */
{
  console.log('\n[2] reload (cold) in the same profile');
  const ctx = await browser.newContext();
  await coldOpen(ctx); // warms the per-server auto-owner cache
  const page = await coldOpen(ctx); // the reload
  const r = await classify(page);
  console.log('  observed:', JSON.stringify(r));
  check('still in the app after reload', r.inApp);
  check('no gate on reload', !r.gatePresent);
  await ctx.close();
}

/* ── 3 — a brand-new profile -> also straight in (the node decides) ───────── */
{
  console.log('\n[3] a brand-new browser profile (no shared storage)');
  const ctx = await browser.newContext(); // a different profile than [1]/[2]
  const page = await coldOpen(ctx);
  const r = await classify(page);
  console.log('  observed:', JSON.stringify(r));
  check('a fresh profile also lands in the app', r.inApp);
  check('no gate for a fresh profile', !r.gatePresent);
  await ctx.close();
}

/* ── 4 & 5 — sign out (real UI) STAYS out, then sign in puts you back ─────── */
{
  console.log('\n[4] sign out through the account menu, then a cold reload');
  const ctx = await browser.newContext();
  const page = await coldOpen(ctx);
  check('started in the app', (await classify(page)).inApp);

  await page.locator('[data-testid="account-menu-trigger"]').click();
  await page.locator('[data-testid="auth-account-menu"]').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.locator('[data-testid="auth-frame"]').waitFor({ timeout: 8000 });
  const afterSignOut = await classify(page);
  console.log('  after sign out:', JSON.stringify(afterSignOut));
  check('sign-out returns to the gate', afterSignOut.gatePresent && !afterSignOut.inApp);

  const reloaded = await coldOpen(ctx); // cold reload — the bounce-back trap
  const afterReload = await classify(reloaded);
  console.log('  after cold reload:', JSON.stringify(afterReload));
  check('STAYS at the gate — no bounce back into the app', afterReload.gatePresent && !afterReload.inApp);
  await reloaded.screenshot({ path: `${OUT}loopback-gate-4-signed-out.png` });

  console.log('\n[5] explicit handle/password sign-in after the sign-out');
  const handleField = reloaded.locator('input:not([type="password"])').first();
  await handleField.fill(HANDLE);
  await reloaded.locator('input[type="password"]').first().fill(PASSWORD);
  await reloaded.getByRole('button', { name: /^sign in$/i }).click();
  await reloaded.locator('[data-testid="account-menu-trigger"]').waitFor({ timeout: 8000 }).catch(() => {});
  const afterSignIn = await classify(reloaded);
  console.log('  after sign in:', JSON.stringify(afterSignIn));
  check('handle/password sign-in puts you back in the app', afterSignIn.inApp);
  await ctx.close();
}

/* ── 6a — a forwarded (remote) caller must still be GATED ─────────────────── */
{
  console.log('\n[6a] a FORWARDED caller (simulated remote/proxied origin)');
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.7' } });
  const page = await coldOpen(ctx);
  const r = await classify(page);
  console.log('  observed:', JSON.stringify(r));
  check('a remote origin is NOT auto-owner — the gate is shown', r.gatePresent);
  check('the app did NOT render for a remote caller', !r.inApp);
  await page.screenshot({ path: `${OUT}loopback-gate-6a-remote-gated.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

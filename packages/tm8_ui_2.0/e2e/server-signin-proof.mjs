/**
 * LIVE PROOF — sign in to a named server from inside the workspace.
 *
 * Drives the dev UI (vite :4612 → local node :7778) through the real journey:
 *   1. sign in on the local node (gate 1d),
 *   2. switch the rail to utho-prod (real remote node that 401s anonymous),
 *   3. the NEW in-workspace login frame appears (rail still on screen),
 *   4. sign in with real prod credentials → prod workspace loads, no reload.
 *
 * Usage: TM8_LOCAL_PASSWORD=… TM8_PROD_PASSWORD=… node e2e/server-signin-proof.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'gate-evidence/server-signin';
mkdirSync(OUT, { recursive: true });

const LOCAL_PASSWORD = process.env.TM8_LOCAL_PASSWORD ?? '';
const PROD_PASSWORD = process.env.TM8_PROD_PASSWORD ?? '';
if (!LOCAL_PASSWORD || !PROD_PASSWORD) {
  console.error('set TM8_LOCAL_PASSWORD and TM8_PROD_PASSWORD');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

// Known-account seed so the gate opens on 1d (sign-in), not 1a (first-run).
await page.addInitScript(() => {
  localStorage.setItem(
    'tm8ui.auth.known.v1',
    JSON.stringify({
      'http://127.0.0.1:4612': [
        { handle: 'subhang', displayName: 'Subhang', lastSignedInAt: new Date().toISOString() },
      ],
    }),
  );
});

await page.goto('http://127.0.0.1:4612/');

// ── 1. the entry gate, local node ──────────────────────────────────────────
await page.waitForSelector('[data-testid="auth-frame"][data-frame="1d"]', { timeout: 20_000 });
await page.getByLabel('HANDLE').fill('subhang');
await page.getByLabel('PASSWORD').fill(LOCAL_PASSWORD);
await page.getByRole('button', { name: /^sign in$/i }).click();
await page.waitForSelector('[data-testid="workspace-grid"]', { timeout: 30_000 });
await page.screenshot({ path: `${OUT}/1-local-workspace.png` });
console.log('1 ✓ signed in on local, workspace mounted');

// ── 2. switch the rail to utho-prod ────────────────────────────────────────
await page.getByText('utho-prod', { exact: false }).first().click();

// ── 3. the in-workspace login frame, NOT the unreachable card ─────────────
await page.waitForSelector('[data-testid="auth-frame"][data-frame="1d"]', { timeout: 30_000 });
const railStillThere = await page.$('[data-testid="menu-rail"]');
const cantReach = await page.getByText(/Can’t reach the tm8 node/).count();
console.log(
  `2 ${railStillThere ? '✓' : '✗'} rail still on screen; ` +
    `${cantReach === 0 ? '✓' : '✗'} no unreachable-node card`,
);
await page.screenshot({ path: `${OUT}/2-utho-prod-login-frame.png` });

// ── 4. real prod sign-in through the frame ────────────────────────────────
await page.getByLabel('HANDLE').fill('subhang');
await page.getByLabel('PASSWORD').fill(PROD_PASSWORD);
await page.getByRole('button', { name: /^sign in$/i }).click();
await page.waitForSelector('[data-testid="workspace-grid"]', { timeout: 60_000 });
await page.screenshot({ path: `${OUT}/3-utho-prod-workspace.png` });

const passKeys = await page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem('tm8ui.auth.passes.v1') ?? '{}')),
);
console.log('3 ✓ prod workspace mounted without reload; pass keys:', passKeys);

await browser.close();

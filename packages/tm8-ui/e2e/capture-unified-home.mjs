// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Drives the REAL composed app (fixture seam) through the unified Home:
// rail + root header, kind menu, a rooted centre, and the address bar claims.
// Run: bunx vite --port 4633 & bunx node e2e/capture-unified-home.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.CAPTURE_BASE ?? 'http://127.0.0.1:4633';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.localStorage.setItem('tm8-ui:real-seam', '0');
  /* The gate wants a pass; the fixture world has no server to mint one. A
     seeded pass under the page origin (the LOCAL server's pass key) signs
     the capture in; the node-verify failing against a dev server without
     auth endpoints keeps, not revokes, the pass. */
  window.localStorage.setItem(
    'tm8ui.auth.passes.v1',
    JSON.stringify({
      [window.location.origin]: {
        token: 'tm8s_capture.secret',
        account: {
          handle: '@capture',
          displayName: 'Capture',
          accountId: 'acct-capture',
          identityId: 'id-capture',
          isOwner: true,
          isNodeAdmin: true,
        },
        sessionId: 'sess-capture',
        expiresAt: '2027-01-01T00:00:00.000Z',
        signedInAt: '2026-08-16T00:00:00.000Z',
      },
    }),
  );
});

async function setTheme(theme) {
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function shoot(name) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
}

// 1. Home landing: icon rail + [Chats ＋][Kind ＋ ▾] header + composer centre.
await page.goto(`${BASE}/#/s/sp-atelier/home`);
await page.getByTestId('home-page').waitFor();
await page.getByTestId('home-rail').waitFor();
await setTheme('light');
await shoot('unified-home-01-landing-light');
await setTheme('dark');
await shoot('unified-home-02-landing-dark');
await setTheme('light');

// 2. The kind menu (R5: the caret only switches).
await page.getByRole('button', { name: 'Choose which list to show' }).click();
await shoot('unified-home-03-kind-menu');
await page.keyboard.press('Escape');

// 3. Rail click → tasks root; the address follows.
await page.getByTestId('home-rail').getByRole('button', { name: /^Tasks/ }).click();
await page.getByTestId('tch-hosted-list').waitFor();
await shoot('unified-home-04-tasks-root');
const rootHash = await page.evaluate(() => window.location.hash);
console.log('address after rail click:', rootHash);

// 4. Tile click → the centre roots on the entity (trail in `p`).
await page.getByTestId('tch-hosted-list').getByText('Session tree guide lines').first().click();
await page.getByTestId('tch-center-override').waitFor();
await shoot('unified-home-05-centre-rooted');
const trailHash = await page.evaluate(() => window.location.hash);
console.log('address with centre trail:', trailHash);

// 5. The expanded rail (the #269 anatomy, wider).
await page.getByRole('button', { name: 'Expand the rail' }).click();
await shoot('unified-home-06-rail-expanded');

await browser.close();
console.log('done');

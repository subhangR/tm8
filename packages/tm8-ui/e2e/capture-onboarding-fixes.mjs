/**
 * Capture the three first-run screens this lane fixes, from the SHIPPING app
 * under the SHIPPING stylesheet against a REAL node — jsdom sees no CSS, so
 * only a browser proves colour, layout and theme.
 *
 * Usage: node e2e/capture-onboarding-fixes.mjs [appOrigin]
 *   appOrigin defaults to the dev server on http://127.0.0.1:4680, which must
 *   already be proxying /v2 to a live node.
 *
 * TRAP (stated by the lane lead): this SPA reads state in useState
 * initialisers, so a same-document navigation does NOT remount. Every shot
 * below uses a FRESH context and a COLD goto for exactly that reason.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const app = process.argv[2] ?? 'http://127.0.0.1:4680';
const OUT = 'gate-evidence/onboarding';
mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };
const HANDLE = 'samrivera';
const PASSWORD = 'correct-horse-battery';

const browser = await chromium.launch({ channel: 'chrome' });

/** A fresh context, themed, with optional init-script and route overrides. */
async function freshPage({ theme, init, routes }) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: theme,
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('tm8ui.theme', t);
    } catch {}
  }, theme);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  if (routes) for (const [pattern, handler] of routes) await page.route(pattern, handler);
  return { context, page };
}

/** Fulfil auth.claim.status as an UNCLAIMED single-player node. The scratch
 * node is claimed, so the live status is simulated; this verifies the claim
 * card's RENDER (chrome origin + copy), not the claim submit. */
const unclaimedRoute = [
  '**/v2/auth/claim',
  (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { claimed: false, mode: 'single', signupPath: 'claim' } }),
      });
    }
    return route.continue();
  },
];

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  captured', name);
}

for (const theme of ['light', 'dark']) {
  console.log(`\n== theme: ${theme} ==`);

  // DEFECT 3 + DEFECT 2 (meta) — the first-run CLAIM card on an unclaimed node.
  {
    const { context, page } = await freshPage({
      theme,
      init: () => {
        try {
          localStorage.setItem(
            'tm8ui.auth.nodeclaim.v1',
            JSON.stringify({ local: { claimed: false, mode: 'single', signupPath: 'claim' } }),
          );
        } catch {}
      },
      routes: [unclaimedRoute],
    });
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('SETUP TOKEN').waitFor({ timeout: 20000 });
    const meta = await page.locator('.auth-stage__meta').first().innerText().catch(() => '(none)');
    const body = await page.locator('.auth-body').first().innerText().catch(() => '(none)');
    console.log(`  claim card meta: ${meta}`);
    console.log(`  claim card body: ${body.slice(0, 120)}…`);
    await shot(page, `claim-card-${theme}`);
    await context.close();
  }

  // DEFECT 2 — the SIGN-IN card footer (node is claimed → gate opens on 1d).
  {
    const { context, page } = await freshPage({ theme });
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^sign in$/i }).waitFor({ timeout: 20000 });
    const footer = await page.locator('.auth-footnote').last().innerText().catch(() => '(none)');
    console.log(`  sign-in footer: ${footer}`);
    await shot(page, `signin-card-${theme}`);
    await context.close();
  }

  // DEFECT 1 — the zero-spaces WELCOME, reached by signing in for real. The
  // scratch node genuinely has a Space, so the space LIST read is fulfilled
  // empty to reach the zero-spaces state; the welcome component is driven only
  // by that emptiness, so the render is the shipping one. (Stated for honesty.)
  {
    const emptySpaces = [
      '**/v2/spaces',
      (route) => {
        const u = new URL(route.request().url());
        if (route.request().method() === 'GET' && u.pathname === '/v2/spaces') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [] }),
          });
        }
        return route.continue();
      },
    ];
    const { context, page } = await freshPage({ theme, routes: [emptySpaces] });
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('HANDLE').waitFor({ timeout: 20000 });
    await page.getByLabel('HANDLE').fill(HANDLE);
    await page.getByLabel('PASSWORD').fill(PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const welcome = page.getByTestId('welcome-no-spaces');
    try {
      await welcome.waitFor({ timeout: 25000 });
      console.log('  reached the zero-spaces welcome');
      await shot(page, `welcome-${theme}`);
    } catch {
      console.log('  DID NOT reach welcome — capturing whatever rendered for honesty');
      await shot(page, `welcome-MISS-${theme}`);
    }
    await context.close();
  }
}

await browser.close();
console.log('\ndone');

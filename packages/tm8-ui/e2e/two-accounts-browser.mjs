/**
 * THE BROWSER HALF of the two-users acceptance (Identity v2 Slice 1).
 *
 *   "log in as two different accounts, create tasks and entities as each,
 *    and see two different user icons on the tasks."
 *
 * Drives the REAL gate in a REAL browser against a REAL server: the vite dev
 * server on :4614 proxies /v2 to a worktree-built tm8-server on :8899 with
 * the full migration chain. Nothing is stubbed — the gate's auth.signup /
 * auth.login are the production wire.
 *
 * Space membership is provisioned exactly as docs/identity/
 * PROVISION-SECOND-ACCOUNT.md documents: the loopback owner creates a space
 * invite over the API, and each account redeems it under ITS OWN bearer —
 * read from the browser's per-origin pass store, which is itself part of
 * what this script proves.
 *
 *   UI_URL=http://127.0.0.1:4614 API_URL=http://127.0.0.1:8899 \
 *     node e2e/two-accounts-browser.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const UI = process.env.UI_URL ?? 'http://127.0.0.1:4614';
const API = process.env.API_URL ?? 'http://127.0.0.1:8899';
const OUT = new URL('../gate-evidence/identity-two-accounts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const cmid = () => crypto.randomUUID();
let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'X-TM8-Client': 'tm8-ui',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, error: json.error };
}

/** The browser's own per-origin pass store — the thing Slice 1 added. */
async function passFromBrowser(page) {
  return page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('tm8ui.auth.passes.v1') ?? '{}');
    return all[location.origin] ?? null;
  });
}

async function createAccount(page, name, password) {
  await page.getByLabel('YOUR NAME').fill(name);
  await page.getByLabel('PASSWORD').fill(password);
  await page.getByRole('button', { name: /create (owner )?account/i }).click();
  await page.waitForSelector('[data-testid="auth-frame"]', { state: 'detached', timeout: 15000 });
}

async function signOut(page) {
  await page.getByTestId('account-menu-trigger').click();
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForSelector('[data-testid="auth-frame"]', { timeout: 15000 });
}

const run = async () => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const AMBER = `amber_${suffix}`;
  const BOBBY = `bobby_${suffix}`;
  const PW_A = 'amber-browser-pass-1';
  const PW_B = 'bobby-browser-pass-2';

  // The space both humans will work in, made by the loopback owner (T-L7).
  const space = await api('POST', '/v2/spaces', {
    body: { clientMutationId: cmid(), name: `Browser Proof ${suffix}`, description: 'Slice 1 browser acceptance' },
  });
  check('owner creates the proof space', space.status === 201, JSON.stringify(space.error));
  const spaceId = space.data?.space?.id;

  // channel: 'chrome' drives the machine's installed Chrome — the playwright
  // cache in this worktree has no downloaded binary for this version.
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

  // ── §1 · first run: the gate, then a REAL account ─────────────────────
  console.log('\n§1 · amber signs up through the gate');
  await page.goto(UI);
  await page.waitForSelector('[data-testid="auth-frame"]', { timeout: 15000 });
  check('the gate is on screen, the app is not', (await page.locator('[data-testid="auth-frame"]').count()) === 1);
  await createAccount(page, AMBER, PW_A);
  check('the gate closed after signup', true);

  const amberPass = await passFromBrowser(page);
  check('a tm8s_ pass is stored under the page ORIGIN', !!amberPass && amberPass.token.startsWith('tm8s_'));
  check('the pass names amber', amberPass?.account?.handle === AMBER, JSON.stringify(amberPass?.account));

  const whoami = await api('GET', '/v2/auth/session', { token: amberPass.token });
  check('the browser-held pass resolves to amber ON THE SERVER', whoami.data?.account?.username === AMBER,
    `got ${whoami.status} ${whoami.data?.account?.username}`);

  // Provision membership per the documented path: owner invites, amber
  // redeems under her own pass.
  const invA = await api('POST', `/v2/spaces/${spaceId}/invites`, { body: { clientMutationId: cmid(), maxUses: 1 } });
  const redeemA = await api('POST', '/v2/invites/redeem', {
    token: amberPass.token,
    body: { clientMutationId: cmid(), code: invA.data?.code ?? invA.data?.invite?.code },
  });
  check('amber redeems her invite', redeemA.status === 200 || redeemA.status === 201, JSON.stringify(redeemA.error));

  await page.reload();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}1-amber-signed-in.png` });

  // ── §2 · amber creates a task, in the browser ─────────────────────────
  console.log('\n§2 · amber creates a task');
  await createTaskInUI(page, 1);
  await page.screenshot({ path: `${OUT}2-amber-task.png` });

  // ── §3 · sign out, and bobby arrives ──────────────────────────────────
  console.log('\n§3 · bobby signs up through the gate');
  await signOut(page);
  check('sign-out returned to the gate', true);
  // The sign-in frame offers "create another account" — the second human.
  await page.getByRole('button', { name: /create another account/i }).click();
  await createAccount(page, BOBBY, PW_B);
  const bobbyPass = await passFromBrowser(page);
  check('bobby has his OWN tm8s_ pass now', !!bobbyPass && bobbyPass.token.startsWith('tm8s_') && bobbyPass.token !== amberPass.token);
  check('the pass names bobby', bobbyPass?.account?.handle === BOBBY, JSON.stringify(bobbyPass?.account));

  const invB = await api('POST', `/v2/spaces/${spaceId}/invites`, { body: { clientMutationId: cmid(), maxUses: 1 } });
  const redeemB = await api('POST', '/v2/invites/redeem', {
    token: bobbyPass.token,
    body: { clientMutationId: cmid(), code: invB.data?.code ?? invB.data?.invite?.code },
  });
  check('bobby redeems his invite', redeemB.status === 200 || redeemB.status === 201, JSON.stringify(redeemB.error));

  await page.reload();
  await page.waitForTimeout(4000);

  console.log('\n§4 · bobby creates a task');
  await createTaskInUI(page, 2);
  await page.screenshot({ path: `${OUT}3-bobby-task.png` });

  // ── §5 · THE ACCEPTANCE ASSERTION — two tasks, two authors, on screen ──
  console.log('\n§5 · two different user icons on the two tasks');
  console.log(`  spaceId for the SQL check: ${spaceId}`);

  // A fresh task tile has no assignee, so the LIST shows no avatar for it —
  // the creator's identity renders in the task DETAIL chrome (created-by
  // avatar + name; initials-first, since every profile row is NULL). Open
  // each of the two tiles and read who the detail says made it.
  const authorsSeen = [];
  const tiles = page.locator('text=Untitled task');
  const tileCount = await tiles.count();
  check('two task tiles are in the list', tileCount >= 2, `found ${tileCount}`);
  for (let i = 0; i < Math.min(tileCount, 2); i += 1) {
    await tiles.nth(i).click();
    await page.waitForTimeout(1500);
    const detail = await page.evaluate((names) => {
      const found = [];
      for (const el of document.querySelectorAll('[class*="kit-avatar" i], [class*="avatar" i]')) {
        const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (names.some((n) => label.includes(n))) found.push(label);
      }
      return found;
    }, [AMBER, BOBBY]);
    await page.screenshot({ path: `${OUT}4-task-detail-${i + 1}.png` });
    console.log(`  detail ${i + 1} author avatars:`, JSON.stringify(detail));
    authorsSeen.push(new Set(detail));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  const sawAmber = authorsSeen.some((s) => [...s].some((l) => l.includes(AMBER)));
  const sawBobby = authorsSeen.some((s) => [...s].some((l) => l.includes(BOBBY)));
  check('one task shows AMBER as its author icon', sawAmber);
  check('the other task shows BOBBY as its author icon', sawBobby);

  await browser.close();
  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failures ===`);
  process.exit(failures ? 1 : 0);
};

/**
 * Create a task through the workspace UI. "New task" is the generic-create
 * pattern: it commits "Untitled task" IMMEDIATELY (no composer — T5-6:
 * "created for real, instantly"). Success is the open-count incrementing and
 * a new tile; a RefusalCard is read out loud rather than swallowed — this
 * script's job is proof, and a silent miss would be the exact instrument
 * failure the project's memories warn about.
 */
async function createTaskInUI(page, expectedOpenCount) {
  await page.getByRole('button', { name: 'New task' }).first().click();
  try {
    await page
      .locator(`button:has-text("Open ${expectedOpenCount}")`)
      .first()
      .waitFor({ timeout: 15000 });
    check(`the open count reached ${expectedOpenCount}`, true);
  } catch {
    const refusal = await page
      .locator('[class*="refusal" i], [class*="au-refus" i]')
      .allTextContents()
      .catch(() => []);
    const status = await page.getByRole('status').allTextContents().catch(() => []);
    await page.screenshot({ path: `${OUT}debug-create-${Date.now()}.png` });
    check(
      `the open count reached ${expectedOpenCount}`,
      false,
      `refusal: ${JSON.stringify(refusal)} status: ${JSON.stringify(status)}`,
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

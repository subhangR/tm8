/**
 * Extended Identity 2 browser gate: two authenticated humans post into the
 * same channel, then the rendered feed and server DTOs must name both authors.
 *
 * The channel itself is provisioned ahead of time through the documented API
 * path; every message below is authored through the real browser composer.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const UI = process.env.UI_URL ?? 'https://tm8-server.tail28ac62.ts.net:8888';
const API = process.env.API_URL ?? UI;
const SPACE_ID = process.env.E2E_SPACE_ID;
const CHANNEL_ID = process.env.E2E_CHANNEL_ID;
const CHANNEL_TITLE = process.env.E2E_CHANNEL_TITLE;
const ALICE = process.env.E2E_ALICE_USER;
const ALICE_PASS = process.env.E2E_ALICE_PASS;
const BOB = process.env.E2E_BOB_USER;
const BOB_PASS = process.env.E2E_BOB_PASS;
const OUT = new URL('../gate-evidence/identity-two-accounts/', import.meta.url).pathname;

if (!SPACE_ID || !CHANNEL_ID || !CHANNEL_TITLE || !ALICE || !ALICE_PASS || !BOB || !BOB_PASS) {
  throw new Error(
    'requires E2E_SPACE_ID, E2E_CHANNEL_ID/TITLE, E2E_ALICE_USER/PASS and E2E_BOB_USER/PASS',
  );
}
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

async function signIn(page, handle, password) {
  if ((await page.getByLabel('HANDLE').count()) === 0) {
    await page.getByRole('button', { name: /already have an account.*sign in|back to sign in/i }).click();
  }
  await page.getByLabel('HANDLE').fill(handle);
  await page.getByLabel('PASSWORD').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForSelector('[data-testid="auth-frame"]', { state: 'detached', timeout: 15_000 });
}

async function signOut(page) {
  await page.getByTestId('account-menu-trigger').click();
  await page.getByRole('button', { name: /sign out/i }).click();
  // A cold Utho Vite graph is hundreds of module requests over HTTP/1.1 and
  // has measured just over a minute. The gate itself is the readiness oracle.
  await page.waitForSelector('[data-testid="auth-frame"]', { timeout: 120_000 });
}

async function passFromBrowser(page) {
  return page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('tm8ui.auth.passes.v1') ?? '{}');
    return all[location.origin] ?? null;
  });
}

async function openChannel(page) {
  // GateApp's current screen target is component state, not cold-hydrated from
  // the hash route. Drive the shipped list-kind switcher exactly as a human
  // does: Tasks ▾ → Channels → the channel row. This also ensures the channel
  // collection is hydrated on a menu config that predates migration 071.
  const panel = page.locator('[data-testid="entity-list-panel"]').first();
  await panel.waitFor({ timeout: 20_000 });
  await panel.locator('button.lp__kind').click();
  await page.getByRole('menuitem', { name: 'Channels', exact: true }).first().click();
  const channelPanel = page.locator('[data-testid="entity-list-panel"][data-kind="channel"]').first();
  await channelPanel.waitFor({ timeout: 20_000 });
  await channelPanel.getByRole('button', { name: CHANNEL_TITLE, exact: true }).click();
  // The feed is a second lazy split point. On staging's Vite dev server its
  // first browser load can spend more than 20 seconds transforming the module
  // graph even after the workspace shell is interactive.
  await page.getByRole('textbox', { name: 'Message this channel' }).waitFor({ timeout: 120_000 });
}

async function postFromBrowser(page, body) {
  const composer = page.getByRole('textbox', { name: 'Message this channel' });
  await composer.fill(body);
  const send = page.locator('button.chs-composer__send', { hasText: 'Send' });
  try {
    await send.waitFor({ state: 'visible', timeout: 120_000 });
  } catch (error) {
    const reason = (await page.locator('[data-testid="chs-send-reason"] .hon-caption').textContent())?.trim()
      ?? 'Send did not become available and no visible refusal was rendered';
    await page.screenshot({ path: `${OUT}channel-send-blocker.png`, fullPage: true });
    throw new Error(`browser composer stayed unavailable: ${reason}`, { cause: error });
  }
  await send.click();
  // A page-wide text query can match the controlled textarea's value before
  // the command settles. The draft clears only after `messages.post` and the
  // authoritative feed reload both finish; then require the body in the feed.
  await page.waitForFunction(() => {
    const draft = document.querySelector('.chs-composer__input');
    return draft instanceof HTMLTextAreaElement && draft.value === '';
  }, null, { timeout: 30_000 });
  await page.locator('.chs-list').getByText(body, { exact: true }).waitFor({ timeout: 30_000 });
}

async function apiMessages(token) {
  const res = await fetch(`${API}/v2/entities/${CHANNEL_ID}/messages?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, items: json.data?.items ?? [], error: json.error };
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
page.on('response', (response) => {
  if (response.url().includes('/v2/') && response.status() >= 400) {
    console.log(`  [http ${response.status()}] ${response.request().method()} ${response.url()}`);
  }
});

const suffix = crypto.randomUUID().slice(0, 6);
const aliceBody = `Alice browser channel proof ${suffix}`;
const bobBody = `Bob browser channel proof ${suffix}`;

try {
  console.log('\n§1 · Alice signs in and posts through the channel composer');
  // Vite keeps a long-lived development transport on staging. Waiting for the
  // document commit and then the product's auth-frame oracle avoids treating
  // that transport as page readiness.
  await page.goto(UI, { waitUntil: 'commit', timeout: 30_000 });
  await page.waitForSelector('[data-testid="auth-frame"]', { timeout: 120_000 });
  await signIn(page, ALICE, ALICE_PASS);
  const alicePass = await passFromBrowser(page);
  check('Alice has a real server pass', alicePass?.token?.startsWith('tm8s_'));
  await openChannel(page);
  await postFromBrowser(page, aliceBody);
  await page.locator('.chs-byline__who', { hasText: 'Alice Example' }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${OUT}5-channel-alice-message.png` });
  check('Alice message renders with the Alice Example byline', true);

  console.log('\n§2 · Alice signs out; Bob signs in and posts to the same channel');
  await signOut(page);
  await signIn(page, BOB, BOB_PASS);
  const bobPass = await passFromBrowser(page);
  check('Bob has a different real server pass',
    bobPass?.token?.startsWith('tm8s_') && bobPass.token !== alicePass.token);
  await openChannel(page);
  await postFromBrowser(page, bobBody);
  await page.getByText(aliceBody, { exact: true }).waitFor({ timeout: 20_000 });

  const bylines = (await page.locator('.chs-byline__who').allTextContents()).map((value) => value.trim());
  const avatarLabels = await page.locator('.chs-gutter .kit-avatar').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? element.getAttribute('title') ?? ''),
  );
  console.log('  rendered bylines:', JSON.stringify(bylines));
  console.log('  rendered avatar labels:', JSON.stringify(avatarLabels));
  check('the rendered feed shows Alice Example', bylines.includes('Alice Example'));
  check('the rendered feed shows Bob Example', bylines.includes('Bob Example'));
  check('the rendered feed shows Alice’s face', avatarLabels.some((label) => label.includes('Alice Example')));
  check('the rendered feed shows Bob’s face', avatarLabels.some((label) => label.includes('Bob Example')));
  await page.screenshot({ path: `${OUT}6-channel-two-authors.png`, fullPage: true });

  console.log('\n§3 · API receipt for the exact two rendered messages');
  const receipt = await apiMessages(bobPass.token);
  check('messages.list answers 200 under Bob’s bearer', receipt.status === 200,
    `${receipt.status} ${JSON.stringify(receipt.error)}`);
  const exact = receipt.items
    .filter((item) => item?.content?.body === aliceBody || item?.content?.body === bobBody)
    .map((item) => ({
      id: item.id,
      body: item.content.body,
      authorId: item.state?.author?.id ?? item.createdBy?.id,
      author: item.state?.author?.displayName ?? item.createdBy?.displayName,
      avatar: item.state?.author?.avatar ?? item.createdBy?.avatar ?? null,
    }));
  console.log(JSON.stringify({ channelId: CHANNEL_ID, messages: exact }, null, 2));
  check('the API returns both exact message bodies', exact.length === 2, `found ${exact.length}`);
  check('the API names Alice Example and Bob Example',
    new Set(exact.map((item) => item.author)).size === 2
      && exact.some((item) => item.author === 'Alice Example')
      && exact.some((item) => item.author === 'Bob Example'));
  check('the API carries two different author member ids', new Set(exact.map((item) => item.authorId)).size === 2);
} finally {
  await browser.close();
}

console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failures ===`);
process.exit(failures ? 1 : 0);

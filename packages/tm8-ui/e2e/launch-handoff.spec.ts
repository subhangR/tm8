/**
 * THE LAUNCH HAND-OFF, LIVE (task 01a182d2) — on a dev slot, pressing Launch
 * lands on the launching page within 200 ms, and that same tab becomes the
 * live session: no second navigation, no second tab. A launch the node fails
 * stays on the page with the node's words, Edit and retry, and Dismiss.
 *
 * LIVE ONLY. It drives a real node and a real UI, so it runs when pointed at
 * them and skips otherwise (the unit suites carry the logic in CI):
 *   TM8_E2E_LIVE_URL      the UI — a production build (`vite build`, then
 *                         `vite preview --config vite.preview.config.ts` with
 *                         TM8_UI_PORT / TM8_SERVER_ORIGIN set): the 200 ms
 *                         budget is a production one, not React's dev build's
 *   TM8_E2E_LIVE_SERVER   the node, to seed the task the launch is about
 *   TM8_E2E_LIVE_SPACE    the space to launch in
 *   TM8_E2E_LIVE_STORAGE  a signed-in storage state for the UI
 *   TM8_E2E_LIVE_FAILING  1 when the node's agent CLI is missing on purpose
 *                         (TM8_AGENT_CMD naming no binary): runs the failure
 *                         case instead of the live one
 *   TM8_E2E_LAUNCH_BUDGET_MS  the press → page budget, 200 by default
 * The node runs with TM8_AGENT_CMD=echo-agent for the live case, so a launch
 * boots without credentials.
 *
 *   bunx playwright test -c e2e/launch-handoff.config.ts --workers=1
 */
import { expect, test, type Page } from '@playwright/test';

const UI = process.env.TM8_E2E_LIVE_URL;
const SERVER = process.env.TM8_E2E_LIVE_SERVER;
const SPACE = process.env.TM8_E2E_LIVE_SPACE;
const FAILING = process.env.TM8_E2E_LIVE_FAILING === '1';
/**
 * The press → page budget. 200 ms is the product's; on a shared node far past
 * its core count the same production bundle measures slower, so a slot may
 * raise it — the measured figure is printed either way.
 */
const BUDGET_MS = Number(process.env.TM8_E2E_LAUNCH_BUDGET_MS ?? 200);

test.skip(!UI || !SERVER || !SPACE, 'a live dev-slot check: set TM8_E2E_LIVE_URL, _SERVER, _SPACE and _STORAGE');

/** The task the launch is about, made fresh so every run starts from the same place. */
async function seedTask(title: string): Promise<void> {
  const res = await fetch(`${SERVER}/v2/entities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spaceId: SPACE, kind: 'task', title, clientMutationId: `e2e-launch-${Date.now()}` }),
  });
  expect(res.ok).toBe(true);
}

/** Work, the task's tab, and its Run popup. */
async function openRunPopup(page: Page, title: string): Promise<void> {
  await page.goto(`${UI}/#/s/${SPACE}/work`);
  const later = page.getByRole('button', { name: 'Later' });
  if (await later.waitFor({ timeout: 8_000 }).then(() => true, () => false)) await later.click();
  const row = page.getByText(title, { exact: true }).first();
  if (!(await row.waitFor({ timeout: 20_000 }).then(() => true, () => false))) {
    await page.reload();
    await row.waitFor({ timeout: 30_000 });
  }
  await row.click();
  await page.getByRole('button', { name: /^Run\b/ }).first().click();
  await expect(page.getByTestId('nsx-send')).toBeVisible();
}

/**
 * Press Launch and return press → page in ms, measured IN the page (pointerdown
 * of the committing press to the page's first DOM appearance), so the driver's
 * own latency on a loaded node is not counted. Until lane A's one-press card
 * lands, the preview's confirm is the committing press.
 */
async function pressLaunch(page: Page): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __launch: { presses: number[]; shown: number | null } };
    w.__launch = { presses: [], shown: null };
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-testid="nsx-send"],[data-testid="lcd3-preview-confirm"]')
        : null;
      if (target) w.__launch.presses.push(performance.now());
    }, true);
    new MutationObserver(() => {
      if (w.__launch.shown === null && document.querySelector('[data-testid="session-launching"]')) {
        w.__launch.shown = performance.now();
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId('nsx-send').click();
  const confirm = page.getByTestId('lcd3-preview-confirm');
  if (await confirm.waitFor({ timeout: 1_500 }).then(() => true, () => false)) await confirm.click();
  await expect(page.getByTestId('session-launching')).toBeVisible();
  return page.evaluate(() => {
    const { presses, shown } = (window as unknown as { __launch: { presses: number[]; shown: number | null } }).__launch;
    return (shown ?? Number.POSITIVE_INFINITY) - (presses.at(-1) ?? 0);
  });
}

const activeTabId = (page: Page) => page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('data-tab-id');

test('Launch lands on the launching page at once, and that tab becomes the live session', async ({ page }) => {
  test.skip(FAILING, 'the node is set up to fail launches');
  const title = `Hand-off ${new Date().toISOString()}`;
  await seedTask(title);
  await openRunPopup(page, title);
  const historyBefore = await page.evaluate(() => history.length);

  const pressToPage = await pressLaunch(page);
  console.log(`press → launching page: ${pressToPage.toFixed(1)} ms`);
  expect(pressToPage).toBeLessThan(BUDGET_MS);
  /* The popup is gone; the page names the launch. */
  await expect(page.getByTestId('nsx-send')).toBeHidden();
  await expect(page.getByTestId('session-launching')).toContainText(title);
  const launchTab = await activeTabId(page);
  const tabCount = await page.locator('[role="tab"][data-tab-id]').count();

  /* The node answers and the session comes up: the SAME tab now shows it. */
  await expect(page.getByTestId('session-launching')).toBeHidden({ timeout: 90_000 });
  await expect(page.getByTestId('work-session-content')).not.toHaveAttribute('data-surface', 'launching');
  expect(await activeTabId(page)).toBe(launchTab);
  expect(await page.locator('[role="tab"][data-tab-id]').count()).toBe(tabCount);
  /* One navigation for the whole launch: the swap wrote no history entry. */
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(historyBefore + 1);
});

test('a launch the node fails stays on the page with its words, Edit and retry, and Dismiss', async ({ page }) => {
  test.skip(!FAILING, 'needs a node whose agent CLI is missing (TM8_E2E_LIVE_FAILING=1)');
  const title = `Hand-off failure ${new Date().toISOString()}`;
  await seedTask(title);
  await openRunPopup(page, title);
  await page.getByTestId('lcd3-notes').click();
  await page.keyboard.type('Keep the change small.');

  const pressToPage = await pressLaunch(page);
  console.log(`press → launching page: ${pressToPage.toFixed(1)} ms`);
  expect(pressToPage).toBeLessThan(BUDGET_MS);
  const failure = page.getByTestId('session-launching-failure');
  await expect(failure).toBeVisible({ timeout: 90_000 });
  await expect(failure).toContainText('was not found');
  await expect(page.getByTestId('session-launching-phase-admitted')).toHaveAttribute('data-mark', 'failed');

  /* Edit and retry: the full popup again, on the same subject, notes kept. */
  await page.getByTestId('session-launching-retry').click();
  await expect(page.getByTestId('lcd3-notes')).toHaveValue('Keep the change small.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nsx-send')).toBeHidden();

  /* Dismiss: the launch's tab goes. */
  const tabCount = await page.locator('[role="tab"][data-tab-id]').count();
  await page.getByTestId('session-launching-dismiss').click();
  await expect(page.getByTestId('session-launching')).toBeHidden();
  expect(await page.locator('[role="tab"][data-tab-id]').count()).toBe(tabCount - 1);
});

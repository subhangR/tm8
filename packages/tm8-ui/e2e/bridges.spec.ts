import { devices, expect, test, type Page } from '@playwright/test';

/*
 * Settings → Bridges and the bridge panel (BRIDGE-ENTITY-DESIGN §4.2, §4.4;
 * BRIDGES-V2-DESIGN §1). The fixture seam seeds three bridges: Infra (live
 * WhatsApp group), #deploys (paused Slack channel) and Rahul (degraded DM).
 */
const SETTINGS = '/e2e/admin-pages-harness.html#/s/sp-atelier/settings/bridges';

async function openSettings(page: Page) {
  await page.goto(SETTINGS);
  await expect(page.getByTestId('bridges-table')).toBeVisible({ timeout: 60_000 });
}

const ENTITY = (id: string) => `/e2e/admin-pages-harness.html#/s/sp-atelier/e/${id}`;

async function openBridge(page: Page, id: string) {
  await page.goto(ENTITY(id));
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
}
const openInfra = (page: Page) => openBridge(page, 'ent-bridge-infra');

test('Settings → Bridges lists accounts and bridges, status in colour and word', async ({ page }, info) => {
  await openSettings(page);
  await expect(page.getByText('Accounts & secrets')).toBeVisible();
  await expect(page.getByTestId('bridge-row-ent-bridge-rahul')).toContainText('degraded');
  await page.screenshot({ path: info.outputPath('01-settings-bridges.png') });

  await page.getByRole('button', { name: 'More for Infra' }).click();
  await page.screenshot({ path: info.outputPath('02-settings-row-menu.png') });
  await page.getByRole('menuitem', { name: 'Remove Infra…' }).click();
  await page.getByLabel('Type Infra to confirm').fill('Infra');
  await page.screenshot({ path: info.outputPath('03-remove-confirm.png') });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'More for Infra' }).click();
  await page.getByRole('menuitem', { name: 'Pause Infra' }).click();
  await expect(page.getByTestId('bridges-notice')).toContainText('Messages are still logged');
  await page.screenshot({ path: info.outputPath('04-settings-after-pause.png') });
  // Opening a row opens the bridge in Work (review #1445 r1: `bridge` was
  // missing from WORKSPACE_KINDS, so this opened nothing).
  await page.getByRole('button', { name: 'Open Infra bridge' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('05-opened-from-settings.png') });
});

test('the bridge panel: header, and each tab', async ({ page }, info) => {
  await openInfra(page);
  await expect(page.getByTestId('bridge-conversation')).toContainText('@tm8 is the deploy done?');
  await page.screenshot({ path: info.outputPath('10-panel-conversation.png') });

  await page.getByRole('button', { name: /^Status: live/ }).click();
  await page.screenshot({ path: info.outputPath('11-panel-status-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More for Infra' }).last().click();
  await page.screenshot({ path: info.outputPath('12-panel-more-menu.png') });
  await page.mouse.click(5, 5);

  for (const [tab, testId, n] of [
    ['People', 'bridge-people', '13'],
    ['Routing', 'bridge-routing', '14'],
    ['Memory', 'bridge-memory', '16'],
    ['Loops', 'bridge-loops', '17'],
    ['Health', 'bridge-health', '18'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByTestId(testId)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${n}-panel-${tab.toLowerCase()}.png`), fullPage: true });
  }

  await page.getByRole('tab', { name: 'Routing' }).click();
  await page.getByLabel(/^Anyone in the group/).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('bridge-consequences')).toContainText('not linked, will be able to start agents');
  await page.screenshot({ path: info.outputPath('15-routing-consequence-confirm.png') });
});

test('a degraded bridge says why on Health', async ({ page }, info) => {
  await openBridge(page, 'ent-bridge-rahul');
  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.getByTestId('bridge-health')).toContainText('The runtime has not checked in');
  await page.screenshot({ path: info.outputPath('19-degraded-health.png') });
});

test('Settings → Bridges at 900×600: no horizontal page scroll', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openSettings(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('20-settings-900x600.png') });
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });
  test('Settings → Bridges, Routing and the §1.5 confirm in dark', async ({ page }, info) => {
    await page.addInitScript(() => window.localStorage.setItem('tm8ui.theme', 'dark'));
    await openSettings(page);
    await page.screenshot({ path: info.outputPath('30-dark-settings.png') });
    await openInfra(page);
    await page.getByRole('tab', { name: 'Routing' }).click();
    await page.screenshot({ path: info.outputPath('31-dark-routing.png') });
    await page.getByLabel(/^Anyone in the group/).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('bridge-consequences')).toBeVisible();
    await page.screenshot({ path: info.outputPath('32-dark-consequence.png') });
  });
});

test.describe('phone shell', () => {
  // A coarse pointer under 500px selects the mobile shell (mobile/shell-for.ts).
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 5'];
  test.use(pixel);
  test('Settings → Bridges and the bridge panel on a phone', async ({ page }, info) => {
    await page.goto(SETTINGS);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: info.outputPath('40-phone-settings.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId('bridges-table').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('41-phone-settings-table.png') });
    // §4.1 Mobile (01a18c2b-a0fe): the phone page of a bridge is the bridge page.
    await page.goto(`/e2e/admin-pages-harness.html#/s/sp-atelier/e/ent-bridge-infra`);
    await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('42-phone-bridge-page.png') });
    await page.getByRole('tab', { name: 'Routing' }).click();
    await page.screenshot({ path: info.outputPath('43-phone-bridge-routing.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Health' }).click();
    await page.screenshot({ path: info.outputPath('44-phone-bridge-health.png') });
    // The phone page carries the loops client (#1448 after #1470): the Loops tab is the live one.
    await page.getByRole('tab', { name: 'Loops' }).click();
    await expect(page.getByTestId('bridge-loops').getByRole('button', { name: 'Stand-up nudge', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('46-phone-bridge-loops.png'), fullPage: true });
    await page.getByRole('tab', { name: 'People' }).click();
    await page.screenshot({ path: info.outputPath('47-phone-bridge-people.png'), fullPage: true });
    await page.getByRole('button', { name: /^Status: live/ }).click();
    await page.screenshot({ path: info.outputPath('45-phone-status-menu.png') });
  });
});

test('Loops tab: the loops that post here, their words, a new loop here', async ({ page }, info) => {
  await openInfra(page);
  await page.getByRole('tab', { name: 'Loops' }).click();
  const tab = page.getByTestId('bridge-loops');
  await expect(tab.getByRole('button', { name: 'Stand-up nudge', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('70-loops-tab.png') });
  await page.getByRole('button', { name: 'Run Stand-up nudge now' }).click();
  await expect(tab.getByText(/Last run here: posted/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('71-loops-after-run.png') });
  await page.getByRole('button', { name: 'Edit what Stand-up nudge says here' }).click();
  await page.screenshot({ path: info.outputPath('72-loops-edit-text.png') });
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await page.getByRole('button', { name: '+ New loop here' }).click();
  await page.getByLabel('Loop name').fill('Friday wrap-up');
  await page.getByLabel('Schedule').fill('every friday at 17:00');
  await page.getByLabel('What it posts in Infra').fill("It's Friday: post one thing you shipped this week.");
  await expect(page.getByTestId('bridge-new-loop-preview')).toContainText('every friday');
  await page.screenshot({ path: info.outputPath('73-loops-new-loop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create loop' }).click();
  await expect(tab.getByRole('button', { name: 'Friday wrap-up', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('74-loops-created.png'), fullPage: true });
});

test('Conversation opens on the newest page and scrolls back (#1446)', async ({ page }, info) => {
  await openInfra(page);
  const conv = page.getByTestId('bridge-conversation');
  await expect(conv.getByText('nice, ship the changelog too')).toBeVisible();
  await expect(conv.getByText('@tm8 is the deploy done?')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('75-conversation-newest.png') });
  await conv.getByTestId('bridge-conversation-older').click();
  await expect(conv.getByText('@tm8 is the deploy done?')).toBeVisible();
  await expect(conv.getByTestId('bridge-conversation-start')).toBeVisible();
  await page.screenshot({ path: info.outputPath('76-conversation-scrolled-back.png') });
});

test('PR2: the add-bridge wizard, step by step', async ({ page }, info) => {
  await openSettings(page);
  await expect(page.getByTestId('connection-0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494')).toBeVisible();
  await page.screenshot({ path: info.outputPath('50-settings-my-accounts.png') });
  await page.getByTestId('bridges-add').click();
  await expect(page.getByTestId('wizard-step-connection')).toBeVisible();
  await page.screenshot({ path: info.outputPath('51-wizard-1-connection.png') });
  await page.getByRole('button', { name: 'Use Ada · work phone' }).click();
  await expect(page.getByRole('option', { name: /Gaming/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('52-wizard-2-conversation.png') });
  await page.getByRole('option', { name: /Gaming/ }).click();
  await page.getByRole('button', { name: 'Next: where it lands' }).click();
  await expect(page.getByTestId('wizard-step-target')).toBeVisible();
  await page.getByRole('combobox', { name: 'Target', exact: true }).selectOption({ label: 'Plan the launch sequence' });
  await page.screenshot({ path: info.outputPath('53-wizard-3-target.png') });
  await page.getByLabel(/^Anyone in the group/).check();
  await page.getByRole('button', { name: 'Create bridge' }).click();
  await expect(page.getByTestId('bridge-consequences')).toBeVisible();
  await page.screenshot({ path: info.outputPath('54-wizard-3-confirm.png') });
  await page.getByRole('button', { name: 'Yes, create it' }).click();
  await expect(page.getByTestId('wizard-step-test')).toBeVisible();
  await page.screenshot({ path: info.outputPath('55-wizard-4-test.png') });
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('56-wizard-finished-opens-bridge.png') });
});

test('PR2: linking a number — QR and pairing code', async ({ page }, info) => {
  await openSettings(page);
  await page.getByRole('button', { name: '+ Link a new account' }).click();
  await expect(page.getByTestId('bridge-link-number')).toBeVisible();
  await page.screenshot({ path: info.outputPath('60-link-choose.png') });
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  await expect(page.getByAltText('WhatsApp link QR code')).toBeVisible();
  await page.screenshot({ path: info.outputPath('61-link-qr.png') });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: '+ Link a new account' }).click();
  await page.getByLabel(/^This phone/).check();
  await page.getByLabel('Phone number').fill('+91 98000 00094');
  await page.getByRole('button', { name: 'Get a code' }).click();
  await expect(page.getByTestId('bridge-link-code')).toHaveText('K7Q2-9MXD');
  await page.screenshot({ path: info.outputPath('62-link-pairing-code.png') });
});

test('PR2: the account menu, and the wizard in dark', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => window.localStorage.setItem('tm8ui.theme', 'dark'));
  await openSettings(page);
  await page.getByRole('button', { name: 'More for Ada · work phone' }).click();
  await page.screenshot({ path: info.outputPath('63-account-menu-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('bridges-add').click();
  await page.getByRole('button', { name: 'Use Ada · work phone' }).click();
  await expect(page.getByRole('option', { name: /Family/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('64-wizard-2-dark.png') });
});

test('hand-over: offer from ⋯, the banner, accept after one more ask', async ({ page }, info) => {
  await openInfra(page);
  await page.getByRole('button', { name: 'More for Infra' }).last().click();
  await page.screenshot({ path: info.outputPath('60-handover-menu.png') });
  await page.getByRole('menuitem', { name: 'Hand over to another number…' }).click();
  const dialog = page.getByRole('dialog', { name: /Hand over the .* bridge/ });
  await expect(dialog.getByRole('radio', { name: /Ada · personal/ })).toBeChecked();
  await page.screenshot({ path: info.outputPath('61-handover-offer-dialog.png') });
  await dialog.getByRole('radio', { name: 'Another member’s number' }).check();
  await dialog.getByRole('textbox', { name: 'Their connection id' }).fill('bo');
  await page.screenshot({ path: info.outputPath('62-handover-paste-id.png') });
  await dialog.getByRole('radio', { name: /Ada · personal/ }).check();
  await dialog.getByRole('button', { name: 'Offer hand-over' }).click();
  const banner = page.getByTestId('bridge-handover');
  await expect(banner).toContainText('it would move onto your number Ada · personal');
  await page.screenshot({ path: info.outputPath('63-handover-banner.png') });
  await banner.getByRole('button', { name: 'Accept…' }).click();
  await page.screenshot({ path: info.outputPath('64-handover-accept-ask.png') });
  await banner.getByRole('button', { name: 'Move it' }).click();
  await expect(page.getByText('Handed over. The bridge now rides your number.')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('65-handover-done.png') });
});

/*
 * ---------------------------------------------------------------------------
 * SLACK (Slack bridge design §1.1–1.3): the token connection, the channel
 * picker, thread mode and View in Slack — in a real browser, because jsdom
 * cannot see that a dialog's state block fits, that the lock sits beside the
 * #name, or that the Slack mark is actually tinted.
 *
 *   bunx playwright test -c e2e/bridges.config.ts -g Slack
 * ---------------------------------------------------------------------------
 */

/* The fixture's tokens: they must match the contract's structural regexes. */
/*
 * The tokens in this file are deliberately unrealistic — short, with zero
 * digit groups and a NOTAREAL… body. They still satisfy the contract's
 * regexes, which is all the code under test reads, and they do not look
 * enough like real Slack tokens to trip GitHub's secret scanning (which
 * blocked a push of this branch when they did).
 */
const SLACK_BOT = 'xoxb-0-0-NOTAREALBOTTOKEN';
const SLACK_APP = 'xapp-0-A0-0-NOTAREALAPPTOKEN';
const SLACK_CONNECTION = '5d3e8a10-2f4b-4c7e-8a9d-0c1f2e3d4a5b';

async function openSlackTokenDialog(page: Page) {
  await openSettings(page);
  await page.getByTestId('bridges-add-account').click();
  await page.getByRole('menuitem', { name: /Slack workspace/ }).click();
  await expect(page.getByTestId('bridge-slack-tokens')).toBeVisible();
}

test('Slack: the connection row names the workspace auth.test answered', async ({ page }, info) => {
  await openSettings(page);
  const row = page.getByTestId(`connection-${SLACK_CONNECTION}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`connection-account-${SLACK_CONNECTION}`))
    .toContainText('Connected to Acme · Acme Corp (acme.enterprise.slack.com) as @tm8');
  await page.screenshot({ path: info.outputPath('80-slack-connection-row.png') });

  // The rotation door says pasting, not re-linking a device.
  await page.getByRole('button', { name: 'More for Acme Slack' }).click();
  await expect(page.getByRole('menuitem', { name: /Paste new tokens for Acme Slack/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('81-slack-row-menu.png') });
});

test('Slack: the token form refuses a bad pair locally, then connects', async ({ page }, info) => {
  await openSlackTokenDialog(page);
  await page.screenshot({ path: info.outputPath('82-slack-token-form.png') });

  // Both inputs are secrets, and nothing will autofill them.
  for (const label of ['Bot token', 'App-level token']) {
    await expect(page.getByLabel(label)).toHaveAttribute('type', 'password');
    await expect(page.getByLabel(label)).toHaveAttribute('autocomplete', 'off');
  }

  // The pair the other way round: refused here, named, never sent.
  await page.getByLabel('Bot token').fill(SLACK_APP);
  await page.getByLabel('App-level token').fill(SLACK_BOT);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('slack-token-problem')).toContainText('other way round');
  await page.screenshot({ path: info.outputPath('83-slack-token-swapped.png') });

  // The real pair: the runtime's auth.test answer comes back as the account.
  await page.getByLabel('Bot token').fill(SLACK_BOT);
  await page.getByLabel('App-level token').fill(SLACK_APP);
  await page.getByLabel('Workspace label').fill('Acme Slack 2');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('slack-connected')).toContainText('Connected to Acme');
  // The hard rule, in a real browser: neither token is anywhere on the page.
  expect(await page.content()).not.toContain(SLACK_BOT);
  expect(await page.content()).not.toContain(SLACK_APP);
  expect(await page.inputValue('input[aria-label="Bot token"]')).toBe('');
  await page.screenshot({ path: info.outputPath('84-slack-connected.png') });
});

test('Slack: a refused token says what to do about it', async ({ page }, info) => {
  await openSlackTokenDialog(page);
  await page.getByLabel('Bot token').fill('xoxb-0-0-invalid');
  await page.getByLabel('App-level token').fill(SLACK_APP);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('slack-refused')).toContainText('revoked, rotated or copied');
  await page.screenshot({ path: info.outputPath('85-slack-refused.png') });
});

test('Slack: a thin install names the scopes it is missing', async ({ page }, info) => {
  await openSlackTokenDialog(page);
  await page.getByLabel('Bot token').fill('xoxb-0-0-noscope');
  await page.getByLabel('App-level token').fill(SLACK_APP);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('slack-missing-scopes')).toContainText('chat:write.customize');
  await page.screenshot({ path: info.outputPath('86-slack-missing-scopes.png'), fullPage: true });
});

test('Slack: the channel picker, thread mode, and the every-message confirm', async ({ page }, info) => {
  await openSettings(page);
  await page.getByTestId('bridges-add').click();
  await expect(page.getByTestId('wizard-step-connection')).toBeVisible();
  await page.screenshot({ path: info.outputPath('87-wizard-1-two-providers.png') });

  await page.getByRole('button', { name: 'Use Acme Slack' }).click();
  await expect(page.getByRole('option', { name: /#eng-support/ })).toBeVisible();
  // #name, a lock on the private channel, and Slack's own words for read-only.
  await expect(page.getByRole('option', { name: /#incidents/ })).toContainText('#incidents');
  await expect(page.getByRole('option', { name: /#announcements/ })).toContainText('/invite @tm8 there first');
  await page.screenshot({ path: info.outputPath('88-wizard-2-channels.png'), fullPage: true });

  await page.getByRole('option', { name: /#eng-support/ }).click();
  await page.getByRole('button', { name: 'Next: where it lands' }).click();
  await expect(page.getByTestId('wizard-step-target')).toBeVisible();
  await page.getByRole('combobox', { name: 'Target', exact: true }).selectOption({ label: 'Plan the launch sequence' });
  await expect(page.getByTestId('bridge-thread-mode')).toBeVisible();
  // Slack has no reply-signature switch: every reply carries its own voice.
  await expect(page.getByTestId('wizard-voice-note')).toBeVisible();
  await expect(page.getByText('How replies are signed')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('89-wizard-3-thread-mode.png'), fullPage: true });

  await page.getByLabel(/^Every message/).first().check();
  await page.getByRole('button', { name: 'Create bridge' }).click();
  await expect(page.getByTestId('bridge-consequences')).toContainText('EVERY top-level message');
  await page.screenshot({ path: info.outputPath('90-wizard-thread-confirm.png') });
  await page.getByRole('button', { name: 'Yes, create it' }).click();
  await expect(page.getByTestId('wizard-step-test')).toBeVisible();
  await expect(page.getByTestId('wizard-step-test')).toContainText('THREAD');
  await page.screenshot({ path: info.outputPath('91-wizard-4-slack-test.png') });

  // The new Slack bridge's own panel: thread mode is editable there.
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('92-slack-bridge-page.png') });
  await page.getByRole('tab', { name: 'Routing' }).click();
  await expect(page.getByTestId('bridge-thread-mode')).toBeVisible();
  await page.screenshot({ path: info.outputPath('93-slack-routing-thread-mode.png'), fullPage: true });
});

test('Slack: View in Slack opens the channel', async ({ page }, info) => {
  await openBridge(page, 'ent-bridge-deploys');
  const link = page.getByTestId('slack-channel-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://acme.enterprise.slack.com/archives/C04DEPLOYS');
  await expect(link).toHaveAttribute('target', '_blank');
  await page.screenshot({ path: info.outputPath('94-slack-view-in-slack.png') });
});

test.describe('Slack in dark theme', () => {
  test.use({ colorScheme: 'dark' });
  test('Slack: the token dialog and the channel picker in dark', async ({ page }, info) => {
    await page.addInitScript(() => window.localStorage.setItem('tm8ui.theme', 'dark'));
    await openSlackTokenDialog(page);
    await page.screenshot({ path: info.outputPath('95-dark-slack-token-form.png') });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('bridges-add').click();
    await page.getByRole('button', { name: 'Use Acme Slack' }).click();
    await expect(page.getByRole('option', { name: /#incidents/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath('96-dark-slack-channels.png'), fullPage: true });
  });
});

test('Slack: the token dialog at 900×600 does not scroll the page sideways', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openSlackTokenDialog(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('97-slack-token-form-900x600.png') });
});

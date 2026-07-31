import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const RAW_PROVIDER_PROSE = 'RAW_PROVIDER_ONLY: native Claude/Codex PTY prose';

test('profile projection controls availability and route preference precedence', async ({ page }) => {
  await page.goto('/e2e/m7-harness.html?scenario=profiles');

  const noProfile = page.getByTestId('profile-none');
  await expect(noProfile.getByText('native terminal')).toBeVisible();
  await expect(noProfile.getByRole('tab', { name: 'Chat' })).toHaveCount(0);

  const explicit = page.getByTestId('profile-explicit');
  await expect(explicit.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(explicit.getByRole('tab', { name: 'Chat' })).toBeVisible();

  const profileDefault = page.getByTestId('profile-default');
  await expect(profileDefault.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');

  const saved = page.getByTestId('profile-saved');
  await expect(saved.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');

  const unknown = page.getByTestId('profile-unknown');
  await expect(unknown.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(unknown.getByText(/newer interaction template/i)).toBeVisible();
});

async function openSurface(page: import('@playwright/test').Page): Promise<void> {
  const replay = Buffer.from(`${RAW_PROVIDER_PROSE}\r\nstream frame 2\r\n`);
  await page.routeWebSocket(/\/v2\/ws\?/, (socket) => {
    socket.send(JSON.stringify({
      type: 'attached',
      base: 0,
      gap: 0,
      next: replay.byteLength,
      hasReplay: true,
      epoch: 'm7-fake-pty-1',
    }));
    socket.send(replay);
  });
  await page.goto('/e2e/m7-harness.html?scenario=surface');
}

test('retains the real terminal instance, PTY output, Chat draft, and scroll across surface switches', async ({ page }) => {
  await openSurface(page);

  const terminal = page.getByTestId('terminal-instance');
  await expect(terminal).toContainText(RAW_PROVIDER_PROSE);
  const instance = await terminal.getAttribute('data-instance');

  await page.getByRole('tab', { name: 'Chat' }).click();
  const composer = page.getByLabel('Message this session');
  await expect(composer).toBeVisible();
  await composer.fill('draft survives a provider-neutral surface switch');

  const history = page.getByRole('region', { name: 'Chat history' });
  const scroll = await history.evaluate((element) => {
    if (element.scrollHeight <= element.clientHeight) throw new Error('M7 history fixture must overflow');
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(terminal).toHaveAttribute('data-instance', instance!);
  await expect(terminal).toContainText(RAW_PROVIDER_PROSE);

  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(composer).toHaveValue('draft survives a provider-neutral surface switch');
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(scroll);
  await expect(history).not.toContainText(RAW_PROVIDER_PROSE);
});

test('shows stored-first truth, canonical attachments and mentions, all delivery facets, and persona reply', async ({ page }) => {
  await openSurface(page);
  await page.getByRole('tab', { name: 'Chat' }).click();

  const composer = page.getByLabel('Message this session');
  await composer.fill('Stored-first browser message');
  await page.getByRole('button', { name: 'Mention someone' }).click();
  await page.getByRole('option', { name: /forge/i }).click();
  await page.getByLabel('Choose files to attach').setInputFiles({
    name: 'e2e-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('canonical attachment bytes'),
  });
  await expect(page.getByText('✓ uploaded')).toBeVisible();

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const pending = page.locator('article').filter({
    has: page.locator('.chs-text').filter({ hasText: /^Stored-first browser message/ }),
  });
  await expect(pending).toContainText('saving…');

  await page.getByRole('button', { name: 'Commit stored message' }).click();
  await expect(pending).not.toContainText('saving…');
  await expect(pending.getByRole('button', { name: /open mention forge/i })).toBeVisible();
  await expect(pending.getByRole('button', { name: /open attachment e2e-note\.txt/i })).toBeVisible();

  await pending.getByRole('button', { name: /delivery · 1 of 8 delivered/i }).click();
  await expect(pending.locator('[data-delivery-status]')).toHaveCount(8);
  await expect(pending).toContainText('delivery unknown');
  await expect(pending).toContainText('The target session is no longer live');

  await page.getByRole('button', { name: 'Agent reply through tm8' }).click();
  const reply = page.locator('article').filter({ hasText: 'Persona reply through tm8 message reply' });
  await expect(reply).toContainText('forge');
  await expect(reply).toContainText('in reply to');
  await reply.getByRole('button', { name: 'Focus parent message' }).click();
  await expect(pending).toBeFocused();

  await expect(page.getByRole('region', { name: 'Chat history' })).not.toContainText(RAW_PROVIDER_PROSE);
});

test('renders edited reply references, explicit redaction, and artifact focus without leaking tombstoned content', async ({ page }) => {
  await page.goto('/e2e/m7-harness.html?scenario=presentation');

  const history = page.getByRole('region', { name: 'Chat history' });
  await expect(history.getByTestId('chs-tombstone')).toBeVisible();
  await expect(history).not.toContainText('M7_SECRET_BODY_MUST_NOT_RENDER');
  await expect(history).not.toContainText('M7_SECRET_MENTION');
  await expect(history).not.toContainText('M7_SECRET_FILE.txt');

  const reply = page.locator('[data-feed-message-id="m7-rich-reply"]');
  await expect(reply).toContainText('edited');
  await expect(reply.getByRole('button', { name: /open mention forge/i })).toBeVisible();
  await expect(reply.getByRole('button', { name: /open attachment browser-proof\.txt/i })).toBeVisible();
  await reply.getByRole('button', { name: 'Focus parent message' }).click();
  await expect(page.locator('[data-feed-message-id="m7-parent-message"]')).toBeFocused();

  const artifact = history.getByTestId('chs-artifact');
  await expect(artifact).toContainText('Layout spec');
  await artifact.getByRole('button', { name: /open layout spec/i }).click();
  await expect(page.getByTestId('m7-opened-entity')).toHaveText('doc-layout-spec');
});

test('recovers from invalid cursors and reconnect snapshots, preserves drafts, and stores in an exited session', async ({ page }) => {
  await openSurface(page);
  await page.getByRole('tab', { name: 'Chat' }).click();

  const composer = page.getByLabel('Message this session');
  await composer.fill('draft survives recovery');
  await page.getByRole('button', { name: /load earlier/i }).click();
  await expect(page.getByTestId('chs-refreshed')).toContainText('cursor expired');
  await expect(composer).toHaveValue('draft survives recovery');

  await page.getByRole('button', { name: 'Disconnect events' }).click();
  await expect(page.getByText('Chat is reconnecting. Cached history remains available.')).toBeAttached();
  await page.getByRole('button', { name: 'Reconnect events' }).click();
  await expect(page.getByText('Chat is connected.')).toBeAttached();
  await page.getByRole('button', { name: 'Force snapshot recovery' }).click();
  await expect(page.getByTestId('chs-refreshed')).toBeVisible();
  await expect(composer).toHaveValue('draft survives recovery');

  await page.getByRole('button', { name: 'Mark session exited' }).click();
  await expect(page.getByTestId('chs-exited')).toContainText('Send stores the message');
  await composer.fill('stored after exit without waking the agent');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('article').filter({ hasText: 'stored after exit without waking the agent' })).toBeVisible();
});

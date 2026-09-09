// Use the disposable browser-fixture backend, never the user's database.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.TM8_BROWSER_LIBRARY ?? 'playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.TM8_CHROME_EXECUTABLE });
const context = await browser.newContext();
const page = await context.newPage();
let output = '', input = '', phase = 'GitHub fixture sign-in';
page.on('websocket', socket => {
  if (!socket.url().includes('/workspaces/terminals/')) return;
  socket.on('framereceived', frame => { output += frame.payload.toString(); });
  socket.on('framesent', frame => { try { const data = JSON.parse(frame.payload.toString()); if (data.type === 'input') input += data.data; } catch {} });
});
try {
  await page.route('https://github.com/login/oauth/authorize?**', async route => {
    const url = new URL(route.request().url()), callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }).toString();
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.goto('http://127.0.0.1:4629');
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'My workspace', exact: true }).waitFor();
  phase = 'prepare private workspace and space';
  await page.evaluate(async () => {
    const request = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-TM8-Client': 'tm8-ui' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Fixture setup failed (${response.status})`);
    };
    await request('/v2/workspaces/me/ensure', {});
    await request('/v2/spaces', { name: 'Provider browser acceptance', clientMutationId: crypto.randomUUID() });
  });
  await page.reload();
  const setup = page.getByTestId('credentials-setup-dialog');
  await setup.waitFor();
  phase = 'guided Codex connection';
  await page.getByTestId('cset-start').click();
  output = '';
  await page.getByTestId('cset-connect-openai').click();
  await page.getByLabel('Codex login terminal', { exact: true }).waitFor();
  const deadline = Date.now() + 35000;
  while (!output.includes('auth.openai.com/codex/device') && Date.now() < deadline) await page.waitForTimeout(100);
  assert.ok(output.includes('auth.openai.com/codex/device'), 'Codex device URL must reach the browser terminal');
  await page.getByTestId('cset-cancel').click();
  await page.getByTestId('cset-connect-openai').waitFor();
  await page.getByTestId('cset-x').click();
  console.log('PASS: Agent tools opens the real Codex device prompt and cancellation finishes the server login');
  phase = 'Settings navigation';
  await page.getByText('Settings', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Agent credentials', exact: true }).click();
  for (const provider of ['anthropic', 'openai']) {
    phase = `Settings ${provider} connection`;
    await page.getByTestId(`credential-connect-${provider}`).waitFor();
    output = '';
    await page.getByTestId(`credential-connect-${provider}`).click();
    await page.getByTestId('credential-login-terminal').waitFor();
    const expected = provider === 'anthropic' ? 'claude.com/cai/oauth/authorize' : 'auth.openai.com/codex/device';
    const deadline = Date.now() + 35000;
    while (!output.includes(expected) && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(output.includes(expected), `${provider} authorization URL must reach the Settings terminal`);
    if (provider === 'anthropic') {
      const terminal = page.getByTestId('credential-login-terminal').locator('.xterm-helper-textarea');
      input = '';
      await terminal.focus(); await page.keyboard.type('tm8-browser-input-check');
      await page.waitForTimeout(300);
      assert.ok(input.includes('tm8-browser-input-check'), 'The Claude terminal forwards keyboard input');
      await page.keyboard.press('Control+u');
    }
    await page.getByTestId('credential-finish-login').click();
    await page.getByTestId('credential-outcome-finish').waitFor();
    assert.equal(await page.getByTestId(`credential-verdict-${provider}`).innerText(), 'Not connected');
    console.log(`PASS: Settings ${provider} login renders real provider output and incomplete login stays disconnected`);
  }
} catch (error) {
  console.error('Browser verification failed during '+phase);
  console.error((await page.locator('body').innerText()).replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]').slice(-2400));
  throw new Error(phase+' failed: '+error.name);
} finally { await browser.close(); }

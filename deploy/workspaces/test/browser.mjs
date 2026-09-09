import assert from 'node:assert/strict';
const { chromium } = await import(process.env.TM8_BROWSER_LIBRARY ?? 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.TM8_CHROME_EXECUTABLE ? { executablePath: process.env.TM8_CHROME_EXECUTABLE } : {}) });
const context = await browser.newContext();
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
let terminalOutput = '';
page.on('websocket', socket => { if (socket.url().includes('/workspaces/terminals/')) socket.on('framereceived', frame => { terminalOutput += frame.payload.toString(); }); });
try {
  await page.route('https://github.com/login/oauth/authorize?**', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }).toString();
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.goto('http://127.0.0.1:4629');
  await page.getByRole('heading', { name: 'Sign in or sign up' }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  const panel = page.getByRole('region', { name: 'My workspace' });
  try { await panel.waitFor({ state: 'visible', timeout: 2000 }); }
  catch { await page.getByRole('button', { name: 'My workspace', exact: true }).click(); }
  await panel.waitFor({ state: 'visible' });
  const createWorkspace = panel.getByRole('button', { name: 'Create workspace', exact: true });
  if (await createWorkspace.isVisible()) await createWorkspace.click();
  await panel.getByLabel('New space', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  const spaceName = `Browser acceptance ${Date.now()}`;
  await panel.getByLabel('New space', { exact: true }).fill(spaceName);
  await panel.getByRole('button', { name: 'Create space', exact: true }).click();
  await page.waitForFunction(name => [...document.querySelectorAll('select option')].some(option => option.textContent === name), spaceName);
  await panel.getByLabel(/^Active space/).selectOption({ label: spaceName });
  await panel.getByLabel('Project name', { exact: true }).fill('Browser Git project');
  await panel.getByRole('button', { name: 'Create project', exact: true }).click();
  await panel.getByRole('button', { name: 'Save file', exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  await panel.getByLabel('File content', { exact: true }).fill('Code written through the browser into its Ubuntu workspace.\n');
  await panel.getByRole('button', { name: 'Save file', exact: true }).click();
  await panel.getByText('File saved in your private checkout', { exact: true }).waitFor();
  await panel.getByLabel('Commit message', { exact: true }).fill('Browser acceptance');
  await panel.getByRole('button', { name: 'Commit all changes', exact: true }).click();
  await panel.getByRole('button', { name: 'Push', exact: true }).click();
  await panel.getByText('push completed', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Open terminal', exact: true }).click();
  const readyDeadline = Date.now() + 10000;
  while (!terminalOutput.includes('$') && Date.now() < readyDeadline) await page.waitForTimeout(100);
  assert.ok(terminalOutput.includes('$'), 'Terminal must connect before accepting input');
  const terminal = panel.locator('.xterm-helper-textarea'); await terminal.waitFor({ state: 'attached' }); await terminal.focus();
  await page.keyboard.type("printf 'TM8_''BROWSER_EXEC_OK\\n'"); await page.keyboard.press('Enter');
  const deadline = Date.now() + 10000;
  while (!terminalOutput.includes('TM8_BROWSER_EXEC_OK') && Date.now() < deadline) await page.waitForTimeout(100);
  assert.ok(terminalOutput.includes('TM8_BROWSER_EXEC_OK'), 'Terminal executed inside the real Ubuntu runner');
  const cookies = await context.cookies();
  assert.ok(cookies.some(cookie => cookie.name === '__Host-tm8-session' && cookie.httpOnly && cookie.secure));
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('tm8s_')), false, 'Browser storage must not contain the session bearer');
  if (process.env.TM8_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.TM8_BROWSER_SCREENSHOT, fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'My workspace', exact: true }).waitFor();
  assert.equal(failures.length, 0, `Browser errors: ${failures.join(', ')}`);
  console.log('PASS: GitHub-only browser sign-in (controlled provider), HttpOnly session, private workspace, space and Git project, file save, commit/push, Ubuntu terminal and reload');
} catch (error) { console.error((await page.locator('body').innerText()).slice(0,4000)); throw error; }
finally { await browser.close(); }

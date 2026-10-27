import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Only test-owned synthetic credentials belong in this setup file. Never print it.
const setup = JSON.parse(await readFile(process.env.MCP_JOURNEY_SETUP, 'utf8'));
for (const address of [process.env.MCP_UI_URL, setup.fixtureUrl]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(address).hostname)) throw new Error('This journey only supports disposable loopback fixtures');
}
const output = process.env.MCP_JOURNEY_EVIDENCE ?? '/tmp/mcp-real-browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.MCP_CHROMIUM_PATH,
  args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu', '--disable-dev-shm-usage'] });
const checks = [], requests = [], errors = [];
const record = message => { checks.push(message); console.log(message); };
const serverName = setup.serverName ?? `browserfixture_${Date.now().toString(36)}`;
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(30000);
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/v2/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status() }); });
await page.addInitScript(value => { window.__MCP_JOURNEY__ = value; }, setup);
try {
  await page.goto(`${process.env.MCP_UI_URL}/e2e/mcp-real-harness.html`);
  await page.getByRole('button', { name: 'Add connector', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(serverName);
  await page.getByLabel('Server URL', { exact: true }).fill(setup.fixtureUrl);
  await page.getByRole('combobox', { name: /^Authentication/ }).selectOption('api_key');
  await page.getByRole('checkbox', { name: /Allow this connector to access private networks/ }).check();
  await page.getByRole('button', { name: 'Register connector', exact: true }).click();
  await page.getByRole('button', { name: `Manage ${serverName}`, exact: true }).click();
  if (await page.getByRole('button', { name: 'Approve connector', exact: true }).count()) await page.getByRole('button', { name: 'Approve connector', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add private account', exact: true })).toBeEnabled();
  record('register and approve through native adapter and facade');
  const equipment = page.getByRole('region', { name: 'Task and teammate connectors', exact: true });
  await equipment.getByRole('checkbox', { name: serverName, exact: true }).click();
  await expect(equipment.getByRole('checkbox', { name: serverName, exact: true })).toBeChecked();
  const picker = page.getByRole('group', { name: 'Connectors', exact: true });
  await expect(picker.getByRole('checkbox', { name: new RegExp(serverName) })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Launch fixture session', exact: true })).toBeDisabled();
  await picker.getByRole('link', { name: `Connect ${serverName}`, exact: true }).waitFor();
  record('missing credential blocks launch and offers connection route');
  await page.getByLabel('Account label', { exact: true }).fill(`Account ${serverName}`);
  await page.getByLabel('API key', { exact: true }).fill(setup.fixtureKey ?? 'fixture-mcp-key');
  await page.getByRole('button', { name: 'Add private account', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Private account added.' }).waitFor();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: 'Test with account', exact: true }).selectOption({ label: `Account ${serverName}` });
  await page.getByRole('button', { name: 'Test and discover tools', exact: true }).click();
  await page.getByText(setup.toolName ?? 'fixture', { exact: true }).waitFor();
  record('sealed private key creation and real upstream tool discovery');
  await picker.getByRole('button', { name: 'None', exact: true }).click();
  await picker.getByRole('checkbox', { name: new RegExp(serverName) }).check();
  await picker.getByRole('combobox', { name: `Account for ${serverName}`, exact: true }).selectOption({ label: `Account ${serverName}` });
  await expect(page.getByRole('button', { name: 'Launch fixture session', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Launch fixture session', exact: true }).click();
  await page.getByTestId('mcp-session-id').waitFor();
  const sessionId = await page.getByTestId('mcp-session-id').textContent();
  record('task equips attachment and explicit account launch through production spawn');
  await writeFile(`${output}/launched.json`, JSON.stringify({ sessionId, checks }, null, 2));
  if (!setup.evidencePath) throw new Error('Backend setup must supply the real child bridge evidencePath');
  async function bridgeResults() {
    try { return (await readFile(setup.evidencePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.sessionId === sessionId); }
    catch { return []; }
  }
  await expect.poll(async () => JSON.stringify(await bridgeResults()), { timeout: 30000 }).toContain(setup.successMarker ?? 'MCP browser fixture tool succeeded');
  record('actual launched child bridge calls fixture tool');
  const revokedAfter = new Date().toISOString();
  await page.getByRole('button', { name: 'Revoke account', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await picker.getByRole('link', { name: `Connect ${serverName}`, exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Launch fixture session', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Confirm revoke', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rotate key', exact: true })).toHaveCount(0);
  await page.getByText('Add a new private account below to reconnect.', { exact: true }).waitFor();
  await expect.poll(async () => (await bridgeResults()).some(row => row.at >= revokedAfter && (row.result?.error || row.result?.result?.isError)), { timeout: 30000 }).toBe(true);
  record('revoke invalidates browser readiness and denies running child tool calls');
  const bridge = await bridgeResults();
  if (JSON.stringify(bridge).includes(setup.fixtureKey ?? 'fixture-mcp-key')) throw new Error('Synthetic key appeared in child output');
  if (errors.length) throw new Error('Browser runtime errors');
  await page.screenshot({ path: `${output}/complete.png`, fullPage: true });
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: true,
    backendRevision: process.env.MCP_BACKEND_REVISION ?? null, uiRevision: process.env.MCP_UI_REVISION ?? null,
    provider: 'Synthetic vendor executable using production MCP config and connector bridge; no vendor model execution',
    checks, sessionId, bridge, requests, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidence: output }));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  await writeFile(`${output}/failure-text.txt`, await page.locator('body').innerText());
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: false, checks, requests, errors, failure: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }

import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.TOOLS_CHROMIUM_PATH ? { executablePath: process.env.TOOLS_CHROMIUM_PATH } : {}) });
const base = process.env.TOOLS_UI_URL ?? 'http://127.0.0.1:4864';
const results = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/e2e/tools-harness.html`);
    await page.getByRole('button', { name: 'Edit tool', exact: true }).click();
    await page.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption('python');
    const source = page.getByRole('textbox', { name: 'Source', exact: true });
    await expect(source).toHaveAttribute('contenteditable', 'true');
    await source.fill('print("hello")\n');
    await page.getByRole('textbox', { name: 'Input 1 name', exact: true }).fill('url');
    await page.getByRole('button', { name: 'Save tool', exact: true }).click();
    await page.getByText('Version 2', { exact: true }).waitFor();
    await expect(page.locator('.tool-source .cm-content')).toContainText('print');
    await expect(page.locator('.tool-source .tok-string')).toContainText('"hello"');
    await page.getByRole('button', { name: 'Set secret for token', exact: true }).click();
    await page.getByLabel('Secret for token', { exact: true }).fill('fixture-secret-abcd');
    await page.getByRole('button', { name: 'Save secret', exact: true }).click();
    await page.getByText('Secret set · …abcd', { exact: true }).waitFor();
    await expect(page.getByText('fixture-secret-abcd', { exact: true })).toHaveCount(0);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw Error(`Page overflow at ${width}`);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Run url-check' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'url', exact: true })).toHaveValue('https://example.test');
    await page.getByRole('button', { name: 'Run tool', exact: true }).click();
    await page.getByText('Running', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Shell command' }).fill('pwd');
    await page.getByRole('button', { name: 'Finish run' }).click();
    await page.getByText('Exited 0', { exact: true }).waitFor();
    await expect(page.getByRole('textbox', { name: 'Shell command' })).toHaveValue('pwd');
    await page.getByRole('textbox', { name: 'Shell command' }).fill('echo still-open');
    if (errors.length) throw Error(errors.join('\n'));
    results.push({ width, sourceHighlighting: 'python', secret: 'hint only', result: 'exited 0', interactiveAfterExit: true, errors });
    await page.close();
  }
  console.log(JSON.stringify({ fixtureOnly: true, results }, null, 2));
} finally { await browser.close(); }

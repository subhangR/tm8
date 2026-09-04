// Standalone real-app capture (NOT a spec — .mjs is outside the test glob).
// Drives the LIVE launchd node at 127.0.0.1:4610: switches to the artifact's
// space, opens it from the Artifacts view, clicks Run, and proves the bundle
// actually RENDERS inside the sandboxed iframe served from the second origin
// (localhost:4613). Evidence for the artifacts-preview task; nothing is
// created except a browser-local scratch owner account when the auth gate
// appears in this fresh profile.
//
// Deep-link note (measured 2026-07-31): a cold `#/s/<space>/e/<id>` load does
// NOT land on the entity — the shell restores its persisted workspace/space
// instead — so this walks the UI the way a user would.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = 'http://127.0.0.1:4610';
const ARTIFACT_TITLE = 'Hello artifact';
const SPACE_NAME = /Smoke Space/i;
const OUT = process.env.OUT_DIR ?? 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();

await page.goto(BASE);
await page.waitForTimeout(4000);

// The local-auth gate appears once per fresh profile; pass it if present.
if (await page.getByText(/create owner account/i).count()) {
  await page.getByLabel(/your name/i).fill('Preview Probe');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
  await page.waitForTimeout(4000);
}

// Workspace switcher → the artifact's space.
await page.locator('text=local · this').first().click();
await page.waitForTimeout(1500);
await page.getByText(SPACE_NAME).first().click();
await page.waitForTimeout(3500);

// Sidebar Artifacts view → the artifact row.
await page.getByText('Artifacts', { exact: true }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/artifacts-view.png` });
await page.getByText(ARTIFACT_TITLE).first().click();
await page.waitForTimeout(2500);

const runButton = page.getByRole('button', { name: /run/i }).first();
await runButton.waitFor({ timeout: 15_000 });
await page.screenshot({ path: `${OUT}/artifact-panel-before-run.png` });
console.log('before-run: Run button present, disabled =', await runButton.isDisabled());

await runButton.click();

// The iframe only exists after Run (click-to-run, §9.5). Wait for it, then
// for the bundle's own script to have executed inside the opaque frame.
const frameEl = page.locator('iframe.pn-preview__frame');
await frameEl.waitFor({ timeout: 15_000 });
console.log('iframe src:', await frameEl.getAttribute('src'));
console.log('iframe sandbox:', await frameEl.getAttribute('sandbox'));

const frame = await (await frameEl.elementHandle()).contentFrame();
await frame.waitForSelector('#t', { timeout: 15_000 });
// The bundle's script rewrites #t from "loading" to "rendered <iso>"; seeing
// that text is proof allow-scripts executed INSIDE the sandbox.
await frame.waitForFunction(
  () => document.getElementById('t')?.textContent?.startsWith('rendered'),
  { timeout: 15_000 },
);
console.log('bundle text:', await frame.locator('#t').textContent());
console.log('bundle heading:', await frame.locator('h1').textContent());

await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/artifact-panel-running.png` });
console.log('saved', `${OUT}/artifact-panel-before-run.png`, `${OUT}/artifact-panel-running.png`);
await browser.close();

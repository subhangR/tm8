/** A bounded startup diagnosis, not durable storage acceptance. Use the external window guard. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { repoRoot, runRoot, uiPort, startServer, startUi, stopChild } from './game-storage-node.mjs';
import { fixturePool, seedStorageFixture } from './game-storage-fixture.mjs';
import { captureHostDiagnostics } from './game-storage-host-diagnostics.mjs';
import { createBrowserLifecycle, gameStorageLaunchOptions } from './game-storage-browser-lifecycle.mjs';

const require = createRequire(`${repoRoot}/packages/tm8-ui/package.json`);
const { chromium } = require('@playwright/test');
const options = gameStorageLaunchOptions();
const lifecycle = createBrowserLifecycle(chromium, { launchOptions: options });
const report = { kind: 'startup diagnosis only; not acceptance',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  launchOptions: options, executable: options.executablePath ?? chromium.executablePath(),
  dataPagePassed: false, harnessWebGlPassed: false };
let browser, context, server, ui, pool;
await captureHostDiagnostics(runRoot, 'before');
try {
  browser = await lifecycle.launch();
  context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: 'reduce' });
  const page = lifecycle.observePage(await context.newPage(), browser);
  console.log(JSON.stringify({ stage: 'diagnostic data page', boundary: 'before' }));
  await page.goto('data:text/html,<title>synthetic startup probe</title><p>startup</p>');
  if (await page.title() !== 'synthetic startup probe') throw new Error('Diagnostic data page title did not arrive');
  report.dataPagePassed = true;
  console.log(JSON.stringify({ stage: 'diagnostic data page', boundary: 'after' }));
  // Only initialize the real fixture and WebGL page after basic renderer startup succeeds.
  server = await startServer(); pool = fixturePool();
  const f = await seedStorageFixture(pool); ui = await startUi();
  const url = `http://127.0.0.1:${uiPort}/e2e/game-storage-harness.html?${new URLSearchParams({
    space: f.spaceId, member: f.owner.memberId, story: f.storyId, nested: f.nestedStoryId, task: f.taskId,
  })}`;
  console.log(JSON.stringify({ stage: 'diagnostic harness WebGL', boundary: 'before' }));
  await page.goto(url);
  await page.getByTestId('walking-map').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => {
    const scene = window.__storageHarness?.scene(); return !!scene?.player && scene.drawCalls > 0;
  }, null, { timeout: 90_000 });
  report.harnessWebGlPassed = true;
  console.log(JSON.stringify({ stage: 'diagnostic harness WebGL', boundary: 'after' }));
} catch (error) { report.runnerError = String(error.message).split('\n')[0]; process.exitCode = 1; }
finally {
  await lifecycle.closeContext(context, browser).catch(() => {});
  await lifecycle.closeBrowser(browser);
  await stopChild(ui); await stopChild(server); await pool?.end();
  await captureHostDiagnostics(runRoot, 'after');
  Object.assign(report, lifecycle.diagnostics());
  await writeFile(`${runRoot}/startup-probe.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}

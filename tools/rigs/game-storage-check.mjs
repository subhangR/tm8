/** Run from an isolated migrated database. Persists only aggregate acceptance evidence. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { migrationChainDigest } from '../../db/scratch-template.mjs';
import { startServer, startUi, stopChild, runRoot, repoRoot } from './game-storage-node.mjs';
import { fixturePool, seedStorageFixture } from './game-storage-fixture.mjs';
import { verifyStorageApi } from './game-storage-api.mjs';
import { verifyBrowserDurability, verifyLegacyMigration, verifyWalkingTraffic } from './game-storage-browser.mjs';
import { verifyPersistenceCost } from './game-storage-cost.mjs';

await mkdir(runRoot, { recursive: true });
const checks = [], began = Date.now();
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  migrationDigest: migrationChainDigest(), syntheticOnly: true,
  browserRuntime: 'SwiftShader single-process software functional diagnostics', checks };
const record = result => { checks.push({ ...result, ...(result.reason ? { reason: result.reason.split('\n')[0] } : {}) });
  console.log(JSON.stringify(checks.at(-1))); };
let server, ui; const pool = fixturePool();
try {
  server = await startServer();
  let fixture = await seedStorageFixture(pool);
  if (process.env.GAME_STORAGE_BROWSER_ONLY !== '1') await verifyStorageApi(fixture, pool, record);
  if (process.env.GAME_STORAGE_API_ONLY !== '1') {
    if (process.env.GAME_STORAGE_BROWSER_ONLY !== '1') fixture = await seedStorageFixture(pool);
    ui = await startUi();
    await verifyBrowserDurability(fixture, async () => { const oldPid = server.pid; await stopChild(server); server = await startServer();
      if (server.pid === oldPid) throw new Error('Restart did not replace the server process'); report.serverRestarted = true; }, record);
    await verifyLegacyMigration(await seedStorageFixture(pool), record);
    if (process.env.GAME_STORAGE_COST === '1') {
      await verifyPersistenceCost(fixture, pool, record);
      await verifyWalkingTraffic(fixture, pool, record);
    }
  }
} catch (error) {
  report.runnerError = String(error.message).split('\n')[0].slice(0, 300);
  process.exitCode = 1;
} finally {
  await stopChild(ui); await stopChild(server); await pool.end();
  report.elapsedMs = Date.now() - began;
  report.passed = checks.filter(check => check.passed).length;
  report.failed = checks.filter(check => !check.passed).length;
  report.ownedProcessesStopped = true;
  if (report.failed) process.exitCode = 1;
  await writeFile(`${runRoot}/acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ head: report.head, passed: report.passed, failed: report.failed, runnerError: report.runnerError,
    elapsedMs: report.elapsedMs, ownedProcessesStopped: true }));
}

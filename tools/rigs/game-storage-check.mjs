/** Run from an isolated migrated database. Persists only aggregate acceptance evidence. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { migrationChainDigest } from '../../db/scratch-template.mjs';
import { startServer, startUi, stopChild, runRoot, repoRoot } from './game-storage-node.mjs';
import { fixturePool, seedStorageFixture } from './game-storage-fixture.mjs';
import { verifyStorageApi } from './game-storage-api.mjs';
import { verifyBrowserDurability, verifyLegacyMigration, verifyWalkingTraffic, browserDiagnostics } from './game-storage-browser.mjs';
import { verifyPersistenceCost } from './game-storage-cost.mjs';
import { captureHostDiagnostics } from './game-storage-host-diagnostics.mjs';

await mkdir(runRoot, { recursive: true });
const checks = [], began = Date.now();
const dependencies = JSON.parse(readFileSync(`${repoRoot}/tools/rigs/game-storage-dependencies.json`, 'utf8'));
const chain = createHash('sha256');
for (const file of readdirSync(`${repoRoot}/db/migrations`).filter(file => file.endsWith('.sql')).sort()) {
  chain.update(file).update('\0').update(readFileSync(`${repoRoot}/db/migrations/${file}`)).update('\0');
}
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  activeCheckout: repoRoot, backendHead: dependencies.backend.sourceHead,
  backendProductionEquivalentHead: dependencies.backend.productionEquivalentHead,
  adapterHead: dependencies.adapter.sourceHead,
  officialMapMigrationSha256: createHash('sha256').update(readFileSync(`${repoRoot}/db/migrations/315_game_maps.sql`)).digest('hex'),
  fullMigrationChainSha256: chain.digest('hex'), migrationDigest: migrationChainDigest(), syntheticOnly: true,
  browserMotionPreference: 'reduce (except explicitly named default-motion restore check)',
  browserViewport: { width: 800, height: 600 }, rendererReadinessTimeoutMs: 90_000,
  concurrentOwnedUnitRuns: process.env.GAME_STORAGE_CONCURRENT_OWNED_UNIT_RUNS ?? 'not recorded',
  browserRuntime: 'SwiftShader single-process software functional diagnostics', checks };
const record = result => { checks.push({ ...result, ...(result.reason ? { reason: result.reason.split('\n')[0] } : {}) });
  console.log(JSON.stringify(checks.at(-1))); };
let server, ui; const pool = fixturePool();
if (process.env.GAME_STORAGE_BROWSER_DIAGNOSTICS === '1') await captureHostDiagnostics(runRoot, 'before');
try {
  server = await startServer();
  let fixture = await seedStorageFixture(pool);
  if (process.env.GAME_STORAGE_BROWSER_ONLY !== '1') await verifyStorageApi(fixture, pool, record);
  if (process.env.GAME_STORAGE_API_ONLY !== '1') {
    if (process.env.GAME_STORAGE_BROWSER_ONLY !== '1') fixture = await seedStorageFixture(pool);
    ui = await startUi();
    if (process.env.GAME_STORAGE_COST_ONLY !== '1') await verifyBrowserDurability(fixture, async () => { const oldPid = server.pid; await stopChild(server); server = await startServer();
      if (server.pid === oldPid) throw new Error('Restart did not replace the server process'); report.serverRestarted = true; }, record);
    if (process.env.GAME_STORAGE_COST_ONLY !== '1') await verifyLegacyMigration(await seedStorageFixture(pool), record);
    if (process.env.GAME_STORAGE_COST === '1') {
      await verifyPersistenceCost(fixture, pool, record);
      await verifyWalkingTraffic(fixture, pool, record);
    }
  }
} catch (error) {
  report.runnerError = String(error.message).split('\n')[0].slice(0, 300);
  if (!checks.some(check => !check.passed)) record({ name: 'all requested acceptance stages completed', passed: false, reason: report.runnerError });
  process.exitCode = 1;
} finally {
  await stopChild(ui); await stopChild(server); await pool.end();
  if (process.env.GAME_STORAGE_BROWSER_DIAGNOSTICS === '1') await captureHostDiagnostics(runRoot, 'after');
  report.elapsedMs = Date.now() - began;
  report.passed = checks.filter(check => check.passed).length;
  report.failed = checks.filter(check => !check.passed).length;
  report.success = !report.runnerError && report.failed === 0;
  report.ownedProcessesStopped = true;
  Object.assign(report, browserDiagnostics());
  if (report.failed) process.exitCode = 1;
  await writeFile(`${runRoot}/acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ head: report.head, passed: report.passed, failed: report.failed, runnerError: report.runnerError,
    elapsedMs: report.elapsedMs, ownedProcessesStopped: true }));
}

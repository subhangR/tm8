#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditEnvironment, browserGpuSummary } from './environment.mjs';
import { classify, fixture, INTERACTIONS, matrix } from './core.mjs';
import { writeReport } from './report.mjs';
const here = dirname(fileURLToPath(import.meta.url)), ui = resolve(here, '../..'), repo = resolve(ui, '../..');
const argv = process.argv.slice(2), flag = name => argv.includes(name);
const value = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const number = (name, fallback, minimum) => { const n = Number(value(name, fallback)); if (!Number.isFinite(n) || n < minimum) throw new Error(`${name} must be >= ${minimum}`); return n; };
const smoke = flag('--smoke');
const bounded = async (promise, ms = 10000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser GPU audit timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};
const settings = { warmupMs: number('--warmup-ms', smoke ? 200 : 2000, smoke ? 0 : 2000),
  sampleMs: number('--sample-ms', smoke ? 1000 : 10000, smoke ? 100 : 10000),
  repeats: number('--repeats', smoke ? 1 : 3, smoke ? 1 : 3), minimumSamples: number('--min-samples', smoke ? 3 : 30, 1),
  viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'no-preference',
  mode: smoke ? 'tool-smoke-only' : 'production-build-synthetic-benchmark', headed: flag('--headed'),
  softwareRequested: flag('--software'), nativeOnly: flag('--native-only'), httpCache: 'disabled',
  interactions: INTERACTIONS, windowOrder: 'idle then walk-overview-zoom', fixtureIsolation: 'new context/page for each repeat/case',
  readiness: 'actual scene draw + all known imported assets resolved + fonts ready + canvas visible + 500ms HTTP quiet + no errors',
  frameTiming: 'rAF timestamps of callbacks with real WebGL draw submissions; complete intervals inside window',
  drawMetric: 'drawArrays/drawElements/instanced submissions per rendering callback, including shadow passes',
  cpuMetric: 'instrumented rendering callback duration; asynchronous GL submission, not GPU execution time' };
if (!Number.isInteger(settings.repeats) || !Number.isInteger(settings.minimumSamples)) throw new Error('Repeats and min samples must be integers');
const output = resolve(value('--output', join(tmpdir(), 'tm8-game-gpu-evidence')));
await mkdir(output, { recursive: true });
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = data => createHash('sha256').update(data).digest('hex');
const fileNames = (await readdir(here)).filter(name => /\.(mjs|tsx|html|md)$/.test(name)).sort();
const toolHash = hash((await Promise.all(fileNames.map(async name => name + '\n' + await readFile(join(here, name), 'utf8')))).join('\n'));
const allCases = matrix();
const selection = value('--case', null);
const cases = selection ? allCases.filter(c => `${c.scope}/${c.map}/${c.workload}` === selection) : allCases;
if (!cases.length) throw new Error('Unknown --case (use space/taskland/representative, for example)');
const audit = await auditEnvironment();
const report = { schema: 'tm8.game-gpu-benchmark.v1', createdAt: new Date().toISOString(), settings,
  provenance: { head: git(['rev-parse', 'HEAD']), main: git(['rev-parse', 'origin/main']),
    branch: git(['branch', '--show-current']), dirty: Boolean(git(['status', '--porcelain'])), expectedHead: value('--expected-head', null),
    toolHash, toolFiles: fileNames, argv, node: process.version,
    environment: { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null, LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE ?? null,
      MESA_LOADER_DRIVER_OVERRIDE: process.env.MESA_LOADER_DRIVER_OVERRIDE ?? null, buildMode: 'production', exclusiveResourcesReserved: false },
    fixtureHashes: Object.fromEntries(allCases.map(c => [`${c.scope}/${c.map}/${c.workload}`, hash(JSON.stringify(fixture(c)))])) },
  audit, workloadMatrix: allCases, runs: [], nativeEligible: false, coverage: { completeMatrix: !selection && !smoke,
    supported: ['static six map types at both scopes, 64/512 content rows', 'production renderer, model and player', 'idle and scripted walking/overview/zoom'],
    unsupported: ['live server event replay', 'criteria/subtree-weight construction new contract (baseline builder unavailable)', 'construction/status/shipping transitions', '24h rubble lifecycle', 'worker arrival/departure routes', 'production authenticated graph adapter', 'nested navigation and reload persistence'],
    noApprovedPerformanceBudget: true, smokeOnly: smoke } };
await writeFile(join(output, 'reproduce.md'), await readFile(join(here, 'README.md'), 'utf8'));
let browser, server, temporary;
const persist = async () => { report.nativeEligible = !smoke && !selection && report.runs.length === allCases.length * settings.repeats && report.runs.every(r =>
  !r.error && r.windows.length === INTERACTIONS.length && r.windows.every(w => w.eligibility.nativeEligible)); await writeReport(output, report); };
try {
  if (settings.nativeOnly && (smoke || selection || !settings.headed || settings.softwareRequested || report.provenance.dirty || !/^[a-f\d]{40}$/i.test(report.provenance.expectedHead ?? '') || report.provenance.expectedHead !== report.provenance.head)) throw new Error('Native-only refused: requires full non-smoke matrix, headed browser, no software flag, clean checkout and exact --expected-head SHA');
  if (settings.nativeOnly && !audit.devices.some(d => d.hardware && d.accessible)) throw new Error('Native-only refused: physical device access is not proven on this host');
  temporary = await mkdtemp(join(tmpdir(), 'tm8-game-gpu-build-'));
  const config = { configFile: false, root: ui, base: '/', plugins: [react()], logLevel: 'warn',
    build: { outDir: temporary, emptyOutDir: true, rollupOptions: { input: join(here, 'harness.html') } } };
  await build(config);
  server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  const base = server.resolvedUrls.local[0];
  const launchArgs = ['--no-sandbox', ...(settings.softwareRequested ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])];
  browser = await chromium.launch({ headless: !settings.headed, args: launchArgs, ignoreDefaultArgs: settings.softwareRequested ? undefined : ['--enable-unsafe-swiftshader'],
    ...(value('--chromium', null) ? { executablePath: resolve(value('--chromium')) } : {}) });
  console.log(JSON.stringify({ stage: 'browser-launched' }));
  const browserSession = await bounded(browser.newBrowserCDPSession());
  report.browser = { version: browser.version(), launchArgs, ...(await bounded(browserSession.send('Browser.getVersion')).then(({ product, revision, userAgent, jsVersion }) => ({ product, revision, userAgent, jsVersion }))) };
  try { report.browser.commandLine = (await bounded(browserSession.send('Browser.getBrowserCommandLine'))).arguments.map(a => a.startsWith('--user-data-dir=') ? '--user-data-dir=[temporary]' : a); } catch { report.browser.commandLine = null; }
  const gpu = async () => { try { return browserGpuSummary(await bounded(browserSession.send('SystemInfo.getInfo'))); } catch (error) { return { auditError: String(error) }; } };
  report.browser.gpuAtLaunch = await gpu();
  console.log(JSON.stringify({ stage: 'browser-audited', gpuAuditError: report.browser.gpuAtLaunch.auditError ?? null }));
  if (settings.nativeOnly) {
    const candidate = classify({ renderer: { unmaskedRenderer: report.browser.gpuAtLaunch.glRenderer, context: 'webgl2' }, browserGpu: report.browser.gpuAtLaunch, audit, softwareRequested: settings.softwareRequested, dirty: report.provenance.dirty, headed: settings.headed, actualHead: report.provenance.head, expectedHead: report.provenance.expectedHead });
    if (!candidate.nativeEligible) throw new Error(`Native-only refused: ${candidate.reasons.join(', ')}`);
  }
  for (const config of cases) for (let repeat = 1; repeat <= settings.repeats; repeat++) {
    const key = `${config.scope}/${config.map}/${config.workload}`;
    const row = { key, repeat, selection: config, fixtureHash: report.provenance.fixtureHashes[key], windows: [] };
    report.runs.push(row);
    console.log(JSON.stringify({ key, repeat, stage: 'creating-context' }));
    const context = await bounded(browser.newContext({ viewport: settings.viewport, deviceScaleFactor: settings.deviceScaleFactor, reducedMotion: settings.reducedMotion }));
    console.log(JSON.stringify({ key, repeat, stage: 'creating-page' }));
    const page = await bounded(context.newPage()), failures = [], pending = new Set();
    let lastNetworkAt = Date.now();
    page.on('pageerror', error => failures.push(error.message.slice(0, 500)));
    page.on('request', request => { pending.add(request); lastNetworkAt = Date.now(); });
    page.on('requestfinished', request => { pending.delete(request); lastNetworkAt = Date.now(); });
    page.on('requestfailed', request => { pending.delete(request); failures.push(`request failed: ${new URL(request.url()).pathname}`); lastNetworkAt = Date.now(); });
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
    try {
      const cdp = await bounded(context.newCDPSession(page));
      await bounded(cdp.send('Network.enable')); await bounded(cdp.send('Network.setCacheDisabled', { cacheDisabled: true }));
      console.log(JSON.stringify({ key, repeat, stage: 'opening-document' }));
      const began = Date.now();
      await page.goto(`${base}e2e/game-gpu/harness.html?${new URLSearchParams(config)}`, { waitUntil: 'load', timeout: 90000 });
      console.log(JSON.stringify({ key, repeat, stage: 'document-loaded' }));
      await page.bringToFront();
      await page.waitForFunction(() => {
        const probe = window.__gpuProbe?.state(), snapshot = window.__gameGpuFixture?.snapshot();
        const canvas = document.querySelector('[data-renderer="webgl"] canvas');
        return canvas && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0 && probe?.renderer && probe.lastRenderAt &&
          !probe.contextLost && snapshot?.assets && !snapshot.assets.loading && !snapshot.assets.errors.length && !snapshot.unresolvedImportedFallbacks.length && document.visibilityState === 'visible';
      }, null, { timeout: smoke ? 15000 : 90000 });
      await page.evaluate(() => document.fonts.ready);
      const quietDeadline = Date.now() + 30000;
      while (pending.size || Date.now() - lastNetworkAt < 500) { if (Date.now() > quietDeadline) throw new Error('HTTP requests did not settle'); await page.waitForTimeout(100); }
      if (failures.length) throw new Error(`Readiness errors: ${failures.join('; ')}`);
      const data = await page.evaluate(() => { const { snapshot, ...data } = window.__gameGpuFixture; return { ...data, snapshot: snapshot(), probe: window.__gpuProbe.state() }; });
      Object.assign(row, { counts: data.counts, buildMs: data.buildMs, warnings: data.warnings, source: data.source,
        readiness: { loadToReadyMs: Date.now() - began, firstRenderedMs: data.probe.firstRenderAt, ...data.snapshot }, renderer: data.probe.renderer });
      await page.waitForTimeout(settings.warmupMs);
      const host = page.getByTestId('walking-map');
      for (const interaction of INTERACTIONS) {
        await host.focus();
        const before = await page.evaluate(() => ({ observations: window.__gameGpuFixture.observations, snapshot: window.__gameGpuFixture.snapshot() }));
        await page.evaluate(() => window.__gpuProbe.begin());
        if (interaction === 'walk-overview-zoom') {
          await page.keyboard.down('d'); await page.waitForTimeout(settings.sampleMs / 2); await page.keyboard.up('d');
          await page.keyboard.press('m'); await host.locator('canvas').hover(); await page.mouse.wheel(0, 120);
          await page.waitForTimeout(settings.sampleMs / 2);
        } else await page.waitForTimeout(settings.sampleMs);
        const windowData = await page.evaluate(minimum => ({ ...window.__gpuProbe.end(minimum), observations: window.__gameGpuFixture.observations, snapshot: window.__gameGpuFixture.snapshot(), probe: window.__gpuProbe.state() }), settings.minimumSamples);
        const browserGpu = await gpu();
        windowData.interaction = interaction;
        windowData.conditions = { before, after: { observations: windowData.observations, snapshot: windowData.snapshot },
          script: interaction === 'idle' ? 'focused explorer view, no input' : 'D held for first half, released, M overview toggle, wheel +120; second half settles', reducedMotion: settings.reducedMotion };
        delete windowData.observations; delete windowData.snapshot;
        if (failures.length) { windowData.valid = false; windowData.invalidReasons.push('browser_or_network_error'); }
        if (windowData.conditions.after.snapshot.assets?.loading || windowData.conditions.after.snapshot.unresolvedImportedFallbacks.length) { windowData.valid = false; windowData.invalidReasons.push('assets_unresolved_after_window'); }
        if (before.snapshot.size?.pixelRatio !== windowData.conditions.after.snapshot.size?.pixelRatio) { windowData.valid = false; windowData.invalidReasons.push('renderer_pixel_ratio_changed'); }
        windowData.browserGpu = browserGpu;
        windowData.eligibility = classify({ renderer: windowData.probe.renderer, browserGpu, audit, softwareRequested: settings.softwareRequested, samplesValid: windowData.valid && !smoke, dirty: report.provenance.dirty, headed: settings.headed, actualHead: report.provenance.head, expectedHead: report.provenance.expectedHead });
        row.windows.push(windowData);
        console.log(JSON.stringify({ key, repeat, interaction, samples: windowData.sampledFrames, fps: windowData.fps, valid: windowData.valid, nativeEligible: windowData.eligibility.nativeEligible }));
        if (settings.nativeOnly && !windowData.eligibility.nativeEligible) throw new Error(`Native-only refused sample: ${windowData.eligibility.reasons.join(', ')}`);
      }
      row.errors = failures;
    } catch (error) {
      row.error = String(error).slice(0, 2000); row.errors = failures;
      row.failureState = await page.evaluate(() => ({ probe: window.__gpuProbe?.state(), snapshot: window.__gameGpuFixture?.snapshot(),
        hostRenderer: document.querySelector('[data-testid="walking-map"]')?.getAttribute('data-renderer'),
        canvases: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width, cssHeight: c.getBoundingClientRect().height })) })).catch(() => null);
      console.error(JSON.stringify({ key, repeat, error: row.error, errors: failures, failureState: row.failureState })); if (settings.nativeOnly) throw error;
    }
    finally { await context.close(); await persist(); }
  }
  report.completedAt = new Date().toISOString();
  report.provenance.headAtEnd = git(['rev-parse', 'HEAD']);
  report.provenance.dirtyAtEnd = Boolean(git(['status', '--porcelain']));
  if (report.provenance.headAtEnd !== report.provenance.head || report.provenance.dirtyAtEnd) {
    for (const run of report.runs) for (const window of run.windows) {
      window.eligibility.nativeEligible = false; window.eligibility.reasons.push('checkout_changed_during_run');
    }
  }
  if (report.runs.some(r => r.error || r.windows.some(w => !w.valid))) process.exitCode = 1;
} catch (error) { report.error = String(error).slice(0, 2000); process.exitCode = 2; console.error(report.error); }
finally {
  await persist();
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ output, head: report.provenance.head, runs: report.runs.length, nativeEligible: report.nativeEligible, error: report.error ?? null }));
}

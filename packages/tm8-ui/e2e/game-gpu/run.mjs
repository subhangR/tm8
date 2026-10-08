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
import { classify, fixture, interactionEffect, INTERACTIONS, matrix, matrixOrder } from './core.mjs';
import { writeReport } from './report.mjs';
const here = dirname(fileURLToPath(import.meta.url)), ui = resolve(here, '../..'), repo = resolve(ui, '../..');
const argv = process.argv.slice(2), flag = name => argv.includes(name);
const value = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const number = (name, fallback, minimum) => { const n = Number(value(name, fallback)); if (!Number.isFinite(n) || n < minimum) throw new Error(`${name} must be >= ${minimum}`); return n; };
const smoke = flag('--smoke');
const bounded = async (promise, ms = 10000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const settings = { warmupMs: number('--warmup-ms', smoke ? 200 : 2000, smoke ? 0 : 2000),
  sampleMs: number('--sample-ms', smoke ? 3000 : 10000, smoke ? 100 : 10000),
  repeats: number('--repeats', smoke ? 1 : 3, smoke ? 1 : 3), minimumSamples: number('--min-samples', smoke ? 3 : 30, 1),
  viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'no-preference',
  mode: smoke ? 'tool-smoke-only' : 'production-build-synthetic-benchmark', headed: flag('--headed'),
  softwareRequested: flag('--software'), nativeOnly: flag('--native-only'), singleProcess: flag('--single-process'), processModel: flag('--single-process') ? 'single-process-software-diagnostic' : 'multiprocess', httpCache: 'fresh browser/context per case/repeat',
  interactions: INTERACTIONS, iterationOrder: 'repeat-major: all distinct cases before next repeat', windowOrder: 'idle then walk-overview-zoom', fixtureIsolation: 'new browser/context/page for each repeat/case',
  gpuAuditTiming: 'same browser after both sampled windows and before close; GPU inspection excluded from sampling',
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
  audit, workloadMatrix: allCases, runs: [], cleanup: [], nativeEligible: false, coverage: { completeMatrix: false, fullMatrixRequested: !selection && !smoke,
    supported: ['static six map types at both scopes, 64/512 content rows', 'production renderer, model and player', 'idle and scripted walking/overview/zoom'],
    unsupported: ['live server event replay', 'criteria/subtree-weight construction new contract (baseline builder unavailable)', 'construction/status/shipping transitions', '24h rubble lifecycle', 'worker arrival/departure routes', 'production authenticated graph adapter', 'nested navigation and reload persistence'],
    noApprovedPerformanceBudget: true, smokeOnly: smoke } };
await writeFile(join(output, 'reproduce.txt'), await readFile(join(here, 'README.md'), 'utf8'));
let browser, browserServer, server, temporary;
const closeBrowser = async () => {
  if (!browserServer) return;
  try { await bounded(browserServer.close(), 5000); report.cleanup.push({ key: report.runs.at(-1)?.key ?? null, repeat: report.runs.at(-1)?.repeat ?? null, forcedBrowserKill: false }); }
  catch (error) {
    (report.cleanup ??= []).push({ key: report.runs.at(-1)?.key ?? null, repeat: report.runs.at(-1)?.repeat ?? null, forcedBrowserKill: true, reason: String(error) });
    try { await bounded(browserServer.kill(), 5000); } catch {}
  } finally {
    const process = browserServer.process();
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await bounded(browser?.close(), 3000).catch(() => {});
    browserServer = null;
  }
};
const persist = async () => { report.nativeEligible = !smoke && !selection && report.runs.length === allCases.length * settings.repeats && report.runs.every(r =>
  !r.error && r.windows.length === INTERACTIONS.length && r.windows.every(w => w.eligibility.nativeEligible)); await writeReport(output, report); };
try {
  if (settings.singleProcess && !settings.softwareRequested) throw new Error('--single-process is supported only for explicit software diagnostics');
  if (settings.nativeOnly && (smoke || selection || !settings.headed || settings.softwareRequested || report.provenance.dirty || !/^[a-f\d]{40}$/i.test(report.provenance.expectedHead ?? '') || report.provenance.expectedHead !== report.provenance.head)) throw new Error('Native-only refused: requires full non-smoke matrix, headed browser, no software flag, clean checkout and exact --expected-head SHA');
  if (settings.nativeOnly && !audit.devices.some(d => d.hardware && d.accessible)) throw new Error('Native-only refused: physical device access is not proven on this host');
  temporary = await mkdtemp(join(tmpdir(), 'tm8-game-gpu-build-'));
  const config = { configFile: false, root: ui, base: '/', plugins: [react()], logLevel: 'warn',
    build: { outDir: temporary, emptyOutDir: true, rollupOptions: { input: join(here, 'harness.html') } } };
  await build(config);
  server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  const base = server.resolvedUrls.local[0];
  const launchArgs = ['--no-sandbox', ...(settings.singleProcess ? ['--no-zygote', '--single-process'] : []), ...(settings.softwareRequested ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])];
  const launchOptions = { headless: !settings.headed, args: launchArgs, ignoreDefaultArgs: settings.softwareRequested ? undefined : ['--enable-unsafe-swiftshader'],
    ...(value('--chromium', null) ? { executablePath: resolve(value('--chromium')) } : {}) };
  const openBrowser = async () => {
    browserServer = await chromium.launchServer({ ...launchOptions, host: '127.0.0.1' });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 });
  };
  await openBrowser();
  console.log(JSON.stringify({ stage: 'browser-launched' }));
  let browserSession = await bounded(browser.newBrowserCDPSession());
  report.browser = { version: browser.version(), launchArgs, ...(await bounded(browserSession.send('Browser.getVersion')).then(({ product, revision, userAgent, jsVersion }) => ({ product, revision, userAgent, jsVersion }))) };
  try { report.browser.commandLine = (await bounded(browserSession.send('Browser.getBrowserCommandLine'))).arguments.map(a => a.startsWith('--user-data-dir=') ? '--user-data-dir=[temporary]' : a); } catch { report.browser.commandLine = null; }
  const gpu = async () => { try { return browserGpuSummary(await bounded(browserSession.send('SystemInfo.getInfo'))); } catch (error) { return { auditError: String(error) }; } };
  console.log(JSON.stringify({ stage: 'browser-commandline-recorded', gpuAudit: 'deferred-until-after-windows' }));
  for (const { config, repeat } of matrixOrder(cases, settings.repeats)) {
    if (report.runs.length) {
      await openBrowser();
      browserSession = await bounded(browser.newBrowserCDPSession());
    }
    const key = `${config.scope}/${config.map}/${config.workload}`;
    const row = { key, repeat, ordinal: report.runs.length + 1, startedAt: new Date().toISOString(), selection: config, fixtureHash: report.provenance.fixtureHashes[key], windows: [] };
    report.runs.push(row);
    let context, page;
    const failures = [], pending = new Set();
    let lastNetworkAt = Date.now();
    try {
    console.log(JSON.stringify({ key, repeat, stage: 'creating-context' }));
    context = await bounded(browser.newContext({ viewport: settings.viewport, deviceScaleFactor: settings.deviceScaleFactor, reducedMotion: settings.reducedMotion }));
    console.log(JSON.stringify({ key, repeat, stage: 'creating-page' }));
    page = await bounded(context.newPage());
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => failures.push(error.message.slice(0, 500)));
    page.on('request', request => { pending.add(request); lastNetworkAt = Date.now(); });
    page.on('requestfinished', request => { pending.delete(request); lastNetworkAt = Date.now(); });
    page.on('requestfailed', request => { pending.delete(request); failures.push(`request failed: ${new URL(request.url()).pathname}`); lastNetworkAt = Date.now(); });
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
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
      const data = await page.evaluate(() => { const { snapshot, ...data } = window.__gameGpuFixture; return { ...data, timeOrigin: performance.timeOrigin, snapshot: snapshot(), probe: window.__gpuProbe.state() }; });
      Object.assign(row, { counts: data.counts, buildMs: data.buildMs, warnings: data.warnings, source: data.source,
        readiness: { loadToReadyMs: Date.now() - began, firstRenderedMs: data.probe.firstRenderAt, ...data.snapshot }, renderer: data.probe.renderer });
      await page.waitForTimeout(settings.warmupMs);
      const host = page.getByTestId('walking-map');
      for (const interaction of INTERACTIONS) {
        await host.focus();
        const before = await page.evaluate(() => ({ observations: window.__gameGpuFixture.observations, snapshot: window.__gameGpuFixture.snapshot() }));
        await page.evaluate(() => window.__gpuProbe.begin());
        let during = null;
        if (interaction === 'walk-overview-zoom') {
          await page.keyboard.down('d'); await page.waitForTimeout(settings.sampleMs / 2);
          during = await page.evaluate(() => ({ observations: window.__gameGpuFixture.observations, snapshot: window.__gameGpuFixture.snapshot() }));
          await page.keyboard.up('d');
          await page.keyboard.press('m'); await host.locator('canvas[data-engine]').hover(); await page.mouse.wheel(0, 120);
          await page.waitForTimeout(settings.sampleMs / 2);
        } else await page.waitForTimeout(settings.sampleMs);
        const windowData = await page.evaluate(minimum => ({ ...window.__gpuProbe.end(minimum), observations: window.__gameGpuFixture.observations, snapshot: window.__gameGpuFixture.snapshot(), probe: window.__gpuProbe.state() }), settings.minimumSamples);
        windowData.interaction = interaction;
        windowData.startEpochMs = data.timeOrigin + windowData.start;
        windowData.endEpochMs = data.timeOrigin + windowData.end;
        windowData.conditions = { before, during, after: { observations: windowData.observations, snapshot: windowData.snapshot },
          script: interaction === 'idle' ? 'focused explorer view, no input' : 'D held for first half, released, M overview toggle, wheel +120; second half settles', reducedMotion: settings.reducedMotion };
        delete windowData.observations; delete windowData.snapshot;
        if (during) {
          windowData.inputEffect = interactionEffect(before, during, windowData.conditions.after);
          if (!windowData.inputEffect.valid) { windowData.valid = false; windowData.invalidReasons.push('scripted_input_effect_not_observed'); }
        }
        const clockHz = windowData.probe.frameClockCalibration?.estimatedHz;
        windowData.pacingRelation = clockHz && windowData.fps >= clockHz * .95 ? 'near_pre_scene_clock_cap_headroom_unknown' : 'below_pre_scene_clock_estimate_or_unknown';
        if (failures.length) { windowData.valid = false; windowData.invalidReasons.push('browser_or_network_error'); }
        if (windowData.conditions.after.snapshot.assets?.loading || windowData.conditions.after.snapshot.unresolvedImportedFallbacks.length) { windowData.valid = false; windowData.invalidReasons.push('assets_unresolved_after_window'); }
        if (before.snapshot.size?.pixelRatio !== windowData.conditions.after.snapshot.size?.pixelRatio) { windowData.valid = false; windowData.invalidReasons.push('renderer_pixel_ratio_changed'); }
        windowData.eligibility = { nativeEligible: false, reasons: ['post_window_browser_audit_pending'] };
        row.windows.push(windowData);
        console.log(JSON.stringify({ key, repeat, interaction, samples: windowData.sampledFrames, fps: windowData.fps, valid: windowData.valid, nativeEligible: false, gpuAudit: 'pending' }));
      }
      const startedAtEpochMs = Date.now();
      row.gpuAuditStartedAt = new Date(startedAtEpochMs).toISOString();
      row.browserGpu = { ...await gpu(), startedAtEpochMs, collectedAtEpochMs: Date.now() };
      row.gpuAuditCompletedAt = new Date().toISOString();
      try {
        const postAudit = await bounded(page.evaluate(() => window.__gpuProbe.state()), 5000);
        row.postAuditProbe = postAudit;
        row.browserGpu.stableContext = !postAudit.contextLost && postAudit.renderer?.unmaskedRenderer === row.renderer.unmaskedRenderer;
      } catch (error) { row.browserGpu.stableContext = false; row.postAuditError = String(error); }
      for (const windowData of row.windows) {
        windowData.eligibility = classify({ renderer: windowData.probe.renderer, browserGpu: row.browserGpu, audit, softwareRequested: settings.softwareRequested, samplesValid: windowData.valid && !smoke, dirty: report.provenance.dirty, headed: settings.headed, singleProcess: settings.singleProcess, actualHead: report.provenance.head, expectedHead: report.provenance.expectedHead, windowEndEpochMs: windowData.endEpochMs });
        if (settings.nativeOnly && !windowData.eligibility.nativeEligible) throw new Error(`Native-only refused sample: ${windowData.eligibility.reasons.join(', ')}`);
      }
      row.errors = failures;
    } catch (error) {
      row.error = String(error).slice(0, 2000); row.errors = failures;
      row.failureState = page ? await bounded(page.evaluate(() => ({ probe: window.__gpuProbe?.state(), snapshot: window.__gameGpuFixture?.snapshot(),
        hostRenderer: document.querySelector('[data-testid="walking-map"]')?.getAttribute('data-renderer'),
        canvases: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width, cssHeight: c.getBoundingClientRect().height })) })), 3000).catch(() => null) : null;
      console.error(JSON.stringify({ key, repeat, error: row.error, errors: failures, failureState: row.failureState })); if (settings.nativeOnly) throw error;
    }
    finally { await closeBrowser(); row.completedAt = new Date().toISOString(); await persist(); }
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
  await closeBrowser();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ output, head: report.provenance.head, runs: report.runs.length, nativeEligible: report.nativeEligible, error: report.error ?? null }));
}

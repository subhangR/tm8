import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, matrix, matrixOrder, distribution, summarize, classify, recordFrame, hardwareVendor, rendererIdentityMatches, interactionEffect } from './core.mjs';
const native = { renderer: { unmaskedRenderer: 'ANGLE (Intel, Intel GPU)', context: 'webgl2' },
  headed: true, actualHead: 'a'.repeat(40), expectedHead: 'a'.repeat(40),
  windowEndEpochMs: 100,
  audit: { devices: [{ name: 'Intel GPU', hardware: true, accessible: true, vendorId: 0x8086, deviceId: 42 }] },
  browserGpu: { glRenderer: 'ANGLE (Intel, Intel GPU)', stableContext: true, startedAtEpochMs: 150, collectedAtEpochMs: 200,
    devices: [{ deviceString: 'Intel GPU', vendorId: 0x8086, deviceId: 42, driverVersion: '1.2' }], featureStatus: { webgl: 'enabled', webgl2: 'enabled' } } };
test('24 deterministic workload cases and map-specific input counts', () => {
  assert.equal(matrix().length, 24);
  for (const config of matrix()) {
    const data = fixture(config), n = config.workload === 'large' ? 512 : 64;
    assert.deepEqual(data, fixture(config));
    assert.equal(data.entities.length, ['taskland', 'town'].includes(config.map) ? n * 1.25 : n);
    assert.equal(new Set(data.entities.map(e => e.id)).size, data.entities.length);
    assert(data.edges.every(e => data.entities.some(n => n.id === e.fromId) && data.entities.some(n => n.id === e.toId)));
  }
  const tasks = fixture({ scope: 'story', map: 'taskland', workload: 'representative' }).entities;
  assert.equal(tasks[0].status, 'done'); assert.equal(tasks[1].parentId, tasks[0].id);
  assert(tasks.some(e => e.status === 'cancelled')); assert(tasks.some(e => e.pointsEstimate === null));
});
test('quantiles and FPS use complete in-window rendered intervals', () => {
  assert.equal(distribution([10, 20, 30, 40]).median, 25);
  assert.equal(distribution([10, 20, 30, 40]).p95, 38.5);
  const frames = [
    { previous: 0, at: 10, drawCalls: 2, cpuMs: 1, instances: 2 },
    { previous: 10, at: 30, drawCalls: 4, cpuMs: 2, instances: 4 },
    { previous: 30, at: 50, drawCalls: 6, cpuMs: 3, instances: 6 },
    { previous: 50, at: 70, drawCalls: 0, cpuMs: 0, instances: 0 },
  ];
  const s = summarize(frames, { start: 5, end: 60, minimumSamples: 2 });
  assert.equal(s.sampledFrames, 2); assert.equal(s.fps, 50); assert.equal(s.drawCalls.median, 5);
  assert.equal(summarize(frames, { start: 5, end: 60, minimumSamples: 3 }).valid, false);
  assert.equal(summarize(frames, { start: 5, end: 60, minimumSamples: 2, hidden: true }).valid, false);
  assert.equal(summarize(frames, { start: 5, end: 60, minimumSamples: 2, contextLost: true }).valid, false);
});
test('native requires matched physical device, driver, hardware features and valid clean samples', () => {
  assert.equal(classify(native).nativeEligible, true);
  for (const change of [ { audit: { devices: [] } }, { browserGpu: {} }, { renderer: {} },
    { softwareRequested: true }, { samplesValid: false }, { dirty: true }, { headed: false }, { singleProcess: true }, { expectedHead: undefined }, { expectedHead: 'b'.repeat(40) },
    { browserGpu: { ...native.browserGpu, devices: [{ ...native.browserGpu.devices[0], driverVersion: '' }] } },
    { browserGpu: { ...native.browserGpu, devices: [{ ...native.browserGpu.devices[0], deviceId: 99 }] } },
    { browserGpu: { ...native.browserGpu, auditError: 'timeout' } },
    { browserGpu: { ...native.browserGpu, collectedAtEpochMs: 99 } },
    { browserGpu: { ...native.browserGpu, startedAtEpochMs: 99 } },
    { browserGpu: { ...native.browserGpu, stableContext: false } },
    { browserGpu: { ...native.browserGpu, gpuProcessCrashCount: 1 } },
    { browserGpu: { ...native.browserGpu, glRenderer: 'ANGLE (NVIDIA, Other GPU)' } },
    { browserGpu: { ...native.browserGpu, devices: [{ ...native.browserGpu.devices[0], active: false }, { vendorId: 0x10de, deviceId: 99, driverVersion: '1.2', active: true }] } },
    { browserGpu: { ...native.browserGpu, featureStatus: { webgl: 'unavailable_software', webgl2: 'enabled' } } } ]) {
    assert.equal(classify({ ...native, ...change }).nativeEligible, false, JSON.stringify(change));
  }
  for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'WARP', 'virgl', 'VMware']) {
    const value = classify({ ...native, renderer: { unmaskedRenderer: name } });
    assert.equal(value.classification, 'software-diagnostic'); assert.equal(value.nativeEligible, false);
  }
});
test('same timestamp rendering callbacks keep all submitted draws', () => {
  const frames = [];
  recordFrame(frames, { previous: 10, at: 30, drawCalls: 4, instances: 7, cpuMs: 2 });
  recordFrame(frames, { previous: 30, at: 30, drawCalls: 6, instances: 10, cpuMs: 3 });
  assert.equal(frames.length, 1); assert.equal(frames[0].previous, 10); assert.equal(frames[0].callbacks, 2);
  assert.equal(summarize(frames, { start: 5, end: 35, minimumSamples: 1 }).drawCalls.median, 10);
});
test('interaction validation rejects idle, unfocused and unmoved input windows', () => {
  const before = { observations: { initialPosition: { x: 0, z: 0 }, positions: [] }, snapshot: { overview: false, camera: { zoom: 1 } } };
  const during = { observations: { positions: [{ x: 1, z: 0 }] } };
  const after = { snapshot: { overview: true, camera: { zoom: 1 } } };
  assert.equal(interactionEffect(before, during, after).valid, true);
  assert.equal(interactionEffect(before, { observations: { positions: [{ x: 0, z: 0 }] } }, after).valid, false);
  assert.equal(interactionEffect(before, during, before).valid, false);
  const previouslyMoved = { ...before, observations: { positions: [{ x: 1, z: 0, at: 1 }, { x: 0, z: 0, at: 2 }] } };
  assert.equal(interactionEffect(previouslyMoved, { observations: previouslyMoved.observations }, after).valid, false);
  assert.equal(interactionEffect(previouslyMoved, { observations: { positions: [...previouslyMoved.observations.positions, { x: 2, z: 0, at: 3 }] } }, after).valid, true);
});
test('real hardware identities pass only with matching host/browser proof; QXL never hardware', () => {
  for (const [vendorId, name, renderer] of [
    [0x8086, 'Intel GPU', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'],
    [0x10de, 'NVIDIA GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    [0x106b, 'Apple M2', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  ]) {
    const data = { ...native, renderer: { unmaskedRenderer: renderer, context: 'webgl2' }, audit: { devices: [{ name, hardware: true, accessible: true, vendorId, deviceId: vendorId === 0x106b ? null : 42 }] },
      browserGpu: { ...native.browserGpu, glRenderer: renderer, devices: [{ vendorId, deviceId: vendorId === 0x106b ? 0 : 42, driverVersion: '1.2', deviceString: '' }] } };
    assert.equal(classify(data).nativeEligible, true, renderer);
  }
  assert.equal(hardwareVendor('0x1b36'), false); assert.equal(hardwareVendor('0x10de'), true);
  assert.equal(classify({ ...native, audit: { devices: [{ vendorId: 0x1b36, deviceId: 42, name: 'QXL', hardware: true, accessible: true }] } }).nativeEligible, false);
});

test('audit renderer matching removes only terminal driver-version suffix', () => {
  const sampled = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
  const audited = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver-5.0.0)';
  assert.equal(rendererIdentityMatches(sampled, audited), true);
  assert.equal(rendererIdentityMatches(sampled, audited.replace('0x0000C0DE', '0x0000BEEF')), false);
  assert.equal(rendererIdentityMatches(sampled, audited.replace('Vulkan 1.3.0', 'OpenGL 4.6')), false);
  assert.equal(rendererIdentityMatches(null, audited), false);
});

test('repeat-major schedule covers all24 cases before duplicates, with72 unique rows', () => {
  const cases = matrix(), rows = matrixOrder(cases, 3);
  assert.equal(rows.length, 72);
  assert.equal(new Set(rows.map(({ config: c, repeat }) => `${c.scope}/${c.map}/${c.workload}/${repeat}`)).size, 72);
  for (let repeat = 1; repeat <= 3; repeat++) {
    const batch = rows.slice((repeat - 1) * 24, repeat * 24);
    assert(batch.every(row => row.repeat === repeat)); assert.deepEqual(batch.map(row => row.config), cases);
  }
});

test('published partial coverage and repeat spreads use actual completed valid rows', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeReport } = await import('./report.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'tm8-gpu-report-test-'));
  try {
    const window = interaction => ({ interaction, valid: true, fps: 60, frameMs: { median: 16, p95: 20 } });
    const row = { key: 'space/hub/representative', repeat: 1, completedAt: '2026-01-01T00:00:00Z', windows: [window('idle'), window('walk-overview-zoom')] };
    const report = { settings: { repeats: 3 }, workloadMatrix: matrix(), coverage: { fullMatrixRequested: true }, runs: [row] };
    await writeReport(dir, report);
    const saved = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(saved.coverage.completeMatrix, false); assert.equal(saved.coverage.expectedRows, 72);
    assert.equal(saved.coverage.distinctAttemptedCases, 1); assert.equal(saved.coverage.completedRows, 1);
    assert.equal(saved.coverage.cases[0].validRepeats, 1); assert.equal(saved.repeatSummaries[0].fpsSpread, null);
    report.runs.push({ ...row, repeat: 2 }); await writeReport(dir, report);
    assert.equal(report.repeatSummaries[0].fpsSpread.count, 2);
    report.runs.push({ ...row, repeat: 3, completedAt: null }); await writeReport(dir, report);
    assert.equal(report.coverage.completedRows, 2); assert.equal(report.coverage.completeMatrix, false);
    assert.equal(report.repeatSummaries[0].validRepeats, 2); assert.equal(report.repeatSummaries[0].fpsSpread.count, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

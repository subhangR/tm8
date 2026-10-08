import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, matrix, distribution, summarize, classify, recordFrame, hardwareVendor } from './core.mjs';
const native = { renderer: { unmaskedRenderer: 'ANGLE (Intel, Intel GPU)', context: 'webgl2' },
  headed: true, actualHead: 'a'.repeat(40), expectedHead: 'a'.repeat(40),
  audit: { devices: [{ name: 'Intel GPU', hardware: true, accessible: true, vendorId: 0x8086, deviceId: 42 }] },
  browserGpu: { devices: [{ deviceString: 'Intel GPU', vendorId: 0x8086, deviceId: 42, driverVersion: '1.2' }], featureStatus: { webgl: 'enabled', webgl2: 'enabled' } } };
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
    { softwareRequested: true }, { samplesValid: false }, { dirty: true }, { headed: false }, { expectedHead: undefined }, { expectedHead: 'b'.repeat(40) },
    { browserGpu: { ...native.browserGpu, devices: [{ ...native.browserGpu.devices[0], driverVersion: '' }] } },
    { browserGpu: { ...native.browserGpu, devices: [{ ...native.browserGpu.devices[0], deviceId: 99 }] } },
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
test('real hardware identities pass only with matching host/browser proof; QXL never hardware', () => {
  for (const [vendorId, name, renderer] of [
    [0x8086, 'Intel GPU', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'],
    [0x10de, 'NVIDIA GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    [0x106b, 'Apple M2', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  ]) {
    const data = { ...native, renderer: { unmaskedRenderer: renderer, context: 'webgl2' }, audit: { devices: [{ name, hardware: true, accessible: true, vendorId, deviceId: vendorId === 0x106b ? null : 42 }] },
      browserGpu: { ...native.browserGpu, devices: [{ vendorId, deviceId: vendorId === 0x106b ? 0 : 42, driverVersion: '1.2', deviceString: '' }] } };
    assert.equal(classify(data).nativeEligible, true, renderer);
  }
  assert.equal(hardwareVendor('0x1b36'), false); assert.equal(hardwareVendor('0x10de'), true);
  assert.equal(classify({ ...native, audit: { devices: [{ vendorId: 0x1b36, deviceId: 42, name: 'QXL', hardware: true, accessible: true }] } }).nativeEligible, false);
});

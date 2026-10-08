/** Test-only deterministic inputs and conservative report rules. No private graph rows. */
export const MAPS = ['hub', 'taskland', 'office', 'library', 'factory', 'town'];
export const SCOPES = ['space', 'story'];
export const WORKLOADS = { representative: 64, large: 512 };
export const INTERACTIONS = ['idle', 'walk-overview-zoom'];
export const matrix = () => SCOPES.flatMap(scope => MAPS.flatMap(map =>
  Object.keys(WORKLOADS).map(workload => ({ scope, map, workload }))));

export function fixture({ scope: kind, map, workload }) {
  if (!SCOPES.includes(kind) || !MAPS.includes(map) || !(workload in WORKLOADS)) throw new Error('Invalid workload');
  const scope = { kind, id: `synthetic-${kind}` };
  const n = WORKLOADS[workload], entities = [], edges = [];
  const entity = (id, kind, extra = {}) => ({ id, kind, title: `Synthetic ${kind} ${id}`, spaceId: 'synthetic-space',
    storyIds: ['synthetic-story'], createdAt: '2026-01-01T00:00:00Z', ...extra });
  const kinds = { hub: ['story'], taskland: ['task'], office: ['team_member', 'work_session', 'skill', 'member'],
    library: ['doc', 'drawing', 'artifact', 'file'], factory: ['project', 'pull_request', 'commit', 'worktree'], town: ['task'] }[map];
  for (let i = 0; i < n; i++) {
    const entityKind = kinds[i % kinds.length], id = `row-${String(i).padStart(4, '0')}`;
    const parentId = map === 'hub' ? (kind === 'story' ? scope.id : null)
      : i % 8 && entityKind === kinds[0] ? `row-${String(i - i % 8).padStart(4, '0')}` : null;
    entities.push(entity(id, entityKind, { parentId,
      status: map === 'town' || map === 'taskland' && i % 32 === 0 ? 'done' : entityKind === 'work_session' ? 'running' : ['open', 'working', 'in_review', 'blocked', 'cancelled', 'done'][i % 6],
      processState: entityKind === 'work_session' ? 'running' : null, live: entityKind === 'work_session',
      progress: (i % 9) / 9, pointsEstimate: i % 7 === 0 ? null : 1 + i % 8, mailbox: { count: i % 4 }, pendingAttention: i % 17 === 0 ? 1 : 0 }));
    if ((map === 'taskland' || map === 'town') && i) edges.push({ id: `road-${i}`, type: 'depends_on', fromId: `row-${String(i - 1).padStart(4, '0')}`, toId: id });
  }
  if (map === 'taskland') for (let i = 0; i < n / 4; i++) {
    const id = `worker-${i}`;
    entities.push(entity(id, 'work_session', { status: 'running', processState: 'running', live: true }));
    edges.push({ id: `claim-${i}`, type: 'working_on', fromId: id, toId: `row-${String(i * 4).padStart(4, '0')}`, status: ['working', 'waiting', 'blocked'][i % 3] });
  }
  if (map === 'town') for (let i = 0; i < n / 4; i++) {
    const id = `output-${i}`;
    entities.push(entity(id, 'artifact'));
    edges.push({ id: `output-edge-${i}`, type: 'produces', fromId: `row-${String(i * 4).padStart(4, '0')}`, toId: id });
  }
  return { scope, entities, edges };
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, median: null, p95: null, p99: null, max: null, mean: null };
  const quantile = q => { const i = (sorted.length - 1) * q, lo = Math.floor(i); return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo); };
  return { count: sorted.length, min: sorted[0], median: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}

/** Several rendering callbacks in one vsync belong to one rendered frame. */
export function recordFrame(frames, sample) {
  const last = frames.at(-1);
  if (last?.at === sample.at) {
    last.drawCalls += sample.drawCalls; last.instances += sample.instances; last.cpuMs += sample.cpuMs;
    last.callbacks = (last.callbacks ?? 1) + 1;
  } else frames.push({ ...sample, callbacks: 1 });
}

export function interactionEffect(before, during, after) {
  const origin = before.observations.positions.at(-1) ?? before.observations.initialPosition;
  const since = before.observations.positions.at(-1)?.at ?? -Infinity;
  const playerMoved = Boolean(origin && during.observations.positions.some(p => (since === -Infinity || p.at > since) && Math.hypot(p.x - origin.x, p.z - origin.z) > .001));
  const cameraOrOverviewChanged = before.snapshot.overview !== after.snapshot.overview || JSON.stringify(before.snapshot.camera) !== JSON.stringify(after.snapshot.camera);
  return { playerMoved, cameraOrOverviewChanged, valid: playerMoved && cameraOrOverviewChanged };
}

export function summarize(frames, { start, end, minimumSamples = 30, hidden = false, contextLost = false }) {
  // Include only complete intervals whose two rendered endpoints fall in the window.
  const sampled = frames.filter(f => f.previous >= start && f.at <= end && f.at > f.previous && f.drawCalls > 0);
  const frameMs = distribution(sampled.map(f => f.at - f.previous));
  const invalidReasons = [];
  if (hidden) invalidReasons.push('document_hidden_during_window');
  if (contextLost) invalidReasons.push('webgl_context_lost');
  if (!sampled.length) invalidReasons.push('no_rendered_intervals_in_window');
  if (sampled.length < minimumSamples) invalidReasons.push('insufficient_rendered_frame_intervals');
  if (!(end > start)) invalidReasons.push('invalid_window');
  const elapsed = sampled.reduce((sum, f) => sum + f.at - f.previous, 0);
  return { valid: !invalidReasons.length, invalidReasons, sampledFrames: sampled.length, windowMs: end - start,
    coveredIntervalMs: elapsed, fps: elapsed ? sampled.length * 1000 / elapsed : null, frameMs,
    over33ms: sampled.filter(f => f.at - f.previous > 33).length, over50ms: sampled.filter(f => f.at - f.previous > 50).length,
    callbackCpuMs: distribution(sampled.map(f => f.cpuMs)), drawCalls: distribution(sampled.map(f => f.drawCalls)),
    submittedInstances: distribution(sampled.map(f => f.instances)) };
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|warp|virgl|qxl|vmware|virtualbox|microsoft basic|parallels/i;
export const hardwareVendor = id => [0x1002, 0x10de, 0x8086, 0x106b, 0x5143, 0x13b5, 0x1010].includes(Number(id));
export function classify({ renderer, browserGpu, audit, softwareRequested = false, samplesValid = true, dirty = false, headed = false, singleProcess = false, actualHead, expectedHead, windowEndEpochMs }) {
  const identity = [renderer?.unmaskedRenderer, renderer?.unmaskedVendor, browserGpu?.glRenderer,
    ...(browserGpu?.devices ?? []).map(d => d.deviceString)].filter(Boolean).join(' ');
  const software = softwareRequested || SOFTWARE.test(identity);
  const reasons = [];
  if (software) reasons.push('software_or_virtual_renderer');
  if (!renderer?.unmaskedRenderer) reasons.push('unmasked_renderer_missing');
  if (!/nvidia|amd|ati\b|intel|apple|adreno|mali|powervr/i.test(renderer?.unmaskedRenderer ?? '')) reasons.push('positive_hardware_renderer_missing');
  if (!browserGpu?.devices?.length) reasons.push('browser_gpu_device_missing');
  if (browserGpu?.auditError || !browserGpu?.glRenderer || browserGpu?.stableContext !== true) reasons.push('gpu_audit_unavailable');
  if (renderer?.unmaskedRenderer !== browserGpu?.glRenderer) reasons.push('sample_and_audit_renderer_mismatch');
  if (!(browserGpu?.startedAtEpochMs >= windowEndEpochMs && browserGpu?.collectedAtEpochMs >= browserGpu.startedAtEpochMs)) reasons.push('gpu_audit_not_bound_to_window');
  if (Number(browserGpu?.gpuProcessCrashCount) > 0) reasons.push('gpu_process_restart_observed');
  const physical = (audit?.devices ?? []).filter(d => d.accessible && d.hardware === true && hardwareVendor(d.vendorId) && !SOFTWARE.test(d.name ?? ''));
  if (!physical.length) reasons.push('physical_device_access_not_proven');
  const devices = browserGpu?.devices ?? [];
  const activeDevice = devices.find(d => d.active === true) ?? devices[0];
  const browserDevices = activeDevice ? [activeDevice] : [];
  const matched = physical.some(p => browserDevices.some(b => {
    if (p.vendorId !== Number(b.vendorId)) return false;
    if (p.deviceId != null && Number(b.deviceId)) return p.deviceId === Number(b.deviceId);
    const name = p.name?.toLowerCase().replace(/\s+/g, ' ').trim();
    return name && name.length >= 5 && [b.deviceString, renderer?.unmaskedRenderer].some(s => s?.toLowerCase().replace(/\s+/g, ' ').includes(name));
  }));
  if (!matched) reasons.push('browser_and_host_device_not_matched');
  if (!browserDevices.some(d => d.driverVersion)) reasons.push('browser_driver_version_missing');
  // Chrome often has only a combined webgl feature key. Actual scene context proves WebGL2.
  if (browserGpu?.featureStatus?.webgl !== 'enabled' || browserGpu?.featureStatus?.webgl2 && browserGpu.featureStatus.webgl2 !== 'enabled') reasons.push('browser_hardware_webgl_not_enabled');
  if (renderer?.context !== 'webgl2') reasons.push('scene_webgl2_context_not_proven');
  if (!samplesValid) reasons.push('sample_window_invalid');
  if (dirty) reasons.push('uncommitted_checkout');
  if (!headed) reasons.push('headless_synthetic_frame_clock');
  if (singleProcess) reasons.push('single_process_browser');
  if (!/^[a-f\d]{40}$/i.test(expectedHead ?? '')) reasons.push('expected_head_missing_or_not_full_sha');
  else if (expectedHead !== actualHead) reasons.push('expected_head_mismatch');
  return { classification: software ? 'software-diagnostic' : reasons.length ? 'unverified' : 'native-hardware',
    nativeEligible: reasons.length === 0, reasons };
}

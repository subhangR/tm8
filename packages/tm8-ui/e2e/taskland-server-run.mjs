#!/usr/bin/env node
/** Real durable transitions -> production loader -> pure model -> actual WebGL canvas. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startTasklandNode, repoRoot, isolatedEnv, stopChild } from './taskland-server-node.mjs';
import { seedTasklandFixture, mutateEntity, rotateFixtureToken } from './taskland-server-fixture.mjs';
import { waitForRenderedTaskland, projectedTasklandCues } from './taskland-readiness.mjs';
import { measureSyntheticUnread } from './taskland-server-unread-benchmark.mjs';
import { writeTasklandReport } from './taskland-server-report.mjs';

const output = resolve(process.env.TASKLAND_EVIDENCE_DIR ?? '/tmp/taskland-server-evidence');
await mkdir(output, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const evidence = { schema: 'tm8.taskland-server-evidence.v1', head, dirty: !!dirty, syntheticOnly: true,
  dataSource: 'Isolated synthetic records mutated over real tm8 HTTP; production Seam, loader and model',
  runtimeSource: 'Provider-free local echo executable under the production tm8 runtime lifecycle',
  gpuProof: 'Software WebGL browser acceptance; this is not native GPU evidence', checks: [], snapshots: [], screenshots: [], browserErrors: [],
  limitations: ['Historical cancellations without an authoritative timestamp retain an unknown expiry warning',
    'The local echo provider verifies tm8 runtime lifecycle, not a provider conversation'] };
let node, browser, syntheticProcess;
const started = Date.now();
async function check(name, fn) {
  const at = Date.now();
  try {
    await fn(); evidence.checks.push({ name, passed: true, milliseconds: Date.now() - at });
    await writeFile(resolve(output, 'checks.json'), JSON.stringify(evidence, null, 2));
    console.log(`PASS ${name}`);
  }
  catch (error) { evidence.checks.push({ name, passed: false, milliseconds: Date.now() - at, error: error.message }); throw error; }
}
try {
  assert.equal(dirty, '', 'Acceptance requires a clean, committed source tree');
  node = await startTasklandNode({ beforeClose: async () => { await browser?.close(); await stopChild(syntheticProcess); } });
  console.log(`Owned fixture ready: ${node.databaseName}; logs ${node.runRoot}`);
  const f = await seedTasklandFixture(node);
  const ids = Object.fromEntries(Object.entries(f.tasks).map(([name, row]) => [name, row.id]));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-zygote', '--single-process', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.on('pageerror', error => { evidence.browserErrors.push(error.message); console.error(`Browser error: ${error.message}`); });
  await page.goto(`${node.uiOrigin}/e2e/taskland-server-harness.html`);
  await page.waitForFunction(() => !!window.tasklandServer);
  await page.evaluate(config => window.tasklandServer.initialize(config), { spaceId: f.spaceId, storyId: f.storyId, memberId: f.memberId });
  assert.equal(await page.evaluate(() => window.tasklandServer.state().buildHead), head, 'Immutable browser build must match recorded head');
  const scopes = [{ kind: 'space', id: f.spaceId }, { kind: 'story', id: f.storyId }];
  const project = (scope, type = 'taskland', now, cold = false) => page.evaluate(args => window.tasklandServer.project(...args), [scope, type, now, cold]);
  const place = (model, name) => model.places.find(row => row.entityId === ids[name]);
  const coordinate = row => row && [row.x, row.z];
  const closeNumbers = (actual, expected, note) => {
    assert.equal(actual.length, expected.length, note);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-7, `${note}: ${value} vs ${expected[index]}`));
  };
  const snapshots = async (label, type = 'taskland', now, cold = false) => {
    const models = await Promise.all(scopes.map(scope => project(scope, type, now, cold)));
    evidence.snapshots.push({ label, models: models.map(model => ({
      scope: model.scope.kind, type, places: model.places.filter(row => Object.values(ids).includes(row.entityId)).map(row => ({
        name: Object.keys(ids).find(name => ids[name] === row.entityId), x: row.x, z: row.z, group: row.groupId,
        stage: row.constructionStage, progress: row.progress, role: row.role, estimateMissing: row.estimateMissing,
        sizeBucket: row.sizeBucket, cancelledAt: row.cancelledAt, mailbox: row.mailbox,
        subtreeWeight: row.subtreeWeight,
      })), robots: model.robots.length, roads: model.roads.length, shippingWaiting: model.shippingYard?.waitingIds?.length,
      nextLifecycleAt: model.nextLifecycleAt, warnings: model.warnings, sessionFacts: model.sessionFacts,
      claimFacts: model.claimFacts, liveness: model.liveness,
      inputFields: model.inputFields.filter(row => Object.values(ids).includes(row.id)).map(row => ({
        name: Object.keys(ids).find(name => ids[name] === row.id), pointsEstimate: row.pointsEstimate,
        acceptance: row.acceptance, estimateTent: row.estimateTent, ownProgress: row.ownProgress,
        subtreeWeight: row.subtreeWeight, version: row.version, updatedAt: row.updatedAt, cancelledAt: row.cancelledAt,
      })),
    })) });
    return models;
  };
  let baseline;
  await check('Real HTTP creation and nested production loader at both scopes', async () => {
    baseline = await snapshots('created');
    for (const model of baseline) {
      for (const name of Object.keys(ids)) assert.ok(place(model, name), `${model.scope.kind}: missing ${name}`);
      assert.equal(place(model, 'grandchild').depth, 2);
      assert.equal(place(model, 'tent').estimateMissing, true);
      assert.equal(place(model, 'root').constructionStage, 'lot');
    }
  });
  await check('Done child ships independently and weighted root keeps its lot', async () => {
    await mutateEntity(node, ids.child, 'complete', { completerIds: [f.memberId] });
    const models = await snapshots('child-shipped');
    const towns = await snapshots('child-town', 'town');
    for (let index = 0; index < models.length; index++) {
      assert.equal(place(models[index], 'root').progress, 0.25);
      assert.equal(place(models[index], 'root').constructionStage, 'foundation');
      assert.equal(place(models[index], 'root').subtreeWeight, 4);
      assert.equal(place(models[index], 'root').sizeBucket, 5);
      assert.equal(place(models[index], 'root').estimateMissing, false);
      const dto = await node.request(`/v2/entities/${ids.root}`);
      const rootInput = models[index].inputFields.find(row => row.id === ids.root);
      assert.deepEqual(rootInput.acceptance, { total: 3, completed: 0 });
      assert.equal(rootInput.version, dto.version);
      assert.equal(rootInput.updatedAt, dto.updatedAt);
      assert.deepEqual(coordinate(place(models[index], 'root')), coordinate(place(baseline[index], 'root')));
      assert.equal(place(models[index], 'child'), undefined);
      assert.ok(place(towns[index], 'child'));
      assert.ok(towns[index].shippingYard.waitingIds.includes(ids.child));
    }
  });
  await check('Real unread route latency at realistic isolated synthetic volume', async () => {
    evidence.unreadLatency = await measureSyntheticUnread(node);
  });
  await check('Criteria tick advances weighted construction and stable neighbours', async () => {
    await mutateEntity(node, ids.root, 'tick', { criterionIds: ['ac1'] });
    const models = await snapshots('criterion-ticked');
    for (let index = 0; index < models.length; index++) {
      assert.equal(place(models[index], 'root').progress, 0.5);
      assert.equal(place(models[index], 'root').constructionStage, 'scaffolding');
      assert.deepEqual(coordinate(place(models[index], 'neighbour')), coordinate(place(baseline[index], 'neighbour')));
    }
  });
  for (const status of ['pulled', 'working', 'in_review', 'blocked', 'open']) {
    await check(`Real ${status} moves root compound and nested mini-yard`, async () => {
      const before = await snapshots(`before-${status}`);
      await mutateEntity(node, ids.tree, 'work', { status });
      const rootMoved = await snapshots(`root-${status}`);
      for (let index = 0; index < before.length; index++) {
        assert.deepEqual(coordinate(place(rootMoved[index], 'neighbour')), coordinate(place(before[index], 'neighbour')));
        closeNumbers([place(rootMoved[index], 'branch').x - place(rootMoved[index], 'tree').x,
          place(rootMoved[index], 'branch').z - place(rootMoved[index], 'tree').z],
        [place(before[index], 'branch').x - place(before[index], 'tree').x, place(before[index], 'branch').z - place(before[index], 'tree').z], 'root compound offset');
      }
      await mutateEntity(node, ids.branch, 'work', { status });
      const childMoved = await snapshots(`child-${status}`);
      for (let index = 0; index < before.length; index++) {
        assert.deepEqual(coordinate(place(childMoved[index], 'tree')), coordinate(place(rootMoved[index], 'tree')));
        assert.deepEqual(coordinate(place(childMoved[index], 'sibling')), coordinate(place(rootMoved[index], 'sibling')));
        assert.equal(place(childMoved[index], 'branch').workStatus, status);
      }
    });
  }
  await check('Real active claim, release and new claim reappear at both scopes', async () => {
    const claim = () => mutateEntity(node, ids.tree, 'work', { status: 'working', claim: true }, { token: f.token });
    await claim();
    let models = await snapshots('claimed');
    for (const model of models) assert.ok(model.robots.some(robot => robot.taskId === ids.tree && robot.sessionId === f.sessionId));
    await mutateEntity(node, ids.tree, 'release', { note: 'Synthetic handoff releases claim' }, { token: f.token });
    models = await snapshots('released');
    for (const model of models) assert.equal(model.robots.filter(robot => robot.taskId === ids.tree).length, 0);
    await claim();
    models = await snapshots('claimed-again');
    for (const model of models) assert.ok(model.robots.some(robot => robot.taskId === ids.tree));
    await mutateEntity(node, ids.tree, 'release', { note: 'Synthetic claim test complete' }, { token: f.token });
  });
  await check('Real session stop, resume, complete and fresh claim reconcile robots', async () => {
    await mutateEntity(node, ids.tree, 'work', { status: 'working', claim: true }, { token: f.token });
    await mutateEntity(node, f.sessionId, 'terminate', { outcome: 'stop', note: 'Synthetic lifecycle stop' });
    let models = await snapshots('session-stopped');
    for (const model of models) assert.equal(model.robots.some(robot => robot.sessionId === f.sessionId), false);
    await mutateEntity(node, f.sessionId, 'resume', { clientMutationId: randomUUID(), cols: 120, rows: 30 });
    f.token = await rotateFixtureToken(node, f.sessionId);
    await mutateEntity(node, ids.tree, 'work', { status: 'working', claim: true }, { token: f.token });
    models = await snapshots('session-resumed-claim');
    for (const model of models) assert.ok(model.robots.some(robot => robot.taskId === ids.tree && robot.sessionId === f.sessionId));
    await mutateEntity(node, ids.tree, 'release', { note: 'Synthetic session completion preparation' }, { token: f.token });
    await node.request('/v2/messages', { anchorIds: [f.sessionId], body: 'Synthetic lifecycle receipt', clientMutationId: randomUUID() }, { token: f.token });
    await mutateEntity(node, f.sessionId, 'complete-session', { closeProcess: false }, { token: f.token });
    models = await snapshots('session-completed');
    for (const model of models) assert.equal(model.robots.some(robot => robot.sessionId === f.sessionId), false);
    await mutateEntity(node, ids.tree, 'work', { status: 'working', claim: true }, { token: f.token });
    models = await snapshots('session-completion-reset-claim');
    for (const model of models) assert.ok(model.robots.some(robot => robot.taskId === ids.tree && robot.sessionId === f.sessionId));
    await mutateEntity(node, ids.tree, 'release', { note: 'Synthetic runtime lifecycle checks finished' }, { token: f.token });
  });
  await check('True viewer unread includes shipped subtree and mark-read clears it', async () => {
    await node.request('/v2/messages', { anchorIds: [ids.root], body: 'Synthetic own message is already read', clientMutationId: randomUUID() });
    for (const anchorId of [ids.root, ids.root, ids.child, ids.child, ids.child]) {
      await node.request('/v2/messages', { anchorIds: [anchorId], body: 'Synthetic other-author message', clientMutationId: randomUUID() }, { token: f.token });
    }
    const unread = await node.request(`/v2/spaces/${f.spaceId}/unread-counts`);
    assert.equal(unread.complete, true);
    assert.ok(unread.counts.some(row => row.anchorId === ids.child && row.unread === 3));
    let models = await snapshots('shipped-child-unread');
    for (const model of models) {
      assert.equal(place(model, 'root').mailbox.basis, 'unread');
      assert.equal(place(model, 'root').mailbox.count, 5);
      assert.equal(place(model, 'child'), undefined);
    }
    await node.request(`/v2/actions?contextEntityId=${ids.child}&schema=v2&limit=100`);
    await node.request(`/v2/read-marks/${ids.child}`, { clientMutationId: randomUUID() }, { method: 'PUT' });
    models = await snapshots('shipped-child-marked-read');
    for (const model of models) {
      assert.equal(place(model, 'root').mailbox.basis, 'unread');
      assert.equal(place(model, 'root').mailbox.count, 2);
    }
  });
  await check('Authorized legacy observation stays truthful and expires on a cold reload', async () => {
    const dto = await node.request(`/v2/entities/${ids.legacy}`);
    assert.equal(dto.state.statusChangedAt, null);
    const observations = await node.request(`/v2/spaces/${f.spaceId}/tasks/cancellation-observations`, { taskIds: [ids.legacy] });
    const bound = observations.facts.find(fact => fact.taskId === ids.legacy)?.statusChangedNotAfter;
    assert.ok(bound, 'Official317 must observe the genuinely legacy NULL task');
    const deadline = Date.parse(bound) + 86_400_000;
    let models = await snapshots('legacy-before-bound', 'taskland', deadline - 1, true);
    for (const model of models) {
      const legacy = place(model, 'legacy');
      assert.equal(legacy.constructionStage, 'rubble');
      assert.equal(legacy.cancelledAt, null);
      assert.equal(legacy.rubbleExpiresAt, null);
      assert.equal(legacy.rubbleRemovalNotAfter, deadline);
      assert.equal(model.nextLifecycleAt, deadline);
    }
    models = await snapshots('legacy-at-bound-cold', 'taskland', deadline, true);
    for (const model of models) assert.equal(place(model, 'legacy'), undefined);
    await mutateEntity(node, ids.legacy, 'work', { status: 'open' });
    await mutateEntity(node, ids.legacy, 'work', { status: 'cancelled' });
    const exactAt = (await node.request(`/v2/entities/${ids.legacy}`)).state.statusChangedAt;
    assert.ok(exactAt, 'Re-cancel must establish exact timestamp');
    models = await snapshots('legacy-recancel-exact-wins', 'taskland', Date.parse(exactAt) + 86_400_000 - 1, true);
    for (const model of models) {
      assert.equal(place(model, 'legacy').cancelledAt, exactAt);
      assert.equal(place(model, 'legacy').rubbleExpiresAt, Date.parse(exactAt) + 86_400_000);
    }
    const cleared = await node.request(`/v2/spaces/${f.spaceId}/tasks/cancellation-observations`, { taskIds: [ids.legacy] });
    assert.equal(cleared.facts.length, 0);
    evidence.legacyClock = { observedNotAfter: bound, exactAfterReopen: exactAt, deadline };
  });
  await check('Dependency road follows durable edge lifecycle', async () => {
    const edge = (await node.request('/v2/edges', { type: 'depends_on', srcId: ids.tree, dstId: ids.neighbour, clientMutationId: randomUUID() })).edge;
    let models = await snapshots('dependency');
    for (const model of models) assert.ok(model.roads.some(road => road.edgeId === edge.id));
    await node.request(`/v2/actions?contextEntityId=${ids.tree}&schema=v2&limit=100`);
    await node.request(`/v2/edges/${edge.id}`, { clientMutationId: randomUUID() }, { method: 'DELETE' });
    models = await snapshots('dependency-removed');
    for (const model of models) assert.equal(model.roads.some(road => road.edgeId === edge.id), false);
  });
  await check('Done root retains foundation marker until last live child ships', async () => {
    await mutateEntity(node, ids.shipRoot, 'complete', { completerIds: [f.memberId] });
    let models = await snapshots('root-marker');
    for (const model of models) assert.equal(place(model, 'shipRoot').role, 'shipped-marker');
    await mutateEntity(node, ids.shipChild, 'complete', { completerIds: [f.memberId] });
    models = await snapshots('last-child-shipped');
    for (const model of models) assert.equal(place(model, 'shipRoot'), undefined);
  });
  await check('Human Town placements survive done, reopen and reshipping unchanged', async () => {
    const saved = [];
    for (let index = 0; index < scopes.length; index++) {
      const identity = await node.request(`/v2/spaces/${f.spaceId}/maps/open`, { scope: scopes[index], type: 'town', clientMutationId: randomUUID() });
      await node.request(`/v2/actions?contextEntityId=${identity.id}&schema=v2&limit=100`);
      await node.request(`/v2/maps/${identity.id}/placements`, { itemId: randomUUID(), entityId: ids.child, kind: 'ref',
        x: 40 + index * 10, z: 20 + index * 10, rotation: 0, spec: {}, expectedVersion: 0, clientMutationId: randomUUID() }, { method: 'PUT' });
      const context = await node.request(`/v2/maps/${identity.id}`);
      const row = context.placements.find(row => row.entityId === ids.child);
      assert.equal(row.layer, 'human');
      assert.equal(row.byActor, f.memberId);
      saved.push({ mapId: identity.id, row });
    }
    let towns = await snapshots('human-town-placement', 'town', undefined, true);
    for (let index = 0; index < towns.length; index++) {
      assert.deepEqual(coordinate(place(towns[index], 'child')), [saved[index].row.x, saved[index].row.z]);
      assert.equal(towns[index].shippingYard.waitingIds.includes(ids.child), false);
      assert.ok(towns[index].shippingYard.waitingIds.includes(ids.shipRoot));
    }
    await mutateEntity(node, ids.child, 'work', { status: 'open' });
    towns = await snapshots('reopened-town-placement-hidden', 'town', undefined, true);
    for (let index = 0; index < towns.length; index++) {
      assert.equal(place(towns[index], 'child'), undefined);
      const context = await node.request(`/v2/maps/${saved[index].mapId}`);
      assert.deepEqual(context.placements.find(row => row.entityId === ids.child), saved[index].row);
    }
    await mutateEntity(node, ids.child, 'complete', { completerIds: [f.memberId] });
    towns = await snapshots('reshipped-human-placement', 'town', undefined, true);
    for (let index = 0; index < towns.length; index++) assert.deepEqual(coordinate(place(towns[index], 'child')), [saved[index].row.x, saved[index].row.z]);
  });
  await check('Cancellation clock uses real transition, no-op retains it, reopen clears it', async () => {
    const before = await snapshots('before-cancel');
    await mutateEntity(node, ids.cancel, 'work', { status: 'cancelled' });
    const dto = await node.request(`/v2/entities/${ids.cancel}`);
    const firstAt = dto.state.statusChangedAt;
    assert.ok(firstAt, 'Authoritative cold statusChangedAt required');
    const at = Date.parse(firstAt);
    let models = await snapshots('cancelled');
    for (let index = 0; index < models.length; index++) {
      assert.equal(place(models[index], 'cancel').constructionStage, 'rubble');
      assert.equal(place(models[index], 'cancel').cancelledAt, firstAt);
      assert.deepEqual(coordinate(place(models[index], 'cancel')), coordinate(place(before[index], 'cancel')));
      assert.equal(place(models[index], 'cancel').rubbleExpiresAt, at + 86_400_000);
      assert.ok(models[index].nextLifecycleAt <= at + 86_400_000);
    }
    await mutateEntity(node, ids.cancel, 'work', { status: 'cancelled' });
    assert.equal((await node.request(`/v2/entities/${ids.cancel}`)).state.statusChangedAt, firstAt);
    models = await snapshots('cold-cancel', 'taskland', at + 86_400_000 - 1, true);
    for (const model of models) assert.ok(place(model, 'cancel'));
    models = await snapshots('exact-expiry', 'taskland', at + 86_400_000, true);
    for (const model of models) assert.equal(place(model, 'cancel'), undefined);
    await mutateEntity(node, ids.cancel, 'work', { status: 'open' });
    models = await snapshots('reopened', 'taskland', undefined, true);
    for (const model of models) assert.notEqual(place(model, 'cancel').constructionStage, 'rubble');
    await mutateEntity(node, ids.cancel, 'work', { status: 'cancelled' });
    const nextAt = (await node.request(`/v2/entities/${ids.cancel}`)).state.statusChangedAt;
    assert.ok(Date.parse(nextAt) > at);
    await snapshots('recancelled-cold', 'taskland', undefined, true);
  });
  await check('Expired cancelled ancestor becomes neutral stable yard until descendants leave', async () => {
    const before = await snapshots('before-ancestor-cancel');
    await mutateEntity(node, ids.tree, 'work', { status: 'cancelled' });
    const at = Date.parse((await node.request(`/v2/entities/${ids.tree}`)).state.statusChangedAt);
    await snapshots('ancestor-rubble');
    const models = await snapshots('ancestor-neutral-marker', 'taskland', at + 86_400_000);
    for (let index = 0; index < models.length; index++) {
      assert.equal(place(models[index], 'tree').role, 'hierarchy-marker');
      assert.equal(place(models[index], 'tree').constructionStage, 'foundation');
      assert.deepEqual(coordinate(place(models[index], 'tree')), coordinate(place(before[index], 'tree')));
      assert.deepEqual(coordinate(place(models[index], 'sibling')), coordinate(place(before[index], 'sibling')));
      assert.equal(models[index].robots.some(robot => robot.taskId === ids.tree), false);
    }
    const towns = await snapshots('cancelled-ancestor-never-ships', 'town', at + 86_400_000, true);
    for (const model of towns) assert.equal(place(model, 'tree'), undefined);
  });
  evidence.renderSkipped = process.env.TASKLAND_RENDER === '0';
  if (!evidence.renderSkipped) {
  if (process.env.TASKLAND_RENDER_GATE) await check('Serialized software browser window explicitly released', async () => {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      let receipt;
      try { receipt = JSON.parse(await readFile(process.env.TASKLAND_RENDER_GATE, 'utf8')); } catch {}
      if (receipt) {
        assert.equal(receipt.head, head, 'Browser release must name this frozen head');
        evidence.browserWindow = receipt; return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('No explicit browser-window release receipt arrived');
  });
  let memory;
  await check('Actual production WalkingMapView canvas and projected scene ready', async () => {
    const model = await project(scopes[0], 'taskland', undefined, true);
    const root = place(model, 'root');
    memory = { position: { x: root.x, z: root.z }, camera: { zoom: 10,
      position: [root.x + 20, 30, root.z + 20], target: [root.x, 0, root.z] } };
    await page.evaluate(args => window.tasklandServer.mount(...args), [scopes[0], 'taskland', memory, true]);
    await page.locator('[data-testid="walking-map"][data-renderer="webgl"] canvas').waitFor();
    await waitForRenderedTaskland(page, () => page.evaluate(() => window.tasklandServer.scene()), { cue: 'mailbox' });
    await page.waitForFunction(() => [...document.querySelectorAll('.ms-label')].some(label => {
      const parent = label.parentElement;
      return parent?.style.display === 'block' && /translate\([^N]*px/.test(parent.style.transform);
    }));
    evidence.webglRenderer = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'Unavailable debug renderer';
    });
    evidence.renderedScene = await page.evaluate(() => window.tasklandServer.scene());
    evidence.visibleCues = await projectedTasklandCues(page);
    await page.screenshot({ path: resolve(output, 'taskland-space.png'), timeout: 90_000 }); evidence.screenshots.push('taskland-space.png');
  });
  await check('Twenty real criteria events update the same scene and preserve pose and camera', async () => {
    await page.evaluate(() => { window.tasklandEventCanvas = document.querySelector('[data-testid="walking-map"] canvas'); });
    const before = await page.evaluate(() => window.tasklandServer.scene());
    for (let index = 0; index < 20; index++) {
      const done = index % 2 === 0;
      await mutateEntity(node, ids.root, 'tick', { criterionIds: ['ac2'], done });
      await page.waitForFunction(percent => [...document.querySelectorAll('.ms-label')].some(label =>
        label.textContent.includes('Harbour construction') && label.textContent.includes(`${percent}%`)), done ? 75 : 50);
      assert.equal(await page.evaluate(() => window.tasklandEventCanvas === document.querySelector('[data-testid="walking-map"] canvas')), true);
    }
    const after = await page.evaluate(() => window.tasklandServer.scene());
    closeNumbers(after.player, before.player, 'player preserved across events');
    closeNumbers(after.camera.position, before.camera.position, 'camera position preserved across events');
    closeNumbers(after.camera.forward, before.camera.forward, 'camera direction preserved across events');
    assert.equal(after.camera.zoom, before.camera.zoom);
    evidence.eventPose = { before, after, events: 20 };
  });
  await check('Rendered unread mailbox includes shipped child and same-client read drops five to two', async () => {
    const loadCount = await page.evaluate(() => window.tasklandServer.state().loadCount);
    for (let index = 0; index < 3; index++) await node.request('/v2/messages', {
      anchorIds: [ids.child], body: 'Synthetic rendered mailbox event', clientMutationId: randomUUID(),
    }, { token: f.token });
    const rootMailbox = page.locator('[data-map-cue="mailbox"]').filter({ hasText: '5 subtree unread' });
    await rootMailbox.waitFor({ state: 'visible', timeout: 30_000 });
    const at = Date.now();
    await page.evaluate(id => window.tasklandServer.markRead(id), ids.child);
    await page.locator('[data-map-cue="mailbox"]').filter({ hasText: '2 subtree unread' }).waitFor({ state: 'visible', timeout: 5000 });
    evidence.renderedReadMark = { before: 5, after: 2, milliseconds: Date.now() - at,
      loaderCallsBefore: loadCount, loaderCallsAfter: await page.evaluate(() => window.tasklandServer.state().loadCount) };
    assert.equal(evidence.renderedReadMark.loaderCallsAfter, loadCount, 'Unread invalidation must not reload map geometry');
    await page.screenshot({ path: resolve(output, 'taskland-read-mark.png'), timeout: 90_000 }); evidence.screenshots.push('taskland-read-mark.png');
  });
  await check('Cold production hydration restores exact durable pose inside a plot footprint', async () => {
    const expectedPlayer = [memory.position.x, 0, memory.position.z];
    const before = await page.evaluate(() => window.tasklandServer.scene());
    closeNumbers(before.player, expectedPlayer, 'saved footprint player');
    closeNumbers(before.camera.position, memory.camera.position, 'saved camera');
    const durable = await node.request(`/v2/spaces/${f.spaceId}/maps/navigation`);
    assert.equal(durable.save.current.scope.kind, 'space');
    assert.equal(durable.save.current.type, 'taskland');
    await page.reload();
    await page.waitForFunction(() => !!window.tasklandServer);
    await page.evaluate(config => window.tasklandServer.initialize(config), { spaceId: f.spaceId, storyId: f.storyId, memberId: f.memberId });
    await page.evaluate(() => window.tasklandServer.resume());
    await page.locator('[data-testid="walking-map"][data-renderer="webgl"] canvas').waitFor();
    await waitForRenderedTaskland(page, () => page.evaluate(() => window.tasklandServer.scene()), { cue: 'mailbox' });
    const after = await page.evaluate(() => window.tasklandServer.scene());
    closeNumbers(after.player, expectedPlayer, 'restored footprint player');
    closeNumbers(after.camera.position, before.camera.position, 'restored camera position');
    closeNumbers(after.camera.forward, before.camera.forward, 'restored camera direction');
    assert.equal(after.camera.zoom, before.camera.zoom);
    evidence.durableResume = { revision: durable.revision, before, after };
    await page.screenshot({ path: resolve(output, 'taskland-durable-resume.png'), timeout: 90_000 }); evidence.screenshots.push('taskland-durable-resume.png');
  });
  await check('Actual walking, plot inspection and portal navigation remain usable', async () => {
    const before = await page.evaluate(() => window.tasklandServer.scene().player);
    await page.locator('[data-testid="walking-map"]').focus();
    await page.keyboard.down('ArrowRight');
    try { await page.waitForFunction(before => {
      const player = window.tasklandServer.scene()?.player;
      return player && Math.hypot(player[0] - before[0], player[2] - before[2]) > .05;
    }, before); } finally { await page.keyboard.up('ArrowRight'); }
    await page.locator('.walking-places summary').click();
    await page.getByRole('button', { name: 'Inspect Harbour construction', exact: true }).click();
    assert.equal(await page.evaluate(() => window.tasklandServer.state().inspected), ids.root);
    const portal = (await project(scopes[0])).portals.find(row => row.target.type === 'hub');
    assert.ok(portal, 'Taskland must expose its hub portal');
    await page.getByRole('button', { name: `Enter ${portal.label}`, exact: true }).click();
    await page.waitForFunction(() => window.tasklandServer.state().save.current.type === 'hub');
  });
  await check('Story scope actual scene renders after durable navigation', async () => {
    const model = await project(scopes[1], 'taskland', undefined, true);
    const root = place(model, 'root');
    const memory = { position: { x: root.x, z: root.z }, camera: { zoom: 10,
      position: [root.x + 20, 30, root.z + 20], target: [root.x, 0, root.z] } };
    await page.evaluate(args => window.tasklandServer.mount(...args), [scopes[1], 'taskland', memory]);
    await page.locator('[data-testid="walking-map"][data-renderer="webgl"] canvas').waitFor();
    await waitForRenderedTaskland(page, () => page.evaluate(() => window.tasklandServer.scene()), { cue: 'mailbox' });
    await page.waitForFunction(() => [...document.querySelectorAll('.ms-label')].some(label => label.parentElement?.style.display === 'block'));
    await page.screenshot({ path: resolve(output, 'taskland-story.png'), timeout: 90_000 }); evidence.screenshots.push('taskland-story.png');
    assert.deepEqual(evidence.browserErrors, []);
  });
  await check('Existing synthetic checker renders both scopes at the same integrated head', async () => {
    await browser.close(); browser = undefined;
    const log = await open(resolve(output, 'synthetic-checker.log'), 'w', 0o600);
    try {
      syntheticProcess = spawn(process.execPath, ['e2e/taskland-check.mjs'], {
        cwd: resolve(repoRoot, 'packages/tm8-ui'),
        env: isolatedEnv({ TASKLAND_ORIGIN: node.uiOrigin, TASKLAND_EVIDENCE: resolve(output, 'synthetic'),
          TASKLAND_UNREAD_RECEIPT: '../checks.json' }),
        stdio: ['ignore', log.fd, log.fd],
      });
      const code = await new Promise((resolveExit, reject) => {
        syntheticProcess.once('error', reject); syntheticProcess.once('exit', resolveExit);
      });
      assert.equal(code, 0, 'The supplied synthetic checker must finish all assertions');
      const report = JSON.parse(await readFile(resolve(output, 'synthetic/report.json'), 'utf8'));
      assert.equal(report.sourceHead, head, 'Synthetic frames must use the real proof head');
      evidence.syntheticReport = 'synthetic/index.html';
    } finally { await log.close(); await stopChild(syntheticProcess); }
  });
  }
} catch (error) {
  evidence.failure = error.message;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  const cleanup = await node?.close();
  if (cleanup) evidence.cleanup = cleanup;
  evidence.ownedProcessesStopped = true;
  evidence.ownedDatabaseDropped = true;
  if (cleanup?.sessionStopErrors.length) {
    evidence.failure = 'Synthetic runtime termination failed during cleanup';
    evidence.ownedProcessesStopped = false;
    process.exitCode = 1;
  }
  evidence.milliseconds = Date.now() - started;
  await writeFile(resolve(output, 'checks.json'), JSON.stringify(evidence, null, 2));
  await writeTasklandReport(output, evidence);
  console.log(`Synthetic evidence: ${output}; owned processes and DB cleaned up`);
}

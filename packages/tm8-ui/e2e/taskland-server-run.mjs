#!/usr/bin/env node
/** Real durable transitions -> production loader -> pure model -> actual WebGL canvas. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startTasklandNode, repoRoot } from './taskland-server-node.mjs';
import { seedTasklandFixture, mutateEntity, rotateFixtureToken } from './taskland-server-fixture.mjs';
import { waitForRenderedTaskland, projectedTasklandCues } from './taskland-readiness.mjs';

const output = resolve(process.env.TASKLAND_EVIDENCE_DIR ?? '/tmp/taskland-server-evidence');
await mkdir(output, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const evidence = { schema: 'tm8.taskland-server-evidence.v1', head, dirty: !!dirty, syntheticOnly: true,
  gpuProof: 'Software WebGL browser acceptance; this is not native GPU evidence', checks: [], snapshots: [], screenshots: [], limitations: [] };
let node, browser;
const started = Date.now();
async function check(name, fn) {
  const at = Date.now();
  try { await fn(); evidence.checks.push({ name, passed: true, milliseconds: Date.now() - at }); console.log(`PASS ${name}`); }
  catch (error) { evidence.checks.push({ name, passed: false, milliseconds: Date.now() - at, error: error.message }); throw error; }
}
try {
  node = await startTasklandNode();
  console.log(`Owned fixture ready: ${node.databaseName}; logs ${node.runRoot}`);
  const f = await seedTasklandFixture(node);
  const ids = Object.fromEntries(Object.entries(f.tasks).map(([name, row]) => [name, row.id]));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => console.error(`Browser error: ${error.message}`));
  await page.goto(`${node.uiOrigin}/e2e/taskland-server-harness.html`);
  await page.waitForFunction(() => !!window.tasklandServer);
  await page.evaluate(config => window.tasklandServer.initialize(config), { spaceId: f.spaceId, storyId: f.storyId, memberId: f.memberId });
  const scopes = [{ kind: 'space', id: f.spaceId }, { kind: 'story', id: f.storyId }];
  const project = (scope, type = 'taskland', now, cold = false) => page.evaluate(args => window.tasklandServer.project(...args), [scope, type, now, cold]);
  const place = (model, name) => model.places.find(row => row.entityId === ids[name]);
  const coordinate = row => row && [row.x, row.z];
  const snapshots = async (label, type = 'taskland', now, cold = false) => {
    const models = await Promise.all(scopes.map(scope => project(scope, type, now, cold)));
    evidence.snapshots.push({ label, models: models.map(model => ({
      scope: model.scope.kind, type, places: model.places.filter(row => Object.values(ids).includes(row.entityId)).map(row => ({
        name: Object.keys(ids).find(name => ids[name] === row.entityId), x: row.x, z: row.z, group: row.groupId,
        stage: row.constructionStage, progress: row.progress, role: row.role, estimateMissing: row.estimateMissing,
        sizeBucket: row.sizeBucket, cancelledAt: row.cancelledAt, mailbox: row.mailbox,
      })), robots: model.robots.length, roads: model.roads.length, shippingWaiting: model.shippingYard?.waitingIds?.length,
      nextLifecycleAt: model.nextLifecycleAt, warnings: model.warnings,
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
      assert.deepEqual(coordinate(place(models[index], 'root')), coordinate(place(baseline[index], 'root')));
      assert.equal(place(models[index], 'child'), undefined);
      assert.ok(place(towns[index], 'child'));
      assert.ok(towns[index].shippingYard.waitingIds.includes(ids.child));
    }
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
        assert.deepEqual([place(rootMoved[index], 'branch').x - place(rootMoved[index], 'tree').x,
          place(rootMoved[index], 'branch').z - place(rootMoved[index], 'tree').z],
        [place(before[index], 'branch').x - place(before[index], 'tree').x, place(before[index], 'branch').z - place(before[index], 'tree').z]);
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
    await node.request('/v2/messages', { anchorIds: [ids.child], body: 'Synthetic shipped child message', clientMutationId: randomUUID() }, { token: f.token });
    const unread = await node.request(`/v2/spaces/${f.spaceId}/unread-counts`);
    assert.equal(unread.complete, true);
    assert.ok(unread.counts.some(row => row.anchorId === ids.child && row.unread === 1));
    let models = await snapshots('shipped-child-unread');
    for (const model of models) {
      assert.equal(place(model, 'root').mailbox.basis, 'unread');
      assert.equal(place(model, 'root').mailbox.count, 1);
      assert.equal(place(model, 'child'), undefined);
    }
    await node.request(`/v2/actions?contextEntityId=${ids.child}&schema=v2&limit=100`);
    await node.request(`/v2/read-marks/${ids.child}`, { clientMutationId: randomUUID() }, { method: 'PUT' });
    models = await snapshots('shipped-child-marked-read');
    for (const model of models) {
      assert.equal(place(model, 'root').mailbox.basis, 'unread');
      assert.equal(place(model, 'root').mailbox.count, 0);
    }
  });
  await check('Dependency road follows durable edge lifecycle', async () => {
    const edge = (await node.request('/v2/edges', { type: 'depends_on', srcId: ids.tree, dstId: ids.neighbour, clientMutationId: randomUUID() })).edge;
    let models = await snapshots('dependency');
    for (const model of models) assert.ok(model.roads.some(road => road.edgeId === edge.id));
    await node.request(`/v2/edges/${edge.id}`, { expectedVersion: edge.version }, { method: 'DELETE' });
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
      assert.deepEqual(coordinate(place(models[index], 'cancel')), coordinate(place(before[index], 'cancel')));
      assert.equal(models[index].nextLifecycleAt, at + 86_400_000);
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
  await check('Actual production WalkingMapView canvas and projected scene ready', async () => {
    await page.evaluate(scope => window.tasklandServer.mount(scope, 'taskland'), scopes[0]);
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
    await page.screenshot({ path: resolve(output, 'taskland-space.png') }); evidence.screenshots.push('taskland-space.png');
    await page.evaluate(scope => window.tasklandServer.mount(scope, 'taskland'), scopes[1]);
    await page.locator('[data-testid="walking-map"][data-renderer="webgl"] canvas').waitFor();
    await waitForRenderedTaskland(page, () => page.evaluate(() => window.tasklandServer.scene()), { cue: 'mailbox' });
    await page.waitForFunction(() => [...document.querySelectorAll('.ms-label')].some(label => label.parentElement?.style.display === 'block'));
    await page.screenshot({ path: resolve(output, 'taskland-story.png') }); evidence.screenshots.push('taskland-story.png');
  });
} catch (error) {
  evidence.failure = error.message;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await node?.close();
  evidence.ownedProcessesStopped = true;
  evidence.ownedDatabaseDropped = true;
  evidence.milliseconds = Date.now() - started;
  await writeFile(resolve(output, 'checks.json'), JSON.stringify(evidence, null, 2));
  console.log(`Synthetic evidence: ${output}; owned processes and DB cleaned up`);
}

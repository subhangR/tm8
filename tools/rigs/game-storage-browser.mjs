/** Browser acceptance uses the production adapter and independently observes the real Three scene. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { request, repoRoot, runRoot, uiPort } from './game-storage-node.mjs';
import { dataOf } from './game-storage-fixture.mjs';
import { ledgerSize } from './game-storage-cost.mjs';
import { createBrowserLifecycle, gameStorageLaunchOptions } from './game-storage-browser-lifecycle.mjs';
const require = createRequire(`${repoRoot}/packages/tm8-ui/package.json`);
const { chromium, expect } = require('@playwright/test');
const keyOf = value => JSON.stringify([value.scope.kind, value.scope.id, value.type]);
const lifecycle = createBrowserLifecycle(chromium, { launchOptions: gameStorageLaunchOptions() });
const launchBrowser = () => lifecycle.launch();
const closeBrowser = browser => lifecycle.closeBrowser(browser);
const closeContext = (context, browser) => lifecycle.closeContext(context, browser);
const evaluate = (page, label, expression, argument) => lifecycle.evaluate(page, label, expression, argument);
export const browserDiagnostics = () => lifecycle.diagnostics();

export async function verifyBrowserDurability(f, restartServer, record) {
  let browser;
  const errors = [];
  const requestedRevisions = [];
  const pointerTrials = [];
  const url = `http://127.0.0.1:${uiPort}/e2e/game-storage-harness.html?${new URLSearchParams({
    space: f.spaceId, member: f.owner.memberId, story: f.storyId, nested: f.nestedStoryId, task: f.taskId,
  })}`;
  const navPath = `/v2/spaces/${f.spaceId}/maps/navigation`;
  const nav = async () => dataOf(await request(navPath), 'browser navigation read');
  const write = async state => {
    const initial = await nav();
    return dataOf(await request(navPath, { save: state, expectedRevision: initial.revision, clientMutationId: randomUUID() }, { method: 'PUT' }), 'browser fixture save');
  };
  let context;
  const newPage = async (motion = 'reduce') => {
    // Every restored visit owns a fresh browser process and an isolated renderer.
    await closeBrowser(browser); browser = await launchBrowser();
    context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: motion });
    await context.addInitScript(() => { window.__storageInitiallyEmpty = localStorage.length === 0; });
    const page = lifecycle.observePage(await context.newPage(), browser); page.setDefaultTimeout(90_000);
    page.on('request', request => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === navPath) {
        requestedRevisions.push(request.postDataJSON().expectedRevision);
      }
    });
    page.on('pageerror', error => { errors.push(error.name); console.log(JSON.stringify({ stage: 'synthetic browser error', name: error.name, message: String(error.message).split('\n')[0].slice(0, 250) })); });
    page.on('response', response => { if (response.status() >= 400) console.log(JSON.stringify({ stage: 'synthetic browser response', status: response.status(), path: new URL(response.url()).pathname })); });
    await page.goto(url);
    try { await page.getByTestId('walking-map').waitFor(); }
    catch (error) { console.log(JSON.stringify({ stage: 'synthetic browser DOM', text: (await page.locator('body').innerText()).slice(0, 500) })); throw error; }
    return page;
  };
  const local = page => evaluate(page, 'local navigation memory', () => {
    const key = Object.keys(localStorage).find(key => key.startsWith('tm8:game:v1:'));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  const scene = page => evaluate(page, 'visible scene', () => window.__storageHarness.scene());
  const model = (page, key) => evaluate(page, 'plain model geometry', key => window.__storageHarness.model(key), key);
  const ready = async page => {
    const host = page.getByTestId('walking-map'); await expect(host).toHaveAttribute('data-renderer', 'webgl');
    await expect.poll(async () => { const current = await scene(page); return !!current?.player && current.drawCalls > 0; }, { timeout: 90_000 }).toBe(true);
    console.log(JSON.stringify({ stage: 'synthetic actual scene ready' }));
  };
  const waitCurrent = async (page, type, kind, id) => {
    await expect.poll(async () => (await local(page))?.current).toMatchObject({ type, scope: { kind, id } });
    await ready(page);
  };
  const enter = async (page, name) => {
    console.log(JSON.stringify({ stage: 'synthetic portal entry', name }));
    const places = page.getByTestId('walking-map').locator('details.walking-places');
    if (!(await places.evaluate(node => node.open))) await places.locator('summary').click();
    const portal = places.getByRole('button', { name: `Enter ${name}`, exact: true });
    // Diagnose pointer actionability, then use the ordinary accessible keyboard activation.
    try { await portal.click({ trial: true, timeout: 3_000 }); pointerTrials.push(true); console.log(JSON.stringify({ stage: 'synthetic portal pointer actionability', name, actionable: true })); }
    catch (error) { pointerTrials.push(false); console.log(JSON.stringify({ stage: 'synthetic portal pointer actionability', name, actionable: false, message: String(error.message).slice(0, 1_200) })); }
    await portal.focus(); await portal.press('Enter');
  };
  const assertScene = async (page, memory) => {
    await ready(page); const live = await scene(page);
    assert.deepEqual(live.player, [memory.position.x, 0, memory.position.z], 'actual scene player restores exact pose');
    assert.deepEqual(live.camera.position, memory.camera.position, 'actual camera restores all position components');
    assert.equal(live.camera.zoom, memory.camera.zoom, 'actual camera restores exact zoom');
    const direction = memory.camera.target.map((value, index) => value - memory.camera.position[index]);
    const length = Math.hypot(...direction);
    direction.forEach((value, index) => assert.ok(Math.abs(value / length - live.camera.forward[index]) < 1e-12, 'actual camera points at saved target'));
  };
  const check = async (name, fn) => { const started = Date.now(); try { await fn(); record({ name, passed: true, elapsedMs: Date.now() - started,
    portalActivation: 'accessible keyboard focus and Enter', pointerTrials: { count: pointerTrials.length, actionable: pointerTrials.filter(Boolean).length, rejected: pointerTrials.filter(value => !value).length } }); }
    catch (error) { console.log(JSON.stringify({ stage: 'synthetic journey failure detail', name, message: String(error.message).slice(0, 2_000), stack: String(error.stack).split('\n').slice(0, 5) })); record({ name, passed: false, elapsedMs: Date.now() - started, reason: String(error.message).slice(0, 250) }); throw error; } };

  try {
    let before, currentKey;
    await check('nested walk camera and return stack survive real API restart and fresh browser', async () => {
      const initial = await nav(); assert.equal(initial.save, null); assert.equal(initial.revision, 0);
      const page = await newPage();
      await waitCurrent(page, 'hub', 'space', f.spaceId);
      assert.equal(await evaluate(page, 'page state', () => window.__storageInitiallyEmpty), true);
      await expect(page.getByText('Server save is unavailable.', { exact: false })).toHaveCount(0);
      await enter(page, 'Synthetic harbour story'); await waitCurrent(page, 'hub', 'story', f.storyId);
      await enter(page, 'Synthetic mountain story'); await waitCurrent(page, 'hub', 'story', f.nestedStoryId);
      await enter(page, 'Taskland'); await waitCurrent(page, 'taskland', 'story', f.nestedStoryId);
      const host = page.getByTestId('walking-map'); await host.focus();
      const atEntrance = (await scene(page)).player;
      await page.keyboard.down('d'); await page.waitForTimeout(240); await page.keyboard.up('d');
      await host.locator('.sgm-stage canvas').hover({ position: { x: 40, y: 120 } }); await page.mouse.wheel(0, 160);
      await expect.poll(async () => (await scene(page)).player[0]).toBeGreaterThan(atEntrance[0]);
      await page.waitForTimeout(1_300);
      await evaluate(page, 'page state', () => window.dispatchEvent(new Event('pagehide')));
      const browserSave = await local(page); currentKey = keyOf(browserSave.current);
      try { await expect.poll(async () => (await nav()).save.maps[currentKey], { timeout: 10_000 }).toEqual(browserSave.maps[currentKey]); }
      catch (error) {
        const server = await nav(), expected = browserSave.maps[currentKey], actual = server.save?.maps[currentKey];
        console.log(JSON.stringify({ stage: 'synthetic forced-save mismatch', revision: server.revision,
          requestedRevisions, repairs: server.repairs, expected, actual,
          notice: await page.locator('.game-mode__notice').allTextContents(),
          saveObservations: await evaluate(page, 'page state', () => window.__storageHarness.saveObservations) }));
        throw error;
      }
      before = (await nav()).save;
      assert.equal(requestedRevisions[0], 0, 'healthy first visit first write expects revision zero');
      record({ name: 'healthy first GET null has no unavailable notice and first write expects revision zero', passed: true });
      assert.equal(before.stack.length, 3); assert.equal(before.current.scope.id, f.nestedStoryId);
      let memory = before.maps[currentKey]; assert.ok(memory.position && memory.camera);
      assert.ok([...Object.values(memory.position), memory.camera.zoom, ...memory.camera.position, ...memory.camera.target].every(Number.isFinite));
      const { bounds } = await model(page, currentKey);
      assert.ok(memory.position.x >= bounds.minX && memory.position.x <= bounds.maxX && memory.position.z >= bounds.minZ && memory.position.z <= bounds.maxZ);
      await page.screenshot({ path: `${runRoot}/synthetic-before-restart.png` });
      await closeContext(context, browser);
      // Camera easing can produce a later idle/unload flush during screenshot readback.
      // The final durable server snapshot is the restart's authoritative expectation.
      await new Promise(resolve => setTimeout(resolve, 500));
      before = (await nav()).save; memory = before.maps[currentKey];
      await restartServer();
      const fresh = await newPage();
      assert.equal(await fresh.evaluate(() => window.__storageInitiallyEmpty), true, 'restart context starts with empty browser storage');
      await waitCurrent(fresh, 'taskland', 'story', f.nestedStoryId);
      await assertScene(fresh, memory);
      const restored = await local(fresh); assert.deepEqual(restored.current, before.current); assert.deepEqual(restored.stack, before.stack);
      assert.deepEqual(restored.maps[currentKey], memory);
      await fresh.screenshot({ path: `${runRoot}/synthetic-after-restart.png` });
      await closeContext(context, browser);
    });
    await check('finite saved pose inside a building footprint restores in the visible scene', async () => {
      const page = await newPage(); await waitCurrent(page, 'taskland', 'story', f.nestedStoryId);
      const geometry = await model(page, currentKey); assert.ok(geometry.places.length);
      const place = geometry.places[0]; await closeContext(context, browser);
      const state = structuredClone(before); state.maps[currentKey] = { position: { x: place.x, z: place.z },
        camera: { zoom: 23, position: [place.x + 12, 18, place.z + 11], target: [place.x, 0.3, place.z] } };
      await write(state); const fresh = await newPage(); await waitCurrent(fresh, 'taskland', 'story', f.nestedStoryId);
      await assertScene(fresh, state.maps[currentKey]);
      assert.deepEqual((await local(fresh)).maps[currentKey], state.maps[currentKey]);
      await closeContext(context, browser);
    });
    await check('default motion restores exact scene immediately and after three idle seconds', async () => {
      const durable = (await nav()).save;
      const memory = durable.maps[keyOf(durable.current)];
      assert.ok(memory?.position && memory?.camera, 'default-motion probe requires durable pose and camera');
      const page = await newPage('no-preference');
      assert.equal(await evaluate(page, 'page state', () => window.__storageInitiallyEmpty), true);
      await waitCurrent(page, durable.current.type, durable.current.scope.kind, durable.current.scope.id);
      await assertScene(page, memory);
      await page.waitForTimeout(3_000);
      await assertScene(page, memory);
      record({ name: 'default-motion scene observation controls', passed: true, browserMotionPreference: 'no-preference', initialExact: true, idleThreeSecondsExact: true });
      await closeContext(context, browser);
    });
    await check('bounds repair clamps actual player and discards the stale camera', async () => {
      const state = structuredClone(before); state.maps[currentKey] = { position: { x: 999_999, z: -999_999 },
        camera: { zoom: 19, position: [1, 2, 3], target: [4, 5, 6] } };
      await write(state); const fresh = await newPage(); await waitCurrent(fresh, 'taskland', 'story', f.nestedStoryId);
      const geometry = await model(fresh, currentKey), repaired = await local(fresh);
      assert.deepEqual(repaired.maps[currentKey].position, { x: geometry.bounds.maxX, z: geometry.bounds.minZ });
      assert.equal(repaired.maps[currentKey].camera, undefined, 'repaired memory discarded old camera');
      const live = await scene(fresh); assert.deepEqual(live.player, [geometry.bounds.maxX, 0, geometry.bounds.minZ]);
      assert.notDeepEqual(live.camera.position, state.maps[currentKey].camera.position);
      await closeContext(context, browser);
    });
    await check('unvisited Office entrance exact pose camera resume and restored story hub Back', async () => {
      const page = await newPage(); await waitCurrent(page, 'taskland', 'story', f.nestedStoryId);
      const host = page.getByTestId('walking-map'); await host.focus(); await page.keyboard.press('Escape');
      await waitCurrent(page, 'hub', 'story', f.nestedStoryId);
      await enter(page, 'Office'); await waitCurrent(page, 'office', 'story', f.nestedStoryId);
      const state = await local(page), geometry = await model(page, keyOf(state.current));
      assert.deepEqual((await scene(page)).player, [geometry.entrance.x, 0, geometry.entrance.z]);
      await host.focus(); await page.keyboard.down('d'); await page.waitForTimeout(200); await page.keyboard.up('d');
      await host.locator('.sgm-stage canvas').hover({ position: { x: 40, y: 120 } }); await page.mouse.wheel(0, 100); await page.waitForTimeout(1_300);
      await evaluate(page, 'page state', () => window.dispatchEvent(new Event('pagehide')));
      const office = await local(page), officeKey = keyOf(office.current);
      await expect.poll(async () => (await nav()).save?.maps[officeKey]).toEqual(office.maps[officeKey]);
      await closeContext(context, browser);
      const fresh = await newPage(); await waitCurrent(fresh, 'office', 'story', f.nestedStoryId);
      await assertScene(fresh, office.maps[officeKey]);
      const freshHost = fresh.getByTestId('walking-map');
      await freshHost.focus(); await fresh.keyboard.press('Escape'); await waitCurrent(fresh, 'hub', 'story', f.nestedStoryId);
      const hubKey = keyOf((await local(fresh)).current);
      assert.ok(office.maps[hubKey]?.camera && office.maps[hubKey]?.position, 'story hub pose and camera memory exist');
      await assertScene(fresh, office.maps[hubKey]);
      await freshHost.focus(); await fresh.keyboard.press('Escape'); await waitCurrent(fresh, 'hub', 'story', f.storyId);
      await closeContext(context, browser); assert.equal(errors.length, 0, 'browser page errors');
    });
    await check('real human Town placement appears at persisted coordinates in actual Three geometry', async () => {
      const entity = dataOf(await request('/v2/entities', { kind: 'task', title: 'Synthetic shipped building',
        spaceId: f.spaceId, clientMutationId: randomUUID() }), 'Town shipped fixture').entity;
      dataOf(await request(`/v2/entities/${entity.id}/commands/complete`, { expectedVersion: entity.version,
        completerIds: [f.owner.memberId], clientMutationId: randomUUID() }), 'complete synthetic shipped task');
      const town = dataOf(await request(`/v2/spaces/${f.spaceId}/maps/open`, { type: 'town', scope: { kind: 'space', id: f.spaceId },
        clientMutationId: randomUUID() }), 'Town identity');
      dataOf(await request(`/v2/maps/${town.id}/placements`, { itemId: randomUUID(), entityId: entity.id,
        kind: 'ref', x: 7, z: 8, expectedVersion: 0, clientMutationId: randomUUID() }, { method: 'PUT', token: f.member.token }), 'human Town placement');
      const page = await newPage(); await waitCurrent(page, 'hub', 'story', f.storyId);
      await page.getByTestId('walking-map').focus(); await page.keyboard.press('Escape');
      await waitCurrent(page, 'hub', 'space', f.spaceId); await enter(page, 'Completed Town');
      await waitCurrent(page, 'town', 'space', f.spaceId);
      const geometry = await model(page, keyOf((await local(page)).current));
      assert.ok(geometry.places.some(place => place.entityId === entity.id && place.x === 7 && place.z === 8));
      assert.ok((await scene(page)).plots.some(position => position[0] === 7 && position[2] === 8), 'actual clickable building group moved to stored coordinates');
      await page.screenshot({ path: `${runRoot}/synthetic-town-placement.png` });
      await closeContext(context, browser);
    });
  } finally { await closeContext(context, browser).catch(() => {}); await closeBrowser(browser); }
}

export async function verifyWalkingTraffic(f, pool, record) {
  const browser = await launchBrowser();
  const page = lifecycle.observePage(await browser.newPage({ viewport: { width: 800, height: 600 }, reducedMotion: 'reduce' }), browser);
  await page.addInitScript(() => {
    const send = window.fetch.bind(window);
    window.__traffic = [];
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), location.href);
      if (init?.method === 'PUT' && url.pathname.endsWith('/maps/navigation')) {
        window.__traffic.push({ at: Date.now(), keepalive: init.keepalive === true });
      }
      return send(input, init);
    };
  });
  const url = `http://127.0.0.1:${uiPort}/e2e/game-storage-harness.html?${new URLSearchParams({
    space: f.spaceId, member: f.owner.memberId, story: f.storyId, nested: f.nestedStoryId, task: f.taskId,
  })}`;
  let writes = 0, wireBytes = 0;
  try {
    await page.goto(url); const host = page.getByTestId('walking-map'); await host.waitFor();
    await expect.poll(() => evaluate(page, 'page state', () => !!window.__storageHarness.scene()?.player), { timeout: 90_000 }).toBe(true);
    const before = await ledgerSize(pool);
    page.on('request', request => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/maps/navigation')) {
        writes++; wireBytes += Buffer.byteLength(request.postData() ?? '');
      }
    });
    const started = Date.now();
    for (let index = 0; index < 12; index++) {
      const direction = index % 2 ? 'a' : 'd';
      await host.focus(); await page.keyboard.down(direction);
      await page.waitForTimeout(Math.max(0, started + (index + 1) * 5_000 - Date.now()));
      await page.keyboard.up(direction);
      if (index === 5) console.log(JSON.stringify({ stage: 'synthetic walking traffic', seconds: 30, writes }));
    }
    await evaluate(page, 'page state', () => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(async () => {
      const view = dataOf(await request(`/v2/spaces/${f.spaceId}/maps/navigation`), 'walk final save');
      const local = await evaluate(page, 'page state', () => { const key = Object.keys(localStorage).find(key => key.startsWith('tm8:game:v1:')); return JSON.parse(localStorage.getItem(key)); });
      try { assert.deepEqual(view.save.maps, local.maps); return true; } catch { return false; }
    }).toBe(true);
    const after = await ledgerSize(pool), elapsedMs = Date.now() - started;
    const traffic = await evaluate(page, 'page state', () => window.__traffic);
    const regular = traffic.filter(send => !send.keepalive && send.at >= started && send.at < started + 60_000).length;
    const additionalRegular = traffic.filter(send => !send.keepalive && send.at >= started + 60_000).length;
    const pagehideFlushes = traffic.filter(send => send.keepalive && send.at >= started).length;
    record({ name: '60 second scripted walk persistence request and ledger growth', passed: regular <= 20,
      elapsedMs, navigationWrites: writes, savesPerMinute: writes * 60_000 / elapsedMs, requestBytes: wireBytes,
      regularWritesIn60Seconds: regular, additionalRegularWrites: additionalRegular,
      pagehideFlushes, routeFlushes: 0, visibilityFlushes: 0, renderer: 'SwiftShader software functional diagnostics',
      memoryCount: Object.keys(dataOf(await request(`/v2/spaces/${f.spaceId}/maps/navigation`), 'walk save').save.maps).length,
      inputRowsGrowth: after.inputRows - before.inputRows, inputBytesGrowth: after.inputBytes - before.inputBytes,
      ledgerRowsGrowth: after.ledgerRows - before.ledgerRows, ledgerBytesGrowth: after.ledgerBytes - before.ledgerBytes });
  } finally { await closeBrowser(browser); }
}

export async function verifyLegacyMigration(f, record) {
  const started = Date.now();
  let browser;
  const root = { type: 'hub', scope: { kind: 'space', id: f.spaceId } };
  const story = { type: 'hub', scope: { kind: 'story', id: f.storyId } };
  const nested = { type: 'hub', scope: { kind: 'story', id: f.nestedStoryId } };
  const current = { type: 'taskland', scope: nested.scope };
  const prior = { type: 'taskland', scope: root.scope };
  const legacy = { version: 1, spaceId: f.spaceId, memberId: f.owner.memberId, current, stack: [root, story, nested], maps: {
    [keyOf(current)]: { position: { x: 0, z: 6 }, camera: { zoom: 23, position: [24, 23, 30], target: [0, 0.3, 6] } },
    [keyOf(prior)]: { position: { x: 1, z: 6 }, camera: { zoom: 21, position: [25, 23, 30], target: [1, 0.3, 6] } },
  } };
  const validMemories = structuredClone(legacy.maps);
  legacy.maps[JSON.stringify(['story', 'legacy-nonuuid', 'taskland'])] = {
    position: { x: 1, z: 2 }, camera: { zoom: 20, position: [24, 23, 24], target: [1, 0.3, 2] },
  };
  const navPath = `/v2/spaces/${f.spaceId}/maps/navigation`;
  const nav = async () => dataOf(await request(navPath), 'legacy navigation get');
  const url = `http://127.0.0.1:${uiPort}/e2e/game-storage-harness.html?${new URLSearchParams({
    space: f.spaceId, member: f.owner.memberId, story: f.storyId, nested: f.nestedStoryId, task: f.taskId,
  })}`;
  let context;
  try {
    assert.equal((await nav()).save, null, 'legacy migration starts with GET null');
    for (const migrating of [true, false]) {
      await closeBrowser(browser); browser = await launchBrowser();
      context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: 'reduce' });
      if (migrating) await context.addInitScript(save => {
        localStorage.setItem(`tm8:game:v1:${JSON.stringify([save.spaceId, save.memberId])}`, JSON.stringify(save));
      }, legacy);
      const page = lifecycle.observePage(await context.newPage(), browser);
      await page.goto(url); await page.getByTestId('walking-map').waitFor();
      await expect.poll(async () => {
        const saved = (await nav()).save?.maps;
        return saved && Object.entries(validMemories).every(([key, memory]) => JSON.stringify(saved[key]) === JSON.stringify(memory)) &&
          !Object.keys(saved).some(key => key.includes('legacy-nonuuid'));
      }).toBe(true);
      await expect.poll(async () => await evaluate(page, 'page state', () => window.__storageHarness.scene()?.player), { timeout: 90_000 }).toEqual([0, 0, 6]);
      const live = await evaluate(page, 'page state', () => window.__storageHarness.scene());
      assert.deepEqual(live.camera.position, legacy.maps[keyOf(current)].camera.position);
      assert.equal(live.camera.zoom, legacy.maps[keyOf(current)].camera.zoom);
      const persisted = (await nav()).save;
      assert.deepEqual(persisted.current, legacy.current); assert.deepEqual(persisted.stack, legacy.stack);
      await closeContext(context, browser);
    }
    record({ name: 'legacy browser v1 valid current and prior memories migrate despite malformed key then fresh browser', passed: true, elapsedMs: Date.now() - started });
  } catch (error) { record({ name: 'legacy browser v1 valid current and prior memories migrate despite malformed key then fresh browser', passed: false,
    elapsedMs: Date.now() - started, reason: String(error.message).split('\n')[0] }); throw error; }
  finally { await closeContext(context, browser).catch(() => {}); await closeBrowser(browser); }
}

import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitForRenderedTaskland, projectedTasklandCues } from './taskland-readiness.mjs';

const origin = process.env.TASKLAND_ORIGIN ?? 'http://127.0.0.1:4637';
const evidence = resolve(process.env.TASKLAND_EVIDENCE ?? 'gate-evidence/taskland');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.TASKLAND_CHROMIUM ? { executablePath: process.env.TASKLAND_CHROMIUM } : {}),
  args: ['--no-zygote', '--single-process', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' });
const errors = [], assetFailures = [], transitions = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (/\.(glb|gltf)(\?|$)/.test(response.url()) && !response.ok()) assetFailures.push({ status: response.status(), path: new URL(response.url()).pathname }); });
async function state() { return page.evaluate(() => JSON.parse(JSON.stringify(window.__tasklandHarness))); }
async function ready(cue = 'mailbox') {
  await waitForRenderedTaskland(page, state, { cue });
}
async function capture(scope, name, cue) {
  await ready(cue);
  const snapshot = await state();
  await page.screenshot({ path: `${evidence}/${scope}-${name}.png`, timeout: 90000 });
  const visibleCues = await projectedTasklandCues(page);
  transitions.push({ scope, name, type: snapshot.type, revision: snapshot.revision,
    places: snapshot.model.places.map(({ entityId, status, progress, constructionStage, role, mailbox, attention, badges, subtreeWeight, rubbleExpiresAt }) =>
      ({ entityId, status, progress, constructionStage, role, mailbox, attention, badges, subtreeWeight, rubbleExpiresAt })),
    robots: snapshot.model.robots.map(({ taskId, pose }) => ({ taskId, pose })),
    workerIds: await page.locator('[data-worker-id]').evaluateAll(nodes => nodes.map(n => n.dataset.workerId)),
    motion: snapshot.motion, motionTime: snapshot.motionTime, reducedMotion: snapshot.reducedMotion,
    nextLifecycleAt: snapshot.model.nextLifecycleAt, stats: snapshot.stats, assets: snapshot.assets, visibleCues });
}
const place = (snapshot, id) => snapshot.model.places.find(p => p.entityId === id);
async function action(name) { await page.getByRole('button', { name, exact: true }).click(); }
async function motion(kind, entityId, members) {
  await expect.poll(async () => (await state()).motion?.transitions.some(t => t.kind === kind && t.entityId === entityId), {
    timeout: 15000, message: `Wait for committed production ${kind} transition for ${entityId}`,
  }).toBe(true);
  const snapshot = await state();
  const transition = snapshot.motion.transitions.find(t => t.kind === kind && t.entityId === entityId);
  if (members) expect(transition.members.map(m => m.place.entityId).sort()).toEqual([...members].sort());
  return transition;
}
async function settle(cue = 'mailbox') {
  await action('settle'); await ready(cue);
  await expect.poll(async () => (await state()).motion?.transitions.length, { timeout: 15000 }).toBe(0);
}
async function midpoint(scope, name, kind, entityId, members, cue = 'mailbox') {
  await motion(kind, entityId, members); await action('mid-frame'); await capture(scope, name, cue);
  const snapshot = await state();
  const transition = await motion(kind, entityId, members);
  const progress = (snapshot.motionTime - transition.startedAt) / transition.duration;
  expect(progress).toBeGreaterThan(0); expect(progress).toBeLessThan(1);
  return { snapshot, transition };
}
let renderer;
try {
  await page.goto(`${origin}/e2e/taskland-harness.html`);
  for (const scope of ['story', 'space']) {
    if (scope === 'space') await page.getByLabel('Scope', { exact: true }).selectOption('space');
    await capture(scope, 'planning', 'mailbox');
    expect((await state()).buildHead, 'The served immutable bundle must match the checked source commit').toBe(sourceHead);
    if (!renderer) renderer = await page.locator('canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    });
    let snapshot = await state();
    expect(place(snapshot, 'child').badges).toContain('estimate-missing');
    expect(place(snapshot, 'root').mailbox).toMatchObject({ count: 5, approx: true });
    expect(place(snapshot, 'root').attention).toBe(1);
    expect(snapshot.model.groups.some(g => g.depth > 0)).toBe(true);
    expect(snapshot.model.robots.some(r => r.taskId === 'child')).toBe(true);
    await expect(page.locator('[data-worker-id]')).not.toHaveCount(0);
    await expect(page.getByText('Surveyor tent', { exact: true })).toHaveCount(1);
    await action('survey view'); await capture(scope, 'surveyor-tent', 'surveyor');
    await action('survey view'); await ready();
    await action('root-blocked');
    const rootMove = await midpoint(scope, 'root-family-move', 'move', 'root', ['root', 'child', 'paused']);
    expect(rootMove.snapshot.motion.suppressedPlaceIds.sort()).toEqual(rootMove.transition.members.map(m => m.target.id).sort());
    await settle();
    await action('working'); await midpoint(scope, 'child-yard-move', 'move', 'child', ['child']); await settle();
    expect(place(await state(), 'child').status).toBe('working');
    await action('progress'); await capture(scope, 'construction', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'child').progress).toBe(.5);
    expect(place(snapshot, 'child').constructionStage).toBe('scaffolding');
    await action('review'); await motion('move', 'child', ['child']); await settle(); await capture(scope, 'review', 'mailbox');
    expect(place(await state(), 'child').constructionStage).toBe('walls');
    await action('blocked'); await motion('move', 'child', ['child']); await settle(); await capture(scope, 'blocked', 'mailbox');
    expect(place(await state(), 'child').status).toBe('blocked');
    await action('estimate'); await ready();
    expect(place(await state(), 'child').badges).not.toContain('estimate-missing');
    await expect(page.getByText('Surveyor tent', { exact: true })).toHaveCount(0);
    await action('ship'); await midpoint(scope, 'child-shipping-cart', 'ship-out', 'child', ['child']); await settle();
    snapshot = await state();
    expect(place(snapshot, 'child')).toBeUndefined();
    expect(snapshot.model.robots.some(r => r.taskId === 'child')).toBe(false);
    await page.getByLabel('Map', { exact: true }).selectOption('town');
    await capture(scope, 'shipping-yard', 'shipping');
    snapshot = await state();
    expect(snapshot.model.places.map(p => p.entityId).sort()).toEqual(['child', 'output']);
    await expect(page.locator('[data-map-cue="shipping"]')).toContainText('2 waiting for placement');
    // Completion while Town remains mounted proves arrival; navigation alone resets motion.
    await action('ship-review');
    const arrival = await midpoint(scope, 'town-arrival', 'ship-in', 'review', ['review'], 'shipping');
    expect(arrival.transition.from).toEqual({ x: 0, z: -12 });
    await settle('shipping');
    await expect(page.locator('[data-map-cue="shipping"]')).toContainText('3 waiting for placement');
    await action('reopen-review'); await ready('shipping');
    expect(place(await state(), 'review')).toBeUndefined();
    await page.getByLabel('Map', { exact: true }).selectOption('taskland'); await ready();
    await action('root-done'); await midpoint(scope, 'done-root-open-child', 'ship-out', 'root', ['root']); await settle();
    expect(place(await state(), 'root').role).toBe('shipped-marker');
    expect(place(await state(), 'paused')).toBeDefined();
    await action('cancel'); await midpoint(scope, 'cancellation-collapse', 'collapse', 'paused', ['paused']); await settle();
    await capture(scope, 'cancelled-rubble', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'paused').constructionStage).toBe('rubble');
    expect(snapshot.model.nextLifecycleAt).toBe(snapshot.now + 24 * 60 * 60 * 1000);
    await action('expire'); await capture(scope, 'rubble-expired', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'paused')).toBeUndefined();
    expect(place(snapshot, 'root')).toBeUndefined();
    await page.getByLabel('Map', { exact: true }).selectOption('town'); await ready('shipping');
    expect((await state()).model.places.some(p => p.entityId === 'paused')).toBe(false);
    await expect(page.locator('[data-map-cue="shipping"]')).toContainText('3 waiting for placement');
    await action('reset'); await ready();
    await action('root-cancel'); await motion('collapse', 'root', ['root']); await settle();
    const beforeExpiry = await state(), beforeChild = place(beforeExpiry, 'child');
    await action('expire'); await capture(scope, 'neutral-yard-anchor', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'root')).toMatchObject({ role: 'hierarchy-marker', constructionStage: 'foundation', rubbleExpiresAt: null });
    expect(place(snapshot, 'child')).toMatchObject({ parentId: 'root', x: beforeChild.x, z: beforeChild.z });
    await expect(page.getByText('Yard anchor · open children remain', { exact: true })).toHaveCount(1);
    await page.getByLabel('Map', { exact: true }).selectOption('town'); await ready('shipping');
    expect(place(await state(), 'root')).toBeUndefined();
    await expect(page.locator('[data-map-cue="shipping"]')).toContainText('0 waiting for placement');
    await action('reset'); await ready();
    await page.getByLabel('Reduced motion', { exact: true }).check(); await ready();
    await action('root-blocked'); await capture(scope, 'reduced-motion-direct-state', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'root').status).toBe('blocked');
    expect(snapshot.motion.transitions).toEqual([]); expect(snapshot.motion.suppressedPlaceIds).toEqual([]);
    await page.getByLabel('Reduced motion', { exact: true }).uncheck(); await ready();
  }
  expect(errors).toEqual([]); expect(assetFailures).toEqual([]);
  const report = { source: 'Synthetic MapInput and typed task effects, production model/MapScene/imported assets', sourceHead,
    renderer, softwareWebGL: /swiftshader|llvmpipe|software/i.test(renderer), nativeGPUProof: false,
    checks: 'Both scopes: projected mailbox/yard/tent cues; progress stages; rendered worker; root-family versus child carts; independent child and root shipping; mounted-Town arrival; cancellation collapse and exact 24h expiry; stationary neutral ancestor with open children; reduced motion direct state; cancelled work never ships',
    errors, assetFailures, transitions };
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  const images = transitions.map(t => `<figure><img src="${t.scope}-${t.name}.png" alt="Synthetic ${t.scope} ${t.name}"/><figcaption>${t.scope} · ${t.name}</figcaption></figure>`).join('');
  await writeFile(`${evidence}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic Taskland evidence</title><style>body{font:16px system-ui;background:#101c24;color:#e8eef3;max-width:1200px;margin:30px auto}img{width:100%}figure{margin:24px 0}a{color:#a8d5fb}</style><h1>Synthetic Taskland construction evidence</h1><p>Production scene and model with synthetic in-memory records. Renderer: ${renderer.replaceAll('<','&lt;')}. Software WebGL; no native GPU or live Space proof.</p><p>Each capture waited for assets, rendered triangles and a projected world label. <a href="report.json">Aggregate assertions and frame metrics</a>.</p>${images}</html>`);
  console.log(JSON.stringify({ passed: true, renderer, scopes: 2, captures: transitions.length, evidence }));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, timeout: 10000 }).catch(() => {});
  const capturedState = await state().catch(cause => ({ unavailable: String(cause) }));
  await writeFile(`${evidence}/failure.json`, JSON.stringify({ incomplete: true, sourceHead, renderer, error: String(error), errors, assetFailures, transitions, state: capturedState }, null, 2));
  throw error;
} finally { await browser.close(); }

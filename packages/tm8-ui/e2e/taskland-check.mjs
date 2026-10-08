import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.env.TASKLAND_ORIGIN ?? 'http://127.0.0.1:4637';
const evidence = resolve(process.env.TASKLAND_EVIDENCE ?? 'gate-evidence/taskland');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.TASKLAND_CHROMIUM ? { executablePath: process.env.TASKLAND_CHROMIUM } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
const errors = [], assetFailures = [], transitions = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (/\.(glb|gltf)(\?|$)/.test(response.url()) && !response.ok()) assetFailures.push({ status: response.status(), path: new URL(response.url()).pathname }); });
async function state() { return page.evaluate(() => JSON.parse(JSON.stringify(window.__tasklandHarness))); }
async function ready(cue = 'mailbox') {
  await expect.poll(async () => {
    const value = await state();
    return Boolean(value?.stats?.triangles > 0 && value.stats.calls > 0 && !value.assets.loading && value.assets.used.length > 0);
  }, { timeout: 45000, message: 'Wait for imported assets and real rendered frame metrics' }).toBe(true);
  const label = page.locator(`[data-map-cue="${cue}"]`).first();
  await expect(label).toBeVisible({ timeout: 15000 });
  await expect.poll(() => label.evaluate(node => node.parentElement.style.transform), {
    message: 'Wait for the shared scene to project its world label',
  }).not.toBe('');
  expect((await state()).assets.errors).toEqual([]);
}
async function capture(scope, name, cue) {
  await ready(cue);
  const snapshot = await state();
  await page.screenshot({ path: `${evidence}/${scope}-${name}.png` });
  const visibleCues = await page.locator('[data-map-cue]').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width && n.parentElement.style.display !== 'none')
    .map(n => ({ cue: n.dataset.mapCue, text: n.textContent, projected: n.parentElement.style.transform })));
  transitions.push({ scope, name, type: snapshot.type, revision: snapshot.revision,
    places: snapshot.model.places.map(({ entityId, status, progress, constructionStage, role, mailbox, attention, badges, subtreeWeight, rubbleExpiresAt }) =>
      ({ entityId, status, progress, constructionStage, role, mailbox, attention, badges, subtreeWeight, rubbleExpiresAt })),
    robots: snapshot.model.robots.map(({ taskId, pose }) => ({ taskId, pose })),
    nextLifecycleAt: snapshot.model.nextLifecycleAt, stats: snapshot.stats, assets: snapshot.assets, visibleCues });
}
const place = (snapshot, id) => snapshot.model.places.find(p => p.entityId === id);
async function action(name) { await page.getByRole('button', { name, exact: true }).click(); }
let renderer;
try {
  await page.goto(`${origin}/e2e/taskland-harness.html`);
  for (const scope of ['story', 'space']) {
    if (scope === 'space') await page.getByLabel('Scope', { exact: true }).selectOption('space');
    await capture(scope, 'planning', 'mailbox');
    let snapshot = await state();
    expect(place(snapshot, 'child').badges).toContain('estimate-missing');
    expect(place(snapshot, 'root').mailbox).toMatchObject({ count: 5, approx: true });
    expect(place(snapshot, 'root').attention).toBe(1);
    expect(snapshot.model.groups.some(g => g.depth > 0)).toBe(true);
    expect(snapshot.model.robots.some(r => r.taskId === 'child')).toBe(true);
    await expect(page.getByText('Surveyor tent', { exact: true })).toHaveCount(1);
    await action('working'); await ready();
    expect(place(await state(), 'child').status).toBe('working');
    await action('progress'); await capture(scope, 'construction', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'child').progress).toBe(.5);
    expect(place(snapshot, 'child').constructionStage).toBe('scaffolding');
    await action('review'); await capture(scope, 'review', 'mailbox');
    expect(place(await state(), 'child').constructionStage).toBe('walls');
    await action('blocked'); await capture(scope, 'blocked', 'mailbox');
    expect(place(await state(), 'child').status).toBe('blocked');
    await action('estimate'); await ready();
    expect(place(await state(), 'child').badges).not.toContain('estimate-missing');
    await expect(page.getByText('Surveyor tent', { exact: true })).toHaveCount(0);
    await action('ship'); await capture(scope, 'child-shipped', 'mailbox');
    snapshot = await state();
    expect(place(snapshot, 'child')).toBeUndefined();
    expect(snapshot.model.robots.some(r => r.taskId === 'child')).toBe(false);
    await page.getByLabel('Map', { exact: true }).selectOption('town');
    await capture(scope, 'shipping-yard', 'shipping');
    snapshot = await state();
    expect(snapshot.model.places.map(p => p.entityId).sort()).toEqual(['child', 'output']);
    await expect(page.locator('[data-map-cue="shipping"]')).toContainText('2 waiting for placement');
    await page.getByLabel('Map', { exact: true }).selectOption('taskland'); await ready();
    await action('root-done'); await capture(scope, 'done-root-open-child', 'mailbox');
    expect(place(await state(), 'root').role).toBe('shipped-marker');
    expect(place(await state(), 'paused')).toBeDefined();
    await action('cancel'); await capture(scope, 'cancelled', 'mailbox');
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
    if (!renderer) renderer = await page.locator('canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    });
  }
  expect(errors).toEqual([]); expect(assetFailures).toEqual([]);
  const report = { source: 'Synthetic MapInput, production model/MapScene/imported assets',
    renderer, softwareWebGL: /swiftshader|llvmpipe|software/i.test(renderer), nativeGPUProof: false,
    checks: 'Both scopes: projected mailbox/yard/tent cues, acceptance progress stages, status yards, estimate correction, active claim, child ships independently, done root marker, cancellation and exact 24h expiry; cancelled work never ships',
    errors, assetFailures, transitions };
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  const images = transitions.map(t => `<figure><img src="${t.scope}-${t.name}.png" alt="Synthetic ${t.scope} ${t.name}"/><figcaption>${t.scope} · ${t.name}</figcaption></figure>`).join('');
  await writeFile(`${evidence}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic Taskland evidence</title><style>body{font:16px system-ui;background:#101c24;color:#e8eef3;max-width:1200px;margin:30px auto}img{width:100%}figure{margin:24px 0}a{color:#a8d5fb}</style><h1>Synthetic Taskland construction evidence</h1><p>Production scene and model with synthetic in-memory records. Renderer: ${renderer.replaceAll('<','&lt;')}. Software WebGL; no native GPU or live Space proof.</p><p>Each capture waited for assets, rendered triangles and a projected world label. <a href="report.json">Aggregate assertions and frame metrics</a>.</p>${images}</html>`);
  console.log(JSON.stringify({ passed: true, renderer, scopes: 2, captures: transitions.length, evidence }));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  await writeFile(`${evidence}/failure.json`, JSON.stringify({ error: String(error), errors, assetFailures, transitions, state: await state() }, null, 2));
  throw error;
} finally { await browser.close(); }

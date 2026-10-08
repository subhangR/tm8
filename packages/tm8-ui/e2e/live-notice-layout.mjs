/** CSS-only browser regression using DOM snapshots from GameMode.live.test.tsx. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const [snapshotsPath, outputPath] = process.argv.slice(2);
assert.ok(snapshotsPath, 'Pass the GameMode test snapshot JSON path');
const snapshots = JSON.parse(await readFile(snapshotsPath, 'utf8'));
assert.deepEqual(snapshots.map(phase => phase.name), ['empty', 'below', 'above', 'below-again', 'warnings-added', 'warnings-cleared']);
const css = (await Promise.all([
  '../src/game/game-mode.css', '../src/story/game/story-game.css',
  '../src/story/game/maps/walking.css', '../src/story/game/story-game-minimap.css',
].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ headless: true, timeout: 10_000, ...(process.env.TM8_LAYOUT_CHROMIUM ? { executablePath: process.env.TM8_LAYOUT_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-gpu', '--disable-webgl', '--no-zygote', '--single-process'] });
const deadline = setTimeout(() => { void browser.close(); }, 50_000);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const measurements = [];
  for (const phase of snapshots) {
    await page.setContent(`<style>html,body,.cv2-root{height:100%;margin:0}${css}</style><div class="cv2-root">${phase.html}</div>`);
    measurements.push(await page.evaluate(name => {
      const map = document.querySelector('.game-mode__map');
      const notice = map.querySelector('[aria-live="polite"]');
      const deck = map.querySelector('.game-mode__notices');
      const canvas = map.querySelector('.sgm-stage canvas');
      const rect = map.getBoundingClientRect();
      const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { name, height: rect.height, width: rect.width, mapClientHeight: map.clientHeight, canvasClientHeight: canvas.clientHeight,
        noticeHeight: notice.getBoundingClientRect().height, deck: bounds(deck),
        controls: ['.walking-toolbar', '.walking-places', '.walking-workers', '.sgm-minimap'].map(selector => ({ selector, ...bounds(map.querySelector(selector)) })),
        warnings: map.querySelector('details.game-mode__notice')?.textContent ?? '',
        announcement: notice.textContent, position: getComputedStyle(deck).position, pointerEvents: getComputedStyle(notice).pointerEvents,
        display: getComputedStyle(notice).display, visibility: getComputedStyle(notice).visibility,
        polite: notice.getAttribute('aria-live'), atomic: notice.getAttribute('aria-atomic') };
    }, phase.name));
  }
  const baseline = measurements[0];
  assert.ok(baseline.height > 600 && baseline.width === 1280, 'Measure a real nonzero viewport, not JSDOM geometry');
  for (const frame of measurements) {
    assert.equal(frame.height, baseline.height, `${frame.name} must preserve map/canvas viewport height`);
    assert.equal(frame.mapClientHeight, baseline.mapClientHeight, `${frame.name} map container clientHeight`);
    assert.equal(frame.canvasClientHeight, baseline.canvasClientHeight, `${frame.name} canvas clientHeight`);
    assert.ok(frame.canvasClientHeight > 600, 'The canvas has a real nonzero layout box without WebGL');
    assert.equal(frame.position, 'absolute');
    assert.equal(frame.pointerEvents, 'none');
    assert.notEqual(frame.display, 'none'); assert.notEqual(frame.visibility, 'hidden');
    assert.equal(frame.polite, 'polite'); assert.equal(frame.atomic, 'true');
    for (const control of frame.controls) {
      const a = frame.deck, b = control;
      assert.ok(b.width > 0 && b.height > 0, `${control.selector} actually occupies a visible rectangle`);
      assert.ok(a.height === 0 || a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${frame.name} notice deck must not cover ${control.selector}`);
    }
  }
  assert.ok(measurements[1].noticeHeight > 0 && measurements[2].noticeHeight > 0, 'Visible notices must actually occupy painted height');
  assert.equal(measurements[0].announcement, '');
  assert.equal(measurements[1].announcement, '1 map update');
  assert.equal(measurements[2].announcement, '6 map updates in the last minute');
  assert.equal(measurements[3].announcement, '1 map update');
  assert.match(measurements[4].warnings, /hide their estimate in an incomplete hierarchy/);
  assert.equal(measurements[5].warnings, '');
  const result = { viewport: { width: 1280, height: 800 }, webgl: false, measurements };
  if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { clearTimeout(deadline); await browser.close(); }

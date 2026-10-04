/** Story drill-in round trip (task 01a1090f): walk to a portal, Enter, Inspect in the child, Esc back.
 * DRILL_URL, DRILL_DIR, DRILL_BROWSER, DRILL_THEME configure reproduction. SwiftShader software rendering. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.DRILL_DIR ?? '/tmp/story-drill', theme = process.env.DRILL_THEME ?? 'light';
const base = process.env.DRILL_URL ?? 'http://127.0.0.1:4781/e2e/story-drill-harness.html';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.DRILL_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { theme, steps: [], errors: [] };
const step = (name, data = {}) => { report.steps.push({ name, ...data }); console.log(name, JSON.stringify(data)); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.addInitScript(() => localStorage.removeItem('tm8.story-game.v1'));
  await page.goto(`${base}${theme === 'dark' ? '?theme=dark' : ''}`, { waitUntil: 'networkidle' });
  const game = page.getByTestId('story-game');
  const ids = await page.evaluate(async () => {
    const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
    return { parent: STORY_FIXTURE.id, parentTitle: STORY_FIXTURE.title, child: STORY_FIXTURE.page.childStories[0].id, childTitle: STORY_FIXTURE.page.childStories[0].title };
  });
  await game.waitFor({ timeout: 90000 });
  await page.waitForSelector('.sgm-stage canvas', { timeout: 90000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${dir}/${theme}-1-parent.png` });
  step('parent map', { label: await game.getAttribute('aria-label') });

  await page.locator(`button[title="Walk to ${ids.childTitle}"]`).click();
  const enter = page.locator('[data-testid="story-game-approach"] [data-action="enter"]');
  await enter.waitFor({ timeout: 180000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/${theme}-2-portal-enter.png` });
  const stood = await page.evaluate(async (id) => {
    const { storyGameStore } = await import('/src/story/game/store.ts');
    return storyGameStore.getState().saves[id];
  }, ids.parent);
  step('approach card at portal', { button: (await enter.innerText()).trim(), parentSave: { x: stood.x, z: stood.z } });

  await page.keyboard.press('e');
  await page.waitForFunction((t) => document.querySelector('[data-testid="story-game"]')?.getAttribute('aria-label') === `${t} as a game`, ids.childTitle, { timeout: 60000 });
  await page.waitForSelector('.sgm-stage canvas', { timeout: 90000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${dir}/${theme}-3-child-map.png` });
  const afterEnter = await page.evaluate(async (id) => {
    const { storyGameStore } = await import('/src/story/game/store.ts');
    const { navStore } = await import('/src/stores/navStore.ts');
    return { mode: storyGameStore.getState().mode[id], route: navStore.getState().view, historyLength: history.length };
  }, ids.child);
  step('E entered the child', afterEnter);

  const rootTitle = await page.locator('.sgm-quest__row .sgm-quest__title').first().innerText();
  await page.locator(`button[title="Walk to ${rootTitle}"]`).click();
  const inspect = page.locator('[data-testid="story-game-approach"] [data-action="inspect"]');
  const duel = page.getByTestId('story-game-duel');
  await inspect.or(duel).first().waitFor({ timeout: 180000 });
  if (await duel.isVisible()) {
    await page.screenshot({ path: `${dir}/${theme}-4a-child-duel.png` });
    await page.keyboard.press('Escape'); // leaves the duel; Esc only climbs out when no duel is open
    step('Esc in a duel left the duel, not the story', { label: await game.getAttribute('aria-label') });
  }
  await inspect.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/${theme}-4-child-inspect.png` });
  await inspect.click();
  step('Inspect in the child', { button: (await inspect.innerText()).trim(), opened: await page.getByTestId('drill-opened').innerText() });

  await game.focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction((t) => document.querySelector('[data-testid="story-game"]')?.getAttribute('aria-label') === `${t} as a game`, ids.parentTitle, { timeout: 60000 });
  await page.waitForSelector('.sgm-stage canvas', { timeout: 90000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${dir}/${theme}-5-back-in-parent.png` });
  const afterEsc = await page.evaluate(async (id) => {
    const { storyGameStore } = await import('/src/story/game/store.ts');
    const { navStore } = await import('/src/stores/navStore.ts');
    const s = storyGameStore.getState().saves[id];
    return { mode: storyGameStore.getState().mode[id], route: navStore.getState().view, parentSave: { x: s.x, z: s.z }, historyLength: history.length,
      approach: document.querySelector('[data-testid="story-game-approach"] .sgm-approach__title')?.textContent ?? null };
  }, ids.parent);
  step('Esc returned to the parent', afterEsc);

  await page.keyboard.press('e');
  await page.waitForFunction((t) => document.querySelector('[data-testid="story-game"]')?.getAttribute('aria-label') === `${t} as a game`, ids.childTitle, { timeout: 60000 });
  await page.goBack();
  await page.waitForFunction((t) => document.querySelector('[data-testid="story-game"]')?.getAttribute('aria-label') === `${t} as a game`, ids.parentTitle, { timeout: 60000 });
  step('browser Back from a re-entered child returns to the parent', { label: await game.getAttribute('aria-label') });
  await writeFile(`${dir}/${theme}-report.json`, JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
} finally { await browser.close(); }

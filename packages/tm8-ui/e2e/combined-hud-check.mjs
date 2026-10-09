import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), software: true, passed: false, checks: [] };
const browser = await chromium.launch({ headless: true, timeout: 15000,
  ...(process.env.COMBINED_HUD_CHROMIUM ? { executablePath: process.env.COMBINED_HUD_CHROMIUM } : {}),
  args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const deadline = setTimeout(() => { void browser.close(); }, 60000);
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  for (const viewport of [{ width: 800, height: 600 }, { width: 560, height: 740 }, { width: 560, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.goto(process.env.COMBINED_HUD_URL ?? 'http://127.0.0.1:18653/e2e/combined-hud.html');
    const host = page.getByTestId('walking-map');
    await expect(host).toHaveAttribute('data-renderer', 'webgl');
    const places = host.locator('.walking-places'), workers = host.locator('.walking-workers');
    await places.locator('summary').click();
    await workers.locator('summary').click();
    const worker = workers.getByRole('button', { name: 'Combined worker with a long session title' });
    await worker.click();
    expect(await page.evaluate(() => window.__combinedHud.actions)).toEqual(['inspect:session']);
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { workers: rect('.walking-workers'), tools: rect('.walking-map-tools'), places: rect('.walking-places'), minimap: rect('.sgm-minimap') };
    });
    expect(geometry.workers.right).toBeLessThan(geometry.tools.left);
    expect(geometry.places.bottom).toBeLessThan(geometry.minimap.top);
    const portal = places.getByRole('button', { name: 'Enter Combined story 1', exact: true });
    await portal.scrollIntoViewIfNeeded();
    await portal.click();
    expect(await page.evaluate(() => window.__combinedHud.actions.at(-1))).toMatch(/^enter:/);
    const toggle = host.getByTestId('story-game-minimap').getByRole('button');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const collapsed = await places.boundingBox();
    expect(collapsed.height).toBeGreaterThanOrEqual(geometry.places.bottom - geometry.places.top);
    report.checks.push({ viewport, collapsedPlacesHeight: collapsed.height });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await worker.click();
    expect(await page.evaluate(() => window.__combinedHud.actions.at(-1))).toBe('inspect:session');
    report.checks.push({ viewport, geometry, actions: await page.evaluate(() => window.__combinedHud.actions) });
  }
  report.passed = true;
} catch (error) { report.failure = String(error); throw error; }
finally { clearTimeout(deadline); await browser.close(); await writeFile(process.env.COMBINED_HUD_EVIDENCE ?? '/tmp/combined-hud-check.json', JSON.stringify(report, null, 2)); }

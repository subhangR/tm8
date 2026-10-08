import { expect } from '@playwright/test';

/** readState returns {stats,assets} from the mounted production scene. */
export async function waitForRenderedTaskland(page, readState, { cue = 'mailbox', timeout = 45000 } = {}) {
  await expect.poll(async () => {
    const value = await readState();
    return Boolean(value?.stats?.triangles > 0 && value.stats.calls > 0 && !value.assets.loading && value.assets.used.length > 0);
  }, { timeout, message: 'Wait for imported assets and real rendered frame metrics' }).toBe(true);
  const label = page.locator(`[data-map-cue="${cue}"]`).first();
  await expect(label).toBeVisible({ timeout: 15000 });
  await expect.poll(() => label.evaluate(node => node.parentElement.style.transform), {
    message: 'Wait for the shared scene to project its world label',
  }).not.toBe('');
  expect((await readState()).assets.errors).toEqual([]);
}
export function projectedTasklandCues(page) {
  return page.locator('[data-map-cue]').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width && n.parentElement.style.display !== 'none')
    .map(n => ({ cue: n.dataset.mapCue, text: n.textContent, projected: n.parentElement.style.transform })));
}

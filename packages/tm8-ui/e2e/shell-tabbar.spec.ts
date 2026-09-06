import { expect, test } from '@playwright/test';

const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];

for (const viewport of viewports) {
  test(`keeps every visible shell control inside the centred bar at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/shell-tabbar-harness.html');
    await expect(page.getByTestId('harness-ready')).toBeVisible();

    const result = await page.getByTestId('space-tab-bar').evaluate((bar) => {
      const barRect = bar.getBoundingClientRect();
      const selectors = [
        '.shell-tabbar__mark',
        '.shell-switcher__trigger',
        '.shell-tabbar__tab',
        '.shell-tabbar__palette',
        '.shell-tabbar__bell',
        '.shell-tabbar__avatar',
        '.auth-accountmenu__trigger',
      ].join(',');
      const leafElements = [...bar.querySelectorAll<HTMLElement>(selectors)]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility === 'visible'
            && Number(style.opacity) > 0
            && rect.width > 0
            && rect.height > 0;
        });
      const leaves = leafElements.map((element) => ({
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className,
          rect: element.getBoundingClientRect().toJSON(),
          cssHeight: element.offsetHeight,
          rightControl: element.matches('.shell-tabbar__palette, .shell-tabbar__bell, .shell-tabbar__avatar, .auth-accountmenu__trigger'),
        }));
      const outside = leaves.filter(({ rect }) =>
        rect.left < barRect.left - 0.5
        || rect.right > barRect.right + 0.5
        || rect.top < barRect.top - 0.5
        || rect.bottom > barRect.bottom + 0.5);
      const intersections: string[] = [];
      for (let first = 0; first < leaves.length; first += 1) {
        for (let second = first + 1; second < leaves.length; second += 1) {
          const a = leaves[first]!;
          const b = leaves[second]!;
          if (
            a.rect.left < b.rect.right - 0.5
            && a.rect.right > b.rect.left + 0.5
            && a.rect.top < b.rect.bottom - 0.5
            && a.rect.bottom > b.rect.top + 0.5
          ) intersections.push(`${a.name} / ${b.name}`);
        }
      }
      const visibleOutside = [...bar.querySelectorAll<HTMLElement>('*')].filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (
          rect.left < barRect.left - 0.5
          || rect.right > barRect.right + 0.5
          || rect.top < barRect.top - 0.5
          || rect.bottom > barRect.bottom + 0.5
        );
      }).map((element) => element.className);
      const descendantsOutsideLeaf = leafElements.flatMap((leaf) => {
        const leafRect = leaf.getBoundingClientRect();
        return [...leaf.querySelectorAll<HTMLElement>('*')].filter((element) => {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (
            rect.left < leafRect.left - 0.5
            || rect.right > leafRect.right + 0.5
            || rect.top < leafRect.top - 0.5
            || rect.bottom > leafRect.bottom + 0.5
          );
        }).map((element) => `${leaf.className} > ${element.className}`);
      });

      return {
        cssHeight: getComputedStyle(bar).height,
        outside,
        intersections,
        visibleOutside,
        descendantsOutsideLeaf,
        tallRightControls: leaves.filter((leaf) => leaf.rightControl && leaf.cssHeight > 24),
        captions: bar.querySelectorAll('.hon-caption').length,
      };
    });

    expect(result.cssHeight).toBe('36px');
    expect(result.outside).toEqual([]);
    expect(result.intersections).toEqual([]);
    expect(result.visibleOutside).toEqual([]);
    expect(result.descendantsOutsideLeaf).toEqual([]);
    expect(result.tallRightControls).toEqual([]);
    expect(result.captions).toBe(0);
  });
}

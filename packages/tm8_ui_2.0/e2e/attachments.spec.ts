import { expect, test } from '@playwright/test';

/**
 * THE ROUND TRIP: upload → edge → thumbnail → download → detach, in a real
 * browser against a real node.
 *
 * WHY THIS FILE EXISTS. Every unit test this feature has asserts a SHAPE — a
 * prop arrived, a resolver returned a string, a fake seam saw a call. The four
 * things that were actually broken in production are none of those:
 *
 *   1. the bytes never left the page (no host handed the panel an upload port);
 *   2. the edge was written but the panel never re-read it;
 *   3. the `<img>` pointed at a URL nothing served, so it rendered as a broken
 *      chip that looked like a corrupt file;
 *   4. there was no way back — the strip could add and could not remove.
 *
 * Each is invisible to jsdom and each is asserted below on EVIDENCE rather than
 * on a call: `naturalWidth > 0` means a real decoder read real bytes, and the
 * download assertion re-fetches the href and compares the LENGTH to what went
 * up. A test that only checked the `src` attribute would have passed
 * throughout the outage.
 *
 * REQUIRES A NODE. Run with `TM8_SERVER_ORIGIN=http://127.0.0.1:7778 bunx
 * playwright test e2e/attachments.spec.ts` (vite proxies /v2 there; the node
 * sends no CORS headers, so the page must stay same-origin).
 */

const STRIP = '[data-testid="attachment-strip"]';
const ITEM = '[data-testid="attachment-item"]';

/** A 1×1 PNG, small enough to inline and real enough for a decoder to accept. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

test.describe('an attachment survives the whole round trip', () => {
  test('upload writes an edge, the thumbnail decodes, the link downloads, Remove cuts it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/attachments-harness.html');

    // A failed boot says so, rather than presenting as a missing strip.
    const failed = page.getByTestId('harness-failed');
    await expect(page.getByTestId('harness-ready').or(failed)).toBeVisible({ timeout: 30_000 });
    if (await failed.isVisible()) throw new Error(`harness could not boot: ${await failed.textContent()}`);

    const strip = page.locator(STRIP);
    await expect(strip).toBeVisible();
    const before = await strip.locator(ITEM).count();

    const name = `e2e-attachment-${Date.now()}.png`;
    await page.getByTestId('attachment-file-input').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });

    // 1 + 2: the bytes completed AND the anchor was re-read, because the row
    // only exists if the server answered an `attached_to` edge on a refetch.
    const row = strip.locator(ITEM).filter({ has: page.locator(`img[alt="${name}"]`) });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    expect(await strip.locator(ITEM).count()).toBe(before + 1);

    // 3: a real decoder read real bytes. `src` alone would have passed while
    // the route 404'd.
    const image = row.locator('img');
    await expect
      .poll(async () => image.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The download link resolves to the same file, byte-for-byte in length.
    const href = await row.locator('a').getAttribute('href');
    expect(href).toContain('/download');
    const served = await page.request.get(new URL(href!, page.url()).toString());
    expect(served.status()).toBe(200);
    expect((await served.body()).length).toBe(PNG_BYTES.length);

    // 4: the way back. The row goes, and the count returns to where it started.
    await row.getByTestId('attachment-detach').click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(strip.locator(ITEM)).toHaveCount(before);

    // And the FILE outlived its link — detach cuts the edge, not the bytes.
    const after = await page.request.get(new URL(href!, page.url()).toString());
    expect(after.status()).toBe(200);
  });
});

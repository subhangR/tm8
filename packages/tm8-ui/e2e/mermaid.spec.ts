import { expect, test } from '@playwright/test';

/**
 * MERMAID, drawn for real. Only a browser can verify this: mermaid measures
 * text to lay out nodes, and jsdom has no layout, so the SVG it would produce
 * there is not the SVG a reader sees.
 */
const LIST = '[data-testid="entity-view"] .ev-list';
const MD = '[data-testid="entity-view-detail"] [data-testid="reader-markdown"]';

/**
 * THE DRAWING, as opposed to any other svg in the figure. Since the diagram
 * gained expand/zoom controls, `[data-testid="mermaid"] svg` also matches the
 * four `kit/VectorIcon` glyphs on the buttons — five elements, and a strict-mode
 * violation. The drawn diagram is the one mermaid injected, so it is addressed
 * through the wrapper that injects it.
 */
const DRAWING = '.md-mermaid__svg svg';

const DOC = '# Flow\n\n'
  + '```mermaid\nflowchart LR\n  A[list] --> B[detail]\n  B --> C[aux]\n```\n\n'
  + 'Prose after the diagram.\n\n'
  + '```bash\nbun run dev\n```\n';

/** Wide enough that the column is the constraint — the actual complaint. */
const WIDE_DOC = '```mermaid\nflowchart LR\n'
  + '  A[ingest] --> B[normalise] --> C[project] --> D[reduce]\n'
  + '  D --> E[persist] --> F[publish] --> G[notify] --> H[archive]\n'
  + '```\n';

async function writeDoc(page: import('@playwright/test').Page, body: string) {
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto('/e2e/entity-view-harness.html?kind=doc');
  await page.getByTestId('harness-ready').waitFor();
  await page.locator(`${LIST} [data-testid="list-tile"]`).nth(1).click();
  await page.getByTestId('doc-edit-entry').click();
  await page.locator('[data-testid="doc-source"]').fill(body);
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.getByTestId('doc-collapse').click();
}

test('a mermaid fence renders as an actual SVG diagram, not source', async ({ page }) => {
  await writeDoc(page, DOC);
  const md = page.locator(MD);

  const diagram = md.locator('[data-testid="mermaid"]');
  await expect(diagram).toBeVisible();
  await expect(diagram).toHaveAttribute('data-phase', 'ok');

  // A REAL drawing: an svg with real geometry, carrying the node labels.
  const svg = diagram.locator(DRAWING);
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(20);
  await expect(svg).toContainText('list');
  await expect(svg).toContainText('detail');
  await expect(svg).toContainText('aux');

  // It is a diagram, NOT a code block, and the old placeholder is gone.
  await expect(md.locator('[data-testid="markdown-fence"][data-lang="mermaid"]')).toHaveCount(0);
  await expect(md).not.toContainText('not rendered');
  await expect(md).not.toContainText('flowchart LR');

  // The rest of the document still renders around it.
  await expect(md.locator('h1')).toHaveText('Flow');
  await expect(md.locator('[data-testid="markdown-fence"][data-lang="bash"]')).toContainText('bun run dev');
});

test('a broken diagram states the error and KEEPS the source', async ({ page }) => {
  await writeDoc(page, '```mermaid\nflowchart LR\n  A[[[ ->> not a diagram\n```\n');
  const failed = page.locator(MD).locator('[data-testid="mermaid-failed"]');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('could not be drawn');
  // The author's text survives the failure — it is what they need to fix it.
  await expect(failed.locator('code')).toContainText('not a diagram');
});

test('the diagram is redrawn for the dark theme, not left with light colours', async ({ page }) => {
  await writeDoc(page, DOC);
  const diagram = page.locator(MD).locator('[data-testid="mermaid"]');
  await expect(diagram).toHaveAttribute('data-phase', 'ok');
  // The COMPUTED fill, not the `style` attribute: mermaid emits its palette in
  // a <style> block inside the SVG, so the attribute is empty and comparing it
  // would compare "" to "" and pass for the wrong reason.
  const nodeFill = () => diagram.locator(`${DRAWING} .node rect, ${DRAWING} rect`).first()
    .evaluate((el) => getComputedStyle(el).fill);

  const light = await nodeFill();

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect(diagram).toHaveAttribute('data-phase', 'ok');

  // Mermaid bakes colour into the SVG at render time, so a diagram that did NOT
  // re-render would keep its light palette and go unreadable on dark paper.
  // Asserted against the TOKEN the dark theme defines, so this also proves the
  // palette is read from tokens.css rather than hardcoded in Mermaid.tsx.
  await expect.poll(nodeFill).toBe('rgb(34, 30, 21)'); // --pn-card, dark
  expect(light).toBe('rgb(255, 255, 255)'); // --pn-card, light
});

/**
 * EXPAND / ZOOM / PAN — browser-level on purpose, and this is the only place it
 * can be checked. jsdom has no layout: the mermaid SVG it produces has no
 * measured size, a CSS transform moves nothing, and `position: fixed` covers
 * nothing, so every assertion below would pass there for the wrong reason.
 * `src/kit/zoomable-figure.test.tsx` takes the half that IS honest in jsdom —
 * control wiring, aria-pressed, Escape, the clamp — and stops there.
 */
const FIGURE = '[data-testid="mermaid"]';

test('a diagram can be maximised, and the expanded figure really covers the viewport', async ({ page }) => {
  await writeDoc(page, WIDE_DOC);
  const figure = page.locator(MD).locator(FIGURE);
  await expect(figure).toHaveAttribute('data-phase', 'ok');

  const inline = await figure.boundingBox();
  const viewport = page.viewportSize()!;
  // At rest it is a figure in a column, not a screen.
  expect(inline!.width).toBeLessThan(viewport.width * 0.9);

  await figure.getByRole('button', { name: 'Expand to full screen' }).click();

  // The MEASURED box, not the class: the point of `position: fixed; inset: 0`
  // is that it covers the app, and only a browser can say whether it does.
  await expect(figure).toHaveAttribute('data-expanded', 'true');
  const full = await figure.boundingBox();
  expect(full!.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(full!.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(full!.x).toBeLessThanOrEqual(1);
  expect(full!.y).toBeLessThanOrEqual(1);

  // Same element throughout — that is why the SVG never had to be redrawn.
  await expect(figure.locator(DRAWING)).toContainText('normalise');

  // The exit affordance stays on screen, and Escape works too (the artifact
  // viewer's ruling, kept identical here).
  await expect(figure.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(figure).toHaveAttribute('data-expanded', 'false');
  const back = await figure.boundingBox();
  expect(back!.width).toBeLessThan(viewport.width * 0.9);
});

test('zooming actually magnifies the drawing, and reset puts it back', async ({ page }) => {
  await writeDoc(page, WIDE_DOC);
  const figure = page.locator(MD).locator(FIGURE);
  await expect(figure).toHaveAttribute('data-phase', 'ok');
  const svg = figure.locator(DRAWING);

  const fitted = await svg.boundingBox();

  await figure.getByRole('button', { name: 'Zoom in' }).click();
  await figure.getByRole('button', { name: 'Zoom in' }).click();

  // The RENDERED box grows. `getBoundingClientRect` folds in the ancestor's
  // CSS transform, so this measures the pixels a reader sees rather than the
  // string in the style attribute — which is exactly the thing jsdom cannot do.
  const zoomed = await svg.boundingBox();
  expect(zoomed!.width).toBeGreaterThan(fitted!.width * 1.3);
  expect(zoomed!.height).toBeGreaterThan(fitted!.height * 1.3);

  // And the labels are still text, not a raster blur — it is a vector scaled by
  // the compositor, which is the reason zoom is a transform at all.
  await expect(svg).toContainText('normalise');

  await figure.getByRole('button', { name: 'Reset to fit' }).click();
  await expect(figure).toHaveAttribute('data-interactive', 'false');
  const reset = await svg.boundingBox();
  expect(Math.abs(reset!.width - fitted!.width)).toBeLessThan(2);
});

test('the resting diagram is untouched: no transform, and the column still scrolls it', async ({ page }) => {
  await writeDoc(page, WIDE_DOC);
  const figure = page.locator(MD).locator(FIGURE);
  await expect(figure).toHaveAttribute('data-phase', 'ok');

  // A reader who never touches a control gets exactly what shipped before: the
  // viewport is a real scroll container and no transform is written at all.
  await expect(figure).toHaveAttribute('data-interactive', 'false');
  expect(await figure.locator('.kit-zfig__canvas').getAttribute('style')).toBeNull();
  expect(
    await figure.locator('.kit-zfig__viewport').evaluate((el) => getComputedStyle(el).overflowX),
  ).toBe('auto');

  // Once zoomed, this component owns the panning and native scroll is off —
  // two pan mechanisms on one box would fight.
  await figure.getByRole('button', { name: 'Zoom in' }).click();
  expect(
    await figure.locator('.kit-zfig__viewport').evaluate((el) => getComputedStyle(el).overflowX),
  ).toBe('hidden');
});

test('the controls are reachable by keyboard, not hover-only', async ({ page }) => {
  await writeDoc(page, WIDE_DOC);
  const figure = page.locator(MD).locator(FIGURE);
  await expect(figure).toHaveAttribute('data-phase', 'ok');

  const zoomIn = figure.getByRole('button', { name: 'Zoom in' });
  // Hidden chrome that a Tab cannot reveal is chrome a keyboard reader does not
  // have. `:focus-within` is what makes this true, and only a real cascade can
  // prove it — hence the computed opacity rather than a class check.
  await zoomIn.focus();
  await expect.poll(() => zoomIn.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1');
  await page.keyboard.press('Enter');
  await expect(figure).toHaveAttribute('data-interactive', 'true');
});

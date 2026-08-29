import { expect, test } from '@playwright/test';

/**
 * MERMAID, drawn for real. Only a browser can verify this: mermaid measures
 * text to lay out nodes, and jsdom has no layout, so the SVG it would produce
 * there is not the SVG a reader sees.
 */
const LIST = '[data-testid="entity-view"] .ev-list';
const MD = '[data-testid="entity-view-detail"] [data-testid="reader-markdown"]';

const DOC = '# Flow\n\n'
  + '```mermaid\nflowchart LR\n  A[list] --> B[detail]\n  B --> C[aux]\n```\n\n'
  + 'Prose after the diagram.\n\n'
  + '```bash\nbun run dev\n```\n';

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
  const svg = diagram.locator('svg');
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
  const nodeFill = () => diagram.locator('svg .node rect, svg rect').first()
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

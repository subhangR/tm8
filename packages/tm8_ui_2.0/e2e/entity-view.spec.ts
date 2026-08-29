import { expect, test } from '@playwright/test';

/**
 * THE 2026-07-31 THREE-REGION ENTITY SCREEN, measured in a real browser.
 *
 * Every assertion here is one jsdom cannot make: the vitest suite has no
 * layout engine, so "the list is a 320px rail and the detail takes the rest"
 * is only checkable where boxes have real widths. That is the entire reason
 * this file exists alongside the unit tests rather than instead of them.
 */

const LIST = '[data-testid="entity-view"] .ev-list';
const DETAIL = '[data-testid="entity-view-detail"]';
const AUX = '[data-testid="entity-view-aux"]';
/** The CENTRE's reader surface. Scoped: the aux column renders one too when the
    thing opened beside the document is itself a doc, and an unscoped testid
    would match both and fail strict mode for the wrong reason. */
const CENTRE_READER = '[data-testid="entity-view-detail"] [data-testid="reader-surface"]';

async function boot(page: import('@playwright/test').Page, kind = 'doc') {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/e2e/entity-view-harness.html?kind=${kind}`);
  await expect(page.getByTestId('harness-ready')).toBeVisible({ timeout: 15_000 });
}

/**
 * Left edge + width of a region, in DEVICE pixels.
 *
 * These are post-zoom numbers: `.cv2-root` carries `zoom: 1.1` (D60, the
 * app's single global scale lever), so a 320px rule paints ~352 here. Use this
 * for ORDER and RELATIVE size — never to assert a number written in the
 * stylesheet, or the assertion is really testing the zoom constant.
 */
async function box(page: import('@playwright/test').Page, selector: string) {
  const handle = page.locator(selector);
  const rect = await handle.boundingBox();
  if (!rect) throw new Error(`${selector} has no box — it is not laid out`);
  return rect;
}

/** The resolved CSS width, which is zoom-independent and therefore assertable. */
async function cssWidth(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluate((el) => getComputedStyle(el).width);
}

test('the list is a fixed rail on the LEFT and the detail takes the whole remaining width', async ({ page }) => {
  await boot(page);

  const list = await box(page, LIST);
  const detail = await box(page, DETAIL);

  // The rail: fixed at its declared width, and genuinely leftmost.
  expect(await cssWidth(page, LIST)).toBe('320px');
  expect(list.x).toBeLessThan(detail.x);

  // The detail is not a 440px peek any more — it is everything that is left.
  // Asserted as a RELATION rather than a magic number, so the test does not
  // have to be re-tuned every time the rail width is.
  expect(detail.width).toBeGreaterThan(list.width * 3);

  // No aux column until something asks for one — it must not reserve space.
  await expect(page.locator(AUX)).toHaveCount(0);
});

test('selecting a doc opens it in the centre, and the list stays put', async ({ page }) => {
  await boot(page);

  const before = await box(page, LIST);
  await page.locator(`${LIST} [data-testid="list-tile"]`).first().click();

  // The reader surface is the doc viewer mount — its presence is the proof
  // that `doc-edit` is wired, not merely importable.
  await expect(page.locator(CENTRE_READER)).toBeVisible();
  await expect(page.locator(CENTRE_READER)).toHaveAttribute('data-stance', 'read');

  const after = await box(page, LIST);
  expect(after.width).toBe(before.width);
  expect(after.x).toBe(before.x);
});

test('a read-only doc refuses Edit with its reason, rather than hiding the verb', async ({ page }) => {
  await boot(page);
  // `docLayoutSpec` is the fixture's deliberately restricted doc ("viewer can
  // look, not touch"), so this is the L6 path — visible, dead, and stating why.
  await page.locator(`${LIST} [data-testid="list-tile"]`).first().click();
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  await expect(page.getByTestId('doc-edit-entry')).toHaveCount(0);
  const refused = page.getByRole('button', { name: /^Edit/ });
  await expect(refused).toBeVisible();
  await expect(refused).toBeDisabled();
  await expect(page.getByText(/Read-only/i).first()).toBeVisible();
});

test('an editable doc opens the split editor: source beside a LIVE preview', async ({ page }) => {
  await boot(page);
  // The chapters carry no restricted detail, so the seam synthesises them with
  // full capabilities — this is the writable path.
  await page.locator(`${LIST} [data-testid="list-tile"]`).nth(1).click();
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  await page.getByTestId('doc-edit-entry').click();
  await expect(page.locator(CENTRE_READER)).toHaveAttribute('data-stance', 'edit');
  await expect(page.getByTestId('doc-split')).toBeVisible();

  // Both halves are laid out at once — that is what makes it a split rather
  // than a stance toggle: source on the left, preview on the right.
  const source = await box(page, '[data-testid="doc-source"]');
  const preview = await box(page, '[data-testid="doc-preview"]');
  expect(source.x).toBeLessThan(preview.x);

  // Clean draft ⇒ collapse is live.
  await expect(page.getByTestId('doc-collapse')).toBeVisible();

  // THE PREVIEW IS LIVE, and renders the DRAFT rather than the saved body.
  await page.locator('[data-testid="doc-source"]').first()
    .fill('## Draft heading\n\n- first bullet\n- second bullet\n\n**bold run**');
  const previewPane = page.locator('[data-testid="doc-preview"]');
  await expect(previewPane.locator('h2')).toHaveText('Draft heading');
  await expect(previewPane.locator('li')).toHaveCount(2);
  await expect(previewPane.locator('strong')).toHaveText('bold run');

  // Dirty ⇒ collapse must REFUSE rather than silently discard the draft, and
  // it must say the true reason, not "this view was mounted without a dispatch".
  await expect(page.getByTestId('doc-collapse')).toHaveCount(0);
  const refused = page.getByRole('button', { name: /Collapse back to the panel/i });
  await expect(refused).toBeDisabled();
  await expect(page.getByText(/unsaved changes/i).first()).toBeVisible();
});

test('the read view renders real markdown — headings, lists, emphasis, code', async ({ page }) => {
  await boot(page);
  await page.locator(`${LIST} [data-testid="list-tile"]`).nth(1).click();

  const md = page.locator('[data-testid="entity-view-detail"] [data-testid="reader-markdown"]');
  await expect(md).toBeVisible();

  // Write a document exercising the shapes the old four-shape parser destroyed,
  // save it, and read it back through the READER (not the preview).
  await page.getByTestId('doc-edit-entry').click();
  await page.locator('[data-testid="doc-source"]').first().fill(
    '# Title\n\nIntro with **bold**, *italic* and `inline code`.\n\n'
    + '- alpha\n- beta\n  - nested\n\n1. one\n2. two\n\n'
    + '> a quoted line\n\n'
    + '| col a | col b |\n| --- | --- |\n| 1 | 2 |\n\n'
    + '```ts\nconst cMin = max(320, v);\n```\n',
  );
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByTestId('doc-collapse')).toBeVisible();
  await page.getByTestId('doc-collapse').click();

  await expect(page.locator(CENTRE_READER)).toHaveAttribute('data-stance', 'read');
  await expect(md.locator('h1')).toHaveText('Title');
  await expect(md.locator('strong')).toHaveText('bold');
  await expect(md.locator('em')).toHaveText('italic');
  await expect(md.locator('ul li')).toHaveCount(3); // alpha, beta, nested
  await expect(md.locator('ol li')).toHaveCount(2);
  await expect(md.locator('blockquote')).toContainText('a quoted line');
  await expect(md.locator('table td')).toHaveCount(2);

  // The fence renders as REAL CODE, labelled — not the old "not rendered" chip.
  const fence = md.locator('[data-testid="markdown-fence"]');
  await expect(fence).toHaveAttribute('data-lang', 'ts');
  await expect(fence).toContainText('const cMin = max(320, v);');
  await expect(md.getByText(/not rendered/i)).toHaveCount(0);
});

test('Discussion and Connections open the THIRD column instead of replacing the body', async ({ page }) => {
  await boot(page);
  await page.locator(`${LIST} [data-testid="list-tile"]`).first().click();
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  const detailBefore = await box(page, DETAIL);

  await page.getByRole('tab', { name: /Connections/i }).click();
  await expect(page.locator(AUX)).toBeVisible();

  // THE POINT OF THE THIRD COLUMN: the document is still on screen. A tab that
  // swapped the body would leave the reader surface unmounted.
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  const list = await box(page, LIST);
  const detail = await box(page, DETAIL);
  const aux = await box(page, AUX);

  // Left → centre → right, in that order, all three laid out at once.
  expect(list.x).toBeLessThan(detail.x);
  expect(detail.x).toBeLessThan(aux.x);

  // The aux takes its width from the CENTRE, never from the rail.
  expect(await cssWidth(page, LIST)).toBe('320px');
  expect(detail.width).toBeLessThan(detailBefore.width);
  expect(aux.width).toBeGreaterThan(300);

  // Esc walks down one rung: aux closes, the document stays open.
  await page.keyboard.press('Escape');
  await expect(page.locator(AUX)).toHaveCount(0);
  await expect(page.locator(CENTRE_READER)).toBeVisible();
});

test('a linked entity inside the body opens BESIDE the document, not over it', async ({ page }) => {
  await boot(page);
  await page.locator(`${LIST} [data-testid="list-tile"]`).first().click();
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  // The outline's chapter chips are the doc's in-body entity references. Their
  // presence is asserted, NOT skipped past: a skipped test would let this
  // trigger rot silently, and it is one of the three the aux column exists for.
  const chapter = page.getByTestId('reader-toc-chip').first();
  await expect(chapter).toBeVisible();
  const chapterName = (await chapter.textContent())?.trim() ?? '';

  await chapter.click();

  // It opens BESIDE the document — the reader surface must survive the click.
  await expect(page.locator(AUX)).toBeVisible();
  await expect(page.locator(CENTRE_READER)).toBeVisible();

  // And the aux is genuinely about the thing that was clicked, not a shell.
  await expect(page.locator(`${AUX} .ev-aux__crumb`)).toHaveText(chapterName);

  const detail = await box(page, DETAIL);
  const aux = await box(page, AUX);
  expect(detail.x).toBeLessThan(aux.x);
});

test('the layout holds for a non-doc kind — it is generic, not doc-special', async ({ page }) => {
  await boot(page, 'task');

  const list = await box(page, LIST);
  const detail = await box(page, DETAIL);
  expect(await cssWidth(page, LIST)).toBe('320px');
  expect(list.x).toBeLessThan(detail.x);
  expect(detail.width).toBeGreaterThan(list.width * 3);
});

/**
 * THE BOARD IS THE EXCEPTION TO THE RAIL, and this is the only place the claim
 * is checkable. The unit test can say the centre is unmounted; it cannot say
 * the board actually got the width, because jsdom has no layout engine and a
 * board still trapped in a 320px rail passes every structural assertion there.
 */
test('switching to the board gives it the WHOLE screen, rail width and all', async ({ page }) => {
  await boot(page, 'task');

  const railWidth = (await box(page, LIST)).width;
  const screen = await box(page, '[data-testid="entity-view"]');

  await page.getByRole('button', { name: 'board layout' }).click();
  await expect(page.getByTestId('board-body')).toBeVisible();

  // The centre is GONE, not merely covered.
  await expect(page.locator(DETAIL)).toHaveCount(0);

  const board = await box(page, LIST);
  expect(board.width).toBeGreaterThan(railWidth * 3);
  // "The entire thing" — the region spans the screen, give or take a border.
  expect(screen.width - board.width).toBeLessThan(2);

  // And the width buys what it was for: more than the one-and-a-bit columns
  // that fitted in the rail. 236px floor each, so a rail could never do this.
  const columns = page.locator('.lp__board-col');
  expect(await columns.count()).toBeGreaterThan(3);
});

/**
 * THE BOARD SCROLLS, THE COLUMNS DO NOT.
 *
 * Each column used to carry its own `overflow-y` and was locked to the
 * viewport height, so a long column became a short well you scrolled inside
 * while the board around it never moved — six independent scrollbars, and no
 * way to read two columns at the same offset. This is a pure geometry claim,
 * so the cards are INJECTED: what is under test is which box overflows, not
 * where the rows came from.
 */
test('a long column scrolls the BOARD, not a well inside the column', async ({ page }) => {
  await boot(page, 'task');
  await page.getByRole('button', { name: 'board layout' }).click();
  await expect(page.getByTestId('board-body')).toBeVisible();

  // Fill the tallest column well past the viewport.
  await page.evaluate(() => {
    const cards = document.querySelector('.lp__board-cards');
    if (!cards) throw new Error('no card area');
    const seed = cards.querySelector('*');
    if (!seed) throw new Error('no card to clone');
    for (let i = 0; i < 40; i += 1) cards.appendChild(seed.cloneNode(true));
  });

  const metrics = await page.evaluate(() => {
    const cols = document.querySelector('.lp__board-cols')!;
    const cards = document.querySelector('.lp__board-cards')!;
    return {
      boardScroll: cols.scrollHeight - cols.clientHeight,
      cardsScroll: cards.scrollHeight - cards.clientHeight,
      cardsOverflowY: getComputedStyle(cards).overflowY,
    };
  });

  // The board is what overflows...
  expect(metrics.boardScroll).toBeGreaterThan(200);
  // ...and the column is NOT a scroller. `visible` is the proof the well is
  // gone; a leftover `auto` would still trap the cards even at this height.
  expect(metrics.cardsOverflowY).toBe('visible');
  expect(metrics.cardsScroll).toBe(0);

  // It really scrolls, and the header stays pinned so the column you are
  // reading is still named after you have scrolled away from the top.
  const HEAD = '.lp__board-col:first-child .lp__board-head';
  const headTopBefore = (await box(page, HEAD)).y;
  await page.locator('.lp__board-cols').evaluate((el) => el.scrollBy(0, 400));
  await expect(page.locator('.lp__board-cols')).not.toHaveJSProperty('scrollTop', 0);
  const headTopAfter = (await box(page, HEAD)).y;
  expect(Math.abs(headTopAfter - headTopBefore)).toBeLessThan(2);
});

test('a card on the board opens BESIDE it — the board keeps its width', async ({ page }) => {
  await boot(page, 'task');
  await page.getByRole('button', { name: 'board layout' }).click();
  await expect(page.getByTestId('board-body')).toBeVisible();

  const before = await box(page, LIST);
  await page.locator('.lp__board-col [data-testid="list-tile"]').first().click();

  // The aux column, not the centre: there is no centre in this layout, so
  // routing the click there would have opened nothing at all.
  await expect(page.locator(AUX)).toBeVisible();
  await expect(page.locator(DETAIL)).toHaveCount(0);
  await expect(page.getByTestId('board-body')).toBeVisible();

  const after = await box(page, LIST);
  const aux = await box(page, AUX);
  expect(after.x).toBeLessThan(aux.x);
  // The board yields the aux column's width and no more — it is still the
  // subject of the screen, not a rail again.
  expect(after.width).toBeGreaterThan(before.width - aux.width - 2);

  // Esc walks down the same rung it does everywhere else.
  await page.keyboard.press('Escape');
  await expect(page.locator(AUX)).toHaveCount(0);
});

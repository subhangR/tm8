// @vitest-environment jsdom
/**
 * THE ICON RAIL'S OPEN-COUNT BADGES.
 *
 * TWO LAYERS, AND THEY PROVE DIFFERENT THINGS.
 *
 * The first block mounts `HomeRail` DIRECTLY with a stub accessor. That is the
 * only way to state the trichotomy at all: `undefined` (not read), `0` (read,
 * none open) and a positive count are three distinct inputs, and no fixture
 * dataset can be posed into all three at once. A stub is not a weaker test
 * here, it is the only test that can name the cases.
 *
 * The second block runs the number through the REAL seam and asserts the rail
 * agrees with `categoryCounts` — the claim the whole feature rests on, which a
 * stub by construction cannot make. It reads the expected value OUT of the
 * aggregate rather than hard-coding it, so it measures the wiring rather than
 * re-stating a fixture constant that drifts the moment anyone edits the data.
 */
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import { HomeRail } from './HomeRail';
import { homeRailGroups } from '../domain';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data/fixtures/seam-fixture';

function mount(openCountFor?: (kind: string) => number | undefined, collapsed = false) {
  return render(
    <div className="cv2-root">
      <HomeRail
        groups={homeRailGroups()}
        activeKind="task"
        onSelect={() => {}}
        collapsed={collapsed}
        onToggleCollapsed={() => {}}
        openCountFor={openCountFor}
      />
    </div>,
  );
}

const taskRow = (view: ReturnType<typeof mount>) =>
  within(view.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ });

describe('the rail badge draws what is OPEN', () => {
  it('draws the count, and names it — a bare number would announce a quantity of nothing', () => {
    const view = mount((kind) => (kind === 'task' ? 12 : 0));
    const row = taskRow(view);
    expect(row.querySelector('.hr-rail__badge')?.textContent).toBe('12');
    /* The ACCESSIBLE NAME, which is not the text content: adjacent inline
       spans concatenate with no separator, so the content alone reads
       "Tasks12" — the number fused to the word, and no unit at all. The
       explicit label is what makes it a sentence. */
    expect(within(view.getByTestId('home-rail')).getByRole('button', { name: 'Tasks, 12 open' })).toBe(row);
    /* The visible word stays the START of the name, so voice control's
       "click Tasks" still hits this row (WCAG 2.5.3). */
    expect(within(view.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ })).toBe(row);
    view.unmount();
  });

  it('draws NOTHING at zero — a caught-up rail is quiet, not a column of noughts', () => {
    const view = mount(() => 0);
    const rail = view.getByTestId('home-rail');
    expect(rail.querySelectorAll('.hr-rail__badge')).toHaveLength(0);
    /* Specifically: no literal `0` anywhere. A badge that rendered `0` would
       pass a `.hr-rail__badge` count of zero only by accident of styling. */
    expect(rail.textContent).not.toMatch(/\b0\b/);
    view.unmount();
  });

  it('draws NOTHING when the count was never read — and says so differently in the title', () => {
    const unread = mount(() => undefined);
    const unreadRow = taskRow(unread);
    expect(unread.getByTestId('home-rail').querySelectorAll('.hr-rail__badge')).toHaveLength(0);
    /* THE DISTINCTION THAT MUST SURVIVE. Zero and unknown both draw nothing,
       so the rendered badge cannot tell them apart — the title is where the
       fact is still legible, and losing it is how "we never asked" quietly
       becomes "there are none". */
    expect(unreadRow.getAttribute('title')).toBe('Tasks');
    unread.unmount();

    const read = mount(() => 0);
    expect(taskRow(read).getAttribute('title')).toBe('Tasks — 0 open');
    read.unmount();
  });

  it('a host that passes no accessor mounts the rail unchanged', () => {
    const view = mount(undefined);
    expect(view.getByTestId('home-rail').querySelectorAll('.hr-rail__badge')).toHaveLength(0);
    expect(taskRow(view).getAttribute('title')).toBe('Tasks');
    view.unmount();
  });

  it('the badge survives COLLAPSE — the rail\'s default state is the one that must carry it', () => {
    /* The rail ships collapsed, so a badge that only rendered expanded would
       be invisible to every viewer who never opens the rail. One element in
       both states (CSS moves it), so this is the same node, not a second copy
       that could drift. */
    const view = mount(() => 7, true);
    expect(view.getByTestId('home-rail').dataset.collapsed).toBe('true');
    expect(taskRow(view).querySelector('.hr-rail__badge')?.textContent).toBe('7');
    view.unmount();
  });
});

describe('the number is the SEAM\'s, not the rail\'s', () => {
  it('renders exactly what categoryCounts reports as to_do + in_progress', async () => {
    const seam = createFixtureSeam();
    const matrix = await seam.categoryCounts({ spaceId: FIXTURE_SPACE_ID });
    const tasks = matrix.byKind.task ?? {};
    const open = (tasks.to_do ?? 0) + (tasks.in_progress ?? 0);
    /* Guard the guard: if the fixture ever has no open tasks this case would
       assert "nothing rendered" and pass while proving nothing. */
    expect(open).toBeGreaterThan(0);

    const view = mount((kind) => (kind === 'task' ? open : undefined));
    expect(taskRow(view).querySelector('.hr-rail__badge')?.textContent).toBe(String(open));
    view.unmount();
  });

  it('IGNORES the paging fields — a count is not a page length', async () => {
    /* THE MISTAKE THIS FORBIDS, stated: the op takes the same body as `query`,
       so the lazy implementation counts the page it would have returned. That
       reads as correct on a small space and silently caps everywhere else.
       `limit: 1` is the sharpest probe available — if paging were honoured at
       all, every kind would report at most one row. */
    const seam = createFixtureSeam();
    const sum = (m: Awaited<ReturnType<typeof seam.categoryCounts>>) =>
      Object.values(m.byKind).reduce(
        (n, bucket) => n + Object.values(bucket ?? {}).reduce((acc, c) => acc + c, 0),
        0,
      );

    const unpaged = sum(await seam.categoryCounts({ spaceId: FIXTURE_SPACE_ID }));
    const paged = sum(await seam.categoryCounts({ spaceId: FIXTURE_SPACE_ID, limit: 1 }));
    /* Guard the guard: with fewer than two categorised rows the two sums would
       agree no matter what the implementation did. */
    expect(unpaged).toBeGreaterThan(1);
    expect(paged).toBe(unpaged);
  });

  it('counts exactly the rows the SAME query would page — badge and list are one claim', async () => {
    const seam = createFixtureSeam();
    const matrix = await seam.categoryCounts({ spaceId: FIXTURE_SPACE_ID, kinds: ['task'] });
    const counted = Object.values(matrix.byKind.task ?? {}).reduce((n, c) => n + c, 0);
    const listed = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'], limit: Number.MAX_SAFE_INTEGER,
    });
    /* Every fixture task carries a category, so the list and the matrix cover
       the same rows and the two numbers must be equal — not merely close. */
    expect(counted).toBe(listed.page.items.length);
    expect(counted).toBeGreaterThan(0);
  });

  it('a FILTER moves the count — otherwise it is not running the query\'s predicate at all', async () => {
    /* The load-bearing property of building this over `buildWhere()`. A count
       that ignored filters would still pass every case above; only a narrowed
       query can tell the difference. */
    const seam = createFixtureSeam();
    const all = await seam.categoryCounts({ spaceId: FIXTURE_SPACE_ID, kinds: ['task'] });
    const open = await seam.categoryCounts({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'], filters: { category: ['to_do'] },
    });
    const total = Object.values(all.byKind.task ?? {}).reduce((n, c) => n + c, 0);
    expect(open.byKind.task?.to_do).toBe(all.byKind.task?.to_do);
    expect(open.byKind.task?.in_progress).toBeUndefined();
    expect(Object.values(open.byKind.task ?? {}).reduce((n, c) => n + c, 0)).toBeLessThan(total);
  });
});

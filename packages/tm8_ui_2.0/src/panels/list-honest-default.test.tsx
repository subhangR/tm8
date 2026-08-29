// @vitest-environment jsdom
/**
 * THE 2026-08-29 LIST-HONESTY AUDIT, pinned — three findings, one panel.
 *
 * 1. THE EMPTY-DEFAULT-TAB LIE. Six screens (Commits, Files, Artifacts,
 *    Memories among them) opened on "To Do 0 — No X here yet — create one"
 *    while their own footer printed "3 done": `kind_seeds_done` (152) births
 *    those kinds straight into Done, so the default band was empty by
 *    construction and the empty-state copy contradicted the counts on the
 *    same screen. The fix is a DERIVED landing correction: with no stored
 *    pick, an empty resolved default yields to the first band with rows —
 *    and the copy, where an empty band is still shown, names the band and
 *    points at the rows instead of claiming there are none.
 *
 * 2. LIBRARY KINDS WORE TASK CLOTHES. A done file/memory/artifact rendered
 *    the completed STRIKETHROUGH — a healthy stored row reading as deleted.
 *    `list.lifecycle: 'library'` (registry DATA, §15.2) suppresses the
 *    treatment; the four shared category tabs are deliberately untouched.
 *
 * 3. DESTRUCTIVE ROW VERBS WERE SILENT. Archive and the tick remove the row
 *    from the open band instantly; nothing said so and nothing offered a way
 *    back. The panel now shows a 5s trace — with Undo for archive, whose
 *    inverse (`restore`) rides the same `onArchive` executor, and without
 *    Undo for complete, whose executor contract has no inverse verb.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { allKinds, getKind, type ActionContext } from '../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureSummaries,
  fileScreenshot,
  memoryTokens,
  docLayoutSpec,
} from '../fixtures';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const CAPS_FULL = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
} as const;

const TASK: EntitySummary = fixtureSummaries.find((s) => s.kind === 'task')!;
const SESSION: EntitySummary = fixtureSummaries.find((s) => s.kind === 'work_session')!;

function task(
  id: string,
  title: string,
  category: StatusCategory,
  deleted = false,
): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: deleted ? '2026-08-29T00:00:00.000Z' : null,
    category,
  };
}

function session(id: string, title: string, category: StatusCategory): EntitySummary {
  return {
    ...SESSION,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category,
  };
}

/** Honours `category` and `deleted` the way the seam does — the landing
 *  correction is invisible under the suite's usual `(_filter) => rows`. */
function bandedRowsFor(rows: readonly EntitySummary[]) {
  return (filter: QueryFilter): readonly EntitySummary[] =>
    rows.filter((row) => {
      const deleted = filter.deleted ?? 'exclude';
      if (deleted === 'exclude' && row.deletedAt !== null) return false;
      if (deleted === 'only' && row.deletedAt === null) return false;
      if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;
      return true;
    });
}

function openTab(view: { getAllByRole: (r: string) => HTMLElement[] }): string | undefined {
  return view
    .getAllByRole('tab')
    .find((t) => t.getAttribute('aria-selected') === 'true')
    ?.textContent?.replace(/\s*\d+\+?$/, '');
}

/* The stored-pick slot the panel reads and writes — `usePanelChoice`'s key. */
const storedKeyOf = (kind: string) => `tm8ui.panel-choice.list-category.${kind}`;

beforeEach(() => localStorage.clear());

describe('finding 1 — the landing tab is never an empty band over a populated kind', () => {
  it('with no stored pick, an empty default yields to the first band with rows', () => {
    /* The reported screens exactly: every row lives in Done, the default is
       To Do, and before the fix the panel opened on "To Do 0" over an
       empty-state sentence while the footer said "1 done". */
    const view = render(
      <EntityListPanel kind="task" rowsFor={bandedRowsFor([task('t1', 'Shipped it', 'done')])} ctx={ctx} />,
    );
    expect(openTab(view)).toBe('Done');
    expect(view.container.textContent).toContain('Shipped it');
  });

  it('the correction is derived, never persisted — the first stored pick stays the viewer’s', () => {
    render(
      <EntityListPanel kind="task" rowsFor={bandedRowsFor([task('t1', 'Shipped it', 'done')])} ctx={ctx} />,
    );
    expect(localStorage.getItem(storedKeyOf('task'))).toBeNull();
  });

  it('the registry default keeps its seat while ITS band has rows', () => {
    /* work_session declares `defaultCategory: 'in_progress'` — with a live
       row present the correction must not fire, however full Done is. */
    const rows = [
      session('ws1', 'still going', 'in_progress'),
      session('ws2', 'ended a', 'done'),
      session('ws3', 'ended b', 'done'),
    ];
    const view = render(
      <EntityListPanel kind="work_session" rowsFor={bandedRowsFor(rows)} ctx={ctx} />,
    );
    expect(openTab(view)).toBe('In Progress');
    expect(view.container.textContent).toContain('still going');
  });

  it('…and an empty registry default yields too — to the first non-empty band in tab order', () => {
    const view = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={bandedRowsFor([session('ws2', 'ended a', 'done')])}
        ctx={ctx}
      />,
    );
    expect(openTab(view)).toBe('Done');
  });

  it('a stored pick ALWAYS wins, even a pick of an empty band', () => {
    localStorage.setItem(storedKeyOf('task'), 'to_do');
    const view = render(
      <EntityListPanel kind="task" rowsFor={bandedRowsFor([task('t1', 'Shipped it', 'done')])} ctx={ctx} />,
    );
    expect(openTab(view)).toBe('To Do');
  });

  it('a genuinely empty kind corrects nothing and keeps the create invitation', () => {
    const view = render(<EntityListPanel kind="task" rowsFor={bandedRowsFor([])} ctx={ctx} />);
    expect(openTab(view)).toBe('To Do');
    expect(view.container.textContent).toContain('No tasks here yet');
  });
});

describe('finding 1 — the empty band’s sentence matches the counts on screen', () => {
  it('an empty tab over a populated kind says where the rows are, never "no X here yet"', () => {
    localStorage.setItem(storedKeyOf('task'), 'to_do');
    const rows = [
      task('t1', 'Shipped it', 'done'),
      task('t2', 'Shipped it too', 'done'),
      task('t3', 'Abandoned it', 'cancelled'),
    ];
    const view = render(<EntityListPanel kind="task" rowsFor={bandedRowsFor(rows)} ctx={ctx} />);
    expect(view.container.textContent).toContain('Nothing in To Do — 2 in Done · 1 in Cancelled.');
    expect(view.container.textContent).not.toContain('here yet');
  });

  it('the total-zero case keeps the old copy — "create one" is only said when it is true', () => {
    localStorage.setItem(storedKeyOf('task'), 'to_do');
    const view = render(<EntityListPanel kind="task" rowsFor={bandedRowsFor([])} ctx={ctx} />);
    expect(view.container.textContent).toContain('No tasks here yet');
  });
});

describe('finding 2 — library kinds do not wear task clothes', () => {
  it('the library kinds declare it as REGISTRY DATA; work kinds stay work', () => {
    /* `commit` joined in wave 3 — the other `kind_seeds_done` member the
       2026-08-29 fix missed, so every commit tile (immutable history!)
       rendered struck through. `member`, `team_member` and `project` joined
       for the identity/fact-about-the-world reason their registry rows state:
       a done HUMAN or persona must never render as crossed-out work. */
    for (const kind of [
      'file', 'artifact', 'memory', 'collection', 'spell', 'skill',
      'commit', 'member', 'team_member', 'project',
    ]) {
      expect(getKind(kind).list.lifecycle, kind).toBe('library');
    }
    for (const kind of ['task', 'doc', 'pull_request']) {
      expect(getKind(kind).list.lifecycle, kind).toBeUndefined();
    }
    /* work_session is neither: a done session is the RECORD OF A RUN — not
       finished work needing a strike, not curated library material. The third
       value was added (wave 3) for exactly this kind; 471 of 477 rows on the
       launch node rendered struck through under the 'work' default. */
    expect(getKind('work_session').list.lifecycle).toBe('record');
    /* The closed vocabulary stays closed: nothing else invents a value. */
    for (const row of allKinds()) {
      expect([undefined, 'work', 'library', 'record']).toContain(row.list.lifecycle);
    }
  });

  it('a done library row keeps its title readable and carries data-lifecycle="library"', () => {
    /* memoryTokens and fileScreenshot are both seeded `done` (152): before
       the registry field every healthy row on those screens was struck
       through, which reads as deleted. */
    for (const row of [memoryTokens, fileScreenshot]) {
      expect(row.category).toBe('done');
      const view = render(
        <EntityListPanel kind={row.kind} rowsFor={() => [row]} ctx={ctx} />,
      );
      const tile = view.container.querySelector('[data-testid="list-tile"]')!;
      expect(tile.getAttribute('data-lifecycle')).toBe('library');
      expect(tile.querySelector('.lp__title--completed'), `${row.kind} must not strike`).toBeNull();
      view.unmount();
    }
  });

  it('a done WORK row still earns the strikethrough — the treatment moved, it did not die', () => {
    const doneDoc = { ...docLayoutSpec, category: 'done' as const };
    const view = render(<EntityListPanel kind="doc" rowsFor={() => [doneDoc]} ctx={ctx} />);
    const tile = view.container.querySelector('[data-testid="list-tile"]')!;
    expect(tile.getAttribute('data-lifecycle')).toBe('work');
    expect(tile.querySelector('.lp__title--completed')).not.toBeNull();
  });

  it('the four shared category tabs are untouched on a library kind — tab renaming is out of scope', () => {
    const view = render(<EntityListPanel kind="file" rowsFor={() => [fileScreenshot]} ctx={ctx} />);
    const words = view.getAllByRole('tab').map((t) => t.textContent?.replace(/\s*\d+\+?$/, ''));
    expect(words).toEqual(['To Do', 'In Progress', 'Done', 'Cancelled']);
  });
});

describe('finding 3 — destructive row verbs leave a trace', () => {
  const liveTask = fixtureSummaries.find((r) => r.kind === 'task' && r.deletedAt == null)!;
  const deadTask = fixtureSummaries.find((r) => r.kind === 'task' && r.deletedAt != null)!;

  function mount(row: EntitySummary, handlers: { onArchive?: ReturnType<typeof vi.fn>; onComplete?: ReturnType<typeof vi.fn> }) {
    return render(
      <EntityListPanel
        kind="task"
        rowsFor={() => [row]}
        ctx={ctx}
        capabilitiesOf={() => CAPS_FULL}
        onArchive={handlers.onArchive ?? vi.fn()}
        onComplete={handlers.onComplete ?? vi.fn()}
      />,
    );
  }

  it('Archive still dispatches unchanged, then shows "Archived" with a live Undo', () => {
    const onArchive = vi.fn();
    const view = mount(liveTask, { onArchive });
    fireEvent.click(view.container.querySelector('[data-action="archive"]')!);

    /* Pass-through-first: the host executor got exactly the old call. */
    expect(onArchive).toHaveBeenCalledWith('archive', liveTask.id);

    const notice = view.getByTestId('row-verb-notice');
    expect(notice.textContent).toContain('Archived');

    /* Undo is the INVERSE VERB through the SAME executor — the contract the
       cluster itself already uses for an archived row. */
    fireEvent.click(view.getByTestId('row-verb-undo'));
    expect(onArchive).toHaveBeenLastCalledWith('restore', liveTask.id);
    expect(view.queryByTestId('row-verb-notice')).toBeNull();
  });

  it('Complete shows the trace WITHOUT Undo — its executor contract has no inverse verb', () => {
    /* `commands.complete` is the only operation permitted to write `done`
       (useRowLifecycle's verb→call map) and `onComplete(id)` carries no way
       back, so offering Undo here would be a control that cannot perform
       what it promises. The trace names the band the row moved to instead. */
    const onComplete = vi.fn();
    const view = mount(liveTask, { onComplete });
    fireEvent.click(view.container.querySelector('[data-action="complete"]')!);

    expect(onComplete).toHaveBeenCalledWith(liveTask.id);
    const notice = view.getByTestId('row-verb-notice');
    expect(notice.textContent).toContain('Completed — now under Done');
    expect(view.queryByTestId('row-verb-undo')).toBeNull();
  });

  it('Restore is not destructive and earns no trace', () => {
    const onArchive = vi.fn();
    const view = mount(deadTask, { onArchive });
    fireEvent.click(view.container.querySelector('[data-action="restore"]')!);
    expect(onArchive).toHaveBeenCalledWith('restore', deadTask.id);
    expect(view.queryByTestId('row-verb-notice')).toBeNull();
  });

  it('the trace stands down on its own after 5s', () => {
    vi.useFakeTimers();
    try {
      const view = mount(liveTask, { onArchive: vi.fn() });
      fireEvent.click(view.container.querySelector('[data-action="archive"]')!);
      expect(view.getByTestId('row-verb-notice')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(4999);
      });
      expect(view.queryByTestId('row-verb-notice')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(view.queryByTestId('row-verb-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

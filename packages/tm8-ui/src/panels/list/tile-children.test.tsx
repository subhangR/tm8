// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import { tileChildCount, type ActionContext, type QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, sessionLive, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * TILE CHILDREN (task 01a14b92). The list a status tab shows is one page of
 * one category, so a family is usually split across tabs. These pin the three
 * answers: the subscript counts every child (the server's number), opening a
 * row reads its children whatever their status (`parentIn`), and a row whose
 * parent is on another tab brings that parent in as CONTEXT (`idIn`) instead
 * of standing at the top level as if it had none.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const task = (id: string, title: string, parentId: string | null, extra: Partial<EntitySummary> = {}) =>
  ({ ...taskGuideLines, id, title, parentId, childCount: 0, ...extra }) as EntitySummary;

/** A node double that honours the two tree reads, like `collections.ts`. */
function node(tab: readonly EntitySummary[], all: readonly EntitySummary[]) {
  const asked: QueryFilter[] = [];
  const rowsFor = (filter: QueryFilter): readonly EntitySummary[] => {
    asked.push(filter);
    const f = filter as { idIn?: string[]; parentIn?: string[] };
    if (f.idIn) return all.filter((row) => f.idIn!.includes(row.id));
    if (f.parentIn) return all.filter((row) => row.parentId !== null && f.parentIn!.includes(row.parentId));
    return tab;
  };
  return { rowsFor, asked };
}

const tileTitled = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="list-tile"]')].find(
    (el) => el.querySelector('.pn-tt__title, .lp__title')?.textContent === title,
  );

describe('a subtask whose parent is on another tab', () => {
  it('draws the parent as a SHUT context row; opening it shows only the matching subtask', () => {
    const parent = task('t-parent', 'Done parent', null, { category: 'done', childCount: 3 });
    const kid = task('t-kid', 'Working kid', parent.id, { category: 'in_progress' });
    const { rowsFor, asked } = node([kid], [parent, kid]);
    const { container } = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);

    expect(asked).toContainEqual({ idIn: ['t-parent'] });
    const parentTile = tileTitled(container, 'Done parent')!;
    expect(parentTile.getAttribute('data-context')).toBe('true');
    // Collapsed by default (Subhang, 2026-10-18) — its subscript says what opening shows.
    const count = parentTile.querySelector<HTMLElement>('[data-testid="child-count"]')!;
    expect(count.textContent).toBe('1');
    expect(count.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="list-tile-children"]')).toBeNull();

    fireEvent.click(count);
    const children = container.querySelector<HTMLElement>('[data-testid="list-tile-children"]')!;
    expect(children.textContent).toContain('Working kid');
    // It does not read the parent's other children back into this tab.
    expect(asked.some((f) => 'parentIn' in f)).toBe(false);
    // And the subtask is no longer an orphan.
    expect(container.querySelector('[data-testid="parent-crumb"]')).toBeNull();

    fireEvent.click(count);
    expect(container.querySelector('[data-testid="list-tile-children"]')).toBeNull();
  });

  it('says ↑ parent when the parent cannot be read', () => {
    const kid = task('t-kid', 'Working kid', 't-gone');
    const { rowsFor } = node([kid], [kid]);
    const { container } = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    expect(tileTitled(container, 'Working kid')!.querySelector('[data-testid="parent-crumb"]')?.textContent).toBe('↑ parent');
  });
});

describe('opening a row reads its children', () => {
  it('a parent whose children are on other tabs counts them all, and opening it reads them', () => {
    const parent = task('t-parent', 'Parent', null, { childCount: 2 });
    const kids = [task('t-a', 'Kid A', parent.id, { category: 'done' }), task('t-b', 'Kid B', parent.id)];
    const { rowsFor, asked } = node([parent], [parent, ...kids]);
    const { container } = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    const count = tileTitled(container, 'Parent')!.querySelector<HTMLElement>('[data-testid="child-count"]')!;
    expect(count.textContent).toBe('2');
    // Collapsed on first load: no children drawn, none read.
    expect(count.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="list-tile-children"]')).toBeNull();
    expect(asked.some((f) => 'parentIn' in f)).toBe(false);

    fireEvent.click(count);
    // A task's children ride along whatever their tab (01a14b92): no tab filter on the read.
    expect(asked).toContainEqual({ parentIn: ['t-parent'] });
    const children = container.querySelector<HTMLElement>('[data-testid="list-tile-children"]')!;
    expect(children.textContent).toContain('Kid A');
    expect(children.textContent).toContain('Kid B');
    // A task tree draws every child in line: the other-tab fold is sessions only.
    expect(container.querySelector('[data-testid="child-fold"]')).toBeNull();
  });
});

/**
 * THE OTHER-TAB FOLD (task 01a1821d). A session tab asks whether a process is
 * alive, so a Running parent — here a coordinator that is finished but still
 * open — draws its live child in line and folds the exited one behind
 * `▸ 1 ended`, which opens to show it. The exited one is also on Completed, as
 * a root whose crumb names the parent and its tab.
 */
describe('a Running session parent with an exited and a running child', () => {
  const session = (id: string, title: string, status: string, outcome: string, launchedBy: string | null, sessions = 0) =>
    ({
      ...sessionLive,
      id,
      title,
      parentId: null,
      counters: { ...sessionLive.counters, sessions },
      state: { ...sessionLive.state, status, outcome, ...(launchedBy ? { launchedBy } : {}) },
    }) as EntitySummary;
  const parent = session('ses-coord', 'Coordinator', 'idle', 'completed', null, 2);
  const live = session('ses-live', 'Live kid', 'running', 'open', parent.id);
  const ended = session('ses-ended', 'Ended kid', 'exited', 'completed', parent.id);
  const all = [parent, live, ended];

  /** A node double that honours the session tab axes and the tree reads. */
  function sessionNode() {
    const asked: QueryFilter[] = [];
    const rowsFor = (filter: QueryFilter): readonly EntitySummary[] => {
      asked.push(filter);
      const f = filter as { idIn?: string[]; launchedBy?: string[]; sessionStatus?: string[]; sessionOutcome?: string[] };
      return all.filter((row) => {
        const st = row.state as unknown as { status: string; outcome: string; launchedBy?: string };
        if (f.idIn && !f.idIn.includes(row.id)) return false;
        if (f.launchedBy && !(st.launchedBy && f.launchedBy.includes(st.launchedBy))) return false;
        if (f.sessionStatus && !f.sessionStatus.includes(st.status)) return false;
        if (f.sessionOutcome && !f.sessionOutcome.includes(st.outcome)) return false;
        return true;
      });
    };
    return { rowsFor, asked };
  }
  const sessionTile = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-session-node="${id}"]`);
  const panel = () => {
    const { rowsFor, asked } = sessionNode();
    const view = render(<EntityListPanel kind="work_session" rowsFor={rowsFor} rowsForKind={() => rowsFor} ctx={ctx} />);
    return { ...view, asked };
  };

  it('under Running, the exited child folds behind "1 ended", which expands to show it', () => {
    const { container, asked } = panel();
    const coord = sessionTile(container, 'ses-coord')!;
    // The count is every child: 1 live + 1 ended.
    expect(coord.getAttribute('data-children')).toBe('2');

    fireEvent.click(coord.querySelector<HTMLElement>('.pn-st__arrow')!);
    // The read still asks for every child (ruling 01a14b92); the tab only folds.
    expect(asked).toContainEqual({ launchedBy: ['ses-coord'] });
    const children = container.querySelector<HTMLElement>('[data-testid="list-tile-children"]')!;
    expect(sessionTile(children, 'ses-live')).not.toBeNull();
    expect(sessionTile(container, 'ses-ended')).toBeNull();
    const fold = children.querySelector<HTMLElement>('[data-testid="child-fold"]')!;
    expect(fold.textContent).toBe('1 ended');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    // The live child comes first; the fold sits after it.
    expect([...children.children].indexOf(sessionTile(children, 'ses-live')!.closest('.lp__branch')!)).toBeLessThan(
      [...children.children].indexOf(fold),
    );

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(sessionTile(children, 'ses-ended')).not.toBeNull();

    fireEvent.click(fold);
    expect(sessionTile(container, 'ses-ended')).toBeNull();
  });

  it('under Completed, the exited child is a root that points at its parent', () => {
    const { container, getByRole } = panel();
    fireEvent.click(getByRole('tab', { name: /^Completed/ }));
    const tile = sessionTile(container, 'ses-ended')!;
    expect(tile).not.toBeNull();
    expect(tile.closest('[data-testid="list-tile-children"]')).toBeNull();
    expect(sessionTile(container, 'ses-live')).toBeNull();
    // The session anatomy's `↑ parent`: it names the parent and its tab.
    expect(tile.querySelector('[data-testid="session-row-crumb"]')?.textContent).toBe('↳ under Coordinator (Running)');
  });
});

describe('tileChildCount', () => {
  const doc = docLayoutSpec;
  it('takes the server count, never fewer than the loaded children', () => {
    expect(tileChildCount({ ...doc, childCount: 6 }, 1, false)).toBe(6);
    expect(tileChildCount({ ...doc, childCount: 1 }, 3, false)).toBe(3);
  });
  it('falls back to a doc state count, then to the loaded rows', () => {
    const { childCount: _drop, ...bare } = { ...doc, childCount: undefined };
    expect(tileChildCount({ ...bare, state: { kind: 'doc', format: 'markdown', childCount: 4 } } as EntitySummary, 0, false)).toBe(4);
    expect(tileChildCount({ ...bare, state: { ...taskGuideLines.state } } as EntitySummary, 2, false)).toBe(2);
  });
  it('a launcher counts the sessions it launched, not its parent_id children', () => {
    const counters = { ...doc.counters, sessions: 5 };
    expect(tileChildCount({ ...doc, childCount: 9, counters }, 0, true)).toBe(5);
  });
});

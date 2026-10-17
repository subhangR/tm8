// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import { tileChildCount, type ActionContext, type QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, taskGuideLines } from '../../fixtures';
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
  it('draws the parent as an open CONTEXT row, with the matching subtask under it', () => {
    const parent = task('t-parent', 'Done parent', null, { category: 'done', childCount: 3 });
    const kid = task('t-kid', 'Working kid', parent.id, { category: 'in_progress' });
    const { rowsFor, asked } = node([kid], [parent, kid]);
    const { container } = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);

    expect(asked).toContainEqual({ idIn: ['t-parent'] });
    const parentTile = tileTitled(container, 'Done parent')!;
    expect(parentTile.getAttribute('data-context')).toBe('true');
    // Open, holding only what matched — its subscript says what opening shows.
    const count = parentTile.querySelector<HTMLElement>('[data-testid="child-count"]')!;
    expect(count.textContent).toBe('1');
    expect(count.getAttribute('aria-expanded')).toBe('true');
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
    expect(asked.some((f) => 'parentIn' in f)).toBe(false);

    fireEvent.click(count);
    expect(asked).toContainEqual({ parentIn: ['t-parent'] });
    const children = container.querySelector<HTMLElement>('[data-testid="list-tile-children"]')!;
    expect(children.textContent).toContain('Kid A');
    expect(children.textContent).toContain('Kid B');
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

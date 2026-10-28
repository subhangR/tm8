// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, sessionLive, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * `rowLead="icon"` — the Workspace browser's row lead. No chevron slot on any
 * anatomy; the leading icon is the expand button when (and only when) the row
 * has children, and nothing but that icon changes expansion.
 *
 * ONE GRAMMAR (task 01a14b92, superseding the quiet tile's `▸ N` chip): on
 * every anatomy the lead icon is the disclosure and wears the child count as
 * a subscript on its corner. The cases below assert it against all three.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

function family(template: EntitySummary, n: number): EntitySummary[] {
  /* The server's live child count rides every row (`childCount`); a leaf
     says 0, so a template's own count cannot make it read as a parent. */
  const parent = { ...template, id: `${template.kind}-parent`, title: 'Parent', parentId: null, childCount: n } as EntitySummary;
  const kids = Array.from({ length: n }, (_, index) => ({
    ...template,
    id: `${template.kind}-kid-${index}`,
    title: `Child ${index}`,
    parentId: parent.id,
    childCount: 0,
  }) as EntitySummary);
  const leaf = { ...template, id: `${template.kind}-leaf`, title: 'Leaf', parentId: null, childCount: 0 } as EntitySummary;
  return [parent, ...kids, leaf];
}

function tileTitled(container: HTMLElement, title: string): HTMLElement {
  const tile = [...container.querySelectorAll<HTMLElement>('[data-testid="list-tile"]')].find(
    (el) => el.querySelector('.pn-tt__title, .lp__title, .pn-st__titleText')?.textContent?.startsWith(title),
  );
  if (!tile) throw new Error(`no tile titled ${title}`);
  return tile;
}

const leadOf = (tile: HTMLElement) => tile.querySelector<HTMLElement>('.lp-lead');

describe.each([
  ['task', taskGuideLines],
  ['doc', docLayoutSpec],
  ['work_session', sessionLive],
] as const)('rowLead="icon" on a %s list', (kind, template) => {
  const control = leadOf;

  it('draws no chevron slot, and has exactly one expand control', () => {
    const { container } = render(
      <EntityListPanel kind={kind} rowsFor={rowsFor(family(template, 2))} ctx={ctx} rowLead="icon" />,
    );
    expect(container.querySelector('.lp__disclosure, .pn-tt__arrow, .pn-st__arrow')).toBeNull();
    const parent = tileTitled(container, 'Parent');
    const owned = control(parent);
    expect(owned?.tagName).toBe('BUTTON');
    expect(owned?.getAttribute('aria-label')).toBe('Expand Parent, 2 children');
    expect(owned?.getAttribute('aria-expanded')).toBe('false');
    /* EXACTLY ONE. Two controls carrying the same accessible name would read
       as one broken control. */
    const named = [...parent.querySelectorAll('[aria-label^="Expand Parent"]')];
    expect(named).toHaveLength(1);
    // No `▸ N` chip after the title on any anatomy.
    expect(container.querySelector('.lp__kidchip')).toBeNull();
    // A leaf has no control at all — its icon is decoration.
    expect(leadOf(tileTitled(container, 'Leaf'))?.tagName).toBe('SPAN');
  });

  it('a click on the control expands without opening the row; a title click opens without expanding', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <EntityListPanel kind={kind} rowsFor={rowsFor(family(template, 2))} ctx={ctx} rowLead="icon" onSelect={onSelect} />,
    );
    const owned = () => control(tileTitled(container, 'Parent'))!;
    fireEvent.click(owned());
    expect(owned().getAttribute('aria-expanded')).toBe('true');
    expect(onSelect).not.toHaveBeenCalled();

    const title = tileTitled(container, 'Parent').querySelector<HTMLElement>('.pn-tt__title, .lp__title, .pn-st__titleText')!;
    fireEvent.click(title);
    expect(onSelect).toHaveBeenCalledWith(`${kind}-parent`);
    expect(owned().getAttribute('aria-expanded')).toBe('true');
  });

  it('a click on a leaf icon falls through and opens the row', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <EntityListPanel kind={kind} rowsFor={rowsFor(family(template, 2))} ctx={ctx} rowLead="icon" onSelect={onSelect} />,
    );
    fireEvent.click(leadOf(tileTitled(container, 'Leaf'))!);
    expect(onSelect).toHaveBeenCalledWith(`${kind}-leaf`);
  });
});

describe('rowLead="icon" — the reveal latches', () => {
  const rows = family(taskGuideLines, 2);
  const panel = (selectedId: string | null) => (
    <EntityListPanel kind="task" rowsFor={rowsFor(rows)} ctx={ctx} rowLead="icon" selectedId={selectedId} />
  );

  it('opening a child keeps its parent expanded after another row is selected', () => {
    const view = render(panel('task-kid-0'));
    const chip = () => leadOf(tileTitled(view.container, 'Parent'))!;
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    view.rerender(panel('task-leaf'));
    expect(chip().getAttribute('aria-expanded')).toBe('true');
  });

  it('one click on a revealed parent collapses it', () => {
    const view = render(panel('task-kid-0'));
    const chip = () => leadOf(tileTitled(view.container, 'Parent'))!;
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('rowLead="icon" — keyboard on a tree item', () => {
  it('Right expands, Left collapses then moves to the parent, Enter opens', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor(family(taskGuideLines, 1))} ctx={ctx} rowLead="icon" onSelect={onSelect} />,
    );
    const parentItem = () => tileTitled(container, 'Parent').closest<HTMLElement>('[role="treeitem"]')!;
    fireEvent.keyDown(parentItem(), { key: 'ArrowRight' });
    expect(parentItem().getAttribute('aria-expanded')).toBe('true');

    const childItem = tileTitled(container, 'Child 0').closest<HTMLElement>('[role="treeitem"]')!;
    childItem.focus();
    fireEvent.keyDown(childItem, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(parentItem());

    fireEvent.keyDown(parentItem(), { key: 'ArrowLeft' });
    expect(parentItem().getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(parentItem(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('task-parent');
  });
});

describe('without rowLead, nothing changes', () => {
  it('the task tile keeps its chevron slot', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor(family(taskGuideLines, 1))} ctx={ctx} />,
    );
    expect(container.querySelector('.pn-tt__arrow')).not.toBeNull();
    expect(container.querySelector('.lp-lead')).toBeNull();
  });
});

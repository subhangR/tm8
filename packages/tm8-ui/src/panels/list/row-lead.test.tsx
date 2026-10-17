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
 * TWO GRAMMARS SINCE THE QUIET TILE (task 01a1469f, design doc 01a1465d §6):
 * the STANDARD anatomy and the CONTROL CARD moved their disclosure onto a
 * `▸ N` chip after the title, and their lead icon is now decoration; the
 * session-tree anatomy keeps the lead as its control, because a session's
 * sub-session count rides the agent mark that IS its status glyph. `DISCLOSURE`
 * below is which one each kind uses, so the cases that follow assert the
 * SHARED behaviour — a control only where there are children, a click that
 * expands without opening the row, a leaf whose icon falls through — against
 * whichever element owns it.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

function family(template: EntitySummary, n: number): EntitySummary[] {
  const parent = { ...template, id: `${template.kind}-parent`, title: 'Parent', parentId: null } as EntitySummary;
  const kids = Array.from({ length: n }, (_, index) => ({
    ...template,
    id: `${template.kind}-kid-${index}`,
    title: `Child ${index}`,
    parentId: parent.id,
  }) as EntitySummary);
  const leaf = { ...template, id: `${template.kind}-leaf`, title: 'Leaf', parentId: null } as EntitySummary;
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
/** The ▸ N chip — the standard anatomy's disclosure since the quiet tile. */
const chipOf = (tile: HTMLElement) => tile.querySelector<HTMLElement>('.lp__kidchip');

/** Which element owns expansion on each anatomy, under `rowLead="icon"`. */
const DISCLOSURE = { task: 'chip', doc: 'chip', work_session: 'lead' } as const;

describe.each([
  ['task', taskGuideLines],
  ['doc', docLayoutSpec],
  ['work_session', sessionLive],
] as const)('rowLead="icon" on a %s list', (kind, template) => {
  const owner = DISCLOSURE[kind];
  const control = (tile: HTMLElement) => (owner === 'chip' ? chipOf(tile) : leadOf(tile));

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
       as one broken control, which is the reason the standard tile's lead
       icon stopped toggling when the chip took the job. */
    const named = [...parent.querySelectorAll('[aria-label^="Expand Parent"]')];
    expect(named).toHaveLength(1);
    // A leaf has no control at all — its icon is decoration.
    expect(leadOf(tileTitled(container, 'Leaf'))?.tagName).toBe('SPAN');
    expect(chipOf(tileTitled(container, 'Leaf'))).toBeNull();
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

  /* Read off the ▸ N chip, which is the task row's disclosure since the quiet
     tile — the latch itself (`useTreeDisclosure`) is unchanged. */
  it('opening a child keeps its parent expanded after another row is selected', () => {
    const view = render(panel('task-kid-0'));
    const chip = () => chipOf(tileTitled(view.container, 'Parent'))!;
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    view.rerender(panel('task-leaf'));
    expect(chip().getAttribute('aria-expanded')).toBe('true');
  });

  it('one click on a revealed parent collapses it', () => {
    const view = render(panel('task-kid-0'));
    const chip = () => chipOf(tileTitled(view.container, 'Parent'))!;
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

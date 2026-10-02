// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * THE SUB-ENTITY COUNT RIDES THE LEADING ICON, ON EVERY TREE ANATOMY.
 *
 * The session tile already drew its sub-session count on the agent icon's
 * corner and its chevron in a column of its own. The task tile drew its
 * chevron OVER the status dot (and kept its count in a `display: none` node),
 * and the standard tile drew its chevron over the kind mark with no count at
 * all. These pin the shared shape: one count, on the icon, nothing for a leaf,
 * and a chevron that is laid out rather than laid over.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

/** A root with `n` children and one leaf root, cloned from `template`. */
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
    (el) => el.querySelector('.pn-tt__title, .lp__title')?.textContent === title,
  );
  if (!tile) throw new Error(`no tile titled ${title}`);
  return tile;
}

describe('the sub-entity count on the leading icon', () => {
  it('a task parent carries its subtask count on the STATUS mark, beside — not under — its chevron', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor(family(taskGuideLines, 3))} ctx={ctx} />,
    );
    const parent = tileTitled(container, 'Parent');
    const status = parent.querySelector('.pn-tt__status');
    expect(status?.querySelector('[data-testid="child-count"]')?.textContent).toBe('3');
    // The chevron is the status mark's preceding SIBLING in the row, not a
    // layer stacked on it; the count is not a second copy beside the chevron.
    expect(status?.previousElementSibling?.classList.contains('pn-tt__arrow')).toBe(true);
    expect(parent.querySelector('.pn-tt__arrowCount')).toBeNull();
    // Decorative: the disclosure control is where the count is said.
    expect(parent.querySelector('.pn-tt__arrow')?.getAttribute('aria-label')).toBe('Expand Parent, 3 children');
  });

  it('a task leaf prints no count — no sub-entities is not a count of zero', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor(family(taskGuideLines, 2))} ctx={ctx} />,
    );
    expect(tileTitled(container, 'Leaf').querySelector('[data-testid="child-count"]')).toBeNull();
  });

  it('a standard-tile parent (doc) carries its count on the kind mark', () => {
    const { container } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor(family(docLayoutSpec, 2))} ctx={ctx} />,
    );
    const parent = tileTitled(container, 'Parent');
    expect(parent.querySelector('.lp__statusmark [data-testid="child-count"]')?.textContent).toBe('2');
    expect(parent.querySelector('.lp__statusmark')?.previousElementSibling?.classList.contains('lp__disclosure')).toBe(true);
    expect(tileTitled(container, 'Leaf').querySelector('[data-testid="child-count"]')).toBeNull();
  });
});

describe('the chevron owns a column on every tree anatomy (stylesheet contract)', () => {
  const css = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  /** The declaration block of the FIRST rule whose selector is exactly `selector`. */
  const block = (source: string, selector: string): string => {
    const at = source.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return source.slice(at, source.indexOf('}', at));
  };

  it('neither the task chevron nor the standard disclosure is positioned over the icon', () => {
    // jsdom loads no stylesheet, so the overlay this fixes is invisible to every
    // render test above; the rule text is the only thing a unit test can see.
    expect(block(css('./maestro-task-tile.css'), '.cv2-root .pn-tt__arrow')).not.toMatch(/position:\s*absolute/);
    expect(block(css('../panels.css'), '.cv2-root .lp__disclosure')).not.toMatch(/position:\s*absolute/);
  });

  it('the count pill is ONE rule shared with the session tile, anchored on a positioned slot', () => {
    const panels = css('../panels.css');
    expect(panels).toContain('.cv2-root :is(.pn-agent__kids, .lp__kids) {');
    expect(block(panels, '.cv2-root .lp__statusmark')).toMatch(/position:\s*relative/);
    expect(block(css('./maestro-task-tile.css'), '.cv2-root .pn-tt__status')).toMatch(/position:\s*relative/);
  });
});

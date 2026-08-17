// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { taskGuideLines, taskUuidTitle } from '../fixtures';
import { EntityTree } from './EntityTree';

describe('EntityTree card hierarchy', () => {
  it('keeps parent/child cards attached, color-labelled, and keyboard-selectable', () => {
    const parent: EntitySummary = {
      ...taskGuideLines,
      id: 'entity-tree-parent',
      title: 'Workspace layout',
      parentId: null,
    };
    const child: EntitySummary = {
      ...taskUuidTitle,
      id: 'entity-tree-child',
      title: 'Center sizing law',
      parentId: parent.id,
    };
    const rows = [parent, child];
    const onSelect = vi.fn();
    const view = render(
      <div className="cv2-root">
        <EntityTree
          kind="task"
          rowsFor={() => rows}
          livenessOf={() => 'not-running'}
          activity={{}}
          selectedId={null}
          onSelect={onSelect}
        />
      </div>,
    );

    // COLLAPSED IS THE SHIPPED DEFAULT (user ruling 2026-08-17): the root is
    // the only tree item until the viewer opens it.
    expect(view.getAllByRole('treeitem')).toHaveLength(1);
    const disclosure = view.getByRole('button', { name: /expand workspace layout, 1 child/i });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure);
    expect(view.getAllByRole('treeitem')).toHaveLength(2);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.evt-priority--medium')?.textContent).toBe('MEDIUM');
    expect(view.container.querySelector('.evt-priority--urgent')?.textContent).toBe('URGENT');

    fireEvent.click(view.getByRole('button', { name: 'Center sizing law' }));
    expect(onSelect).toHaveBeenLastCalledWith(child.id);

    // The prior implementation made the whole row role=button while nesting a
    // disclosure button inside it. Real buttons now own selection and expand.
    for (const button of view.container.querySelectorAll('button')) {
      expect(button.querySelector('button')).toBeNull();
    }
  });
});

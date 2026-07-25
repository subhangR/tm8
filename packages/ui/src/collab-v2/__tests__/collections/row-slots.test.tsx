/**
 * W3.3 — the additive CollectionView row slots: `rowAction` (per-row action
 * node), `selection` (checkbox mode), and `expandDepth` (tree default
 * expansion). Screens (Home/Tasks/Docs) consume these instead of building
 * local row components.
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CollectionView, TreeLayout } from '../../collections';
import type { CollectionQuery, EntityId } from '../../types/contract';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores } from './helpers';

const taskQuery = (spaceId: string): CollectionQuery => ({
  spaceId, kinds: ['task'], sort: 'position',
});

describe('CollectionView row slots', () => {
  beforeEach(resetStores);

  it('rowAction renders on every list row and clicking it does not open the entity', async () => {
    const facade = createFacade();
    const onOpen = vi.fn();
    renderWith(facade, (
      <CollectionView
        query={taskQuery(facade.ids.space)}
        onOpenEntity={onOpen}
        rowAction={(e) => <button type="button" data-entity={e.id}>⋯</button>}
      />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');
    const actions = document.querySelectorAll('.cv2-collection__rowaction button');
    expect(actions.length).toBeGreaterThanOrEqual(11);
    fireEvent.click(actions[0] as HTMLElement);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('selection renders controlled checkboxes and toggles without opening', async () => {
    const facade = createFacade();
    const onOpen = vi.fn();

    function Harness() {
      const [sel, setSel] = useState<ReadonlySet<EntityId>>(new Set());
      return (
        <CollectionView
          query={taskQuery(facade.ids.space)}
          onOpenEntity={onOpen}
          selection={{
            selectedIds: sel,
            onToggle: (id) => setSel((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            }),
          }}
        />
      );
    }

    renderWith(facade, <Harness />);
    await screen.findByText('T-100 · Collab V2 milestone');
    const boxes = document.querySelectorAll<HTMLInputElement>('.cv2-collection__check');
    expect(boxes.length).toBeGreaterThanOrEqual(11);
    expect([...boxes].every((b) => !b.checked)).toBe(true);

    fireEvent.click(boxes[0] as HTMLInputElement);
    await waitFor(() => {
      expect(document.querySelectorAll<HTMLInputElement>('.cv2-collection__check')[0]?.checked).toBe(true);
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rowAction and selection ride the board and tree layouts too', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <CollectionView
        query={taskQuery(facade.ids.space)}
        layout="board"
        rowAction={() => <button type="button">⋯</button>}
        selection={{ selectedIds: new Set(), onToggle: () => {} }}
      />
    ));
    await waitFor(() => expect(document.querySelector('.cv2-board')).toBeTruthy());
    expect(document.querySelectorAll('.cv2-board .cv2-collection__rowaction').length).toBeGreaterThanOrEqual(11);
    expect(document.querySelectorAll('.cv2-board .cv2-collection__check').length).toBeGreaterThanOrEqual(11);

    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }));
    await waitFor(() => expect(document.querySelector('.cv2-tree')).toBeTruthy());
    expect(document.querySelectorAll('.cv2-tree .cv2-collection__rowaction').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelectorAll('.cv2-tree .cv2-collection__check').length).toBeGreaterThanOrEqual(1);
  });
});

describe('TreeLayout expandDepth', () => {
  beforeEach(resetStores);

  async function seededTasks(facade: MockFacade) {
    const res = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' });
    return res.page.items;
  }

  it('defaults to roots-only (no auto-expansion)', async () => {
    const facade = createFacade();
    const items = await seededTasks(facade);
    renderWith(facade, <TreeLayout items={items} onOpen={() => {}} />);
    expect(document.querySelectorAll('.cv2-tree__children').length).toBe(0);
  });

  it('expandDepth=1 auto-opens roots and loads their children from the facade', async () => {
    const facade = createFacade();
    const items = await seededTasks(facade);
    renderWith(facade, <TreeLayout items={items} onOpen={() => {}} expandDepth={1} />);
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-tree__children .cv2-tree__row').length).toBeGreaterThan(0);
    });
    // rows carry the registry status pill (data-driven, every kind)
    expect(document.querySelectorAll('.cv2-tree__meta .cv2-pill').length).toBeGreaterThan(0);
  });

  it('expandDepth=2 opens the second level as slices arrive', async () => {
    const facade = createFacade();
    const items = await seededTasks(facade);
    renderWith(facade, <TreeLayout items={items} onOpen={() => {}} expandDepth={2} />);
    await waitFor(() => {
      expect(
        document.querySelectorAll('.cv2-tree__children .cv2-tree__children .cv2-tree__row').length,
      ).toBeGreaterThan(0);
    });
  });

  it('a user collapse wins over the expandDepth default', async () => {
    const facade = createFacade();
    const items = await seededTasks(facade);
    renderWith(facade, <TreeLayout items={items} onOpen={() => {}} expandDepth={1} />);
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-tree__children .cv2-tree__row').length).toBeGreaterThan(0);
    });
    const collapse = screen.getAllByRole('button', { name: /^collapse / })[0];
    fireEvent.click(collapse as HTMLElement);
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-tree__children').length).toBe(0);
    });
  });

  it('CollectionView threads expandDepth through to the tree layout', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <CollectionView query={taskQuery(facade.ids.space)} layout="tree" expandDepth={1} />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-tree__children .cv2-tree__row').length).toBeGreaterThan(0);
    });
  });
});

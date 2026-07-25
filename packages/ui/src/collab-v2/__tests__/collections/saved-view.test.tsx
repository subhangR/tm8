/**
 * Gate L4: saved-view round-trip — save a named (shared) view with its
 * layout/groupBy/graph positions through the facade, list it back, and
 * re-render the identical collection from it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CollectionView } from '../../collections';
import { createFacade, renderWith, resetStores } from './helpers';

describe('saved views', () => {
  beforeEach(resetStores);

  it('save-view control persists name + share + the effective query', async () => {
    const facade = createFacade();
        renderWith(facade, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
        layout="board"
        groupBy="axis:type"
      />
    ));
    await screen.findByText('T-103 · Facade routes');

    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Type board' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const views = await facade.listSavedViews(facade.ids.space);
      const mine = views.find((v) => v.name === 'Type board');
      expect(mine).toBeTruthy();
      expect(mine!.shareMode).toBe('space');
      expect(mine!.query.layout).toBe('board');
      expect(mine!.query.groupBy).toBe('axis:type');
      expect(mine!.query.kinds).toEqual(['task']);
    });
  });

  it('re-rendering from the saved view reproduces the collection', async () => {
    const facade = createFacade();
    const saved = await facade.createSavedView(facade.ids.space, {
      name: 'Milestone board',
      shareMode: 'space',
      query: {
        spaceId: facade.ids.space, kinds: ['task'], sort: 'position',
        layout: 'board', groupBy: 'workStatus',
      },
    });
    renderWith(facade, (
      <CollectionView query={{ spaceId: facade.ids.space }} savedView={saved} />
    ));
    await screen.findByText('T-103 · Facade routes');
    expect(document.querySelector('.cv2-board')).toBeTruthy();
    expect(document.querySelector('[data-column="open"]')).toBeTruthy();
  });

  it('graph layout persists onto the saved view and comes back', async () => {
    const facade = createFacade();
    const saved = await facade.createSavedView(facade.ids.space, {
      name: 'Layout home',
      shareMode: 'private',
      query: { spaceId: facade.ids.space, kinds: ['task'], layout: 'graph' },
    });
    const layout = { [facade.ids.t105]: { x: 640, y: 64 } };
    const updated = await facade.updateSavedView(saved.id, { graphLayout: layout });
    expect(updated.graphLayout).toEqual(layout);
    const listed = await facade.listSavedViews(facade.ids.space);
    expect(listed.find((v) => v.id === saved.id)?.graphLayout).toEqual(layout);

    // the seeded dependency view already carries a layout — it must round-trip
    const seededViews = await facade.listSavedViews(facade.ids.space);
    const dep = seededViews.find((v) => v.name === 'V2 milestone · dependencies');
    expect(dep?.graphLayout?.[facade.ids.t105]).toEqual({ x: 520, y: 40 });
  });
});

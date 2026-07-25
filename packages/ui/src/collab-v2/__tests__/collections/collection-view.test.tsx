/**
 * Gate L4: the SAME seeded query renders in all six layouts, plus the
 * teaching empty state and the layout switcher.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CollectionView } from '../../collections';
import type { CollectionQuery } from '../../types/contract';
import { createFacade, renderWith, resetStores } from './helpers';

describe('CollectionView — one query, six layouts', () => {
  beforeEach(resetStores);

  const taskQuery = (spaceId: string): CollectionQuery => ({
    spaceId, kinds: ['task'], sort: 'position',
  });

  it('renders the seeded tasks as a list (default), arrow-navigable', async () => {
    const facade = createFacade();
    renderWith(facade, <CollectionView query={taskQuery(facade.ids.space)} />);
    expect(await screen.findByText('T-100 · Collab V2 milestone')).toBeTruthy();
    expect(screen.getByText('T-105 · Graph canvas')).toBeTruthy();
    // every cell is a Z2 card
    expect(document.querySelectorAll('.cv2-collection__list .cv2-card').length).toBeGreaterThanOrEqual(11);
  });

  it('renders the same query as board / tree / feed / gallery via the switcher', async () => {
    const facade = createFacade();
        renderWith(facade, <CollectionView query={taskQuery(facade.ids.space)} />);
    await screen.findByText('T-100 · Collab V2 milestone');

    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
    await waitFor(() => {
      expect(document.querySelector('.cv2-board')).toBeTruthy();
    });
    // board pivots on workStatus by default: open + working + done columns exist
    expect(document.querySelector('[data-column="open"]')).toBeTruthy();
    expect(document.querySelector('[data-column="working"]')).toBeTruthy();
    expect(document.querySelector('[data-column="done"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }));
    await waitFor(() => {
      expect(document.querySelector('.cv2-tree')).toBeTruthy();
    });
    expect(screen.getByText('T-100 · Collab V2 milestone')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Feed' }));
    await waitFor(() => {
      expect(document.querySelector('.cv2-collection__feed')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Gallery' }));
    await waitFor(() => {
      expect(document.querySelector('.cv2-collection__gallery')).toBeTruthy();
    });
    expect(document.querySelectorAll('.cv2-collection__gallery .cv2-card').length).toBeGreaterThanOrEqual(11);
  });

  it('renders the same query as a graph (nodes are Z2 cards)', async () => {
    const facade = createFacade();
        renderWith(facade, <CollectionView query={taskQuery(facade.ids.space)} />);
    await screen.findByText('T-100 · Collab V2 milestone');
    fireEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    await waitFor(() => {
      expect(document.querySelector('.cv2-graph')).toBeTruthy();
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-gnode .cv2-card').length).toBeGreaterThanOrEqual(11);
    });
  });

  it('shows the teaching empty state on an empty collection', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], filters: { workStatus: ['cancelled'] } }}
      />
    ));
    const empty = (await screen.findByText(/no tasks linked yet — drag one here/i)).closest('.cv2-collection__empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toMatch(/⌘K/);
  });
});

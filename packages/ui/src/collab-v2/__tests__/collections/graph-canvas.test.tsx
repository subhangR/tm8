/**
 * Gate L4 (graph, DOM): GraphCanvas renders Z2-card nodes, containment
 * clusters collapse from the UI, dependency mode paints the seeded blocked
 * path, and clicking a node pushes a panel while the canvas stays.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { GraphCanvas } from '../../collections';
import { useNavStore } from '../../stores';
import { createFacade, renderWith, resetStores } from './helpers';

describe('GraphCanvas', () => {
  beforeEach(resetStores);

  it('renders every node as a Z2 EntityCard with kind shaping', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <GraphCanvas query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }} />
    ));
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-gnode .cv2-card').length).toBeGreaterThanOrEqual(11);
    });
    expect(document.querySelector('.cv2-gnode--task')).toBeTruthy();
    // hierarchy = dashed containment boxes, present alongside the cards
    expect(document.querySelector('.cv2-gcluster')).toBeTruthy();
  });

  it('collapses a containment cluster from its bar', async () => {
    const facade = createFacade();
        renderWith(facade, (
      <GraphCanvas query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }} />
    ));
    await screen.findByText('T-103a · Read routes');
    fireEvent.click(screen.getByRole('button', { name: 'collapse T-103 · Facade routes' }));
    await waitFor(() => expect(screen.queryByText('T-103a · Read routes')).toBeNull());
    // the parent card fronts the collapsed group and can re-expand it
    fireEvent.click(screen.getByRole('button', { name: /expand T-103 · Facade routes/ }));
    await waitFor(() => expect(screen.getByText('T-103a · Read routes')).toBeTruthy());
  });

  it('dependency mode marks the seeded blocked path red', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <GraphCanvas
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position', mode: 'dependency' }}
      />
    ));
    await waitFor(() => {
      expect(document.querySelectorAll('.cv2-gnode--blocked').length).toBe(2);
    });
    const blockedTitles = Array.from(document.querySelectorAll('.cv2-gnode--blocked .cv2-card__title'))
      .map((el) => el.textContent);
    expect(blockedTitles).toEqual(expect.arrayContaining([
      'T-105 · Graph canvas', 'T-104 · Entity panel UI',
    ]));
  });

  it('offers the three seeded subgraphs in the switcher', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <GraphCanvas query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }} />
    ));
    const select = await screen.findByLabelText('Subgraph');
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
      expect(options).toEqual(expect.arrayContaining([
        'V2 milestone · dependencies', 'Spec docs · tree', 'Forge · kit',
      ]));
    });
  });

  it('clicking a node pushes a Z3 panel and the canvas stays mounted', async () => {
    const facade = createFacade();
        renderWith(facade, (
      <GraphCanvas query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position', mode: 'dependency' }} />
    ));
    const title = await screen.findByText('T-105 · Graph canvas');
    fireEvent.click(title);
    await waitFor(() => {
      expect(useNavStore.getState().stack.map((r) => r.entityId)).toContain(facade.ids.t105);
    });
    expect(document.querySelector('.cv2-graph__canvas')).toBeTruthy();
    expect(screen.getByText('T-105 · Graph canvas')).toBeTruthy();
  });
});

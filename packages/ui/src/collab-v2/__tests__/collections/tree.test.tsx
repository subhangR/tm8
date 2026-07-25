/**
 * Gate L4: tree layout — expand/collapse with facade-paged children, and
 * drag-reparent through `moveEntity`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CollectionView, TreeLayout } from '../../collections';
import type { Cursor, EntityId, Hierarchy } from '../../types/contract';
import { CollabFacadeProvider } from '../../entity';
import { PopoverProvider } from '../../kit';
import { render } from '@testing-library/react';
import { createFacade, makeDataTransfer, renderWith, resetStores } from './helpers';

describe('TreeLayout', () => {
  beforeEach(resetStores);

  it('expands the milestone into its (facade-loaded) children and collapses again', async () => {
    const facade = createFacade();
        renderWith(facade, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
        layout="tree"
      />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');
    // subtree rows are roots only until expanded... T-101 is top-level in the
    // flat result but T-100 is its parent IN the result, so it nests.
    fireEvent.click(screen.getByRole('button', { name: /expand T-100/ }));
    await waitFor(() => expect(screen.getAllByText('T-101 · Schema foundation').length).toBeGreaterThan(0));

    // nested cluster: T-103's children stay hidden until IT expands
    expect(screen.queryByText('T-103a · Read routes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /expand T-103 · Facade routes/ }));
    await waitFor(() => expect(screen.getByText('T-103a · Read routes')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /collapse T-100/ }));
    await waitFor(() => expect(screen.queryByText('T-103a · Read routes')).toBeNull());
  });

  it('pages children through cursors with a load-more affordance', async () => {
    const facade = createFacade();
    const t100 = facade.ids.t100;
    const full = await facade.getHierarchy(t100);
    const pageOne = full.children.items.slice(0, 3);
    const pageTwo = full.children.items.slice(3);
    const paged = Object.create(facade) as typeof facade;
    paged.getHierarchy = async (id: EntityId, cursor?: Cursor): Promise<Hierarchy> => {
      if (id !== t100) return facade.getHierarchy(id, cursor);
      return {
        ...full,
        children: cursor
          ? { items: pageTwo, nextCursor: null }
          : { items: pageOne, nextCursor: 'page-2' },
      };
    };

        renderWith(paged, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
        layout="tree"
      />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');
    fireEvent.click(screen.getByRole('button', { name: /expand T-100/ }));

    await waitFor(() => expect(screen.getAllByText(pageOne[0].title).length).toBeGreaterThan(0));
    expect(screen.queryByText(pageTwo[0].title)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'load more children' }));
    await waitFor(() => expect(screen.getAllByText(pageTwo[0].title).length).toBeGreaterThan(0));
    expect(screen.queryByText('load more children')).toBeNull();
  });

  it('drag-reparents a row onto a same-kind row via moveEntity', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
        layout="tree"
      />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');

    // T-108 currently sits under T-100; re-nest it under T-103.
    const before = await facade.getEntity(facade.ids.t108);
    expect(before.parentId).toBe(facade.ids.t100);

        fireEvent.click(screen.getByRole('button', { name: /expand T-100/ }));
    const source = (await screen.findByText('T-108 · Onboarding tour')).closest('.cv2-tree__row') as HTMLElement;
    const target = screen.getByText('T-103 · Facade routes').closest('.cv2-tree__row') as HTMLElement;

    const dt = makeDataTransfer();
    fireEvent.dragStart(source, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    // ghost preview names the reparent before it happens
    expect(document.querySelector('.cv2-tree__ghost')?.textContent).toMatch(/child of/);
    fireEvent.drop(target, { dataTransfer: dt });

    await waitFor(async () => {
      const after = await facade.getEntity(facade.ids.t108);
      expect(after.parentId).toBe(facade.ids.t103);
    });
  });

  it('refuses a cross-kind reparent (hierarchy is homogeneous)', async () => {
    const facade = createFacade();
    const docs = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['doc'], sort: 'position' });
    const tasks = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' });
    render(
      <CollabFacadeProvider facade={facade}>
        <PopoverProvider>
          <TreeLayout items={[...tasks.page.items, ...docs.page.items]} onOpen={() => {}} />
        </PopoverProvider>
      </CollabFacadeProvider>,
    );

    const source = screen.getByText('Collab V2 Spec').closest('.cv2-tree__row') as HTMLElement;
    const target = screen.getByText('T-100 · Collab V2 milestone').closest('.cv2-tree__row') as HTMLElement;
    const dt = makeDataTransfer();
    fireEvent.dragStart(source, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/same-kind only/i));
    const doc = await facade.getEntity(docs.page.items.find((d) => d.title === 'Collab V2 Spec')!.id);
    expect(doc.parentId).toBeNull();
  });
});

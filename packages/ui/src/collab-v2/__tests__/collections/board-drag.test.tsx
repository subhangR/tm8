/**
 * Gate L4: board drag between columns IS the matching mutation — optimistic
 * move with ghost preview, server ack, and 409 rollback that adopts the
 * server's `current` (DEV-8 code-switched handling).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CollectionView } from '../../collections';
import { CollabError } from '../../types/contract';
import { createFacade, makeDataTransfer, renderWith, resetStores } from './helpers';

function column(key: string): HTMLElement {
  const el = document.querySelector(`[data-column="${key}"]`);
  expect(el, `column ${key}`).toBeTruthy();
  return el as HTMLElement;
}

function cardIn(colKey: string, title: string): HTMLElement | null {
  const col = document.querySelector(`[data-column="${colKey}"]`);
  if (!col) return null;
  return within(col as HTMLElement).queryByText(title)?.closest('.cv2-collection__cell') ?? null;
}

async function renderBoard(facade: ReturnType<typeof createFacade>) {
  renderWith(facade, (
    <CollectionView
      query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
      layout="board"
      groupBy="workStatus"
    />
  ));
  await screen.findByText('T-103 · Facade routes');
}

describe('BoardLayout — drag between columns mutates', () => {
  beforeEach(resetStores);

  it('drops a card into another status column → patchTask({workStatus}) with ghost preview', async () => {
    const facade = createFacade();
    await renderBoard(facade);

    expect(cardIn('open', 'T-103 · Facade routes')).toBeTruthy();
    const card = cardIn('open', 'T-103 · Facade routes') as HTMLElement;
    const dt = makeDataTransfer();

    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragEnter(column('working'), { dataTransfer: dt });
    fireEvent.dragOver(column('working'), { dataTransfer: dt });
    // ghost preview announces the meaning BEFORE the drop
    expect(screen.getByTestId('ghost-working').textContent).toMatch(/move to/i);
    fireEvent.drop(column('working'), { dataTransfer: dt });

    // optimistic: the card is in the new column without waiting for the server
    await waitFor(() => expect(cardIn('working', 'T-103 · Facade routes')).toBeTruthy());
    expect(cardIn('open', 'T-103 · Facade routes')).toBeNull();

    // and the mutation is REAL: the facade's world moved too
    await waitFor(async () => {
      const detail = await facade.getEntity(facade.ids.t103);
      expect(detail.state.kind === 'task' && detail.state.workStatus).toBe('working');
    });
  });

  it('rolls back on version_conflict and adopts the server current', async () => {
    const facade = createFacade();
    await renderBoard(facade);

    const current = await facade.getEntity(facade.ids.t103);
    facade.failNextWith(new CollabError('version_conflict', 'someone else won', { current }));

    const card = cardIn('open', 'T-103 · Facade routes') as HTMLElement;
    const dt = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(column('in_review'), { dataTransfer: dt });
    fireEvent.drop(column('in_review'), { dataTransfer: dt });

    // rolled back into the source column, with an explanatory banner
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed .* first/i));
    expect(cardIn('open', 'T-103 · Facade routes')).toBeTruthy();
    expect(cardIn('in_review', 'T-103 · Facade routes')).toBeNull();

    const detail = await facade.getEntity(facade.ids.t103);
    expect(detail.state.kind === 'task' && detail.state.workStatus).toBe('open');
  });

  it('rolls back on a plain network error too', async () => {
    const facade = createFacade();
    await renderBoard(facade);

    facade.failNextWith(new Error('network down'));
    const card = cardIn('open', 'T-103 · Facade routes') as HTMLElement;
    const dt = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(column('working'), { dataTransfer: dt });
    fireEvent.drop(column('working'), { dataTransfer: dt });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/rolled back/i));
    expect(cardIn('open', 'T-103 · Facade routes')).toBeTruthy();
  });

  it('axis pivot drags take the identical path — patchTask({axes}) with the merged map', async () => {
    const facade = createFacade();
    renderWith(facade, (
      <CollectionView
        query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }}
        layout="board"
        groupBy="axis:type"
      />
    ));
    await screen.findByText('T-103 · Facade routes');

    // axis columns come from the axis catalog: default axis `type`
    expect(column('code')).toBeTruthy();
    expect(column('design')).toBeTruthy();

    const card = cardIn('code', 'T-103 · Facade routes') as HTMLElement;
    const dt = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(column('review'), { dataTransfer: dt });
    fireEvent.drop(column('review'), { dataTransfer: dt });

    await waitFor(() => expect(cardIn('review', 'T-103 · Facade routes')).toBeTruthy());
    const detail = await facade.getEntity(facade.ids.t103);
    if (detail.state.kind !== 'task') throw new Error('not a task');
    expect(detail.state.axes.type).toBe('review');
    // merged, not replaced: the other axis survives
    expect(detail.state.axes.milestone).toBe('v2-alpha');
  });
});

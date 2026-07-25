/**
 * Tombstones keep history shape, and the Z4 full view renders its registry
 * layout variant per kind with expand/collapse round-tripping the nav store.
 */
import { fireEvent } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntityChip, EntityFullView, Tombstone } from '../../entity';
import { registryFor } from '../../registry';
import { useGraphStore, useNavStore } from '../../stores';
import type { EntityDetail, EntityKind, EntitySummary } from '../../types/contract';
import { ALL_KINDS, createFacade, loadKindDetails, renderWith, resetStores } from './helpers';
import type { MockFacade } from '../../mock';

let facade: MockFacade;
let details: Record<EntityKind, EntityDetail>;
let dead: EntitySummary;

beforeAll(async () => {
  facade = createFacade();
  details = await loadKindDetails(facade);
  const created = await facade.createTask({ spaceId: facade.ids.space, title: 'Ephemeral task', parentId: null });
  const res = await facade.deleteEntity(created.entity!.id);
  dead = res.patches.find((p) => p.id === created.entity!.id && p.deletedAt != null)!;
});

beforeEach(() => resetStores());

describe('Tombstone', () => {
  it('chip keeps the title (struck) and says what it was', () => {
    const { container, unmount } = renderWith(facade, <Tombstone entity={dead} variant="chip" />);
    const chip = container.querySelector('.cv2-chip--tombstone')!;
    expect(chip.querySelector('s')?.textContent).toBe(dead.title);
    expect(chip.textContent).toContain('deleted task');
    unmount();
  });

  it('card preserves the counters footprint (history shape)', () => {
    const { container, unmount } = renderWith(facade, <Tombstone entity={dead} variant="card" />);
    const card = container.querySelector('.cv2-card--tombstone')!;
    expect(card.querySelectorAll('.cv2-count').length).toBeGreaterThanOrEqual(4);
    expect(card.textContent).toContain('deleted');
    unmount();
  });

  it('EntityChip transparently renders tombstoned summaries as tombstones', () => {
    const { container, unmount } = renderWith(facade, <EntityChip entity={dead} />);
    expect(container.querySelector('.cv2-chip--tombstone')).toBeTruthy();
    unmount();
  });
});

describe('EntityFullView (Z4)', () => {
  it.each(ALL_KINDS)('%s renders its registry layout variant', (kind) => {
    const detail = details[kind];
    const { container, unmount } = renderWith(
      facade, <EntityFullView entityId={detail.id} detail={detail} />,
    );
    const root = container.querySelector('.cv2-full')!;
    expect(root.getAttribute('data-layout')).toBe(registryFor(kind).fullLayout);
    expect(container.querySelector('.cv2-full__title')?.textContent).toBe(detail.title);
    unmount();
  });

  it('doc reader shows the chapter tree; task subtree shows children + dep slot', () => {
    const doc = renderWith(facade, <EntityFullView entityId={details.doc.id} detail={details.doc} />);
    expect(doc.container.querySelector('.cv2-full__grid--reader')).toBeTruthy();
    expect(doc.container.querySelector('[data-slot="margin-threads"]')).toBeTruthy();
    doc.unmount();

    const task = renderWith(facade, <EntityFullView entityId={details.task.id} detail={details.task} />);
    expect(task.container.querySelector('[data-slot="dependencies"]')).toBeTruthy();
    task.unmount();
  });

  it('collapse ⤡ round-trips: full view back to a pushed panel', () => {
    const detail = details.doc;
    useNavStore.getState().setSpace(detail.spaceId);
    useNavStore.getState().promotePanel(detail.id);
    useGraphStore.getState().ingestDetail(detail);
    const { getByRole, unmount } = renderWith(
      facade, <EntityFullView entityId={detail.id} detail={detail} />,
    );
    fireEvent.click(getByRole('button', { name: /Collapse/ }));
    const nav = useNavStore.getState();
    expect(nav.view).not.toBe('entity');
    expect(nav.stack.some((r) => r.entityId === detail.id)).toBe(true);
    unmount();
  });
});

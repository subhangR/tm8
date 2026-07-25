/**
 * Z3 panel anatomy: the universal tab set in the SAME order for every kind,
 * tab switching, slot props for the W2 subsystems, header/footer anatomy,
 * and the action bar honoring capabilities.
 */
import { fireEvent, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntityPanel, PANEL_TABS } from '../../entity';
import { useNavStore } from '../../stores';
import type { EntityDetail, EntityKind } from '../../types/contract';
import { ALL_KINDS, createFacade, loadKindDetails, renderWith, resetStores } from './helpers';
import type { MockFacade } from '../../mock';

let facade: MockFacade;
let details: Record<EntityKind, EntityDetail>;

beforeAll(async () => {
  facade = createFacade();
  details = await loadKindDetails(facade);
});

beforeEach(() => resetStores());

describe('EntityPanel (Z3) anatomy', () => {
  it('exports the universal tab set in the contract order', () => {
    expect(PANEL_TABS.map((t) => t.label)).toEqual(['Content', 'Discussion', 'Connections', 'Activity']);
  });

  it.each(ALL_KINDS)('%s: tabs render in the same order for every kind', (kind) => {
    const detail = details[kind];
    const { getAllByRole, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    const tabs = getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Content', 'Discussion', 'Connections', 'Activity']);
    unmount();
  });

  it('switches tabs; Discussion and Connections expose W2 slots', async () => {
    const detail = details.task;
    const { container, getByRole, unmount } = renderWith(
      facade,
      <EntityPanel
        entityId={detail.id}
        detail={detail}
        slots={{ discussion: () => <div data-testid="thread-slot">thread goes here</div> }}
      />,
    );
    // content first
    expect(getByRole('tab', { name: 'Content' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(getByRole('tab', { name: 'Discussion' }));
    expect(container.querySelector('[data-testid="thread-slot"]')).toBeTruthy();

    fireEvent.click(getByRole('tab', { name: 'Connections' }));
    // no slot passed → the fallback renders hierarchy + edge groups
    expect(container.querySelector('[data-slot="connections-fallback"]')).toBeTruthy();

    fireEvent.click(getByRole('tab', { name: 'Activity' }));
    await waitFor(() => {
      expect(container.querySelector('.cv2-activity, .cv2-empty-line')).toBeTruthy();
    });
    unmount();
  });

  it('default Discussion placeholder marks the slot for W2', () => {
    const detail = details.doc;
    const { container, getByRole, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    fireEvent.click(getByRole('tab', { name: 'Discussion' }));
    expect(container.querySelector('[data-slot="discussion"]')).toBeTruthy();
    unmount();
  });

  it('header shows breadcrumb chips from hierarchy.path (self excluded)', () => {
    const detail = details.task; // T-103 sits under T-100 in the seed
    const { container, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    const crumbs = container.querySelector('.cv2-panel__crumbs')!;
    const ancestors = detail.hierarchy.path.filter((p) => p.id !== detail.id);
    expect(ancestors.length).toBeGreaterThan(0); // seed invariant: T-103 has ancestors
    expect(crumbs.querySelectorAll('.cv2-chip').length).toBeGreaterThanOrEqual(ancestors.length);
    unmount();
  });

  it('footer carries created-by and version + activity', () => {
    const detail = details.doc;
    const { container, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    const footer = container.querySelector('.cv2-panel__footer')!;
    expect(footer.textContent).toContain(detail.createdBy.displayName);
    expect(footer.textContent).toContain(`v${detail.version}`);
    unmount();
  });

  it('action bar honors capabilities (Pull only where meaningful)', () => {
    const doc = details.doc;
    const member = details.member;
    const a = renderWith(facade, <EntityPanel entityId={doc.id} detail={doc} />);
    const docHasPull = [...a.container.querySelectorAll('.cv2-actionbtn')].some((b) => b.textContent === 'Pull');
    expect(docHasPull).toBe(doc.capabilities.canPull);
    a.unmount();
    const b = renderWith(facade, <EntityPanel entityId={member.id} detail={member} />);
    const memberHasPull = [...b.container.querySelectorAll('.cv2-actionbtn')].some((x) => x.textContent === 'Pull');
    expect(memberHasPull).toBe(member.capabilities.canPull);
    b.unmount();
  });

  it('expand ⤢ promotes the panel to the Z4 route through the nav store', () => {
    const detail = details.doc;
    useNavStore.getState().setSpace(detail.spaceId);
    useNavStore.getState().pushPanel({ entityId: detail.id });
    const { getByRole, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    fireEvent.click(getByRole('button', { name: 'Expand to full view' }));
    const nav = useNavStore.getState();
    expect(nav.view).toBe('entity');
    expect(nav.entityId).toBe(detail.id);
    expect(nav.stack.some((r) => r.entityId === detail.id)).toBe(false);
    unmount();
  });

  it('tab choice is mirrored into the nav store (deep-linkable state)', () => {
    const detail = details.task;
    useNavStore.getState().setSpace(detail.spaceId);
    useNavStore.getState().pushPanel({ entityId: detail.id });
    const { getByRole, unmount } = renderWith(
      facade, <EntityPanel entityId={detail.id} detail={detail} />,
    );
    fireEvent.click(getByRole('tab', { name: 'Connections' }));
    expect(useNavStore.getState().stack.find((r) => r.entityId === detail.id)?.tab).toBe('connections');
    unmount();
  });
});

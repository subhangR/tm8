// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { CrossSpaceRef, EntityId } from '@tm8/contract';
import { fixtureDetails } from '../../fixtures';
import { CrossSpaceRefsSection } from './CrossSpaceRefsSection';
import { ConnectionsTab } from './tabs';

/**
 * IN OTHER SPACES (279): an entity's cross-space references. A chip shows the
 * live target only when the server says the viewer can read it; otherwise the
 * snapshot, marked as one. Titles from another space render as text.
 */

function ref(overrides: Partial<CrossSpaceRef> = {}): CrossSpaceRef {
  return {
    id: 'ref-1',
    spaceId: '01900000-0000-7000-8000-00000000000a',
    entityId: '01900000-0000-7000-8000-0000000000a1' as EntityId,
    linkId: '01900000-0000-7000-8000-0000000000d1' as EntityId,
    targetSpaceId: '01900000-0000-7000-8000-00000000000b',
    targetServerId: null,
    targetEntityId: '01900000-0000-7000-8000-0000000000b1' as EntityId,
    kind: 'task',
    titleSnapshot: 'Old title',
    live: null,
    createdBy: '01900000-0000-7000-8000-0000000000c1' as EntityId,
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
    ...overrides,
  };
}

describe('CrossSpaceRefsSection', () => {
  it('draws nothing while loading or when there are no references', () => {
    expect(render(<CrossSpaceRefsSection state={{ phase: 'loading' }} />).container.innerHTML).toBe('');
    expect(render(<CrossSpaceRefsSection state={{ phase: 'ready', refs: [] }} />).container.innerHTML).toBe('');
  });

  it('shows the live title when the viewer can read the target, the snapshot otherwise', () => {
    const { getAllByTestId } = render(
      <CrossSpaceRefsSection state={{ phase: 'ready', refs: [
        ref({ id: 'live', live: { kind: 'task', title: 'New title', updatedAt: '2026-10-02T09:00:00.000Z' } }),
        ref({ id: 'snap', titleSnapshot: '<b>Snapshot</b>' }),
      ] }} />,
    );
    const [live, snap] = getAllByTestId('cross-space-ref');
    expect(live!.dataset.live).toBe('true');
    expect(live!.textContent).toContain('New title');
    expect(live!.textContent).not.toContain('Old title');
    expect(snap!.dataset.live).toBe('false');
    expect(snap!.textContent).toContain('<b>Snapshot</b>');
    expect(snap!.textContent).toContain('snapshot');
    expect(snap!.querySelector('b')).toBeNull();
  });

  it('remove hands the reference to the host', () => {
    const onRemove = vi.fn();
    const target = ref();
    const { getByRole } = render(<CrossSpaceRefsSection state={{ phase: 'ready', refs: [target] }} onRemove={onRemove} />);
    fireEvent.click(getByRole('button', { name: /Remove the reference to Old title/ }));
    expect(onRemove).toHaveBeenCalledWith(target);
  });

  it('the Connections tab renders the host-composed section', () => {
    const detail = Object.values(fixtureDetails)[0]!;
    const { getByTestId } = render(
      <ConnectionsTab
        detail={detail}
        crossSpaceRefs={<CrossSpaceRefsSection state={{ phase: 'ready', refs: [ref()] }} />}
      />,
    );
    expect(within(getByTestId('cross-space-refs')).getByText(/IN OTHER SPACES/)).toBeTruthy();
  });
});

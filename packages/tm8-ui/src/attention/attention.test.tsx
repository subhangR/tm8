// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { AttentionRequest, EntityId, SpaceId } from '@tm8/contract';
import { AttentionInbox } from './AttentionInbox';
import { groupAttentionByEntity } from './attention-model';

const SPACE = 'space-1' as SpaceId;

function req(over: Partial<AttentionRequest> & { entityId: string; points: number }): AttentionRequest {
  return {
    id: over.id ?? `req-${over.entityId}-${over.points}`,
    spaceId: SPACE,
    entityId: over.entityId as EntityId,
    reason: over.reason ?? 'because',
    points: over.points,
    status: 'open',
    version: 1,
    requestedBy: { id: 'm1' as EntityId, kind: 'member', name: 'Ann', avatarUrl: null } as never,
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: over.createdAt ?? '2026-07-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-07-01T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
  };
}

describe('groupAttentionByEntity', () => {
  it('combines every request for one entity into a single row and sums the points', () => {
    const groups = groupAttentionByEntity([
      req({ entityId: 'a', points: 90, reason: 'first', createdAt: '2026-07-01T00:00:00.000Z' }),
      req({ entityId: 'a', points: 40, reason: 'newest', createdAt: '2026-07-03T00:00:00.000Z' }),
      req({ entityId: 'a', points: 10, reason: 'middle', createdAt: '2026-07-02T00:00:00.000Z' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      entityId: 'a',
      pendingCount: 3,
      totalPoints: 140,
      maxPoints: 90,
      // The most RECENT reason, not the loudest and not the first seen.
      latestReason: 'newest',
      // The honest age of the wait is when it STARTED.
      oldestRequestedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('ranks entities by combined points, so many small requests can outrank one big one', () => {
    const groups = groupAttentionByEntity([
      req({ entityId: 'big', points: 95 }),
      req({ entityId: 'many', points: 40 }),
      req({ entityId: 'many', points: 40 }),
      req({ entityId: 'many', points: 40 }),
    ]);

    expect(groups.map((g) => [g.entityId, g.totalPoints])).toEqual([
      ['many', 120],
      ['big', 95],
    ]);
  });

  it('breaks ties by who has waited longest, then by id — never by input order', () => {
    const rows = [
      req({ entityId: 'z-newer', points: 50, createdAt: '2026-07-09T00:00:00.000Z' }),
      req({ entityId: 'a-older', points: 50, createdAt: '2026-07-02T00:00:00.000Z' }),
    ];
    expect(groupAttentionByEntity(rows).map((g) => g.entityId)).toEqual(['a-older', 'z-newer']);
    expect(groupAttentionByEntity([...rows].reverse()).map((g) => g.entityId))
      .toEqual(['a-older', 'z-newer']);
  });

  it('returns nothing for an empty queue rather than a zero row', () => {
    expect(groupAttentionByEntity([])).toEqual([]);
  });
});

describe('AttentionInbox', () => {
  const names: Record<string, { title: string; kind: string }> = {
    a: { title: 'Fix the auth race', kind: 'task' },
    b: { title: 'Deploy check', kind: 'work_session' },
  };
  const nameOf = (id: EntityId) => names[id];
  const seam = {
    attentionRequests: vi.fn(),
    entity: vi.fn(),
  };

  it('renders one row per entity with combined points, ranked, and opens on click', async () => {
    const onOpenEntity = vi.fn();
    const view = render(
      <AttentionInbox
        seam={seam as never}
        spaceId={SPACE}
        nameOf={nameOf}
        onOpenEntity={onOpenEntity}
        rows={[
          req({ entityId: 'a', points: 30, reason: 'pick an API shape' }),
          req({ entityId: 'a', points: 30, reason: 'pick an API shape' }),
          req({ entityId: 'b', points: 45, reason: 'confirm the rollout' }),
        ]}
      />,
    );

    const rowA = view.getByTestId('attention-row-a');
    const rowB = view.getByTestId('attention-row-b');

    // Two requests on `a` became ONE row worth 60 — which outranks b's 45.
    expect(within(rowA).getByText('60')).toBeTruthy();
    expect(within(rowA).getByText('2 requests')).toBeTruthy();
    expect(within(rowB).getByText('45')).toBeTruthy();
    // A single request says nothing about a count — there is nothing combined.
    expect(within(rowB).queryByText(/requests$/)).toBeNull();

    const order = [...view.container.querySelectorAll('[data-testid^="attention-row-"]')]
      .map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['attention-row-a', 'attention-row-b']);

    // Titles and kinds come from the store, not from the wire.
    expect(within(rowA).getByText('Fix the auth race')).toBeTruthy();
    expect(within(rowA).getByText('pick an API shape')).toBeTruthy();

    fireEvent.click(rowA);
    expect(onOpenEntity).toHaveBeenCalledWith('a');
  });

  it('reads the queue for the space and states when a full page hides more', async () => {
    seam.attentionRequests.mockResolvedValueOnce({
      items: [req({ entityId: 'a', points: 12 })],
      nextCursor: '100',
      total: 400,
    });
    const view = render(
      <AttentionInbox seam={seam as never} spaceId={SPACE} nameOf={nameOf} onOpenEntity={vi.fn()} />,
    );

    await waitFor(() => expect(view.getByTestId('attention-row-a')).toBeTruthy());
    expect(seam.attentionRequests).toHaveBeenCalledWith({
      spaceId: SPACE, status: 'open', limit: 100,
    });
    expect(view.getByText(/more are pending/)).toBeTruthy();
  });

  it('hydrates a title the store does not know, and shows the id until it arrives', async () => {
    seam.attentionRequests.mockResolvedValueOnce({
      items: [req({ entityId: 'stranger', points: 20 })], nextCursor: null, total: 1,
    });
    let resolveEntity: (v: unknown) => void = () => {};
    seam.entity.mockReturnValueOnce(new Promise((resolve) => { resolveEntity = resolve; }));

    const view = render(
      <AttentionInbox seam={seam as never} spaceId={SPACE} nameOf={nameOf} onOpenEntity={vi.fn()} />,
    );

    // Before hydration the row shows the raw id — never an invented title.
    await waitFor(() => expect(view.getByTestId('attention-row-stranger')).toBeTruthy());
    expect(view.getByText('stranger')).toBeTruthy();

    resolveEntity({ title: 'A doc you have not opened', state: { kind: 'doc' } });
    await waitFor(() => expect(view.getByText('A doc you have not opened')).toBeTruthy());
  });

  it('says nothing is waiting rather than rendering an empty list', async () => {
    seam.attentionRequests.mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 });
    const view = render(
      <AttentionInbox seam={seam as never} spaceId={SPACE} nameOf={nameOf} onOpenEntity={vi.fn()} />,
    );
    await waitFor(() => expect(view.getByText('Nothing needs your attention.')).toBeTruthy());
  });

  it('reports a failed read instead of showing a confident empty state', async () => {
    seam.attentionRequests.mockRejectedValueOnce(new Error('nope'));
    const view = render(
      <AttentionInbox seam={seam as never} spaceId={SPACE} nameOf={nameOf} onOpenEntity={vi.fn()} />,
    );
    await waitFor(() => expect(view.getByText('Attention could not be loaded.')).toBeTruthy());
    expect(view.queryByText('Nothing needs your attention.')).toBeNull();
  });
});

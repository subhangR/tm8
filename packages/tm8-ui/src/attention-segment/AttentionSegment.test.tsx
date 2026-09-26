// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AttentionRequest,
  AttentionRequestListQuery,
  AttentionRequestStatus,
  DurableWorkspaceEvent,
  EntityId,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import { AttentionSegment, type AttentionSegmentProps } from './AttentionSegment';

const SPACE = 'space-1' as SpaceId;
const OTHER = 'space-2' as SpaceId;

function req(over: Partial<AttentionRequest> & { entityId: string; points: number }): AttentionRequest {
  return {
    id: over.id ?? `req-${over.entityId}-${over.points}`,
    spaceId: SPACE,
    entityId: over.entityId as EntityId,
    reason: over.reason ?? 'because',
    points: over.points,
    status: over.status ?? 'open',
    version: 1,
    requestedBy: { id: 'm1' as EntityId, kind: 'member', displayName: 'Ann', avatar: null, isAgent: false },
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: over.createdAt ?? '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
  };
}

/**
 * A hand-written seam: the rows live in `table`, filtered by status exactly as
 * the list op does, so a test mutates the table and fires an event to model
 * the server changing underneath the strip.
 */
function fakeSeam(initial: AttentionRequest[], options: { truncated?: boolean; fail?: boolean } = {}) {
  const table = { rows: [...initial] };
  let eventCb: ((e: DurableWorkspaceEvent) => void) | null = null;
  let resyncCb: ((s: SpaceId) => void) | null = null;
  const attentionRequests = vi.fn(async (input: AttentionRequestListQuery) => {
    if (options.fail) throw new Error('node unreachable');
    const items = table.rows.filter((r) => r.status === (input.status as AttentionRequestStatus));
    return { items, nextCursor: options.truncated && input.status === 'open' ? 'c1' : null };
  });
  const resolveAttention = vi.fn(async (entityId: EntityId) => {
    table.rows = table.rows.filter((r) => r.entityId !== entityId);
    return { request: null, entity: { id: entityId } as EntitySummary, affectedCount: 1 };
  });
  const seam = {
    attentionRequests,
    onEvent: vi.fn((cb: (e: DurableWorkspaceEvent) => void) => {
      eventCb = cb;
      return () => { eventCb = null; };
    }),
    onResync: vi.fn((cb: (s: SpaceId) => void) => {
      resyncCb = cb;
      return () => { resyncCb = null; };
    }),
    entity: vi.fn(async (id: EntityId) => ({ title: `Title of ${id}`, state: { kind: 'task' } })),
    commands: { resolveAttention, upsertReadMark: vi.fn(async () => undefined) },
  };
  return {
    table,
    seam: seam as unknown as AttentionSegmentProps['seam'],
    attentionRequests,
    resolveAttention,
    emit: (e: Partial<DurableWorkspaceEvent> & { type: string }) =>
      act(() => { eventCb?.({ spaceId: SPACE, seq: 1, occurredAt: '', schemaVersion: 1, ...e } as DurableWorkspaceEvent); }),
    resync: (s: SpaceId) => act(() => { resyncCb?.(s); }),
  };
}

function mount(fake: ReturnType<typeof fakeSeam>, over: Partial<AttentionSegmentProps> = {}) {
  const onOpenEntity = vi.fn();
  render(
    <AttentionSegment seam={fake.seam} spaceId={SPACE} onOpenEntity={onOpenEntity} refreshDelayMs={0} {...over} />,
  );
  return { onOpenEntity };
}

const count = () => screen.getByTestId('attention-segment-count').textContent;

afterEach(cleanup);

describe('AttentionSegment — the count', () => {
  it('counts every PENDING request — open AND acknowledged, the badge definition', async () => {
    const fake = fakeSeam([
      req({ entityId: 'a', points: 50 }),
      req({ entityId: 'a', points: 10, id: 'r2' }),
      req({ entityId: 'b', points: 30, status: 'acknowledged' }),
      req({ entityId: 'c', points: 99, status: 'resolved' }),
    ]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('3'));
    expect(fake.attentionRequests.mock.calls.map(([q]) => q.status).sort()).toEqual(['acknowledged', 'open']);
    const button = screen.getByTestId('attention-segment');
    expect(button.className).toContain('att-seg__btn--hot');
    expect(button.className).toContain('status-strip__segment');
    expect(button.getAttribute('aria-label')).toBe('3 attention requests pending on 2 entities');
  });

  it('says zero plainly, and is not hot', async () => {
    const fake = fakeSeam([]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('0'));
    expect(screen.getByTestId('attention-segment').className).not.toContain('--hot');
    fireEvent.click(screen.getByTestId('attention-segment'));
    expect(screen.getByTestId('attention-segment-popover').textContent).toContain('Nothing needs your attention');
  });

  it('marks a full page as a floor, never a total', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })], { truncated: true });
    mount(fake);
    await waitFor(() => expect(count()).toBe('1+'));
    // The entity count is grouped from the same truncated page, so it is a
    // floor too.
    expect(screen.getByTestId('attention-segment').getAttribute('aria-label'))
      .toBe('1+ attention request pending on 1+ entities');
  });

  it('shows a dash, not a zero, when the read fails', async () => {
    const fake = fakeSeam([], { fail: true });
    mount(fake);
    await waitFor(() => expect(count()).toBe('—'));
    expect(screen.getByTestId('attention-segment').getAttribute('title')).toContain('node unreachable');
  });

  it('renders nothing without a space', () => {
    const fake = fakeSeam([]);
    mount(fake, { spaceId: null });
    expect(screen.queryByTestId('attention-segment')).toBeNull();
    expect(fake.attentionRequests).not.toHaveBeenCalled();
  });
});

describe('AttentionSegment — live updates', () => {
  it('re-reads on a thin activity_touched event in its space, and ignores other spaces', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('1'));
    const reads = fake.attentionRequests.mock.calls.length;

    fake.table.rows.push(req({ entityId: 'b', points: 7 }));
    fake.emit({ type: 'entity.activity_touched', spaceId: OTHER, id: 'b' as EntityId, kind: 'task', activityAt: '' } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.attentionRequests.mock.calls.length).toBe(reads);

    fake.emit({ type: 'entity.activity_touched', id: 'b' as EntityId, kind: 'task', activityAt: '' } as never);
    await waitFor(() => expect(count()).toBe('2'));
  });

  it('re-reads on an upsert only when its badge disagrees with the held count', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('1'));
    const reads = fake.attentionRequests.mock.calls.length;

    const agreeing = { id: 'a', badges: { attention: { pendingCount: 1 } } } as unknown as EntitySummary;
    fake.emit({ type: 'entity.upsert', entity: agreeing } as never);
    const unrelated = { id: 'z', badges: {} } as unknown as EntitySummary;
    fake.emit({ type: 'entity.upsert', entity: unrelated } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.attentionRequests.mock.calls.length).toBe(reads);

    fake.table.rows = [];
    const cleared = { id: 'a', badges: {} } as unknown as EntitySummary;
    fake.emit({ type: 'entity.upsert', entity: cleared } as never);
    await waitFor(() => expect(count()).toBe('0'));
  });

  it('collapses a burst of events into one trailing read', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake, { refreshDelayMs: 20 });
    await waitFor(() => expect(count()).toBe('1'));
    const reads = fake.attentionRequests.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      fake.emit({ type: 'entity.activity_touched', id: 'a' as EntityId, kind: 'task', activityAt: '' } as never);
    }
    await waitFor(() => expect(fake.attentionRequests.mock.calls.length).toBe(reads + 2));
    await new Promise((r) => setTimeout(r, 40));
    // One refresh = one read per pending status.
    expect(fake.attentionRequests.mock.calls.length).toBe(reads + 2);
  });

  it('re-reads after a resync of its own space', async () => {
    const fake = fakeSeam([]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('0'));
    fake.table.rows.push(req({ entityId: 'a', points: 5 }));
    fake.resync(OTHER);
    await new Promise((r) => setTimeout(r, 5));
    expect(count()).toBe('0');
    fake.resync(SPACE);
    await waitFor(() => expect(count()).toBe('1'));
  });
});

describe('AttentionSegment — reaching the requests', () => {
  it('lists pending entities ranked by combined points, with hydrated titles', async () => {
    const fake = fakeSeam([
      req({ entityId: 'low', points: 10, reason: 'small thing' }),
      req({ entityId: 'high', points: 60, reason: 'first' }),
      req({ entityId: 'high', points: 30, id: 'r3', reason: 'newest', createdAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('3'));
    // No hydration reads until the popover is actually opened.
    expect(fake.seam.entity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('attention-segment'));
    const pop = screen.getByTestId('attention-segment-popover');
    const rows = within(pop).getAllByRole('button');
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'attention-segment-row-high',
      'attention-segment-row-low',
    ]);
    expect(rows[0]!.textContent).toContain('90');
    expect(rows[0]!.textContent).toContain('×2');
    expect(rows[0]!.textContent).toContain('newest');
    await waitFor(() => expect(within(pop).getByText('Title of high')).toBeTruthy());
  });

  it('prefers host-known names over a network read', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake, { nameOf: (id) => (id === 'a' ? { title: 'Known A', kind: 'task' } : undefined) });
    await waitFor(() => expect(count()).toBe('1'));
    fireEvent.click(screen.getByTestId('attention-segment'));
    expect(screen.getByText('Known A')).toBeTruthy();
    expect(fake.seam.entity).not.toHaveBeenCalled();
  });

  /**
   * THE INVERSION (Attention v2, G4/G5). This test asserted the opposite until
   * S0: opening a row bulk-resolved that entity and the count dropped to 1. That
   * made the popover destroy the queue by being used, and it is the behaviour
   * `open-entity.ts` no longer has. The count holding at 2 IS the fix, so this
   * stays a test rather than being deleted with the assertion it guarded.
   */
  it('opening a row navigates and closes, and does NOT resolve or drop the count', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 }), req({ entityId: 'b', points: 3 })]);
    const { onOpenEntity } = mount(fake);
    await waitFor(() => expect(count()).toBe('2'));

    fireEvent.click(screen.getByTestId('attention-segment'));
    fireEvent.click(screen.getByTestId('attention-segment-row-a'));

    expect(onOpenEntity).toHaveBeenCalledWith('a');
    expect(screen.queryByTestId('attention-segment-popover')).toBeNull();
    // NAVIGATION IS A READ. Nothing was written, so nothing moved.
    expect(fake.resolveAttention).not.toHaveBeenCalled();
    expect(fake.table.rows).toHaveLength(2);
    expect(count()).toBe('2');
  });

  it('records a read mark on open — the per-viewer write that DID survive', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('1'));

    fireEvent.click(screen.getByTestId('attention-segment'));
    fireEvent.click(screen.getByTestId('attention-segment-row-a'));

    expect(fake.seam.commands.upsertReadMark).toHaveBeenCalledWith('a', expect.any(String));
  });

  it('closes on Escape and on an outside pointer-down', async () => {
    const fake = fakeSeam([req({ entityId: 'a', points: 5 })]);
    mount(fake);
    await waitFor(() => expect(count()).toBe('1'));
    const button = screen.getByTestId('attention-segment');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('attention-segment-popover')).toBeNull();

    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('attention-segment-popover')).toBeNull();
  });
});

/**
 * A seam whose reads resolve only when the test says so. Each call to
 * `attentionRequests` parks a deferred; `settle(i, rows)` answers call `i`
 * with the rows of the requested status. This is what makes a read genuinely
 * IN FLIGHT while further triggers arrive — the plain fake answers on the next
 * microtask, so the throttle's timer swallowed every burst before the
 * in-flight guard was ever consulted.
 */
function deferredSeam() {
  type Call = { input: AttentionRequestListQuery; resolve(rows: AttentionRequest[]): void };
  const calls: Call[] = [];
  let eventCb: ((e: DurableWorkspaceEvent) => void) | null = null;
  const seam = {
    attentionRequests: vi.fn((input: AttentionRequestListQuery) => new Promise((resolve) => {
      calls.push({
        input,
        resolve: (rows) => resolve({
          items: rows.filter((r) => r.status === input.status && r.spaceId === input.spaceId),
          nextCursor: null,
        }),
      });
    })),
    onEvent: vi.fn((cb: (e: DurableWorkspaceEvent) => void) => {
      eventCb = cb;
      return () => { eventCb = null; };
    }),
    onResync: vi.fn(() => () => undefined),
    entity: vi.fn(async () => ({ title: 't', state: { kind: 'task' } })),
    commands: { resolveAttention: vi.fn(), upsertReadMark: vi.fn(async () => undefined) },
  };
  return {
    calls,
    seam: seam as unknown as AttentionSegmentProps['seam'],
    /** Answer every call made for one refresh (one per pending status). */
    settle: async (from: number, rows: AttentionRequest[]) => {
      await act(async () => {
        for (const call of calls.slice(from, from + 2)) call.resolve(rows);
      });
    },
    touch: (spaceId: SpaceId = SPACE) => act(() => {
      eventCb?.({
        type: 'entity.activity_touched', spaceId, seq: 1, occurredAt: '', schemaVersion: 1,
        id: 'x' as EntityId, kind: 'task', activityAt: '',
      } as DurableWorkspaceEvent);
    }),
  };
}

const tick = (ms = 5) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('AttentionSegment — reads that overlap', () => {
  it('never runs two reads at once: triggers during a read collapse into ONE trailing read, and its answer wins', async () => {
    const d = deferredSeam();
    render(<AttentionSegment seam={d.seam} spaceId={SPACE} onOpenEntity={vi.fn()} refreshDelayMs={0} />);
    await waitFor(() => expect(d.calls).toHaveLength(2));

    // Three event-triggered refreshes land while the first read is still out.
    // Each timer fires (delay 0) and reaches `load()` — the IN-FLIGHT guard is
    // the only thing between them and three more concurrent reads.
    for (let i = 0; i < 3; i++) {
      d.touch();
      await tick();
    }
    expect(d.calls).toHaveLength(2);

    // The first read answers with the OLD queue; the trailing read starts only
    // now, and exactly once.
    await d.settle(0, [req({ entityId: 'a', points: 5 })]);
    await waitFor(() => expect(d.calls).toHaveLength(4));
    expect(count()).toBe('1');

    await d.settle(2, [req({ entityId: 'a', points: 5 }), req({ entityId: 'b', points: 7 })]);
    await waitFor(() => expect(count()).toBe('2'));
    await tick(20);
    expect(d.calls).toHaveLength(4);
  });

  it('drops a slow answer for the space it has left', async () => {
    const d = deferredSeam();
    const OTHER_ROWS = [
      req({ entityId: 'a1', points: 5 }),
      req({ entityId: 'a2', points: 5 }),
      req({ entityId: 'a3', points: 5 }),
    ];
    const view = render(
      <AttentionSegment seam={d.seam} spaceId={SPACE} onOpenEntity={vi.fn()} refreshDelayMs={0} />,
    );
    await waitFor(() => expect(d.calls).toHaveLength(2));

    view.rerender(
      <AttentionSegment seam={d.seam} spaceId={OTHER} onOpenEntity={vi.fn()} refreshDelayMs={0} />,
    );
    await waitFor(() => expect(d.calls).toHaveLength(4));
    expect(d.calls.slice(2).every((c) => c.input.spaceId === OTHER)).toBe(true);

    // The NEW space answers first, then the old space's slow read lands.
    await d.settle(2, [{ ...req({ entityId: 'b1', points: 9 }), spaceId: OTHER }]);
    await waitFor(() => expect(count()).toBe('1'));
    await d.settle(0, OTHER_ROWS);
    await tick();
    expect(count()).toBe('1');
  });
});

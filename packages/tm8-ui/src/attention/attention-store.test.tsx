// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type {
  AttentionRequest,
  AttentionRequestListQuery,
  DurableWorkspaceEvent,
  EntityAttentionSummary,
  EntityId,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import { AttentionProvider, useAttention, useAttentionOptional } from './attention-store';
import type { AttentionApi } from './attention-store';
import type { AttentionSeam } from './attention-commands';
import { UNDO_WINDOW_MS } from './attention-commands';
import { buildQueue, countsOf, groupByRoot } from './attention-selectors';
import { AttentionUndoToast } from './AttentionUndoToast';

const SPACE = 'space-1' as SpaceId;
const ME = 'member-me';

let seq = 0;
function req(over: Partial<AttentionRequest> & { entityId: string }): AttentionRequest {
  seq += 1;
  return {
    id: over.id ?? `req-${seq}`,
    spaceId: SPACE,
    entityId: over.entityId as EntityId,
    reason: over.reason ?? 'because',
    points: over.points ?? 40,
    status: over.status ?? 'open',
    version: over.version ?? 1,
    requestedBy: { id: 'agent-1' as EntityId, kind: 'member', displayName: 'Agent', avatar: null, isAgent: true },
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: over.createdAt ?? '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    ...over,
  } as AttentionRequest;
}

function badge(pendingCount: number, totalPoints = 40 * pendingCount): EntityAttentionSummary {
  return { pendingCount, totalPoints, maxPoints: 40, latestReason: 'why', oldestRequestedAt: '2026-09-26T10:00:00.000Z' };
}

function summary(id: string, attention: EntityAttentionSummary | null): EntitySummary {
  return { id, badges: { attention } } as unknown as EntitySummary;
}

function fakeSeam(initial: AttentionRequest[], options: { v2?: boolean; failResolve?: boolean } = {}) {
  const table = { rows: [...initial] };
  const listeners: ((e: DurableWorkspaceEvent) => void)[] = [];
  const pendingOn = (id: string) => table.rows.filter((r) => (r.rootId ?? r.entityId) === id && (r.status === 'open' || r.status === 'acknowledged'));
  const result = (id: string) => ({ request: null, entity: summary(id, pendingOn(id).length ? badge(pendingOn(id).length) : null), affectedCount: 1 });

  const attentionRequests = vi.fn(async (input: AttentionRequestListQuery) => ({
    items: table.rows.filter((r) => r.status === input.status).map((r) => ({ ...r })),
    nextCursor: null,
  }));
  const resolveAttention = vi.fn(async (entityId: EntityId) => {
    if (options.failResolve) throw new Error('node unreachable');
    for (const r of table.rows) if (r.entityId === entityId && r.status === 'open') { r.status = 'resolved'; r.version += 1; }
    return result(entityId);
  });
  const updateAttentionRequest = vi.fn(async (id: string, input: { status?: string }) => {
    const row = table.rows.find((r) => r.id === id)!;
    row.status = input.status as AttentionRequest['status'];
    row.version += 1;
    return { ...result(row.entityId), request: row };
  });
  const postMessage = vi.fn(async () => ({}));
  const v2 = {
    markSeen: vi.fn(async (id: EntityId) => result(id)),
    unresolve: vi.fn(async () => {
      for (const r of table.rows) if (r.status === 'resolved') r.status = 'open';
      return result('task-1');
    }),
    withdraw: vi.fn(async (id: string) => {
      const row = table.rows.find((r) => r.id === id)!;
      row.status = 'dismissed';
      return { ...result(row.entityId), request: row };
    }),
  };
  const seam = {
    attentionRequests,
    onEvent: (cb: (e: DurableWorkspaceEvent) => void) => {
      listeners.push(cb);
      return () => { listeners.splice(listeners.indexOf(cb), 1); };
    },
    onResync: () => () => {},
    entity: vi.fn(async (id: EntityId) => ({ title: `Title ${id}`, state: { kind: 'task' } })),
    commands: {
      resolveAttention,
      updateAttentionRequest,
      postMessage,
      attentionV2: options.v2 ? v2 : {},
    },
  } as unknown as AttentionSeam;
  return {
    table, seam, attentionRequests, resolveAttention, updateAttentionRequest, postMessage, v2,
    upsert: (id: string, attention: EntityAttentionSummary | null) => act(() => {
      for (const l of [...listeners]) {
        l({ spaceId: SPACE, seq: 1, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: summary(id, attention) } as unknown as DurableWorkspaceEvent);
      }
    }),
  };
}

function mount(fake: ReturnType<typeof fakeSeam>) {
  const ref: { api: AttentionApi | null } = { api: null };
  function Probe() {
    ref.api = useAttention();
    return null;
  }
  render(
    <AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0} newId={() => `id-${++seq}`}>
      <Probe />
      <AttentionUndoToast />
    </AttentionProvider>,
  );
  return ref;
}

async function ready(ref: { api: AttentionApi | null }) {
  await waitFor(() => expect(ref.api?.status).toBe('ready'));
  return ref;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('selectors (chapter 1)', () => {
  it('pending is open plus legacy acknowledged; counts are roots; mine needs the viewer as assignee', () => {
    const rows = [
      req({ entityId: 'task-1', assigneeId: ME as EntityId }),
      req({ entityId: 'sess-1', rootId: 'task-1' as EntityId }),
      req({ entityId: 'doc-1', status: 'acknowledged' }),
      req({ entityId: 'doc-2', status: 'resolved' }),
      req({ entityId: 'doc-3', assigneeId: 'someone-else' as EntityId }),
    ];
    const byRoot = groupByRoot(rows);
    expect([...byRoot.keys()].sort()).toEqual(['doc-1', 'doc-3', 'task-1']);
    expect(countsOf(byRoot, ME)).toEqual({ mine: 1, all: 3 });
    expect(countsOf(byRoot, null)).toEqual({ mine: 0, all: 3 });
  });

  it('orders unseen first, then level, then points, then oldest', () => {
    const rows = [
      req({ entityId: 'a', level: 'urgent', points: 95, seenByMe: true }),
      req({ entityId: 'b', level: 'fyi', points: 10 }),
      req({ entityId: 'c', level: 'high', points: 70 }),
      req({ entityId: 'd', level: 'high', points: 90 }),
      req({ entityId: 'e', level: 'high', points: 90, createdAt: '2026-09-26T09:00:00.000Z' }),
    ];
    const queue = buildQueue(groupByRoot(rows), { filter: 'all', viewerId: ME, names: new Map() });
    expect(queue.map((r) => r.rootId)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(queue[4]!.seen).toBe(true);
  });

  it('a roll-up root combines own and rolled-up requests', () => {
    const rows = [
      req({ entityId: 'task-1', points: 40 }),
      req({ entityId: 'sess-1', rootId: 'task-1' as EntityId, points: 70, level: 'high' }),
    ];
    const [row] = buildQueue(groupByRoot(rows), { filter: 'all', viewerId: ME, names: new Map() });
    expect(row).toMatchObject({ rootId: 'task-1', rolledUp: 1, chip: { pendingCount: 2, totalPoints: 110, level: 'high', icon: '!', tone: 'wait' } });
  });
});

describe('AttentionProvider', () => {
  it('useAttentionOptional is null outside the provider', () => {
    let seen: AttentionApi | null | undefined;
    function Probe() {
      seen = useAttentionOptional();
      return null;
    }
    render(<Probe />);
    expect(seen).toBeNull();
  });

  it('chipFor prefers the freshest badge, and takes the level from rows', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1', level: 'urgent', points: 95 })]);
    const ref = await ready(mount(fake));
    expect(ref.api!.chipFor(summary('task-1', badge(1, 95)))).toMatchObject({ level: 'urgent', tone: 'block', totalPoints: 95 });
    // An entity the host thinks is clean but an upsert says is waiting.
    fake.upsert('doc-9', badge(2));
    expect(ref.api!.chipFor(summary('doc-9', null))).toMatchObject({ pendingCount: 2, level: 'normal' });
    // And the reverse: an upsert clears a stale host badge.
    fake.upsert('task-1', null);
    expect(ref.api!.chipFor(summary('task-1', badge(1, 95)))).toBeNull();
  });

  it('raisedChipFor marks the session that asked, wherever the request is pinned (F1)', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1', sourceWorkSessionId: 'sess-1' as EntityId, reason: 'pick one' })]);
    const ref = await ready(mount(fake));
    expect(ref.api!.raisedChipFor('sess-1')).toMatchObject({ pendingCount: 1, latestReason: 'pick one' });
    expect(ref.api!.raisedChipFor('sess-2')).toBeNull();
    expect(ref.api!.counts()).toEqual({ mine: 0, all: 1 });
  });

  it('resolve settles in place, offers Undo for 8s, and before S4 resolves rolled-up children too', async () => {
    const fake = fakeSeam([
      req({ entityId: 'task-1', assigneeId: ME as EntityId }),
      req({ entityId: 'sess-1', rootId: 'task-1' as EntityId }),
    ]);
    const ref = await ready(mount(fake));
    expect(ref.api!.counts()).toEqual({ mine: 1, all: 1 });

    let done!: Promise<void>;
    act(() => { done = ref.api!.resolve('task-1' as EntityId, '  ship it '); });
    // In place, before the server answers.
    expect(ref.api!.counts()).toEqual({ mine: 0, all: 0 });
    expect(ref.api!.chipFor(summary('task-1', badge(2)))).toBeNull();
    expect(ref.api!.undo).toMatchObject({ rootId: 'task-1' });
    await act(() => done);

    expect(fake.resolveAttention.mock.calls.map((c) => c[0])).toEqual(['sess-1', 'task-1']);
    const input = fake.resolveAttention.mock.calls[1]![1] as { resolutionNote?: string; resolutionBatchId?: string };
    expect(input.resolutionNote).toBe('ship it');
    expect(input.resolutionBatchId).toBe(ref.api!.undo!.batchId);
    expect(document.querySelector('[data-testid="attention-toast-undo"]')).not.toBeNull();
  });

  it('with S4, resolve names only the root', async () => {
    const fake = fakeSeam([
      req({ entityId: 'task-1' }),
      req({ entityId: 'sess-1', rootId: 'task-1' as EntityId }),
    ], { v2: true });
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    expect(fake.resolveAttention.mock.calls.map((c) => c[0])).toEqual(['task-1']);
  });

  it('Undo before S4 reopens each row at its bumped version', async () => {
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1', version: 3 })]);
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    const batch = ref.api!.undo!.batchId;
    await act(() => ref.api!.unresolve(batch));
    expect(fake.updateAttentionRequest).toHaveBeenCalledWith('r1', expect.objectContaining({ expectedVersion: 4, status: 'open' }));
    expect(ref.api!.undo).toBeNull();
    await waitFor(() => expect(ref.api!.counts().all).toBe(1));
  });

  it('Undo with S4 sends the batch to unresolve', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1' })], { v2: true });
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    const batch = ref.api!.undo!.batchId;
    await act(() => ref.api!.unresolve(batch));
    expect(fake.v2.unresolve).toHaveBeenCalledWith(batch, expect.anything());
    expect(fake.updateAttentionRequest).not.toHaveBeenCalled();
  });

  it('the Undo offer expires with the window', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1' })]);
    const ref = await ready(mount(fake));
    vi.useFakeTimers();
    await act(() => ref.api!.resolve('task-1' as EntityId));
    expect(ref.api!.undo).not.toBeNull();
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 1); });
    expect(ref.api!.undo).toBeNull();
  });

  it('a failed resolve rolls back and says so; nothing throws', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1' })], { failResolve: true });
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    expect(ref.api!.counts().all).toBe(1);
    expect(ref.api!.undo).toBeNull();
    expect(ref.api!.error).toMatch(/Couldn't resolve/);
    expect(document.querySelector('[data-testid="attention-toast"]')?.textContent).toMatch(/node unreachable/);
  });

  it('markSeen dims locally before S4 and calls the op with it; the count never moves', async () => {
    const before = fakeSeam([req({ entityId: 'task-1' })]);
    const ref = await ready(mount(before));
    await act(() => ref.api!.markSeen('task-1' as EntityId));
    expect(ref.api!.queue('all')[0]!.seen).toBe(true);
    expect(ref.api!.counts().all).toBe(1);
    cleanup();

    const after = fakeSeam([req({ entityId: 'task-1' })], { v2: true });
    const ref2 = await ready(mount(after));
    await act(() => ref2.api!.markSeen('task-1' as EntityId));
    expect(after.v2.markSeen).toHaveBeenCalledWith('task-1', expect.anything());
  });

  it('withdraw falls back to dismissed before S4, and uses the op after', async () => {
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1', version: 2 })]);
    const ref = await ready(mount(fake));
    await act(() => ref.api!.withdraw('r1'));
    expect(fake.updateAttentionRequest).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'dismissed', expectedVersion: 2 }));
    expect(ref.api!.counts().all).toBe(0);
    cleanup();

    const v2 = fakeSeam([req({ id: 'r2', entityId: 'task-1' })], { v2: true });
    const ref2 = await ready(mount(v2));
    await act(() => ref2.api!.withdraw('r2'));
    expect(v2.v2.withdraw).toHaveBeenCalledWith('r2', expect.anything());
  });

  it('reply posts on the session and leaves the request open', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1', sourceWorkSessionId: 'sess-1' as EntityId })]);
    const ref = await ready(mount(fake));
    await act(() => ref.api!.reply('sess-1' as EntityId, 'which one?'));
    expect(fake.postMessage).toHaveBeenCalledWith(expect.objectContaining({ anchorIds: ['sess-1'], body: 'which one?' }));
    expect(ref.api!.counts().all).toBe(1);
  });

  it('queue rows carry hydrated titles', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1' })]);
    const ref = await ready(mount(fake));
    await waitFor(() => expect(ref.api!.queue('all')[0]!.title).toBe('Title task-1'));
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { AttentionRequest, EntityAttentionSummary, EntityId } from '@tm8/contract';
import { AttentionProvider, useAttention, useAttentionOptional } from './attention-store';
import type { AttentionApi } from './attention-store';
import { UNDO_WINDOW_MS } from './attention-commands';
import { buildQueue, countsOf, groupByRoot } from './attention-selectors';
import { AttentionUndoToast } from './AttentionUndoToast';

import { ME, SPACE, badge, fakeSeam, nextId, req, summary } from './fake-attention-seam.test-support';

function mount(fake: ReturnType<typeof fakeSeam>) {
  const ref: { api: AttentionApi | null } = { api: null };
  function Probe() {
    ref.api = useAttention();
    return null;
  }
  render(
    <AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0} newId={nextId}>
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

  it('orders priority before seen, then points and oldest; FYI requires its explicit scope', () => {
    const rows = [
      req({ entityId: 'a', level: 'urgent', points: 95, seenByMe: true }),
      req({ entityId: 'b', level: 'fyi', points: 10 }),
      req({ entityId: 'c', level: 'high', points: 70 }),
      req({ entityId: 'd', level: 'high', points: 90 }),
      req({ entityId: 'e', level: 'high', points: 90, createdAt: '2026-09-26T09:00:00.000Z' }),
      req({ entityId: 'normal', level: 'normal', points: 1000 }),
    ];
    const queue = buildQueue(groupByRoot(rows), { filter: 'all', viewerId: ME, names: new Map() });
    expect(queue.map((r) => r.rootId)).toEqual(['a', 'e', 'd', 'c', 'normal']);
    expect(queue[0]!.seen).toBe(true);
    const fyi = buildQueue(groupByRoot(rows), { filter: 'all', viewerId: ME, names: new Map(), scope: 'fyi' });
    expect(fyi.map((r) => r.rootId)).toEqual(['b']);
  });

  it('counts only assigned actions as Personal, retains FYI explicitly, and counts mixed roots once', () => {
    const byRoot = groupByRoot([
      req({ entityId: 'mixed', assigneeId: 'someone-else' as EntityId }),
      req({ entityId: 'session', rootId: 'mixed' as EntityId, level: 'fyi', assigneeId: ME as EntityId }),
      req({ entityId: 'only-fyi', level: 'fyi', assigneeId: ME as EntityId }),
      req({ entityId: 'my-action', assigneeId: ME as EntityId, status: 'acknowledged' }),
      req({ entityId: 'closed', assigneeId: ME as EntityId, level: 'urgent', status: 'resolved' }),
    ]);
    expect(countsOf(byRoot, ME)).toEqual({ mine: 1, all: 2 });
    expect(countsOf(byRoot, ME, 'fyi')).toEqual({ mine: 2, all: 2 });
    expect(countsOf(byRoot, ME, 'all')).toEqual({ mine: 3, all: 3 });
    expect(buildQueue(byRoot, { filter: 'mine', viewerId: ME, names: new Map() }).map(r => r.rootId)).toEqual(['my-action']);
  });

  it('heads a mixed root with its older urgent request and retains the newest request and complete inventory', () => {
    const urgent = req({ id: 'urgent', entityId: 'task', level: 'urgent', points: 95, seenByMe: true, reason: 'Restore service',
      sourceWorkSessionId: 'urgent-session' as EntityId, actionType: 'approve', createdAt: '2026-09-25T09:00:00.000Z' });
    const normal = req({ id: 'normal', entityId: 'task', points: 40, createdAt: '2026-09-26T09:00:00.000Z' });
    const fyi = req({ id: 'fyi', entityId: 'task', level: 'fyi', points: 1000, reason: 'New information', createdAt: '2026-09-26T11:00:00.000Z' });
    const byRoot = groupByRoot([normal, fyi, urgent]);
    const options = { filter: 'all' as const, viewerId: ME, names: new Map() };
    const [row] = buildQueue(byRoot, options);
    expect(row!.primary).toEqual(urgent);
    expect(row!.latest).toEqual(fyi);
    expect(row!.requests.map(r => r.id)).toEqual(['fyi', 'normal', 'urgent']);
    expect(row!.chip).toMatchObject({ level: 'urgent', totalPoints: 135, pendingCount: 2 });
    expect(row!.chip.latestReason).toBe('Restore service');
    expect(buildQueue(byRoot, { ...options, scope: 'fyi' })[0]!.primary).toEqual(fyi);
    expect(buildQueue(byRoot, { ...options, scope: 'all' })[0]!.requests).toHaveLength(3);
  });

  it('Personal headlines and ranks the viewer\'s request while retaining other assignees in the root inventory', () => {
    const mine = req({ id: 'mine', entityId: 'task', level: 'high', points: 40, assigneeId: ME as EntityId,
      reason: 'My approval', sourceWorkSessionId: 'my-session' as EntityId });
    const theirs = req({ id: 'theirs', entityId: 'task', level: 'high', points: 95,
      assigneeId: 'another-member' as EntityId, reason: 'Their review' });
    const byRoot = groupByRoot([theirs, mine]);
    const options = { viewerId: ME, names: new Map() };
    const [personal] = buildQueue(byRoot, { ...options, filter: 'mine' });
    expect(personal!.primary).toEqual(mine);
    expect(personal!.chip).toMatchObject({ pendingCount: 1, totalPoints: 40, latestReason: 'My approval' });
    expect(personal!.requests).toHaveLength(2);
    expect(buildQueue(byRoot, { ...options, filter: 'all' })[0]!.primary).toEqual(theirs);
  });

  it('keeps FYI points and unseen state out of actionable ranking, with deterministic age and id ties', () => {
    const rows = [
      req({ id: 'a', entityId: 'a', level: 'high', points: 70, seenByMe: true }),
      req({ id: 'noise', entityId: 'a', level: 'fyi', points: 1000 }),
      req({ id: 'b', entityId: 'b', level: 'high', points: 70 }),
      req({ id: 'c', entityId: 'c', level: 'high', points: 70 }),
      req({ id: 'd', entityId: 'd', level: 'high', points: 70, createdAt: '2026-09-25T09:00:00.000Z' }),
    ];
    const queue = buildQueue(groupByRoot(rows), { filter: 'all', viewerId: ME, names: new Map() });
    expect(queue.map(r => r.rootId)).toEqual(['d', 'b', 'c', 'a']);
    expect(queue[3]!.seen).toBe(true);
    expect(queue[3]!.chip.totalPoints).toBe(70);
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

    let done!: Promise<boolean>;
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

  it('reply clears the last error before trying, and reports whether it landed', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1', sourceWorkSessionId: 'sess-1' as EntityId })]);
    const ref = await ready(mount(fake));
    fake.postMessage.mockRejectedValueOnce(new Error('offline'));
    let landed: boolean | undefined;
    await act(async () => { landed = await ref.api!.reply('sess-1' as EntityId, 'which one?'); });
    expect(landed).toBe(false);
    expect(ref.api!.error).toBe("Couldn't send the reply: offline");

    // A retry that lands clears the old failure rather than leaving it up.
    await act(async () => { landed = await ref.api!.reply('sess-1' as EntityId, 'which one?'); });
    expect(landed).toBe(true);
    expect(ref.api!.error).toBeNull();
  });

  it('queue rows carry hydrated titles', async () => {
    const fake = fakeSeam([req({ entityId: 'task-1' })]);
    const ref = await ready(mount(fake));
    await waitFor(() => expect(ref.api!.queue('all')[0]!.title).toBe('Title task-1'));
  });
});

describe('review fixes (S5a review, findings 1, 2, 4)', () => {
  function gated() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { gate, release };
  }

  it('Undo pressed while the resolve is in flight waits for it, then really reopens (v1)', async () => {
    const { gate, release } = gated();
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1', version: 3 })], { gate });
    const ref = await ready(mount(fake));
    let resolving!: Promise<boolean>;
    act(() => { resolving = ref.api!.resolve('task-1' as EntityId); });
    const batch = ref.api!.undo!.batchId;
    let undoing!: Promise<void>;
    act(() => { undoing = ref.api!.unresolve(batch); });
    await act(async () => { release(); await resolving; await undoing; });
    expect(fake.table.rows[0]!.status).toBe('open');
    expect(ref.api!.error).toBeNull();
    await waitFor(() => expect(ref.api!.counts().all).toBe(1));
  });

  it('Undo pressed while the resolve is in flight waits for it (v2 batch)', async () => {
    const { gate, release } = gated();
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1' })], { gate, v2: true });
    const ref = await ready(mount(fake));
    let resolving!: Promise<boolean>;
    act(() => { resolving = ref.api!.resolve('task-1' as EntityId); });
    const batch = ref.api!.undo!.batchId;
    let undoing!: Promise<void>;
    act(() => { undoing = ref.api!.unresolve(batch); });
    await act(async () => { release(); await resolving; await undoing; });
    expect(fake.v2.unresolve).toHaveBeenCalledWith(batch, expect.anything());
    expect(fake.table.rows[0]!.status).toBe('open');
    await waitFor(() => expect(ref.api!.counts().all).toBe(1));
  });

  it('a partial v1 Undo failure hides nothing the server has open', async () => {
    const fake = fakeSeam([
      req({ id: 'r1', entityId: 'task-1' }),
      req({ id: 'r2', entityId: 'task-1' }),
    ], { failUpdateFor: 'r2' });
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    await act(() => ref.api!.unresolve(ref.api!.undo!.batchId));
    expect(ref.api!.error).toMatch(/Couldn't undo/);
    // r1 was reopened on the server; the read after the settle shows it.
    await waitFor(() => expect(ref.api!.requestsFor('task-1').map((r) => r.id)).toEqual(['r1']));
    expect(ref.api!.counts().all).toBe(1);
  });

  it('a settled hide ends when a later read has the row open again (reopened elsewhere)', async () => {
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1' })]);
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    await waitFor(() => expect(ref.api!.counts().all).toBe(0));
    // Another surface reopens it; the next read is the truth.
    fake.table.rows[0]!.status = 'open';
    act(() => ref.api!.refresh());
    await waitFor(() => expect(ref.api!.counts().all).toBe(1));
  });

  it("a fresh badge's maxLevel beats the rows' older level", async () => {
    const fake = fakeSeam([req({ entityId: 'task-1', level: 'normal' })]);
    const ref = await ready(mount(fake));
    fake.upsert('task-1', { ...badge(2), maxLevel: 'urgent' } as EntityAttentionSummary);
    expect(ref.api!.chipFor(summary('task-1', badge(1)))).toMatchObject({ level: 'urgent', tone: 'block' });
  });

  it('a failed Undo does not hide the root from a request raised later', async () => {
    const fake = fakeSeam([req({ id: 'r1', entityId: 'task-1' })], { v2: true });
    fake.v2.unresolve.mockRejectedValue(Object.assign(new Error('undo window closed'), { code: 'conflict' }));
    const ref = await ready(mount(fake));
    await act(() => ref.api!.resolve('task-1' as EntityId));
    await act(() => ref.api!.unresolve(ref.api!.undo!.batchId));
    expect(ref.api!.error).toMatch(/Couldn't undo/);
    await waitFor(() => expect(ref.api!.counts().all).toBe(0));
    // A new request lands on the same root.
    fake.table.rows.push(req({ id: 'r9', entityId: 'task-1', reason: 'one more thing' }));
    act(() => ref.api!.refresh());
    await waitFor(() => expect(ref.api!.requestsFor('task-1').map((r) => r.id)).toEqual(['r9']));
    expect(ref.api!.counts().all).toBe(1);
    fake.upsert('task-1', badge(1));
    expect(ref.api!.chipFor(summary('task-1', badge(1)))).not.toBeNull();
  });
});

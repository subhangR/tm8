// @vitest-environment jsdom
/**
 * Rail live counts (task 01a111a2-f9ad, design log R42): root tasks and stories
 * in progress, every live session, root chats running — derived from a fake
 * seam that answers `parentId` and `category` the way the server does, kept
 * live by events and liveness pushes, hidden at 0, `99+` above 99, a corner
 * badge collapsed and a row number expanded, and the words in tooltip + aria.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, EntitySummary } from '@tm8/contract';
import type { LivenessSnapshot, Seam } from '../../data/seam';
import { getRailStore, resetRailStores } from '../runtime/railStore';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from './context';
import { WorkspaceRail } from './WorkspaceRail';
import { inProgressFilter, readRailCounts, railCountLabel, railKindLabel, sessionCountOf } from './useRailCounts';

const SPACE = 'space-rail-counts';

interface Row {
  id: string;
  kind: string;
  parentId: string | null;
  category?: string;
  turnState?: string;
}

function fakeSeam(initial: Row[], snapshot: Partial<LivenessSnapshot> = {}) {
  let rows = initial;
  const eventSubs = new Set<() => void>();
  const liveSubs = new Set<(s: LivenessSnapshot) => void>();
  const snap = (extra: Partial<LivenessSnapshot>): LivenessSnapshot => ({
    spaceId: SPACE as never,
    liveEntityIds: [],
    nodeBootId: 'boot',
    checkedAt: 'now',
    ...extra,
  });
  const query = vi.fn(async (input: CollectionQuery) => {
    const f = input.filters ?? {};
    const hit = rows.filter(
      (r) =>
        (!input.kinds || input.kinds.includes(r.kind as never)) &&
        (input.parentId === undefined || r.parentId === input.parentId) &&
        (!f.category || f.category.includes(r.category as never)),
    );
    const items = hit.slice(0, input.limit ?? 50).map(
      (r) => ({ id: r.id, kind: r.kind, parentId: r.parentId, state: { turnState: r.turnState } }) as unknown as EntitySummary,
    );
    return { page: { items, nextCursor: null, total: hit.length } } as never;
  });
  const seam = {
    query,
    onEvent: (cb: () => void) => {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    liveness: {
      refresh: vi.fn(async () => snap(snapshot)),
      onChange: (cb: (s: LivenessSnapshot) => void) => {
        liveSubs.add(cb);
        return () => liveSubs.delete(cb);
      },
    },
  } as unknown as Seam;
  return {
    seam,
    query,
    setRows(next: Row[]) {
      rows = next;
    },
    emitEvent() {
      eventSubs.forEach((cb) => cb());
    },
    pushLiveness(extra: Partial<LivenessSnapshot>) {
      liveSubs.forEach((cb) => cb(snap(extra)));
    },
  };
}

const many = (n: number, make: (i: number) => Row): Row[] => Array.from({ length: n }, (_, i) => make(i));

/** 2 root tasks in progress, plus a child in progress and a root done. */
const FIXTURE: Row[] = [
  { id: 't1', kind: 'task', parentId: null, category: 'in_progress' },
  { id: 't2', kind: 'task', parentId: null, category: 'in_progress' },
  { id: 't3', kind: 'task', parentId: 't1', category: 'in_progress' },
  { id: 't4', kind: 'task', parentId: null, category: 'done' },
  { id: 's1', kind: 'story', parentId: null, category: 'in_progress' },
  { id: 's2', kind: 'story', parentId: 's1', category: 'in_progress' },
  { id: 'c1', kind: 'chat', parentId: null, turnState: 'running' },
  { id: 'c2', kind: 'chat', parentId: null, turnState: 'idle' },
  { id: 'c3', kind: 'chat', parentId: null, turnState: 'queued' },
  { id: 'c4', kind: 'chat', parentId: 'w1', turnState: 'running' },
];

function mount(seam: Seam | undefined) {
  const store = createWorkspaceStore('viewer-1', SPACE);
  const gate = {
    shellTabs: [],
    openPalette: vi.fn(),
    onSelectViewTab: vi.fn(),
    accountSlot: undefined,
    data: seam ? { seam, spaceId: SPACE } : undefined,
  } as unknown as WorkspaceGateHandles;
  const value = { runtime: {} as never, store, dispatch: vi.fn(), viewerId: 'viewer-1', spaceId: SPACE, gate } as WorkspaceContextValue;
  return render(
    <WorkspaceProvider value={value}>
      <WorkspaceRail />
    </WorkspaceProvider>,
  );
}

const kindButtons = (kind: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(`button[data-kind="${kind}"]`));
const countOf = (button: HTMLButtonElement) => button.querySelector('[data-testid="tws-rail-count"]')?.textContent ?? null;

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
});
afterEach(() => {
  cleanup();
});

describe('count derivation', () => {
  it('counts root tasks and stories in progress, and root running chats only', async () => {
    const { seam, query } = fakeSeam(FIXTURE);
    await expect(readRailCounts(seam, SPACE)).resolves.toEqual({ task: 2, story: 1, chat: 1 });
    /* The same filter as the browser's In Progress tab, plus the list's top level. */
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['task'], parentId: null, filters: inProgressFilter('task'), limit: 1 }),
    );
    expect(inProgressFilter('task')).toEqual(expect.objectContaining({ category: ['in_progress'] }));
  });

  it('a child in progress or a child chat running is not counted', async () => {
    const { seam } = fakeSeam([
      { id: 't3', kind: 'task', parentId: 't1', category: 'in_progress' },
      { id: 's2', kind: 'story', parentId: 's1', category: 'in_progress' },
      { id: 'c4', kind: 'chat', parentId: 'w1', turnState: 'running' },
    ]);
    await expect(readRailCounts(seam, SPACE)).resolves.toEqual({ task: 0, story: 0, chat: 0 });
  });

  it('sessions are the full live count, children included; an older node falls back to the live set', () => {
    const base = { spaceId: SPACE as never, nodeBootId: 'b', checkedAt: 'x' };
    expect(sessionCountOf({ ...base, liveEntityIds: ['a', 'b', 'c'], liveSessionCount: 2 })).toBe(2);
    expect(sessionCountOf({ ...base, liveEntityIds: ['root', 'child'] })).toBe(2);
  });
});

describe('labels', () => {
  it('hidden at 0, the number up to 99, 99+ above', () => {
    expect(railCountLabel(undefined)).toBeNull();
    expect(railCountLabel(0)).toBeNull();
    expect(railCountLabel(99)).toBe('99');
    expect(railCountLabel(100)).toBe('99+');
  });

  it('tooltip and aria words per kind; every other kind stays plain', () => {
    expect(railKindLabel('task', 'Tasks', 4)).toBe('Tasks · 4 in progress (top-level)');
    expect(railKindLabel('story', 'Stories', 1)).toBe('Stories · 1 in progress (top-level)');
    expect(railKindLabel('work_session', 'Sessions', 2)).toBe('Sessions · 2 running');
    expect(railKindLabel('chat', 'Chats', 1)).toBe('Chats · 1 running (top-level)');
    expect(railKindLabel('task', 'Tasks', 0)).toBe('Tasks');
    expect(railKindLabel('doc', 'Docs', 4)).toBe('Docs');
  });
});

describe('the rail', () => {
  it('badges the four kinds in both the Pinned and list copies, and no other kind', async () => {
    const fake = fakeSeam(FIXTURE, { liveEntityIds: ['w1', 'w2', 'w3'], liveSessionCount: 3 });
    mount(fake.seam);
    await waitFor(() => expect(kindButtons('task').map(countOf)).toEqual(['2', '2']));
    expect(kindButtons('work_session').map(countOf)).toEqual(['3', '3']);
    expect(kindButtons('chat').map(countOf)).toEqual(['1', '1']);
    expect(kindButtons('story').map(countOf)).toEqual(['1']);
    const others = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-kind]')).filter(
      (b) => !['task', 'story', 'work_session', 'chat'].includes(b.dataset.kind!),
    );
    expect(others.length).toBeGreaterThan(0);
    expect(others.map(countOf).every((c) => c === null)).toBe(true);
    const [task] = kindButtons('task');
    expect(task!.getAttribute('aria-label')).toBe('Tasks · 2 in progress (top-level)');
    expect(kindButtons('work_session')[0]!.getAttribute('aria-label')).toBe('Sessions · 3 running');
    expect(kindButtons('chat')[0]!.getAttribute('aria-label')).toBe('Chats · 1 running (top-level)');
  });

  it('collapsed: a corner badge in the icon; expanded: a number at the row end', async () => {
    const fake = fakeSeam(FIXTURE);
    mount(fake.seam);
    await waitFor(() => expect(countOf(kindButtons('task')[0]!)).toBe('2'));
    let badge = kindButtons('task')[0]!.querySelector('[data-testid="tws-rail-count"]')!;
    expect(badge.className).toBe('tws-rail-count-badge');
    expect(badge.parentElement!.className).toBe('tws-rail-icon');
    act(() => getRailStore(SPACE).getState().setExpanded(true));
    badge = kindButtons('task')[0]!.querySelector('[data-testid="tws-rail-count"]')!;
    expect(badge.className).toBe('tws-rail-count');
    expect(badge.parentElement!.tagName).toBe('BUTTON');
    expect(badge.previousElementSibling!.className).toBe('tws-rail-label');
  });

  it('hidden at 0 and 99+ above 99', async () => {
    const fake = fakeSeam(
      many(150, (i) => ({ id: `t${i}`, kind: 'task', parentId: null, category: 'in_progress' })),
      { liveEntityIds: [], liveSessionCount: 0 },
    );
    mount(fake.seam);
    await waitFor(() => expect(countOf(kindButtons('task')[0]!)).toBe('99+'));
    expect(kindButtons('work_session').map(countOf)).toEqual([null, null]);
    expect(kindButtons('chat').map(countOf)).toEqual([null, null]);
    expect(kindButtons('work_session')[0]!.getAttribute('aria-label')).toBe('Sessions');
  });

  it('updates live from an event and from a liveness push, with no polling', async () => {
    const fake = fakeSeam(FIXTURE, { liveEntityIds: ['w1'], liveSessionCount: 1 });
    mount(fake.seam);
    await waitFor(() => expect(countOf(kindButtons('task')[0]!)).toBe('2'));
    const reads = fake.query.mock.calls.length;
    /* Nothing changes without an event. */
    await new Promise((r) => setTimeout(r, 900));
    expect(fake.query.mock.calls.length).toBe(reads);
    fake.setRows([...FIXTURE, { id: 't9', kind: 'task', parentId: null, category: 'in_progress' }]);
    fake.emitEvent();
    await waitFor(() => expect(countOf(kindButtons('task')[0]!)).toBe('3'), { timeout: 3000 });
    act(() => fake.pushLiveness({ liveEntityIds: ['w1', 'w2', 'w9'], liveSessionCount: 3 }));
    expect(countOf(kindButtons('work_session')[0]!)).toBe('3');
  });

  it('draws nothing without a seam', () => {
    mount(undefined);
    expect(document.querySelectorAll('[data-testid="tws-rail-count"]')).toHaveLength(0);
  });
});

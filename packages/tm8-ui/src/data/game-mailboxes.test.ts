import { describe, expect, it, vi } from 'vitest';
import type { SpaceUnreadCounts } from '@tm8/contract';
import type { MapInput } from '../story/game/map-model';
import { applyGameMailboxCounts, createGameMailboxReader } from './game-mailboxes';

const SPACE = 'space-a';
const input: MapInput = {
  scope: { kind: 'space', id: SPACE },
  entities: [
    { id: 'root', kind: 'task', title: 'Root', spaceId: SPACE, status: 'working', mailbox: { count: 9, basis: 'messages' } },
    { id: 'shipped', kind: 'task', title: 'Shipped child', parentId: 'root', spaceId: SPACE, status: 'done', mailbox: { count: 4, basis: 'messages' } },
    { id: 'session', kind: 'work_session', title: 'Session', spaceId: SPACE, live: true, mailbox: { count: 7 } },
    { id: 'story', kind: 'story', title: 'Story', spaceId: SPACE, mailbox: { count: 3 } },
    { id: 'doc', kind: 'doc', title: 'Document', spaceId: SPACE, mailbox: { count: 8 } },
    { id: 'foreign', kind: 'task', title: 'Foreign', spaceId: 'space-b', mailbox: { count: 6 } },
  ],
  edges: [{ id: 'road', type: 'depends_on', fromId: 'root', toId: 'shipped' }],
  townPlacements: [{ entityId: 'shipped', x: 12, z: 40 }],
  taskHierarchyComplete: true,
  warnings: ['Existing relation warning'],
};
const snapshot: SpaceUnreadCounts = {
  spaceId: SPACE, complete: true,
  counts: [{ anchorId: 'root', unread: 2 }, { anchorId: 'shipped', unread: 1 },
    { anchorId: 'foreign', unread: 77 }, { anchorId: 'graph-only', unread: 10 }],
};

describe('Game mailbox read and merge', () => {
  it('joins only admitted primary anchors, including shipped children, and complete absence means zero', () => {
    const result = applyGameMailboxCounts(input, snapshot, SPACE);
    expect(result.entities.map(row => row.mailbox)).toEqual([
      { count: 2, basis: 'unread' }, { count: 1, basis: 'unread' },
      { count: 0, basis: 'unread' }, { count: 0, basis: 'unread' }, { count: 8 }, { count: 6 },
    ]);
    expect(result.entities.map(row => row.id)).toEqual(input.entities.map(row => row.id));
    expect(result.entities[0]?.status).toBe('working');
    expect(result.entities[2]?.live).toBe(true);
    expect(result.edges).toBe(input.edges);
    expect(result.townPlacements).toBe(input.townPlacements);
    expect(result.taskHierarchyComplete).toBe(true);
    expect(result.warnings).toEqual(input.warnings);
    expect(input.entities[0]?.mailbox).toEqual({ count: 9, basis: 'messages' });
  });

  it('preserves total-message fallback on unavailable/incomplete reads, with an honest warning', () => {
    for (const counts of [null, { ...snapshot, complete: false }, { ...snapshot, spaceId: 'space-b' }]) {
      const result = applyGameMailboxCounts(input, counts, SPACE);
      expect(result.entities[0]?.mailbox).toEqual({ count: 9, basis: 'messages' });
      expect(result.entities[2]?.mailbox).toEqual({ count: 7, basis: 'messages' });
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings?.[1]).toMatch(/Unread mailbox counts/);
    }
  });

  it('marks earlier unread as stale on failure and clears the warning on a complete refresh', () => {
    const loaded = applyGameMailboxCounts(input, snapshot, SPACE);
    const stale = applyGameMailboxCounts(loaded, null, SPACE);
    expect(stale.entities[0]?.mailbox).toEqual({ count: 2, basis: 'unread', approx: true });
    const refreshed = applyGameMailboxCounts(stale, { ...snapshot, counts: [] }, SPACE);
    expect(refreshed.entities[0]?.mailbox).toEqual({ count: 0, basis: 'unread' });
    expect(refreshed.warnings).toEqual(input.warnings);
  });

  it('reads once and merges into current input after status and placement changes during the request', async () => {
    let resolve!: (value: SpaceUnreadCounts) => void;
    const unreadCounts = vi.fn(() => new Promise<SpaceUnreadCounts>(done => { resolve = done; }));
    const reader = createGameMailboxReader({ unreadCounts }, SPACE);
    const pending = reader();
    const current: MapInput = { ...input,
      entities: input.entities.map(row => row.id === 'root' ? { ...row, status: 'done' } : row),
      edges: [], townPlacements: [{ entityId: 'root', x: 90, z: 120 }],
    };
    resolve(snapshot);
    const result = applyGameMailboxCounts(current, await pending, SPACE);
    expect(unreadCounts).toHaveBeenCalledExactlyOnceWith(SPACE);
    expect(result.entities[0]?.status).toBe('done');
    expect(result.edges).toBe(current.edges);
    expect(result.townPlacements).toBe(current.townPlacements);
  });

  it('returns unavailable for missing/failed/foreign-space/invalid capabilities', async () => {
    expect(await createGameMailboxReader({}, SPACE)()).toBeNull();
    expect(await createGameMailboxReader({ unreadCounts: async () => { throw new Error('501'); } }, SPACE)()).toBeNull();
    for (const result of [{ ...snapshot, spaceId: 'space-b' },
      { ...snapshot, counts: [{ anchorId: 'root', unread: -1 }] }]) {
      expect(await createGameMailboxReader({ unreadCounts: async () => result }, SPACE)()).toBeNull();
    }
  });

  it('cancels promptly and ignores a late unread reply', async () => {
    const abort = new AbortController();
    let resolve!: (value: SpaceUnreadCounts) => void;
    const reader = createGameMailboxReader({ unreadCounts: () => new Promise(done => { resolve = done; }) }, SPACE);
    const pending = reader(abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolve(snapshot);
    await expect(reader(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

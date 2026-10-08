// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameNavigationView } from '@tm8/contract';
import { DurableGameSave, type GamePersistencePort } from './durable-save';
import { enterGameMap, freshGameSave, mapKey, readGameSave, rememberGameMap, writeGameSave } from './local-save';

const SPACE = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const STORY = '00000000-0000-4000-8000-000000000003';
const initial = () => freshGameSave(SPACE, MEMBER);
const view = (save: GameNavigationView['save'] = null, revision = 0): GameNavigationView => ({ spaceId: SPACE, memberId: MEMBER, save, revision,
  repairs: { routeTruncated: false, droppedMemories: 0 } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function port(): GamePersistencePort & { load: ReturnType<typeof vi.fn<GamePersistencePort['load']>>; save: ReturnType<typeof vi.fn<GamePersistencePort['save']>> } {
  return { load: vi.fn(async () => view()), save: vi.fn(async (_space, save, revision) => view(save, revision + 1)) };
}
beforeEach(() => window.localStorage.clear());

describe('durable Game save queue', () => {
  it('bounds hydration even when a port ignores cancellation and keeps fallback without blind writes', async () => {
    vi.useFakeTimers();
    try {
      const adapter = port(); adapter.load.mockReturnValue(new Promise(() => {}));
      const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
      const loading = queue.hydrate(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await loading).toEqual(initial());
      await queue.enqueue(initial()); expect(adapter.save).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('throttles steady walking to20 server writes per minute, keeps latest poses, and flushes explicit navigation immediately', async () => {
    vi.useFakeTimers();
    try {
      const adapter = port(), queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
      await queue.hydrate(new AbortController().signal);
      await queue.enqueue(initial()); adapter.save.mockClear();
      for (let x = 1; x <= 240; x++) {
        await queue.enqueue(rememberGameMap(initial(), mapKey(initial().current), { position: { x, z: 9 } }), false, false);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(adapter.save).toHaveBeenCalledTimes(20);
      expect(adapter.save.mock.calls.at(-1)?.[1].maps[mapKey(initial().current)]?.position).toEqual({ x: 240, z: 9 });
      await queue.enqueue(enterGameMap(initial(), { type: 'office', scope: { kind: 'space', id: SPACE } }));
      expect(adapter.save).toHaveBeenCalledTimes(21);
      expect(adapter.save.mock.calls.at(-1)?.[1].current.type).toBe('office');
    } finally { vi.useRealTimers(); }
  });

  it('flushes keepalive snapshots ahead of the server cadence and cancels pending timers on account change', async () => {
    vi.useFakeTimers();
    try {
      const adapter = port(), identity = new AbortController(), queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn(), identity.signal);
      await queue.hydrate(new AbortController().signal); await queue.enqueue(initial());
      await queue.enqueue(rememberGameMap(initial(), mapKey(initial().current), { position: { x: 2, z: 3 } }), false, false);
      expect(adapter.save).toHaveBeenCalledTimes(1);
      await queue.enqueue(rememberGameMap(initial(), mapKey(initial().current), { position: { x: 4, z: 5 } }), true);
      expect(adapter.save).toHaveBeenCalledTimes(2);
      expect(adapter.save.mock.calls.at(-1)?.[3]?.keepalive).toBe(true);
      await queue.enqueue(initial(), false, false); identity.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.save).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('adopts normalized route/memory repairs but preserves navigation and pose intent created during the write', async () => {
    const adapter = port(), first = deferred<GameNavigationView>(), repaired = vi.fn();
    adapter.save.mockReturnValueOnce(first.promise);
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn(), undefined, repaired);
    await queue.hydrate(new AbortController().signal);
    const oldStory = enterGameMap(initial(), { type: 'hub', scope: { kind: 'story', id: STORY } });
    const old = rememberGameMap(oldStory, mapKey(oldStory.current), { position: { x: 1, z: 2 } });
    const saving = queue.enqueue(old);
    const next = rememberGameMap(enterGameMap(initial(), { type: 'office', scope: { kind: 'space', id: SPACE } }), mapKey(initial().current), { position: { x: 3, z: 4 } });
    void queue.enqueue({ ...next, maps: { ...old.maps, ...next.maps } });
    first.resolve(view(initial(), 1)); await saving;
    expect(adapter.save.mock.calls[1]?.[1]).toEqual(next);
    expect(repaired).toHaveBeenCalledWith(next, old);
  });
  it('uses the server save before any write and restores its route, exact poses and camera without local state', async () => {
    const remote = rememberGameMap(enterGameMap(initial(), { type: 'hub', scope: { kind: 'story', id: STORY } }),
      mapKey(initial().current), { position: { x: 7.5, z: -8.25 }, camera: { zoom: 3, position: [1, 2, 3], target: [7.5, 0, -8.25] } });
    writeGameSave(rememberGameMap(initial(), mapKey(initial().current), { position: { x: 99, z: 99 } }));
    const adapter = port(); adapter.load.mockResolvedValue(view(remote, 7));
    const pending = deferred<GameNavigationView>(); adapter.load.mockReturnValueOnce(pending.promise);
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
    const hydrating = queue.hydrate(new AbortController().signal);
    expect(adapter.save).not.toHaveBeenCalled();
    pending.resolve(view(remote, 7));
    expect(await hydrating).toEqual(remote);
    expect(readGameSave(SPACE, MEMBER)).toEqual(remote);
    await queue.enqueue(remote);
    expect(adapter.save.mock.calls[0]?.[2]).toBe(7);
  });

  it('migrates validated browser v1 state when the server explicitly returns no save', async () => {
    const local = enterGameMap(initial(), { type: 'taskland', scope: { kind: 'space', id: SPACE }, title: 'Private title' });
    writeGameSave(local);
    const adapter = port(), queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
    const restored = await queue.hydrate(new AbortController().signal);
    await queue.enqueue(restored);
    expect(adapter.save.mock.calls[0]?.[1].current.type).toBe('taskland');
    expect(JSON.stringify(adapter.save.mock.calls[0]?.[1])).not.toContain('Private title');
    expect(adapter.save.mock.calls[0]?.[2]).toBe(0);
  });

  it('serializes CAS saves and coalesces pending poses to the latest final snapshot', async () => {
    const adapter = port(), first = deferred<GameNavigationView>();
    adapter.save.mockReturnValueOnce(first.promise);
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
    await queue.hydrate(new AbortController().signal);
    const pose = (x: number) => rememberGameMap(initial(), mapKey(initial().current), { position: { x, z: 9 } });
    const saving = queue.enqueue(pose(1));
    void queue.enqueue(pose(2)); void queue.enqueue(pose(3), true);
    expect(adapter.save).toHaveBeenCalledTimes(1);
    first.resolve(view(pose(1), 1));
    await saving;
    expect(adapter.save).toHaveBeenCalledTimes(2);
    expect(adapter.save.mock.calls[1]?.[1].maps[mapKey(initial().current)]?.position).toEqual({ x: 3, z: 9 });
    expect(adapter.save.mock.calls[1]?.[2]).toBe(1);
    expect(adapter.save.mock.calls[1]?.[3]).toMatchObject({ keepalive: true });
  });

  it('never writes blindly after failed hydration, and explicit recovery first reads a revision', async () => {
    const adapter = port(), status = vi.fn(); adapter.load.mockRejectedValueOnce(new Error('Private payload'));
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, status);
    await queue.hydrate(new AbortController().signal);
    await queue.enqueue(initial(), true);
    expect(adapter.save).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('local');
    adapter.load.mockResolvedValue(view(null, 9));
    await queue.retry();
    expect(adapter.save.mock.calls[0]?.[2]).toBe(9);
    expect(status).toHaveBeenLastCalledWith('saved');
  });

  it('halts conflicts without a retry loop and preserves newer intent for an explicit save', async () => {
    const adapter = port(), status = vi.fn();
    adapter.save.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { code: 'version_conflict' }));
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, status);
    await queue.hydrate(new AbortController().signal);
    await queue.enqueue(initial());
    const next = enterGameMap(initial(), { type: 'office', scope: { kind: 'space', id: SPACE } });
    await queue.enqueue(next);
    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith('conflict');
    adapter.load.mockResolvedValue(view(null, 4));
    await queue.retry();
    expect(adapter.save).toHaveBeenCalledTimes(2);
    expect(adapter.save.mock.calls[1]?.[1]).toEqual(next);
    expect(adapter.save.mock.calls[1]?.[2]).toBe(4);
  });

  it('rejects member/space mismatches and invalid canonical saves without logging private payloads', async () => {
    for (const invalid of [ { ...view(), memberId: STORY }, { ...view(), spaceId: STORY },
      view({ ...initial(), stack: Array(65).fill(initial().current) }), view({ ...initial(), current: { ...initial().current, title: 'Private title' } } as never) ]) {
      const adapter = port(); adapter.load.mockResolvedValue(invalid);
      const status = vi.fn(), queue = new DurableGameSave(SPACE, MEMBER, adapter, status);
      expect(await queue.hydrate(new AbortController().signal)).toEqual(initial());
      await queue.enqueue(initial());
      expect(adapter.save).not.toHaveBeenCalled();
      expect(status.mock.calls.flat()).toEqual(['loading', 'local']);
    }
  });

  it('ignores late canceled hydration without altering the browser save', async () => {
    const adapter = port(), pending = deferred<GameNavigationView>(), controller = new AbortController();
    adapter.load.mockReturnValue(pending.promise);
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn());
    const hydrating = queue.hydrate(controller.signal);
    controller.abort();
    pending.resolve(view(enterGameMap(initial(), { type: 'hub', scope: { kind: 'story', id: STORY } }), 5));
    await hydrating;
    expect(readGameSave(SPACE, MEMBER)).toEqual(initial());
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it('aborts in-flight writes and discards queued writes on an identity/space change', async () => {
    const adapter = port(), pending = deferred<GameNavigationView>(), identity = new AbortController();
    adapter.save.mockReturnValueOnce(pending.promise);
    const queue = new DurableGameSave(SPACE, MEMBER, adapter, vi.fn(), identity.signal);
    await queue.hydrate(new AbortController().signal);
    const saving = queue.enqueue(initial());
    void queue.enqueue(rememberGameMap(initial(), mapKey(initial().current), { position: { x: 4, z: 5 } }));
    identity.abort();
    expect(adapter.save.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    pending.resolve(view(initial(), 1)); await saving;
    await queue.enqueue(initial(), true); await queue.retry();
    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });
});

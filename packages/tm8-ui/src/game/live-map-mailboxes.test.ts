// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceUnreadCounts } from '@tm8/contract';
import type { MapInput } from '../story/game/map-model';
import type { GameMailboxReader } from '../data/game-mailboxes';
import type { GameMapEvents } from './types';
import type { GameMapEvent } from './live-map-events';
import { createLiveMailboxController } from './live-map-mailboxes';

const counts = (unread: number): SpaceUnreadCounts => ({ spaceId: 'space', complete: true, counts: [{ anchorId: 'task', unread }] }) as SpaceUnreadCounts;
const visits: { dispose(): void }[] = [];
function harness(reader = vi.fn<GameMailboxReader>(async () => counts(4))) {
  let input: MapInput = { scope: { kind: 'space', id: 'space' }, entities: [
    { id: 'task', kind: 'task', title: 'Build', status: 'working', mailbox: { count: 5, basis: 'unread' } },
  ], edges: [{ id: 'claim', fromId: 'session', toId: 'task', type: 'working_on' }], townPlacements: [] };
  const locals = new Set<(id: string) => void>(), events = new Set<(event: GameMapEvent) => void>();
  reader.onInvalidated = callback => { locals.add(callback); return () => { locals.delete(callback); }; };
  const update = vi.fn((next: MapInput) => { input = next; });
  const port = { onEvent(callback: (event: GameMapEvent) => void) { events.add(callback); return () => { events.delete(callback); }; } } as GameMapEvents;
  const controller = createLiveMailboxController({ spaceId: 'space', reader, events: port, current: () => input, update });
  visits.push(controller);
  let seq = 0;
  const emit = (body: object, over: object = {}) => events.forEach(callback => callback({ spaceId: 'space', seq: ++seq, ...body, ...over } as GameMapEvent));
  return { controller, reader, update, emit, current: () => input, set: (next: MapInput) => { input = next; }, locals, events,
    invalidate: (id = 'task') => locals.forEach(callback => callback(id)) };
}
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { visits.splice(0).forEach(visit => visit.dispose()); vi.useRealTimers(); });

describe('current-visit mailbox refresh', () => {
  it('uses loader counts initially and refreshes remote read marks at 15 seconds without a map read', async () => {
    const h = harness(); h.controller.attach();
    await vi.advanceTimersByTimeAsync(14_999); expect(h.reader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await vi.advanceTimersByTimeAsync(0);
    expect(h.reader).toHaveBeenCalledTimes(1); expect(h.current().entities[0]!.mailbox).toEqual({ count: 4, basis: 'unread' });
    await vi.advanceTimersByTimeAsync(15_000); await vi.advanceTimersByTimeAsync(0); expect(h.reader).toHaveBeenCalledTimes(2);
    h.controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes successful local read marks immediately and coalesces message/notification bursts', async () => {
    const h = harness(); h.controller.attach(); h.invalidate();
    h.emit({ type: 'message.created', anchorId: 'task' }); h.emit({ type: 'message.updated', anchorId: 'task' });
    h.emit({ type: 'notification.read', notification: {} }); h.emit({ type: 'counter.changed', entityId: 'task' });
    await vi.advanceTimersByTimeAsync(0); expect(h.reader).toHaveBeenCalledTimes(1);
    h.invalidate('outsider'); h.emit({ type: 'message.created', anchorId: 'outsider' });
    h.emit({ type: 'message.created', anchorId: 'task' }, { spaceId: 'foreign' });
    h.emit({ type: 'entity.seen', entityId: 'task' });
    await vi.advanceTimersByTimeAsync(0); expect(h.reader).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('merges a delayed count into the latest status, edges and placements', async () => {
    let resolve!: (value: SpaceUnreadCounts) => void;
    const h = harness(vi.fn(() => new Promise<SpaceUnreadCounts>(yes => { resolve = yes; }))); h.controller.attach();
    h.invalidate(); await vi.advanceTimersByTimeAsync(0);
    const current = { ...h.current(), entities: h.current().entities.map(row => ({ ...row, status: 'blocked' })),
      edges: [], townPlacements: [{ entityId: 'task', x: 100, z: 40 }] } as MapInput;
    h.set(current); resolve(counts(2)); await vi.advanceTimersByTimeAsync(0);
    expect(h.current().entities[0]).toMatchObject({ status: 'blocked', mailbox: { count: 2, basis: 'unread' } });
    expect(h.current().edges).toBe(current.edges); expect(h.current().townPlacements).toBe(current.townPlacements);
    h.controller.dispose();
  });
  it('aborts old requests and ignores their late responses after a newer read', async () => {
    const pending: { resolve(value: SpaceUnreadCounts): void; signal?: AbortSignal }[] = [];
    const h = harness(vi.fn(signal => new Promise<SpaceUnreadCounts>(resolve => { pending.push({ resolve, signal }); })));
    h.controller.attach(); h.invalidate(); await vi.advanceTimersByTimeAsync(0);
    h.invalidate(); h.emit({ type: 'message.deleted', anchorId: 'task' }); await vi.advanceTimersByTimeAsync(0);
    expect(h.reader).toHaveBeenCalledTimes(2); expect(pending[0]!.signal!.aborted).toBe(true);
    pending[1]!.resolve(counts(1)); await vi.advanceTimersByTimeAsync(0);
    pending[0]!.resolve(counts(99)); await vi.advanceTimersByTimeAsync(0);
    expect(h.current().entities[0]!.mailbox!.count).toBe(1); expect(h.update).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it('pauses hidden maps, resumes on visibility/focus and disposes local/event listeners', async () => {
    const h = harness(); h.controller.attach();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    h.invalidate(); await vi.advanceTimersByTimeAsync(30_000); expect(h.reader).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); expect(h.reader).toHaveBeenCalledTimes(1);
    h.controller.dispose(); expect(h.locals.size).toBe(0); expect(h.events.size).toBe(0);
    h.invalidate(); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.reader).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts a request on disposal/map change and does not update the old input', async () => {
    let resolve!: (value: SpaceUnreadCounts) => void, signal: AbortSignal | undefined;
    const h = harness(vi.fn(currentSignal => { signal = currentSignal; return new Promise<SpaceUnreadCounts>(yes => { resolve = yes; }); }));
    h.controller.attach(); h.invalidate(); await vi.advanceTimersByTimeAsync(0); h.controller.dispose();
    expect(signal!.aborted).toBe(true); resolve(counts(9)); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.update).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not run a cadence without admitted mailbox anchors', async () => {
    const h = harness(); h.set({ entities: [{ id: 'asset', kind: 'asset', title: 'Texture' }], edges: [] });
    h.controller.attach(); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.reader).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); h.controller.dispose();
  });
});

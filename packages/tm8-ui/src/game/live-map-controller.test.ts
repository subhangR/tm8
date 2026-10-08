import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import type { MapScope } from '../story/game/map-model';
import { createLiveMapController, type LiveMapSnapshot } from './live-map-controller';
import type { GameMapEvents, GameMapLoader, GameMapResult } from './types';
import type { GameMapEvent } from './live-map-events';

const scope: MapScope = { kind: 'space', id: 'space' };
function result(selected = scope): GameMapResult {
  return { title: 'Space', input: { scope: selected, entities: [
    { id: 'task', kind: 'task', title: 'Build', status: 'working', progress: .2 },
    { id: 'other', kind: 'task', title: 'Other', status: 'working' },
    { id: 'session', kind: 'work_session', title: 'Juniper', status: 'running', processState: 'running', outcome: 'open', live: true },
  ], edges: [{ id: 'claim', type: 'working_on', fromId: 'session', toId: 'task', status: 'working', endedAt: null }] } };
}
function row(id: string, kind = 'task', state: Record<string, unknown> = {}): EntitySummary {
  return { id, kind, spaceId: 'space', title: id, parentId: null, category: 'in_progress', counters: { messages: 0 }, badges: {},
    state: { kind, status: kind === 'task' ? 'working' : 'running', ...state } } as unknown as EntitySummary;
}
function harness(selected = scope, loadMap: GameMapLoader = vi.fn(async () => result(selected))) {
  const subs = new Set<(event: GameMapEvent) => void>();
  const resync = new Set<(id: string) => void>();
  const live = new Set<() => void>();
  let seq = 0, alive = true;
  const port = { onEvent(cb: (event: GameMapEvent) => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    onResync(cb: (id: string) => void) { resync.add(cb); return () => { resync.delete(cb); }; },
    liveness: { statusOf: () => alive ? 'live' : 'stale', onChange(cb: () => void) { live.add(cb); return () => { live.delete(cb); }; } },
  } as unknown as GameMapEvents;
  const snapshots: LiveMapSnapshot[] = [], errors: unknown[] = [];
  const controller = createLiveMapController({ spaceId: 'space', scope: selected, type: 'taskland', loadMap, events: port,
    onSnapshot: snapshot => snapshots.push(snapshot), onError: error => errors.push(error) });
  const emit = (body: object, over: object = {}) => {
    const event = { spaceId: 'space', seq: ++seq, occurredAt: new Date().toISOString(), schemaVersion: 1, ...body, ...over } as GameMapEvent;
    subs.forEach(cb => cb(event)); return event;
  };
  return { controller, emit, loadMap, snapshots, errors, subs,
    resync: (id = 'space') => resync.forEach(cb => cb(id)),
    liveness: (value: boolean) => { alive = value; live.forEach(cb => cb()); },
    boot: async () => { controller.attach(); await vi.advanceTimersByTimeAsync(0); },
  };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
describe('authoritative live map controller', () => {
  it('folds claim start/move/stop in space and story maps without another read', async () => {
    for (const selected of [scope, { kind: 'story', id: 'story' } as const]) {
      const h = harness(selected); await h.boot();
      const original = h.controller.getSnapshot()!.model;
      expect(original.robots).toHaveLength(1);
      const source = row('session', 'work_session', { outcome: 'open' });
      const target = row('other');
      h.emit({ type: 'edge.upsert', edge: { id: 'claim', type: 'working_on', source, target, props: { status: 'working' } } });
      expect(h.controller.getSnapshot()!.model.robots[0]).toMatchObject({ id: 'robot:claim', taskId: 'other' });
      expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')).toMatchObject({ x: original.places.find(place => place.id === 'task')!.x });
      h.emit({ type: 'edge.upsert', edge: { id: 'second', type: 'working_on', source, target: row('task'), props: { status: 'blocked' } } });
      expect(h.controller.getSnapshot()!.model.robots).toHaveLength(2);
      h.emit({ type: 'edge.ended', edgeId: 'claim', edgeType: 'working_on', sourceId: 'session', targetId: 'other', endedAt: 'now', endReason: 'released' });
      expect(h.controller.getSnapshot()!.model.robots.map(robot => robot.id)).toEqual(['robot:second']);
      expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
    }
  });
  it('ignores other spaces, unrelated story entities, duplicates and stale sequences', async () => {
    const h = harness({ kind: 'story', id: 'story' }); await h.boot();
    h.emit({ type: 'entity.upsert', entity: row('outsider') });
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'Foreign' } }, { spaceId: 'foreign' });
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'New' } }, { seq: 10 });
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'Old' } }, { seq: 9 });
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('New');
    expect(h.controller.getSnapshot()!.model.places.some(place => place.id === 'outsider')).toBe(false);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('replays events arriving during an initial or recovery read', async () => {
    let resolve!: (result: GameMapResult) => void;
    const loader = vi.fn<GameMapLoader>(() => new Promise(yes => { resolve = yes; }));
    const h = harness(scope, loader); h.controller.attach();
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'During initial' } });
    resolve(result()); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('During initial');
    h.resync(); await vi.advanceTimersByTimeAsync(250);
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'During recovery' } });
    resolve(result()); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('During recovery');
    h.controller.dispose();
  });
  it('applies state immediately while combining >5 relevant events in 60 seconds', async () => {
    const h = harness(); await h.boot();
    for (let n = 0; n < 8; n++) h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: `Update ${n}` } });
    expect(h.snapshots.at(-1)!.model.places.find(place => place.id === 'task')!.title).toBe('Update 7');
    expect(h.controller.getSnapshot()!.effect).toBeNull();
    await vi.advanceTimersByTimeAsync(80);
    const effect = h.controller.getSnapshot()!.effect!;
    expect(effect).toMatchObject({ combined: true, count: 8 });
    h.emit({ type: 'task.criterion_changed', taskId: 'task', criterionId: 'ac1', criterionText: 'Built', isDone: true, done: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.effect).toMatchObject({ id: effect.id, combined: true, count: 9, taskEvents: [expect.objectContaining({ criterionId: 'ac1', done: 1, total: 3 })] });
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.progress).toBeNull(); // full upsert has no weighted progress
    await vi.advanceTimersByTimeAsync(60_000);
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'blocked' });
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.status).toBe('blocked');
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.effect).toMatchObject({ combined: false, count: 1 });
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('preserves completion departure when edge upsert precedes edge.ended and session outcome', async () => {
    const h = harness(); await h.boot();
    h.emit({ type: 'edge.upsert', edge: { id: 'claim', type: 'working_on', source: row('session', 'work_session', { outcome: 'completed' }), target: row('task'), props: { endedAt: 'now', status: 'working' } } });
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    h.emit({ type: 'edge.ended', edgeId: 'claim', edgeType: 'working_on', sourceId: 'session', targetId: 'task', endedAt: 'now', endReason: 'session_completed' });
    h.emit({ type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: 'completed' });
    expect(h.controller.getSnapshot()!.departures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(0); h.controller.dispose();
  });
  it.each(['stopped', 'failed', 'exited'] as const)('removes %s workers with no completed departure', async state => {
    const h = harness(); await h.boot();
    h.emit(state === 'stopped' ? { type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: state }
      : { type: 'session.process_changed', sessionId: 'session', from: 'running', to: state });
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(0); h.controller.dispose();
  });
  it('follows process idle, attention and authoritative liveness without requery', async () => {
    const h = harness(); await h.boot();
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' });
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('idle');
    h.emit({ type: 'entity.upsert', entity: { ...row('session', 'work_session', { status: 'idle', outcome: 'open' }), badges: { attention: { pendingCount: 1 } } } });
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('attention');
    h.liveness(false); await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('coalesces membership fallback/resync and preserves a good map after a refresh failure', async () => {
    const loader = vi.fn<GameMapLoader>(async () => result({ kind: 'story', id: 'story' }));
    const h = harness({ kind: 'story', id: 'story' }, loader); await h.boot();
    loader.mockRejectedValueOnce(new Error('offline'));
    h.resync('foreign'); h.resync(); h.resync();
    h.emit({ type: 'edge.upsert', edge: { id: 'membership', type: 'produces', source: row('task'), target: row('new-doc', 'doc'), props: {} } });
    await vi.advanceTimersByTimeAsync(250);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(h.snapshots.at(-1)!.error?.message).toBe('offline');
    expect(h.snapshots.at(-1)!.model.places).toHaveLength(2); h.controller.dispose();
  });
  it('aborts pending reads, queued effects and stale subscriber callbacks on disposal', async () => {
    let resolve!: (result: GameMapResult) => void, signal: AbortSignal | undefined;
    const h = harness(scope, (_scope, value) => { signal = value; return new Promise(yes => { resolve = yes; }); });
    h.controller.attach();
    const late = [...h.subs][0]!;
    h.controller.dispose();
    expect(signal!.aborted).toBe(true);
    resolve(result()); late({ spaceId: 'space', seq: 99, type: 'entity.upsert', entity: row('task') } as GameMapEvent);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.snapshots).toHaveLength(0); expect(h.subs.size).toBe(0);
  });
});

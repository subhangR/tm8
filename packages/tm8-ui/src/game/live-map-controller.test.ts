import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import type { MapScope } from '../story/game/map-model';
import { createLiveMapController, type LiveMapSnapshot } from './live-map-controller';
import type { GameMapEvents, GameMapLoader, GameMapResult } from './types';
import type { GameMapEvent } from './live-map-events';
import type { GameMailboxReader } from '../data/game-mailboxes';
import { emptyTasklandMotion, reconcileTasklandMotion } from '../story/game/taskland-motion';

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
function harness(selected = scope, loadMap: GameMapLoader = vi.fn(async () => result(selected)), mailboxes?: GameMailboxReader) {
  const subs = new Set<(event: GameMapEvent) => void>();
  const resync = new Set<(id: string) => void>();
  const live = new Set<() => void>();
  let seq = 0, alive: boolean | 'unknown' = true;
  const port = { onEvent(cb: (event: GameMapEvent) => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    onResync(cb: (id: string) => void) { resync.add(cb); return () => { resync.delete(cb); }; },
    liveness: { statusOf: () => alive === 'unknown' ? 'unknown' : alive ? 'live' : 'stale', onChange(cb: () => void) { live.add(cb); return () => { live.delete(cb); }; } },
  } as unknown as GameMapEvents;
  const snapshots: LiveMapSnapshot[] = [], errors: unknown[] = [];
  const controller = createLiveMapController({ spaceId: 'space', scope: selected, type: 'taskland', loadMap, events: port, mailboxes,
    onSnapshot: snapshot => snapshots.push(snapshot), onError: error => errors.push(error) });
  const emit = (body: object, over: object = {}) => {
    const event = { spaceId: 'space', seq: ++seq, occurredAt: new Date().toISOString(), schemaVersion: 1, ...body, ...over } as GameMapEvent;
    subs.forEach(cb => cb(event)); return event;
  };
  return { controller, emit, loadMap, snapshots, errors, subs,
    resync: (id = 'space') => resync.forEach(cb => cb(id)),
    liveness: (value: boolean | 'unknown') => { alive = value; live.forEach(cb => cb()); },
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
      await vi.advanceTimersByTimeAsync(80);
      expect(h.controller.getSnapshot()!.model.robots[0]).toMatchObject({ id: 'robot:claim', taskId: 'other' });
      expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')).toMatchObject({ x: original.places.find(place => place.id === 'task')!.x });
      h.emit({ type: 'edge.upsert', edge: { id: 'second', type: 'working_on', source, target: row('task'), props: { status: 'blocked' } } });
      await vi.advanceTimersByTimeAsync(80);
      expect(h.controller.getSnapshot()!.model.robots).toHaveLength(2);
      h.emit({ type: 'edge.ended', edgeId: 'claim', edgeType: 'working_on', sourceId: 'session', targetId: 'other', endedAt: 'now', endReason: 'released' });
      await vi.advanceTimersByTimeAsync(80);
      expect(h.controller.getSnapshot()!.model.robots.map(robot => robot.id)).toEqual(['robot:second']);
      expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
    }
  });
  it('ignores other spaces, unrelated story entities, duplicates and stale sequences', async () => {
    const h = harness({ kind: 'story', id: 'story' }); await h.boot();
    h.emit({ type: 'entity.upsert', entity: row('outsider') });
    await vi.advanceTimersByTimeAsync(80);
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'Foreign' } }, { spaceId: 'foreign' });
    await vi.advanceTimersByTimeAsync(80);
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'New' } }, { seq: 10 });
    await vi.advanceTimersByTimeAsync(80);
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'Old' } }, { seq: 9 });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('New');
    expect(h.controller.getSnapshot()!.model.places.some(place => place.id === 'outsider')).toBe(false);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('replays events arriving during an initial or recovery read', async () => {
    let resolve!: (result: GameMapResult) => void;
    const loader = vi.fn<GameMapLoader>(() => new Promise(yes => { resolve = yes; }));
    const h = harness(scope, loader); h.controller.attach();
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'During initial' } });
    await vi.advanceTimersByTimeAsync(80);
    resolve(result()); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('During initial');
    h.resync(); await vi.advanceTimersByTimeAsync(250);
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'During recovery' } });
    await vi.advanceTimersByTimeAsync(80);
    resolve(result()); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('During recovery');
    h.controller.dispose();
  });
  it('applies state immediately while combining >5 relevant events in 60 seconds', async () => {
    const h = harness(); await h.boot();
    for (let n = 0; n < 8; n++) h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: `Update ${n}` } });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.title).toBe('Update 7');
    expect(h.snapshots.at(-1)!.model.places.find(place => place.id === 'task')!.title).toBe('Build');
    expect(h.controller.getSnapshot()!.effect).toBeNull();
    await vi.advanceTimersByTimeAsync(80);
    const effect = h.controller.getSnapshot()!.effect!;
    expect(effect).toMatchObject({ combined: true, count: 8 });
    h.emit({ type: 'task.criterion_changed', taskId: 'task', criterionId: 'ac1', criterionText: 'Built', isDone: true, done: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.effect).toMatchObject({ id: effect.id, combined: true, count: 9, taskEvents: [expect.objectContaining({ criterionId: 'ac1', done: 1, total: 3 })] });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.progress).toBeNull(); // full upsert has no weighted progress
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.acceptance).toEqual({ completed: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'blocked' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.status).toBe('blocked');
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.effect).toMatchObject({ combined: false, count: 1 });
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('preserves completion departure when edge upsert precedes edge.ended and session outcome', async () => {
    const h = harness(); await h.boot();
    h.emit({ type: 'edge.upsert', edge: { id: 'claim', type: 'working_on', source: row('session', 'work_session', { outcome: 'completed' }), target: row('task'), props: { endedAt: 'now', status: 'working' } } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    h.emit({ type: 'edge.ended', edgeId: 'claim', edgeType: 'working_on', sourceId: 'session', targetId: 'task', endedAt: 'now', endReason: 'session_completed' });
    await vi.advanceTimersByTimeAsync(80);
    h.emit({ type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: 'completed' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(0); h.controller.dispose();
  });
  it.each(['stopped', 'failed', 'exited'] as const)('removes %s workers with no completed departure', async state => {
    const h = harness(); await h.boot();
    h.emit(state === 'stopped' ? { type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: state }
      : { type: 'session.process_changed', sessionId: 'session', from: 'running', to: state });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(0); h.controller.dispose();
  });
  it('follows process idle, attention and authoritative liveness without requery', async () => {
    const h = harness(); await h.boot();
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('idle');
    h.emit({ type: 'entity.upsert', entity: { ...row('session', 'work_session', { status: 'idle', outcome: 'open' }), badges: { attention: { pendingCount: 1 } } } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('attention');
    h.liveness(false); await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('admits story claim sessions without storyIds, rejects foreign peers and reuses a reopened edge', async () => {
    const selected = { kind: 'story', id: 'story' } as const;
    const data = result(selected);
    data.input = { ...data.input, entities: data.input.entities.filter(entity => entity.kind !== 'work_session'), edges: [] };
    const h = harness(selected, vi.fn(async () => data)); await h.boot();
    const edge = { id: 'new-claim', type: 'working_on', source: row('new-session', 'work_session', { outcome: 'open' }), target: row('task'), props: { status: 'working', endedAt: null } };
    h.emit({ type: 'edge.upsert', edge: { ...edge, source: { ...edge.source, spaceId: 'foreign' } } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    h.emit({ type: 'edge.upsert', edge });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]).toMatchObject({ id: 'robot:new-claim', sessionId: 'new-session' });
    h.emit({ type: 'session.outcome_changed', sessionId: 'new-session', from: 'open', to: 'completed' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.departures).toHaveLength(1);
    h.emit({ type: 'session.outcome_changed', sessionId: 'new-session', from: 'completed', to: 'open' });
    await vi.advanceTimersByTimeAsync(80);
    h.emit({ type: 'edge.upsert', edge });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.id).toBe('robot:new-claim');
    expect(h.controller.getSnapshot()!.departures).toHaveLength(0);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('coalesces membership fallback/resync and preserves a good map after a refresh failure', async () => {
    const loader = vi.fn<GameMapLoader>(async () => result({ kind: 'story', id: 'story' }));
    const h = harness({ kind: 'story', id: 'story' }, loader); await h.boot();
    loader.mockRejectedValueOnce(new Error('offline'));
    h.resync('foreign'); h.resync(); h.resync();
    h.emit({ type: 'edge.upsert', edge: { id: 'membership', type: 'produces', source: row('task'), target: row('new-doc', 'doc'), props: {} } });
    await vi.advanceTimersByTimeAsync(80);
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
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps v3 hydration when replay contains an older v2 entity and endpoint', async () => {
    let resolve!: (result: GameMapResult) => void;
    const h = harness(scope, () => new Promise(yes => { resolve = yes; })); h.controller.attach();
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), version: 2, title: 'Stale v2' } });
    h.emit({ type: 'edge.upsert', edge: { id: 'claim', type: 'working_on', source: row('session', 'work_session', { outcome: 'open' }), target: { ...row('task'), version: 2, title: 'Stale endpoint' }, props: { status: 'working' } } });
    const loaded = result(); loaded.input = { ...loaded.input, entities: loaded.input.entities.map(entity => entity.id === 'task' ? { ...entity, version: 3, title: 'Fresh v3' } : entity) };
    resolve(loaded); await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('Fresh v3');
    h.controller.dispose();
  });
  it('reduces 50 updates on 200 tasks immediately, publishes once and keeps all unaffected layout coordinates', async () => {
    const loaded = result(); loaded.input = { ...loaded.input, entities: [...loaded.input.entities, ...Array.from({ length: 198 }, (_, id) => ({ id: `task-${id}`, kind: 'task', title: `Task ${id}`, status: 'working' }))] };
    const h = harness(scope, vi.fn(async () => loaded)); await h.boot();
    const before = h.controller.getSnapshot()!.model, count = h.snapshots.length;
    for (let id = 0; id < 50; id++) h.emit({ type: 'entity.upsert', entity: { ...row(`task-${id}`), title: `Updated ${id}` } });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task-49')!.title).toBe('Updated 49');
    expect(h.snapshots).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(80);
    expect(h.snapshots).toHaveLength(count + 1);
    for (const place of before.places) expect(h.controller.getSnapshot()!.model.places.find(row => row.id === place.id)).toMatchObject({ x: place.x, z: place.z });
    expect(h.controller.getSnapshot()!.model.places).toHaveLength(200);
    expect(h.loadMap).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it('keeps cold unknown liveness consistent with the first session process event', async () => {
    const data = result(); data.input = { ...data.input, entities: data.input.entities.map(row => row.kind === 'work_session' ? { ...row, live: false } : row) };
    const h = harness(scope, vi.fn(async () => data)); h.liveness('unknown'); await h.boot();
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(1);
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('idle'); h.controller.dispose();
  });
  it('keeps loaded primary rows above 200, filters unrelated kinds and bounds only new admissions', async () => {
    const data = result(); data.input = { ...data.input, entities: [...data.input.entities, ...Array.from({ length: 300 }, (_, id) => ({ id: `old-${id}`, kind: 'task', title: `Old ${id}`, status: 'working' }))] };
    const h = harness(scope, vi.fn(async () => data)); await h.boot();
    h.emit({ type: 'entity.upsert', entity: row('foreign-kind', 'doc') });
    for (let id = 0; id < 201; id++) h.emit({ type: 'entity.upsert', entity: row(`new-${id}`) });
    expect(h.controller.getSnapshot()!.result.input.entities).toHaveLength(data.input.entities.length + 200);
    expect(h.controller.getSnapshot()!.result.input.entities.some(row => row.id === 'foreign-kind')).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.loadMap).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()!.model.places).toHaveLength(302);
    h.controller.dispose();
  });
  it.each(['semantic-first', 'summary-first'])('updates criterion construction and count edits in %s order', async order => {
    const h = harness(); await h.boot();
    const semantic = { type: 'task.criterion_changed', taskId: 'task', criterionId: 'ac2', criterionText: 'Two done', isDone: true, done: 2, total: 3 };
    const summary = { type: 'entity.upsert', entity: row('task', 'task', { acceptance: { completed: 2, total: 3 } }) };
    for (const body of order === 'semantic-first' ? [semantic, summary] : [summary, semantic]) h.emit(body);
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.acceptance).toEqual({ completed: 2, total: 3 });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.progress).toBeCloseTo(2 / 3);
    h.emit({ type: 'entity.upsert', entity: row('task', 'task', { acceptance: { completed: 1, total: 2 } }) });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.progress).toBe(.5);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('uses committed cancellation time, preserves exact DTO time and expires rubble without another event/read', async () => {
    const h = harness(); await h.boot();
    const committed = new Date(Date.now()).toISOString();
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'cancelled' }, { occurredAt: committed });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')).toMatchObject({ constructionStage: 'rubble', cancelledAt: committed });
    const exact = new Date(Date.now() - 20).toISOString();
    h.emit({ type: 'entity.upsert', entity: row('task', 'task', { status: 'cancelled', statusChangedAt: exact }) });
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'cancelled' }, { occurredAt: committed });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.cancelledAt).toBe(exact);
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.terminalFromStatus).toBe('working');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(h.controller.getSnapshot()!.model.places.some(place => place.id === 'task')).toBe(false);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('applies live edge/session deltas by seq even when transaction timestamps precede loaded updatedAt', async () => {
    const data = result(); data.input = { ...data.input,
      entities: data.input.entities.map(row => ({ ...row, updatedAt: '2026-10-09T00:00:00Z', version: 3 })),
      edges: data.input.edges.map(edge => ({ ...edge, updatedAt: '2026-10-09T00:00:00Z' })) };
    const h = harness(scope, vi.fn(async () => data)); await h.boot();
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' }, { occurredAt: '2026-10-08T00:00:00Z' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('idle');
    h.emit({ type: 'edge.ended', edgeId: 'claim', edgeType: 'working_on', sourceId: 'session', targetId: 'task', endedAt: '2026-10-08T00:00:00Z', endReason: 'released' }, { occurredAt: '2026-10-08T00:00:00Z' });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots).toHaveLength(0);
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('repairs ambiguous read replay once and bounds concurrent-write recovery without a requery loop', async () => {
    const resolvers: ((value: GameMapResult) => void)[] = [];
    const loader = vi.fn<GameMapLoader>(() => new Promise(resolve => resolvers.push(resolve)));
    const h = harness(scope, loader); h.controller.attach();
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' });
    resolvers.shift()!(result()); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('working');
    await vi.advanceTimersByTimeAsync(250); expect(loader).toHaveBeenCalledTimes(2);
    h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' });
    resolvers.shift()!(result()); await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]!.pose).toBe('idle');
    await vi.advanceTimersByTimeAsync(1_000); expect(loader).toHaveBeenCalledTimes(2);
    h.controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains newer endpoint versions while applying live edge changes and requesting scoped repair', async () => {
    const data = result(); data.input = { ...data.input, entities: data.input.entities.map(row => ({ ...row, version: 3 })) };
    const h = harness(scope, vi.fn(async () => data)); await h.boot();
    h.emit({ type: 'edge.upsert', edge: { id: 'claim', type: 'working_on', source: { ...row('session', 'work_session', { outcome: 'completed' }), version: 2 },
      target: { ...row('other'), version: 2, title: 'Old endpoint' }, props: { status: 'blocked' } } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.robots[0]).toMatchObject({ taskId: 'other', pose: 'blocked' });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'session')!.outcome).toBe('open');
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'other')!.title).toBe('Other');
    await vi.advanceTimersByTimeAsync(170); expect(h.loadMap).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });
  it('does not use timestamps when an entity version is absent', async () => {
    const data = result(); data.input = { ...data.input, entities: data.input.entities.map(row => ({ ...row, version: 3, updatedAt: '2026-10-09T00:00:00Z' })) };
    const h = harness(scope, vi.fn(async () => data)); await h.boot();
    h.emit({ type: 'entity.upsert', entity: { ...row('task'), title: 'Sequence update', updatedAt: '2026-10-08T00:00:00Z' } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.title).toBe('Sequence update');
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('combines more than five status effects per minute while reducing every final status immediately', async () => {
    const h = harness(); await h.boot();
    for (let n = 0; n < 8; n++) h.emit({ type: 'task.status_changed', taskId: 'task', from: n % 2 ? 'blocked' : 'working', to: n % 2 ? 'working' : 'blocked' });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.status).toBe('working');
    await vi.advanceTimersByTimeAsync(80); const effect = h.controller.getSnapshot()!.effect!;
    expect(effect).toMatchObject({ combined: true, count: 8 }); expect(effect.taskEvents).toHaveLength(8);
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'blocked' });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.status).toBe('blocked');
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.effect).toMatchObject({ id: effect.id, combined: true, count: 9 });
    expect(h.controller.getSnapshot()!.model.places.find(place => place.id === 'task')!.status).toBe('blocked');
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it('retains explicit legacy cancellation evidence through count/title edits, but clears it on reopen and exact recancellation', async () => {
    const data = result(); data.input = { ...data.input, entities: data.input.entities.map(row => row.id === 'task' ? { ...row, status: 'cancelled', cancelledAt: null, cancelledNotAfter: '2026-10-08T00:00:00Z' } : row) };
    const h = harness(scope, vi.fn(async () => data)); await h.boot();
    h.emit({ type: 'entity.upsert', entity: { ...row('task', 'task', { status: 'cancelled' }), title: 'Edited', category: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')).toMatchObject({ cancelledAt: null, cancelledNotAfter: '2026-10-08T00:00:00Z' });
    h.emit({ type: 'task.criterion_changed', taskId: 'task', criterionId: 'ac1', criterionText: 'Changed', isDone: true, done: 1, total: 2 });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')!.cancelledNotAfter).toBe('2026-10-08T00:00:00Z');
    // A reconnect can hide reopen/recancel. Its exact stamped summary must clear
    // the prior episode's bound even though both visible rows are cancelled.
    h.emit({ type: 'entity.upsert', entity: { ...row('task', 'task', { status: 'cancelled', statusChangedAt: '2026-10-08T12:00:00Z' }), category: 'cancelled' } });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')).toMatchObject({ cancelledAt: '2026-10-08T12:00:00Z', cancelledNotAfter: null });
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'cancelled', to: 'working' });
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')).toMatchObject({ cancelledAt: null, cancelledNotAfter: null });
    h.emit({ type: 'entity.upsert', entity: { ...row('task', 'task', { status: 'cancelled', statusChangedAt: '2026-10-09T01:00:00Z' }), category: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(80);
    expect(h.controller.getSnapshot()!.result.input.entities.find(row => row.id === 'task')).toMatchObject({ cancelledAt: '2026-10-09T01:00:00Z', cancelledNotAfter: null });
    h.controller.dispose();
  });
  it('publishes motion facts atomically with post-fact geometry and resets the handoff on recovery', async () => {
    let resolve!: (value: GameMapResult) => void;
    const loader = vi.fn<GameMapLoader>(async () => result());
    const h = harness(scope, loader); await h.boot();
    const initial = h.snapshots.at(-1)!;
    const event = h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'blocked' });
    // Records reduce immediately; subscribers receive geometry and facts together.
    expect(h.snapshots.at(-1)).toBe(initial);
    await vi.advanceTimersByTimeAsync(80);
    const moved = h.snapshots.at(-1)!;
    expect(moved.previousModel).toBe(initial.model);
    expect(moved.model.places.find(place => place.id === 'task')!.status).toBe('blocked');
    expect(moved.effect!.taskEvents).toEqual([event]);
    let motion = reconcileTasklandMotion(emptyTasklandMotion(initial), moved, 0);
    expect(motion.transitions).toEqual([expect.objectContaining({ entityId: 'task', kind: 'move' })]);
    for (let n = 0; n < 6; n++) h.emit({ type: 'task.status_changed', taskId: 'task', from: n % 2 ? 'working' : 'blocked', to: n % 2 ? 'blocked' : 'working' });
    await vi.advanceTimersByTimeAsync(80);
    const burst = h.snapshots.at(-1)!;
    expect(burst.previousModel).toBe(moved.model);
    expect(burst.model.places.find(place => place.id === 'task')!.status).toBe('blocked');
    expect(burst.effect!.taskEvents.at(-1)).toMatchObject({ type: 'task.status_changed', to: 'blocked' });
    expect(burst.effect).toMatchObject({ combined: true, count: 7 });
    motion = reconcileTasklandMotion(motion, burst, 100);
    expect(motion.lastTaskSeq).toBe(burst.effect!.taskEvents.at(-1)!.seq);
    loader.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    h.resync(); await vi.advanceTimersByTimeAsync(250);
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'blocked', to: 'review' });
    // Resolve before the live publish: the read can still contain the older status.
    resolve(result()); await vi.advanceTimersByTimeAsync(0);
    const recovery = h.snapshots.at(-1)!;
    expect(recovery.previousModel).toBeNull(); expect(recovery.effect).toBeNull();
    expect(reconcileTasklandMotion(motion, recovery, 200).transitions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(80);
    expect(h.snapshots.at(-1)!.effect).toBeNull();
    // One authoritative repair is scheduled for the ambiguous replay, with no
    // historical fact delivered against the recovered geometry.
    await vi.advanceTimersByTimeAsync(170); expect(loader).toHaveBeenCalledTimes(3);
    expect(h.snapshots.at(-1)!.effect).toBeNull();
    h.controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('joins delayed unread counts through the live controller without rolling back status, worker, or layout', async () => {
    let resolve!: (value: import('@tm8/contract').SpaceUnreadCounts) => void, invalidated!: (id: string) => void;
    const read: GameMailboxReader = vi.fn(() => new Promise(yes => { resolve = yes; }));
    read.onInvalidated = callback => { invalidated = callback; return () => {}; };
    const data = result(); data.input = { ...data.input, entities: data.input.entities.map(row => ({ ...row, mailbox: { count: 5, basis: 'unread' as const } })) };
    const h = harness(scope, vi.fn(async () => data), read); await h.boot(); const before = h.controller.getSnapshot()!.model;
    invalidated('task'); await vi.advanceTimersByTimeAsync(0);
    h.emit({ type: 'task.status_changed', taskId: 'task', from: 'working', to: 'blocked' }); await vi.advanceTimersByTimeAsync(80);
    const changed = h.controller.getSnapshot()!.model;
    resolve({ spaceId: 'space', complete: true, counts: [{ anchorId: 'task', unread: 2 }] } as import('@tm8/contract').SpaceUnreadCounts);
    await vi.advanceTimersByTimeAsync(80);
    const after = h.controller.getSnapshot()!.model;
    expect(after.places.find(place => place.id === 'task')).toMatchObject({ status: 'blocked', mailbox: { count: 2, basis: 'unread' } });
    expect(after.robots.map(worker => worker.id)).toEqual(before.robots.map(worker => worker.id));
    expect(after.places.map(place => [place.id, place.x, place.z])).toEqual(changed.places.map(place => [place.id, place.x, place.z]));
    expect(h.loadMap).toHaveBeenCalledTimes(1); h.controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});

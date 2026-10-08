import { buildMapModel } from '../story/game/map-model';
import type { MapModel, MapRobot, MapScope, MapType } from '../story/game/map-model';
import { applyMapEvent, type GameMapEvent, type GameTaskEvent } from './live-map-events';
import type { GameMapEvents, GameMapLoader, GameMapResult } from './types';

export interface MapUpdateEffect { id: number; count: number; combined: boolean; entityIds: string[]; taskEvents: GameTaskEvent[] }
export interface LiveMapSnapshot {
  result: GameMapResult; model: MapModel; departures: MapRobot[]; effect: MapUpdateEffect | null; error: Error | null;
}
interface Options {
  spaceId: string; scope: MapScope; type: MapType; loadMap: GameMapLoader; events?: GameMapEvents;
  previous?: MapModel; onSnapshot(snapshot: LiveMapSnapshot): void; onError(error: unknown): void;
  now?: () => number;
}
/** One controller belongs to one navigation epoch. Dispose aborts reads and every queued callback. */
export function createLiveMapController(options: Options) {
  const { scope, type, spaceId, events } = options;
  const now = options.now ?? Date.now;
  let closed = false, request = 0, lastSeq = -1;
  let snapshot: LiveMapSnapshot | null = null;
  let previous = options.previous;
  let abort: AbortController | null = null;
  let replay: GameMapEvent[] | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let departureTimer: ReturnType<typeof setTimeout> | undefined;
  let effectId = 0, recent: number[] = [], effectTimes: number[] = [];
  const departing = new Map<string, { robot: MapRobot; until: number }>();
  // An edge upsert can remove the active row before the semantic completion arrives.
  const lastWorkers = new Map<string, { robot: MapRobot; at: number }>();
  const touched = new Set<string>();
  let taskEvents: GameTaskEvent[] = [];
  const subscriptions: (() => void)[] = [];

  const publish = () => {
    publishTimer = undefined;
    if (closed || !snapshot) return;
    const time = now();
    recent = recent.filter(at => time - at < 60_000);
    if (effectTimes.length) {
      const combined = recent.length > 5;
      const old = snapshot.effect;
      snapshot = { ...snapshot, effect: { id: combined && old?.combined ? old.id : ++effectId,
        count: combined ? recent.length : effectTimes.length, combined, entityIds: [...touched], taskEvents } };
      effectTimes = []; touched.clear(); taskEvents = [];
    }
    snapshot = { ...snapshot, departures: [...departing.values()].filter(row => row.until > time).map(row => row.robot) };
    options.onSnapshot(snapshot);
  };
  const schedulePublish = () => { if (!closed && publishTimer === undefined) publishTimer = setTimeout(publish, 80); };
  const expireDepartures = () => {
    clearTimeout(departureTimer);
    if (!departing.size) return;
    departureTimer = setTimeout(() => {
      if (closed) return;
      for (const [id, row] of departing) if (row.until <= now()) departing.delete(id);
      publish(); expireDepartures();
    }, Math.max(1, Math.min(...[...departing.values()].map(row => row.until - now()))));
  };
  const apply = (event: GameMapEvent, animate = true) => {
    if (!snapshot) return;
    const result = applyMapEvent(snapshot.result.input, scope, event, events);
    if (result.refresh) scheduleRefresh();
    if (!result.changed) return;
    if (animate) {
      for (const robot of snapshot.model.robots) lastWorkers.set(robot.id, { robot, at: now() });
      for (const [id, row] of lastWorkers) {
        if (now() - row.at > 60_000) { lastWorkers.delete(id); continue; }
        if (result.completed.includes(row.robot.sessionId)) departing.set(id, { robot: row.robot, until: now() + 8_000 });
      }
      for (const [id, row] of departing) {
        const session = result.input.entities.find(entity => entity.id === row.robot.sessionId);
        if (!session || session.outcome === 'stopped' || (session.outcome !== 'completed' && ['failed', 'exited', 'lost', 'stopped'].includes(session.processState ?? session.status ?? ''))) departing.delete(id);
      }
      recent.push(now()); effectTimes.push(now()); result.touched.forEach(id => touched.add(id));
      if (event.type === 'task.criterion_changed' || event.type === 'task.status_changed') taskEvents.push(event);
    }
    const model = buildMapModel(result.input, { scope, type, previous: snapshot.model });
    for (const robot of model.robots) { departing.delete(robot.id); lastWorkers.set(robot.id, { robot, at: now() }); }
    previous = model;
    snapshot = { ...snapshot, model, departures: [...departing.values()].map(row => row.robot), result: { ...snapshot.result, input: result.input } };
    expireDepartures();
    if (animate) options.onSnapshot(snapshot);
    schedulePublish();
  };
  const receive = (event: GameMapEvent) => {
    if (closed || event.spaceId !== spaceId || event.seq <= lastSeq) return;
    lastSeq = event.seq;
    replay?.push(event);
    apply(event);
  };
  const refresh = async () => {
    if (closed) return;
    clearTimeout(refreshTimer); refreshTimer = undefined;
    abort?.abort();
    const controller = new AbortController(), epoch = ++request;
    abort = controller; replay = [];
    try {
      const result = await options.loadMap(scope, controller.signal, type);
      if (closed || controller.signal.aborted || epoch !== request) return;
      if (result.input.scope && (result.input.scope.kind !== scope.kind || result.input.scope.id !== scope.id)) throw new Error('The map data does not match the selected scope.');
      const model = buildMapModel(result.input, { scope, type, previous });
      model.robots.forEach(robot => lastWorkers.set(robot.id, { robot, at: now() }));
      previous = model;
      const queued = replay ?? []; replay = null;
      snapshot = { result, model, departures: [], effect: snapshot?.effect ?? null, error: null };
      queued.forEach(event => apply(event, false));
      publish();
    } catch (error) {
      if (closed || controller.signal.aborted || epoch !== request) return;
      replay = null;
      if (snapshot) { snapshot = { ...snapshot, error: error instanceof Error ? error : new Error('Map refresh failed') }; publish(); }
      else options.onError(error);
    }
  };
  function scheduleRefresh() {
    if (!closed && refreshTimer === undefined) refreshTimer = setTimeout(() => { void refresh(); }, 250);
  }
  const attach = () => {
    if (events) {
      subscriptions.push(events.onEvent(receive), events.onResync(id => { if (id === spaceId) scheduleRefresh(); }),
        events.liveness.onChange(() => {
          if (closed || !snapshot) return;
          const input = { ...snapshot.result.input, entities: snapshot.result.input.entities.map(row => {
            if (row.kind !== 'work_session') return row;
            const status = row.processState ?? row.status;
            const recorded = status === 'spawning' || status === 'running' || status === 'idle' || status === 'failed' || status === 'exited' ? status : null;
            return { ...row, live: events.liveness.statusOf({ id: row.id, status: recorded }) === 'live' };
          }) };
          const model = buildMapModel(input, { scope, type, previous: snapshot.model });
          snapshot = { ...snapshot, model, result: { ...snapshot.result, input } }; previous = model; schedulePublish();
        }));
    }
    void refresh();
  };
  const dispose = () => {
    if (closed) return;
    closed = true; request++; abort?.abort(); replay = null;
    clearTimeout(refreshTimer); clearTimeout(publishTimer); clearTimeout(departureTimer);
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
  };
  return { attach, dispose, refresh, getSnapshot: () => snapshot };
}

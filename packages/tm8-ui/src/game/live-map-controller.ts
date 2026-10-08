import { buildMapModel } from '../story/game/map-model';
import type { MapModel, MapRobot, MapScope, MapType } from '../story/game/map-model';
import { workerHome } from '../story/game/maps/worker-motion';
import { applyMapEvent, sessionLiveness, type GameMapEvent, type GameTaskEvent } from './live-map-events';
import type { GameMapEvents, GameMapLoader, GameMapResult } from './types';
import type { GameMailboxReader } from '../data/game-mailboxes';
import { createLiveMailboxController } from './live-map-mailboxes';

export interface MapUpdateEffect { id: number; count: number; combined: boolean; entityIds: string[]; taskEvents: GameTaskEvent[] }
export interface LiveMapSnapshot {
  result: GameMapResult; model: MapModel; previousModel: MapModel | null; departures: MapRobot[]; effect: MapUpdateEffect | null; error: Error | null;
}
interface Options {
  spaceId: string; scope: MapScope; type: MapType; loadMap: GameMapLoader; events?: GameMapEvents;
  previous?: MapModel; onSnapshot(snapshot: LiveMapSnapshot): void; onError(error: unknown): void;
  now?: () => number;
  mailboxes?: GameMailboxReader;
}
/** One controller belongs to one navigation epoch. Dispose aborts reads and every queued callback. */
export function createLiveMapController(options: Options) {
  const { scope, type, spaceId, events } = options;
  const now = options.now ?? Date.now;
  let closed = false, request = 0, lastSeq = -1;
  let snapshot: LiveMapSnapshot | null = null;
  let dirty = false;
  let additions = 0;
  let replayAmbiguityUsed = false;
  let previous = options.previous;
  let abort: AbortController | null = null;
  let replay: GameMapEvent[] | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let departureTimer: ReturnType<typeof setTimeout> | undefined;
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
  let effectId = 0, recent: number[] = [], effectTimes: number[] = [];
  const departing = new Map<string, { robot: MapRobot; until: number }>();
  // An edge upsert can remove the active row before the semantic completion arrives.
  const lastWorkers = new Map<string, { robot: MapRobot; at: number }>();
  const touched = new Set<string>();
  let taskEvents: GameTaskEvent[] = [];
  const subscriptions: (() => void)[] = [];
  const mailboxes = options.mailboxes ? createLiveMailboxController({ spaceId, reader: options.mailboxes, events,
    current: () => snapshot?.result.input ?? null,
    update: input => { if (closed || !snapshot) return; snapshot = { ...snapshot, result: { ...snapshot.result, input } }; dirty = true; schedulePublish(); },
  }) : undefined;
  const scheduleLifecycle = () => {
    clearTimeout(lifecycleTimer); lifecycleTimer = undefined;
    const deadline = snapshot?.model.nextLifecycleAt;
    if (closed || deadline == null) return;
    lifecycleTimer = setTimeout(() => { if (!closed && snapshot) { dirty = true; publish(); } }, Math.min(2_147_483_647, Math.max(1, deadline - now())));
  };

  const publish = () => {
    publishTimer = undefined;
    if (closed || !snapshot) return;
    if (dirty) {
      const model = buildMapModel(snapshot.result.input, { scope, type, previous: snapshot.model, now: now() });
      previous = model; dirty = false;
      const activeSessions = new Set(model.robots.map(robot => robot.sessionId));
      for (const [id, row] of departing) if (activeSessions.has(row.robot.sessionId)) departing.delete(id);
      for (const robot of model.robots) { departing.delete(robot.id); lastWorkers.set(robot.id, { robot, at: now() }); }
      snapshot = { ...snapshot, previousModel: snapshot.model, model };
    }
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
    scheduleLifecycle();
    options.onSnapshot(snapshot);
    mailboxes?.sync();
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
    const result = applyMapEvent(snapshot.result.input, scope, event, events, type, additions < 200);
    if (result.refresh || (animate && result.staleEndpoints)) scheduleRefresh();
    if (!result.changed) return;
    additions += Math.max(0, result.input.entities.length - snapshot.result.input.entities.length);
    if (animate) {
      for (const robot of snapshot.model.robots) lastWorkers.set(robot.id, { robot, at: now() });
      for (const [id, row] of lastWorkers) {
        if (now() - row.at > 60_000) { lastWorkers.delete(id); continue; }
        if (result.completed.includes(row.robot.sessionId)) {
          const home = workerHome(snapshot.model), distance = Math.hypot(row.robot.x - home.x, row.robot.z - home.z);
          departing.set(id, { robot: row.robot, until: now() + Math.max(8_000, distance / 7 * 1_000 + 2_000) });
        }
      }
      for (const [id, row] of departing) {
        const session = result.input.entities.find(entity => entity.id === row.robot.sessionId);
        if (!session || session.outcome === 'stopped' || (session.outcome !== 'completed' && ['failed', 'exited', 'lost', 'stopped'].includes(session.processState ?? session.status ?? ''))) departing.delete(id);
      }
      recent.push(now()); effectTimes.push(now()); result.touched.forEach(id => touched.add(id));
      if (event.type === 'task.criterion_changed' || event.type === 'task.status_changed') taskEvents.push(event);
    }
    dirty = true;
    snapshot = { ...snapshot, departures: [...departing.values()].map(row => row.robot), result: { ...snapshot.result, input: result.input } };
    expireDepartures();
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
      const loaded = await options.loadMap(scope, controller.signal, type);
      if (closed || controller.signal.aborted || epoch !== request) return;
      const result = { ...loaded, input: { ...loaded.input, entities: loaded.input.entities.map(row => sessionLiveness(row, events)) } };
      if (result.input.scope && (result.input.scope.kind !== scope.kind || result.input.scope.id !== scope.id)) throw new Error('The map data does not match the selected scope.');
      const model = buildMapModel(result.input, { scope, type, previous, now: now() });
      // A scoped read replaces the visual handoff. Pending live facts must not be
      // delivered alongside a read snapshot that may predate them.
      clearTimeout(publishTimer); publishTimer = undefined;
      effectTimes = []; touched.clear(); taskEvents = [];
      model.robots.forEach(robot => lastWorkers.set(robot.id, { robot, at: now() }));
      previous = model;
      const queued = replay ?? []; replay = null;
      snapshot = { result, model, previousModel: null, departures: [], effect: null, error: null };
      dirty = false; additions = 0;
      const loadedIds = new Set(result.input.entities.map(row => row.id));
      const ambiguous = (event: GameMapEvent) => {
        switch (event.type) {
          case 'edge.upsert': case 'edge.deleted': return loadedIds.has(event.edge.source.id) || loadedIds.has(event.edge.target.id);
          case 'edge.ended': return loadedIds.has(event.sourceId) || loadedIds.has(event.targetId);
          case 'session.outcome_changed': case 'session.process_changed': return loadedIds.has(event.sessionId);
          case 'task.status_changed': case 'task.criterion_changed': return loadedIds.has(event.taskId);
          case 'counter.changed': return loadedIds.has(event.entityId);
          default: return false;
        }
      };
      // Reads have no seq watermark. Resolve ambiguous deltas with one extra read.
      // After that bound, replay follows stream seq; sustained concurrent writes
      // cannot be proven atomic without a server snapshot watermark.
      const repair = !replayAmbiguityUsed && queued.some(ambiguous);
      if (repair) { replayAmbiguityUsed = true; scheduleRefresh(); }
      queued.forEach(event => { if (!repair || !ambiguous(event)) apply(event, false); });
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
          const input = { ...snapshot.result.input, entities: snapshot.result.input.entities.map(row => sessionLiveness(row, events)) };
          snapshot = { ...snapshot, result: { ...snapshot.result, input } }; dirty = true; schedulePublish();
        }));
    }
    mailboxes?.attach();
    void refresh();
  };
  const dispose = () => {
    if (closed) return;
    closed = true; request++; abort?.abort(); replay = null;
    mailboxes?.dispose();
    clearTimeout(refreshTimer); clearTimeout(publishTimer); clearTimeout(departureTimer); clearTimeout(lifecycleTimer);
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
  };
  return { attach, dispose, refresh, getSnapshot: () => snapshot };
}

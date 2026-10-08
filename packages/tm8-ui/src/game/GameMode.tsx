import { useCallback, useEffect, useRef, useState } from 'react';
import { buildMapModel, MAP_LABELS } from '../story/game/map-model';
import type { MapModel, MapPortal } from '../story/game/map-model';
import { walkingBounds, walkingEntrance } from '../story/game/map-model/walking-world';
import { WalkingMapView } from '../story/game/maps/WalkingMapView';
import type { MapCameraState } from '../story/game/maps/WalkingMapView';
import { backGameMap, enterGameMap, freshGameSave, mapKey, readGameSave, rememberGameMap, validCamera, validPosition, writeGameSave } from './local-save';
import type { GameSave } from './local-save';
import type { GameMapSelection, GameModeProps } from './types';
import './game-mode.css';
export type { GameMapLoader, GameMapResult, GameModeProps } from './types';

type View = { key: string; status: 'loading' } | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; model: MapModel };
function unavailableScope(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return e.code === 'forbidden' || e.code === 'not_found' || e.status === 403 || e.status === 404 || e.statusCode === 403 || e.statusCode === 404;
}

/** The inner key also isolates state when a caller changes account/space without remounting. */
export default function GameMode(props: GameModeProps) {
  return <GameSession key={JSON.stringify([props.spaceId, props.memberId])} {...props} />;
}
function GameSession({ spaceId, memberId, spaceTitle, loadMap, onInspect }: GameModeProps) {
  const [navigation, setNavigation] = useState(() => readGameSave(spaceId, memberId));
  const save = useRef(navigation);
  const models = useRef(new Map<string, MapModel>());
  const pendingSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const closing = useRef(false);
  const navigationEpoch = useRef(0);
  const loadEpoch = useRef(0);
  const root = useRef<HTMLElement | null>(null);
  const epoch = navigationEpoch.current;
  const [retry, setRetry] = useState(0);
  const key = mapKey(navigation.current);
  const [view, setView] = useState<View>({ key, status: 'loading' });
  const [saveFailed, setSaveFailed] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  const flush = useCallback(() => {
    clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
    const persisted = writeGameSave(save.current);
    if (!closing.current) setSaveFailed(!persisted);
  }, []);
  const scheduleSave = useCallback(() => {
    if (pendingSave.current === undefined) pendingSave.current = setTimeout(flush, 250);
  }, [flush]);
  useEffect(() => {
    closing.current = false;
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      closing.current = true;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      clearTimeout(pendingSave.current);
      writeGameSave(save.current);
    };
  }, [flush]);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++loadEpoch.current;
    abort.current = controller;
    const selected = save.current.current;
    setView({ key, status: 'loading' });
    void (async () => {
      try {
        const result = await loadMap(selected.scope, controller.signal, selected.type);
        if (controller.signal.aborted || request !== loadEpoch.current || mapKey(save.current.current) !== key) return;
        if (result.input.scope && (result.input.scope.kind !== selected.scope.kind || result.input.scope.id !== selected.scope.id)) {
          throw new Error('The map data does not match the selected scope.');
        }
        const model = buildMapModel(result.input, { type: selected.type, scope: selected.scope, previous: models.current.get(key) });
        models.current.set(key, model);
        // Keep a bounded cache of stable layouts; snapshots are always loaded afresh.
        if (models.current.size > 128) models.current.delete(models.current.keys().next().value!);
        const position = save.current.maps[key]?.position;
        if (position) {
          const bounds = walkingBounds(model);
          const clamped = { x: Math.max(bounds.minX, Math.min(bounds.maxX, position.x)), z: Math.max(bounds.minZ, Math.min(bounds.maxZ, position.z)) };
          const moved = clamped.x !== position.x || clamped.z !== position.z;
          save.current = rememberGameMap(save.current, key, { position: clamped, ...(moved ? { camera: undefined } : {}) });
        }
        save.current = { ...save.current, current: { ...selected, title: result.title } };
        setNavigation(save.current);
        flush();
        setView({ key, status: 'ready', model });
      } catch (error) {
        if (!controller.signal.aborted && request === loadEpoch.current && mapKey(save.current.current) === key) {
          if (selected.scope.kind === 'story' && unavailableScope(error)) {
            // Skip typed maps and the hub of the unavailable story, then try its parent.
            let index = save.current.stack.length - 1;
            while (index >= 0 && save.current.stack[index]!.scope.id === selected.scope.id && save.current.stack[index]!.scope.kind === 'story') index--;
            const next = index >= 0 ? backGameMap(save.current, index) : { ...freshGameSave(spaceId, memberId), maps: save.current.maps };
            navigationEpoch.current++;
            save.current = next;
            flush();
            setRecoveryNotice('That story is no longer available. Returned to an available hub.');
            setNavigation(next);
            return;
          }
          setView({ key, status: 'error', message: error instanceof Error ? error.message : 'The map could not be loaded.' });
        }
      }
    })();
    return () => { controller.abort(); loadEpoch.current++; };
  }, [key, loadMap, retry, flush]);

  const navigate = useCallback((next: GameSave) => {
    if (next === save.current) return;
    abort.current?.abort();
    loadEpoch.current++;
    navigationEpoch.current++;
    save.current = next;
    setRecoveryNotice(null);
    flush();
    setNavigation(next);
  }, [flush]);
  const back = useCallback((index?: number) => {
    if (navigationEpoch.current === epoch && mapKey(save.current.current) === key) navigate(backGameMap(save.current, index));
  }, [key, epoch, navigate]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return;
      if (target && target !== document.body && !root.current?.contains(target)) return;
      if (mapKey(save.current.current) === key && save.current.stack.length) { event.preventDefault(); back(); }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [key, back]);

  const ready = view.key === key && view.status === 'ready' ? view : null;
  const enter = (portal: MapPortal) => {
    if (!ready || navigationEpoch.current !== epoch || mapKey(save.current.current) !== key) return;
    const actual = ready.model.portals.find(p => p.id === portal.id);
    if (!actual) return;
    navigate(enterGameMap(save.current, { ...actual.target, title: actual.target.scope.kind === ready.model.scope.kind
      && actual.target.scope.id === ready.model.scope.id ? save.current.current.title : actual.label }));
  };
  const position = (x: number, z: number) => {
    if (!validPosition({ x, z })) return;
    save.current = rememberGameMap(save.current, key, { position: { x, z } });
    if (closing.current || mapKey(save.current.current) !== key) flush(); else scheduleSave();
  };
  const camera = (state: MapCameraState) => {
    if (!validCamera(state)) return;
    save.current = rememberGameMap(save.current, key, { camera: { zoom: state.zoom, position: [...state.position], target: [...state.target] } });
    if (closing.current || mapKey(save.current.current) !== key) flush(); else scheduleSave();
  };
  const label = (map: GameMapSelection) => `${map.title || (map.scope.kind === 'space' ? spaceTitle || 'Space' : 'Story')} · ${MAP_LABELS[map.type]}`;
  // Mount values stay stable while the renderer reports movement/camera changes.
  const memory = navigation.maps[key];
  const failure = view.key === key && view.status === 'error' ? view : null;
  return <section ref={root} className="game-mode" aria-label="Game">
    <nav className="game-mode__navigation" aria-label="Map navigation">
      <button type="button" onClick={() => back()} disabled={!navigation.stack.length} aria-label="Back one map">Back</button>
      <ol>{navigation.stack.map((map, index) => <li key={`${mapKey(map)}:${index}`}><button type="button" onClick={() => back(index)}>{label(map)}</button></li>)}
        <li aria-current="location">{label(navigation.current)}</li></ol>
    </nav>
    {saveFailed && <p className="game-mode__notice" role="status">Browser save is unavailable. Your place is kept for this visit.</p>}
    {recoveryNotice && <p className="game-mode__notice" role="status">{recoveryNotice}</p>}
    {!!ready?.model.warnings.length && <details className="game-mode__notice" open><summary>Map notices</summary><ul>{[...new Set(ready.model.warnings)].map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
    <div className="game-mode__map" aria-busy={!ready && !failure}>
      {ready ? <WalkingMapView key={ready.model.id} model={ready.model} start={memory?.position ?? walkingEntrance(ready.model)} camera={memory?.camera}
        onPosition={position} onCamera={camera} onInspect={id => { if (navigationEpoch.current === epoch && mapKey(save.current.current) === key) onInspect(id); }} onEnterPortal={enter}
        onBack={navigation.stack.length ? () => back() : undefined} />
        : failure ? <div className="game-mode__status" role="alert"><p>{failure.message}</p>
          <button type="button" onClick={() => setRetry(n => n + 1)}>Retry map</button>
          <button type="button" onClick={() => { navigate({ ...freshGameSave(spaceId, memberId), maps: save.current.maps }); setRetry(n => n + 1); }}>Return to space hub</button></div>
          : <p className="game-mode__status" role="status">Loading {MAP_LABELS[navigation.current.type]}…</p>}
    </div>
  </section>;
}

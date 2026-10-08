import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MapModel, MapPortal, MapRenderer, MapRendererProps } from '../map-model';
import { mapWalkingWorld, walkingBounds, walkingEntrance } from '../map-model/walking-world';
import { createControl, keyDirection, WALK_KEYS, walkTo } from '../control';
import { WorldMinimap } from '../Minimap';
import { hasWebGL, readPalette, type Palette } from '../palette';
import type { Place } from '../world';
import '../story-game.css';
import './studio.css';
import './walking.css';

export interface MapCameraState {
  zoom: number;
  position: [number, number, number];
  target: [number, number, number];
}
export interface WalkingMapViewProps extends MapRendererProps {
  model: MapModel;
  start: { x: number; z: number };
  camera?: MapCameraState;
  onPosition: (x: number, z: number) => void;
  onCamera: (state: MapCameraState) => void;
  onInspect: (entityId: string) => void;
  onEnterPortal: (portal: MapPortal) => void;
  onBack?: () => void;
}
class RenderBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onUnavailable(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Map selection and persistence belong to the host. A new map owns a fresh player. */
export const WalkingMapView: MapRenderer<ReactNode, WalkingMapViewProps> = props => <WalkingMapBody key={props.model.id} {...props}/>;

function WalkingMapBody(props: WalkingMapViewProps) {
  const { model } = props;
  const bounds = useMemo(() => walkingBounds(model), [model]);
  const world = useMemo(() => mapWalkingWorld(model), [model]);
  // Saving must never reapply the initial pose to a player who is already moving.
  const [initial] = useState(() => {
    const { x, z } = props.start;
    // Explicit saves remain valid inside footprints: walking can leave those positions.
    const valid = Number.isFinite(x) && Number.isFinite(z) && x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
    return { start: valid ? { ...props.start } : walkingEntrance(model), camera: valid && props.camera ? { ...props.camera, position: [...props.camera.position] as [number, number, number], target: [...props.camera.target] as [number, number, number] } : undefined };
  });
  const [control] = useState(createControl);
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(hasWebGL);
  const unavailable = useCallback(() => setWebgl(false), []);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [position, setPosition] = useState({ ...initial.start, heading: 0 });
  const positionRef = useRef(position);
  const [nearId, setNearId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set(world.places.filter(p => Math.hypot(p.x - initial.start.x, p.z - initial.start.z) <= 12).map(p => p.id)));
  const [overview, setOverview] = useState(false);
  const [minimap, setMinimap] = useState(true);
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const alertNode = useRef<HTMLSpanElement>(null);
  const focus = useCallback(() => host.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const refresh = () => setPalette(readPalette(node));
    refresh(); focus();
    const root = node.closest('.cv2-root');
    const observer = new MutationObserver(refresh);
    if (root) observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => observer.disconnect();
  }, [focus]);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const savePosition = useCallback((x: number, z: number) => {
    const p = { x, z, heading: control.player?.heading ?? 0 };
    positionRef.current = p; setPosition(p);
    latest.current.onPosition(x, z);
  }, [control]);
  const saveCamera = useCallback((camera: MapCameraState) => latest.current.onCamera(camera), []);
  useEffect(() => () => {
    control.keys.clear();
    const p = control.player ?? positionRef.current;
    latest.current.onPosition(p.x, p.z);
  }, [control]);
  const reveal = useCallback((ids: string[]) => setRevealed(previous => new Set([...previous, ...ids])), []);
  const act = useCallback((id: string) => {
    const portal = latest.current.model.portals.find(p => p.id === id);
    if (portal) latest.current.onEnterPortal(portal);
    else {
      const place = latest.current.model.places.find(p => p.id === id);
      if (place) latest.current.onInspect(place.entityId);
    }
  }, []);
  const arrive = useCallback((id: string, open: boolean) => { setNearId(id); if (open) act(id); }, [act]);
  const go = useCallback((p: Place) => {
    setOverview(false); walkTo(control, p.x, p.z, p.id);
    if (!webgl) { savePosition(p.x, p.z + p.footprint + 1.1); setNearId(p.id); }
    focus();
  }, [control, webgl, savePosition, focus]);
  const toggleOverview = () => { control.overview = !control.overview; setOverview(control.overview); focus(); };
  const toggleMinimap = () => { setMinimap(value => !value); focus(); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[aria-modal="true"]')) return;
    if (event.key === 'Escape' && props.onBack) { event.preventDefault(); event.stopPropagation(); props.onBack(); return; }
    if (event.target instanceof HTMLElement && event.target.closest('button,input,textarea,select,[contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'm') { toggleOverview(); event.preventDefault(); }
    else if (key === 'n') { toggleMinimap(); event.preventDefault(); }
    else if (WALK_KEYS.has(key)) {
      control.keys.add(key); control.overview = false; setOverview(false); event.preventDefault();
      if (!webgl) {
        const dir = keyDirection(control.keys);
        if (dir) {
          const b = bounds, p = positionRef.current;
          const x = Math.max(b.minX, Math.min(b.maxX, p.x + dir[0]));
          const z = Math.max(b.minZ, Math.min(b.maxZ, p.z + dir[1]));
          savePosition(x, z);
          const closest = world.places.filter(q => Math.hypot(q.x - x, q.z - z) <= q.footprint + 1.6).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
          setNearId(closest?.id ?? null);
        }
      }
    } else if (['e', 'enter', ' '].includes(key) && nearId) { event.preventDefault(); act(nearId); }
  };
  const near = nearId ? world.byId.get(nearId) : null;
  // Three is loaded with the scene. Keep its mutable vector out of the DOM module.
  const walking = useMemo(() => ({ world, palette: palette!, control, revealed, start: initial.start, reduced, duel: null, alertNode,
    cameraState: initial.camera, onCamera: saveCamera, bounds, approachFootprints: true,
    onPosition: savePosition, onReveal: reveal, onNear: setNearId, onArrive: arrive,
  }), [world, palette, control, revealed, initial, reduced, bounds, savePosition, saveCamera, reveal, arrive]);
  return <div className="sgm walking-map" ref={host} tabIndex={0} role="application" aria-label="Walking map" data-testid="walking-map" data-map-id={model.id} data-renderer={webgl ? 'webgl' : 'dom'}
    onKeyDown={keyDown} onKeyUp={event => control.keys.delete(event.key.toLowerCase())} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) control.keys.clear(); }}>
    <div className="sgm-stage">
      {webgl && palette ? <RenderBoundary onUnavailable={unavailable}><Suspense fallback={<div className="sgm-loading" role="status">Opening the map…</div>}><WalkingSceneAdapter
        model={model} walking={walking} initial={initial.start} onUnavailable={unavailable}
        onGround={(x, z) => { walkTo(control, x, z, null); setOverview(false); focus(); }}
        onSelectEntity={id => { const p = model.places.find(p => p.entityId === id); if (p) go(world.byId.get(p.id)!); }}
        onEnterPortal={p => go(world.byId.get(p.id)!)}/></Suspense></RenderBoundary> : null}
      {!webgl && <div className="walking-fallback" role="region" aria-label="Map places"><p>Explore the places below. Choose a place to travel, then inspect it or enter its map.</p><ul>{world.places.map(p => <li key={p.id}><span>{p.title}</span><button className="sgm-btn" onClick={() => go(p)}>Walk to {p.title}</button><button className="sgm-btn" onClick={() => act(p.id)}>{p.portal ? 'Enter' : 'Inspect'} {p.title}</button></li>)}</ul></div>}
    </div>
    <div className="sgm-hud">
      <div className="walking-toolbar">{props.onBack && <button className="sgm-btn" onClick={props.onBack}>Back <kbd>Esc</kbd></button>}<button className="sgm-btn" onClick={toggleOverview} aria-pressed={overview}>{overview ? 'Back to explorer' : 'Map overview'} <kbd>M</kbd></button></div>
      <div className="walking-map-tools">
        {webgl && <details className="walking-places"><summary>Places ({world.places.length})</summary><ul>{world.places.map(p => <li key={p.id}><button className="sgm-btn" onClick={() => go(p)} title={`Walk to ${p.title}`}>{p.title}</button><button className="sgm-btn" aria-label={`${p.portal ? 'Enter' : 'Inspect'} ${p.title}`} onClick={() => act(p.id)}>{p.portal ? 'Enter' : 'Inspect'}</button></li>)}</ul></details>}
        <WorldMinimap world={world} revealed={revealed} palette={palette} control={control} player={position} open={minimap} onToggle={toggleMinimap} onTravel={() => { setOverview(false); focus(); }}/>
      </div>
      {near && <div className="sgm-approach" role="region" aria-label="Nearby place"><div className="sgm-approach__text"><div className="sgm-approach__title">{near.title}</div><div className="sgm-approach__sub">{near.portal ? 'Portal to another map' : [near.kind.replaceAll('_', ' '), near.status?.replaceAll('_', ' '), near.progress === null ? null : `${Math.round(near.progress * 100)}% complete`].filter(Boolean).join(' · ')}</div></div><button className="sgm-btn sgm-btn--primary" onClick={() => act(near.id)}>{near.portal ? 'Enter' : 'Inspect'} <kbd>E</kbd></button></div>}
      <div className="sgm-hint"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows to walk</span><span>Click to travel · scroll to zoom</span><span><kbd>E</kbd> inspect / enter</span></div>
    </div>
    {world.places.length === 0 && <div className="walking-empty" role="status">No entities in this map yet.</div>}
  </div>;
}

// The vector belongs to the mounted scene; prop saves never recreate it.
const WalkingSceneAdapter = lazy(() => import('./WalkingSceneAdapter'));

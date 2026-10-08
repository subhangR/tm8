/** Real read/event ports and production GameMode; no fixture DTO substitution. */
import { createRoot } from 'react-dom/client';
import { _roots } from '@react-three/fiber';
import { useAssetReport } from '../src/story/game/maps/MapAsset';
import { Vector3 } from 'three';
import GameMode from '../src/game/GameMode';
import { createRealSeam } from '../src/data/real/seam-real';
import { browserWebSocketFactory } from '../src/data/real/socket';
import { createGameMapLoader } from '../src/data/game-maps';
import { buildMapModel, type MapModel, type MapScope, type MapType } from '../src/story/game/map-model';
import { freshGameSave, gameSaveKey, mapKey } from '../src/game/local-save';
import type { MapCameraState } from '../src/story/game/maps/WalkingMapView';
import '../src/styles/tokens.css';
import '../src/styles/app.css';

const root = createRoot(document.getElementById('root')!);
const seam = createRealSeam({ fetch: window.fetch.bind(window), webSocketFactory: browserWebSocketFactory(WebSocket), origin: location.origin });
const models = new Map<string, MapModel>();
let config: { spaceId: string; storyId: string; memberId: string };
let loader: ReturnType<typeof createGameMapLoader>;
let inspected: string | null = null;
let loadCount = 0;
let mounting = 0;
let assets: ReturnType<typeof useAssetReport> | null = null;
function AssetEvidence() { assets = useAssetReport(); return null; }

function scene() {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="walking-map"] canvas');
  const state = canvas ? _roots.get(canvas)?.store.getState() : undefined;
  if (!state) return null;
  let player: number[] | null = null;
  state.scene.traverse(node => {
    const instance = (node as unknown as { __r3f?: { props?: { visible?: boolean; position?: unknown[] } } }).__r3f;
    const props = instance?.props;
    if (props?.visible === true && Array.isArray(props.position) && props.position.length === 3 && props.position[1] === 0) player = node.position.toArray();
  });
  return { camera: { position: state.camera.position.toArray(), zoom: state.camera.zoom,
    forward: state.camera.getWorldDirection(new Vector3()).toArray() }, player,
    stats: { triangles: state.gl.info.render.triangles, calls: state.gl.info.render.calls }, assets };
}

function record(model: MapModel) {
  return {
    id: model.id, scope: model.scope, type: model.type, places: model.places,
    robots: model.robots, roads: model.roads, portals: model.portals, groups: model.groups,
    warnings: model.warnings, bounds: model.bounds,
    ...('nextLifecycleAt' in model ? { nextLifecycleAt: model.nextLifecycleAt } : {}),
    ...('shippingYard' in model ? { shippingYard: model.shippingYard } : {}),
  };
}

async function project(scope: MapScope, type: MapType, now?: number, cold = false) {
  const data = await loader(scope, undefined, type);
  const key = mapKey({ scope, type });
  const model = buildMapModel(data.input, { scope, type, ...(cold ? {} : { previous: models.get(key) }), ...(now === undefined ? {} : { now }) });
  models.set(key, model);
  return record(model);
}

async function initialize(value: typeof config) {
  config = value; loader = createGameMapLoader(seam, config.spaceId);
  await seam.openSpace(config.spaceId);
}

function mount(scope: MapScope, type: MapType, memory?: { position: { x: number; z: number }; camera: MapCameraState }) {
  const save = freshGameSave(config.spaceId, config.memberId);
  const spaceHub = { scope: { kind: 'space' as const, id: config.spaceId }, type: 'hub' as const };
  const storyHub = { scope, type: 'hub' as const };
  save.current = { scope, type };
  save.stack = scope.kind === 'story' ? type === 'hub' ? [spaceHub] : [spaceHub, storyHub] : type === 'hub' ? [] : [spaceHub];
  if (memory) save.maps[mapKey(save.current)] = memory;
  localStorage.setItem(gameSaveKey(config.spaceId, config.memberId), JSON.stringify(save));
  inspected = null;
  const observingLoader: typeof loader = async (scope, signal, type = 'hub') => {
    const result = await loader(scope, signal, type);
    const key = mapKey({ scope, type });
    models.set(key, buildMapModel(result.input, { scope, type, previous: models.get(key) }));
    loadCount++;
    return result;
  };
  root.render(<div className="cv2-root" style={{ height: '100%', zoom: 1 }}>
    <AssetEvidence/>
    <GameMode key={++mounting} spaceId={config.spaceId} memberId={config.memberId} spaceTitle="Synthetic Taskland world"
      loadMap={observingLoader} onInspect={id => { inspected = id; }}/>
  </div>);
}

declare global {
  interface Window { tasklandServer: {
    initialize: typeof initialize; project: typeof project; mount: typeof mount;
    current: (scope: MapScope, type: MapType) => ReturnType<typeof record> | null;
    scene: typeof scene;
    state: () => { inspected: string | null; loadCount: number; save: unknown };
  } }
}
window.tasklandServer = {
  initialize, project, mount,
  scene,
  current: (scope, type) => { const model = models.get(mapKey({ scope, type })); return model ? record(model) : null; },
  state: () => ({ inspected, loadCount, save: JSON.parse(localStorage.getItem(gameSaveKey(config.spaceId, config.memberId)) ?? 'null') }),
};

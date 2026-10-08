/** Production renderer + model builder, fed ONLY deterministic synthetic records. */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { _roots } from '@react-three/fiber';
import { buildMapModel, type MapType } from '../../src/story/game/map-model';
import { walkingEntrance } from '../../src/story/game/map-model/walking-world';
import { WalkingMapView } from '../../src/story/game/maps/WalkingMapView';
import { useAssetReport } from '../../src/story/game/maps/MapAsset';
import { getImportedAsset } from '../../src/story/game/imported-assets';
import { fixture } from './core.mjs';
import '../../src/styles/tokens.css';

const params = new URLSearchParams(location.search);
const selection = { map: params.get('map') ?? 'taskland', scope: params.get('scope') ?? 'space', workload: params.get('workload') ?? 'representative' };
const buildStarted = performance.now();
const input = fixture(selection);
const model = buildMapModel(input, { type: selection.map as MapType, scope: input.scope });
const buildMs = performance.now() - buildStarted;
const counts = { inputEntities: input.entities.length, inputEdges: input.edges.length, places: model.places.length,
  roads: model.roads.length, robots: model.robots.length, groups: model.groups.length, portals: model.portals.length,
  decor: model.decor.length, paths: model.paths.length,
  byKind: Object.fromEntries([...new Set(input.entities.map(e => e.kind))].map(kind => [kind, input.entities.filter(e => e.kind === kind).length])) };
const observations = { positions: [] as Array<{ x: number; z: number; at: number }>, cameras: [] as unknown[], inspections: 0, portalRequests: 0 };
let assetReport: ReturnType<typeof useAssetReport> | null = null;
Object.assign(window, { __gameGpuFixture: { selection, counts, buildMs, warnings: model.warnings, observations,
  snapshot: () => {
    const canvas = document.querySelector('canvas');
    // R3F's test registry exposes the actual mounted renderer; no production hook added.
    const gl = canvas ? _roots.get(canvas)?.store.getState().gl : null;
    return { assets: assetReport, unresolvedImportedFallbacks: assetReport?.fallbacks.filter(id => getImportedAsset(id)) ?? [],
      shadows: gl ? { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, autoUpdate: gl.shadowMap.autoUpdate } : null,
      size: gl ? { width: gl.domElement.width, height: gl.domElement.height, pixelRatio: gl.getPixelRatio() } : null,
      memory: gl ? { ...gl.info.memory } : null };
  },
  source: 'synthetic MapInput -> production buildMapModel -> production WalkingMapView/MapScene',
  coverage: { measured: ['production player locomotion', 'overview camera', 'scroll zoom', 'rendered static worker poses and ambient animations'],
    unsupported: ['live server event replay', 'worker arrival/departure routes', 'construction transitions', 'shipping transitions', 'production authenticated graph adapter', 'nested navigation and reload persistence'] } } });
function App() {
  const [inspected, inspect] = useState<string | null>(null);
  const assets = useAssetReport();
  useEffect(() => { assetReport = assets; }, [assets]);
  return <main className="cv2-root gpu-fixture"><header>Synthetic {selection.scope} / {selection.map} / {selection.workload} · {model.places.length} places, {model.robots.length} workers</header>
    <WalkingMapView model={model} start={walkingEntrance(model)}
      onPosition={(x, z) => { observations.positions.push({ x, z, at: performance.now() }); if (observations.positions.length > 256) observations.positions.shift(); }}
      onCamera={camera => { observations.cameras.push(camera); if (observations.cameras.length > 256) observations.cameras.shift(); }}
      onInspect={id => { observations.inspections++; inspect(id); }} onEnterPortal={() => observations.portalRequests++}/>
    {inspected && <aside role="status">Synthetic inspection: {inspected}</aside>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

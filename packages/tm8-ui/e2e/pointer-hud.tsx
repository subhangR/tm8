/** Synthetic records; actual shared scene, Places actions and minimap handlers. */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { buildMapModel, type MapPortal } from '../src/story/game/map-model';
import { mapWalkingWorld } from '../src/story/game/map-model/walking-world';
import { mapExtent, project } from '../src/story/game/minimap';
import { WalkingMapView } from '../src/story/game/maps/WalkingMapView';
import '../src/styles/tokens.css';
const scope = { kind: 'space' as const, id: 'pointer-space' };
const entities = Array.from({ length: 16 }, (_, i) => ({ id: `pointer-story-${i}`, kind: 'story' as const,
  title: i === 15 ? 'Pointer mountain story' : `Pointer story ${i + 1}` }));
const rootModel = buildMapModel({ scope, entities, edges: [] }, { scope, type: 'hub' });
const target = rootModel.portals.find(p => p.entityId === 'pointer-story-15')!;
if (!target) throw new Error('Missing story portal fixture');
const world = mapWalkingWorld(rootModel);
declare const __POINTER_HUD_BUILD_SHA__: string;
declare const __POINTER_HUD_BUILD_PROVENANCE__: { head: string; sourceDiffExitCode: number; statusPorcelain: string };
const start = { x: target.x + 3, z: target.z + target.radius + 1.1 };
const state = { sourceHead: __POINTER_HUD_BUILD_SHA__, provenance: __POINTER_HUD_BUILD_PROVENANCE__, navigate: false, entered: [] as MapPortal[],
  actions: [] as { type: string; id: string }[], positions: [] as { mapId: string; x: number; z: number }[],
  target, start, places: world.places.map(p => ({ title: p.title, type: p.portal ? 'Enter' : 'Inspect',
    id: p.portal ? p.id : rootModel.places.find(q => q.id === p.id)!.entityId })),
  minimapPixel: project(mapExtent(world), 180)(target.x, target.z) };
Object.assign(window, { __pointerHud: state });
function Harness() {
  const [model, setModel] = useState(rootModel);
  const enter = (portal: MapPortal) => {
    state.entered.push(portal);
    state.actions.push({ type: 'Enter', id: portal.id });
    if (state.navigate) setModel(buildMapModel({ scope: portal.target.scope, entities: [], edges: [] }, portal.target));
  };
  return <WalkingMapView model={model}
    start={model === rootModel ? start : { x: 0, z: 0 }}
    onPosition={(x, z) => { state.positions.push({ mapId: model.id, x, z }); }} onCamera={() => {}}
    onInspect={id => { state.actions.push({ type: 'Inspect', id }); }} onEnterPortal={enter} onBack={() => setModel(rootModel)}/>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

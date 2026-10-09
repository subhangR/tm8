/** Synthetic worker+hub fixture using the production walking HUD and handlers. */
import { createRoot } from 'react-dom/client';
import { buildMapModel } from '../src/story/game/map-model';
import { WalkingMapView } from '../src/story/game/maps/WalkingMapView';
import '../src/styles/tokens.css';
const scope = { kind: 'space' as const, id: 'combined-hud-space' };
const hub = buildMapModel({ scope, entities: Array.from({ length: 16 }, (_, i) => ({
  id: `story-${i}`, kind: 'story' as const, title: `Combined story ${i + 1}`,
})), edges: [] }, { scope, type: 'hub' });
const taskland = buildMapModel({ scope, entities: [
  { id: 'task', kind: 'task', title: 'Active construction', status: 'working' },
  { id: 'session', kind: 'work_session', title: 'Combined worker with a long session title', status: 'running', processState: 'running', outcome: 'open', live: true },
], edges: [{ id: 'claim', type: 'working_on', fromId: 'session', toId: 'task', status: 'working' }] }, { scope, type: 'taskland' });
if (taskland.robots.length !== 1) throw new Error('Expected one authoritative worker fixture');
const model = { ...hub, robots: taskland.robots };
const state = { actions: [] as string[], positions: [] as { x: number; z: number }[] };
Object.assign(window, { __combinedHud: state });
createRoot(document.getElementById('root')!).render(<WalkingMapView model={model} start={{ x: 0, z: 8 }}
  onPosition={(x, z) => state.positions.push({ x, z })} onCamera={() => {}}
  onInspect={id => state.actions.push(`inspect:${id}`)} onEnterPortal={portal => state.actions.push(`enter:${portal.id}`)}/>);

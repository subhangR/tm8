/** Synthetic records only. The scene, imported assets and model are production code. */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildMapModel, type MapEntity, type MapInput, type MapModel, type MapScope } from '../src/story/game/map-model';
import { MapScene, type RenderStats } from '../src/story/game/maps/MapScene';
import { useAssetReport } from '../src/story/game/maps/MapAsset';
import '../src/styles/tokens.css';
import '../src/story/game/maps/studio.css';

type FixtureEntity = MapEntity & { acceptance?: { total: number; completed: number }; cancelledAt?: string };
const EPOCH = Date.parse('2026-10-08T12:00:00Z');
function fixture(scope: MapScope): MapInput {
  const entities: FixtureEntity[] = [
    { id: 'root', kind: 'task', title: 'Harbour compound', status: 'working', pointsEstimate: 3,
      acceptance: { total: 4, completed: 1 }, mailbox: { count: 2 } },
    { id: 'child', kind: 'task', title: 'Survey plot', parentId: 'root', status: 'to_do',
      acceptance: { total: 4, completed: 0 }, mailbox: { count: 3, approx: true } },
    { id: 'paused', kind: 'task', title: 'Paused annex', parentId: 'root', status: 'blocked', pointsEstimate: 2,
      acceptance: { total: 4, completed: 2 }, pendingAttention: 1 },
    { id: 'review', kind: 'task', title: 'Review workshop', status: 'in_review', pointsEstimate: 2,
      acceptance: { total: 4, completed: 3 }, mailbox: { count: 1 } },
    { id: 'ready', kind: 'task', title: 'Planning courtyard', status: 'to_do', pointsEstimate: 1,
      acceptance: { total: 4, completed: 0 }, mailbox: { count: 0 } },
    { id: 'session', kind: 'work_session', title: 'Synthetic builder', status: 'running', processState: 'running', live: true },
    { id: 'output', kind: 'artifact', title: 'Survey deliverable' },
  ];
  return { scope, entities, edges: [
    { id: 'claim', type: 'working_on', fromId: 'session', toId: 'child' },
    { id: 'deliverable', type: 'produces', fromId: 'child', toId: 'output' },
  ] };
}
function Harness() {
  const [scope, setScope] = useState<MapScope>({ kind: 'story', id: 'synthetic-story' });
  const [input, setInput] = useState(() => fixture(scope));
  const [type, setType] = useState<'taskland' | 'town'>('taskland');
  const [now, setNow] = useState(EPOCH);
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusSurvey, setFocusSurvey] = useState(false);
  const models = useRef(new Map<string, MapModel>());
  const model = useMemo(() => {
    const key = `${scope.kind}:${type}`;
    const next = buildMapModel(input, { scope, type, previous: models.current.get(key), now } as Parameters<typeof buildMapModel>[1]);
    models.current.set(key, next);
    return next;
  }, [input, scope, type, now]);
  const assets = useAssetReport();
  const onStats = useCallback((value: RenderStats) => setStats(value), [revision]);
  function change(action: string) {
    setStats(null); setRevision(value => value + 1);
    if (action === 'expire') { setNow(value => value + 24 * 60 * 60 * 1000); return; }
    setInput(previous => ({ ...previous, entities: previous.entities.map(e => {
      if (action === 'root-done' && e.id === 'root') return { ...e, status: 'done' };
      if (action === 'cancel' && e.id === 'paused') return { ...e, status: 'cancelled', cancelledAt: new Date(now).toISOString() };
      if (e.id !== 'child') return e;
      switch (action) {
        case 'working': return { ...e, status: 'working' };
        case 'progress': return { ...e, acceptance: { total: 4, completed: 2 } };
        case 'review': return { ...e, status: 'in_review', acceptance: { total: 4, completed: 3 } };
        case 'blocked': return { ...e, status: 'blocked' };
        case 'estimate': return { ...e, pointsEstimate: 3 };
        case 'ship': return { ...e, status: 'done' };
        default: return e;
      }
    }) }));
  }
  const exposed = { model, revision, stats, assets, now, type, scope };
  Object.assign(window, { __tasklandHarness: exposed });
  return <div style={{ height: '100vh', background: '#101c24', color: '#e8eef3', fontFamily: 'system-ui' }}>
    <header style={{ padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>Synthetic Taskland verification</strong><span>Browser WebGL · GPU identity recorded by checker</span>
      <select aria-label="Scope" value={scope.kind} onChange={e => {
        const next: MapScope = { kind: e.target.value as MapScope['kind'], id: `synthetic-${e.target.value}` };
        models.current.clear(); setScope(next); setInput(fixture(next)); setNow(EPOCH); setStats(null); setType('taskland'); setRevision(value => value + 1);
      }}><option value="story">Story</option><option value="space">Space</option></select>
      <select aria-label="Map" value={type} onChange={e => { setType(e.target.value as typeof type); setStats(null); setRevision(value => value + 1); }}>
        <option value="taskland">Taskland</option><option value="town">Completed Town</option>
      </select>
      <button onClick={() => { setFocusSurvey(value => !value); setStats(null); setRevision(value => value + 1); }}>survey view</button>
      {['working','progress','review','blocked','estimate','ship','root-done','cancel','expire'].map(action =>
        <button key={action} onClick={() => change(action)}>{action}</button>)}
    </header>
    <main data-testid="taskland-scene" style={{ position: 'relative', height: 'calc(100vh - 100px)' }}>
      <MapScene model={model} selectedEntityId={selected} onSelectEntity={setSelected} onStats={onStats}
        focus={focusSurvey ? model.places.find(p => p.entityId === 'child') : null} hierarchy/>
    </main>
    <footer style={{ padding: '4px 20px' }}>Synthetic records · imported production assets · aggregate mailbox totals · no native GPU claim</footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

/** Synthetic records only. The scene, imported assets and model are production code. */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkStatus } from '@tm8/contract';
import type { MapUpdateEffect } from '../src/game/live-map-controller';
import type { GameTaskEvent } from '../src/game/live-map-events';
import type { TasklandTransition } from '../src/story/game/taskland-motion';
import { buildMapModel, type MapEntity, type MapInput, type MapModel, type MapScope } from '../src/story/game/map-model';
import { MapScene, type RenderStats } from '../src/story/game/maps/MapScene';
import { useAssetReport } from '../src/story/game/maps/MapAsset';
import '../src/styles/tokens.css';
import '../src/story/game/maps/studio.css';

type FixtureEntity = MapEntity & { acceptance?: { total: number; completed: number }; cancelledAt?: string };
declare const __TASKLAND_BUILD_HEAD__: string;
const EPOCH = Date.parse('2026-10-08T12:00:00Z');
function fixture(scope: MapScope): MapInput {
  const entities: FixtureEntity[] = [
    { id: 'root', kind: 'task', title: 'Harbour compound', status: 'working', pointsEstimate: 3,
      acceptance: { total: 4, completed: 1 }, mailbox: { count: 2 } },
    { id: 'child', kind: 'task', title: 'Survey plot', parentId: 'root', status: 'open',
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
  const [reducedMotion, setReducedMotion] = useState(false);
  const [effect, setEffect] = useState<MapUpdateEffect | null>(null);
  const [motion, setMotion] = useState<{ transitions: readonly TasklandTransition[]; suppressedPlaceIds: readonly string[] } | null>(null);
  const motionClock = useRef(0);
  const motionNow = useCallback(() => motionClock.current, []);
  const models = useRef(new Map<string, MapModel>());
  const frame = useMemo(() => {
    const key = `${scope.kind}:${type}`;
    const previousModel = models.current.get(key);
    const next = buildMapModel(input, { scope, type, previous: previousModel, now } as Parameters<typeof buildMapModel>[1]);
    models.current.set(key, next);
    return { model: next, previousModel };
  }, [input, scope, type, now]);
  const { model, previousModel } = frame;
  const assets = useAssetReport();
  const onStats = useCallback((value: RenderStats) => setStats(value), [revision]);
  function reset(next = scope) {
    models.current.clear(); motionClock.current += 10000;
    setScope(next); setInput(fixture(next)); setNow(EPOCH); setStats(null); setType('taskland');
    setEffect(null); setMotion(null); setSelected(null); setFocusSurvey(false); setRevision(value => value + 1);
  }
  function change(action: string) {
    if (action === 'reset') { reset(); return; }
    setStats(null); setRevision(value => value + 1);
    if (action === 'mid-frame') { motionClock.current += 600; return; }
    if (action === 'settle') { motionClock.current += 10000; return; }
    motionClock.current += 10000;
    if (action === 'expire') { setNow(value => value + 24 * 60 * 60 * 1000); return; }
    const taskId = action.startsWith('root-') ? 'root' : action.endsWith('-review') ? 'review' : action === 'cancel' ? 'paused' : 'child';
    const status: Record<string, WorkStatus> = { working: 'working', review: 'in_review', blocked: 'blocked', ship: 'done',
      'root-done': 'done', 'root-blocked': 'blocked', 'root-cancel': 'cancelled', cancel: 'cancelled',
      'ship-review': 'done', 'reopen-review': 'in_review' };
    const taskEvents: GameTaskEvent[] = [];
    const envelope = { spaceId: 'synthetic-space', seq: revision + 1, occurredAt: new Date(now).toISOString(), schemaVersion: 1 };
    if (status[action]) taskEvents.push({ ...envelope, type: 'task.status_changed', taskId,
      from: input.entities.find(e => e.id === taskId)!.status as WorkStatus, to: status[action]! });
    if (action === 'progress' || action === 'review') taskEvents.push({ ...envelope, type: 'task.criterion_changed',
      taskId: 'child', criterionId: action === 'progress' ? 'criterion-2' : 'criterion-3', criterionText: 'Synthetic construction criterion',
      isDone: true, done: action === 'progress' ? 2 : 3, total: 4 });
    setEffect({ id: revision + 1, count: taskEvents.length, combined: false, entityIds: [taskId], taskEvents });
    setInput(previous => ({ ...previous, entities: previous.entities.map(e => {
      if (status[action] && e.id === taskId) return { ...e, status: status[action],
        ...(status[action] === 'cancelled' ? { cancelledAt: new Date(now).toISOString() } : {}),
        ...(action === 'review' ? { acceptance: { total: 4, completed: 3 } } : {}) };
      if (e.id !== 'child') return e;
      switch (action) {
        case 'progress': return { ...e, acceptance: { total: 4, completed: 2 } };
        case 'estimate': return { ...e, pointsEstimate: 3 };
        default: return e;
      }
    }) }));
  }
  const exposed = { buildHead: __TASKLAND_BUILD_HEAD__, model, previousModel, effect, motion, reducedMotion, motionTime: motionClock.current, revision, stats, assets, now, type, scope };
  Object.assign(window, { __tasklandHarness: exposed });
  return <div style={{ height: '100vh', background: '#101c24', color: '#e8eef3', fontFamily: 'system-ui' }}>
    <header style={{ padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>Synthetic Taskland verification</strong><span>Browser WebGL · GPU identity recorded by checker</span>
      <select aria-label="Scope" value={scope.kind} onChange={e => {
        const next: MapScope = { kind: e.target.value as MapScope['kind'], id: `synthetic-${e.target.value}` };
        reset(next);
      }}><option value="story">Story</option><option value="space">Space</option></select>
      <select aria-label="Map" value={type} onChange={e => { setType(e.target.value as typeof type); setStats(null); setRevision(value => value + 1); }}>
        <option value="taskland">Taskland</option><option value="town">Completed Town</option>
      </select>
      <label><input type="checkbox" checked={reducedMotion} onChange={e => {
        setReducedMotion(e.target.checked); setStats(null); setRevision(value => value + 1);
      }}/>Reduced motion</label>
      <button onClick={() => { setFocusSurvey(value => !value); setStats(null); setRevision(value => value + 1); }}>survey view</button>
      {['working','progress','review','blocked','estimate','ship','root-blocked','root-done','root-cancel','cancel','expire','ship-review','reopen-review','mid-frame','settle','reset'].map(action =>
        <button key={action} onClick={() => change(action)}>{action}</button>)}
    </header>
    <main data-testid="taskland-scene" style={{ position: 'relative', height: 'calc(100vh - 100px)' }}>
      <MapScene model={model} selectedEntityId={selected} onSelectEntity={setSelected} onStats={onStats}
        focus={focusSurvey ? model.places.find(p => p.entityId === 'child') : null} hierarchy
        {...{ previousModel, effect, motionNow, reducedMotion, onTasklandMotion: setMotion }}/>
    </main>
    <footer style={{ padding: '4px 20px' }}>Synthetic records · imported production assets · aggregate mailbox totals · no native GPU claim</footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

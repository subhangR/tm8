// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { DurableWorkspaceEvent, EntitySummary } from '@tm8/contract';
import type { WalkingMapViewProps } from '../story/game/maps/WalkingMapView';
import type { GameMapEvents, GameMapLoader } from './types';
import GameMode from './GameMode';

const scene = vi.hoisted(() => ({ props: null as WalkingMapViewProps | null, mounts: 0 }));
vi.mock('../story/game/maps/WalkingMapView', () => ({ WalkingMapView: (props: WalkingMapViewProps) => {
  scene.props = props;
  useEffect(() => { scene.mounts++; }, []);
  return <div className="sgm walking-map"><div className="sgm-stage"><canvas aria-label="Map canvas"/></div><div className="sgm-hud">
    <div className="walking-toolbar"><button>Back</button><button>Map overview</button></div>
    <details className="walking-places" open><summary>Places</summary><p>Inspect a place</p></details>
    <details className="walking-workers" open><summary>Workers</summary><p>Juniper · working</p></details>
    <div className="sgm-minimap"><button>Hide minimap</button><canvas style={{ width: 180, height: 180 }}/></div>
  </div><div>{props.model.scope.id}:{props.model.type}
    {props.model.portals.map(portal => <button key={portal.id} onClick={() => props.onEnterPortal(portal)}>{portal.label}</button>)}
    <button onClick={() => { props.onPosition(7, 8); props.onCamera({ zoom: 3, position: [1, 2, 3], target: [7, 0, 8] }); }}>Move player</button>
  </div></div>;
} }));
function harness() {
  const subs = new Set<(event: DurableWorkspaceEvent) => void>();
  const unsubscribed: ((event: DurableWorkspaceEvent) => void)[] = [];
  const events = { onEvent(cb: (event: DurableWorkspaceEvent) => void) { subs.add(cb); return () => { subs.delete(cb); unsubscribed.push(cb); }; },
    onResync: () => () => {}, liveness: { onChange: () => () => {}, statusOf: () => 'live' },
  } as unknown as GameMapEvents;
  const loadMap = vi.fn<GameMapLoader>(async scope => ({ title: 'My map', input: { scope, entities: [
    { id: 'task', kind: 'task', title: 'Build', status: 'working' },
    { id: 'session', kind: 'work_session', title: 'Juniper', processState: 'running', outcome: 'open', live: true },
    { id: 'story', kind: 'story', title: 'A story' },
  ], edges: [{ id: 'claim', type: 'working_on', fromId: 'session', toId: 'task', status: 'working' }] } }));
  let seq = 0;
  const event = (body: object) => ({ spaceId: 'space', seq: ++seq, occurredAt: '2026-10-08T00:00:00Z', schemaVersion: 1, ...body }) as DurableWorkspaceEvent;
  return { events, loadMap, subs, unsubscribed, event, emit: (body: object) => { const payload = event(body); subs.forEach(cb => cb(payload)); } };
}
beforeEach(() => { localStorage.clear(); scene.mounts = 0; scene.props = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('GameMode live event wiring', () => {
  it('keeps the announcement inside the map through below/above burst threshold and back', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = harness(); const screen = render(<GameMode spaceId="space" memberId="member" loadMap={h.loadMap} events={h.events} onInspect={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Taskland' }));
    await screen.findByText('space:taskland');
    const phases: { name: string; html: string }[] = [];
    const capture = (name: string) => {
      const map = screen.container.querySelector('.game-mode__map')!;
      expect(map.querySelector('[aria-live="polite"]')?.getAttribute('aria-atomic')).toBe('true');
      phases.push({ name, html: screen.container.innerHTML });
    };
    capture('empty');
    act(() => h.emit({ type: 'counter.changed', entityId: 'task', counters: { messages: 1 } }));
    await screen.findByText('1 map update'); capture('below');
    act(() => { for (let n = 2; n <= 6; n++) h.emit({ type: 'counter.changed', entityId: 'task', counters: { messages: n } }); });
    await screen.findByText('6 map updates in the last minute'); capture('above');
    now += 60_001;
    act(() => h.emit({ type: 'counter.changed', entityId: 'task', counters: { messages: 7 } }));
    await screen.findByText('1 map update'); capture('below-again');
    // Estimate visibility is authoritative row data, so its warning can appear
    // and disappear during a live update as well as during the initial read.
    const row = (version: number, state: object) => ({ id: 'task', kind: 'task', spaceId: 'space', title: 'Build', version,
      parentId: null, category: 'in_progress', counters: {}, badges: {}, state: { kind: 'task', status: 'working', ...state } });
    act(() => h.emit({ type: 'entity.upsert', entity: row(1, { weighted: { tent: false, size: 3, progress: .5 } }) }));
    await screen.findByText(/hide their estimate in an incomplete hierarchy/);
    expect(screen.container.querySelector('.game-mode__map details.game-mode__notice')).not.toBeNull();
    capture('warnings-added');
    act(() => h.emit({ type: 'entity.upsert', entity: row(2, { pointsEstimate: 3 }) }));
    await waitFor(() => expect(screen.queryByText('Map notices')).toBeNull());
    capture('warnings-cleared');
    // The DOM-only browser height regression consumes these actual component
    // snapshots with the production stylesheet, rather than JSDOM's zero rects.
    if (process.env.TM8_LIVE_NOTICE_LAYOUT_SNAPSHOTS) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.TM8_LIVE_NOTICE_LAYOUT_SNAPSHOTS, JSON.stringify(phases));
    }
    expect(h.loadMap).toHaveBeenCalledTimes(2);
  });
  it('updates workers without remounting the walking player or reapplying camera/save values', async () => {
    const h = harness(); const screen = render(<GameMode spaceId="space" memberId="member" loadMap={h.loadMap} events={h.events} onInspect={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Taskland' }));
    await screen.findByText('space:taskland');
    const mounts = scene.mounts, initial = scene.props!.start;
    fireEvent.click(screen.getByText('Move player'));
    act(() => h.emit({ type: 'session.process_changed', sessionId: 'session', from: 'running', to: 'idle' }));
    await waitFor(() => expect(scene.props!.model.robots[0]!.pose).toBe('idle'));
    expect(scene.props!.start).toEqual(initial);
    expect(scene.props!.camera).toBeUndefined(); expect(scene.mounts).toBe(mounts);
    expect(h.loadMap).toHaveBeenCalledTimes(2);
    act(() => { for (let n = 0; n < 20; n++) h.emit({ type: 'counter.changed', entityId: 'task', counters: { messages: n } }); });
    await waitFor(() => expect(scene.props!.model.places.find(place => place.id === 'task')?.mailbox?.count).toBe(19));
    expect(scene.mounts).toBe(mounts); expect(scene.props!.start).toEqual(initial); expect(scene.props!.camera).toBeUndefined();
    act(() => h.emit({ type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: 'completed' }));
    await waitFor(() => expect(scene.props!.model.robots).toHaveLength(0));
    expect(scene.props!.departures).toHaveLength(1);
  });
  it('aborts event callbacks from the previous map immediately on story navigation and account change', async () => {
    const h = harness(); const props = { spaceId: 'space', memberId: 'member', loadMap: h.loadMap, events: h.events, onInspect: vi.fn() };
    const screen = render(<GameMode {...props}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'A story' }));
    await screen.findByText('story:hub');
    expect(h.subs.size).toBe(1);
    act(() => h.unsubscribed[0]!(h.event({ type: 'entity.upsert', entity: { id: 'task', title: 'Stale' } as EntitySummary })));
    expect(scene.props!.model.scope.id).toBe('story');
    screen.rerender(<GameMode {...props} memberId="other"/>);
    await screen.findByText('space:hub');
    await waitFor(() => expect(h.subs.size).toBe(1));
    act(() => h.unsubscribed.at(-1)!(h.event({ type: 'session.outcome_changed', sessionId: 'session', from: 'open', to: 'completed' })));
    expect(scene.props!.model.scope.id).toBe('space');
    screen.unmount(); expect(h.subs.size).toBe(0);
  });
});

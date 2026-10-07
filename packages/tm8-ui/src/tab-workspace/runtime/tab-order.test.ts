/**
 * New tabs open right after the active tab (Kalai, 2026-10-07), the way a
 * browser does: an entity tab, a draft and the chooser alike. With nothing
 * active they go to the end.
 */
import { describe, expect, it } from 'vitest';

import { createWorkspaceRuntime } from './dispatch';
import { createWorkspaceStore } from './store';

let n = 0;
function runtime() {
  n += 1;
  const rt = createWorkspaceRuntime(`order-${n}`, `space-${n}`, createWorkspaceStore(`order-${n}`, `space-${n}`));
  rt.setHooks({ viewMounted: () => true, userTyping: () => false });
  return rt;
}

const tabFor = (rt: ReturnType<typeof runtime>, entityId: string) =>
  Object.values(rt.store.getState().tabs).find((t) => t.type === 'entity' && t.entityId === entityId)!.id;

describe('tab order', () => {
  it('appends while nothing is active, then inserts after the active tab', () => {
    const rt = runtime();
    for (const id of ['a', 'b', 'c']) rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: id }, source: 'click' });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => tabFor(rt, id));
    expect(rt.store.getState().orderedTabIds).toEqual([a, b, c]);

    rt.dispatch({ command: 'workspace.tabs.activate', args: { tabId: a }, source: 'click' });
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'd' }, source: 'click' });
    expect(rt.store.getState().orderedTabIds).toEqual([a, tabFor(rt, 'd'), b, c]);
  });

  it('a new draft and the chooser land next to the tab you were on', () => {
    const rt = runtime();
    for (const id of ['a', 'b']) rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: id }, source: 'click' });
    const [a, b] = ['a', 'b'].map((id) => tabFor(rt, id));
    rt.dispatch({ command: 'workspace.tabs.activate', args: { tabId: a }, source: 'click' });

    rt.dispatch({ command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' });
    const draft = rt.store.getState().orderedTabIds[1]!;
    expect(rt.store.getState().tabs[draft]?.type).toBe('draft');
    expect(rt.store.getState().orderedTabIds).toEqual([a, draft, b]);

    rt.dispatch({ command: 'workspace.chooser.open', args: {}, source: 'click' });
    const chooser = rt.store.getState().orderedTabIds[2]!;
    expect(rt.store.getState().tabs[chooser]?.type).toBe('chooser');
    expect(rt.store.getState().orderedTabIds).toEqual([a, draft, chooser, b]);
  });

  it('focusing a tab that is already open never moves it', () => {
    const rt = runtime();
    for (const id of ['a', 'b', 'c']) rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: id }, source: 'click' });
    const before = rt.store.getState().orderedTabIds;
    rt.dispatch({ command: 'workspace.tabs.activate', args: { tabId: before[0]! }, source: 'click' });
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'c' }, source: 'click' });
    expect(rt.store.getState().orderedTabIds).toEqual(before);
  });
});

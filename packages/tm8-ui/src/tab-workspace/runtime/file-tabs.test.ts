/**
 * Project file tabs in the UI runtime: the open API's preview replace and
 * pin, one tab per (project, path) across projects, the label that tells
 * same-named files apart, and the browser snapshot round-trip.
 */
import { describe, expect, it } from 'vitest';
import { fileTabDetail, openProjectFile, pinFileTab } from '../adapters/projectFile';
import { createWorkspaceRuntime } from './dispatch';
import { validTabsSnapshot } from './persistence';
import { activeTab } from './selectors';
import { createWorkspaceStore } from './store';
import type { FileTabRecord } from './types';

let n = 0;
function runtime() {
  n += 1;
  const rt = createWorkspaceRuntime(`files-${n}`, `space-${n}`, createWorkspaceStore(`files-${n}`, `space-${n}`));
  rt.setHooks({ viewMounted: () => true, userTyping: () => false });
  return rt;
}

const fileTabs = (rt: ReturnType<typeof runtime>) =>
  rt.store.getState().orderedTabIds.map((id) => rt.store.getState().tabs[id]).filter((t): t is FileTabRecord => t?.type === 'file');

describe('openProjectFile', () => {
  it('a preview open replaces the preview tab in place; a keep pins it', () => {
    const rt = runtime();
    openProjectFile(rt, { projectId: 'p1', path: 'src/a.ts' }, { preview: true });
    const [first] = fileTabs(rt);
    openProjectFile(rt, { projectId: 'p1', path: 'src/b.ts' }, { preview: true });
    expect(fileTabs(rt)).toEqual([expect.objectContaining({ id: first!.id, path: 'src/b.ts', preview: true })]);

    pinFileTab(rt, fileTabs(rt)[0]!);
    expect(fileTabs(rt)[0]).toMatchObject({ path: 'src/b.ts', preview: false });
    openProjectFile(rt, { projectId: 'p1', path: 'src/c.ts' }, { preview: true });
    expect(fileTabs(rt).map((t) => [t.path, t.preview])).toEqual([['src/b.ts', false], ['src/c.ts', true]]);
  });

  it('re-opening a file focuses its tab; a preview open never un-pins one', () => {
    const rt = runtime();
    openProjectFile(rt, { projectId: 'p1', path: 'a.ts' });
    openProjectFile(rt, { projectId: 'p1', path: 'b.ts' });
    openProjectFile(rt, { projectId: 'p1', path: 'a.ts' }, { preview: true });
    expect(fileTabs(rt)).toHaveLength(2);
    expect(activeTab(rt.store.getState())).toMatchObject({ path: 'a.ts', preview: false });
  });

  it('the same path in two projects is two tabs', () => {
    const rt = runtime();
    openProjectFile(rt, { projectId: 'p1', path: 'src/index.ts' });
    openProjectFile(rt, { projectId: 'p2', path: 'src/index.ts' });
    openProjectFile(rt, { projectId: 'p1', path: 'src/index.ts' });
    expect(fileTabs(rt).map((t) => t.projectId)).toEqual(['p1', 'p2']);
  });

  it('opens right after the active tab', () => {
    const rt = runtime();
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'e1' }, source: 'click' });
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'e2' }, source: 'click' });
    const [e1] = rt.store.getState().orderedTabIds;
    rt.dispatch({ command: 'workspace.tabs.activate', args: { tabId: e1! }, source: 'click' });
    openProjectFile(rt, { projectId: 'p1', path: 'a.ts' });
    expect(rt.store.getState().orderedTabIds.indexOf(fileTabs(rt)[0]!.id)).toBe(1);
  });
});

describe('fileTabDetail', () => {
  const a = { projectId: 'p1', path: 'src/files/index.ts' };
  it('is null for a unique name', () => {
    expect(fileTabDetail(a, [a, { projectId: 'p1', path: 'src/other.ts' }], 'tm8')).toBeNull();
  });
  it('names the folder for twins in one project, the project across projects', () => {
    expect(fileTabDetail(a, [a, { projectId: 'p1', path: 'src/panels/index.ts' }], 'tm8')).toBe('files');
    expect(fileTabDetail(a, [a, { projectId: 'p2', path: 'src/files/index.ts' }], 'tm8')).toBe('tm8');
    expect(
      fileTabDetail(a, [a, { projectId: 'p2', path: 'src/files/index.ts' }, { projectId: 'p1', path: 'x/index.ts' }], 'tm8'),
    ).toBe('tm8/files');
  });
});

describe('file tab snapshot', () => {
  const file = (id: string, projectId: string, path: string, preview: boolean) => ({ id, type: 'file', projectId, path, preview });

  it('round-trips file tabs next to entity tabs', () => {
    const raw = {
      v: 1,
      savedAt: 1,
      orderedTabIds: ['t1', 't2', 't3'],
      tabs: {
        t1: { id: 't1', type: 'entity', kind: 'task', entityId: 'e1' },
        t2: file('t2', 'p1', 'src/a.ts', true),
        t3: file('t3', 'p2', 'src/a.ts', false),
      },
      presentation: { surface: 'tab', tabId: 't2' },
      recency: ['t2', 't1'],
      rememberedActive: {},
    };
    const out = validTabsSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(out?.orderedTabIds).toEqual(['t1', 't2', 't3']);
    expect(out?.tabs['t2']).toEqual(file('t2', 'p1', 'src/a.ts', true));
    expect(out?.tabs['t3']).toEqual(file('t3', 'p2', 'src/a.ts', false));
    expect(out?.presentation).toEqual({ surface: 'tab', tabId: 't2' });
  });

  it('drops invalid and duplicate file tabs, and keeps one preview', () => {
    const out = validTabsSnapshot({
      v: 1,
      savedAt: 1,
      orderedTabIds: ['a', 'b', 'c', 'd', 'e'],
      tabs: {
        a: file('a', 'p1', 'x.ts', true),
        b: file('b', 'p1', 'x.ts', false),
        c: file('c', 'p1', '/etc/passwd', false),
        d: file('d', 'p1', 'y.ts', true),
        e: { id: 'e', type: 'file', projectId: 'p1' },
      },
      presentation: { surface: 'start' },
      recency: [],
      rememberedActive: {},
    });
    expect(out?.orderedTabIds).toEqual(['a', 'd']);
    expect(out?.tabs['d']).toMatchObject({ preview: false });
  });
});

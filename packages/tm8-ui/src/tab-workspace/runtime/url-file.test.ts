// @vitest-environment jsdom
/**
 * Project file tabs in the address (`?fp=<projectId>&f=<path>`): the codec
 * round-trips them, the active file tab writes them, and a deep link or
 * Back/Forward to one focuses its tab or opens it kept.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SpaceId } from '@tm8/contract';
import { build, defaultRoute, parse } from '../../routes/codec';
import type { NavView } from '../../routes/types';
import { navStore } from '../../stores/navStore';
import { createWorkspaceRuntime } from './dispatch';
import { activeTab } from './selectors';
import { createWorkspaceStore } from './store';
import { initUrlSync, workspaceFileView } from './url';

const FILE = { projectId: 'proj-1', path: 'packages/ui/src/a.test.ts' };

function hashOf(view: NavView): string {
  return build(defaultRoute('sp-a' as SpaceId, view)).hash;
}

let n = 0;
function runtime() {
  n += 1;
  const rt = createWorkspaceRuntime(`url-file-${n}`, `space-${n}`, createWorkspaceStore(`url-file-${n}`, `space-${n}`));
  rt.setHooks({ viewMounted: () => true, userTyping: () => false });
  return rt;
}

function setView(view: NavView): void {
  navStore.setState((s) => ({ view, history: 'push', revision: s.revision + 1 }));
}

const teardowns: Array<() => void> = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
  setView({ view: 'home' });
});

describe('file tab address: codec', () => {
  it('round-trips project and path, dots and slashes included', () => {
    const hash = hashOf(workspaceFileView(FILE));
    expect(hash).toMatch(/\/home\?.*fp=proj-1/);
    expect(parse(hash).route?.target).toEqual({ view: 'tabs', file: FILE });
  });

  it('drops a path a file tab may not hold (absolute, `..`)', () => {
    for (const bad of ['/etc/passwd', '../secret', 'a/../b']) {
      const hash = `#/s/sp-a/work?fp=proj-1&f=${encodeURIComponent(bad)}`;
      expect(parse(hash).route?.target).toEqual({ view: 'tabs' });
    }
  });

  it('an entity tab wins over a file in the same address', () => {
    const hash = '#/s/sp-a/work?tab=task-4f8c2a9e&fp=proj-1&f=a.ts';
    expect(parse(hash).route?.target).toEqual({ view: 'tabs', tab: 'task-4f8c2a9e' });
  });
});

describe('file tab address: sync', () => {
  it('the active file tab writes ?fp=&f=; an entity tab writes ?tab=', () => {
    const rt = runtime();
    setView({ view: 'tabs' });
    teardowns.push(initUrlSync(rt, { viewerId: 'v', spaceId: 's', routeTab: undefined, navigateView: setView }));
    rt.dispatch({ command: 'workspace.files.open', args: { ...FILE, preview: true }, source: 'click' });
    expect(navStore.getState().view).toEqual({ view: 'tabs', file: FILE });
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'task-4f8c2a9e' }, source: 'click' });
    expect(navStore.getState().view).toEqual({ view: 'tabs', tab: 'task-4f8c2a9e' });
  });

  it('a deep link opens the file as a kept tab', () => {
    const rt = runtime();
    setView({ view: 'tabs', file: FILE });
    teardowns.push(initUrlSync(rt, { viewerId: 'v', spaceId: 's', routeTab: undefined, routeFile: FILE, navigateView: setView }));
    expect(activeTab(rt.store.getState())).toMatchObject({ type: 'file', ...FILE, preview: false });
  });

  it('Back to an open preview file focuses it without pinning it', () => {
    const rt = runtime();
    setView({ view: 'tabs' });
    teardowns.push(initUrlSync(rt, { viewerId: 'v', spaceId: 's', routeTab: undefined, navigateView: setView }));
    rt.dispatch({ command: 'workspace.files.open', args: { ...FILE, preview: true }, source: 'click' });
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'task-4f8c2a9e' }, source: 'click' });
    setView({ view: 'tabs', file: FILE });
    expect(activeTab(rt.store.getState())).toMatchObject({ type: 'file', ...FILE, preview: true });
  });
});

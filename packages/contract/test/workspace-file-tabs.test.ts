/** File tabs: `workspace.files.open` and the stored-state sanitizer for `type: 'file'` records. */
import { describe, expect, it } from 'vitest';
import {
  defaultWorkspaceState,
  reduce,
  sanitizeWorkspaceState,
  type CommandEnvelope,
  type TabRecord,
  type WorkspaceHooks,
  type WorkspaceState,
} from '../src/workspace/index.js';

const SPACE = 'space-files';

function hooks(): WorkspaceHooks {
  let n = 0;
  return {
    deleteDraft: () => {},
    draftRevision: () => 0,
    toast: () => {},
    captureUi: () => undefined,
    canCreate: () => true,
    newId: () => `t${++n}`,
    openEntity: () => {},
    focusDraft: () => {},
    openDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    closeDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    showWorkspace: () => ({ status: 'rejected', reason: 'view_unavailable' }),
    viewMounted: () => true,
    userTyping: () => false,
  };
}

function run(state: WorkspaceState, h: WorkspaceHooks, command: CommandEnvelope['command'], args: unknown) {
  return reduce(state, { command, args, source: 'click' }, h);
}

const openFile = (state: WorkspaceState, h: WorkspaceHooks, args: Record<string, unknown>) =>
  run(state, h, 'workspace.files.open', args);

describe('workspace.files.open', () => {
  it('opens a kept file tab right after the active tab and activates it', () => {
    const h = hooks();
    let s = defaultWorkspaceState(SPACE);
    s = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'e1' }).state; // t1
    s = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'e2' }).state; // t2
    s = run(s, h, 'workspace.tabs.activate', { tabId: 't1' }).state;
    const r = openFile(s, h, { projectId: 'p1', path: 'src/a.ts' });
    expect(r.result).toMatchObject({ status: 'applied', outcome: 'created', tabId: 't3' });
    expect(r.state.orderedTabIds).toEqual(['t1', 't3', 't2']);
    expect(r.state.presentation).toEqual({ surface: 'tab', tabId: 't3' });
    expect(r.state.tabs.t3).toEqual({ id: 't3', type: 'file', projectId: 'p1', path: 'src/a.ts', preview: false });
  });

  it('a preview open replaces the one preview tab; a kept tab is never replaced', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'keep.ts' }).state; // t1 kept
    s = openFile(s, h, { projectId: 'p1', path: 'a.ts', preview: true }).state; // t2 preview
    const r = openFile(s, h, { projectId: 'p1', path: 'b.ts', preview: true });
    expect(r.result.outcome).toBe('reused');
    expect(r.state.orderedTabIds).toEqual(['t1', 't2']);
    expect(r.state.tabs.t2).toMatchObject({ type: 'file', path: 'b.ts', preview: true });
    expect(r.state.tabs.t1).toMatchObject({ path: 'keep.ts', preview: false });
  });

  it('a keep open of the previewed file pins it; the next preview then opens a new tab', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'a.ts', preview: true }).state; // t1
    const pinned = openFile(s, h, { projectId: 'p1', path: 'a.ts' });
    expect(pinned.result).toMatchObject({ tabId: 't1', outcome: 'focused', status: 'applied' });
    s = pinned.state;
    expect(s.tabs.t1).toMatchObject({ preview: false });
    s = openFile(s, h, { projectId: 'p1', path: 'b.ts', preview: true }).state;
    expect(s.orderedTabIds).toEqual(['t1', 't2']);
    expect(s.tabs.t2).toMatchObject({ path: 'b.ts', preview: true });
  });

  it('re-opening an open file focuses the existing tab (a preview open never un-pins it)', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'a.ts' }).state; // t1
    s = openFile(s, h, { projectId: 'p1', path: 'b.ts' }).state; // t2
    const r = openFile(s, h, { projectId: 'p1', path: 'a.ts', preview: true });
    expect(r.result).toMatchObject({ tabId: 't1', outcome: 'focused' });
    expect(r.state.orderedTabIds).toEqual(['t1', 't2']);
    expect(r.state.tabs.t1).toMatchObject({ preview: false });
    expect(r.state.presentation).toEqual({ surface: 'tab', tabId: 't1' });
  });

  it('keys tabs on (project, path): the same path in two projects is two tabs', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'README.md' }).state;
    s = openFile(s, h, { projectId: 'p2', path: 'README.md' }).state;
    expect(s.orderedTabIds).toHaveLength(2);
  });

  it('file tabs are visible under every scope', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'a.ts' }).state;
    s = run(s, h, 'workspace.tabScope.set', { mode: 'byType', selectedTypeIds: ['doc'] }).state;
    expect(s.presentation).toEqual({ surface: 'tab', tabId: 't1' });
  });

  it('closes and moves like any tab', () => {
    const h = hooks();
    let s = openFile(defaultWorkspaceState(SPACE), h, { projectId: 'p1', path: 'a.ts' }).state;
    s = openFile(s, h, { projectId: 'p1', path: 'b.ts' }).state;
    s = run(s, h, 'workspace.tabs.move', { tabId: 't2', beforeTabId: 't1' }).state;
    expect(s.orderedTabIds).toEqual(['t2', 't1']);
    s = run(s, h, 'workspace.tabs.close', { tabId: 't2' }).state;
    expect(s.orderedTabIds).toEqual(['t1']);
    expect(s.presentation).toEqual({ surface: 'tab', tabId: 't1' });
  });

  it('rejects malformed args', () => {
    const s = defaultWorkspaceState(SPACE);
    for (const args of [
      {},
      { projectId: '', path: 'a' },
      { projectId: 'p', path: '' },
      { projectId: 'p', path: '/etc/passwd' },
      { projectId: 'p', path: 'C:\\x' },
      { projectId: 'p', path: 'a\0b' },
      { projectId: 'p', path: '../secret' },
      { projectId: 'p', path: 'a//b' },
      { projectId: 'p', path: 'a/./b' },
      { projectId: 'p', path: 'x'.repeat(4097) },
      { projectId: 'p', path: 'a', preview: 'yes' },
    ]) {
      expect(openFile(s, hooks(), args).result).toMatchObject({ status: 'rejected', reason: 'invalid_arguments' });
    }
  });
});

describe('sanitizeWorkspaceState file tabs', () => {
  const withTabs = (tabs: Record<string, unknown>) => ({
    ...defaultWorkspaceState(SPACE),
    orderedTabIds: Object.keys(tabs),
    tabs,
  });

  it('keeps a valid file tab, coercing preview to a boolean', () => {
    const out = sanitizeWorkspaceState(
      withTabs({
        a: { id: 'a', type: 'file', projectId: 'p1', path: 'src/a.ts', preview: true, extra: 'dropped' },
        b: { id: 'b', type: 'file', projectId: 'p1', path: 'b.ts', preview: 'yes' },
      }),
      SPACE,
    );
    expect(out?.orderedTabIds).toEqual(['a', 'b']);
    expect(out?.tabs.a).toEqual<TabRecord>({ id: 'a', type: 'file', projectId: 'p1', path: 'src/a.ts', preview: true });
    expect(out?.tabs.b).toMatchObject({ preview: false });
  });

  it('drops a file tab missing its projectId or path, or with a bad path', () => {
    const out = sanitizeWorkspaceState(
      withTabs({
        a: { id: 'a', type: 'file', path: 'a.ts', preview: false },
        b: { id: 'b', type: 'file', projectId: 'p1', preview: false },
        c: { id: 'c', type: 'file', projectId: 'p1', path: '/abs', preview: false },
        d: { id: 'd', type: 'file', projectId: 'p1', path: 'nul\0', preview: false },
        e: { id: 'e', type: 'file', projectId: 7, path: 'a.ts', preview: false },
        ok: { id: 'ok', type: 'file', projectId: 'p1', path: 'ok.ts', preview: false },
      }),
      SPACE,
    );
    expect(out?.orderedTabIds).toEqual(['ok']);
  });
});

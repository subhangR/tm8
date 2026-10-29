/** At the hard cap an open closes the least recently used tabs instead of refusing (task 01a185ec). */
import { describe, expect, it } from 'vitest';
import {
  defaultWorkspaceState,
  evictLeastRecent,
  reduce,
  WORKSPACE_TAB_HARD_CAP,
  type CommandEnvelope,
  type WorkspaceHooks,
  type WorkspaceState,
} from '../src/workspace/index.js';

const SPACE = 'space-evict';

function hooks(deleted: string[] = []): WorkspaceHooks {
  let n = 0;
  return {
    deleteDraft: (draftId) => void deleted.push(draftId),
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

/** `count` entity tabs t1..tN, opened in order, so t1 is the least recently used. */
function full(h: WorkspaceHooks, count = WORKSPACE_TAB_HARD_CAP): WorkspaceState {
  let s = defaultWorkspaceState(SPACE);
  for (let i = 1; i <= count; i++) s = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: `e${i}` }).state;
  return s;
}

describe('LRU eviction at the hard cap', () => {
  it('opening one past the cap closes the least recently used tab', () => {
    const h = hooks();
    const s = full(h);
    expect(s.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
    const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'new' });
    expect(r.result).toMatchObject({ status: 'applied', outcome: 'created', evictedTabIds: ['t1'] });
    expect(r.state.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
    expect(r.state.tabs.t1).toBeUndefined();
    expect(r.state.recency).not.toContain('t1');
    expect(r.state.presentation).toEqual({ surface: 'tab', tabId: r.result.tabId });
  });

  it('recency, not tab order, picks the tab: a re-activated old tab survives', () => {
    const h = hooks();
    let s = full(h);
    s = run(s, h, 'workspace.tabs.activate', { tabId: 't1' }).state;
    s = run(s, h, 'workspace.tabs.activate', { tabId: 't50' }).state;
    const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'new' });
    expect(r.result.evictedTabIds).toEqual(['t2']);
    expect(r.state.tabs.t1).toBeDefined();
  });

  it('a background open counts as a use: it joins recency behind the active tab and never evicts itself', () => {
    const h = hooks();
    const s = full(h);
    const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'bg', activate: false });
    expect(r.result.evictedTabIds).toEqual(['t1']);
    expect(r.state.recency.slice(0, 2)).toEqual(['t50', r.result.tabId]);
    expect(r.state.presentation).toEqual({ surface: 'tab', tabId: 't50' });
  });

  it('a stream of background opens evicts the oldest opened, not the one before it', () => {
    const h = hooks();
    let s = defaultWorkspaceState(SPACE);
    const evicted: string[] = [];
    for (let i = 1; i <= WORKSPACE_TAB_HARD_CAP + 2; i++) {
      const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: `e${i}`, activate: false });
      evicted.push(...(r.result.evictedTabIds ?? []));
      s = r.state;
    }
    expect(evicted).toEqual(['t1', 't2']);
    expect(s.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
  });

  it('a dirty draft is skipped; a clean one goes and its stored values with it', () => {
    const deleted: string[] = [];
    const h = hooks(deleted);
    let s = defaultWorkspaceState(SPACE);
    s = run(s, h, 'workspace.drafts.open', { kind: 'task' }).state; // t1, the oldest
    const dirtyId = s.orderedTabIds[0]!;
    const dirty = s.tabs[dirtyId]!;
    s = { ...s, tabs: { ...s.tabs, [dirtyId]: { ...dirty, dirty: true } as typeof dirty } };
    s = run(s, h, 'workspace.drafts.open', { kind: 'doc' }).state; // the next oldest, clean
    const cleanId = s.orderedTabIds.find((id) => id !== dirtyId)!;
    const clean = s.tabs[cleanId]!;
    for (let i = 3; i <= WORKSPACE_TAB_HARD_CAP; i++) s = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: `e${i}` }).state;
    expect(s.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
    const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'new' });
    expect(r.result.evictedTabIds).toEqual([cleanId]);
    expect(r.state.tabs[dirtyId]).toBeDefined();
    for (const c of r.commits) for (const after of c.after) after();
    expect(deleted).toEqual([clean.type === 'draft' ? clean.draftId : '']);
  });

  it('below the cap nothing is evicted and the result carries no evictedTabIds', () => {
    const h = hooks();
    const s = full(h, WORKSPACE_TAB_HARD_CAP - 1);
    const r = run(s, h, 'workspace.tabs.open', { kind: 'task', entityId: 'new' });
    expect(r.state.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
    expect(r.result.evictedTabIds).toBeUndefined();
  });

  it('evict: false leaves the list over the cap for a caller that evicts once', () => {
    const h = hooks();
    const s = full(h);
    const r = reduce(s, { command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'new' }, source: 'click' }, h, { evict: false });
    expect(r.state.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP + 1);
  });

  it('evictLeastRecent never closes a tab the batch opened, nor the active one', () => {
    const h = hooks();
    const before = full(h, WORKSPACE_TAB_HARD_CAP - 1);
    let s = before;
    for (const id of ['n1', 'n2', 'n3']) {
      s = reduce(s, { command: 'workspace.tabs.open', args: { kind: 'task', entityId: id, activate: false }, source: 'click' }, h, { evict: false }).state;
    }
    const active = before.presentation.surface === 'tab' ? before.presentation.tabId : '';
    const out = evictLeastRecent(before, s, WORKSPACE_TAB_HARD_CAP, h);
    expect(out.evicted).toEqual(['t1', 't2']);
    expect(out.next.orderedTabIds).toHaveLength(WORKSPACE_TAB_HARD_CAP);
    expect(out.next.tabs[active]).toBeDefined();
    // Only the active tab and the batch's own: nothing may go, and the caller refuses.
    const lone = full(h, 1);
    let many = lone;
    for (let i = 0; i < WORKSPACE_TAB_HARD_CAP; i++) {
      many = reduce(many, { command: 'workspace.tabs.open', args: { kind: 'task', entityId: `b${i}`, activate: false }, source: 'click' }, h, { evict: false }).state;
    }
    const none = evictLeastRecent(lone, many, WORKSPACE_TAB_HARD_CAP, h);
    expect(none.evicted).toEqual([]);
    expect(none.next).toBe(many);
  });
});

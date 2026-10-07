/**
 * The window's sync with the stored workspace (Spec D §3): local-first
 * commits sent with their ids, rebase on the node's state with this window's
 * own active tab kept, rollback with a notice, the one-time import, and the
 * local fallback when another window closes the tab this one is showing.
 * And multiple workspaces (API doc 01a115c4 §7.6, decision E's S10 cases):
 * per-workspace queues, the switch, and the capless protocol until proof.
 */
import { describe, expect, it } from 'vitest';
import { reduce, toStoredState, type WorkspaceHooks, type WorkspaceState } from '@tm8/contract/workspace';

import { createWorkspaceRuntime } from '../runtime/dispatch';
import { flushDraftValues } from '../runtime/draftStore';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceSync, type SyncIo } from './sync';

const SPACE = 'space-sync';
let n = 0;

function setup(legacy: Partial<WorkspaceState> | null = null, extra: Partial<SyncIo> = {}) {
  n += 1;
  const runtime = createWorkspaceRuntime(`viewer-${n}`, SPACE, createWorkspaceStore(`viewer-${n}`, SPACE));
  const sent: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  let serverMode = false;
  const sync = new WorkspaceSync(runtime, SPACE, 'win-1', {
    send: (frame) => void sent.push(frame as unknown as Record<string, unknown>) || true,
    notify: (text) => void notices.push(text),
    onServerMode: () => void (serverMode = true),
    legacy: () => ({ state: legacy, rail: null }),
    ...extra,
  });
  return { runtime, sync, sent, notices, isServerMode: () => serverMode };
}

/** The node's view: replay a window's command with its ids, as the service does. */
function nodeApply(state: WorkspaceState, env: unknown, ids: string[]): WorkspaceState {
  const queue = [...ids];
  const hooks = {
    deleteDraft: () => {}, draftRevision: () => 0, toast: () => {}, captureUi: () => undefined, canCreate: () => true,
    newId: () => queue.shift() ?? 'minted-on-node', openEntity: () => {}, focusDraft: () => {},
    openDialog: () => ({ status: 'rejected' }), closeDialog: () => ({ status: 'rejected' }), showWorkspace: () => ({ status: 'rejected' }),
    viewMounted: () => true, userTyping: () => false,
  } as unknown as WorkspaceHooks;
  return toStoredState(reduce(state, env as never, hooks).state);
}

const open = (entityId: string) => ({ command: 'workspace.tabs.open', args: { kind: 'task', entityId }, source: 'click' }) as const;

describe('WorkspaceSync', () => {
  it('holds local commits until the node answers, then sends them with the ids they minted', () => {
    const { runtime, sync, sent, isServerMode } = setup();
    runtime.dispatch(open('e1'));
    expect(sent).toEqual([]);
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 0, state: null });
    expect(isServerMode()).toBe(true);
    // The import carried e1 (it is this window's state); nothing is re-sent.
    expect(sent.map((f) => f['type'])).toEqual(['workspace.import']);
    runtime.dispatch(open('e2'));
    const apply = sent.at(-1)!;
    expect(apply).toMatchObject({ type: 'workspace.apply', instanceId: 'win-1', env: { command: 'workspace.tabs.open' } });
    expect((apply['ids'] as string[]).length).toBe(1);
    expect(runtime.store.getState().tabs[(apply['ids'] as string[])[0]!]).toBeDefined();
  });

  it('rebases on the node’s state, keeps its own active tab and re-applies what is in flight', () => {
    const { runtime, sync, sent } = setup();
    const base = { ...runtime.store.getState() };
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 3, state: toStoredState(base) as never });
    runtime.dispatch(open('mine'));
    const mine = sent.at(-1)!;
    // Meanwhile another window opened something else; the node pushes that.
    const otherIds = ['other-tab'];
    const fromOther = nodeApply({ ...base, revision: 3 }, { ...open('theirs'), args: { kind: 'task', entityId: 'theirs', activate: false } }, otherIds);
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 4, state: { ...fromOther, revision: 4 } as never });
    const after = runtime.store.getState();
    expect(after.orderedTabIds).toContain('other-tab');
    const myTab = (mine['ids'] as string[])[0]!;
    expect(after.orderedTabIds).toContain(myTab);
    expect(after.presentation).toEqual({ surface: 'tab', tabId: myTab });
    // The node confirms mine: no change in what the window shows.
    const confirmed = nodeApply({ ...fromOther, revision: 4 }, mine['env'], mine['ids'] as string[]);
    sync.onFrame({
      type: 'workspace.state', spaceId: SPACE, revision: 5, state: { ...confirmed, revision: 5 } as never,
      cause: { instanceId: 'win-1', requestId: mine['requestId'] as string, result: { status: 'applied' } },
    });
    expect(runtime.store.getState().orderedTabIds).toEqual(after.orderedTabIds);
    expect(runtime.store.getState().presentation).toEqual({ surface: 'tab', tabId: myTab });
  });

  it('rolls a refused command back, with a notice', () => {
    const { runtime, sync, sent, notices } = setup();
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 1, state: toStoredState(runtime.store.getState()) as never });
    runtime.dispatch(open('e1'));
    expect(runtime.store.getState().orderedTabIds).toHaveLength(1);
    sync.onFrame({ type: 'workspace.applied', spaceId: SPACE, requestId: sent.at(-1)!['requestId'] as string, result: { status: 'rejected', reason: 'tab_limit' } });
    expect(runtime.store.getState().orderedTabIds).toHaveLength(0);
    expect(notices).toEqual(['Couldn’t open that tab: your workspace changed elsewhere']);
  });

  it('imports the browser’s legacy state once, only into an empty workspace', () => {
    const legacyTab = { id: 'legacy', type: 'entity' as const, kind: 'task', entityId: 'e-old', ui: { subview: 'entity' as const } };
    const { sync, sent } = setup({ orderedTabIds: ['legacy'], tabs: { legacy: legacyTab } });
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 0, state: null });
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 0, state: null });
    const imports = sent.filter((f) => f['type'] === 'workspace.import');
    expect(imports).toHaveLength(1);
    expect((imports[0]!['state'] as WorkspaceState).orderedTabIds).toEqual(['legacy']);
  });

  it('falls back locally when another window closes the tab this one shows', () => {
    const { runtime, sync, sent } = setup();
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 1, state: toStoredState(runtime.store.getState()) as never });
    runtime.dispatch(open('a'));
    runtime.dispatch(open('b'));
    const state = runtime.store.getState();
    const [a, b] = state.orderedTabIds;
    expect(state.presentation).toEqual({ surface: 'tab', tabId: b });
    // The node confirms both opens…
    const shared = toStoredState({ ...state, revision: 3 });
    sync.onFrame({
      type: 'workspace.state', spaceId: SPACE, revision: 3, state: shared as never,
      cause: { instanceId: 'win-1', requestId: sent.at(-1)!['requestId'] as string, result: { status: 'applied' } },
    });
    // …then another window closes `b`.
    const closed = nodeApply(shared, { command: 'workspace.tabs.close', args: { tabId: b }, source: 'click' }, []);
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 4, state: { ...closed, revision: 4 } as never });
    expect(runtime.store.getState().orderedTabIds).toEqual([a]);
    expect(runtime.store.getState().presentation).toEqual({ surface: 'tab', tabId: a });
  });
});

/** A capable node's state frame for one workspace. */
const stateOf = (workspaceId: string | null, revision: number, state: WorkspaceState | null, extra: Record<string, unknown> = {}) =>
  ({ type: 'workspace.state', spaceId: SPACE, revision, state, workspaceId, active: true, ...extra }) as never;
const switched = (workspaceId: string, previousWorkspaceId: string | null) =>
  ({ type: 'workspace.switched', spaceId: SPACE, workspaceId, previousWorkspaceId, listRevision: 2, at: '2026-10-07T00:00:00Z' }) as const;
const applies = (sent: Array<Record<string, unknown>>) => sent.filter((f) => f['type'] === 'workspace.apply');

/** A window showing workspace A (capable), and B's stored state with one tab. */
function onA() {
  const ctx = setup();
  const empty = toStoredState(ctx.runtime.store.getState());
  ctx.sync.onFrame(stateOf('A', 1, empty));
  const b = nodeApply({ ...empty, revision: 1 }, open('in-b'), ['b-tab']);
  return { ...ctx, empty, b };
}

describe('WorkspaceSync, multiple workspaces (S10)', () => {
  it('a click in A during a switch lands in A and is never replayed on B', () => {
    const { runtime, sync, sent, b } = onA();
    sync.onFrame(switched('B', 'A'));
    // B's state has not landed: the window still shows A, so the click is A's.
    runtime.dispatch(open('during'));
    const during = applies(sent).at(-1)!;
    expect(during).toMatchObject({ workspaceId: 'A' });
    const duringTab = (during['ids'] as string[])[0]!;
    expect(runtime.store.getState().orderedTabIds).toContain(duringTab);
    sync.onFrame(stateOf('B', 1, b));
    expect(sync.shown).toBe('B');
    expect(runtime.store.getState().orderedTabIds).toEqual(['b-tab']);
    expect(runtime.store.getState().presentation).toEqual({ surface: 'tab', tabId: 'b-tab' });
    // Another state for B, and a reconnect: still never on B's base, still addressed to A.
    sync.onFrame(stateOf('B', 2, { ...b, revision: 2 }));
    expect(runtime.store.getState().orderedTabIds).toEqual(['b-tab']);
    sent.length = 0;
    sync.reconnected();
    expect(applies(sent)).toEqual([expect.objectContaining({ requestId: during['requestId'], workspaceId: 'A' })]);
  });

  it('a state for a workspace not on screen confirms only its own queue', () => {
    const { runtime, sync, sent, empty, b } = onA();
    runtime.dispatch(open('in-a'));
    const inA = applies(sent).at(-1)!;
    sync.onFrame(switched('B', 'A'));
    sync.onFrame(stateOf('B', 1, b));
    runtime.dispatch(open('in-b-2'));
    const inB = applies(sent).at(-1)!;
    expect(inB).toMatchObject({ workspaceId: 'B' });
    const shownBefore = runtime.store.getState().orderedTabIds;
    // A state for A naming B's request confirms nothing of B's…
    const a = nodeApply({ ...empty, revision: 1 }, inA['env'], inA['ids'] as string[]);
    sync.onFrame(stateOf('A', 2, { ...a, revision: 2 }, {
      active: false, cause: { instanceId: 'win-1', requestId: inB['requestId'], result: { status: 'applied' } },
    }));
    // …and is never rendered.
    expect(runtime.store.getState().orderedTabIds).toEqual(shownBefore);
    sent.length = 0;
    sync.reconnected();
    expect(applies(sent).map((f) => f['requestId'])).toEqual([inA['requestId'], inB['requestId']]);
    // A state for A naming A's request confirms it.
    sync.onFrame(stateOf('A', 3, { ...a, revision: 3 }, {
      active: false, cause: { instanceId: 'win-1', requestId: inA['requestId'], result: { status: 'applied' } },
    }));
    expect(runtime.store.getState().orderedTabIds).toEqual(shownBefore);
    sent.length = 0;
    sync.reconnected();
    expect(applies(sent).map((f) => f['requestId'])).toEqual([inB['requestId']]);
  });

  it('a reconnect resends every queue, each with its own workspaceId', () => {
    const { runtime, sync, sent, b } = onA();
    runtime.dispatch(open('a1'));
    runtime.dispatch(open('a2'));
    sync.onFrame(switched('B', 'A'));
    sync.onFrame(stateOf('B', 1, b));
    runtime.dispatch(open('b1'));
    sent.length = 0;
    sync.reconnected();
    expect(applies(sent).map((f) => [(f['env'] as { args: { entityId: string } }).args.entityId, f['workspaceId']])).toEqual([
      ['a1', 'A'],
      ['a2', 'A'],
      ['b1', 'B'],
    ]);
  });

  it('keeps the capless protocol until a state carries workspaceId', () => {
    let capable = 0;
    const { runtime, sync, sent } = setup(null, { onCapable: () => void (capable += 1) });
    runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' } as never);
    // An old node's state: no workspaceId key at all.
    sync.onFrame({ type: 'workspace.state', spaceId: SPACE, revision: 1, state: toStoredState(runtime.store.getState()) } as never);
    runtime.dispatch(open('old'));
    const draftId = Object.values(runtime.store.getState().tabs).find((t) => t.type === 'draft')!;
    runtime.drafts.set((draftId as { draftId: string }).draftId, { title: 'x' });
    flushDraftValues();
    expect(sync.registerFields()).toEqual({});
    expect(capable).toBe(0);
    for (const frame of sent) expect(frame).not.toHaveProperty('workspaceId');
    expect(sent.map((f) => f['type'])).toEqual(expect.arrayContaining(['workspace.apply', 'workspace.draft.patch']));
    // The proof: from here on, caps and addresses.
    sync.onFrame(stateOf('W', 2, toStoredState({ ...runtime.store.getState(), revision: 2 })));
    expect(capable).toBe(1);
    expect(sync.registerFields()).toEqual({ caps: ['multiWorkspace'], workspaceId: 'W' });
    runtime.dispatch(open('new'));
    expect(applies(sent).at(-1)).toMatchObject({ workspaceId: 'W' });
  });
});

describe('WorkspaceSync, notices for a workspace not on screen (S14)', () => {
  it('names the workspace a rollback or a draft deletion happened in', () => {
    const elsewhere: string[] = [];
    const ctx = setup(null, { notifyDraftElsewhere: (_id, name) => void elsewhere.push(name) });
    const { runtime, sync, sent, notices } = ctx;
    const empty = toStoredState(runtime.store.getState());
    sync.onFrame(stateOf('A', 1, empty));
    sync.onFrame({
      type: 'workspace.summary', spaceId: SPACE, listRevision: 1, activeWorkspaceId: 'A',
      items: [{ id: 'A', name: 'Billing' }, { id: 'B', name: 'Main' }] as never,
    });
    runtime.dispatch(open('in-billing'));
    const inA = applies(sent).at(-1)!;
    sync.onFrame(switched('B', 'A'));
    sync.onFrame(stateOf('B', 1, nodeApply({ ...empty, revision: 1 }, open('in-main'), ['b-tab'])));
    sync.onFrame({ type: 'workspace.applied', spaceId: SPACE, requestId: inA['requestId'] as string, workspaceId: 'A', result: { status: 'rejected', reason: 'tab_limit' } });
    expect(notices).toEqual(['Couldn’t open that tab: your workspace changed elsewhere in Billing']);
    // The rollback is A's: what B shows is untouched.
    expect(runtime.store.getState().orderedTabIds).toEqual(['b-tab']);
    // A draft of Billing's: its values are ignored, its deletion is named.
    sync.onFrame({ type: 'workspace.draft', spaceId: SPACE, workspaceId: 'A', draftId: 'd1', revision: 1, fields: { title: { v: 'x', r: 1 } } });
    expect(elsewhere).toEqual([]);
    sync.onFrame({ type: 'workspace.draft', spaceId: SPACE, workspaceId: 'A', draftId: 'd1', revision: 2, deleted: true, sourceInstanceId: 'other' });
    expect(elsewhere).toEqual(['Billing']);
  });
});

describe('WorkspaceSync, a draft the node would not keep (W3.2)', () => {
  it('names the workspace and drops this window’s copy', () => {
    const { runtime, sync, notices } = setup();
    sync.onFrame(stateOf('A', 1, toStoredState(runtime.store.getState())));
    sync.onFrame({
      type: 'workspace.summary', spaceId: SPACE, listRevision: 1, activeWorkspaceId: 'A',
      items: [{ id: 'A', name: 'Billing' }] as never,
    });
    runtime.drafts.set('d1', { title: 'too much' });
    sync.onFrame({ type: 'workspace.draft.rejected', spaceId: SPACE, workspaceId: 'A', draftId: 'd1', reason: 'payload_too_large' });
    expect(notices).toEqual(['Couldn’t save a draft in Billing: it is too large']);
    expect(runtime.drafts.get('d1')).toBeNull();
  });
});

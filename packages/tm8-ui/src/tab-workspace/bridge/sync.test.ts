/**
 * The window's sync with the stored workspace (Spec D §3): local-first
 * commits sent with their ids, rebase on the node's state with this window's
 * own active tab kept, rollback with a notice, the one-time import, and the
 * local fallback when another window closes the tab this one is showing.
 */
import { describe, expect, it } from 'vitest';
import { reduce, toStoredState, type WorkspaceHooks, type WorkspaceState } from '@tm8/contract/workspace';

import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceSync } from './sync';

const SPACE = 'space-sync';
let n = 0;

function setup(legacy: Partial<WorkspaceState> | null = null) {
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

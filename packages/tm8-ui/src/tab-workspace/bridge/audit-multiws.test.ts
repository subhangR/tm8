/**
 * AUDIT (task 01a1181c, 2026-10-07) — FAILING tests that prove defects in the
 * shipped multiple-workspaces window sync (PR #1103, e71efecdc). Each test
 * states the behaviour the design asks for; on e71efecdc every one FAILS.
 * They are evidence for the findings doc, not a fix. Ids F1… match the doc.
 *
 * The frames each test feeds are exactly the frames the node sends for that
 * scenario on e71efecdc (see packages/server/test/workspace/audit-multiws.pg.test.ts
 * for the server half, proven against a real database).
 */
import { describe, expect, it } from 'vitest';
import { reduce, toStoredState, type WorkspaceHooks, type WorkspaceState } from '@tm8/contract/workspace';
import type { WorkspaceSummary } from '@tm8/contract';

import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceSync, type SyncIo, type WorkspaceView } from './sync';

const SPACE = 'space-audit';
let n = 0;

function setup(extra: Partial<SyncIo> = {}) {
  n += 1;
  const runtime = createWorkspaceRuntime(`audit-viewer-${n}`, SPACE, createWorkspaceStore(`audit-viewer-${n}`, SPACE));
  const sent: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const views: WorkspaceView[] = [];
  const sync = new WorkspaceSync(runtime, SPACE, 'win-1', {
    send: (frame) => void sent.push(frame as unknown as Record<string, unknown>) || true,
    notify: (text) => void notices.push(text),
    legacy: () => ({ state: null, rail: null }),
    onWorkspaces: (view) => void views.push(view),
    ...extra,
  });
  const view = () => views.at(-1)!;
  return { runtime, sync, sent, notices, view };
}

/** The node's view: replay a command with its ids, as the service does. */
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
const stateOf = (workspaceId: string | null, revision: number, state: WorkspaceState | null, extra: Record<string, unknown> = {}) =>
  ({ type: 'workspace.state', spaceId: SPACE, revision, state: state ? { ...state, revision } : null, workspaceId, active: true, ...extra }) as never;
const applies = (sent: Array<Record<string, unknown>>) => sent.filter((f) => f['type'] === 'workspace.apply');

function summary(id: string, name: string, active: boolean, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id, name, color: null, position: 0, active, revision: 1, tabCount: 0, draftCount: 0, dirtyDraftCount: 0,
    createdAt: '2026-10-07T00:00:00.000Z', createdBy: null, agentChangedSinceActive: false, lastAgentChange: null, ...extra,
  };
}
const summaryFrame = (listRevision: number, activeWorkspaceId: string, items: WorkspaceSummary[], cause?: Record<string, unknown>) =>
  ({ type: 'workspace.summary', spaceId: SPACE, listRevision, activeWorkspaceId, items, ...(cause ? { cause } : {}) }) as never;

const countOf = (view: WorkspaceView, id: string) => view.items.find((w) => w.id === id)?.tabCount;

describe('AUDIT F1 — the switcher’s tab count goes stale after a tab is opened (stale numbers, root cause)', () => {
  /** A capable window showing A (empty), with the list {A: 0 tabs, B: 0 tabs} from the node. */
  function onA() {
    const ctx = setup();
    const empty = toStoredState(ctx.runtime.store.getState());
    ctx.sync.onFrame(stateOf('A', 1, empty));
    ctx.sync.onFrame(summaryFrame(1, 'A', [summary('A', 'Main', true), summary('B', 'Review', false, { position: 1 })]));
    expect(countOf(ctx.view(), 'A')).toBe(0);
    return { ...ctx, empty };
  }

  it('F1a: this window opens a tab; the node confirms it with workspace.state only — the count must follow', () => {
    const { runtime, sync, sent, empty, view } = onA();
    runtime.dispatch(open('e1'));
    const apply = applies(sent).at(-1)!;
    // What service.apply pushes for a window write to the active workspace: one
    // workspace.state (no workspace.summary — service.ts:692 only sends one for
    // an agent's write to a NON-active workspace).
    const confirmed = nodeApply({ ...empty, revision: 1 }, apply['env'], apply['ids'] as string[]);
    sync.onFrame(stateOf('A', 2, confirmed, { cause: { instanceId: 'win-1', requestId: apply['requestId'], result: { status: 'applied' } } }));
    expect(runtime.store.getState().orderedTabIds).toHaveLength(1);
    // The switcher row for A still says 0.
    expect(countOf(view(), 'A')).toBe(1);
  });

  it('F1b: an agent (or another window) opens 2 tabs in the active workspace — the count must follow', () => {
    const { runtime, sync, empty, view } = onA();
    const one = nodeApply({ ...empty, revision: 1 }, open('x1'), ['t1']);
    const two = nodeApply({ ...one, revision: 2 }, open('x2'), ['t2']);
    sync.onFrame(stateOf('A', 3, two, {
      cause: { requestId: 'agent-req', result: { status: 'applied', tabId: 't2', outcome: 'created' }, actor: { actorClass: 'agent', actorName: 'Claude' } },
    }));
    expect(runtime.store.getState().orderedTabIds).toEqual(['t1', 't2']);
    expect(countOf(view(), 'A')).toBe(2);
  });
});

describe('AUDIT F2 — a no-row identity: the window never adopts the "Main" the first write creates (S12)', () => {
  it('F2a: after the first write creates Main, later pushes for Main (an agent’s open) are never rendered', () => {
    const { runtime, sync, sent } = setup();
    // No row yet: the node's snapshot is state null, workspaceId null (capable proof).
    sync.onFrame(stateOf(null, 0, null));
    expect(sync.capable).toBe(true);
    runtime.dispatch(open('mine'));
    const apply = applies(sent).at(-1)!;
    expect(apply).toMatchObject({ workspaceId: null });
    // The node creates "Main" (id M) and pushes ITS state, naming this window's request.
    const base = toStoredState({ ...runtime.store.getState(), orderedTabIds: [], tabs: {}, presentation: { surface: 'start' } } as WorkspaceState);
    const created = nodeApply({ ...base, revision: 0 }, apply['env'], apply['ids'] as string[]);
    sync.onFrame(stateOf('M', 1, created, { cause: { instanceId: 'win-1', requestId: apply['requestId'], result: { status: 'applied' } } }));
    // Then an agent opens a tab in Main (the active workspace).
    const byAgent = nodeApply({ ...created, revision: 1 }, { ...open('agent'), args: { kind: 'task', entityId: 'agent', activate: false } }, ['agent-tab']);
    sync.onFrame(stateOf('M', 2, byAgent, { cause: { requestId: 'r2', result: { status: 'applied', tabId: 'agent-tab', outcome: 'created' }, actor: { actorClass: 'agent' } } }));
    // The window should now show Main, with the agent's tab.
    expect(sync.shown).toBe('M');
    expect(runtime.store.getState().orderedTabIds).toContain('agent-tab');
  });

  it('F2b: … and its own first click is never confirmed, so every reconnect re-sends it', () => {
    const { runtime, sync, sent } = setup();
    sync.onFrame(stateOf(null, 0, null));
    runtime.dispatch(open('mine'));
    const apply = applies(sent).at(-1)!;
    const base = toStoredState({ ...runtime.store.getState(), orderedTabIds: [], tabs: {}, presentation: { surface: 'start' } } as WorkspaceState);
    const created = nodeApply({ ...base, revision: 0 }, apply['env'], apply['ids'] as string[]);
    sync.onFrame(stateOf('M', 1, created, { cause: { instanceId: 'win-1', requestId: apply['requestId'], result: { status: 'applied' } } }));
    sent.length = 0;
    sync.reconnected();
    expect(applies(sent)).toEqual([]);
  });

  it('F2c: a human creates a 2nd workspace while on the synthetic Main: the window is stuck "switching" and its clicks go out unaddressable', () => {
    const { runtime, sync, sent, view } = setup();
    sync.onFrame(stateOf(null, 0, null));
    // workspace.create (S12) materialises Main (id M) and Workspace 2; the node
    // pushes ONLY the summary — no workspace.state for M (service.ts:338-360).
    sync.onFrame(summaryFrame(2, 'M', [summary('M', 'Main', true), summary('W2', 'Workspace 2', false, { position: 1 })], {
      kind: 'created', workspaceId: 'W2', actorClass: 'human',
    }));
    expect(view().switching).toBe(false);
    runtime.dispatch(open('after-create'));
    // Addressed to null, the node now has 2 workspaces and refuses it (resolve.ts:191-195).
    expect(applies(sent).at(-1)).toMatchObject({ workspaceId: 'M' });
  });
});

describe('AUDIT F3 — the HTTP list overwrites newer frames (equal listRevision is not "as new")', () => {
  it('F3a: an older list response replaces a newer agent_change summary (counts and the activity dot go back)', () => {
    const { sync, view } = setup();
    sync.onFrame(stateOf('A', 1, toStoredState(createWorkspaceStore('x', SPACE).getState())));
    // onCapable fired the HTTP list; before it lands, an agent writes to B and the
    // node pushes an agent_change summary. agent_change does NOT bump list_revision.
    sync.onFrame(summaryFrame(3, 'A', [summary('A', 'Main', true), summary('B', 'Review', false, { tabCount: 5, agentChangedSinceActive: true })], {
      kind: 'agent_change', workspaceId: 'B', actorClass: 'agent',
    }));
    // The list response was read before the agent's write: same listRevision, older numbers.
    sync.adoptList([summary('A', 'Main', true), summary('B', 'Review', false, { tabCount: 4 })], 3, 'A', []);
    expect(countOf(view(), 'B')).toBe(5);
    expect(view().items.find((w) => w.id === 'B')?.agentChangedSinceActive).toBe(true);
  });

  it('F3b: an older list response drops a prompt that a workspace.prompt frame just opened', () => {
    const { sync, view } = setup();
    sync.onFrame(stateOf('A', 1, toStoredState(createWorkspaceStore('y', SPACE).getState())));
    const prompt = { promptId: 'p1', kind: 'switch', workspaceId: 'B', workspaceName: 'Review', state: 'open', createdAt: '2026-10-07T00:00:00.000Z' };
    sync.onFrame({ type: 'workspace.prompt', spaceId: SPACE, prompt } as never);
    expect(view().prompts.map((p) => p.promptId)).toEqual(['p1']);
    // The list was read before the agent asked.
    sync.adoptList([summary('A', 'Main', true), summary('B', 'Review', false)], 1, 'A', []);
    expect(view().prompts.map((p) => p.promptId)).toEqual(['p1']);
  });
});

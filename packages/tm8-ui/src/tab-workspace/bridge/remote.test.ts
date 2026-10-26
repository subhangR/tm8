/**
 * The remote source (Spec C §4) through the one dispatcher, and the R35 notice
 * copy. Each refusal has its positive half: the same command from remote
 * DOES run once the condition is lifted.
 */
import { describe, expect, it } from 'vitest';
import { toStoredState } from '@tm8/contract/workspace';

import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import { noticeLine, quoteTitle, RemoteNoticeCoalescer } from './notices';
import { WorkspaceSync, type AgentNotice } from './sync';

let n = 0;
function runtime(opts: { mounted?: boolean; typing?: boolean } = {}): WorkspaceRuntime {
  n += 1;
  const rt = createWorkspaceRuntime(`viewer-${n}`, `space-${n}`, createWorkspaceStore(`viewer-${n}`, `space-${n}`));
  rt.setHooks({
    viewMounted: () => opts.mounted ?? true,
    userTyping: () => opts.typing ?? false,
    openDialog: (dialogId) => ({ status: 'applied', dialogId, dialogState: 'open' }),
  });
  return rt;
}

const open = (entityId: string, extra: Record<string, unknown> = {}) =>
  ({ command: 'workspace.tabs.open', args: { kind: 'task', entityId, ...extra }, source: 'remote' }) as const;

describe('remote through dispatch()', () => {
  it('opens a tab, and the effect carries source remote (never a human open)', () => {
    const rt = runtime();
    const sources: string[] = [];
    rt.registerEffect((event) => sources.push(event.env.source));
    const result = rt.dispatch(open('e1'));
    expect(result).toMatchObject({ status: 'applied', outcome: 'created' });
    expect(sources).toEqual(['remote']);
  });

  it('refuses what only the human or the draft host may do', () => {
    const rt = runtime();
    rt.dispatch({ command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' });
    const draft = rt.store.getState().orderedTabIds[0]!;
    for (const env of [
      { command: 'workspace.interactions.resolve', args: { interactionId: 'x', choice: 'discard' } },
      { command: 'workspace.drafts.markDirty', args: { tabId: draft, dirty: false } },
      { command: 'workspace.drafts.bind', args: { tabId: draft, entityId: 'e' } },
    ] as const) {
      expect(rt.dispatch({ ...env, source: 'remote' })).toMatchObject({ status: 'rejected', reason: 'permission_denied' });
    }
  });

  it('never discards: a dirty close raises the in-window choice', () => {
    const rt = runtime();
    rt.dispatch({ command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' });
    const draft = rt.store.getState().orderedTabIds[0]!;
    rt.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId: draft, dirty: true }, source: 'system' });
    const result = rt.dispatch({ command: 'workspace.tabs.close', args: { tabId: draft, discard: true }, source: 'remote' });
    expect(result).toMatchObject({ status: 'requires_user_choice', reason: 'unsaved_changes' });
    expect(rt.store.getState().tabs[draft]).toBeDefined();
    expect(rt.store.getState().pending?.reason).toBe('unsaved_changes');
  });

  it('needs the Workspace view mounted, except for inspect and dialogs', () => {
    const rt = runtime({ mounted: false });
    expect(rt.dispatch(open('e1'))).toMatchObject({ status: 'rejected', reason: 'view_unavailable' });
    expect(rt.dispatch({ command: 'workspace.inspect', args: undefined, source: 'remote' })).toMatchObject({ status: 'no_op' });
    expect(rt.dispatch({ command: 'workspace.dialogs.open', args: { dialogId: 'palette' }, source: 'remote' }))
      .toMatchObject({ status: 'applied', dialogId: 'palette', dialogState: 'open' });
  });

  it('does not take focus while the human is typing, but may open in the background', () => {
    const rt = runtime({ typing: true });
    expect(rt.dispatch(open('e1'))).toMatchObject({ status: 'rejected', reason: 'user_typing' });
    expect(rt.dispatch({ command: 'workspace.dialogs.open', args: { dialogId: 'palette' }, source: 'remote' }))
      .toMatchObject({ status: 'rejected', reason: 'user_typing' });
    expect(rt.dispatch(open('e1', { activate: false }))).toMatchObject({ status: 'applied' });
  });

  it('enforces expectedRevision when supplied', () => {
    const rt = runtime();
    rt.dispatch(open('e1'));
    const stale = rt.dispatch({ ...open('e2'), expectedRevision: 0 });
    expect(stale).toMatchObject({ status: 'conflict', reason: 'revision_conflict' });
  });

  it('only registered dialogs, and one blocking modal at a time', () => {
    const rt = runtime();
    expect(rt.dispatch({ command: 'workspace.dialogs.open', args: { dialogId: 'settings' }, source: 'remote' }))
      .toMatchObject({ status: 'rejected', reason: 'unsupported_dialog' });
    expect(rt.dispatch({ command: 'workspace.dialogs.open', args: { dialogId: 'palette', html: '<b>' }, source: 'remote' }))
      .toMatchObject({ status: 'rejected', reason: 'unsupported_dialog' });
    rt.dispatch({ command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' });
    const draft = rt.store.getState().orderedTabIds[0]!;
    rt.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId: draft, dirty: true }, source: 'system' });
    rt.dispatch({ command: 'workspace.tabs.close', args: { tabId: draft }, source: 'remote' });
    expect(rt.dispatch({ command: 'workspace.dialogs.open', args: { dialogId: 'palette' }, source: 'remote' }))
      .toMatchObject({ status: 'rejected', reason: 'busy' });
  });

  it('view.set targets the Workspace only', () => {
    const rt = runtime();
    expect(rt.dispatch({ command: 'workspace.view.set', args: { view: 'settings' }, source: 'remote' }))
      .toMatchObject({ status: 'rejected', reason: 'view_unavailable' });
  });
});

describe('the R35 notice copy', () => {
  it('names one, counts many, and coalesces mixed actions', () => {
    expect(noticeLine('Worker', [{ verb: 'opened', count: 1, title: 'Checkout' }])).toBe('Worker opened “Checkout”');
    expect(noticeLine('Worker', [
      { verb: 'opened', count: 1, title: 'A' }, { verb: 'opened', count: 1, title: 'B' }, { verb: 'opened', count: 1 },
    ])).toBe('Worker opened 3 tabs');
    expect(noticeLine('Worker', [{ verb: 'closed', count: 2 }])).toBe('Worker closed 2 tabs');
    expect(noticeLine('Worker', [{ verb: 'moved', count: 1, title: 'Checkout' }])).toBe('Worker moved “Checkout”');
    expect(noticeLine('Worker', [{ verb: 'scope', label: 'By type · 2' }])).toBe('Worker set the tab scope to By type · 2');
    expect(noticeLine('Worker', [{ verb: 'dialog', title: 'the command palette' }])).toBe('Worker opened the command palette');
    expect(noticeLine('Worker', [
      { verb: 'opened', count: 1 }, { verb: 'scope', label: 'Mixed' }, { verb: 'closed', count: 1 }, { verb: 'moved', count: 1 },
    ])).toBe('Worker made 4 changes to your workspace');
  });

  it('cuts titles at 40 characters', () => {
    expect(quoteTitle('x'.repeat(45))).toBe(`“${'x'.repeat(40)}…”`);
  });

  it('one notice per actor, replaced within 2 s and fresh after', () => {
    let now = 0;
    const c = new RemoteNoticeCoalescer(() => now);
    expect(c.add('Worker', { verb: 'opened', count: 1, title: 'A' })).toEqual({ id: 'tws-remote-Worker', title: 'Worker opened “A”' });
    now = 1500;
    expect(c.add('Worker', { verb: 'opened', count: 1, title: 'B' }).title).toBe('Worker opened 2 tabs');
    expect(c.add('Other', { verb: 'closed', count: 1, title: 'C' }).id).toBe('tws-remote-Other');
    now = 5000;
    expect(c.add('Worker', { verb: 'moved', count: 1, title: 'D' }).title).toBe('Worker moved “D”');
  });
});

describe('an agent’s stored-path write (W3.2)', () => {
  const SPACE = 'space-agent';
  /** A capable window on Main (A), Billing (B) in the list, and an agent's open as the node stores it. */
  function onMain() {
    const rt = runtime();
    const toasts: AgentNotice[] = [];
    const sync = new WorkspaceSync(rt, SPACE, 'win-1', {
      send: () => true,
      notify: () => {},
      onServerMode: () => {},
      legacy: () => ({ state: null, rail: null }),
      notifyAgent: (notice) => void toasts.push(notice),
      titleOf: (id) => (id === 'e1' ? 'Fix the login page' : undefined),
    });
    const empty = toStoredState(rt.store.getState());
    const frame = (workspaceId: string, revision: number, state: unknown, extra: Record<string, unknown> = {}) =>
      ({ type: 'workspace.state', spaceId: SPACE, revision, state, workspaceId, active: true, ...extra }) as never;
    sync.onFrame(frame('A', 1, empty));
    sync.onFrame({
      type: 'workspace.summary', spaceId: SPACE, listRevision: 1, activeWorkspaceId: 'A',
      items: [{ id: 'A', name: 'Main' }, { id: 'B', name: 'Billing' }] as never,
    });
    const agent = runtime();
    agent.dispatch(open('e1'));
    const tabId = agent.store.getState().orderedTabIds[0]!;
    const opened = toStoredState({ ...agent.store.getState(), revision: 2 });
    const cause = {
      requestId: 'r1',
      result: { status: 'applied', outcome: 'created', tabId },
      actor: { actorClass: 'agent', actorName: 'Codex' },
    };
    return { sync, toasts, frame, opened, cause, tabId };
  }

  it('names the actor and the workspace it opened in, once', () => {
    const { sync, toasts, frame, opened, cause, tabId } = onMain();
    sync.onFrame(frame('A', 2, opened, { cause }));
    expect(toasts).toEqual([{ id: 'tws-agent-Codex-A', title: 'Codex opened “Fix the login page” in Main' }]);
    // The node's follow-up activate is the same act: the bridge asks before toasting it again.
    expect(sync.announced(tabId)).toBe(true);
    // This window's own write, and a human's, are not announced.
    sync.onFrame(frame('A', 3, opened, { cause: { ...cause, instanceId: 'win-1' } }));
    sync.onFrame(frame('A', 4, opened, { cause: { ...cause, actor: { actorClass: 'human' } } }));
    expect(toasts).toHaveLength(1);
  });

  it('a write to a workspace not active says prepared, with Go', () => {
    const { sync, toasts, frame, opened, cause } = onMain();
    sync.onFrame(frame('B', 2, opened, { active: false, cause }));
    expect(toasts).toEqual([{ id: 'tws-agent-Codex-B', title: 'Codex prepared “Fix the login page” in Billing', goTo: 'B' }]);
  });

  it('an agent’s new workspace says created, with Go', () => {
    const { sync, toasts } = onMain();
    sync.onFrame({
      type: 'workspace.summary', spaceId: SPACE, listRevision: 2, activeWorkspaceId: 'A',
      items: [{ id: 'A', name: 'Main' }, { id: 'B', name: 'Billing' }, { id: 'C', name: 'Research' }] as never,
      cause: { kind: 'created', workspaceId: 'C', actorClass: 'agent', actorName: 'Codex' },
    } as never);
    expect(toasts).toEqual([{ id: 'tws-agent-Codex-C', title: 'Codex created Research', goTo: 'C' }]);
  });
});

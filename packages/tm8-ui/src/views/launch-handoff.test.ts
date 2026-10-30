/**
 * THE LAUNCH HAND-OFF (task 01a182d2): a press lands at once on a launching
 * page in a Work tab; the node's answer turns that tab into the session's IN
 * PLACE; a refusal or a timeout stays on the page with the node's words; a
 * timeout replays the SAME input before anything else; a page that finds a
 * launch it holds no record of re-attaches by replaying the stored input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../tab-workspace/runtime/dispatch';
import { createWorkspaceStore } from '../tab-workspace/runtime/store';
import {
  findLaunchTab,
  launchTabValues,
  openLaunchTab,
  resetLaunchTabQueue,
  type LaunchTabValues,
} from '../tab-workspace/runtime/launchTabs';
import { launchForSession, launchPageModel, launchRecord, resetLaunches, retireLaunch } from '../launch-handoff';
import type { LaunchStarted } from '../new-session/launch-started';
import { createLaunchHandoff, landQueuedLaunches, RESUME_GRACE_MS, type LaunchHandoffDeps } from './useLaunchHandoff';
import { noticeOfToast } from '../tab-workspace/view/toastNotice';
import { onLaunchTabQueued } from '../tab-workspace/runtime/launchTabs';

let n = 0;
function workspace() {
  n += 1;
  const viewerId = `viewer-${String(n)}`;
  const spaceId = `space-${String(n)}`;
  const runtime = createWorkspaceRuntime(viewerId, spaceId, createWorkspaceStore(viewerId, spaceId));
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  /* The tab Launch was pressed on: a task. */
  runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: 'task-1' }, source: 'click' });
  return { viewerId, spaceId, runtime };
}

function launchOf(id = 'mut-1'): LaunchStarted {
  return {
    clientMutationId: id,
    subjectId: 'task-1' as EntityId,
    title: 'Fix the flaky login test',
    verb: 'worker',
    teammate: { id: 'tm-1' as EntityId, name: 'Opus 5.5 1M Teammate' },
    model: 'claude-opus-5',
    effort: 'max',
    accessMode: 'fullAccess',
    workdir: { kind: 'project', projectId: 'proj-1', mode: 'worktree', baseRef: 'main' },
    notes: 'Keep the change small.',
  };
}

function inputOf(id = 'mut-1'): ExecutionSpawnInput {
  return {
    clientMutationId: id,
    spaceId: 'space' as ExecutionSpawnInput['spaceId'],
    teamMemberId: 'tm-1' as EntityId,
    taskIds: ['task-1' as EntityId],
    title: 'Fix the flaky login test',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const timeout = () => Object.assign(new Error('the tm8 node did not answer within 180000ms'), { code: 'upstream_unavailable' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function handoffFor(
  ws: { viewerId: string; spaceId: string; runtime: WorkspaceRuntime },
  overrides: Partial<LaunchHandoffDeps> = {},
) {
  const navigateToWork = vi.fn();
  const spawnSession = vi.fn<(input: ExecutionSpawnInput) => Promise<EntityId>>();
  const handoff = createLaunchHandoff({
    viewerId: ws.viewerId,
    spaceId: ws.spaceId,
    spawnSession,
    runtimeFor: () => ws.runtime,
    workPresence: () => 'mounted',
    navigateToWork,
    landing: () => 'work',
    ...overrides,
  });
  return { handoff, spawnSession, navigateToWork };
}

const entityTabOf = (runtime: WorkspaceRuntime, entityId: string) =>
  Object.values(runtime.store.getState().tabs).find((tab) => tab.type === 'entity' && tab.entityId === entityId) ?? null;

afterEach(() => {
  resetLaunches();
  resetLaunchTabQueue();
});

describe('the press, inside Work', () => {
  it('opens the launching tab at once, before the node answers', () => {
    const ws = workspace();
    const { handoff, spawnSession, navigateToWork } = handoffFor(ws);

    expect(handoff.onLaunchStarted(launchOf())).toBe(true);

    const tab = findLaunchTab(ws.runtime, 'mut-1');
    expect(tab).toMatchObject({ type: 'draft', kind: 'work_session', holds: 'launch', dirty: false });
    expect(ws.runtime.store.getState().presentation).toEqual({ surface: 'tab', tabId: tab!.id });
    expect(launchTabValues(ws.runtime.drafts.get(tab!.draftId))).toMatchObject({ launchId: 'mut-1', input: null });
    expect(launchRecord('mut-1')).toMatchObject({ state: 'starting', page: { at: 'tab' } });
    expect(spawnSession).not.toHaveBeenCalled();
    /* Inside Work the tab's own open is the one navigation. */
    expect(navigateToWork).not.toHaveBeenCalled();
  });

  it('turns the launching tab into the session tab IN PLACE when the node answers', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);

    handoff.onLaunchStarted(launchOf());
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    const before = ws.runtime.store.getState();
    const index = before.orderedTabIds.indexOf(tab.id);

    const sent = handoff.spawn(inputOf());
    expect(spawnSession).toHaveBeenCalledTimes(1);
    /* The exact input rides the tab, for a reload's replay. */
    expect(launchTabValues(ws.runtime.drafts.get(tab.draftId))?.input?.clientMutationId).toBe('mut-1');

    answer.resolve('session-1' as EntityId);
    await sent;

    const after = ws.runtime.store.getState();
    expect(after.tabs[tab.id]).toMatchObject({ type: 'entity', kind: 'work_session', entityId: 'session-1' });
    expect(after.orderedTabIds.indexOf(tab.id)).toBe(index);
    expect(after.orderedTabIds).toHaveLength(before.orderedTabIds.length);
    expect(after.presentation).toEqual({ surface: 'tab', tabId: tab.id });
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-1' });
  });

  it('a bound tab that is not on screen does not steal focus', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockResolvedValue('session-1' as EntityId);
    handoff.onLaunchStarted(launchOf());
    const launchTab = findLaunchTab(ws.runtime, 'mut-1')!;
    const taskTab = entityTabOf(ws.runtime, 'task-1')!;
    ws.runtime.dispatch({ command: 'workspace.tabs.activate', args: { tabId: taskTab.id }, source: 'click' });

    await handoff.spawn(inputOf());

    expect(ws.runtime.store.getState().tabs[launchTab.id]).toMatchObject({ type: 'entity', entityId: 'session-1' });
    expect(ws.runtime.store.getState().presentation).toEqual({ surface: 'tab', tabId: taskTab.id });
  });

  it('a second send of the same launch goes nowhere', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockReturnValue(new Promise(() => undefined));
    handoff.onLaunchStarted(launchOf());
    void handoff.spawn(inputOf());
    void handoff.spawn(inputOf());
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });
});

describe('a refusal and a timeout', () => {
  it('a refusal stays on the page with the node’s own words, and the popup’s promise rejects with them (no picks recorded)', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockRejectedValue(Object.assign(new Error('session concurrency cap reached (64/64)'), { code: 'conflict' }));
    handoff.onLaunchStarted(launchOf());

    await expect(handoff.spawn(inputOf())).rejects.toThrow('session concurrency cap reached (64/64)');

    expect(launchRecord('mut-1')).toMatchObject({
      state: 'failed',
      failure: { message: 'session concurrency cap reached (64/64)', code: 'conflict', uncertain: false },
    });
    expect(findLaunchTab(ws.runtime, 'mut-1')).not.toBeNull();
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('a timeout REPLAYS the same input first, and lands on the session it started', async () => {
    const ws = workspace();
    const sessionsSince = vi.fn();
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince });
    const replay = deferred<EntityId>();
    spawnSession.mockRejectedValueOnce(timeout()).mockReturnValueOnce(replay.promise);
    handoff.onLaunchStarted(launchOf());

    const sent = handoff.spawn(inputOf());
    await flush();
    expect(launchRecord('mut-1')?.state).toBe('checking');
    expect(spawnSession).toHaveBeenCalledTimes(2);
    /* One id per launch: the replay is the SAME input, never a new mutation id. */
    expect(spawnSession.mock.calls[1]![0]).toBe(spawnSession.mock.calls[0]![0]);

    replay.resolve('session-9' as EntityId);
    await sent;
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-9' });
    expect(entityTabOf(ws.runtime, 'session-9')).not.toBeNull();
    expect(sessionsSince).not.toHaveBeenCalled();
  });

  it('when the replay cannot answer either, the subject’s sessions are OFFERED — never adopted — and the person picks', async () => {
    const ws = workspace();
    const sessionsSince = vi.fn().mockResolvedValue([{ id: 'session-7', title: 'A teammate’s run' }]);
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince });
    spawnSession.mockRejectedValue(timeout());
    handoff.onLaunchStarted(launchOf());

    await handoff.spawn(inputOf()).catch(() => undefined);

    expect(sessionsSince).toHaveBeenCalledWith('task-1', expect.any(String));
    expect(launchRecord('mut-1')).toMatchObject({
      state: 'failed',
      sessionId: null,
      failure: { uncertain: true, candidates: [{ id: 'session-7', title: 'A teammate’s run' }] },
    });
    expect(entityTabOf(ws.runtime, 'session-7')).toBeNull();

    handoff.choose('mut-1', 'session-7' as EntityId);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-7' });
    expect(entityTabOf(ws.runtime, 'session-7')).not.toBeNull();
  });

  it('no session found after a timeout is a plain failure; a check that fails too is an uncertain one', async () => {
    const ws = workspace();
    const none = handoffFor(ws, { sessionsSince: vi.fn().mockResolvedValue([]) });
    none.spawnSession.mockRejectedValue(timeout());
    none.handoff.onLaunchStarted(launchOf('mut-a'));
    await none.handoff.spawn(inputOf('mut-a')).catch(() => undefined);
    expect(launchRecord('mut-a')).toMatchObject({ state: 'failed', failure: { uncertain: false } });

    const broken = handoffFor(ws, { sessionsSince: vi.fn().mockRejectedValue(new Error('offline')) });
    broken.spawnSession.mockRejectedValue(timeout());
    broken.handoff.onLaunchStarted(launchOf('mut-b'));
    await broken.handoff.spawn(inputOf('mut-b')).catch(() => undefined);
    expect(launchRecord('mut-b')).toMatchObject({ state: 'failed', failure: { uncertain: true } });
  });

  it('a refusal on the replay is shown as the refusal', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince: vi.fn().mockResolvedValue([]) });
    spawnSession.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(new Error('task is archived'));
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'failed', failure: { message: 'task is archived' } });
  });
});

describe('the press, outside Work', () => {
  it('waits behind Work’s restore and makes ONE navigation into Work', () => {
    const ws = workspace();
    const { handoff, navigateToWork } = handoffFor(ws, { workPresence: () => 'elsewhere' });

    expect(handoff.onLaunchStarted(launchOf())).toBe(true);

    expect(navigateToWork).toHaveBeenCalledTimes(1);
    /* Nothing written into a Work that has not restored yet. */
    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
    expect(launchRecord('mut-1')?.page?.at).toBe('queued');

    landQueuedLaunches(ws.runtime);
    expect(findLaunchTab(ws.runtime, 'mut-1')).not.toBeNull();
    expect(launchRecord('mut-1')?.page?.at).toBe('tab');
  });

  it('a launch the node admitted while Work mounted opens as the session’s own tab', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws, { workPresence: () => 'elsewhere' });
    spawnSession.mockResolvedValue('session-1' as EntityId);
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf());

    landQueuedLaunches(ws.runtime);

    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
    expect(entityTabOf(ws.runtime, 'session-1')).not.toBeNull();
  });

  it('a launch dismissed before Work drained opens nothing', () => {
    const ws = workspace();
    const { handoff } = handoffFor(ws, { workPresence: () => 'elsewhere' });
    handoff.onLaunchStarted(launchOf());
    handoff.dismiss('mut-1');
    landQueuedLaunches(ws.runtime);
    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
  });
});

describe('when the hand-off declines', () => {
  it('no Work to land in (the phone, the legacy desktop): false, and nothing recorded', () => {
    const ws = workspace();
    const { handoff } = handoffFor(ws, { landing: () => null });
    expect(handoff.onLaunchStarted(launchOf())).toBe(false);
    expect(launchRecord('mut-1')).toBeNull();
  });

  it('a tab scope without sessions keeps the popup’s in-card state rather than raise the reveal prompt', () => {
    const ws = workspace();
    ws.runtime.dispatch({ command: 'workspace.tabScope.set', args: { mode: 'byType', selectedTypeIds: ['task'] }, source: 'click' });
    const { handoff } = handoffFor(ws);
    expect(handoff.onLaunchStarted(launchOf())).toBe(false);
    expect(launchRecord('mut-1')).toBeNull();
    expect(ws.runtime.store.getState().pending).toBeUndefined();
  });

  it('a launch it did not take runs the host’s own verb, and that verb’s error reaches the card', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    const fallback = vi.fn(async () => {
      throw new Error('the node refused');
    });
    await expect(handoff.spawn(inputOf('not-handed-over'), fallback)).rejects.toThrow('the node refused');
    expect(fallback).toHaveBeenCalledWith(inputOf('not-handed-over'));
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe('Dismiss and Edit and retry', () => {
  it('Dismiss closes the tab, and a late answer neither reopens nor re-labels anything', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const sent = handoff.spawn(inputOf());

    handoff.dismiss('mut-1');
    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
    expect(launchRecord('mut-1')).toBeNull();

    answer.resolve('session-1' as EntityId);
    await sent;
    expect(entityTabOf(ws.runtime, 'session-1')).toBeNull();
    expect(launchRecord('mut-1')).toBeNull();
  });

  it('a retry takes the failed launch’s tab over in place', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockRejectedValueOnce(new Error('cap reached'));
    handoff.onLaunchStarted(launchOf('mut-1'));
    await handoff.spawn(inputOf('mut-1')).catch(() => undefined);
    const failedTab = findLaunchTab(ws.runtime, 'mut-1')!;
    const count = ws.runtime.store.getState().orderedTabIds.length;

    expect(handoff.onLaunchStarted(launchOf('mut-2'), 'mut-1')).toBe(true);

    expect(findLaunchTab(ws.runtime, 'mut-2')?.id).toBe(failedTab.id);
    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
    expect(launchRecord('mut-1')).toBeNull();
    expect(ws.runtime.store.getState().orderedTabIds).toHaveLength(count);

    spawnSession.mockResolvedValueOnce('session-2' as EntityId);
    await handoff.spawn(inputOf('mut-2'));
    expect(ws.runtime.store.getState().tabs[failedTab.id]).toMatchObject({ type: 'entity', entityId: 'session-2' });
  });
});

describe('re-attach: a page that finds a launch this window holds no record of', () => {
  function reloaded(startedAgoMs: number, input: ExecutionSpawnInput | null = inputOf(), failure: LaunchTabValues['failure'] = null) {
    const ws = workspace();
    const now = 1_000_000;
    const values: LaunchTabValues = { launchId: 'mut-1', launch: launchOf(), input, startedAt: now - startedAgoMs, failure };
    /* The tab survives the reload; the in-memory record does not. */
    openLaunchTab(ws.runtime, values, 'system');
    let scheduled: { run: () => void; ms: number } | null = null;
    const deps = handoffFor(ws, {
      now: () => now,
      schedule: (run, ms) => {
        scheduled = { run, ms };
      },
    });
    return { ws, values, ...deps, scheduled: () => scheduled };
  }

  it('reload during starting: after the grace the SAME input is replayed and the tab binds to its session', async () => {
    const { ws, values, handoff, spawnSession, scheduled } = reloaded(2_000);
    spawnSession.mockResolvedValue('session-1' as EntityId);

    handoff.resume(values);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'starting', startedAt: values.startedAt });
    expect(scheduled()?.ms).toBe(RESUME_GRACE_MS - 2_000);
    expect(spawnSession).not.toHaveBeenCalled();

    const answer = deferred<EntityId>();
    spawnSession.mockReturnValueOnce(answer.promise);
    scheduled()!.run();
    /* No timeout happened in this window: the page says it is reconnecting. */
    expect(launchRecord('mut-1')?.state).toBe('reconnecting');
    answer.resolve('session-1' as EntityId);
    await flush();
    expect(spawnSession).toHaveBeenCalledWith(values.input);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-1' });
    expect(entityTabOf(ws.runtime, 'session-1')).not.toBeNull();
  });

  it('reload after a STORED refusal draws the failure as it is, and replays nothing', () => {
    const refusal = { message: 'session concurrency cap reached (64/64)', code: 'conflict', uncertain: false };
    const { values, handoff, spawnSession, scheduled } = reloaded(30_000, inputOf(), refusal);
    handoff.resume(values);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'failed', failure: refusal });
    expect(scheduled()).toBeNull();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('a refusal is stored on the tab, so the reload above is what a reload sees', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockRejectedValue(Object.assign(new Error('cap reached'), { code: 'conflict' }));
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    expect(launchTabValues(ws.runtime.drafts.get(tab.draftId))?.failure).toMatchObject({ message: 'cap reached', code: 'conflict' });
  });

  it('reload while the node refused unseen: the replay returns the refusal and the page offers Edit and retry', async () => {
    const { values, handoff, spawnSession, scheduled } = reloaded(30_000);
    spawnSession.mockRejectedValue(new Error('session concurrency cap reached (64/64)'));

    handoff.resume(values);
    expect(scheduled()?.ms).toBe(0);
    scheduled()!.run();
    await flush();

    const record = launchRecord('mut-1');
    expect(record).toMatchObject({ state: 'failed', failure: { message: 'session concurrency cap reached (64/64)' } });
    const page = launchPageModel(record, null);
    expect(page).toMatchObject({ state: 'failed', launchId: 'mut-1', failure: { message: 'session concurrency cap reached (64/64)' } });
  });

  it('never replays while this window’s original request is still in flight', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockReturnValue(new Promise(() => undefined));
    handoff.onLaunchStarted(launchOf());
    void handoff.spawn(inputOf());
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    const values = launchTabValues(ws.runtime.drafts.get(tab.draftId))!;

    /* The page remounts (a tab switch) while the original is out. */
    handoff.resume(values);
    await flush();
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('the replay is skipped when the tab no longer holds the launch when the grace ends (bound or closed elsewhere)', async () => {
    const { ws, values, handoff, spawnSession, scheduled } = reloaded(1_000);
    handoff.resume(values);
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    ws.runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' });
    scheduled()!.run();
    await flush();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('a second resume of the same launch (the page remounted) schedules nothing more', () => {
    const { values, handoff, scheduled } = reloaded(1_000);
    handoff.resume(values);
    const first = scheduled();
    handoff.resume(values);
    expect(scheduled()).toBe(first);
  });

  it('a press whose input never left the window fails without sending anything', () => {
    const { values, handoff, spawnSession } = reloaded(1_000, null);
    handoff.resume(values);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'failed', failure: { uncertain: false } });
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe('a launch tab is never reused, and never reuses', () => {
  it('＋ New → Session does not reuse a launch tab, even after a reload dropped its `submitting`', () => {
    const ws = workspace();
    const { handoff } = handoffFor(ws);
    handoff.onLaunchStarted(launchOf());
    const launchTab = findLaunchTab(ws.runtime, 'mut-1')!;
    /* What a restore leaves: the same record, `submitting` false. */
    ws.runtime.store.setState((s) => ({ ...s, tabs: { ...s.tabs, [launchTab.id]: { ...launchTab, submitting: false } } }));

    const opened = ws.runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'work_session' }, source: 'click' });
    expect(opened.tabId).not.toBe(launchTab.id);
    expect(findLaunchTab(ws.runtime, 'mut-1')?.id).toBe(launchTab.id);
  });

  it('a second launch opens its own tab and leaves the first launch’s stored input alone', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockReturnValue(new Promise(() => undefined));
    handoff.onLaunchStarted(launchOf('mut-1'));
    void handoff.spawn(inputOf('mut-1'));
    handoff.onLaunchStarted(launchOf('mut-2'));
    const first = findLaunchTab(ws.runtime, 'mut-1')!;
    const second = findLaunchTab(ws.runtime, 'mut-2')!;
    expect(second.id).not.toBe(first.id);
    expect(launchTabValues(ws.runtime.drafts.get(first.draftId))?.input?.clientMutationId).toBe('mut-1');
  });

  it('a launch does not take over a blank New session draft', () => {
    const ws = workspace();
    const blank = ws.runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: 'work_session' }, source: 'click' }).tabId!;
    const { handoff } = handoffFor(ws);
    handoff.onLaunchStarted(launchOf());
    expect(findLaunchTab(ws.runtime, 'mut-1')?.id).not.toBe(blank);
    const blankTab = ws.runtime.store.getState().tabs[blank];
    expect(blankTab).toMatchObject({ type: 'draft' });
    expect(launchTabValues(ws.runtime.drafts.get((blankTab as { draftId: string }).draftId))).toBeNull();
  });
});

describe('one navigation, decided on the nav view', () => {
  it('Work’s route already showing but its view still mounting: the tab queues, and nothing is pushed', () => {
    const ws = workspace();
    const { handoff, navigateToWork } = handoffFor(ws, { workPresence: () => 'mounting' });
    expect(handoff.onLaunchStarted(launchOf())).toBe(true);
    expect(navigateToWork).not.toHaveBeenCalled();
    landQueuedLaunches(ws.runtime);
    expect(findLaunchTab(ws.runtime, 'mut-1')).not.toBeNull();
  });
});

describe('what is a spawn error and what is not', () => {
  it('a client-side throw while landing an admitted session is logged, not turned into a launch failure', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockResolvedValue('session-1' as EntityId);
    handoff.onLaunchStarted(launchOf());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispatch = ws.runtime.dispatch;
    ws.runtime.dispatch = ((env: Parameters<typeof dispatch>[0]) => {
      if ((env as { command: string }).command === 'workspace.drafts.bind') throw new Error('bind blew up');
      return dispatch(env);
    }) as typeof dispatch;

    await expect(handoff.spawn(inputOf())).resolves.toBeUndefined();
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-1' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be bound'), expect.anything());
    logged.mockRestore();
    ws.runtime.dispatch = dispatch;
  });
});

describe('what a launch tab stores survives the trip', () => {
  it('a timed-out check’s candidates are stored with the failure', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince: vi.fn().mockResolvedValue([{ id: 's-7', title: 'Run' }]) });
    spawnSession.mockRejectedValue(timeout());
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    expect(launchTabValues(ws.runtime.drafts.get(tab.draftId))?.failure?.candidates).toEqual([{ id: 's-7', title: 'Run' }]);
  });

  it('a stored launch missing any field the page reads is not a launch at all', () => {
    const base = { launchId: 'mut-1', launch: launchOf(), input: null, startedAt: 1, failure: null };
    expect(launchTabValues(base as unknown as Record<string, unknown>)).not.toBeNull();
    for (const broken of [
      { ...launchOf(), workdir: { kind: 'project' } },
      { ...launchOf(), workdir: null },
      { ...launchOf(), verb: 'wizard' },
      { ...launchOf(), teammate: { id: 1 } },
      { ...launchOf(), notes: undefined },
    ]) {
      expect(launchTabValues({ ...base, launch: broken } as unknown as Record<string, unknown>)).toBeNull();
    }
  });
});

describe('round 3', () => {
  it('a replay that errors looks before declaring: something started → offered, not refused', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince: vi.fn().mockResolvedValue([{ id: 's-9', title: 'Mine?' }]) });
    spawnSession.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }));
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    expect(launchRecord('mut-1')).toMatchObject({ state: 'failed', failure: { uncertain: true, candidates: [{ id: 's-9', title: 'Mine?' }] } });
  });

  it('the launch tab closed while the node answers: the bind’s closed-tab path toasts “Created”, and the record goes', async () => {
    const ws = workspace();
    const toast = vi.fn();
    ws.runtime.setHooks({ toast });
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const sent = handoff.spawn(inputOf());
    ws.runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: findLaunchTab(ws.runtime, 'mut-1')!.id }, source: 'click' });

    answer.resolve('session-1' as EntityId);
    await sent;
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: 'Created Fix the flaky login test' }));
    expect(entityTabOf(ws.runtime, 'session-1')).toBeNull();
    expect(launchRecord('mut-1')).toBeNull();
  });

  it('the launch tab closed while the node refuses: a toast whose Show re-opens the page with the failure', async () => {
    const ws = workspace();
    const toast = vi.fn();
    ws.runtime.setHooks({ toast });
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const sent = handoff.spawn(inputOf());
    ws.runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: findLaunchTab(ws.runtime, 'mut-1')!.id }, source: 'click' });

    answer.reject(new Error('cap reached'));
    await sent.catch(() => undefined);
    const shown = toast.mock.calls[0]![0] as { text: string; action: { label: string; run(): void } };
    expect(shown.text).toContain('cap reached');
    expect(shown.action.label).toBe('Show');
    shown.action.run();
    const reopened = findLaunchTab(ws.runtime, 'mut-1')!;
    expect(launchTabValues(ws.runtime.drafts.get(reopened.draftId))?.failure?.message).toBe('cap reached');
  });

  it('a press of a launch already admitted opens its session, and no launch tab that could never bind', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockResolvedValue('session-1' as EntityId);
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf());
    const before = ws.runtime.store.getState().orderedTabIds.length;

    expect(handoff.onLaunchStarted(launchOf())).toBe(true);
    expect(findLaunchTab(ws.runtime, 'mut-1')).toBeNull();
    expect(ws.runtime.store.getState().orderedTabIds).toHaveLength(before);
    expect(entityTabOf(ws.runtime, 'session-1')).not.toBeNull();
  });

  it('admission drops the input and indexes the record by its session', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    spawnSession.mockResolvedValue('session-1' as EntityId);
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf());
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', input: null });
    expect(launchForSession('session-1')?.id).toBe('mut-1');
    retireLaunch('mut-1');
    expect(launchForSession('session-1')).toBeNull();
    expect(launchRecord('mut-1')).toBeNull();
  });
});

describe('round 4', () => {
  /** Work's own toast hook, as TabWorkspaceView installs it: toast → shell notice. */
  function withNotices(ws: ReturnType<typeof workspace>) {
    const notices: ReturnType<typeof noticeOfToast>[] = [];
    ws.runtime.setHooks({ toast: (t) => void notices.push(noticeOfToast(t)) });
    return notices;
  }

  it('closed tab, admitted: the shell notice carries Open, and Open shows the session', async () => {
    const ws = workspace();
    const notices = withNotices(ws);
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const sent = handoff.spawn(inputOf());
    ws.runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: findLaunchTab(ws.runtime, 'mut-1')!.id }, source: 'click' });
    answer.resolve('session-1' as EntityId);
    await sent;

    expect(notices[0]).toMatchObject({ title: 'Created Fix the flaky login test', action: { label: 'Open' } });
    notices[0]!.action!.run();
    expect(entityTabOf(ws.runtime, 'session-1')).not.toBeNull();
  });

  it('closed tab, refused: the shell notice carries Show, and Show draws the failure', async () => {
    const ws = workspace();
    const notices = withNotices(ws);
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const sent = handoff.spawn(inputOf());
    ws.runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: findLaunchTab(ws.runtime, 'mut-1')!.id }, source: 'click' });
    answer.reject(new Error('cap reached'));
    await sent.catch(() => undefined);

    expect(notices[0]).toMatchObject({ action: { label: 'Show' } });
    notices[0]!.action!.run();
    const tab = findLaunchTab(ws.runtime, 'mut-1')!;
    expect(launchTabValues(ws.runtime.drafts.get(tab.draftId))?.failure?.message).toBe('cap reached');
  });

  it('a launch that never got a tab (landed `none`) still reports its refusal', async () => {
    const ws = workspace();
    const notices = withNotices(ws);
    const { handoff, spawnSession } = handoffFor(ws, { workPresence: () => 'elsewhere' });
    spawnSession.mockRejectedValue(new Error('cap reached'));
    handoff.onLaunchStarted(launchOf());
    /* Work refuses the tab at drain (a scope without sessions). */
    ws.runtime.dispatch({ command: 'workspace.tabScope.set', args: { mode: 'byType', selectedTypeIds: ['task'] }, source: 'click' });
    landQueuedLaunches(ws.runtime);
    expect(launchRecord('mut-1')?.page?.at).toBe('none');
    await handoff.spawn(inputOf()).catch(() => undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('cap reached');
  });

  it('a launch refused while queued, then refused a tab at drain, still reports it — and Show lands it in a tab', async () => {
    const ws = workspace();
    const notices = withNotices(ws);
    const { handoff, spawnSession } = handoffFor(ws, { workPresence: () => 'elsewhere' });
    spawnSession.mockRejectedValue(new Error('cap reached'));
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    /* Queued: the drain is left to draw it. */
    expect(notices).toHaveLength(0);
    ws.runtime.dispatch({ command: 'workspace.tabScope.set', args: { mode: 'byType', selectedTypeIds: ['task'] }, source: 'click' });
    landQueuedLaunches(ws.runtime);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ action: { label: 'Show' } });
    expect(notices[0]!.title).toContain('cap reached');
    ws.runtime.dispatch({ command: 'workspace.tabScope.set', args: { mode: 'mixed', lastByTypeIds: [] }, source: 'click' });
    notices[0]!.action!.run();
    expect(findLaunchTab(ws.runtime, 'mut-1')).not.toBeNull();
    expect(launchRecord('mut-1')?.page?.at).toBe('tab');
  });

  it('a synchronous drain on queue lands the tab, and the record stays landed in it', () => {
    const ws = workspace();
    const off = onLaunchTabQueued(() => landQueuedLaunches(ws.runtime));
    const { handoff } = handoffFor(ws, { workPresence: () => 'mounting' });
    handoff.onLaunchStarted(launchOf());
    off();
    expect(findLaunchTab(ws.runtime, 'mut-1')).not.toBeNull();
    expect(launchRecord('mut-1')?.page?.at).toBe('tab');
  });

  it('a definitive refusal on the replay keeps the node’s words, with the found sessions beside them', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws, { sessionsSince: vi.fn().mockResolvedValue([{ id: 's-9', title: 'Run' }]) });
    spawnSession.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(Object.assign(new Error('task is archived'), { code: 'conflict' }));
    handoff.onLaunchStarted(launchOf());
    await handoff.spawn(inputOf()).catch(() => undefined);
    expect(launchRecord('mut-1')).toMatchObject({ failure: { message: 'task is archived', code: 'conflict', candidates: [{ id: 's-9', title: 'Run' }] } });
  });

  it('a second send of a launch in flight settles as that launch does — no early success', async () => {
    const ws = workspace();
    const { handoff, spawnSession } = handoffFor(ws);
    const answer = deferred<EntityId>();
    spawnSession.mockReturnValue(answer.promise);
    handoff.onLaunchStarted(launchOf());
    const first = handoff.spawn(inputOf());
    const second = handoff.spawn(inputOf());
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    answer.reject(new Error('cap reached'));
    await expect(second).rejects.toThrow('cap reached');
    await expect(first).rejects.toThrow('cap reached');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('a stored launch without its press time is unrestorable — no time is invented', () => {
    expect(launchTabValues({ launchId: 'mut-1', launch: launchOf(), input: null } as unknown as Record<string, unknown>)).toBeNull();
  });
});

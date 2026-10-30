// @vitest-environment jsdom
/**
 * A launch tab's body (task 01a182d2), driven through the component:
 *   - re-attaching after a reload survives the re-render its own adoption
 *     causes (the page would otherwise read "Launching" forever);
 *   - Edit and retry rewrites the tab's values in place, and the page that is
 *     ON SCREEN follows them — a local write DraftHost does not remount for;
 *   - a stored launch that cannot be read says so, with a way out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { LaunchPageHostContext, launchRecord, resetLaunches, type LaunchPageHost } from '../../launch-handoff';
import type { LaunchStarted } from '../../new-session/launch-started';
import { createLaunchHandoff } from '../../views/useLaunchHandoff';
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../runtime/dispatch';
import { findLaunchTab, openLaunchTab, resetLaunchTabQueue, type LaunchTabValues } from '../runtime/launchTabs';
import { createWorkspaceStore } from '../runtime/store';
import type { DraftTabRecord } from '../runtime/types';

let current: WorkspaceRuntime | null = null;
vi.mock('../view/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../view/context')>()),
  useWorkspace: () => ({ runtime: current }),
}));

import { LaunchTabBody } from './LaunchTabBody';

const launchOf = (id: string, title = 'Fix the flaky login test'): LaunchStarted => ({
  clientMutationId: id,
  subjectId: 'task-1' as EntityId,
  title,
  verb: 'worker',
  teammate: null,
  model: null,
  effort: null,
  accessMode: null,
  workdir: { kind: 'scratch' },
  notes: '',
});
const inputOf = (id: string) => ({ clientMutationId: id }) as ExecutionSpawnInput;

afterEach(() => {
  cleanup();
  resetLaunches();
  resetLaunchTabQueue();
  current = null;
});

let n = 0;
function setup(failure: LaunchTabValues['failure'] = null) {
  n += 1;
  const runtime = createWorkspaceRuntime(`v-body-${String(n)}`, `s-body-${String(n)}`, createWorkspaceStore(`v-body-${String(n)}`, `s-body-${String(n)}`));
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  current = runtime;
  const values: LaunchTabValues = { launchId: 'mut-1', launch: launchOf('mut-1'), input: inputOf('mut-1'), startedAt: Date.now() - 1_000, failure };
  openLaunchTab(runtime, values, 'system');
  const scheduled: (() => void)[] = [];
  const spawnSession = vi.fn().mockResolvedValue('session-1' as EntityId);
  const handoff = createLaunchHandoff({
    viewerId: runtime.viewerId,
    spaceId: runtime.spaceId,
    spawnSession,
    runtimeFor: () => runtime,
    workPresence: () => 'mounted',
    landing: () => 'work',
    schedule: (run) => void scheduled.push(run),
  });
  const host: LaunchPageHost = {
    editAndRetry: vi.fn(),
    dismiss: vi.fn(),
    choose: vi.fn(),
    resume: (l, i, startedAt, f) => handoff.resume({ launchId: l.clientMutationId, launch: l, input: i, startedAt, failure: f }),
  };
  const tab = findLaunchTab(runtime, 'mut-1')!;
  const view = (t: DraftTabRecord = tab) => (
    <LaunchPageHostContext.Provider value={host}>
      <LaunchTabBody tab={t} />
    </LaunchPageHostContext.Provider>
  );
  return { runtime, tab, scheduled, spawnSession, handoff, view };
}

describe('a launch tab re-attaching after a reload', () => {
  it('adopts the launch and its replay survives the re-render the adoption causes', async () => {
    const { scheduled, spawnSession, view } = setup();
    const { rerender } = render(view());
    expect(launchRecord('mut-1')?.state).toBe('starting');
    rerender(view());
    expect(scheduled).toHaveLength(1);

    await act(async () => {
      scheduled[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spawnSession).toHaveBeenCalledWith(inputOf('mut-1'));
    expect(launchRecord('mut-1')).toMatchObject({ state: 'admitted', sessionId: 'session-1' });
  });

  it('a stored refusal draws the failed page at once and replays nothing', () => {
    const { scheduled, spawnSession, view } = setup({ message: 'cap reached', code: 'conflict', uncertain: false });
    render(view());
    expect(screen.getByTestId('session-launching').dataset.state).toBe('failed');
    expect(screen.getByRole('alert').textContent).toContain('cap reached');
    expect(scheduled).toHaveLength(0);
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe('Edit and retry on the page that is on screen', () => {
  it('the retried launch takes the tab over and the mounted body draws the NEW launch', () => {
    const { tab, handoff, view } = setup({ message: 'cap reached', code: 'conflict', uncertain: false });
    render(view());
    expect(screen.getByTestId('session-launching').dataset.state).toBe('failed');

    act(() => {
      expect(handoff.onLaunchStarted(launchOf('mut-2', 'Fix the flaky login test, again'), 'mut-1')).toBe(true);
    });

    expect(screen.getByTestId('tws-launch-tab').dataset.launchId).toBe('mut-2');
    expect(screen.getByTestId('session-launching').dataset.state).toBe('starting');
    expect(screen.getByText('Fix the flaky login test, again')).toBeTruthy();
    expect(screen.queryByTestId('session-launching-retry')).toBeNull();
    expect(findLaunchTab(current!, 'mut-2')?.id).toBe(tab.id);
  });
});

describe('a stored launch that cannot be read', () => {
  it('says it could not be restored, and Dismiss closes the tab', () => {
    const { runtime, tab, view } = setup();
    runtime.drafts.set(tab.draftId, { launchId: 'mut-1', launch: { ...launchOf('mut-1'), workdir: null }, startedAt: 1 });
    render(view());
    expect(screen.getByTestId('tws-launch-tab-unrestorable')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(runtime.store.getState().tabs[tab.id]).toBeUndefined();
  });
});

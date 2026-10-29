// @vitest-environment jsdom
/**
 * A launch tab's body re-attaching after a reload (task 01a182d2), driven
 * through the component: adopting the launch re-renders the body (the store
 * now holds a record), and that re-render must not cancel the replay the
 * hand-off scheduled — the page would read "Launching" forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { LaunchPageHostContext, launchRecord, resetLaunches, type LaunchPageHost } from '../../launch-handoff';
import type { LaunchStarted } from '../../new-session/launch-started';
import { createLaunchHandoff } from '../../views/useLaunchHandoff';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { openLaunchTab, resetLaunchTabQueue, type LaunchTabValues } from '../runtime/launchTabs';
import { createWorkspaceStore } from '../runtime/store';
import { LaunchTabBody } from './LaunchTabBody';

const launch: LaunchStarted = {
  clientMutationId: 'mut-1',
  subjectId: 'task-1' as EntityId,
  title: 'Fix the flaky login test',
  verb: 'worker',
  teammate: null,
  model: null,
  effort: null,
  accessMode: null,
  workdir: { kind: 'scratch' },
  notes: '',
};
const input = { clientMutationId: 'mut-1' } as ExecutionSpawnInput;

afterEach(() => {
  cleanup();
  resetLaunches();
  resetLaunchTabQueue();
});

function setup(failure: LaunchTabValues['failure'] = null) {
  const runtime = createWorkspaceRuntime('v-body', 's-body', createWorkspaceStore('v-body', 's-body'));
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  const values: LaunchTabValues = { launchId: 'mut-1', launch, input, startedAt: Date.now() - 1_000, failure };
  openLaunchTab(runtime, values, 'system');
  const scheduled: (() => void)[] = [];
  const spawnSession = vi.fn().mockResolvedValue('session-1' as EntityId);
  const handoff = createLaunchHandoff({
    viewerId: 'v-body',
    spaceId: 's-body',
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
  const view = () => (
    <LaunchPageHostContext.Provider value={host}>
      <LaunchTabBody values={values} />
    </LaunchPageHostContext.Provider>
  );
  return { runtime, values, scheduled, spawnSession, view };
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
    expect(spawnSession).toHaveBeenCalledWith(input);
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

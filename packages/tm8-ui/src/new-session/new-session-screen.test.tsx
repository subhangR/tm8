// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, EntityId, ExecutionSpawnInput, SpaceId } from '@tm8/contract';

import { NewSessionScreen } from './NewSessionScreen';

/*
 * The retry the error offers. A failed spawn leaves its task behind on
 * purpose — it holds the prompt — and says "press Enter to try the session
 * again". That press must be ACCEPTED — the error used to be passed as a
 * refusal, which withheld Launch for good — and must start a session on THAT
 * task, not mint another.
 */
describe('NewSessionScreen — retry after a failed spawn', () => {
  const teammates = [{ id: 'tm-1', name: 'Ada', initial: 'A', model: 'claude-opus-5', agentTool: 'claude-code', owner: '' }];

  it('reuses the task the failed attempt created, under a fresh request id', async () => {
    const createEntity = vi.fn(async () => ({ entity: { id: 'task-1' }, patches: [] }) as unknown as CommandResult);
    const spawn = vi.fn<(input: ExecutionSpawnInput) => Promise<EntityId>>()
      .mockRejectedValueOnce(new Error('node busy'))
      .mockResolvedValueOnce('ws-1' as EntityId);
    const onSpawned = vi.fn();
    const { getByTestId, findByText } = render(
      <NewSessionScreen
        spaceId={'space-1' as SpaceId}
        commands={{ createEntity }}
        spawn={spawn}
        launch={{ teammates, projects: [] }}
        onSessionReady={() => undefined}
        onSpawned={onSpawned}
        initialDraft="Fix the flaky login test"
      />,
    );

    fireEvent.click(getByTestId('nsx-send'));
    await findByText(/the task was created and still holds your prompt/);
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawned).toHaveBeenCalledWith('ws-1', expect.any(String)));

    expect(createEntity).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls.map(([input]) => input.taskIds)).toEqual([['task-1'], ['task-1']]);
    const [first, second] = spawn.mock.calls.map(([input]) => input.clientMutationId);
    expect(second).not.toBe(first);
  });
});

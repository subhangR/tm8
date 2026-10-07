// @vitest-environment jsdom
/**
 * The save flow's codec seam, and its one retry: a conflict whose winning
 * write left the saved fields alone goes out again on the new version; any
 * conflict over the text itself parks for a person, as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CollabError, type CommandResult, type EntityDetail, type EntityId } from '@tm8/contract';
import { useDocSave, type DocEdits, type SaveCodec } from './index';

function task(description: string, version: number, title = 'Ship it'): EntityDetail {
  return {
    id: 'task-1',
    kind: 'task',
    title,
    version,
    deletedAt: null,
    content: { kind: 'task', description },
    state: { kind: 'task', status: 'open' },
    capabilities: { canEdit: true },
  } as unknown as EntityDetail;
}

const saved = (version: number) => ({ patches: [{ version }] }) as unknown as CommandResult;
const conflict = (current: EntityDetail | null) =>
  new CollabError('version_conflict', 'stale', current ? { current } : { currentVersion: 9 });

interface TaskCommands {
  patchTask(id: EntityId, input: { description?: string; title?: string; expectedVersion: number }): Promise<CommandResult>;
}

const taskCodec: SaveCodec<TaskCommands> = {
  bodyOf: (detail) => String((detail.content as unknown as { description?: string }).description ?? ''),
  send: (commands, id, edits: DocEdits, expectedVersion) =>
    commands.patchTask(id, { ...(edits.body !== undefined ? { description: edits.body } : {}), expectedVersion }),
};

function mount(answers: Array<CommandResult | Error>) {
  const patchTask = vi.fn((_id: EntityId, _input: { expectedVersion: number }) => {
    const next = answers.shift()!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const hook = renderHook(() => useDocSave({ detail: task('old words', 3), commands: { patchTask }, codec: taskCodec }));
  const type = async (body: string) => {
    act(() => hook.result.current.edit({ body }));
    await act(async () => { await hook.result.current.save(); });
  };
  return { hook, patchTask, type };
}

describe('the save codec', () => {
  it("reads and writes through the kind's own codec", async () => {
    const { hook, patchTask, type } = mount([saved(4)]);
    expect(hook.result.current.body).toBe('old words');
    await type('new words');
    expect(patchTask).toHaveBeenCalledWith('task-1', { description: 'new words', expectedVersion: 3 });
    expect(hook.result.current.state.phase).toBe('clean');
  });

  it('a conflict that left the description alone (a status change) saves again on the new version', async () => {
    const { hook, patchTask, type } = mount([conflict(task('old words', 4)), saved(5)]);
    await type('new words');
    expect(patchTask.mock.calls.map(([, input]) => input.expectedVersion)).toEqual([3, 4]);
    expect(hook.result.current.state.phase).toBe('clean');
  });

  it('a conflict over the description itself parks for a person', async () => {
    const { hook, patchTask, type } = mount([conflict(task('their words', 4))]);
    await type('new words');
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.phase).toBe('conflict');
    expect(hook.result.current.body).toBe('new words');
  });

  it('a conflict that does not carry their record parks too: nothing to prove it safe', async () => {
    const { hook, patchTask, type } = mount([conflict(null)]);
    await type('new words');
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.phase).toBe('conflict');
  });

  it('retries once at most', async () => {
    const { hook, patchTask, type } = mount([conflict(task('old words', 4)), conflict(task('old words', 5))]);
    await type('new words');
    expect(patchTask).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state.phase).toBe('conflict');
  });
});

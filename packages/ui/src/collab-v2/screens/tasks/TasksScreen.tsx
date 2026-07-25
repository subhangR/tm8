/**
 * Tasks — one CollectionView over the space's tasks.
 *
 * Board is the default; Tree is the same query in the hierarchy layout; Select
 * is the same query again with checkboxes for bulk ops. The pivot chips are
 * the collection system's own `GroupByPivot` fed from `getTaskAxes`, so status,
 * assignee, the default `type` axis and any manual axis are indistinguishable —
 * both to the user and to the mutation that a move produces.
 */
import { useEffect, useMemo, useState } from 'react';
import { CollectionView, GroupByPivot, type GroupByKey } from '../../collections';
import { Eyebrow } from '../../kit';
import { useNavStore } from '../../stores';
import { useAsyncValue, type ShellViewProps, type ViewRegistry } from '../../shell';
import type { CollectionQuery } from '../../types/contract';
import { BulkBar } from './BulkBar';
import { SelectableTaskList } from './SelectableTaskList';

const MODES = [
  { key: 'board', label: 'Board' },
  { key: 'tree', label: 'Tree' },
  { key: 'select', label: 'Select' },
] as const;

type TasksMode = typeof MODES[number]['key'];

export function TasksScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const [mode, setMode] = useState<TasksMode>('board');
  const [pivot, setPivot] = useState<GroupByKey | undefined>('workStatus');
  const setSelection = useNavStore((s) => s.setSelection);

  const { value: axes } = useAsyncValue(() => facade.getTaskAxes(spaceId), [facade, spaceId]);

  const query: CollectionQuery = useMemo(
    () => ({ spaceId, kinds: ['task'], sort: 'position' }),
    [spaceId],
  );

  // Leaving select mode drops the selection so a stale bulk bar can't linger.
  useEffect(() => {
    if (mode !== 'select') setSelection([]);
  }, [mode, setSelection]);

  return (
    <div className="cv2-tasks" data-testid="view-tasks">
      <header className="cv2-tasks__header">
        <Eyebrow>tasks</Eyebrow>
        <h1 className="cv2-tasks__h1">Tasks</h1>
        <div className="cv2-tasks__controls">
          <div className="cv2-tasks__modes" role="tablist" aria-label="Task layout">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={mode === m.key}
                className="cv2-tasks__mode"
                data-active={mode === m.key ? 'true' : undefined}
                data-testid={`tasks-mode-${m.key}`}
                onClick={() => setMode(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <GroupByPivot value={pivot} axes={axes ?? []} onChange={setPivot} />
        </div>
      </header>

      <div className="cv2-tasks__body">
        {mode === 'select'
          ? <SelectableTaskList query={query} onOpen={onOpenEntity} />
          : (
            <CollectionView
              // Remounting on a pivot change is what makes "None" re-group too:
              // CollectionView only adopts a truthy `groupBy` after mount.
              key={`${mode}:${pivot ?? 'none'}`}
              query={query}
              layout={mode}
              groupBy={pivot}
              showControls={false}
              onOpenEntity={onOpenEntity}
            />
          )}
      </div>

      <BulkBar query={query} groupBy={pivot ?? 'workStatus'} axes={axes ?? []} />
    </div>
  );
}

/** ViewRegistry fragment — the shell composes screen fragments into `views`. */
export const tasksViews: ViewRegistry = { tasks: TasksScreen };

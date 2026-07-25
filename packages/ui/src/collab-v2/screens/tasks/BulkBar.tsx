/**
 * Bulk operations — "move the selection to <column>", where the columns are
 * exactly the current pivot's board columns.
 *
 * The pivot decides the mutation the same way a board drop does, through the
 * SAME helpers (`moveTaskToStatus` / `moveTaskToAxisValue` / `assignTaskTo`),
 * so a default axis, a manual axis, status and assignee are one code path and
 * the axes map is merged rather than replaced.
 */
import { useState } from 'react';
import {
  assignTaskTo, axisNameOf, boardColumns, moveTaskToAxisValue, moveTaskToStatus,
  useCollection, type GroupByKey,
} from '../../collections';
import { useFacade } from '../../entity';
import { useNavStore } from '../../stores';
import { pushToast } from '../../subsystems/live';
import type {
  CollectionQuery, EntitySummary, TaskAxis, WorkStatus,
} from '../../types/contract';

export interface BulkBarProps {
  query: CollectionQuery;
  groupBy: GroupByKey;
  axes: TaskAxis[];
}

export function BulkBar({ query, groupBy, axes }: BulkBarProps) {
  const facade = useFacade();
  const { items } = useCollection(query);
  const selection = useNavStore((s) => s.selection);
  const setSelection = useNavStore((s) => s.setSelection);
  const [busy, setBusy] = useState(false);

  const chosen = items.filter((i) => selection.includes(i.id));
  if (chosen.length === 0) return null;

  const columns = boardColumns(items, groupBy, axes)
    .filter((c) => !(groupBy === 'assignee' && c.key === 'unassigned'));

  const applyOne = (entity: EntitySummary, columnKey: string) => {
    if (groupBy === 'workStatus') return moveTaskToStatus(facade, entity, columnKey as WorkStatus);
    if (groupBy === 'assignee') return assignTaskTo(facade, entity, columnKey);
    return moveTaskToAxisValue(facade, entity, axisNameOf(groupBy) as string, columnKey);
  };

  const apply = async (columnKey: string, label: string): Promise<void> => {
    setBusy(true);
    try {
      const outcomes = await Promise.all(chosen.map((entity) => applyOne(entity, columnKey)));
      const failed = outcomes.filter((o) => !o.ok).length;
      pushToast(failed === 0
        ? { kind: 'success', message: `Moved ${chosen.length} task${chosen.length === 1 ? '' : 's'} to ${label}` }
        : { kind: 'error', message: `${failed} of ${chosen.length} didn't move — rolled back` });
      if (failed === 0) setSelection([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cv2-tasks__bulk" role="region" aria-label="Bulk actions" data-testid="tasks-bulkbar">
      <span className="cv2-tasks__bulkcount" data-testid="bulk-count">
        {chosen.length} selected
      </span>
      <span className="cv2-tasks__bulklabel">move to</span>
      {columns.map((col) => (
        <button
          key={col.key}
          type="button"
          className="cv2-tasks__bulkchip"
          disabled={busy}
          data-testid={`bulk-to-${col.key}`}
          onClick={() => void apply(col.key, col.label)}
        >
          {col.label}
        </button>
      ))}
      <button
        type="button"
        className="cv2-tasks__bulkclear"
        onClick={() => setSelection([])}
      >
        clear
      </button>
    </div>
  );
}

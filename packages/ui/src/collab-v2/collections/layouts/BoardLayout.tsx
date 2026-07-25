/**
 * Board layout — group columns from the pivot; dragging a card between
 * columns IS the matching mutation:
 *
 *   groupBy 'workStatus'  → patchTask({ workStatus })
 *   groupBy 'axis:<name>' → patchTask({ axes }) (merged map)
 *   groupBy 'assignee'    → placements(intent 'assign')
 *
 * A ghost preview ("Move to <column>") renders in the hovered column before
 * the drop; the mutation is optimistic with rollback (and version-conflict
 * adoption) via collections/mutations. Default and manual axes take the
 * exact same path — the board never knows which one it is pivoting on.
 */
import { useState } from 'react';
import { EntityCard, useFacade } from '../../entity';
import { Pill } from '../../kit';
import { kindCan } from '../../registry';
import type { EntityId, EntitySummary, TaskAxis, WorkStatus } from '../../types/contract';
import { hasDragPayload, readDragPayload, setDragPayload } from '../dnd';
import { boardColumns, axisNameOf, type GroupByKey } from '../grouping';
import {
  assignTaskTo, moveTaskToAxisValue, moveTaskToStatus, type MutationOutcome,
} from '../mutations';
import type { RowAction, RowSelection } from '../slots';
import { useListNav } from '../useListNav';

export interface BoardLayoutProps {
  items: EntitySummary[];
  groupBy: GroupByKey;
  axes?: TaskAxis[];
  onOpen: (id: EntityId) => void;
  rowAction?: RowAction;
  selection?: RowSelection;
  /** Fires after a failed drop (already rolled back); banner is built in. */
  onMutationError?: (outcome: MutationOutcome) => void;
}

interface DragHover { columnKey: string; title: string }

export function BoardLayout({ items, groupBy, axes, onOpen, rowAction, selection, onMutationError }: BoardLayoutProps) {
  const facade = useFacade();
  const columns = boardColumns(items, groupBy, axes);
  const [hover, setHover] = useState<DragHover | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const byId = new Map(items.map((i) => [i.id, i]));

  const dropOn = async (columnKey: string, entityId: EntityId): Promise<void> => {
    const entity = byId.get(entityId);
    if (!entity) return;
    let outcome: MutationOutcome;
    if (groupBy === 'workStatus') {
      outcome = await moveTaskToStatus(facade, entity, columnKey as WorkStatus);
    } else if (groupBy === 'assignee') {
      if (columnKey === 'unassigned') return; // unassign is a rail action, not a drop
      outcome = await assignTaskTo(facade, entity, columnKey);
    } else {
      outcome = await moveTaskToAxisValue(facade, entity, axisNameOf(groupBy) as string, columnKey);
    }
    if (!outcome.ok) {
      setBanner(outcome.conflict
        ? `Someone changed “${entity.title}” first — reloaded the latest version.`
        : `Couldn't move “${entity.title}” — change rolled back.`);
      onMutationError?.(outcome);
    }
  };

  return (
    <div className="cv2-board" role="group" aria-label="Board">
      {banner && (
        <div className="cv2-board__banner" role="alert">
          {banner}
          <button type="button" className="cv2-board__bannerclose" onClick={() => setBanner(null)}>✕</button>
        </div>
      )}
      <div className="cv2-board__columns">
        {columns.map((col) => (
          <div
            key={col.key}
            className={`cv2-board__col${hover?.columnKey === col.key ? ' cv2-board__col--over' : ''}`}
            data-column={col.key}
            onDragOver={(e) => {
              if (!hasDragPayload(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDragEnter={(e) => {
              if (!hasDragPayload(e)) return;
              setHover({ columnKey: col.key, title: col.label });
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setHover((h) => (h?.columnKey === col.key ? null : h));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setHover(null);
              const payload = readDragPayload(e);
              if (payload) void dropOn(col.key, payload.entityId);
            }}
          >
            <div className="cv2-board__colhead">
              <span className="cv2-board__collabel">{col.label}</span>
              <span className="cv2-board__colcount">{col.items.length}</span>
            </div>
            {hover?.columnKey === col.key && (
              <div className="cv2-board__ghost" data-testid={`ghost-${col.key}`}>
                Move to <strong>{col.label}</strong>
              </div>
            )}
            <BoardColumnCards items={col.items} onOpen={onOpen} rowAction={rowAction} selection={selection} />
            {col.items.length === 0 && hover?.columnKey !== col.key && (
              <div className="cv2-board__coldrop">drop a card here</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardColumnCards({ items, onOpen, rowAction, selection }: {
  items: EntitySummary[];
  onOpen: (id: EntityId) => void;
  rowAction?: RowAction;
  selection?: RowSelection;
}) {
  const nav = useListNav(items.length, (i) => { if (items[i]) onOpen(items[i].id); });
  const slots = Boolean(rowAction || selection);
  return (
    <div className="cv2-board__cards" onKeyDown={nav.onKeyDown}>
      {items.map((entity, i) => (
        <div
          key={entity.id}
          className={`cv2-collection__cell${slots ? ' cv2-collection__cell--slots' : ''}`}
          draggable={kindCan(entity.kind, 'workStatusBearing')}
          onDragStart={(e) => setDragPayload(e, entity)}
          onClick={() => onOpen(entity.id)}
          onFocus={() => nav.setIndex(i)}
          {...nav.cellProps(i)}
        >
          {selection && (
            <input
              type="checkbox"
              className="cv2-collection__check"
              checked={selection.selectedIds.has(entity.id)}
              onChange={() => selection.onToggle(entity.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${entity.title}`}
            />
          )}
          <div className="cv2-collection__cellbody">
            <EntityCard entity={entity} />
          </div>
          {rowAction && (
            <span className="cv2-collection__rowaction" onClick={(e) => e.stopPropagation()}>
              {rowAction(entity)}
            </span>
          )}
          {!kindCan(entity.kind, 'workStatusBearing') && (
            <span className="cv2-board__nodrag"><Pill tone="neutral" dot={false}>read-only here</Pill></span>
          )}
        </div>
      ))}
    </div>
  );
}

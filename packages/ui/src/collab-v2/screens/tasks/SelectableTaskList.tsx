/**
 * Select mode — the same live query as the board, rendered as checkable Z2
 * rows. Selection lives in the nav store (already URL-adjacent state), so the
 * bulk bar and the list never hold two copies of it.
 */
import { useCollection } from '../../collections';
import { useFacade } from '../../entity';
import { useNavStore } from '../../stores';
import type { CollectionQuery, EntityId } from '../../types/contract';
import { EntityRow } from '../home/rows';

export interface SelectableTaskListProps {
  query: CollectionQuery;
  onOpen: (id: EntityId) => void;
}

export function SelectableTaskList({ query, onOpen }: SelectableTaskListProps) {
  const facade = useFacade();
  const { items, loading } = useCollection(query);
  const selection = useNavStore((s) => s.selection);
  const toggleSelected = useNavStore((s) => s.toggleSelected);
  const setSelection = useNavStore((s) => s.setSelection);

  const allSelected = items.length > 0 && items.every((i) => selection.includes(i.id));

  return (
    <div className="cv2-tasks__select" data-testid="tasks-select">
      <div className="cv2-tasks__selecthead">
        <label className="cv2-tasks__selectall">
          <input
            type="checkbox"
            checked={allSelected}
            aria-label="Select all tasks"
            onChange={() => setSelection(allSelected ? [] : items.map((i) => i.id))}
          />
          select all
        </label>
      </div>
      {loading && items.length === 0 && <div className="cv2-tasks__loading" role="status">loading…</div>}
      <div className="cv2-tasks__selectrows">
        {items.map((entity) => (
          <EntityRow
            key={entity.id}
            entity={entity}
            facade={facade}
            onOpen={onOpen}
            selected={selection.includes(entity.id)}
            onToggleSelected={toggleSelected}
          />
        ))}
      </div>
    </div>
  );
}

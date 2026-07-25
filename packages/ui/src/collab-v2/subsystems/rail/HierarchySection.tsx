/**
 * HierarchySection — the vertical axis of the rail: parent chip UP, ordered
 * children DOWN. Children reorder (↑/↓), reparent-out, add-child and
 * "open as tree / board" are all INTENT CALLBACKS — the rail decides what a
 * gesture means, W4 wires the pointer-level drag grammar (@dnd-kit) and W3
 * wires the collection routes into the same callbacks.
 *
 * Drop targets are already live at the DOM level: dropping an entity chip on
 * the children list is a reparent intent, which is exactly what the drag
 * grammar table says it should be.
 */
import { useState } from 'react';
import { ENTITY_DRAG_MIME, EntityChip, type EntityDragPayload } from '../../entity';
import { IconBtn } from '../../kit';
import type { EntityId, Hierarchy } from '../../types/contract';
import { planReorder, type ReorderPlan } from './model';

export interface HierarchySectionProps {
  entityId: EntityId;
  hierarchy: Hierarchy;
  canAddChild: boolean;
  canEdit: boolean;
  onOpenEntity?: (id: EntityId) => void;
  onAddChild?: (parentId: EntityId) => void;
  onReorder?: (plan: ReorderPlan) => void;
  onReparent?: (move: { childId: EntityId; newParentId: EntityId | null }) => void;
  /** W3 collection routes: open this family as a tree or a board. */
  onOpenCollection?: (intent: { entityId: EntityId; layout: 'tree' | 'board' }) => void;
  childrenLoading?: boolean;
  onLoadMoreChildren?: () => void;
}

export function HierarchySection({
  entityId, hierarchy, canAddChild, canEdit, onOpenEntity, onAddChild,
  onReorder, onReparent, onOpenCollection, childrenLoading = false, onLoadMoreChildren,
}: HierarchySectionProps) {
  const [dropActive, setDropActive] = useState(false);
  const children = hierarchy.children.items;
  const total = hierarchy.children.total ?? children.length;
  const canReorder = canEdit && onReorder != null && children.length > 1;

  const move = (index: number, direction: 'up' | 'down'): void => {
    const plan = planReorder(children, index, direction);
    if (plan) onReorder?.(plan);
  };

  return (
    <section className="cv2-rail__hierarchy" aria-label="Hierarchy">
      <header className="cv2-rail__grouphead">
        <span className="cv2-eyebrow">Hierarchy</span>
        {children.length > 0 && <span className="cv2-rail__count">{total}</span>}
        <span className="cv2-rail__spacer" />
        <button
          type="button"
          className="cv2-actionbtn"
          disabled={!onOpenCollection}
          title={onOpenCollection ? 'Open this family as a tree' : 'Wire onOpenCollection to open the tree view'}
          onClick={() => onOpenCollection?.({ entityId, layout: 'tree' })}
        >
          Open as tree
        </button>
        <button
          type="button"
          className="cv2-actionbtn"
          disabled={!onOpenCollection}
          title={onOpenCollection ? 'Open this family as a board' : 'Wire onOpenCollection to open the board view'}
          onClick={() => onOpenCollection?.({ entityId, layout: 'board' })}
        >
          Open as board
        </button>
      </header>

      <div className="cv2-rail__updown">
        <span className="cv2-rail__axis" aria-hidden="true">↑</span>
        {hierarchy.parent
          ? (
            <>
              <EntityChip entity={hierarchy.parent} onOpen={onOpenEntity} />
              {canEdit && onReparent && (
                <IconBtn
                  aria-label="Detach from parent"
                  title="Move out of this parent (top of its tree)"
                  onClick={() => onReparent({ childId: entityId, newParentId: null })}
                >
                  ⤴
                </IconBtn>
              )}
            </>
          )
          : <span className="cv2-empty-line">Top of its tree.</span>}
      </div>

      <div
        className="cv2-rail__children"
        data-dropzone="children"
        data-dropactive={dropActive || undefined}
        onDragOver={(e) => {
          if (!canEdit || !onReparent || !e.dataTransfer.types.includes(ENTITY_DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          setDropActive(false);
          if (!canEdit || !onReparent) return;
          const raw = e.dataTransfer.getData(ENTITY_DRAG_MIME);
          if (!raw) return;
          e.preventDefault();
          try {
            const payload = JSON.parse(raw) as EntityDragPayload;
            if (payload.entityId && payload.entityId !== entityId) {
              onReparent({ childId: payload.entityId, newParentId: entityId });
            }
          } catch { /* not our payload */ }
        }}
      >
        <span className="cv2-rail__axis" aria-hidden="true">↓</span>
        {children.length === 0 && <span className="cv2-empty-line">No children yet.</span>}
        <ol className="cv2-rail__childlist">
          {children.map((child, index) => (
            <li key={child.id} className="cv2-rail__item">
              <span className="cv2-rail__ordinal">{index + 1}</span>
              <EntityChip entity={child} onOpen={onOpenEntity} />
              {canReorder && (
                <span className="cv2-rail__reorder">
                  <IconBtn
                    aria-label={`Move ${child.title} up`}
                    disabled={index === 0}
                    onClick={() => move(index, 'up')}
                  >
                    ↑
                  </IconBtn>
                  <IconBtn
                    aria-label={`Move ${child.title} down`}
                    disabled={index === children.length - 1}
                    onClick={() => move(index, 'down')}
                  >
                    ↓
                  </IconBtn>
                </span>
              )}
              {canEdit && onReparent && (
                <IconBtn
                  aria-label={`Move ${child.title} out`}
                  title="Reparent up one level"
                  onClick={() => onReparent({ childId: child.id, newParentId: hierarchy.parent?.id ?? null })}
                >
                  ⤴
                </IconBtn>
              )}
            </li>
          ))}
        </ol>
        {hierarchy.children.nextCursor && (
          <button
            type="button"
            className="cv2-rail__showall"
            disabled={childrenLoading}
            onClick={() => onLoadMoreChildren?.()}
          >
            {childrenLoading ? 'Loading…' : `Show more children (${total - children.length} left)`}
          </button>
        )}
        {canAddChild && (
          <button
            type="button"
            className="cv2-actionbtn"
            disabled={!onAddChild}
            title={onAddChild ? 'Add a child' : 'Wire onAddChild to create children here'}
            onClick={() => onAddChild?.(entityId)}
          >
            + Add child
          </button>
        )}
      </div>
    </section>
  );
}

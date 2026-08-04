/**
 * Tree layout — hierarchy rows with expand/collapse, PAGED children (each
 * expansion is a `getHierarchy` Page with a load-more cursor), and
 * drag-reparent: dropping a row onto a same-kind row calls `moveEntity`
 * (drag gated by the registry's `treeReparentable` capability — DEF-9).
 *
 * Roots are the query items whose parent isn't itself in the result (so a
 * `subtreeOf` query shows the subtree's top level); children always come
 * from the facade so paging and out-of-page children are correct.
 * `expandDepth` auto-opens the first N levels (children load lazily as the
 * auto-open effect reaches them); user toggles always win over the default.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFacade } from '../../entity';
import { Pill } from '../../kit';
import { kindCan, registryFor } from '../../registry';
import type { Cursor, EntityId, EntitySummary } from '../../types/contract';
import { hasDragPayload, readDragPayload, setDragPayload } from '../dnd';
import { reparentEntity, type MutationOutcome } from '../mutations';
import type { RowAction, RowSelection } from '../slots';

export interface TreeLayoutProps {
  items: EntitySummary[];
  onOpen: (id: EntityId) => void;
  /** Levels auto-expanded on mount (0 = all roots collapsed, the default). */
  expandDepth?: number;
  rowAction?: RowAction;
  selection?: RowSelection;
  /** Refetch the collection after a successful reparent. */
  onChanged?: () => void;
  onMutationError?: (outcome: MutationOutcome) => void;
}

interface ChildrenSlice { items: EntitySummary[]; nextCursor: Cursor | null; loading: boolean }

export function TreeLayout({
  items, onOpen, expandDepth = 0, rowAction, selection, onChanged, onMutationError,
}: TreeLayoutProps) {
  const facade = useFacade();
  const [expanded, setExpanded] = useState<Record<EntityId, boolean>>({});
  const [children, setChildren] = useState<Record<EntityId, ChildrenSlice>>({});
  const [dropTarget, setDropTarget] = useState<EntityId | null>(null);
  const [dragged, setDragged] = useState<EntitySummary | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const loadChildren = useCallback(async (id: EntityId, cursor?: Cursor): Promise<void> => {
    setChildren((c) => ({
      ...c,
      [id]: { items: cursor ? c[id]?.items ?? [] : [], nextCursor: c[id]?.nextCursor ?? null, loading: true },
    }));
    const h = await facade.getHierarchy(id, cursor);
    setChildren((c) => {
      const prior = cursor ? c[id]?.items ?? [] : [];
      const have = new Set(prior.map((i) => i.id));
      return {
        ...c,
        [id]: {
          items: [...prior, ...h.children.items.filter((i) => !have.has(i.id))],
          nextCursor: h.children.nextCursor,
          loading: false,
        },
      };
    });
  }, [facade]);

  const isOpen = useCallback(
    (id: EntityId, depth: number): boolean => expanded[id] ?? depth < expandDepth,
    [expanded, expandDepth],
  );

  const toggle = (id: EntityId, open: boolean): void => {
    if (open && !children[id]) void loadChildren(id);
    setExpanded((ex) => ({ ...ex, [id]: open }));
  };

  const ids = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const roots = useMemo(
    () => items.filter((i) => i.parentId == null || !ids.has(i.parentId)),
    [items, ids],
  );

  // Auto-open effect: load children for every default-open row that hasn't
  // loaded yet, level by level as slices arrive. Guarded by `!children[id]`
  // (a loading slice counts as present), so each row loads at most once.
  useEffect(() => {
    if (expandDepth <= 0) return;
    const need: EntityId[] = [];
    const visit = (list: EntitySummary[], depth: number): void => {
      for (const e of list) {
        if (!isOpen(e.id, depth)) continue;
        const slice = children[e.id];
        if (!slice) need.push(e.id);
        else visit(slice.items, depth + 1);
      }
    };
    visit(roots, 0);
    need.forEach((id) => void loadChildren(id));
  }, [roots, expandDepth, children, isOpen, loadChildren]);

  const dropOn = async (target: EntitySummary, payload: { entityId: EntityId; kind: string }): Promise<void> => {
    if (payload.entityId === target.id) return;
    if (payload.kind !== target.kind) {
      setBanner(`Hierarchy is same-kind only — can't nest a ${payload.kind} under a ${target.kind}.`);
      return;
    }
    const source = findLoaded(payload.entityId, items, children);
    if (!source) return;
    const position = children[target.id]?.items.length ?? 0;
    const outcome = await reparentEntity(facade, source, target.id, position);
    if (!outcome.ok) {
      setBanner(outcome.conflict
        ? `Someone moved “${source.title}” first — reloaded the latest version.`
        : `Couldn't move “${source.title}” — change rolled back.`);
      onMutationError?.(outcome);
      return;
    }
    // Reload every loaded slice that could have gained/lost the row.
    setChildren({});
    setExpanded((ex) => ({ ...ex, [target.id]: true }));
    void loadChildren(target.id);
    onChanged?.();
  };

  const renderRow = (entity: EntitySummary, depth: number): React.ReactNode => {
    const slice = children[entity.id];
    const open = isOpen(entity.id, depth);
    const entry = registryFor(entity.kind);
    const status = entry.status.current(entity);
    return (
      <div key={entity.id} className="cv2-tree__node">
        <div
          className={[
            'cv2-tree__row',
            dropTarget === entity.id ? 'cv2-tree__row--over' : '',
          ].filter(Boolean).join(' ')}
          style={{ paddingLeft: depth * 20 }}
          draggable={kindCan(entity.kind, 'treeReparentable')}
          onDragStart={(e) => { setDragged(entity); setDragPayload(e, entity); }}
          onDragEnd={() => { setDragged(null); setDropTarget(null); }}
          onDragOver={(e) => {
            if (!hasDragPayload(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget(entity.id);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDropTarget((t) => (t === entity.id ? null : t));
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDropTarget(null);
            const payload = readDragPayload(e);
            if (payload) void dropOn(entity, payload);
          }}
        >
          <button
            type="button"
            className={`cv2-tree__caret${open ? ' cv2-tree__caret--open' : ''}`}
            aria-label={open ? `collapse ${entity.title}` : `expand ${entity.title}`}
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); toggle(entity.id, !open); }}
          >
            ▸
          </button>
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
          <span className="cv2-chip__glyph" style={{ color: entry.tint(entity) }} aria-hidden="true">
            {entry.glyph}
          </span>
          <button type="button" className="cv2-tree__title" onClick={() => onOpen(entity.id)}>
            {entity.title}
          </button>
          {status && (
            <span className="cv2-tree__meta">
              <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>
            </span>
          )}
          {rowAction && (
            <span className="cv2-collection__rowaction" onClick={(e) => e.stopPropagation()}>
              {rowAction(entity)}
            </span>
          )}
        </div>
        {dropTarget === entity.id && dragged && dragged.id !== entity.id && (
          <div className="cv2-tree__ghost" style={{ marginLeft: (depth + 1) * 20 }}>
            make <strong>{dragged.title}</strong> a child of <strong>{entity.title}</strong>
          </div>
        )}
        {open && (
          <div className="cv2-tree__children">
            {slice?.items.map((child) => renderRow(child, depth + 1))}
            {slice?.loading && <div className="cv2-tree__loading" style={{ paddingLeft: (depth + 1) * 20 }}>loading…</div>}
            {!slice?.loading && slice?.items.length === 0 && (
              <div className="cv2-tree__leaf" style={{ paddingLeft: (depth + 1) * 20 }}>no children</div>
            )}
            {slice?.nextCursor && !slice.loading && (
              <button
                type="button"
                className="cv2-tree__more"
                style={{ marginLeft: (depth + 1) * 20 }}
                onClick={() => void loadChildren(entity.id, slice.nextCursor ?? undefined)}
              >
                load more children
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="cv2-tree" role="tree">
      {banner && (
        <div className="cv2-board__banner" role="alert">
          {banner}
          <button type="button" className="cv2-board__bannerclose" onClick={() => setBanner(null)}>✕</button>
        </div>
      )}
      {roots.map((r) => renderRow(r, 0))}
    </div>
  );
}

function findLoaded(
  id: EntityId,
  items: EntitySummary[],
  children: Record<EntityId, ChildrenSlice>,
): EntitySummary | null {
  const inItems = items.find((i) => i.id === id);
  if (inItems) return inItems;
  for (const slice of Object.values(children)) {
    const hit = slice.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

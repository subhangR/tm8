/**
 * A DESIGN'S PAGE ROW (Craft → Designs, D5 and change list items 10, 12): the
 * Workspace tab strip's LOOK (`tabstrip.css`), driven by the design's own
 * ordered pages — not by the Workspace runtime, and with no per-user tab
 * state. Everyone sees the same row.
 *
 *  · a page changed while it is not the active one carries an "updated" dot;
 *    agents never switch your page;
 *  · drag a tab (or Alt+←/→ on it) to reorder — one position write;
 *  · ⋯ on a tab → "Remove from design", which takes the page out of the
 *    design and never deletes the entity;
 *  · ＋ → a new Graph / Doc / Artifact / Drawing / Design page, or "Add
 *    existing entity…".
 *
 * `size="nested"` is the smaller second row a nested design page draws (D7),
 * one existing type step down.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { getKind, KindIcon } from '../domain';
import { MembershipPicker } from '../panels/bodies/MembershipBlock';
import { NEW_PAGE_KINDS, type DesignPageRow, type NewPageKind } from './design-source';
import '../tab-workspace/view/tabstrip.css';

export interface PageRowProps {
  pages: readonly DesignPageRow[];
  activeId: EntityId | null;
  /** Pages changed while not active. */
  updated: ReadonlySet<string>;
  size?: 'main' | 'nested';
  /** The row's accessible name ("Pages of Launch plan"). */
  label: string;
  onSelect(id: EntityId): void;
  /** Move `id` so it sits at `index` in the order WITHOUT it. */
  onMove(id: EntityId, index: number): void;
  onRemove(id: EntityId): void;
  onNew(kind: NewPageKind): void;
  onAddExisting(id: EntityId): void;
  /** Candidates for "Add existing entity…" (one bounded recent page). */
  candidates(text: string): Promise<EntitySummary[]>;
  /** The design itself, never offered as its own page. */
  ownerId: EntityId;
}

/** A tab's reorder on the keyboard: Alt+← / Alt+→. */
function moveKey(event: KeyboardEvent): -1 | 1 | 0 {
  if (!event.altKey) return 0;
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
}

export function PageRow({
  pages,
  activeId,
  updated,
  size = 'main',
  label,
  onSelect,
  onMove,
  onRemove,
  onNew,
  onAddExisting,
  candidates,
  ownerId,
}: PageRowProps) {
  const [dragId, setDragId] = useState<EntityId | null>(null);
  const [menuFor, setMenuFor] = useState<EntityId | null>(null);
  /* The tab menu is drawn OUTSIDE the scroller (which clips), under its tab. */
  const [menuLeft, setMenuLeft] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  /* One popover open at a time; an outside press or Escape closes it. */
  const open = menuFor !== null || addOpen;
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setMenuFor(null);
      setAddOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest?.('.dsn-menu, .dsn-tab-more, .dsn-add')) close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const dropAt = (event: DragEvent, targetId: EntityId) => {
    event.preventDefault();
    const moving = dragId ?? (event.dataTransfer.getData('text/x-design-page') as EntityId);
    setDragId(null);
    if (!moving || moving === targetId) return;
    const without = pages.filter((page) => page.id !== moving);
    const at = without.findIndex((page) => page.id === targetId);
    if (at === -1) return;
    /* Dropped on the right half of a tab ⇒ after it. */
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = rect.width > 0 && event.clientX > rect.left + rect.width / 2;
    onMove(moving, at + (after ? 1 : 0));
  };

  const excluded = new Set<string>([ownerId, ...pages.map((page) => page.id)]);

  return (
    <div className={`dsn-pages dsn-pages--${size}`} ref={rowRef} data-testid={size === 'nested' ? 'dsn-nested-pages' : 'dsn-pages'}>
      <div className="tws-ts-scroll dsn-pages__scroll" role="tablist" aria-label={label}>
        {pages.map((page, index) => {
          const active = page.id === activeId;
          const isUpdated = !active && updated.has(page.id);
          return (
            <div
              key={page.id}
              className="tws-ts-tab dsn-tab"
              data-active={active || undefined}
              data-dragging={dragId === page.id || undefined}
              data-testid="dsn-tab"
              data-page={page.id}
              draggable
              onDragStart={(event) => {
                setDragId(page.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/x-design-page', page.id);
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => dropAt(event, page.id)}
            >
              <button
                type="button"
                role="tab"
                className="tws-ts-tab-main"
                aria-selected={active}
                tabIndex={active || (activeId === null && index === 0) ? 0 : -1}
                title={`${page.title} — ${getKind(page.kind).label}${isUpdated ? ' (updated)' : ''}`}
                onClick={() => onSelect(page.id)}
                onKeyDown={(event) => {
                  const step = moveKey(event);
                  if (step !== 0) {
                    event.preventDefault();
                    const target = index + step;
                    if (target >= 0 && target < pages.length) onMove(page.id, target);
                    return;
                  }
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const next = pages[(index + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length];
                  if (!next) return;
                  onSelect(next.id);
                  rowRef.current?.querySelector<HTMLElement>(`[data-page="${next.id}"] [role="tab"]`)?.focus();
                }}
              >
                <span className="tws-ts-icon">
                  <KindIcon kind={page.kind} size={size === 'nested' ? 12 : 14} />
                </span>
                <span className="tws-ts-title">{page.title}</span>
              </button>
              <span className="tws-ts-slot">
                {isUpdated ? (
                  <span className="tws-ts-state dsn-updated" data-state="updated" data-testid="dsn-updated" aria-label="Updated" />
                ) : page.running ? (
                  <span className="tws-ts-state" data-state="running" aria-label="Running" />
                ) : null}
                <button
                  type="button"
                  className="dsn-tab-more"
                  aria-label={`Page actions for ${page.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === page.id}
                  data-testid="dsn-tab-more"
                  onClick={(event) => {
                    setAddOpen(false);
                    const tab = event.currentTarget.closest<HTMLElement>('.dsn-tab');
                    const scroller = tab?.parentElement;
                    setMenuLeft(tab && scroller ? tab.offsetLeft - scroller.scrollLeft : 0);
                    setMenuFor((was) => (was === page.id ? null : page.id));
                  }}
                >
                  ⋯
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {menuFor !== null ? (
        <div className="dsn-menu pn-overflow__menu" role="menu" data-testid="dsn-tab-menu" style={{ left: menuLeft }}>
          <button
            type="button"
            role="menuitem"
            className="pn-overflow__item"
            data-testid="dsn-remove-page"
            title="Takes the page out of this design; the entity itself is kept"
            onClick={() => {
              const id = menuFor;
              setMenuFor(null);
              onRemove(id);
            }}
          >
            Remove from design
          </button>
        </div>
      ) : null}
      <div className="dsn-add">
        <button
          type="button"
          className="dsn-add__btn"
          aria-label="Add a page"
          title="Add a page"
          aria-haspopup="menu"
          aria-expanded={addOpen}
          data-testid="dsn-add-page"
          onClick={() => {
            setMenuFor(null);
            setAddOpen((was) => !was);
          }}
        >
          ＋{size === 'main' ? <span className="dsn-add__label">page</span> : null}
        </button>
        {addOpen ? (
          <div className="dsn-menu dsn-menu--add pn-overflow__menu" role="menu" data-testid="dsn-add-menu">
            {NEW_PAGE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className="pn-overflow__item dsn-menu__kind"
                data-testid={`dsn-new-${kind}`}
                title={kind === 'artifact' ? 'Artifacts are published by the craft agent — this asks it in the chat' : undefined}
                onClick={() => {
                  setAddOpen(false);
                  onNew(kind);
                }}
              >
                <KindIcon kind={kind} size={14} /> {getKind(kind).label}
              </button>
            ))}
            <div className="dsn-menu__sep" role="separator" />
            <MembershipPicker
              search={candidates}
              excludeIds={excluded}
              addLabel="Add existing entity…"
              onPick={(id) => {
                setAddOpen(false);
                onAddExisting(id as EntityId);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

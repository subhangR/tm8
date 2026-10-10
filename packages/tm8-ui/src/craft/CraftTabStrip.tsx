/**
 * THE CRAFT'S TAB STRIP (Craft redesign doc 01a1255d §3, "3rd panel — tabs"):
 *
 *   [pages ▾] [▣ Overview] [Plan ×] [Brief ×] …
 *
 *  · [pages ▾], LEFT-MOST, is the craft's shared membership: pick a page to
 *    open its tab (or focus the one already open), "+ New page" makes one of
 *    graph / doc / artifact / drawing / craft, "Add existing…" adds an entity
 *    as a page. "Remove from craft" is here too — it is about the page, not
 *    about anyone's tab.
 *  · The tabs are THIS person's open subset (`useCraftWorkspace`). The first
 *    is always the craft's overview: pinned, never closable, never moved.
 *    Closing a tab never removes a page.
 *  · Drag a tab (or Alt+←/→ on it) to reorder; the overview stays first.
 *
 * The Home strip's tab scope button is not drawn here: in Craft the left-most
 * control is the pages dropdown (doc §2).
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { CraftTab, EntityId, EntitySummary } from '@tm8/contract';
import { getKind, KindIcon } from '../domain';
import { MembershipPicker } from '../panels/bodies/MembershipBlock';
import { NEW_PAGE_KINDS, type CraftPageRow, type NewPageKind } from './craft-source';
import '../tab-workspace/view/tabstrip.css';
import './craft-tab-strip.css';

export interface CraftTabStripProps {
  /** In strip order; `tabs[0]` is the pinned overview. */
  tabs: readonly CraftTab[];
  activeTabId: string;
  /** The craft's pages, in page order. */
  pages: readonly CraftPageRow[];
  craftTitle: string;
  /** Pages changed while their tab was not the active one. */
  updated: ReadonlySet<string>;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  /** Put `tabId` before `beforeTabId` (null = last). */
  onMove(tabId: string, beforeTabId: string | null): void;
  /** Open (or focus) a page's tab. */
  onOpenPage(page: CraftPageRow): void;
  onNew(kind: NewPageKind): void;
  onAddExisting(id: EntityId): void;
  onRemovePage(id: EntityId): void;
  /** Candidates for "Add existing…" (one bounded recent page). */
  candidates(text: string): Promise<EntitySummary[]>;
}

const CloseGlyph = () => (
  <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </svg>
);

/** A tab's reorder on the keyboard: Alt+← / Alt+→. */
function moveKey(event: KeyboardEvent): -1 | 1 | 0 {
  if (!event.altKey) return 0;
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
}

export function CraftTabStrip(props: CraftTabStripProps) {
  const { tabs, activeTabId, pages, craftTitle, updated, onSelect, onClose, onMove } = props;
  const [pagesOpen, setPagesOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pageOf = new Map(pages.map((page) => [page.id as string, page]));

  /* An outside press or Escape closes the dropdown. */
  useEffect(() => {
    if (!pagesOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest?.('.cts-pages')) setPagesOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setPagesOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [pagesOpen]);

  const titleOf = (tab: CraftTab) => (tab.pinned ? 'Overview' : (pageOf.get(tab.entityId)?.title ?? 'Untitled'));
  const kindOf = (tab: CraftTab) => (tab.pinned ? 'craft' : (pageOf.get(tab.entityId)?.kind ?? tab.kind));

  /* Where a tab lands: before the one it is dropped on, or after it on its right half. Never before the overview. */
  const dropAt = (event: DragEvent, target: CraftTab) => {
    event.preventDefault();
    const moving = dragId ?? event.dataTransfer.getData('text/x-craft-tab');
    setDragId(null);
    if (!moving || moving === target.id) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = target.pinned || (rect.width > 0 && event.clientX > rect.left + rect.width / 2);
    const at = tabs.findIndex((tab) => tab.id === target.id);
    const before = after ? tabs.slice(at + 1).find((tab) => tab.id !== moving) : target;
    onMove(moving, before?.id ?? null);
  };

  const stepMove = (index: number, step: -1 | 1) => {
    const tab = tabs[index];
    if (!tab || tab.pinned) return;
    if (step === -1) {
      if (index <= 1) return;
      onMove(tab.id, tabs[index - 1]!.id);
    } else {
      if (index >= tabs.length - 1) return;
      onMove(tab.id, tabs[index + 2]?.id ?? null);
    }
  };

  const openPageIds = new Set(tabs.map((tab) => tab.entityId));
  const excluded = new Set<string>([tabs[0]?.entityId ?? '', ...pages.map((page) => page.id)]);

  return (
    <div className="cts-strip" ref={stripRef} data-testid="craft-tab-strip">
      <div className="cts-pages">
        <button
          type="button"
          className="cts-pages__btn"
          aria-haspopup="menu"
          aria-expanded={pagesOpen}
          title={`Pages of ${craftTitle || 'this craft'}`}
          data-testid="craft-pages-btn"
          onClick={() => setPagesOpen((was) => !was)}
        >
          <span>Pages</span>
          <span className="cts-pages__count">{pages.length}</span>
          <span aria-hidden>▾</span>
        </button>
        {pagesOpen ? (
          <div className="cts-menu pn-overflow__menu" role="menu" aria-label="Pages" data-testid="craft-pages-menu">
            {pages.length === 0 ? <p className="cts-menu__hollow">No pages yet.</p> : null}
            {pages.map((page) => (
              <div key={page.id} className="cts-menu__page">
                <button
                  type="button"
                  role="menuitem"
                  className="pn-overflow__item cts-menu__kind"
                  data-testid="craft-pages-item"
                  data-page={page.id}
                  data-open={openPageIds.has(page.id) || undefined}
                  onClick={() => {
                    setPagesOpen(false);
                    props.onOpenPage(page);
                  }}
                >
                  <KindIcon kind={page.kind} size={14} />
                  <span className="cts-menu__title">{page.title}</span>
                </button>
                <button
                  type="button"
                  className="cts-menu__remove"
                  aria-label={`Remove ${page.title} from the craft`}
                  title="Takes the page out of this craft; the entity itself is kept"
                  data-testid="craft-remove-page"
                  onClick={() => {
                    setPagesOpen(false);
                    props.onRemovePage(page.id);
                  }}
                >
                  <CloseGlyph />
                </button>
              </div>
            ))}
            <div className="cts-menu__sep" role="separator" />
            <p className="cts-menu__head">+ New page</p>
            {NEW_PAGE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className="pn-overflow__item cts-menu__kind"
                data-testid={`craft-new-${kind}`}
                title={kind === 'artifact' ? 'Artifacts are published by the craft agent — this asks it in the chat' : undefined}
                onClick={() => {
                  setPagesOpen(false);
                  props.onNew(kind);
                }}
              >
                <KindIcon kind={kind} size={14} /> {kind === 'craft' ? 'Craft' : getKind(kind).label}
              </button>
            ))}
            <div className="cts-menu__sep" role="separator" />
            <MembershipPicker
              search={props.candidates}
              excludeIds={excluded}
              addLabel="Add existing…"
              onPick={(id) => {
                setPagesOpen(false);
                props.onAddExisting(id as EntityId);
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="tws-ts-scroll cts-strip__scroll" role="tablist" aria-label={`Tabs of ${craftTitle || 'the craft'}`}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const title = titleOf(tab);
          const isUpdated = !active && !tab.pinned && updated.has(tab.entityId);
          return (
            <div
              key={tab.id}
              className="tws-ts-tab cts-tab"
              data-active={active || undefined}
              data-pinned={tab.pinned || undefined}
              data-dragging={dragId === tab.id || undefined}
              data-testid="craft-tab"
              data-tab={tab.id}
              data-entity={tab.entityId}
              draggable={!tab.pinned}
              onDragStart={(event) => {
                setDragId(tab.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/x-craft-tab', tab.id);
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => dropAt(event, tab)}
              onAuxClick={(event) => {
                if (event.button === 1 && !tab.pinned) onClose(tab.id);
              }}
            >
              <button
                type="button"
                role="tab"
                className="tws-ts-tab-main"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={`${title} — ${tab.pinned ? 'all pages' : getKind(kindOf(tab)).label}${isUpdated ? ' (updated)' : ''}`}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => {
                  const step = moveKey(event);
                  if (step !== 0) {
                    event.preventDefault();
                    stepMove(index, step);
                    return;
                  }
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
                  if (!next) return;
                  onSelect(next.id);
                  stripRef.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"] [role="tab"]`)?.focus();
                }}
              >
                <span className="tws-ts-icon">
                  <KindIcon kind={kindOf(tab)} size={14} />
                </span>
                <span className="tws-ts-title">{title}</span>
              </button>
              <span className="tws-ts-slot">
                {isUpdated ? (
                  <span className="tws-ts-state cts-updated" data-state="updated" data-testid="craft-tab-updated" aria-label="Updated" />
                ) : null}
                {tab.pinned ? null : (
                  <button
                    type="button"
                    className="tws-ts-close"
                    tabIndex={active ? 0 : -1}
                    aria-label={`Close ${title}`}
                    data-testid="craft-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    <CloseGlyph />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

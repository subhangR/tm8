/**
 * THE CRAFT'S PAGE TABS, in the band (pinned rail, task 01a14b46):
 *
 *   [craft ▾] [◇ Plan] [▤ Brief] [▦ Sketch] [+]
 *
 *  · The craft's pages ARE the tabs, in page order. There is no second row:
 *    the band is the only chrome over the page body.
 *  · [+] makes a page (graph / doc / artifact / drawing / craft), adds an
 *    existing entity as one, or shows the Overview (every page, stacked).
 *  · "Remove from craft" is on a tab's ⋯ and its context menu. It takes the
 *    page out of the craft; the entity is kept.
 *  · The Overview has no tab of its own: it shows one only while selected,
 *    so the viewer can see where they are.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { getKind, KindIcon } from '../domain';
import { MembershipPicker } from '../panels/bodies/MembershipBlock';
import { NEW_PAGE_KINDS, type CraftPageRow, type NewPageKind } from './craft-source';
import './craft-page-tabs.css';

export interface CraftPageTabsProps {
  pages: readonly CraftPageRow[];
  /** The page on screen; null ⇒ the Overview. */
  activePageId: string | null;
  craftTitle: string;
  /** Pages changed while they were not on screen. */
  updated: ReadonlySet<string>;
  onSelect(page: CraftPageRow): void;
  onOverview(): void;
  onNew(kind: NewPageKind): void;
  onAddExisting(id: EntityId): void;
  onRemovePage(id: EntityId): void;
  /** Candidates for "Add existing…" (one bounded recent page). */
  candidates(text: string): Promise<EntitySummary[]>;
  /** The craft's own id, never offered as its own page. */
  craftId: string;
}

/** Which menu is open: the [+] menu, or one tab's (under its ⋯, or at the pointer). Fixed, so the scrolling tab list never clips it. */
type OpenMenu = { type: 'add' } | { type: 'page'; id: string; at: { x: number; y: number } } | null;

/** The [+] menu's make/add rows. Shared with the classic strip's [Pages ▾]. */
export function NewPageItems({
  excluded,
  candidates,
  onNew,
  onAddExisting,
  close,
}: {
  excluded: ReadonlySet<string>;
  candidates(text: string): Promise<EntitySummary[]>;
  onNew(kind: NewPageKind): void;
  onAddExisting(id: EntityId): void;
  close(): void;
}) {
  return (
    <>
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
            close();
            onNew(kind);
          }}
        >
          <KindIcon kind={kind} size={14} /> {getKind(kind).label}
        </button>
      ))}
      <div className="cts-menu__sep" role="separator" />
      <MembershipPicker
        search={candidates}
        excludeIds={excluded}
        addLabel="Add existing…"
        onPick={(id) => {
          close();
          onAddExisting(id as EntityId);
        }}
      />
    </>
  );
}

export function CraftPageTabs(props: CraftPageTabsProps) {
  const { pages, activePageId, craftTitle, updated, onSelect } = props;
  const [menu, setMenu] = useState<OpenMenu>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const close = () => setMenu(null);

  /* An outside press or Escape closes whichever menu is open. */
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest?.('[data-cpt-menu], [data-cpt-trigger]')) setMenu(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  /* Keep the selected tab in view: the band is as wide as the content column. */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activePageId]);

  const overview = activePageId === null;
  const order = pages.map((page) => page.id as string);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = pages[(index + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length];
    if (!next) return;
    onSelect(next);
    listRef.current?.querySelector<HTMLElement>(`[data-page="${next.id}"] [role="tab"]`)?.focus();
  };
  const menuPage = menu?.type === 'page' ? pages.find((page) => page.id === menu.id) ?? null : null;
  const excluded = new Set<string>([props.craftId, ...order]);

  return (
    <div className="cpt" data-testid="craft-page-tabs">
      <div className="cpt__tabs" ref={listRef} role="tablist" aria-label={`Pages of ${craftTitle || 'the craft'}`}>
        {overview ? (
          <div className="cpt__tab" data-active data-testid="craft-tab-overview">
            <button type="button" role="tab" aria-selected className="cpt__main" title="Overview — every page, stacked">
              <KindIcon kind="craft" size={14} />
              <span className="cpt__title">Overview</span>
            </button>
          </div>
        ) : null}
        {pages.map((page, index) => {
          const active = page.id === activePageId;
          const isUpdated = !active && updated.has(page.id);
          const menuOpen = menu?.type === 'page' && menu.id === page.id;
          return (
            <div
              key={page.id}
              className="cpt__tab"
              data-active={active || undefined}
              data-testid="craft-page-tab"
              data-page={page.id}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ type: 'page', id: page.id, at: { x: event.clientX, y: event.clientY } });
              }}
            >
              <button
                type="button"
                role="tab"
                className="cpt__main"
                aria-selected={active}
                tabIndex={active || (overview && index === 0) ? 0 : -1}
                title={`${page.title} — ${getKind(page.kind).label}${isUpdated ? ' (updated)' : ''}`}
                onClick={() => onSelect(page)}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <KindIcon kind={page.kind} size={14} />
                <span className="cpt__title">{page.title || 'Untitled'}</span>
                {page.running ? <span className="cpt__live" title="A session is working on this page" aria-label="live" /> : null}
                {isUpdated ? <span className="cpt__updated" data-testid="craft-tab-updated" aria-label="Updated" /> : null}
              </button>
              <button
                type="button"
                className="cpt__more"
                data-cpt-trigger=""
                aria-label={`More for ${page.title}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                tabIndex={active ? 0 : -1}
                data-testid="craft-page-tab-more"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu(menuOpen ? null : { type: 'page', id: page.id, at: { x: box.left, y: box.bottom + 2 } });
                }}
              >
                ⋯
              </button>
            </div>
          );
        })}
      </div>
      <div className="cpt__add">
        <button
          type="button"
          className="cpt__add-btn"
          data-cpt-trigger=""
          aria-haspopup="menu"
          aria-expanded={menu?.type === 'add'}
          aria-label="Add a page"
          title="New page, add existing, overview"
          data-testid="craft-add-page"
          onClick={() => setMenu(menu?.type === 'add' ? null : { type: 'add' })}
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        {menu?.type === 'add' ? (
          <div className="cts-menu pn-overflow__menu cpt__menu" role="menu" aria-label="Add a page" data-cpt-menu="" data-testid="craft-add-menu">
            <NewPageItems excluded={excluded} candidates={props.candidates} onNew={props.onNew} onAddExisting={props.onAddExisting} close={close} />
            <div className="cts-menu__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="pn-overflow__item cts-menu__kind"
              data-testid="craft-show-overview"
              data-open={overview || undefined}
              onClick={() => {
                close();
                props.onOverview();
              }}
            >
              <KindIcon kind="craft" size={14} /> Overview — all pages
            </button>
          </div>
        ) : null}
      </div>
      {menuPage && menu?.type === 'page' ? (
        <PageMenu page={menuPage} at={menu.at} onRemove={props.onRemovePage} close={close} />
      ) : null}
    </div>
  );
}

/** One tab's menu: under its ⋯, or at the pointer for the context menu. */
function PageMenu({
  page,
  at,
  onRemove,
  close,
}: {
  page: CraftPageRow;
  at: { x: number; y: number };
  onRemove(id: EntityId): void;
  close(): void;
}) {
  return (
    <div
      className="cts-menu pn-overflow__menu cpt__menu cpt__menu--page"
      role="menu"
      aria-label={page.title}
      data-cpt-menu=""
      data-testid="craft-page-menu"
      style={{ position: 'fixed', left: at.x, top: at.y, right: 'auto', width: 'max-content' }}
    >
      <button
        type="button"
        role="menuitem"
        className="pn-overflow__item"
        title="Takes the page out of this craft; the entity itself is kept"
        data-testid="craft-remove-page"
        onClick={() => {
          close();
          onRemove(page.id);
        }}
      >
        Remove from craft
      </button>
    </div>
  );
}

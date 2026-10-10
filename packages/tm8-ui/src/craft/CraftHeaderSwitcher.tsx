/**
 * THE CRAFT TOP BAR's switcher (owner decisions doc 01a1255d §3):
 *
 *   `[selected craft ▾] · [Home | craft 1 | craft 2 …]`
 *
 * Mounted in the header's mode-aware switcher slot (`modeSwitcherSlot`, lane
 * L2) while Craft is the mode. The dropdown lists **Home** first — the crafts
 * card grid with its filter and "+ New craft"; a page, not a workspace — then
 * every craft in the space. The tabs are the viewer's OPEN crafts: opening a
 * craft (from here, from a card, from a link) adds a tab; × closes it. Closing
 * never deletes a craft; crafts stay shared in the space, the tab row is the
 * viewer's own (`craft-open-tabs.ts` says where it is kept).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import type { CraftCard, CraftsSource } from './crafts-source';
import { neighbourAfterClose, useOpenCraftTabs, type OpenCraftsPort } from './craft-open-tabs';
import './craft-header-switcher.css';

export interface CraftHeaderSwitcherProps {
  /** The space's crafts. */
  source: CraftsSource;
  /** Where this viewer's open tabs persist; `null` until the viewer is known. */
  openCrafts: OpenCraftsPort | null;
  /** The craft on screen, or `null` on Home. */
  currentCraftId: EntityId | null;
  onOpenHome(): void;
  onOpenCraft(id: EntityId): void;
}

const HOME_LABEL = 'Home';
const UNTITLED = 'Untitled craft';

export function CraftHeaderSwitcher({ source, openCrafts, currentCraftId, onOpenHome, onOpenCraft }: CraftHeaderSwitcherProps) {
  const tabs = useOpenCraftTabs(openCrafts);
  const cards = useCraftCards(source);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const { open: openTab, ids: openIds } = tabs;

  /* Any way a craft came on screen opens its tab. */
  useEffect(() => {
    if (currentCraftId) openTab(currentCraftId);
  }, [currentCraftId, openTab]);

  /* The header is only the left column wide: keep the selected tab in view. */
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentCraftId, openIds]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const titleOf = (id: string) => {
    const card = cards?.find((c) => c.id === id);
    return card ? card.title || UNTITLED : UNTITLED;
  };
  /* Once the list is known, a tab whose craft is gone is not drawn. */
  const shownTabs = cards === null ? tabs.ids : tabs.ids.filter((id) => id === currentCraftId || cards.some((c) => c.id === id));

  const pick = (id: EntityId | null) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (id === currentCraftId) return;
    if (id) onOpenCraft(id);
    else onOpenHome();
  };

  const closeTab = (id: string) => {
    if (id === currentCraftId) {
      const next = neighbourAfterClose(shownTabs, id);
      if (next) onOpenCraft(next as EntityId);
      else onOpenHome();
    }
    tabs.close(id);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-craft-row]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = at < 0 ? 0 : (at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      rows[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const selectedLabel = currentCraftId ? titleOf(currentCraftId) : HOME_LABEL;

  return (
    <div className="shell-switcher crf-hsw" ref={rootRef} data-testid="craft-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="shell-switcher__trigger shell-switcher__trigger--quiet crf-hsw__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Craft: ${selectedLabel}`}
        title={`Craft: ${selectedLabel}`}
        data-testid="craft-switcher-trigger"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="shell-switcher__space">{selectedLabel}</span>
        <span className="shell-switcher__caret" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="shell-switcher__pop crf-hsw__pop" role="menu" aria-label="Switch craft" data-testid="craft-switcher-pop" onKeyDown={onListKeyDown}>
          <button
            type="button"
            role="menuitem"
            data-craft-row=""
            data-testid="craft-switcher-home"
            className={`shell-switcher__space-row crf-hsw__row ${currentCraftId ? '' : 'shell-switcher__space-row--active'}`}
            onClick={() => pick(null)}
          >
            <span className="crf-hsw__name">{HOME_LABEL}</span>
            <span className="crf-hsw__meta">All crafts</span>
          </button>
          <div className="crf-hsw__sep" role="separator" />
          {cards === null ? (
            <p className="shell-switcher__hint" role="status">Loading crafts…</p>
          ) : cards.length === 0 ? (
            <p className="shell-switcher__hint">No crafts yet</p>
          ) : (
            cards.map((card) => (
              <button
                type="button"
                role="menuitem"
                key={card.id}
                data-craft-row=""
                data-testid="craft-switcher-row"
                className={`shell-switcher__space-row crf-hsw__row ${card.id === currentCraftId ? 'shell-switcher__space-row--active' : ''}`}
                onClick={() => pick(card.id)}
              >
                <span className="crf-hsw__name">{card.title || UNTITLED}</span>
                <span className="crf-hsw__meta">{`${card.pageCount} page${card.pageCount === 1 ? '' : 's'}`}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      <div className="crf-hsw__tabs" ref={stripRef} role="tablist" aria-label="Open crafts" data-testid="craft-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={!currentCraftId}
          className="crf-hsw__tab"
          data-testid="craft-tab-home"
          onClick={() => pick(null)}
        >
          {HOME_LABEL}
        </button>
        {shownTabs.map((id) => {
          const title = titleOf(id);
          return (
            <div key={id} className="crf-hsw__tab crf-hsw__tab--craft" data-selected={id === currentCraftId || undefined} data-testid="craft-tab">
              <button
                type="button"
                role="tab"
                aria-selected={id === currentCraftId}
                className="crf-hsw__tab-label"
                title={title}
                onClick={() => pick(id as EntityId)}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(id);
                }}
              >
                {title}
              </button>
              <button
                type="button"
                className="crf-hsw__tab-close"
                aria-label={`Close ${title}`}
                title="Close tab (the craft stays)"
                data-testid="craft-tab-close"
                onClick={() => closeTab(id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The space's crafts, kept current; `null` until the first read answers. */
function useCraftCards(source: CraftsSource): readonly CraftCard[] | null {
  const [cards, setCards] = useState<readonly CraftCard[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      source.list().then(
        (list) => live && setCards(list),
        () => live && setCards((was) => was ?? []),
      );
    void load();
    const off = source.subscribe(() => void load());
    return () => {
      live = false;
      off();
    };
  }, [source]);
  return cards;
}

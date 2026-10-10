/**
 * CRAFT'S LEFT PANEL (round 2, R2-D1: "craft is just like workspace, where
 * craft is the dropdown, and like workspace tabs we have craft pages"): the
 * crafts, filterable by name, with the open craft's pages listed under it.
 * It lives in the app frame's panel, so it stays put while crafts switch;
 * the pages stay as the tab row over the page too.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { FrameNav, type FrameNavItem } from '../shell/FrameNav';
import type { CraftPageRow, CraftSource } from './craft-source';
import type { CraftCard, CraftsSource } from './crafts-source';
import type { CraftTarget } from './CraftScreen';

export interface CraftsNavProps {
  crafts: CraftsSource;
  source: CraftSource;
  craftId?: EntityId | undefined;
  pageId?: EntityId | undefined;
  onNavigate(target: CraftTarget): void;
  onNotice?: ((text: string) => void) | undefined;
}

const craftKey = (id: string) => `craft:${id}`;
const pageKey = (id: string) => `page:${id}`;

export function CraftsNav({ crafts, source, craftId, pageId, onNavigate, onNotice }: CraftsNavProps) {
  const [cards, setCards] = useState<readonly CraftCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setCards(await crafts.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [crafts]);
  useEffect(() => {
    void refresh();
    return crafts.subscribe(() => void refresh());
  }, [crafts, refresh]);

  const open = useOpenCraft(source, craftId ?? null);

  const items = useMemo<FrameNavItem[]>(() => {
    const rows: FrameNavItem[] = [];
    const listed = cards ?? [];
    const pagesOf = (id: string): FrameNavItem[] =>
      open && open.id === id
        ? open.pages.map((page) => ({
            key: pageKey(page.id),
            label: page.title || 'Untitled',
            detail: getKind(page.kind)?.label ?? page.kind,
            depth: 1 as const,
          }))
        : [];
    /* A nested craft is not on the home list; while it is open it leads. */
    if (open && !listed.some((card) => card.id === open.id)) {
      rows.push({ key: craftKey(open.id), label: open.title || 'Untitled craft' }, ...pagesOf(open.id));
    }
    for (const card of listed) {
      rows.push(
        { key: craftKey(card.id), label: card.title || 'Untitled craft', detail: String(card.pageCount) },
        ...pagesOf(card.id),
      );
    }
    return rows;
  }, [cards, open]);

  const activePage = open ? (open.pages.find((page) => page.id === pageId) ?? open.pages[0] ?? null) : null;
  const current = activePage ? pageKey(activePage.id) : craftId ? craftKey(craftId) : null;

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      onNavigate({ craftId: await crafts.create('Untitled craft') });
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the craft.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <FrameNav
      label="Crafts"
      filterPlaceholder="Filter crafts"
      groups={[{ id: 'crafts', label: null, items }]}
      current={current}
      onSelect={(key) => {
        if (key.startsWith('craft:')) onNavigate({ craftId: key.slice('craft:'.length) as EntityId });
        else if (open) onNavigate({ craftId: open.id, pageId: key.slice('page:'.length) as EntityId });
      }}
      head={
        <div className="frame-nav__actions">
          <button type="button" className="frame-nav__row" onClick={() => void create()} disabled={creating} data-testid="dsn-nav-new">
            <span className="frame-nav__label">＋ New craft</span>
          </button>
          <button type="button" className="frame-nav__row" aria-current={!craftId ? 'page' : undefined} onClick={() => onNavigate({})}>
            <span className="frame-nav__label">All crafts</span>
          </button>
        </div>
      }
      empty={failed ? 'The crafts could not be read.' : cards === null ? 'Loading crafts…' : 'No crafts yet.'}
    />
  );
}

/** The open craft's title and pages, kept current with its own subscription. */
function useOpenCraft(source: CraftSource, craftId: EntityId | null) {
  const [open, setOpen] = useState<{ id: EntityId; title: string; pages: readonly CraftPageRow[] } | null>(null);
  useEffect(() => {
    if (!craftId) {
      setOpen(null);
      return;
    }
    let live = true;
    let pageIds: ReadonlySet<string> = new Set();
    const read = () =>
      void source.read(craftId).then(
        (craft) => {
          if (!live) return;
          pageIds = new Set(craft.pages.map((page) => page.id));
          setOpen({ id: craft.id, title: craft.title, pages: craft.pages });
        },
        () => undefined,
      );
    read();
    const off = source.subscribe(craftId, () => pageIds, read);
    return () => {
      live = false;
      off();
    };
  }, [source, craftId]);
  return open && open.id === craftId ? open : null;
}

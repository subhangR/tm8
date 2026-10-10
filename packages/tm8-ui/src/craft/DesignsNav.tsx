/**
 * DESIGN'S LEFT PANEL (round 2, R2-D1: "design is just like workspace, where
 * design is the dropdown, and like workspace tabs we have design pages"): the
 * designs, filterable by name, with the open design's pages listed under it.
 * It lives in the app frame's panel, so it stays put while designs switch;
 * the pages stay as the tab row over the page too.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { FrameNav, type FrameNavItem } from '../shell/FrameNav';
import type { DesignPageRow, DesignSource } from './design-source';
import type { DesignCard, DesignsSource } from './designs-source';
import type { DesignTarget } from './DesignScreen';

export interface DesignsNavProps {
  designs: DesignsSource;
  source: DesignSource;
  designId?: EntityId | undefined;
  pageId?: EntityId | undefined;
  onNavigate(target: DesignTarget): void;
  onNotice?: ((text: string) => void) | undefined;
}

const designKey = (id: string) => `design:${id}`;
const pageKey = (id: string) => `page:${id}`;

export function DesignsNav({ designs, source, designId, pageId, onNavigate, onNotice }: DesignsNavProps) {
  const [cards, setCards] = useState<readonly DesignCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setCards(await designs.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [designs]);
  useEffect(() => {
    void refresh();
    return designs.subscribe(() => void refresh());
  }, [designs, refresh]);

  const open = useOpenDesign(source, designId ?? null);

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
    /* A nested design is not on the home list; while it is open it leads. */
    if (open && !listed.some((card) => card.id === open.id)) {
      rows.push({ key: designKey(open.id), label: open.title || 'Untitled design' }, ...pagesOf(open.id));
    }
    for (const card of listed) {
      rows.push(
        { key: designKey(card.id), label: card.title || 'Untitled design', detail: String(card.pageCount) },
        ...pagesOf(card.id),
      );
    }
    return rows;
  }, [cards, open]);

  const activePage = open ? (open.pages.find((page) => page.id === pageId) ?? open.pages[0] ?? null) : null;
  const current = activePage ? pageKey(activePage.id) : designId ? designKey(designId) : null;

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      onNavigate({ designId: await designs.create('Untitled design') });
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the design.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <FrameNav
      label="Designs"
      filterPlaceholder="Filter designs"
      groups={[{ id: 'designs', label: null, items }]}
      current={current}
      onSelect={(key) => {
        if (key.startsWith('design:')) onNavigate({ designId: key.slice('design:'.length) as EntityId });
        else if (open) onNavigate({ designId: open.id, pageId: key.slice('page:'.length) as EntityId });
      }}
      head={
        <div className="frame-nav__actions">
          <button type="button" className="frame-nav__row" onClick={() => void create()} disabled={creating} data-testid="dsn-nav-new">
            <span className="frame-nav__label">＋ New design</span>
          </button>
          <button type="button" className="frame-nav__row" aria-current={!designId ? 'page' : undefined} onClick={() => onNavigate({})}>
            <span className="frame-nav__label">All designs</span>
          </button>
        </div>
      }
      empty={failed ? 'The designs could not be read.' : cards === null ? 'Loading designs…' : 'No designs yet.'}
    />
  );
}

/** The open design's title and pages, kept current with its own subscription. */
function useOpenDesign(source: DesignSource, designId: EntityId | null) {
  const [open, setOpen] = useState<{ id: EntityId; title: string; pages: readonly DesignPageRow[] } | null>(null);
  useEffect(() => {
    if (!designId) {
      setOpen(null);
      return;
    }
    let live = true;
    let pageIds: ReadonlySet<string> = new Set();
    const read = () =>
      void source.read(designId).then(
        (design) => {
          if (!live) return;
          pageIds = new Set(design.pages.map((page) => page.id));
          setOpen({ id: design.id, title: design.title, pages: design.pages });
        },
        () => undefined,
      );
    read();
    const off = source.subscribe(designId, () => pageIds, read);
    return () => {
      live = false;
      off();
    };
  }, [source, designId]);
  return open && open.id === designId ? open : null;
}

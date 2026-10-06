/**
 * Linked-entity trail under the strip (Spec A §11, D12; design log §6).
 *
 * The trail lives on the target tab (`tab.ui.trail`). Following a connection,
 * a body link or a chat reference opens the target's own tab carrying the
 * current one on the trail (`useLinkedOpen`); a direct open (list, chooser,
 * palette, deep link) clears it in the runtime. Crumbs only, no actions, and
 * Home's navStore breadcrumb is never touched.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { EntityId } from '@tm8/contract';
import { useDismissable } from '../../panels/useDismissable';
import { getKindAdapter } from '../adapters/registry';
import { isWorkspaceKind, type EntityTabRecord, type TrailCrumb } from '../runtime/types';
import { useWorkspace } from './context';
import { useTabFacts } from './TabStrip';
import './trail.css';

/** At most this many crumbs show before the middle ones collapse into `…`. */
const MAX_VISIBLE = 4;

/**
 * Open entities linked from `tab`: `openLinked(id)` drills (resolving the
 * target's kind first, pulling it if unknown) and carries `tab` on the
 * target's trail; `openTab(kind, id)` is a plain open with no trail. Kinds
 * outside Workspace go to their Home entity view, as before.
 */
export function useLinkedOpen(tab: EntityTabRecord): {
  openLinked: (entityId: string) => void;
  openTab: (kind: string, entityId: string, withTrail?: boolean) => void;
} {
  const { gate, dispatch } = useWorkspace();
  const data = gate.data as typeof gate.data & { pull?: (id: string) => void };
  const title = data.detailOf(tab.entityId)?.title ?? '';

  const openTab = useCallback(
    (kind: string, entityId: string, withTrail = false) => {
      if (!isWorkspaceKind(kind)) {
        gate.navigateView({ view: 'entity', entityId: entityId as EntityId, origin: null });
        return;
      }
      let trail: TrailCrumb[] | undefined;
      if (withTrail) {
        trail = [...(tab.ui.trail ?? []), { entityId: tab.entityId, kind: tab.kind, title }];
        /* Linking back to an entity already on the trail is the shorter trail. */
        const at = trail.findIndex((crumb) => crumb.entityId === entityId);
        if (at !== -1) trail = trail.slice(0, at);
      }
      dispatch({
        command: 'workspace.tabs.open',
        args: { kind, entityId, ...(trail ? { trail } : {}) },
        source: 'click',
      });
    },
    [dispatch, gate, tab, title],
  );

  const kindOf = useCallback(
    (id: string): string | null =>
      data.detailOf(id)?.kind ?? data.domain.store.getState().entities[id as EntityId]?.kind ?? null,
    [data],
  );
  /* A target whose kind is not known yet is pulled first and opened when it lands. */
  const [pending, setPending] = useState<string | null>(null);
  const openLinked = useCallback(
    (id: string) => {
      const kind = kindOf(id);
      if (kind) openTab(kind, id, true);
      else {
        data.pull?.(id);
        setPending(id);
      }
    },
    [kindOf, openTab, data],
  );
  const pendingKind = pending ? kindOf(pending) : null;
  useEffect(() => {
    if (!pending || !pendingKind) return;
    setPending(null);
    openTab(pendingKind, pending, true);
  }, [pending, pendingKind, openTab]);

  return { openLinked, openTab };
}

export interface LinkedTrailProps {
  tab: EntityTabRecord;
}

export function LinkedTrail({ tab }: LinkedTrailProps) {
  const { gate, dispatch } = useWorkspace();
  const current = useTabFacts(tab).title;
  const trail = tab.ui.trail;

  /* A crumb opens (or focuses) its entity's own tab with the trail before it.
     Through dispatch, so a hidden kind gets the reveal prompt. */
  const openCrumb = useCallback(
    (index: number) => {
      if (!trail) return;
      const crumb = trail[index];
      if (!crumb) return;
      dispatch({
        command: 'workspace.tabs.open',
        args: { kind: crumb.kind, entityId: crumb.entityId, trail: trail.slice(0, index) },
        source: 'click',
      });
    },
    [dispatch, trail],
  );

  const labelOf = useCallback(
    (crumb: TrailCrumb) =>
      gate.data.detailOf(crumb.entityId)?.title?.trim() || crumb.title.trim() || getKindAdapter(crumb.kind).noun,
    [gate.data],
  );

  const shown = useMemo(() => {
    const all = (trail ?? []).map((crumb, index) => ({ crumb, index }));
    if (all.length + 1 <= MAX_VISIBLE) return { head: all, hidden: [], tail: [] };
    /* First and last always show; the middle collapses. */
    const keepTail = MAX_VISIBLE - 2;
    return { head: all.slice(0, 1), hidden: all.slice(1, all.length - keepTail + 1), tail: all.slice(all.length - keepTail + 1) };
  }, [trail]);

  /* R18: the crumbs sit in the head's measure. The head lives in the entity's
     main column (not under a docked chat) and inside the body's scroller (less
     its scrollbar), so the trail insets itself to the head's box: the
     embedded head once mounted, the main column while the body loads. */
  const navRef = useRef<HTMLElement | null>(null);
  const [inset, setInset] = useState<{ left: number; right: number } | null>(null);
  const hasTrail = !!trail && trail.length > 0;
  useLayoutEffect(() => {
    const nav = navRef.current;
    const main = nav?.parentElement?.querySelector<HTMLElement>('.tws-entity-main');
    if (!nav || !main) return;
    let head: HTMLElement | null = null;
    const read = () => {
      const box = (head ?? main).getBoundingClientRect();
      const own = nav.getBoundingClientRect();
      const next = { left: Math.max(0, box.left - own.left), right: Math.max(0, own.right - box.right) };
      setInset((prev) => (prev && prev.left === next.left && prev.right === next.right ? prev : next));
    };
    const sizes = new ResizeObserver(read);
    sizes.observe(main);
    sizes.observe(nav);
    const findHead = () => {
      if (head?.isConnected) return;
      if (head) sizes.unobserve(head);
      head = main.querySelector<HTMLElement>('.pn-embedded-head');
      if (head) sizes.observe(head);
      read();
    };
    findHead();
    const mounts = new MutationObserver(findHead);
    mounts.observe(main, { childList: true, subtree: true });
    return () => {
      sizes.disconnect();
      mounts.disconnect();
    };
  }, [hasTrail]);

  if (!hasTrail) return null;

  const crumbButton = ({ crumb, index }: { crumb: TrailCrumb; index: number }) => (
    <li key={`${index}-${crumb.entityId}`} className="tws-trail-item">
      <button
        type="button"
        className="tws-trail-link"
        data-testid="tws-trail-crumb"
        title={labelOf(crumb)}
        onClick={() => openCrumb(index)}
      >
        {labelOf(crumb)}
      </button>
      <Sep />
    </li>
  );

  return (
    <nav
      ref={navRef}
      className="tws-trail"
      aria-label="Linked trail"
      data-testid="tws-trail"
      style={
        inset ? ({ '--tws-trail-l': `${inset.left}px`, '--tws-trail-r': `${inset.right}px` } as CSSProperties) : undefined
      }
    >
      <ol className="tws-trail-list">
        {shown.head.map(crumbButton)}
        {shown.hidden.length > 0 ? (
          <li className="tws-trail-item">
            <HiddenCrumbs items={shown.hidden} labelOf={labelOf} onOpen={openCrumb} />
            <Sep />
          </li>
        ) : null}
        {shown.tail.map(crumbButton)}
        <li className="tws-trail-item">
          <span className="tws-trail-current" aria-current="page" title={current}>
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function Sep() {
  return (
    <span className="tws-trail-sep" aria-hidden>
      ›
    </span>
  );
}

function HiddenCrumbs({
  items,
  labelOf,
  onOpen,
}: {
  items: { crumb: TrailCrumb; index: number }[];
  labelOf: (crumb: TrailCrumb) => string;
  onOpen: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissable(open, ref, dismiss);
  return (
    <div className="tws-trail-more" ref={ref}>
      <button
        type="button"
        className="tws-trail-link"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${items.length} more`}
        data-testid="tws-trail-more"
        onClick={() => setOpen((value) => !value)}
      >
        …
      </button>
      {open ? (
        <ul className="tws-trail-menu" role="menu">
          {items.map(({ crumb, index }) => (
            <li key={`${index}-${crumb.entityId}`} role="none">
              <button
                type="button"
                role="menuitem"
                className="tws-trail-menu-item"
                onClick={() => {
                  setOpen(false);
                  onOpen(index);
                }}
              >
                {labelOf(crumb)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

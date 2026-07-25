/**
 * PanelStack — the panel behaviour that makes the workspace modular.
 *
 *   click a chip/card anywhere  → a Z3 panel PEEKS over the right edge
 *   click a chip inside a panel → it STACKS (breadcrumbed; ⌫ / swipe-right pops)
 *   📌 pin                      → docks as a persistent SPLIT (capped at MAX_PINNED)
 *   ⤢ promote                   → becomes the Z4 route; the center view is the back target
 *
 * All of that state lives in `useNavStore` (stack / pinned / view), so every
 * arrangement is already in the URL and back/forward walks it. This component
 * is pure presentation over those actions; panel *bodies* arrive through the
 * `renderPanel` slot (`PanelSlotProps`), which W1a's EntityPanel plugs into.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconBtn } from '../kit';
import { MAX_PINNED, useNavStore, type PanelRef, type PanelTab } from '../stores/nav';
import { useGraphStore } from '../stores/graph';
import type { CollabFacade } from '../facade/CollabFacade';
import type { EntityId } from '../types/contract';
import { Icon } from './icons';
import { PlaceholderPanelBody } from './placeholders';
import type { PanelSlot, PanelSlotProps } from './types';

/**
 * Split policy lives in the nav store (`MAX_PINNED`); the shell only reports it.
 * Center is always a column, so the widest layout is center + `MAX_PINNED`.
 */
export const MAX_SPLITS = MAX_PINNED;
export const MAX_SPLIT_COLUMNS = MAX_PINNED + 1;
const SWIPE_POP_PX = 64;

/** Titles for breadcrumbs: graph-store first, lazily hydrated from the facade. */
function useEntityTitle(facade: CollabFacade, id: EntityId): string {
  const known = useGraphStore((s) => s.entities[id]?.title);
  useEffect(() => {
    if (known) return;
    let alive = true;
    void facade.getEntity(id).then(
      (detail) => { if (alive) useGraphStore.getState().ingestDetail(detail); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [facade, id, known]);
  return known ?? id;
}

function Crumb({ facade, id, active, onClick }: {
  facade: CollabFacade; id: EntityId; active: boolean; onClick: () => void;
}) {
  const title = useEntityTitle(facade, id);
  return (
    <button
      type="button"
      className="cv2-panel__crumb"
      data-active={active || undefined}
      onClick={onClick}
      title={title}
    >
      {title}
    </button>
  );
}

interface PanelFrameProps {
  facade: CollabFacade;
  refItem: PanelRef;
  mode: 'stacked' | 'pinned';
  depth: number;
  /** Full stack ids, for the breadcrumb of a stacked panel. */
  trail: EntityId[];
  renderPanel?: PanelSlot;
  showChrome: boolean;
  onOpenEntity: (id: EntityId, opts?: { replace?: boolean }) => void;
  onPopTo: (index: number) => void;
}

function PanelFrame({
  facade, refItem, mode, depth, trail, renderPanel, showChrome, onOpenEntity, onPopTo,
}: PanelFrameProps) {
  const { entityId } = refItem;
  const popPanel = useNavStore((s) => s.popPanel);
  const pinPanel = useNavStore((s) => s.pinPanel);
  const unpinPanel = useNavStore((s) => s.unpinPanel);
  const promotePanel = useNavStore((s) => s.promotePanel);
  const setPanelTab = useNavStore((s) => s.setPanelTab);
  const pinnedCount = useNavStore((s) => s.pinned.length);
  const isPinned = mode === 'pinned';
  const canPin = isPinned || pinnedCount < MAX_PINNED;
  const [pinRejected, setPinRejected] = useState(false);
  const title = useEntityTitle(facade, entityId);

  const onClose = useCallback(() => {
    if (isPinned) unpinPanel(entityId);
    else popPanel();
  }, [isPinned, unpinPanel, popPanel, entityId]);

  const onPin = useCallback((): boolean => {
    const ok = pinPanel(entityId);
    if (!ok) {
      setPinRejected(true);
      window.setTimeout(() => setPinRejected(false), 1600);
    }
    return ok;
  }, [pinPanel, entityId]);

  const onPromote = useCallback(() => {
    if (isPinned) unpinPanel(entityId);
    promotePanel(entityId);
  }, [isPinned, unpinPanel, promotePanel, entityId]);

  const onTabChange = useCallback((tab: PanelTab) => setPanelTab(entityId, tab), [setPanelTab, entityId]);

  // Swipe-right pops the top stacked panel (trackpad/touch parity with ⌫).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    const t = e.changedTouches[0];
    touchStart.current = null;
    if (!start || !t || isPinned) return;
    const dx = t.clientX - start.x;
    if (dx > SWIPE_POP_PX && Math.abs(t.clientY - start.y) < dx) popPanel();
  };

  const slotProps: PanelSlotProps = {
    entityId,
    tab: refItem.tab,
    mode,
    depth,
    facade,
    onOpenEntity,
    onClose,
    onPin,
    onUnpin: () => unpinPanel(entityId),
    onPromote,
    onTabChange,
    canPin,
    isPinned,
  };

  return (
    <section
      className={`cv2-panel cv2-panel--${mode}`}
      data-entity={entityId}
      data-depth={depth}
      data-testid={`panel-${mode}-${entityId}`}
      aria-label={`${isPinned ? 'Pinned' : 'Panel'}: ${title}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {showChrome && (
        <header className="cv2-panel__chrome">
          <nav className="cv2-panel__crumbs" aria-label="Panel stack">
            {isPinned ? (
              <span className="cv2-panel__crumb" data-active>{title}</span>
            ) : (
              trail.map((id, i) => (
                <span key={id} className="cv2-panel__crumbwrap">
                  {i > 0 && <Icon name="chevron-right" size={12} />}
                  <Crumb facade={facade} id={id} active={i === trail.length - 1} onClick={() => onPopTo(i)} />
                </span>
              ))
            )}
            <span className="cv2-panel__chromespacer" />
            <IconBtn
              aria-label={isPinned ? 'Unpin split' : canPin ? 'Pin as split' : `Split limit reached (${MAX_SPLITS} splits)`}
              active={isPinned}
              disabled={!canPin}
              data-testid={`panel-pin-${entityId}`}
              onClick={() => (isPinned ? unpinPanel(entityId) : onPin())}
            >
              <Icon name="pin" size={14} />
            </IconBtn>
            <IconBtn
              aria-label="Promote to full view"
              data-testid={`panel-promote-${entityId}`}
              onClick={onPromote}
            >
              <Icon name="maximize-2" size={14} />
            </IconBtn>
            <IconBtn aria-label="Close panel" data-testid={`panel-close-${entityId}`} onClick={onClose}>
              <Icon name="x" size={15} />
            </IconBtn>
          </nav>
          {pinRejected && (
            <p className="cv2-panel__warn" role="status">
              {MAX_SPLITS} splits max — unpin one first.
            </p>
          )}
        </header>
      )}
      <div className="cv2-panel__body">
        {renderPanel
          ? renderPanel(slotProps)
          : <PlaceholderPanelBody facade={facade} entityId={entityId} onOpenEntity={onOpenEntity} />}
      </div>
    </section>
  );
}

export interface PanelStackProps {
  facade: CollabFacade;
  /** Panel body slot — W1a's EntityPanel. Placeholder frame when omitted. */
  renderPanel?: PanelSlot;
  /** Set false when the slot renders its own header. */
  showChrome?: boolean;
}

/**
 * Renders the pinned splits (persistent columns) followed by the peeking Z3
 * stack. Returns a fragment so `ShellLayout`'s flex row lays the columns out.
 */
export function PanelStack({ facade, renderPanel, showChrome = true }: PanelStackProps) {
  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);
  const pushPanel = useNavStore((s) => s.pushPanel);
  const popPanel = useNavStore((s) => s.popPanel);

  const onOpenEntity = useCallback(
    (id: EntityId, opts?: { replace?: boolean }) => pushPanel({ entityId: id }, opts),
    [pushPanel],
  );

  /** Breadcrumb click: pop back down to `index` (the store pops one at a time). */
  const onPopTo = useCallback((index: number) => {
    const depth = useNavStore.getState().stack.length;
    for (let i = depth - 1; i > index; i -= 1) popPanel();
  }, [popPanel]);

  const top = stack[stack.length - 1];
  const trail = stack.map((r) => r.entityId);

  return (
    <>
      {pinned.map((refItem, i) => (
        <PanelFrame
          key={`pin:${refItem.entityId}`}
          facade={facade}
          refItem={refItem}
          mode="pinned"
          depth={i}
          trail={[refItem.entityId]}
          renderPanel={renderPanel}
          showChrome={showChrome}
          onOpenEntity={onOpenEntity}
          onPopTo={onPopTo}
        />
      ))}
      {top && (
        <div className="cv2-panelstack" data-depth={stack.length} data-testid="panel-stack">
          {stack.length > 1 && <span className="cv2-panelstack__shim" aria-hidden="true" />}
          <PanelFrame
            key={`stack:${top.entityId}`}
            facade={facade}
            refItem={top}
            mode="stacked"
            depth={stack.length - 1}
            trail={trail}
            renderPanel={renderPanel}
            showChrome={showChrome}
            onOpenEntity={onOpenEntity}
            onPopTo={onPopTo}
          />
        </div>
      )}
    </>
  );
}

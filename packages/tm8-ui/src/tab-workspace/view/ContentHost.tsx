/**
 * Content host (Spec A §8, §13, §15): mounts ONLY the active tab's body —
 * entity body with trail, floating group and chat; draft host; chooser — or
 * the start surface. Supplies the runtime's `captureUi` hook so a deactivated
 * tab's scroll lands on its record before the body unmounts. Workstream E.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DraftHost } from '../adapters/draft';
import {
  EntityChromeContext,
  EntityTabBody,
  trackFreshTabs,
  type EntityAdapterHandle,
  type EntityChromeContextValue,
} from '../adapters/entity';
import { getKindAdapter } from '../adapters/registry';
import { getKind } from '../../domain';
import { useAlwaysDarkTheme } from '../../theme/useAlwaysDarkTheme';
import { activeTab } from '../runtime/selectors';
import type { EntityTabRecord, TabId } from '../runtime/types';
import { ChatDock } from './ChatDock';
import { Chooser } from './Chooser';
import { useWorkspace, useWorkspaceState } from './context';
import { ActionStrip } from './ActionStrip';
import { LinkedTrail } from './LinkedTrail';
import { StartSurface } from './StartSurface';
import './content.css';

export function ContentHost() {
  const { runtime } = useWorkspace();
  /* Before any effect runs (persistence restores in one), so a restored tab is
     told apart from one opened in this page. */
  trackFreshTabs(runtime);
  const tab = useWorkspaceState(activeTab);

  /* The mounted entity body's handle, keyed by the tab it belongs to. */
  const handle = useRef<{ tabId: TabId; handle: EntityAdapterHandle } | null>(null);
  useEffect(
    () =>
      runtime.setHooks({
        captureUi: (tabId) => (handle.current?.tabId === tabId ? handle.current.handle.captureUi() : undefined),
      }),
    [runtime],
  );

  return (
    <main className="tws-content" data-testid="tws-content">
      {!tab ? (
        <StartSurface />
      ) : tab.type === 'chooser' ? (
        <Chooser key={tab.id} tabId={tab.id} variant="tab" />
      ) : tab.type === 'draft' ? (
        /* The draft host renders the kind's `draftBody` (or the generic form);
           workstream F owns it. No floating group on drafts (Spec A §8). */
        <DraftHost key={tab.id} tab={tab} />
      ) : (
        <EntityTab key={tab.id} tab={tab} handleRef={handle} />
      )}
    </main>
  );
}

function EntityTab({
  tab,
  handleRef,
}: {
  tab: EntityTabRecord;
  handleRef: React.MutableRefObject<{ tabId: TabId; handle: EntityAdapterHandle } | null>;
}) {
  const [verbsSlot, setVerbsSlot] = useState<HTMLElement | null>(null);
  const [kindSlot, setKindSlot] = useState<HTMLElement | null>(null);
  const [commonVerbsSlot, setCommonVerbsSlot] = useState<HTMLElement | null>(null);
  const [statsSlot, setStatsSlot] = useState<HTMLElement | null>(null);
  const [outlineSlot, setOutlineSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [menuSlot, setMenuSlot] = useState<HTMLElement | null>(null);
  const [dangerSlot, setDangerSlot] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  /* The content width drives the group's narrow arrangement (design log §7). */
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null);
  const [contentWidth, setContentWidth] = useState(Infinity);
  useEffect(() => {
    if (!mainEl || typeof ResizeObserver === 'undefined') return;
    setContentWidth(mainEl.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContentWidth(entry.contentRect.width);
    });
    ro.observe(mainEl);
    return () => ro.disconnect();
  }, [mainEl]);

  const chrome = useMemo<EntityChromeContextValue>(
    () => ({
      verbsSlot,
      kindSlot,
      commonVerbsSlot,
      statsSlot,
      outlineSlot,
      titleSlot,
      menuSlot,
      dangerSlot,
      menuOpen,
      setMenuOpen,
      contentWidth,
      setVerbsSlot,
      setKindSlot,
      setCommonVerbsSlot,
      setStatsSlot,
      setOutlineSlot,
      setTitleSlot,
      setMenuSlot,
      setDangerSlot,
    }),
    [verbsSlot, kindSlot, commonVerbsSlot, statsSlot, outlineSlot, titleSlot, menuSlot, dangerSlot, menuOpen, contentWidth],
  );

  const tabId = tab.id;
  const onHandle = useCallback(
    (next: EntityAdapterHandle | null) => {
      if (next) handleRef.current = { tabId, handle: next };
      else if (handleRef.current?.tabId === tabId) handleRef.current = null;
    },
    [handleRef, tabId],
  );

  return (
    <EntityChromeContext.Provider value={chrome}>
      <div className="tws-entity">
        <LinkedTrail tab={tab} />
        <div className="tws-entity-band">
          {/* The chat dock / overlay lives in this row, so it opens between the
              content and the strip and an overlay never covers the strip. */}
          <div className="tws-entity-row">
            <div ref={setMainEl} className="tws-entity-main tws-entity-host">
              <TitleBar tab={tab} host={mainEl} setSlot={setTitleSlot} />
              <EntityTabBody tab={tab} adapter={getKindAdapter(tab.kind)} onHandle={onHandle} />
            </div>
            {/* Right-hand slot: the per-tab chat dock (workstream G). */}
            <ChatDock tab={tab} />
          </div>
          {/* The entity action strip, pinned to the far right in every state. */}
          <ActionStrip tab={tab} />
        </div>
      </div>
    </EntityChromeContext.Provider>
  );
}

/** Scrolling down past this hides the title bar; any scroll up shows it. */
const TITLE_HIDE_AFTER_PX = 8;
/** On a body that owns its height, a pointer this close to the top reveals it. */
const TITLE_REVEAL_EDGE_PX = 8;

/**
 * The entity title bar (Subhang, round 5): directly under the tab strip (and
 * the trail), on the active tab's plane, 36px, the title only. It overlays the
 * top of the content; a document reserves its height at the top of its own
 * scroll, so nothing jumps. It hides on scroll down and returns on scroll up
 * or at the top. A body that owns its height (terminal, chat, frame) has no
 * document scroll: there the bar hides while focus is inside the body and
 * returns when focus leaves or the pointer reaches the body's top edge — an
 * overlay, never a resize, so a terminal's PTY is never refitted by it.
 */
function TitleBar({
  tab,
  host,
  setSlot,
}: {
  tab: EntityTabRecord;
  host: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const darkBody = getKind(tab.kind).panel.archetype === 'terminal';
  const darkTheme = useAlwaysDarkTheme();
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host) return;
    const flowOf = () => host.querySelector('.pn-panel[data-embedded-flow]')?.getAttribute('data-embedded-flow') ?? null;
    /* Per scroller: the panel column, or a body that scrolls inside it. */
    const lastOf = new WeakMap<HTMLElement, number>();
    let down = 0;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!(t instanceof HTMLElement) || flowOf() !== 'document') return;
      if (t.scrollHeight <= t.clientHeight) return;
      const last = lastOf.get(t) ?? 0;
      const y = t.scrollTop;
      if (y <= 0) {
        down = 0;
        setHidden(false);
      } else if (y < last) {
        down = 0;
        setHidden(false);
      } else {
        down += y - last;
        if (down > TITLE_HIDE_AFTER_PX) setHidden(true);
      }
      lastOf.set(t, y);
    };
    const inBody = (n: EventTarget | null) =>
      n instanceof Node && !barRef.current?.contains(n) && !!host.querySelector('.tws-panel')?.contains(n);
    const onFocusIn = (e: FocusEvent) => {
      if (flowOf() === 'fill' && inBody(e.target)) setHidden(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (flowOf() === 'fill' && !inBody(e.relatedTarget)) setHidden(false);
    };
    const onMove = (e: PointerEvent) => {
      if (flowOf() !== 'fill') return;
      const top = host.getBoundingClientRect().top;
      const zoom = host.offsetHeight > 0 ? host.getBoundingClientRect().height / host.offsetHeight : 1;
      if (e.clientY - top <= TITLE_REVEAL_EDGE_PX * zoom) setHidden(false);
    };
    host.addEventListener('scroll', onScroll, true);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    host.addEventListener('pointermove', onMove);
    return () => {
      host.removeEventListener('scroll', onScroll, true);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('pointermove', onMove);
    };
  }, [host]);

  return (
    <div
      ref={barRef}
      className={`${darkBody ? 'cv2-root ' : ''}tws-titlebar`}
      data-theme={darkBody ? darkTheme : undefined}
      data-hidden={hidden || undefined}
      data-testid="tws-titlebar"
      onFocus={() => setHidden(false)}
    >
      <div ref={setSlot} className="tws-titlebar__text" />
    </div>
  );
}

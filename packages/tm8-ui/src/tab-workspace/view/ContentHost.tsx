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
      menuSlot,
      dangerSlot,
      menuOpen,
      setMenuOpen,
      contentWidth,
      setVerbsSlot,
      setKindSlot,
      setCommonVerbsSlot,
      setStatsSlot,
      setMenuSlot,
      setDangerSlot,
    }),
    [verbsSlot, kindSlot, commonVerbsSlot, statsSlot, menuSlot, dangerSlot, menuOpen, contentWidth],
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

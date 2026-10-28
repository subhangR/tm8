/**
 * Icon rail (Spec A §4, design log §3 + R36, task 01a1112a-c568; redesign
 * task 01a122ea-b5d9). Workstream A.
 *
 *   [Pinned kinds]  ── hairline
 *   [every kind, one list]
 *   ── hairline · [Project files]
 *   ── hairline
 *   Needs you · 👤 · »
 *
 * ONE LIST OF EVERY KIND (Subhang, 2026-10-10): `homeRootKinds()`, the whole
 * Home population — no groups, no tools face. A kind Work's browser holds
 * (`isWorkspaceKind`, the contract's allow-list) opens in Work; any other
 * opens its own kind list. Pins and the expanded flag are the rail's own
 * (`railStore`), never Home's; Pinned takes any kind. A pinned kind moves up
 * to Pinned and leaves the list; an unpinned kind returns at the top of the
 * list (`lifted`, newest first).
 *
 * THE THREE (Subhang, 2026-10-07): the bottom is always Needs you, you and
 * expand. The avatar opens one card beside the rail — status, then the
 * account menu (`RailUser`). A top group taller than the window fades the
 * edge that has more.
 *
 * A kind button IS the browser's kind control (click ⇒ `browsers.main.kind`);
 * a 500ms hold — pointer or Enter/Space — toggles its pin instead, and the
 * release that ends a hold never clicks.
 *
 * LIVE COUNTS (task 01a111a2-f9ad, design log R42) on four kinds only — Tasks,
 * Stories, Sessions, Chats (`useRailCounts`). Collapsed: a run-tinted corner
 * badge. Expanded: the number right-aligned in the row.
 *
 * MORE KINDS IS A POPOVER (Subhang, 2026-10-28, task 01a181da-c799): in the
 * pinned-only rail, ⋯ opens a card beside the rail listing every unpinned
 * kind and source — a row opens it, its pin button pins it — instead of
 * folding the rest open inside the rail, which grew the rail past the window.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { homeRootKinds, KindIcon, type KindConfig } from '../../domain';
import { VectorIcon } from '../../kit/VectorIcon';
import { browserSources, type BrowserSource } from '../adapters/browserSources';
import { getRailStore, workspacePinnedKinds } from '../runtime/railStore';
import { useShellFrame } from './context';
import { isRailCountKind, useRailCounts, type RailCounts } from './useRailCounts';
import { RAIL_COLLAPSE_ART, RAIL_EXPAND_ART, RAIL_PIN_ART } from './railArt';
import { RailAttention, RailPopoverButton, RailUser } from './RailStatus';
import { useCustomKindsVersion } from '../../data/custom-kinds';
import { BrandMark } from '../../kit/BrandMark';
import { isPinnedRailEnabled } from './navigatorFlag';
/* MOVED, NOT FORKED (`railParts.tsx`): the merged navigator draws the same
   kind rows, the same hold, the same tooltips and the same ⌘\ listener. */
import {
  KindButton,
  RailTip,
  SourceButton,
  useCollapseKey,
  useOpenKind,
  useScrollHints,
  useTogglePin,
} from './railParts';
export { HOLD_MS, useHold } from './railParts';

/** The More kinds ⋯ — three dots on `VectorIcon`'s 16×16 grid (as Navigator's). */
const MORE_ART = ['M4 8h.01', 'M8 8h.01', 'M12 8h.01'];

export function WorkspaceRail() {
  const customKinds = useCustomKindsVersion();
  const { spaceId, currentKind: browserKind, currentSource, selectSource, gate } = useShellFrame();
  const railStore = useMemo(() => getRailStore(spaceId), [spaceId]);
  const pins = useStore(railStore, (s) => s.pins);
  const lifted = useStore(railStore, (s) => s.lifted);
  const expanded = useStore(railStore, (s) => s.expanded);
  const [announcement, setAnnouncement] = useState('');
  const counts: RailCounts = useRailCounts();
  const topRef = useRef<HTMLDivElement>(null);
  /* PINNED ONLY (`tm8.ui.navigator = 'rail'`): the rail draws the pins, and
     every other kind and source waits in the More kinds popover. Read once
     per mount, as the navigator flag is. */
  const pinnedOnly = useMemo(() => isPinnedRailEnabled(), []);

  const pinned = useMemo(() => workspacePinnedKinds(pins), [pins, customKinds]);
  const railRef = useRef<HTMLElement>(null);
  const more = useScrollHints(topRef, pinned.length);
  /* EVERY KIND (Subhang, 2026-10-10): the whole Home population, no Work
     filter. A pinned kind MOVES to Pinned and leaves the list; an unpinned
     one comes back at the TOP of the list, most recent first (2026-10-07). */
  const kinds = useMemo(() => {
    const rest = homeRootKinds().filter((config) => !pinned.some((p) => p.kind === config.kind));
    const rank = (kind: string) => {
      const i = lifted.indexOf(kind);
      return i < 0 ? lifted.length : i;
    };
    return rest.map((config, i) => ({ config, i })).sort((a, b) => rank(a.config.kind) - rank(b.config.kind) || a.i - b.i).map((x) => x.config);
  }, [pinned, lifted, customKinds]);

  const openKindNow = useOpenKind();
  /* Pinned-only: a kind pressed while the panel is collapsed brings it back
     on that kind — the rail picks, the panel shows. */
  const openKind = useCallback(
    (kind: string) => {
      if (pinnedOnly && railStore.getState().collapsed) railStore.getState().setCollapsed(false);
      openKindNow(kind);
    },
    [pinnedOnly, railStore, openKindNow],
  );
  const togglePin = useTogglePin(railRef, setAnnouncement);
  const toggleExpanded = useCallback(() => railStore.getState().setExpanded(!railStore.getState().expanded), [railStore]);
  /* ⌘\ collapses the PANEL in the pinned-only layout (the rail never hides). */
  const togglePanel = useCallback(
    () => railStore.getState().setCollapsed(!(railStore.getState().collapsed ?? false)),
    [railStore],
  );
  useCollapseKey(pinnedOnly ? togglePanel : toggleExpanded);


  const kindButton = (config: KindConfig, placement: 'pinned' | 'list') => (
    <KindButton
      key={`${placement}:${config.kind}`}
      config={config}
      placement={placement}
      isPinned={placement === 'pinned'}
      current={config.kind === browserKind}
      expanded={expanded}
      /* PINNED-ONLY: ONE NUMBER ON THE WHOLE RAIL (Subhang 2026-10-17) — the
         running sessions on Sessions. No unseen badges, no other counts. */
      count={
        pinnedOnly
          ? config.kind === 'work_session'
            ? counts.work_session
            : undefined
          : isRailCountKind(config.kind)
            ? counts[config.kind]
            : undefined
      }
      unseen={pinnedOnly ? undefined : gate.data?.countsFor?.(config.kind)?.unseen}
      onSelect={openKind}
      onTogglePin={togglePin}
    />
  );

  const expandLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar';
  return (
    <nav
      ref={railRef}
      className="tws-rail"
      aria-label="Work rail"
      data-testid="tws-rail"
      data-rail-expanded={expanded || undefined}
      data-pinned-only={pinnedOnly || undefined}
    >
      {pinnedOnly ? (
        <>
          {/* The tm8 mark heads the rail (the space switcher is the panel's
              title now). */}
          <div className="tws-rail-logo" data-testid="tws-rail-logo">
            <button type="button" className="tws-rail-logo__btn" aria-label="Home" title="Home" onClick={gate.goHome}>
              <BrandMark />
            </button>
          </div>
          {/* THE MODES (Work · Craft · Observe · Settings), icons only, above
              the pins: the left header's mode menu, laid out as the rail. */}
          <div className="tws-rail-group tws-rail-modes" role="group" aria-label="Modes" data-testid="tws-rail-modes">
            {gate.viewTabs.map((tab) => (
              <RailTip key={tab.id} label={expanded ? null : tab.label}>
                <button
                  type="button"
                  className="tws-rail-btn tws-rail-kind"
                  aria-label={tab.label}
                  aria-current={tab.id === gate.activeViewTabId ? 'page' : undefined}
                  data-mode={tab.id}
                  onClick={() => gate.onSelectViewTab(tab.id)}
                >
                  <span className="tws-rail-icon">{tab.glyph}</span>
                  {expanded ? <span className="tws-rail-label">{tab.label}</span> : null}
                </button>
              </RailTip>
            ))}
          </div>
          <hr className="tws-rail-rule" />
        </>
      ) : null}
      <div
        ref={topRef}
        className="tws-rail-top"
        data-more-above={more.above || undefined}
        data-more-below={more.below || undefined}
      >
        {pinned.length > 0 ? (
          <>
            <div className="tws-rail-group" role="group" aria-label="Pinned" data-testid="tws-rail-pinned">
              {pinned.map((config) => kindButton(config, 'pinned'))}
            </div>
            {pinnedOnly ? null : <hr className="tws-rail-rule" />}
          </>
        ) : null}
        {pinnedOnly ? (
          <div className="tws-rail-group" role="group" aria-label="More" data-testid="tws-rail-more">
            <RailPopoverButton
              label="More kinds"
              tip="More kinds"
              icon={<VectorIcon paths={MORE_ART} size={16} strokeWidth={2} />}
              expanded={expanded}
              testId="tws-rail-more-toggle"
              popoverLabel="More kinds"
              variant="more"
              align="start"
              inRail
            >
              {(close) => (
                <RailMoreKinds
                  kinds={kinds}
                  currentKind={browserKind}
                  currentSource={currentSource}
                  onOpenKind={(kind) => {
                    close();
                    openKind(kind);
                  }}
                  onOpenSource={(id) => {
                    close();
                    selectSource(id);
                  }}
                  onTogglePin={togglePin}
                />
              )}
            </RailPopoverButton>
          </div>
        ) : (
          <>
            <div className="tws-rail-group" role="group" aria-label="Kinds" data-testid="tws-rail-kinds">
              {kinds.map((config) => kindButton(config, 'list'))}
            </div>
            {/* Non-entity browser sources (Project files), from their registry. */}
            <hr className="tws-rail-rule" />
            <div className="tws-rail-group" role="group" aria-label="Sources" data-testid="tws-rail-sources">
              {browserSources().map((source) => (
                <SourceButton
                  key={source.id}
                  source={source}
                  current={source.id === currentSource}
                  expanded={expanded}
                  onSelect={selectSource}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <hr className="tws-rail-rule" />
      {/* THE THREE (Subhang, 2026-10-07): Needs you, you, expand. The avatar
          opens the account card beside the rail; the rail never swaps. */}
      <div className="tws-rail-bottom" role="group" aria-label="Rail controls">
        <RailAttention expanded={expanded} />
        <RailUser expanded={expanded} />
        <RailTip label={expanded ? null : expandLabel} shortcut="⌘\">
          <button
            type="button"
            className="tws-rail-btn tws-rail-expand"
            aria-label={expandLabel}
            aria-keyshortcuts="Meta+\"
            data-testid="tws-rail-expand"
            onClick={toggleExpanded}
          >
            <span className="tws-rail-icon">
              <span className="tws-rail-disc" data-disc="expand">
                <VectorIcon paths={expanded ? RAIL_COLLAPSE_ART : RAIL_EXPAND_ART} size={16} />
              </span>
            </span>
            {expanded ? <span className="tws-rail-label">{expandLabel}</span> : null}
          </button>
        </RailTip>
      </div>
      <span className="tws-sr-only" aria-live="polite" data-testid="tws-rail-live">
        {announcement}
      </span>
    </nav>
  );
}

/**
 * THE MORE KINDS CARD: every kind the rail does not pin, then the sources. A
 * row opens it (and closes the card); a kind's pin button pins it, which moves
 * it onto the rail and out of this list while the card stays open, so several
 * can be pinned in a row. Focus stays in the card, on the next pin button.
 */
function RailMoreKinds({
  kinds,
  currentKind,
  currentSource,
  onOpenKind,
  onOpenSource,
  onTogglePin,
}: {
  kinds: readonly KindConfig[];
  currentKind: string | null | undefined;
  currentSource: string | null | undefined;
  onOpenKind(kind: string): void;
  onOpenSource(sourceId: string): void;
  onTogglePin(config: KindConfig): boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const pin = (config: KindConfig, index: number) => {
    onTogglePin(config);
    window.setTimeout(() => {
      const buttons = list.current?.querySelectorAll<HTMLElement>('.tws-rail-more-pin');
      const next = buttons?.[Math.min(index, buttons.length - 1)];
      (next ?? list.current)?.focus();
    }, 0);
  };
  const sources: readonly BrowserSource[] = browserSources();
  return (
    <div ref={list} className="tws-rail-more-list" tabIndex={-1} data-testid="tws-rail-kinds">
      {kinds.length === 0 ? <div className="tws-rail-more-empty">Every kind is pinned.</div> : null}
      {kinds.map((config, index) => (
        <div key={config.kind} className="tws-rail-more-row">
          <button
            type="button"
            className="tws-menu-row tws-rail-more-open"
            data-kind={config.kind}
            aria-current={config.kind === currentKind ? 'true' : undefined}
            onClick={() => onOpenKind(config.kind)}
          >
            <KindIcon kind={config.kind} size={16} />
            <span className="tws-rail-more-label">{config.labelPlural}</span>
          </button>
          <button
            type="button"
            className="tws-icon-btn tws-rail-more-pin"
            aria-label={`Pin ${config.labelPlural}`}
            title={`Pin ${config.labelPlural} to the rail`}
            data-pin={config.kind}
            onClick={() => pin(config, index)}
          >
            <VectorIcon paths={RAIL_PIN_ART} size={16} strokeWidth={1.4} />
          </button>
        </div>
      ))}
      {sources.length > 0 ? (
        <>
          <hr className="tws-rail-more-rule" />
          <div role="group" aria-label="Sources" data-testid="tws-rail-sources">
            {sources.map((source) => (
              <button
                key={source.id}
                type="button"
                className="tws-menu-row tws-rail-more-open"
                data-source={source.id}
                aria-current={source.id === currentSource ? 'true' : undefined}
                onClick={() => onOpenSource(source.id)}
              >
                <VectorIcon paths={source.art} size={16} />
                <span className="tws-rail-more-label">{source.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

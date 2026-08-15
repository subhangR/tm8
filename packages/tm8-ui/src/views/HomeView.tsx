/**
 * HomeView — Home, and the detail column it opens BESIDE itself.
 *
 * THE DEFECT THIS EXISTS FOR (user report, 2026-08-16). Pressing an entity
 * chip in the chat transcript ran `navigateTo(WORKSPACE_TARGET); nav.push(id)`.
 * That is the right handoff for a screen you are DONE with — Git's lane
 * click-through, Messages' "leave the conversation for the entity it lives
 * on" — and the wrong one for a chip inside a conversation you are still
 * having. The reply that mentioned the task went off screen to show you the
 * task, and getting back meant navigating home and losing the thread.
 *
 * So Home becomes the third host that owns a detail region, after the entity
 * screen and the channel screen, and it does it the way they do: `HomePage`
 * keeps the chrome (the column, its border, its width), `AuxEntityPanel`
 * supplies the panel, and this file owns the one set of ports both share.
 *
 * WHY THE PORTS ARE BUILT HERE AND NOT IN `auxPanel`. Every one of them —
 * `primaries`, `membership`, `launchPort`, `rowLifecycle`, `attachments` — is
 * a per-SCREEN singleton. Building them inside the panel would give Home a
 * second executor, and two executors that disagree about what a write means is
 * the failure `auxPanel`'s docblock names. One screen, one set.
 *
 * THE SELECTION OUTLIVES THE MOUNT. It is held in `screenStackStore` under
 * `view:dashboard`, not in `useState`, for the reason that store exists:
 * switching rail items swaps a branch of GateApp's ternary and UNMOUNTS this
 * view, so component-local state does not get "cleared", it ceases to exist.
 * Coming back to Home returns you to what you were reading.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { HomePage } from '../home-page';
import { AuxEntityPanel } from './auxPanel';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import type { ControlHost, DetailReasons } from '../panels';
import type { ActionRef } from '../domain';
import { attachmentsFor } from '../files/port';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import type { Notice } from '../shell';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import type { GateData } from './useGateData';

/* Same floor and same default as the channel screen's aside: two surfaces
   showing the same `EntityDetailPanel` at two different widths is the drift
   `PanelResizer` was made to stop. `HOME_MIN` is what the conversation needs
   to still be a conversation. */
const ASIDE_MIN = 320;
const ASIDE_DEFAULT = 440;
const HOME_MIN = 420;
/** The 8px separator track plus the aside's own 1px border — this package sets
    no global `border-box`, so that border ADDS to the declared width. */
const ASIDE_CHROME = 8 + 1;

export interface HomeViewProps {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
  onNotice(notice: Notice): void;
  /** Absent ⇒ the panel's Launch renders disabled-with-reason, as everywhere. */
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
  onOpenKind(kind: string): void;
  onOpenWorkspace(): void;
  countsFor?: (kind: string) => { total: number; unseen: number } | undefined;
  /**
   * The chat surface, built by the host that owns its seam wiring — handed the
   * opener so a chip press lands in THIS screen's column. A render prop rather
   * than a node because the callback is the whole point of the fix.
   */
  chat(onOpenEntity: (id: EntityId) => void): ReactNode;
}

export function HomeView(props: HomeViewProps) {
  const { data, reasons, onNotice } = props;

  const screen = useScreenStack(screenKeyOf.view('dashboard'));
  const selectedId = screen.selected;
  const openEntity = useCallback((id: EntityId) => screen.open(id), []); // eslint-disable-line react-hooks/exhaustive-deps

  const notifyActionFailed = useCallback(
    (_verb: ActionRef, _entityId: string, error: unknown) => {
      onNotice({
        id: 'session-close-failed',
        tone: 'error',
        title: 'Session could not be closed',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [onNotice],
  );

  const launchPort = useLaunchPort(data, props.onSpawn ? { onSpawn: props.onSpawn } : {});
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyActionFailed,
  });
  const rowLifecycle = useRowLifecycle({
    data,
    viewerMemberId: props.viewerMemberId,
    onNotice,
  });
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    onNotice,
  });
  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

  const ctx = useMemo(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const selectedDetail = selectedId ? data.detailOf(selectedId) : undefined;
  const controls = useMemo<ControlHost>(
    () => ({
      /* The SUBJECT's kind, because this screen shows no list — it feeds only
         the "this kind has no state to set" refusal, and before the detail
         lands there is no kind to claim. */
      kind: selectedDetail?.kind ?? '',
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id) => data.detailOf(id)?.capabilities,
      onNeedDetail: (id: string) => data.pull?.(id),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [selectedDetail?.kind, ctx, data, rowLifecycle],
  );

  /* The panel reads `detailOf`; nothing else on Home does, so the pull is this
     screen's to ask for. */
  if (selectedId && !selectedDetail) data.pull?.(selectedId);

  /* THE COLUMN IS DRAGGABLE, clamped against the conversation's floor — the
     same split the channel screen makes: `pref.width` is what the viewer asked
     for and survives a narrow window, `width` is what currently fits. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootWidth = useElementWidth(rootRef);
  const pref = usePanelWidth('home.aside', ASIDE_DEFAULT, ASIDE_MIN);
  const outerWidth = rootWidth > 0
    ? rootWidth
    : (typeof window === 'undefined' ? 0 : window.innerWidth);
  const asideMax = Math.max(ASIDE_MIN, outerWidth - HOME_MIN - ASIDE_CHROME);
  const asideWidth = Math.min(Math.max(ASIDE_MIN, pref.width), Math.max(ASIDE_MIN, asideMax));

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      // One rung down is the entity this one was opened FROM; with nothing
      // beneath it, popping closes the column exactly as before.
      screen.pop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const aside = selectedId ? (
    <>
      <PanelResizer
        side="right"
        label="Entity details"
        controls="home-view-aside"
        width={asideWidth}
        minWidth={ASIDE_MIN}
        maxWidth={asideMax}
        onResize={pref.setWidth}
        onReset={pref.reset}
      />
      <aside className="hp-aside" id="home-view-aside" aria-label="Entity details" data-testid="hp-aside">
      <AuxEntityPanel
        host={{
          data,
          reasons,
          ctx,
          controls,
          primaries,
          membership,
          launchPort,
          rowLifecycle,
          attachments,
          serverBaseUrl: props.serverBaseUrl,
          viewerMemberId: props.viewerMemberId,
        }}
        entityId={selectedId}
        /* Drilling from the column REPLACES its subject — reading sideways,
           not growing the screen. EntityView's ruling, and it travels here
           with the mount. */
        onOpenEntity={openEntity}
        onClose={() => screen.clear()}
      />
      </aside>
    </>
  ) : null;

  return (
    <div
      className="hp-host"
      ref={rootRef}
      style={{ '--hp-aside': `${asideWidth}px` } as React.CSSProperties}
    >
      <HomePage
        data={data}
        chat={props.chat(openEntity)}
        {...(aside ? { aside } : {})}
        /* A NEEDS YOU card opens where a chip does. They are the same gesture
           — "show me that" — from two places on one screen. */
        onOpenEntity={(id) => openEntity(id as EntityId)}
        onOpenKind={props.onOpenKind}
        onOpenWorkspace={props.onOpenWorkspace}
        {...(props.countsFor ? { countsFor: props.countsFor } : {})}
      />
    </div>
  );
}

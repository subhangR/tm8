/**
 * HomeView — Home's three regions (task 01a006f8, ruled 2026-08-16).
 *
 *   A · the left column (buttons, tabs, search, list) — drawn by
 *       ChatHomeScreen, fed through the host's render prop.
 *   B · the centre: the SELECTION. The chat conversation by default; a task
 *       or session selected from A replaces what B SHOWS while the chat stays
 *       MOUNTED but hidden (D8) — unmounting it would tear down a streaming
 *       thread. B's entity occupant is the same `AuxEntityPanel` mount C
 *       uses, so a session in B gets the real terminal (or its honest
 *       owner-only refusal) with no second panel implementation.
 *   C · the drill-in: a chip or link ANYWHERE in B opens here, beside B,
 *       never in the Workspace (D12). A chip pressed inside C REPLACES C's
 *       subject. Esc closes C, then B back to the chat (D14). Going to the
 *       Workspace is an explicit action in C's chrome only.
 *
 * WHY THE PORTS ARE BUILT HERE AND NOT IN `auxPanel`: every one of them —
 * `primaries`, `membership`, `launchPort`, `rowLifecycle`, `attachments` — is
 * a per-SCREEN singleton shared by BOTH mounts (B's entity occupant and C).
 * Two executors that disagree about what a write means is the failure
 * `auxPanel`'s docblock names. One screen, one set.
 *
 * THE SELECTIONS OUTLIVE THE MOUNT. C lives in `screenStackStore` under
 * `view:dashboard` (as before); B's occupant and the active tab live in
 * `homeRegionStore` — module-level because switching rail items unmounts this
 * view, and because D11's spawn path writes them from OUTSIDE it (GateApp
 * puts the new session in B and flips A to Sessions).
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { HomePage } from '../home-page';
import { AuxEntityPanel } from './auxPanel';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import type { ControlHost, DetailReasons } from '../panels';
import type { ActionRef } from '../domain';
import { getKind } from '../domain';
import { attachmentsFor } from '../files/port';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { useHomeRegion, type HomeTab } from '../stores/homeRegionStore';
import type { Notice } from '../shell';
import { LaunchSheet, type DispatchSelection, type LaunchSelection } from './LaunchSheet';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import type { GateData } from './useGateData';

/* Same floor and same default as the channel screen's aside: two surfaces
   showing the same `EntityDetailPanel` at two different widths is the drift
   `PanelResizer` was made to stop. */
const ASIDE_MIN = 320;
const ASIDE_DEFAULT = 440;
/** Region B's hard floor (D13) — what the conversation (or a terminal) needs
    to still be itself, PLUS column A beside it inside the chat grid. */
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
  /** D12: the ONE route out of Home — C's explicit workspace action. */
  onOpenInWorkspace?(id: EntityId): void;
  countsFor?: (kind: string) => { total: number; unseen: number } | undefined;
  /** D11/D14 — the GateApp launch-sheet singleton, mounted over this screen
   *  while it holds a subject, exactly as EntityView mounts it. */
  launchSubjectId?: EntityId | null;
  launchRefusal?: { cause: string; detail: string } | null;
  launchInFlight?: boolean;
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: LaunchSelection): void;
  onLaunchDispatch?(request: DispatchSelection): void;
  /**
   * The chat surface, built by the host that owns its seam wiring. The render
   * prop hands DOWN this screen's region state: the opener that lands a chip
   * press in C, and the region-A/B bundle the three-tab column needs.
   */
  chat(onOpenEntity: (id: EntityId) => void, regions: HomeChatRegions): ReactNode;
}

/** What the host's chat mount needs from this screen's region state. */
export interface HomeChatRegions {
  tab: HomeTab;
  onTab(tab: HomeTab): void;
  /** Region B's entity occupant, for A's honest per-tab highlight (D9). */
  selectedEntityId: EntityId | null;
  /** SELECTING (D7): a task/session row puts its entity in B. */
  onSelectEntity(id: string): void;
  /** A chat row (or ＋ New chat) returns B to the conversation. */
  onShowChat(): void;
  /** D2/D3: the create-immediately new-task flow, when available. */
  onNewTask?: (() => void) | undefined;
  newTaskUnavailable: { cause: string; remedy: string } | null;
  /** B's non-chat occupant, rendered inside the chat grid (D8). */
  centerOverride?: ReactNode;
}

export function HomeView(props: HomeViewProps) {
  const { data, reasons, onNotice } = props;

  /* C — the drill-in stack, unchanged from the aux-column pass. */
  const screen = useScreenStack(screenKeyOf.view('dashboard'));
  const drillId = screen.selected;
  const openEntity = useCallback((id: EntityId) => screen.open(id), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* B + A's tab — module-level per space (D15; D11 writes from GateApp). */
  const region = useHomeRegion(data.spaceId);
  const centerId = region.center;

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
  /* The control host serves BOTH panel mounts; its `kind` feeds only the
     "this kind has no state to set" refusal, so the drilled entity (the most
     recently opened) wins and an unloaded detail claims nothing. */
  const focusDetail = drillId
    ? data.detailOf(drillId)
    : centerId
      ? data.detailOf(centerId)
      : undefined;
  const controls = useMemo<ControlHost>(
    () => ({
      kind: focusDetail?.kind ?? '',
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
    [focusDetail?.kind, ctx, data, rowLifecycle],
  );

  /* The panels read `detailOf`; nothing else on Home does, so the pulls are
     this screen's to ask for — one per mounted region. */
  if (drillId && !data.detailOf(drillId)) data.pull?.(drillId);
  if (centerId && !data.detailOf(centerId)) data.pull?.(centerId);

  /* D2/D3 — ＋ New task: create an "Untitled task" immediately, select it
     into B, title focused in the panel. No compose form. */
  const taskKind = getKind('task');
  const newTask = useNewTask({
    spaceId: data.spaceId,
    kind: taskKind.kind,
    placeholderTitle: placeholderNameFor(taskKind, placeholderTitleFor(taskKind.label)),
    commands: data.seam.commands,
    onCreated: (id) => region.selectCenter(id),
  });
  useEffect(() => {
    if (newTask.state.phase !== 'refused') return;
    onNotice({
      id: 'home-new-task-refused',
      tone: 'error',
      title: newTask.state.failure.cause,
      body: newTask.state.failure.detail,
      ttlMs: 8_000,
    });
    newTask.dismiss();
  }, [newTask, onNotice]);

  /* THE C COLUMN IS DRAGGABLE, clamped against B's floor. D13: when the
     window cannot afford all three regions, C keeps its width and OVERLAYS B
     instead of crushing it — a squeezed xterm reflows to nonsense columns and
     reads as "the terminal is broken". */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootWidth = useElementWidth(rootRef);
  const pref = usePanelWidth('home.aside', ASIDE_DEFAULT, ASIDE_MIN);
  const outerWidth = rootWidth > 0
    ? rootWidth
    : (typeof window === 'undefined' ? 0 : window.innerWidth);
  const asideMax = Math.max(0, outerWidth - HOME_MIN - ASIDE_CHROME);
  /** Beside-mode is affordable only while C's floor fits next to B's floor.
      jsdom measures 0 ⇒ beside, so the overlay never triggers in tests that
      cannot measure (the same law as the workspace demotion loop). */
  const overlay = outerWidth > 0 && asideMax < ASIDE_MIN;
  const asideWidth = overlay
    ? Math.min(Math.max(ASIDE_MIN, pref.width), Math.max(ASIDE_MIN, outerWidth - 48))
    : Math.min(Math.max(ASIDE_MIN, pref.width), Math.max(ASIDE_MIN, asideMax));

  /* Esc walks DOWN one region per press: C first, then B back to the chat
     (D14). The launch sheet's own capture-phase Esc handler consumes its key
     before this listener can see it, and `defaultPrevented` honours any other
     surface that claimed the press (a focused terminal, the doc editor). */
  const hasDrill = drillId !== null;
  const hasCenter = centerId !== null;
  useEffect(() => {
    if (!hasDrill && !hasCenter) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (hasDrill) screen.pop();
      else region.selectCenter(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDrill, hasCenter]);

  const hostBundle = {
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
  };

  /* REGION B's entity occupant. Chips inside it open C (D12) — reading
     sideways lands BESIDE the selection, not over it. Closing it returns B
     to the chat. */
  const centerOverride = centerId ? (
    <AuxEntityPanel
      host={hostBundle}
      entityId={centerId}
      onOpenEntity={openEntity}
      onClose={() => region.selectCenter(null)}
    />
  ) : undefined;

  const regions: HomeChatRegions = {
    tab: region.tab,
    onTab: region.setTab,
    selectedEntityId: centerId,
    onSelectEntity: (id) => region.selectCenter(id as EntityId),
    onShowChat: () => region.selectCenter(null),
    ...(newTask.unavailable === null ? { onNewTask: () => void newTask.create() } : {}),
    newTaskUnavailable: newTask.unavailable,
    ...(centerOverride !== undefined ? { centerOverride } : {}),
  };

  /* REGION C. Chips inside it REPLACE its subject (auxPanel's ruling —
     drilling sideways, never a fourth column). The workspace hand-off is
     C's explicit chrome action and exists nowhere else on this screen. */
  const aside = drillId ? (
    <>
      {overlay ? null : (
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
      )}
      <aside
        className={`hp-aside${overlay ? ' hp-aside--overlay' : ''}`}
        id="home-view-aside"
        aria-label="Entity details"
        data-testid="hp-aside"
      >
        {props.onOpenInWorkspace ? (
          <div className="hp-aside__bar">
            <button
              type="button"
              className="hp-aside__workspace"
              title="Leave Home and open this entity in the full workspace"
              onClick={() => props.onOpenInWorkspace!(drillId)}
            >
              Open in Workspace <span aria-hidden>→</span>
            </button>
          </div>
        ) : null}
        <AuxEntityPanel
          host={hostBundle}
          entityId={drillId}
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
        chat={props.chat(openEntity, regions)}
        {...(aside ? { aside } : {})}
        /* A NEEDS YOU card opens where a chip does. They are the same gesture
           — "show me that" — from two places on one screen. */
        onOpenEntity={(id) => openEntity(id as EntityId)}
        onOpenKind={props.onOpenKind}
        onOpenWorkspace={props.onOpenWorkspace}
        {...(props.countsFor ? { countsFor: props.countsFor } : {})}
      />
      {/* D11/D14: the full launch sheet over this screen while the shell
          holds a subject — Run on a task row opened it. Its own capture-phase
          Esc closes it without popping C underneath. */}
      {props.launchSubjectId && (
        <LaunchSheet
          refusal={props.launchRefusal}
          launching={props.launchInFlight}
          subjectId={props.launchSubjectId}
          fromChip="◔ Run ▸"
          fromCaption="subject pre-associated — the session links to it"
          teammates={data.launch.teammates}
          projects={data.launch.projects}
          profiles={data.launch.profiles}
          memories={data.launch.memories}
          capacity={data.launch.capacity}
          loadCredentialStatus={data.seam.credentials.status}
          onCancel={() => props.onLaunchCancel?.()}
          onLaunch={(config) => props.onLaunchSubmit?.(config)}
          onDispatch={props.onLaunchDispatch}
        />
      )}
    </div>
  );
}

/**
 * HomeView — the unified Home's three regions (task 01a006f8, generalized by
 * task 01a00932; selection model re-seated by its D1 ruling).
 *
 *   A · the left column (root header, list) — drawn by ChatHomeScreen, fed
 *       through the host's render prop.
 *   B · the centre: the SELECTION, now the route's `p` TRAIL. The chat
 *       conversation when the trail is empty; a row selected from A restarts
 *       the trail (`openCenter`); an IN-TREE click inside B grows it
 *       (`push` — R6: hierarchy navigates in place) while the chat stays
 *       MOUNTED but hidden (D8). The trail renders as B's breadcrumb (R7).
 *   C · the right panel: the route's `r` TRAIL. A RELATED entity clicked in
 *       B — different kind, or same kind outside the root's tree — opens
 *       here, beside B, never in the Workspace (D12/R6). A chip inside C
 *       pushes onto its trail (same panel, longer crumb). "Open here"
 *       PROMOTES C's subject to B's root and moves the list selection (R6).
 *       Esc pops C first, then B (D14 generalized to the trails).
 *
 * THE ROUTE OWNS ALL OF IT (D1, the LLD's central reconciliation): both
 * trails live in `navStore` and therefore in the URL, so a Home deep link
 * reproduces the whole arrangement and the back button walks it. What the
 * old module-level stores held is gone — `homeRegionStore` keeps only the
 * remembered ROOT (D15), and GateApp's D11 spawn flip writes `navStore`.
 *
 * "IN THE TREE" is one definition (R6): the clicked entity's parent chain,
 * walked through `detailOf`, reaches B's trail root. An unloaded parent
 * chain falls back to the RIGHT panel — sideways is the reversible default;
 * silently re-rooting the centre is not.
 *
 * WHY THE PORTS ARE BUILT HERE AND NOT IN `auxPanel`: every one of them —
 * `primaries`, `membership`, `launchPort`, `rowLifecycle`, `attachments` — is
 * a per-SCREEN singleton shared by BOTH mounts (B's entity occupant and C).
 * Two executors that disagree about what a write means is the failure
 * `auxPanel`'s docblock names. One screen, one set.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { HomePage } from '../home-page';
import { AuxEntityPanel } from './auxPanel';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import { EntityListPanel, type ControlHost, type DetailReasons } from '../panels';
import type { ActionRef } from '../domain';
import { getKind } from '../domain';
import { attachmentsFor } from '../files/port';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { navStore, useNavStore } from '../stores/navStore';
import { loadHomeRoot, rememberHomeRoot, type HomeRoot } from '../stores/homeRegionStore';
import {
  CHATS_ROOT,
  DEFAULT_HOME_KIND,
  homeRailGroups,
  homeRootKinds,
  isHomeRootKind,
  kindOfSlug,
  slugOfKind,
} from '../domain';
import type { NavView } from '../routes/types';
import type { HomeRootOption } from '../chat-home/ChatHomeScreen';
import { HomeRail } from './HomeRail';
import { HomeTrail } from './HomeTrail';
import { inTreeOf } from './home-tree';
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
  onOpenWorkspace(): void;
  /** D12: the ONE route out of Home — C's explicit workspace action. */
  onOpenInWorkspace?(id: EntityId): void;
  /** D11/D14 — the GateApp launch-sheet singleton, mounted over this screen
   *  while it holds a subject, exactly as EntityView mounts it. */
  onLaunchOpen?(id: EntityId): void;
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
  /** The active root — `CHATS_ROOT` or a collection kind (task 01a00932 R3). */
  root: HomeRoot;
  onRoot(root: HomeRoot): void;
  /** What the header's kind cell names (R5) — the current kind root, or the
   *  remembered one while Chats is the root. */
  kindCell: HomeRootOption;
  /** The switcher's kind list — the rail flattened (R4). */
  rootKindOptions: readonly HomeRootOption[];
  /** Region B's entity occupant, for A's honest per-root highlight (D9). */
  selectedEntityId: EntityId | null;
  /** SELECTING (D7): a row puts its entity in B. */
  onSelectEntity(id: string): void;
  /** A chat row (or ＋ New chat) returns B to the conversation. */
  onShowChat(): void;
  /** D2/D3 generalized (R5): create-immediately for the kind cell's kind. */
  onNewEntity?: (() => void) | undefined;
  newEntityUnavailable: { cause: string; remedy: string } | null;
  /** B's non-chat occupant, rendered inside the chat grid (D8). */
  centerOverride?: ReactNode;
  /** The conversation the ADDRESS names (`/home/chat/{id}`), for the screen
   *  to adopt — back/forward and shared links land on the right thread. */
  routeThreadId?: EntityId | null;
  /** The screen's thread selection, so the address can carry it (D1). */
  onThreadSelected?(id: EntityId | null): void;
  /** `?graph=full` — the entity graph fullscreen, route-owned (01a0094b D2). */
  graphFull?: boolean;
  onGraphFullChange?(open: boolean): void;
  /** `?gf=` — the graph's serialised filters, opaque at this layer (step 5). */
  graphFilters?: string | null;
  onGraphFiltersChange?(encoded: string | null): void;
  /**
   * A KIND root's list CONTENT: the WORKSPACE's own `EntityListPanel` —
   * the exact tree, tiles, lifecycle tabs, sort and in-panel search the
   * workspace list draws (user ruling 2026-08-16: "exact tree structure,
   * reuse the same components full"). Composed here because the control
   * executor (`rowLifecycle` through `ControlHost`) is this screen's
   * singleton. Returns null for the Chats root (the screen's own list).
   */
  renderRootList?: (root: HomeRoot) => ReactNode;
}

/** The `NavView` a Home root addresses (the inverse lives in the resolver below). */
function homeViewOf(root: HomeRoot): NavView {
  if (root === CHATS_ROOT) return { view: 'home', root: { type: 'chats', threadId: null } };
  const slug = slugOfKind(root);
  return slug ? { view: 'home', root: { type: 'kind', slug } } : { view: 'home' };
}

export function HomeView(props: HomeViewProps) {
  const { data, reasons, onNotice } = props;

  /* THE TRAILS — route state, read live (D1). B is the stack; C is `r`. */
  const navView = useNavStore((s) => s.view);
  const stack = useNavStore((s) => s.stack);
  const rightTrail = useNavStore((s) => s.right);
  const centerId = stack.length > 0 ? stack[stack.length - 1]! : null;
  const drillId = rightTrail.length > 0 ? rightTrail[rightTrail.length - 1]! : null;
  const openEntity = useCallback((id: EntityId) => navStore.getState().openRight(id), []);

  /* THE ROOT: the address wins; a bare `/home` falls back to the remembered
     root (D15). An unregistered slug is not a root we can list — the memory
     answers, never a blank. */
  const routeRoot = navView.view === 'home' ? (navView.root ?? null) : null;
  const routeRootKind = routeRoot?.type === 'kind' ? kindOfSlug(routeRoot.slug) : null;
  const root: HomeRoot =
    routeRoot?.type === 'chats'
      ? CHATS_ROOT
      : routeRootKind && isHomeRootKind(routeRootKind)
        ? routeRootKind
        : loadHomeRoot(data.spaceId);
  const routeThreadId = routeRoot?.type === 'chats' ? routeRoot.threadId : null;

  /* Switching the root is BROWSING (D6): it renames the address's root and
     touches neither trail. Remembered so a bare `/home` returns here. */
  const setRoot = useCallback(
    (next: HomeRoot) => {
      rememberHomeRoot(data.spaceId, next);
      navStore.getState().navigate(homeViewOf(next));
    },
    [data.spaceId],
  );

  /* THE KIND CELL'S MEMORY (R5): while Chats is the root, the cell keeps
     naming the kind the viewer would return to — the last kind root this
     mount saw, defaulting to tasks. In-memory only: the ROOT is what
     persists (D15), the cell is presentation. */
  const lastKindRef = useRef<string>(DEFAULT_HOME_KIND);
  if (root !== CHATS_ROOT) lastKindRef.current = root;
  const cellKind = root === CHATS_ROOT ? lastKindRef.current : root;
  const cellConfig = getKind(cellKind);
  const kindCell = useMemo<HomeRootOption>(
    () => ({ kind: cellConfig.kind, label: cellConfig.labelPlural, single: cellConfig.label }),
    [cellConfig],
  );
  /* R4: the switcher IS the rail flattened — both render `homeRailGroups()`. */
  const rootKindOptions = useMemo<HomeRootOption[]>(
    () =>
      homeRootKinds().map((config) => ({
        kind: config.kind,
        label: config.labelPlural,
        single: config.label,
      })),
    [],
  );

  /* R6's click rule at its one seam: in-tree grows B's trail (in place);
     everything else opens beside it. `inTreeOf` is the shared definition —
     see views/home-tree.ts and its decision table. */
  const treeRootId = stack.length > 0 ? stack[0]! : null;
  const openFromCenter = useCallback(
    (id: EntityId) => {
      const nav = navStore.getState();
      const parentOf = (cursor: EntityId) =>
        (data.detailOf(cursor)?.parentId ?? null) as EntityId | null;
      if (inTreeOf(treeRootId, id, parentOf)) nav.push(id);
      else nav.openRight(id);
    },
    [treeRootId, data],
  );

  /* Trail crumbs resolve titles through the same read the panels use. */
  const titleOf = useCallback(
    (id: EntityId) => {
      const detail = data.detailOf(id);
      if (!detail) {
        data.pull?.(id);
        return null;
      }
      return { title: detail.title, kind: detail.kind };
    },
    [data],
  );

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

  /* `onFullOptions` rides in when the shell wired `onLaunchOpen` — a task
     row's Run then goes STRAIGHT to the launch sheet this screen mounts,
     the same outranking the kind screens apply. */
  const launchPort = useLaunchPort(data, {
    ...(props.onSpawn ? { onSpawn: props.onSpawn } : {}),
    ...(props.onLaunchOpen
      ? { onFullOptions: (entityId: string) => props.onLaunchOpen!(entityId as EntityId) }
      : {}),
  });
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
      /* Row verbs (Run, Complete) dispatch through the SAME primaries the
         panels use — one executor per screen. `forEntity` answers undefined
         for an unwired verb, which the optional call keeps unreachable. */
      onAction: (ref, entityId) => primaries.forEntity(entityId)?.(ref),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [focusDetail?.kind, ctx, data, primaries, rowLifecycle],
  );

  /* The panels read `detailOf`; nothing else on Home does, so the pulls are
     this screen's to ask for — one per mounted region. */
  if (drillId && !data.detailOf(drillId)) data.pull?.(drillId);
  if (centerId && !data.detailOf(centerId)) data.pull?.(centerId);

  /* D2/D3 generalized (R5) — the kind cell's ＋: create an "Untitled {kind}"
     immediately, select it into B, title focused in the panel. No compose
     form. A kind whose registry row refuses quick-create renders the ＋
     disabled-with-reason instead — never hidden, never a dead button. */
  const newEntity = useNewTask({
    spaceId: data.spaceId,
    kind: cellConfig.kind,
    placeholderTitle: placeholderNameFor(cellConfig, placeholderTitleFor(cellConfig.label)),
    commands: data.seam.commands,
    onCreated: (id) => navStore.getState().openCenter(id),
    refusal: cellConfig.list.quickCreate
      ? null
      : {
          cause: `${cellConfig.labelPlural} aren’t created from here`,
          remedy: 'they are made by their own flow',
        },
  });
  useEffect(() => {
    if (newEntity.state.phase !== 'refused') return;
    onNotice({
      id: 'home-new-entity-refused',
      tone: 'error',
      title: newEntity.state.failure.cause,
      body: newEntity.state.failure.detail,
      ttlMs: 8_000,
    });
    newEntity.dismiss();
  }, [newEntity, onNotice]);

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

  /* Esc walks DOWN one step per press: C's trail first, then B's, until the
     chat is back (D14, generalized to the trails). The launch sheet's own
     capture-phase Esc handler consumes its key before this listener can see
     it, and `defaultPrevented` honours any other surface that claimed the
     press (a focused terminal, the doc editor). */
  const hasDrill = drillId !== null;
  const hasCenter = centerId !== null;
  useEffect(() => {
    if (!hasDrill && !hasCenter) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      const nav = navStore.getState();
      if (hasDrill) nav.popRight();
      else nav.pop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
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

  /* REGION B's entity occupant, under its trail crumb (R7). Clicks inside it
     split by R6: in-tree grows THIS trail (in place); relations open C —
     sideways lands BESIDE the selection, not over it. Closing returns B to
     the chat. */
  const centerOverride = centerId ? (
    <div className="hp-trail-host" data-testid="hp-center-trail-host">
      <HomeTrail
        trail={stack}
        label="Centre trail"
        titleOf={titleOf}
        onCrumb={(id) => navStore.getState().stackTo(id)}
      />
      <AuxEntityPanel
        host={hostBundle}
        entityId={centerId}
        onOpenEntity={openFromCenter}
        onClose={() => navStore.getState().clearStack()}
      />
    </div>
  ) : undefined;

  /* EVERY KIND ROOT IS THE WORKSPACE LIST (user ruling 2026-08-16,
     generalized by task 01a00932 R3): the SAME `EntityListPanel` the
     workspace and the entity screens mount — its tree (children, expand,
     depth), its tiles with the changeable-status expand, its lifecycle tabs,
     sort and its own in-panel search. Composed here because every executor
     it needs is this screen's singleton set; the chat column just gives it
     the root's space. The mount mirrors `EntityView`'s, minus the header
     verbs no Home executor owns (they render their honest not-wired
     refusal). */
  const renderRootList = useCallback(
    (listRoot: HomeRoot): ReactNode => {
      if (listRoot === CHATS_ROOT) return null;
      const kind = listRoot;
      return (
        <EntityListPanel
          kind={kind}
          rowsFor={data.rowsFor(kind)}
          pageStateOf={data.pageStateOf(kind)}
          loadMore={data.loadMore(kind)}
          boardFor={data.boardFor(kind) as never}
          members={data.members}
          ctx={ctx}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          onNeedDetail={(id) => data.pull?.(id)}
          selectedId={centerId}
          /* R6a: a LIST click ROOTS the centre — the trail restarts here. */
          onSelect={(id) => navStore.getState().openCenter(id as EntityId)}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          onMembership={rowLifecycle.membership}
          membershipSets={rowLifecycle.membershipSets}
          connectionsOf={data.connectionsOf}
          launch={launchPort}
          compact
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, ctx, centerId, rowLifecycle, launchPort],
  );

  const regions: HomeChatRegions = {
    root,
    onRoot: setRoot,
    kindCell,
    rootKindOptions,
    selectedEntityId: centerId,
    onSelectEntity: (id) => navStore.getState().openCenter(id as EntityId),
    onShowChat: () => navStore.getState().clearStack(),
    ...(newEntity.unavailable === null ? { onNewEntity: () => void newEntity.create() } : {}),
    newEntityUnavailable: newEntity.unavailable,
    ...(centerOverride !== undefined ? { centerOverride } : {}),
    routeThreadId,
    /* The open conversation is part of the address (`/home/chat/{id}`), so
       back/forward walk threads and a conversation can be linked to. */
    onThreadSelected: (id) =>
      navStore.getState().navigate({
        view: 'home',
        root: { type: 'chats', threadId: id },
      }),
    /* The graph's fullscreen view is part of the address too (`?graph=full`,
       01a0094b D2): opening PUSHES history, so Back closes the dialog. The
       `?gf=` filters survive open/close both ways — a filter chosen
       fullscreen still shapes the inline summary after Back (step 5). */
    graphFull: routeRoot?.type === 'chats' && routeRoot.graph === 'full',
    onGraphFullChange: (open) =>
      navStore.getState().navigate({
        view: 'home',
        root: {
          type: 'chats',
          threadId: routeThreadId,
          ...(open ? { graph: 'full' as const } : {}),
          ...(routeRoot?.type === 'chats' && routeRoot.graphFilters
            ? { graphFilters: routeRoot.graphFilters }
            : {}),
        },
      }),
    graphFilters: routeRoot?.type === 'chats' ? (routeRoot.graphFilters ?? null) : null,
    onGraphFiltersChange: (encoded) =>
      navStore.getState().navigate({
        view: 'home',
        root: {
          type: 'chats',
          threadId: routeThreadId,
          ...(routeRoot?.type === 'chats' && routeRoot.graph === 'full'
            ? { graph: 'full' as const }
            : {}),
          ...(encoded ? { graphFilters: encoded } : {}),
        },
      }),
    renderRootList,
  };

  /* THE ICON RAIL (R4) — the switcher's twin: same groups, same select, no
     view rows. No row is active while Chats is the root; chats live in the
     list header's own cell, not the rail. */
  const rail = (
    <HomeRail
      groups={homeRailGroups()}
      activeKind={root === CHATS_ROOT ? null : root}
      onSelect={setRoot}
    />
  );

  /* R6's PROMOTE — "open here": C's subject becomes B's ROOT, the left list
     follows it (selection AND, when its kind differs, the root list), and
     both trails settle. The explicit escape hatch out of sideways reading. */
  const promoteDrill = useCallback(() => {
    if (!drillId) return;
    const nav = navStore.getState();
    const kind = data.detailOf(drillId)?.kind;
    if (kind && isHomeRootKind(kind) && kind !== root) {
      rememberHomeRoot(data.spaceId, kind);
      nav.navigate(homeViewOf(kind));
    }
    nav.openCenter(drillId);
    nav.closeRight();
  }, [drillId, data, root]);

  /* REGION C. Chips inside it PUSH onto its trail (drilling sideways, never
     a fourth column — the crumb is how you walk back, R7). The workspace
     hand-off and Promote are C's explicit chrome actions and exist nowhere
     else on this screen. */
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
        <div className="hp-aside__bar">
          <button
            type="button"
            className="hp-aside__workspace"
            title="Make this entity the centre's root — the list follows it"
            onClick={promoteDrill}
          >
            ⇤ Open here
          </button>
          {props.onOpenInWorkspace ? (
            <button
              type="button"
              className="hp-aside__workspace"
              title="Leave Home and open this entity in the full workspace"
              onClick={() => props.onOpenInWorkspace!(drillId)}
            >
              Open in Workspace <span aria-hidden>→</span>
            </button>
          ) : null}
        </div>
        <HomeTrail
          trail={rightTrail}
          label="Side panel trail"
          titleOf={titleOf}
          onCrumb={(id) => navStore.getState().rightTo(id)}
        />
        <AuxEntityPanel
          host={hostBundle}
          entityId={drillId}
          onOpenEntity={openEntity}
          onClose={() => navStore.getState().closeRight()}
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
        rail={rail}
        {...(aside ? { aside } : {})}
        /* A NEEDS YOU card opens where a chip does. They are the same gesture
           — "show me that" — from two places on one screen. */
        onOpenEntity={(id) => openEntity(id as EntityId)}
        onOpenWorkspace={props.onOpenWorkspace}
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

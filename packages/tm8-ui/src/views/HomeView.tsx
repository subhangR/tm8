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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { HomePage } from '../home-page';
import { AuxEntityPanel } from './auxPanel';
import { PanelResizer, useElementWidth, usePanelFlag, usePanelWidth } from '../kit';
import {
  EntityListPanel,
  NewContainerSheet,
  type ControlHost,
  type DetailReasons,
} from '../panels';
import type { ActionRef } from '../domain';
import { getKind } from '../domain';
import { attachmentsFor } from '../files/port';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { navStore, useNavStore } from '../stores/navStore';
import { chatAboutTarget, composeListActions, useChatAbout } from './useChatAbout';
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
import type { CockpitStage, NavView } from '../routes/types';
import { rootBirthAction, type ListRootOption } from '../panels/ListRootHeader';
import { HomeRail } from './HomeRail';
import { HomeTrail } from './HomeTrail';
import { inTreeOf } from './home-tree';
import type { Notice } from '../shell';
import { LaunchSheet, type DispatchSelection, type LaunchSelection } from './LaunchSheet';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import { useSessionStart } from './useSessionStart';
import { useNewContainerSheet } from './useNewContainerSheet';
import type { GateData } from './useGateData';

/* Same floor and same default as the channel screen's aside: two surfaces
   showing the same `EntityDetailPanel` at two different widths is the drift
   `PanelResizer` was made to stop. */
const ASIDE_MIN = 320;
const ASIDE_DEFAULT = 440;
/** The 8px separator track plus the aside's own 1px border — this package sets
    no global `border-box`, so that border ADDS to the declared width. */
const ASIDE_CHROME = 8 + 1;

/* ---------------------------------------------------------------------------
   COLUMN A AND THE RAIL (task 01a00ac2)
   ---------------------------------------------------------------------------
   `HOME_MIN = 420` used to stand here as region B's floor "PLUS column A
   beside it". That number was already a fiction and a resizable A is what
   makes the fiction load-bearing: the rail alone is 72 and A's own CSS floor
   was 300, which leaves 48px for B — less than an eighth of what the comment
   claimed B needed. Nothing caught it because A's width was a constant, so
   the under-count only ever showed up as the overlay firing later than it
   should have.

   The bundle is therefore split into the three things it was pretending to
   be, and the floor left of C is now COMPUTED from them (`leftFloor` below)
   rather than typed. Every one of these is a floor in the 02-LAYOUT §6 sense:
   the width below which the column stops being itself. */

/** Region B alone — what the conversation (or a terminal) needs to still be
    itself, with A and the rail no longer smuggled inside the number. */
export const HOME_CENTER_MIN = 360;
/** Column A. 240 keeps a task row's title readable; 560 is where a list stops
    being a list and starts being a second reading column. 340 is a hair under
    today's fluid track resting width, so nothing jumps on first paint for a
    viewer who has never dragged it. (Ruled by Subhang, 2026-08-16.) */
export const HOME_LIST_MIN = 240;
export const HOME_LIST_DEFAULT = 340;
export const HOME_LIST_MAX = 560;
/** A's separator track. It has no border of its own — unlike the aside, which
    is why this is 8 and `ASIDE_CHROME` is 9. */
export const HOME_LIST_CHROME = 8;

/* The rail's two widths, which the SOLVER needs and CSS used to own alone
   (`home-page.css`'s `.hr-rail` 72 / 172). Duplicating a floor in a
   stylesheet is exactly what geometry.ts's standing rule forbids, so they
   live here now and are handed to CSS as `--hp-rail`. */
export const HOME_RAIL_COLLAPSED = 72;
export const HOME_RAIL_EXPANDED = 172;

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
  /**
   * FOCUS MODE — the ruled single toggle that collapses the icon rail AND
   * column A together (task 01a00ac2). It is owned by `GateApp` rather than
   * here for one reason: Mod+\ is a GLOBAL binding handled on the window, and
   * a second `usePanelFlag('home-focus')` in this file would hold its own
   * `useState` and drift from the one the shortcut writes.
   */
  focus?: boolean;
  onToggleFocus?(): void;
}

/** What the host's chat mount needs from this screen's region state. */
export interface HomeChatRegions {
  /** The active root — `CHATS_ROOT` or a collection kind (task 01a00932 R3). */
  root: HomeRoot;
  onRoot(root: HomeRoot): void;
  /** What the header's kind cell names (R5) — the current kind root, or the
   *  remembered one while Chats is the root. */
  kindCell: ListRootOption;
  /** The switcher's kind list — the rail flattened (R4). */
  rootKindOptions: readonly ListRootOption[];
  /** Region B's entity occupant, for A's honest per-root highlight (D9). */
  selectedEntityId: EntityId | null;
  /** SELECTING (D7): a row puts its entity in B. */
  onSelectEntity(id: string): void;
  /** A chat row (or ＋ New chat) returns B to the conversation. */
  onShowChat(): void;
  /** D2/D3 generalized (R5): create-immediately for the kind cell's kind. */
  onNewEntity?: (() => void) | undefined;
  newEntityUnavailable: { cause: string; remedy: string } | null;
  /** The kind menu's per-row ＋ — the same verb, for any kind in the list. */
  onCreateKind: (kind: string) => void;
  createKindUnavailable: (kind: string) => { cause: string; remedy: string } | null;
  /** B's non-chat occupant, rendered inside the chat grid (D8). */
  centerOverride?: ReactNode;
  /** The conversation the ADDRESS names (`/home/chat/{id}`), for the screen
   *  to adopt — back/forward and shared links land on the right thread. */
  routeThreadId?: EntityId | null;
  /** The screen's thread selection, so the address can carry it (D1). */
  onThreadSelected?(id: EntityId | null): void;
  /**
   * `?stage=` — which non-entity Cockpit stage is up (fleet | graph), and the
   * verb that swaps it. Route-owned for the reason `?graph=full` was: Back
   * leaves the stage, a reload restores it, and the view can be linked.
   */
  stage?: CockpitStage | null;
  onStageChange?(next: CockpitStage | null): void;
  /**
   * `?about=` — the entity a NEW conversation started here should be about.
   *
   * Route-owned for the same reason `?stage=` is, and for one more: the verb
   * that sets it ("Chat about this", on a row's action cluster and on the
   * Chats list header) is a NAVIGATION, not a command. It has nowhere to ask
   * for a teammate, a model and a mode, so it hands the subject to the
   * composer through the address and the human commits it there — where a
   * reload keeps it and a paste carries it.
   *
   * IGNORED once a thread is open: an existing conversation's subject is
   * already decided.
   */
  aboutId?: EntityId | null;
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
  /* THE STAGE the address names. A stage and an entity both want region B, and
     the ENTITY WINS when both are addressed: the entity was opened by a click
     the viewer just made, while a stage can persist in a link from yesterday.
     Resolved here, once, so the screen never has to arbitrate. */
  const routeStage: CockpitStage | null =
    routeRoot?.type === 'chats' && !centerId ? (routeRoot.stage ?? null) : null;
  /* The subject a new conversation here is about (`?about=`), from the same
     root. Unlike the stage it does not compete with region B for space — it
     configures the COMPOSER — so it survives an open entity. */
  const routeAboutId: EntityId | null =
    routeRoot?.type === 'chats' ? (routeRoot.aboutId ?? null) : null;

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
  const kindCell = useMemo<ListRootOption>(
    () => ({ kind: cellConfig.kind, label: cellConfig.labelPlural, single: cellConfig.label }),
    [cellConfig],
  );
  /* R4: the switcher IS the rail flattened — both render `homeRailGroups()`. */
  const rootKindOptions = useMemo<ListRootOption[]>(
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
        id: 'session-terminate-failed',
        tone: 'error',
        title: 'Session could not be terminated',
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
     /* The version the viewer is LOOKING AT — see `versionOf` on the hook. */
    versionOf: (id) => data.detailOf(id)?.version,
  });
  /* THE SESSIONS CELL'S BIRTH VERB (user ruling 2026-08-19). Home had no
     session-start dispatcher at all, so its Sessions root offered no way to
     get one — the ＋ simply refused. Same host wiring the Work tab uses,
     including the project rule: a terminal opens where a launch would, not in
     a scratch directory nobody chose. */
  const sessionStart = useSessionStart({
    spaceId: data.spaceId,
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    projectId: data.launch.projects.find((p) => p.selectedByDefault && p.trusted)?.id ?? null,
    onOpen: (id: EntityId) => navStore.getState().openCenter(id),
    onError: (verb: ActionRef, error: unknown) => notifyActionFailed(verb, '', error),
  });

  /* The container birth sheet — same shape as `sessionStart` above, plus the
     modal obligations. See `useNewContainerSheet`. */
  const newContainer = useNewContainerSheet({
    spaceId: data.spaceId,
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onOpen: (id) => navStore.getState().openCenter(id),
    onError: (verb, error) => notifyActionFailed(verb, '', error),
  });

  /**
   * THE LIST'S DISPATCHERS, COMPOSED — the session-start verbs and
   * `chat-about`, routed by which one names the verb. Home builds the route
   * verb itself: unlike the workspace and the kind screen it already owns
   * `navStore` for its own root and thread addresses.
   */
  const chatAbout = useChatAbout({
    open: (aboutId) => navStore.getState().navigate(chatAboutTarget(aboutId)),
  });
  const listActions = composeListActions([
    { onAction: sessionStart.onAction, wiredActions: sessionStart.wiredActions },
    { onAction: chatAbout.onAction, wiredActions: chatAbout.wiredActions },
    { onAction: newContainer.onAction, wiredActions: newContainer.wiredActions },
  ]);
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
      capabilitiesOf: (id) => data.capabilitiesOf(id),
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

  /**
   * HOW A KIND IS BORN FROM THE ROOT HEADER — the cell's ＋ and every row of
   * its menu, answered by ONE function so the two cannot disagree.
   *
   * The Work tab states the rule in full (`WorkspaceView.birthFor`); the two
   * differ only in where the newborn lands, which is this screen's region B.
   */
  const birthFor = useCallback(
    (kind: string): { refusal: { cause: string; remedy: string } | null; perform: () => void } => {
      const action = rootBirthAction(kind);
      if (action) {
        /*
         * `listActions`, NOT `sessionStart` — and this was a live defect the
         * moment `container` declared `quickStart: 'new-container'`.
         *
         * `rootBirthAction(kind)` returns the kind's `list.quickStart`, so for
         * a container this dispatches `'new-container'`. `sessionStart.onAction`
         * is a switch that handles ONLY `start-terminal` and returns on its
         * `default:` — so the header's ＋ would have been drawn ENABLED (the
         * dispatcher exists) and done nothing at all. That is the exact
         * enabled-inert shape `define()`'s throwing runner and `wiredActions`
         * exist to prevent, arriving through the one path that bypasses both.
         */
        const dispatch = listActions.onAction;
        return dispatch
          ? { refusal: null, perform: () => dispatch(action, '') }
          : {
              refusal: {
                cause: `Starting ${getKind(kind).labelPlural.toLowerCase()} isn’t wired here`,
                remedy: 'this surface was mounted without a command executor',
              },
              perform: () => undefined,
            };
      }
      const target = getKind(kind);
      return {
        refusal:
          newEntity.unavailableFor(target.kind)
          ?? (target.list.quickCreate
            ? null
            : {
                cause: `${target.labelPlural} aren’t created from here`,
                remedy: 'they are made by their own flow',
              }),
        perform: () =>
          void newEntity.create({
            kind: target.kind,
            placeholderTitle: placeholderNameFor(target, placeholderTitleFor(target.label)),
          }),
      };
    },
    [newEntity, listActions.onAction],
  );
  const cellBirth = birthFor(cellConfig.kind);

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

  /* COLUMN A IS DRAGGABLE TOO (task 01a00ac2), and it is ONE width for every
     root — not one per kind. Subhang ruled that in the previous wave ("it has
     to be same width", home-page.css) because a per-tab width made the whole
     layout jump on each tab switch; making the width adjustable does not
     re-open that, it just moves who chooses the single number. Hence the flat
     `home.list` key with no kind in it. */
  const listPref = usePanelWidth('home.list', HOME_LIST_DEFAULT, HOME_LIST_MIN);
  const [railCollapsed, setRailCollapsed] = usePanelFlag('home-rail-collapsed', true);
  const focus = props.focus ?? false;

  /* What the rail and A actually occupy. Focus mode is the ruled "collapse the
     entire left panel AND the icon rail" state: both go to zero together
     behind one toggle, and B + C take the whole row. */
  const railWidth = focus ? 0 : railCollapsed ? HOME_RAIL_COLLAPSED : HOME_RAIL_EXPANDED;

  /* A's ceiling is what the row can spare once the rail, B's floor and — when
     C is open — C's floor have been paid. `outerWidth === 0` is jsdom, which
     cannot measure; the same law the overlay follows applies here, so an
     unmeasurable row imposes no ceiling rather than a fabricated one. */
  const asideReserve = drillId ? ASIDE_MIN + ASIDE_CHROME : 0;
  const listCeiling = outerWidth > 0
    ? Math.max(HOME_LIST_MIN, Math.min(HOME_LIST_MAX, outerWidth - railWidth - HOME_CENTER_MIN - HOME_LIST_CHROME - asideReserve))
    : HOME_LIST_MAX;
  /* The PREFERENCE is never rewritten by a narrow window — `usePanelWidth`'s
     own docblock is explicit that clamping on write is how a preference dies.
     This is the paint-time clamp, and widening the window restores what was
     asked for. */
  const listWidth = focus ? 0 : Math.min(Math.max(HOME_LIST_MIN, listPref.width), listCeiling);

  /* Everything left of C, at its ACTUAL width rather than a bundled guess. */
  const leftFloor = focus ? HOME_CENTER_MIN : railWidth + listWidth + HOME_LIST_CHROME + HOME_CENTER_MIN;
  const asideMax = Math.max(0, outerWidth - leftFloor - ASIDE_CHROME);
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
          /* The root header above draws the kind cell, so this panel must not
             draw a second one. The layout is the kind's registry default —
             there is no switcher on either row any more. */
          selectorSlot="host"
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
          capabilitiesOf={data.capabilitiesOf}
          onNeedDetail={(id) => data.pull?.(id)}
          selectedId={centerId}
          /* R6a: a LIST click ROOTS the centre — the trail restarts here. */
          onSelect={(id) => navStore.getState().openCenter(id as EntityId)}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onComplete={rowLifecycle.complete}
          /* Same executor, same reason as `EntityView`: this list draws the
             session row's ⏻ too, and until now nothing was behind it. */
          onTerminate={primaries.terminate}
          onResume={primaries.resume}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          onMembership={rowLifecycle.membership}
          membershipSets={rowLifecycle.membershipSets}
          connectionsOf={data.connectionsOf}
          launch={launchPort}
          onAction={listActions.onAction}
          wiredActions={listActions.wiredActions}
          compact
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, ctx, centerId, rowLifecycle, primaries, launchPort, listActions],
  );

  const regions: HomeChatRegions = {
    root,
    onRoot: setRoot,
    kindCell,
    rootKindOptions,
    selectedEntityId: centerId,
    onSelectEntity: (id) => navStore.getState().openCenter(id as EntityId),
    onShowChat: () => navStore.getState().clearStack(),
    ...(cellBirth.refusal === null ? { onNewEntity: cellBirth.perform } : {}),
    newEntityUnavailable: cellBirth.refusal,
    onCreateKind: (kind) => birthFor(kind).perform(),
    createKindUnavailable: (kind) => birthFor(kind).refusal,
    ...(centerOverride !== undefined ? { centerOverride } : {}),
    routeThreadId,
    /* The open conversation is part of the address (`/home/chat/{id}`), so
       back/forward walk threads and a conversation can be linked to. */
    onThreadSelected: (id) =>
      navStore.getState().navigate({
        view: 'home',
        root: { type: 'chats', threadId: id },
      }),
    /* The Cockpit's non-entity stages are part of the address too (`?stage=`,
       replacing `?graph=full`/`?gf=`): opening PUSHES history, so Back leaves
       the stage, a reload restores it, and a viewer can send someone the fleet
       of a conversation. */
    /* The stage PANE itself is rendered by the screen, not composed here: the
       fleet and the graph are both folds of the THREAD, and the turns live in
       the screen. This layer owns only the address. */
    /* Only while the composer is what is on screen — see the prop's docblock.
       A link that names both a thread and a subject names an intention that
       cannot be honoured, and the thread is the more specific of the two. */
    ...(routeAboutId && routeThreadId == null ? { aboutId: routeAboutId } : {}),
    stage: routeStage,
    onStageChange: (next) =>
      navStore.getState().navigate({
        view: 'home',
        root: {
          type: 'chats',
          threadId: routeThreadId,
          ...(next ? { stage: next } : {}),
        },
      }),
    renderRootList,
  };

  /* THE ICON RAIL (R4) — the switcher's twin: same groups, same select, no
     view rows. No row is active while Chats is the root; chats live in the
     list header's own cell, not the rail. */
  /* Focus mode takes the rail off the row entirely rather than collapsing it
     to its 72px icon strip — "collapsing entire left panel AND icon rail" was
     the ask, and a 72px strip left standing is not a collapse. */
  const rail = focus ? null : (
    <HomeRail
      groups={homeRailGroups()}
      activeKind={root === CHATS_ROOT ? null : root}
      onSelect={setRoot}
      collapsed={railCollapsed}
      onToggleCollapsed={() => setRailCollapsed((collapsed) => !collapsed)}
    />
  );

  /* COLUMN A'S SEPARATOR, and — when A is collapsed — the only way back.

     THE STRIP IS NEVER ABSENT, ONLY RE-ROLED. Collapsed, it is a button at
     the row's left edge carrying a chevron; open, it is the drag handle.
     Subhang ruled against the hover-reveal overlay and against keyboard-only
     restore for the same reason: a viewer who collapses the panel and does
     not know the shortcut has no way to discover one, and a control you can
     only find by sweeping the mouse at a screen edge is not discoverable
     either. Ten pixels is the rent that costs.

     DRAG CLAMPS, IT NEVER CLOSES (the ruling). `PanelResizer` already floors
     every drag at `minWidth`, so there is nothing to add for that — the point
     is what is NOT wired: no snap-shut past the floor. Collapse is only ever
     the chevron, the double-click, or Mod+\. */
  const listRail = focus ? (
    <button
      type="button"
      className="hp-listreveal"
      title="Show the list panel and the icon rail (⌘\)"
      aria-label="Show the list panel and the icon rail"
      aria-expanded={false}
      aria-controls="home-view-list"
      data-testid="hp-list-reveal"
      onClick={() => props.onToggleFocus?.()}
    >
      <span aria-hidden>›</span>
    </button>
  ) : (
    <div className="hp-listsep" data-testid="hp-list-separator">
      <PanelResizer
        side="left"
        label="List"
        controls="home-view-list"
        width={listWidth}
        minWidth={HOME_LIST_MIN}
        maxWidth={listCeiling}
        onResize={listPref.setWidth}
        /* THE DIVIDER'S DOUBLE-CLICK COLLAPSES HERE, where everywhere else in
           the kit it resets to the default width. That is Subhang's ruling
           (2026-08-16) and it is a deliberate divergence, not an oversight:
           on this divider collapse is the gesture people reach for. Reset did
           not go anywhere — `PanelResizer` binds it to Backspace/Delete on the
           focused separator as well, and that binding is untouched. */
        onReset={() => props.onToggleFocus?.()}
      />
      <button
        type="button"
        className="hp-listsep__collapse"
        title="Collapse the list panel and the icon rail (⌘\)"
        aria-label="Collapse the list panel and the icon rail"
        aria-expanded
        aria-controls="home-view-list"
        data-testid="hp-list-collapse"
        onClick={() => props.onToggleFocus?.()}
      >
        <span aria-hidden>‹</span>
      </button>
    </div>
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
      style={{
        '--hp-aside': `${asideWidth}px`,
        /* Handed to CSS rather than duplicated in it — the same rule that
           keeps the workspace's floors in `geometry.ts` and out of
           `shell.css`. `--hp-rail` replaces the 72/172 literals that used to
           live in `.hr-rail`. */
        '--hp-list': `${listWidth}px`,
        '--hp-rail': `${railWidth}px`,
      } as React.CSSProperties}
    >
      <HomePage
        data={data}
        chat={props.chat(openEntity, regions)}
        rail={rail}
        listRail={listRail}
        focus={focus}
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
      {/* THE CONTAINER BIRTH SHEET — same overlay slot and same reason as the
          launch sheet above: it overlays the region rather than entering it as
          a column, so it never touches V/cMin. Mounted only while open, so the
          draft is discarded on dismiss rather than persisting invisibly into
          the next open. */}
      {newContainer.isOpen && (
        <div className="pn-ncs-scrim" role="presentation" onClick={newContainer.close}>
          <div
            className="pn-ncs-host"
            role="dialog"
            aria-modal="true"
            aria-label="New container"
            /* The scrim dismisses; the sheet must not. Without this a click on
               any control inside bubbles up and closes the form under the
               viewer's own cursor. */
            onClick={(event) => event.stopPropagation()}
          >
            <NewContainerSheet
              spaceId={data.spaceId}
              projects={data.launch.projects
                .filter((project) => !project.scratch)
                .map((project) => ({
                  id: project.id as EntityId,
                  title: project.name,
                  trusted: project.trusted,
                }))}
              onCreate={newContainer.create}
              onCancel={newContainer.close}
            />
          </div>
        </div>
      )}
    </div>
  );
}

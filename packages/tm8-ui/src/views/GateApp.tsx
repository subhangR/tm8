/**
 * GateApp — the complete T0-1 master screen, composed (R5 THE GATE).
 *
 * Boot order matters and is deliberate: identity/spaces/menu resolve before
 * anything renders content, the rail falls back to the shipped default when the
 * seam has no menu row (which is the fixture path, so the gate exercises
 * fail-closed for real), and the workspace mounts only once a space exists.
 *
 * The three lanes keep their authority: geometry sizes, navStore owns panel
 * state and the URL, the panels own anatomy. This file is composition only.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMode, EntityId, EntitySummary, MenuViewRef, ProjectTrustLevel, SpaceId } from '@tm8/contract';
import { startFolderImport } from '../files-explorer/folder-import';
import {
  MenuRail,
  NOTICE_TTL_MS,
  NoticeHost,
  SpaceSwitcher,
  SpaceTabBar,
  groupIdOfTarget,
  isRaillessGroup,
  primaryTargetOfGroup,
  useNotices,
  type KindPresenter,
  type MenuDynamicGroup,
  type MenuTarget,
  type ShellTab,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import { registerNoticeSink } from '../terminal/notifications';
import { screenKeyOf, screenStackStore, topOf, useScreenStackStore } from '../stores/screenStackStore';
import { attachRouter, navStore, selectAutoOpenSession, useNavStore } from '../stores/navStore';
import { UNADDRESSED_HASH, createBrowserTarget, type RouterTarget } from '../routes';
import { forgetSpaceScopedPanels } from '../auth/session-reset';
import { CommandPalette, type PaletteView } from '../shell/CommandPalette';
import { CopyLinkControl } from '../share';
import { useShellKind } from '../mobile';
import { MobileShell } from './MobileShell';
import { PromptsOverlay } from '../prompts';
import { ProjectGitScreen } from '../git/ProjectGitScreen';
import { BoardScreen } from '../board';
import { createKeyboardController, type KeyboardController } from '../keyboard';
import { allKinds, KindIcon, VIEW_ART, landingOfRoute, navViewOfName, routeViewOf } from '../domain';
import type { NavView } from '../routes';
import { getKind } from '../domain';
import { buildSpawnInput, newLaunchMutationId } from '../domain/launch';
import type { DispatchSelection, LaunchSelection } from './LaunchSheet';
import type { DetailReasons } from '../panels';
import { BootLoader, VectorIcon, usePanelFlag } from '../kit';
import { CatchBoundary } from '../panels/detail/CatchBoundary';
import {
  authoredFromHollowReason,
  homeActivityLoadEarlierReason,
  presenceHollowReason,
} from '../fixtures';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';
import { useSidePanelKinds } from './useSidePanelKinds';
import { useLaunchSheet } from './useLaunchSheet';
import { useLaunchPort } from './useLaunchPort';
import { useTheme } from '../theme/useTheme';
import { AccountMenu, AuthFlow, authTokenFor, noteServerOrigin, useAuthActions } from '../auth';
import { WorkspaceView } from './WorkspaceView';
import { EntityView } from './EntityView';
import { ChatHomeSurface } from '../chat-home';
import { HomeView } from './HomeView';
import { rememberHomeRoot } from '../stores/homeRegionStore';
import { slugOfKind } from '../domain';
import { GraphScreen } from '../graph';
import { AddServerDialog, LOCAL_SERVER, type AddServerInput, type UiServer } from '../servers';
import { ChannelView } from './ChannelView';
import { SettingsShell, settingsPortFromSeam } from '../settings-space';
import { FilesExplorerScreen, filesExplorerPortFromSeam } from '../files-explorer';
import { InboxView } from './InboxView';
import { MessagesView } from './MessagesView';
import { CredentialsSection, credentialsPortFromSeam } from '../settings-credentials';
import { nodeKeyOf } from '../data/launch-cache';
import { readLastSpace, readLastTarget, writeLastTarget } from './last-place';
import {
  NewSpaceProjectDialog,
  ProjectBranchesSection,
  type ProjectBranchesPort,
  type ProjectOnboardingPort,
} from '../projects';

/**
 * §5.1's ruled side-panel defaults: left=tasks, right=sessions. These are the
 * only kind names in the shell layer; §15.2 wants them in `domain/` beside the
 * registry (the D18 precedent for SHIPPED_DEFAULT_MENU) — flagged to
 * fe-coordinator for routing rather than moved across a lane boundary here.
 */
const DEFAULT_LEFT_KIND = 'task';
/**
 * SESSIONS STAY HERE (user report 2026-08-01, third pass).
 *
 * This briefly defaulted to `channel`, to fix channels being invisible on
 * arrival after they left the rail. That traded one missing collection for
 * another: the workspace has TWO docks and three collections that want to be
 * on screen, so pointing a dock at channels took sessions off the screen, and
 * the next report was "I don't see sessions". The dock is not the place to
 * solve channel visibility — reverted rather than left to rotate the problem.
 */
const DEFAULT_RIGHT_KIND = 'work_session';
/**
 * The green ● in the rail counts running PTYs, which is a SESSION fact and
 * nothing else. It used to be spelled `ref === DEFAULT_RIGHT_KIND`, which was
 * only ever true by coincidence — the moment the right dock defaulted to
 * another kind, that kind would have inherited a live count it has no meaning
 * for. Named for what it is instead.
 */
const LIVE_COUNT_KIND = 'work_session';

/** The three-panel workspace — the handoff destination entity opens use. */
const WORKSPACE_TARGET: MenuTarget = { type: 'view', ref: 'workspace' };
/**
 * The screen a viewer with no remembered place lands on (single-home ruling,
 * 2026-08-14): the merged Home page. A viewer's OWN remembered place still
 * wins — `last-place` is consulted first — so this changes first boots and
 * fresh spaces, not anyone's established habit.
 */
const HOME_TARGET: MenuTarget = { type: 'view', ref: 'dashboard' };

/**
 * WHAT THIS FILE ACTUALLY RENDERS FOR EACH `MenuViewRef`, written down.
 *
 * THE DEFECT THIS CLOSES. The render switch below is one order-dependent
 * ternary chain, and it used to end `: data.ready ? <WorkspaceView/>`. That
 * final arm was not a match on the workspace — it was EVERYTHING LEFT OVER. A
 * target this file had no branch for did not throw, did not warn, and did not
 * say so: it silently drew the workspace under whatever the rail was
 * highlighting. That has shipped twice already (the voice-room misroute, and
 * channels falling through), and both times the symptom was "I clicked a thing
 * and got the workspace", which reads as a no-op rather than as a bug.
 *
 * WHY A TABLE AND NOT A SWITCH. `satisfies Record<MenuViewRef, …>` makes a ref
 * ADDED to the contract a compile error here until someone says which of the
 * three things it is. That is the same guard `domain/nav-targets.ts` uses, for
 * the same reason: the failure mode being designed out is a new member falling
 * through to a default, so the default has to stop existing.
 *
 *   'mounted'   — has its own branch above, which wins before the table is read
 *   'unbuilt'   — no screen in this build; the honest card SAYS SO
 *   'workspace' — the three-panel workspace, matched EXPLICITLY
 *
 * A ref NOT in this table is not a MenuViewRef at all — it came from storage
 * (`last-place.ts` validates the shape, never the ref) or from a caller that
 * invented one. It gets the unrecognised card, which is loud, not the unbuilt
 * card, which would claim we simply have not built it yet.
 */
const VIEW_REF_SCREENS = {
  dashboard: 'mounted',
  inbox: 'mounted',
  graph: 'mounted',
  files: 'mounted',
  settings: 'mounted',
  git: 'mounted',
  messages: 'mounted',
  /* The task Board (2026-08-16): the kanban screen, mounted below. */
  board: 'mounted',
  workspace: 'workspace',
  /* The last genuinely unbuilt view ref. */
  feed: 'unbuilt',
  /* NOT unbuilt — an ALIAS, and as of the router mount this row is UNREACHABLE.
     `domain/nav-targets.ts` resolves `channels` to the `channel`-kind
     EntityView, which is mounted and always has been. Phase 0.5 classified it
     `unbuilt` because that is what the chain did with it then, and left the
     resolution to "the router mount, which owns both directions" — this is that
     mount, and both directions now resolve it. `routeViewOf` turns the alias
     into `k/channels` on the way out, so it never becomes an `unroutableTarget`;
     `landingOfRoute` turns it into the kind target on the way back in, so it is
     never what `activeTarget` derives to. Nothing can reach this row.

     KEPT ANYWAY, and not as clutter: the table is `satisfies
     Record<MenuViewRef, …>`, so every ref must be classified or the file does
     not compile — which is the property that makes a NEW ref a build failure
     rather than a silent fallthrough. Deleting an unreachable row would trade
     that guarantee for tidiness. */
  channels: 'unbuilt',
} as const satisfies Record<MenuViewRef, 'mounted' | 'unbuilt' | 'workspace'>;

/** `true` when this build has no screen for the ref and should say so. */
function isUnbuiltViewRef(ref: string): boolean {
  return VIEW_REF_SCREENS[ref as MenuViewRef] === 'unbuilt';
}

/**
 * A target that reached the end of the render switch unmatched.
 *
 * LOUD IN DEV, HONEST IN PRODUCTION — the two halves of not lying about it.
 * `console.error` fires once per mount (an effect, not a render) so a test can
 * assert the shout and a developer cannot miss it; the card is what a user
 * sees, and it names the target rather than drawing a screen that was never
 * asked for.
 */
/**
 * Do these two routes name THE SAME PLACE?
 *
 * Deliberately not a deep equality. The screen→URL sync compares what it would
 * write against what the address already says, and the two are built by
 * different code paths (`parse` vs `routeViewOf`), so the fields they can
 * legitimately disagree about are exactly the ones that must NOT trigger a
 * write: `q`, which only a pasted URL ever carries, and `mode`, which
 * `routeViewOf` echoes back from the target it was handed. Comparing those too
 * would make the loop rewrite the address on arrival — dropping a viewer's
 * filter and re-asserting a collection mode nothing asked it to assert, which
 * is the ruling R22 must stay free to change.
 */
function sameDestination(a: NavView, b: NavView): boolean {
  if (a.view !== b.view) return false;
  if (a.view === 'entity' && b.view === 'entity') return a.entityId === b.entityId;
  if (a.view === 'kind' && b.view === 'kind') return a.slug === b.slug;
  return true;
}

function UnroutedTargetCard({ target }: { target: MenuTarget | null }) {
  const described = target === null ? 'null' : JSON.stringify(target);
  useEffect(() => {
    console.error(
      `GateApp: no screen for target ${described}. The render switch fell through. ` +
        'This is a routing defect — the workspace is NOT being drawn for it.',
    );
  }, [described]);
  return (
    <div className="ev-root" data-testid="unrouted-target">
      <p className="evt-empty" style={{ margin: 24 }}>
        {`This build has no screen for where you asked to go (${described}). That is a bug, not an empty screen — nothing is hidden behind this card. Pick a destination from the rail to carry on.`}
      </p>
    </div>
  );
}

export interface GateAppProps {
  activeServer?: UiServer;
  servers?: readonly UiServer[];
  onSelectServer?(id: string): void;
  onAddServer?(input: AddServerInput): Promise<unknown>;
  /** Test injection port, forwarded to `useGateData` — see `GateOptions.seam`. */
  seam?: Seam;
  /**
   * Where the router reads and writes the address, defaulting to the real one.
   *
   * A port rather than a flag, so a test drives the SAME mount the browser gets
   * — `createMemoryTarget` is a full history stack with back/forward, which is
   * the only way to assert the history discipline at all. There is deliberately
   * no way to switch the router OFF: an app that is addressable only sometimes
   * is an app whose links work only sometimes.
   */
  routerTarget?: RouterTarget;
}

/**
 * WHETHER THIS BOOT ARRIVED WITH AN ADDRESSABLE ROUTE — the R3 precedence fact,
 * written down as a fact.
 *
 * `pending` only until the router has read the address once, which happens in a
 * layout effect on the first commit.
 */
type BootRoute = 'pending' | 'addressable' | 'none';

export function GateApp(props: GateAppProps = {}) {
  // null when this GateApp is not inside an <AuthGate> — the shell tests, and
  // any host that has not mounted the gate.
  const authAccount = useAuthActions()?.account ?? null;

  // Boot hydrates the RULED defaults; the viewer's persisted choice is applied
  // after, because the persistence is scoped per (viewer, space) and the space
  // id only exists once the seam has answered. Passing a placeholder id here
  // would silently disable persistence altogether — the storage key would never
  // match the one the next session reads.
  const activeServer = props.activeServer ?? LOCAL_SERVER;
  const data = useGateData({
    leftKind: DEFAULT_LEFT_KIND,
    rightKind: DEFAULT_RIGHT_KIND,
    serverBaseUrl: activeServer.routeBaseUrl,
    // The gate's per-server pass rides on every seam request. Read per call,
    // so sign-in/out takes effect without rebuilding the seam; App keys this
    // component on the server id, so a server switch remounts with the right
    // store entry anyway.
    getAuthToken: () => authTokenFor(activeServer.id),
    ...(props.seam ? { seam: props.seam } : {}),
  });
  const kinds = useSidePanelKinds({
    viewerId: 'viewer',
    spaceId: data.spaceId,
    defaultLeft: DEFAULT_LEFT_KIND,
    defaultRight: DEFAULT_RIGHT_KIND,
  });

  // A kind chosen after boot (or restored from storage) may never have been
  // queried — hydrate it on demand rather than rendering an empty panel that
  // looks like "this kind has no rows".
  useEffect(() => {
    data.ensureKind(kinds.leftKind);
    data.ensureKind(kinds.rightKind);
  }, [data, kinds.leftKind, kinds.rightKind]);

  // A pass minted from the in-workspace sign-in must be keyed by this server's
  // ORIGIN, not the `name:<id>` fallback. Normally the registry caches the
  // origin while listing connections, but that read can itself be the thing
  // that failed — so the mapping is written here, from the server row in hand,
  // before the frame can mint anything.
  useEffect(() => {
    if (data.authRequired && activeServer.id !== LOCAL_SERVER.id) {
      noteServerOrigin(activeServer.id, activeServer.baseUrl);
    }
  }, [data.authRequired, activeServer.id, activeServer.baseUrl]);
  const notices = useNotices();

  // The terminal lives many levels down and fires notices from xterm event
  // handlers, so it reaches the queue through a registered sink rather than a
  // prop drilled through everything in between (terminal/notifications.ts).
  useEffect(() => registerNoticeSink(notices.push), [notices.push]);

  // Theme: PERSISTED, with a prefers-color-scheme default (LLD §11). It was an
  // unpersisted useState seeded to light, so every reload discarded the
  // viewer's choice. The control's home is still the account menu (D1).
  const { theme, setTheme, toggle: toggleTheme } = useTheme();
  /**
   * THE MENU RAIL STARTS COLLAPSED, and remembers what the viewer did next.
   *
   * The solver reads this as `menuCollapsedByUser` and never re-expands a rail
   * the viewer collapsed (geometry.ts §5.1 step 1) — so the default has to be a
   * PREFERENCE rather than a solved state, which is why it lives here and not
   * in the geometry module.
   *
   * Revision 11 flipped this to EXPANDED with an argument that only held while
   * COLLAPSED MEANT ICON-ONLY: a rail of unlabelled 48px glyphs is a rail you
   * have to learn, so paying 117px for legible navigation was the better deal.
   * The collapsed rail now keeps every word under its mark at 72px (owner
   * ruling, 2026-08-16), which settles that trade the other way — the whole map
   * is still readable on first paint and the screen keeps 93px.
   *
   * The viewer's persisted choice still wins; this is only where a fresh
   * profile starts.
   */
  const [menuCollapsed, setMenuCollapsed] = usePanelFlag('menu-rail-collapsed', true);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  /**
   * WHICH SCREEN IS SHOWING — now DERIVED from `navStore`, not held here.
   *
   * IT USED TO BE A `useState` IN THIS COMPONENT, and that is the single fact
   * that made the app unaddressable. The route codec, `attachRouter` and the
   * whole `NavView` grammar have existed and been tested for a long time, but
   * `navStore.view` had no readers and `navStore.navigate` had no callers: the
   * store mirrored a field nothing rendered from. Mounting the router against
   * that would have faithfully written a URL describing state no screen
   * consults — the address bar would change while the page did not.
   *
   * So the store is now the single source of truth and this is a projection of
   * it. `landingOfRoute` is total over `NavView`, so every route resolves to a
   * screen; `null` means the route named something unresolvable, which the
   * fallthrough card reports rather than silently drawing the workspace.
   *
   * `last-place` still works and is unchanged in spirit — but it is now a
   * FALLBACK consulted when nothing more authoritative said where to go, not
   * the authority itself. That distinction is what lets a shared link win.
   */
  const { shell } = useShellKind();
  const navView = useNavStore((s) => s.view);

  /**
   * A remembered target that has NO ROUTE, kept so the switch can say so.
   *
   * THE REGRESSION THIS EXISTS TO PREVENT, which was caught by
   * `render-switch-honesty.test.tsx` rather than by inspection. Deriving the
   * screen from `navStore` means a target must become a `NavView` to be
   * rendered at all — so the obvious restore path, `routeViewOf(remembered) ??
   * {view:'workspace'}`, SILENTLY SWALLOWS a target it cannot map and draws the
   * workspace. That is exactly the silent-wrong-screen failure Phase 0.5
   * removed, reintroduced one layer further back.
   *
   * `last-place` validates the SHAPE of what it reads but never the ref, so a
   * corrupt or stale record is a real source of these. It is held apart from
   * the store deliberately: `NavView` has no member for "unrecognised", and
   * inventing one would put an unroutable thing into the URL.
   */
  const [unroutableTarget, setUnroutableTarget] = useState<MenuTarget | null>(null);

  const activeTarget = useMemo<MenuTarget | null>(
    () => unroutableTarget ?? landingOfRoute(navView)?.target ?? null,
    [unroutableTarget, navView],
  );

  /**
   * EVERY user navigation goes through here, so there is no second write path
   * that can forget to remember the place.
   *
   * A target with no route (`routeViewOf` returns null) is a misroute at the
   * source and is refused rather than navigated to — see `nav-targets.ts`. It
   * is not silently swallowed: refusing here is what keeps the store's view and
   * the rendered screen from diverging.
   */
  const nodeKey = nodeKeyOf(activeServer.routeBaseUrl);
  const navigateTo = useCallback((target: MenuTarget) => {
    const view = routeViewOf(target);
    if (!view) {
      console.error('[nav] refusing a target with no route', target);
      return;
    }
    setUnroutableTarget(null);
    navStore.getState().navigate(view);
    if (data.spaceId) writeLastTarget(nodeKey, data.spaceId, target);
  }, [nodeKey, data.spaceId]);

  /**
   * Navigate to a destination expressed as a ROUTE rather than as a screen.
   *
   * Everything a viewer can click already holds a `MenuTarget`, but the
   * keyboard holds route strings, so it needs the other direction. It still
   * ends up in `navigateTo` — one user-navigation path, one place that
   * remembers your place, one `push` entry — and it inherits that function's
   * refusal for free. `null` in means the ref named nothing, which is REPORTED,
   * never defaulted: a chord that quietly went Home instead of to the screen it
   * promised would be the same silent-wrong-screen failure this lane exists to
   * remove.
   */
  const navigateToRouteView = useCallback((view: NavView | null, ref: string) => {
    const target = view ? landingOfRoute(view)?.target : null;
    if (!target) {
      console.error('[nav] no destination for keyboard ref', ref);
      return;
    }
    navigateTo(target);
  }, [navigateTo]);

  /**
   * THE ROUTER, MOUNTED. This is the line the whole lane exists for.
   *
   * `attachRouter` has been built and tested for a long time and had never had
   * a non-test caller, so the app had no URL state at all: no shareable link,
   * no reload-to-where-you-were, no back button. Everything below is wiring; it
   * writes no routing logic of its own.
   *
   * BELOW THE AUTH GATE, STRUCTURALLY. `App.tsx` renders
   * `<AuthGate><ConnectedGateApp/></AuthGate>` and `AuthGate` does not render
   * children at all while signed out, so this effect cannot run for a viewer
   * who is not in. That is what makes "login → page" need no capture-and-replay
   * mechanism: the address bar is never touched, so the destination is still
   * sitting there after sign-in. Mounted ABOVE the gate, the store→URL loop
   * would rewrite a signed-out recipient's deep link before they could sign in
   * — see `signed-out-hash.test.tsx`, which is the law, not a preference.
   *
   * PER ACTIVE SERVER, for free: `App.tsx` keys `GateApp` by `activeServer.id`,
   * so a server switch remounts this component and therefore this effect.
   *
   * A LAYOUT EFFECT, and that is the R3 precedence guarantee rather than a
   * performance choice. React runs every layout effect before any passive
   * effect of the same commit, so the address is read and hydrated before ANY
   * other effect in this tree observes the store. The alternative — a passive
   * effect declared above the restore effect — would work today and would be an
   * ORDERING ACCIDENT, which is the class of bug this lane exists to remove.
   */
  const [bootRoute, setBootRoute] = useState<BootRoute>('pending');
  /** R15's fact — see the step-up sync below, which is the only reader. */
  const coldEntry = useRef(false);
  /* The notice sink, read through a ref so remounting the router is not coupled
     to the identity of a callback that changes on every render. */
  const noticeSink = useRef(notices.push);
  noticeSink.current = notices.push;
  const routerTarget = props.routerTarget;
  /** The live transport, for the one caller that must write the address from
      outside the sync loop — see `resetAddress`. */
  const routerRef = useRef<RouterTarget | null>(null);
  useLayoutEffect(() => {
    const target = routerTarget ?? createBrowserTarget();
    routerRef.current = target;
    /* Latched from `onSpacePicker`, which `attachRouter` fires synchronously
       during its own initial read when the hash carries no addressable space.
       So this is settled by the time `attachRouter` returns. */
    let addressable = true;
    const detach = attachRouter(target, {
      lastActiveSpaceId: readLastSpace(nodeKey) as SpaceId | null,
      onNotice: (notice) => {
        noticeSink.current({
          id: `route:${notice.kind}`,
          tone: notice.kind === 'dropped' ? 'warn' : 'info',
          title: notice.kind === 'dropped' ? 'Part of that link was dropped' : 'Not built yet',
          body: notice.text,
          ttlMs: NOTICE_TTL_MS,
        });
      },
      /* "THE HASH CARRIED NO ADDRESSABLE SPACE." There is no separate space
         picker screen in this shell — `SpaceTabBar` is always mounted above the
         centre and IS the picker. So the honest response is not to render
         something; it is to record that this boot has no route, which is
         exactly what lets last-place apply below. */
      onSpacePicker: () => {
        addressable = false;
      },
    });
    setBootRoute(addressable ? 'addressable' : 'none');
    /* R15's fact, read at the only moment it is true. A depth of 1 means this
       entry IS the whole history — the viewer got here by pasting, not by
       walking — so the first step up must replace rather than push. A target
       that cannot report depth is treated as a walk, which is the safe side:
       an unnecessary push costs one back press, a wrong replace loses an entry
       nobody can get back. */
    coldEntry.current = addressable && (target.historyDepth?.() ?? 2) <= 1;
    return () => {
      routerRef.current = null;
      detach();
    };
  }, [nodeKey, routerTarget]);

  /**
   * THE ADDRESS OF A SPACE ON THE SERVER YOU JUST LEFT ADDRESSES NOTHING HERE.
   *
   * A REAL BUG THE MOUNT INTRODUCES, found while working T9's lifecycle
   * clause rather than by a test. Switching Server re-keys `GateApp`, so the
   * router detaches and a fresh one mounts and READS THE ADDRESS — which still
   * names a Space on the Server just left. That hash is addressable, so R3
   * honours it, the boot refuses to restore last-place, and the reconciliation
   * then tells the viewer "that link points at another Space" about a link
   * nobody clicked. Correct machinery, nonsense sentence.
   *
   * Space ids are not portable across Servers (`servers/server-key.ts`: named
   * Servers are same-origin relay routes, so the same hash resolves against
   * whichever Server is active). So the honest reset is to the unaddressable
   * form: this boot carried no route, and last-place applies on the new node.
   *
   * Written LAST in the switch handler so it is the final address write —
   * `leaveSpaceContext` above it schedules a debounced replace, and the
   * remount's detach cancels that timer before it can fire.
   *
   * ONLY the Server switch. Changing Space WITHIN a node keeps the address
   * meaningful and `setSpace` rewrites it correctly.
   */
  const resetAddress = useCallback(() => {
    routerRef.current?.setHash(UNADDRESSED_HASH, { replace: true });
  }, []);

  /**
   * SEED THE SCREEN STACK FROM THE ADDRESS — the landing algorithm's second
   * half, and the part that makes `e/{id}?origin=tasks` mean what §2.2 says it
   * means: "the Tasks screen, with THAT entity open".
   *
   * `landingOfRoute` returns both halves because a route names two things at
   * once; the target drives the render switch above and `openEntity` belongs to
   * `screenStackStore`, which has no `MenuTarget` representation at all.
   *
   * HYDRATING THIS STORE FROM THE ADDRESS BAR IS NOT A VIOLATION OF ITS
   * "IN-MEMORY ONLY" RULING. That ruling forbids PERSISTING the stacks — a
   * reload must not resurrect a selection out of storage — and the store's
   * header comment says so while also naming this exact route grammar as the
   * thing that would encode it properly. The address bar is not storage; it is
   * the request, and reading the request is what hydration is.
   *
   * Keyed on the view rather than done once at mount, so back/forward and a
   * pasted hash re-seed by the same path as the boot did.
   *
   * NOT THE LAST WORD ON WHAT `e/{id}` DRAWS. Ruling M1 (2026-08-14) says that
   * route means the Z4 entity FULL VIEW, and no such host exists in this tree
   * yet; `landingOfRoute`'s kind-screen-plus-seed is the shape that could be
   * built today, not the shape the frozen spec asks for. Seeding the stack is
   * right either way — an entity the address names has to be open somewhere —
   * so nothing here asserts that the kind screen is the final destination.
   *
   * IT ALSO CARRIES THE SPACE RESET, and the order inside one effect is the
   * point: a route naming a DIFFERENT space is a context switch, and the reset
   * has to happen before the seed or it would wipe the entity it just seeded.
   * Two effects would have made that an ordering accident.
   */
  const navSpaceId = useNavStore((s) => s.spaceId);
  const routedSpace = useRef<string | null>(null);
  useEffect(() => {
    /* A URL-DRIVEN SPACE CHANGE IS THE FOURTH ENTRY POINT INTO THIS RESET.
       Entity ids are space-scoped and both stores are module-level, so pasting
       a hash that names another space would otherwise restore screens holding
       entities from the space you just left — the exact failure the three
       hand-written copies of this reset were collapsed to prevent.

       ONLY the screen stacks, deliberately, and this is where the router path
       and `leaveSpaceContext` legitimately differ. `hydrate` has ALREADY
       replaced navStore's panels with the ones the route named, so clearing
       them here would delete the `?p=`/`?pin=` the link asked for — it would
       reset away the very thing being navigated to. The invariant both paths
       share is "no state from the old space survives"; navStore satisfies it by
       replacement here and by clearing there. */
    if (navSpaceId && routedSpace.current !== null && routedSpace.current !== navSpaceId) {
      screenStackStore.getState().clearAll();
    }
    if (navSpaceId) routedSpace.current = navSpaceId;

    const landing = landingOfRoute(navView);
    if (!landing?.openEntity) return;
    /* Only a kind screen can host one today: `landingOfRoute` produces an
       `openEntity` for the `entity` route alone, and that route's target is
       always a kind. Narrowed rather than assumed. */
    if (landing.target.type !== 'kind') return;
    screenStackStore.getState().open(screenKeyOf.kind(landing.target.ref), landing.openEntity);
  }, [navView, navSpaceId]);

  /**
   * THE OTHER DIRECTION: THE ENTITY A SCREEN HAS OPEN BECOMES PART OF THE
   * ADDRESS.
   *
   * Without this the mount is half a feature. `screenStackStore` holds what a
   * kind screen is showing and nothing ever put it in the URL, so drilling into
   * a task left the address saying `k/tasks`: the address bar could not be
   * copied to share what was on screen, and a reload came back to the list.
   * `routeViewOf`'s `openEntity` parameter exists for exactly this and had no
   * caller — "what makes an open entity shareable at all", in its own words.
   *
   * IT IS THE SAME LOOP AS THE SEED ABOVE, RUN BACKWARDS, so it has to be
   * idempotent or the two would push history at each other forever.
   * `sameDestination` is the fixed point: the seed reopens what the address
   * already named, this sees no change, and neither writes.
   *
   * `q` SURVIVES BY BEING LEFT ALONE. `routeViewOf` always emits `q: null`, so
   * comparing only the destination means a filtered collection keeps its filter
   * while an entity is open on top of it. Same for `mode`, deliberately: this
   * never re-asserts one, which is what keeps R22 open.
   */
  const openOnScreen = useScreenStackStore((s) =>
    activeTarget?.type === 'kind' ? topOf(s, screenKeyOf.kind(activeTarget.ref)) : null,
  );
  /**
   * R15 — A COLD ENTRY'S FIRST STEP UP IS A REPLACE, NEVER A PUSH.
   *
   * Land on a pasted `e/{id}` and there is nothing behind you: history depth is
   * 1, so the back affordance cannot mean BACK and can only mean UP. If up
   * pushed, back would return to the entity and the viewer would be trapped
   * in a two-item loop with no exit — on the EXACT entry path a shared link
   * creates, which is the one path this whole lane is for.
   *
   * Depth comes from the transport because the two cases are indistinguishable
   * from the address: arriving at `k/tasks` by pasting and by walking up from
   * an entity produce the same string and opposite meanings for `‹`.
   *
   * Spent ONCE. After the first step the viewer has a real history and every
   * later navigation is an ordinary push. Declared with the mount, which is the
   * only moment the fact is readable.
   */
  useEffect(() => {
    if (!activeTarget || activeTarget.type !== 'kind') return;
    /* READ THE STORE, NOT THE RENDERED VALUE — and this is a correctness fix,
       not a style choice. The seed effect above runs in the same pass as this
       one and opens the entity the address named; `openOnScreen` is this
       render's snapshot, so it is still null when this runs. Acting on it would
       make the mount navigate AWAY from the route it had just landed on, and —
       worse — spend R15's one-shot concession doing it, so the real step up
       later would push and trap the viewer anyway.

       `openOnScreen` stays in the deps because it is what WAKES this effect
       when the stack changes; it is never what the effect acts on. */
    const open = topOf(screenStackStore.getState(), screenKeyOf.kind(activeTarget.ref));
    const next = routeViewOf(activeTarget, open);
    if (!next || sameDestination(navView, next)) return;
    const steppingUp = navView.view === 'entity' && next.view !== 'entity';
    if (steppingUp && coldEntry.current) {
      coldEntry.current = false;
      navStore.setState((s) => ({ view: next, history: 'replace', revision: s.revision + 1 }));
      return;
    }
    navStore.getState().navigate(next);
  }, [activeTarget, openOnScreen, navView]);

  /**
   * `?session={id}` — THE OTHER HALF OF THE GRAMMAR THAT HAD NO CONSUMER.
   *
   * `selectAutoOpenSession` was written, tested and never called by anything.
   * So a link to a live session parsed cleanly, survived the round trip, and
   * landed the recipient on an EMPTY WORKSPACE — the param was carried
   * faithfully and meant nothing. Same shape as `attachRouter` itself: built,
   * correct, unreached.
   *
   * The selector already carries the §2.2 rule — it auto-opens only when `p`
   * and `pin` are both absent, so a link that names its panels explicitly wins
   * over the shorthand.
   *
   * REPLACE, NOT `push()`. The store's `push` action is for a viewer opening
   * something; this is hydration finishing the job the address asked for, and
   * it must not manufacture a back entry the viewer never created. It settles
   * in one pass: once the id is on the stack the centre is no longer empty, so
   * the selector returns null and this cannot re-fire.
   */
  const autoOpenSession = useNavStore(selectAutoOpenSession);
  useEffect(() => {
    if (!autoOpenSession) return;
    navStore.setState((s) => ({
      stack: [...s.stack.filter((id) => id !== autoOpenSession), autoOpenSession],
      history: 'replace',
      revision: s.revision + 1,
    }));
  }, [autoOpenSession]);

  /**
   * THE LINK'S SPACE OUTRANKS THE REMEMBERED SPACE.
   *
   * `useGateData` picks the boot space from `last-space`, which is right for
   * every boot that did not come from a URL and wrong for every boot that did:
   * a link into Space B opened by someone whose last space was A would render
   * A's content under B's address. The two have to be reconciled, and the
   * address wins — that is what "share a link" means.
   *
   * A link naming a Space the node does not list for this viewer is NOT an
   * error to swallow. It is said out loud and the boot demoted to `none`, which
   * re-runs the restore below and lands them where they were. Silently showing
   * them a different Space under that address is the failure this lane removes.
   */
  const spaceSettled = useRef(false);
  useEffect(() => {
    if (spaceSettled.current || bootRoute !== 'addressable') return;
    const linkSpace = navStore.getState().spaceId;
    if (!linkSpace || linkSpace === data.spaceId) {
      spaceSettled.current = true;
      return;
    }
    // Still booting: the space list is the only thing that can answer this.
    if (data.spaces.length === 0) return;
    spaceSettled.current = true;
    if (data.spaces.some((space) => space.id === linkSpace)) {
      data.selectSpace(linkSpace as SpaceId);
      return;
    }
    noticeSink.current({
      id: 'route:unknown-space',
      tone: 'warn',
      title: 'That link points at another Space',
      body: 'This node does not list that Space for you, so it could not be opened. You are where you left off.',
      ttlMs: NOTICE_TTL_MS,
    });
    setBootRoute('none');
  }, [bootRoute, data.spaces, data.spaceId, data.selectSpace]);

  // Restore once per space. Deliberately NOT paired with a persisting effect:
  // an effect watching `activeTarget` would run in the same pass as this one,
  // still holding the outgoing space's target, and overwrite the very record
  // this just read.
  const restoredSpace = useRef<string | null>(null);
  useEffect(() => {
    /* R3 — THE PRECEDENCE RULE, AND THE WHOLE POINT OF THE FEATURE.
       An addressable hash present at boot OUTRANKS last-place FOR THAT BOOT.
       This effect fires when `data.spaceId` lands ASYNCHRONOUSLY, which is
       strictly after the router has synchronously hydrated the link — so
       without this the link ARRIVES FIRST AND LOSES, and every shared link is
       discarded by a restore nobody asked for. last-place applies only when the
       address carried nothing addressable.

       `restoredSpace` is claimed for the LINK's space rather than for the space
       showing right now: the reconciliation above may still be switching to it,
       and that switch must not re-enter here and restore over the link. */
    if (bootRoute === 'pending') return;
    if (bootRoute === 'addressable') {
      restoredSpace.current = navStore.getState().spaceId;
      return;
    }
    if (!data.spaceId || restoredSpace.current === data.spaceId) return;
    restoredSpace.current = data.spaceId;
    /* The store learns the space here too. `hydrate` is the only other writer
       and it only runs for a parsed hash, so without this the store's spaceId
       stays empty on every boot that did not come from a URL — and the router
       discards URLs built with no space. */
    navStore.getState().setSpace(data.spaceId);
    const remembered = readLastTarget(nodeKey, data.spaceId) ?? HOME_TARGET;
    const view = routeViewOf(remembered);
    if (!view) {
      /* Unroutable: SAY SO rather than substituting the workspace. Storage is
         the only place these come from, and a stale record must not quietly
         put you somewhere you did not ask to be. */
      setUnroutableTarget(remembered);
      return;
    }
    setUnroutableTarget(null);
    /* `replace`, not `push`: restoring where you already were is not a
       navigation and must not leave a back-button entry. */
    navStore.setState((s) => ({ view, history: 'replace', revision: s.revision + 1 }));
    /* `bootRoute` IS A DEPENDENCY, and leaving it out was a real hole rather
       than a lint nit. The ordinary path happens to work without it, because
       this effect re-runs when `data.spaceId` lands and closes over whatever
       `bootRoute` had become by then. The DEMOTION path does not: when the link
       names a Space this node does not list, the reconciliation above flips
       `addressable` → `none` and NOTHING ELSE CHANGES — so without this the
       effect would never re-run and last-place would never restore, leaving the
       viewer on a screen the refused link chose. */
  }, [nodeKey, data.spaceId, bootRoute]);

  /**
   * LEAVING THIS (space, server) FOR ANOTHER — the one path.
   *
   * WHY IT IS ONE FUNCTION NOW. This exact four-line body was written out
   * THREE times: the space tab bar's `onSelectSpace`, the rail's
   * `onSelectServer`, and `NewSpaceProjectDialog`'s `onCreated`. Three copies
   * of an invariant is three chances for the next context switch to be added
   * with two of the four lines, and the failure it guards is silent: entity ids
   * are SPACE-SCOPED while both stores are module-level, so a missed reset
   * restores panels belonging to the space you just left. It does not throw. It
   * shows you somebody else's rows.
   *
   * The interim workspace target is part of the reset and not an afterthought:
   * the restore effect above replaces it once the new space id lands, so this
   * is what is on screen for the frames in between.
   *
   * THERE IS NOW A FOURTH ENTRY POINT AND IT DOES NOT CALL THIS FUNCTION: a
   * hash naming another Space. Not an oversight and not a fourth copy — the two
   * paths share the INVARIANT ("no state from the old Space survives") and
   * satisfy it by different mechanisms, because `hydrate` has already replaced
   * navStore's panels with the ones the route named. Calling this there would
   * reset away the very panels being navigated to, which is a worse bug than
   * the one it would be guarding. The screen-stack half is identical and is
   * done in the seeding effect above, next to the reason. Anyone adding a fifth
   * switch should call this one; anyone adding a second URL-driven one should
   * read that effect first.
   */
  const leaveSpaceContext = useCallback(() => {
    /* THE BODY MOVED, THE DISCIPLINE DID NOT. `forgetSpaceScopedPanels` is
       these three lines, verbatim, in `auth/session-reset.ts` — because SIGN-OUT
       is a fifth entry point into this same act and the natural home for its
       reset is the module that knows a session ended. This function remains the
       one path a space/server switch takes; it now shares its body with the one
       path a session end takes, which is what stops the two from drifting. */
    forgetSpaceScopedPanels();
    /* REPLACE, NOT `navigate`, AND THE MOUNT IS WHAT MAKES IT MATTER.
       This was `navigate({view:'workspace'})`, which is a PUSH. That was inert
       while nothing mirrored the store to the URL; with the router mounted it
       writes a history entry for the space you are LEAVING — `#/s/{old}/workspace`
       — because the store still holds the old space id at this instant and only
       learns the new one afterwards. Back would then land the viewer in a space
       they had left, on a screen they never visited: this is the INTERIM state
       the restore effect replaces a frame later, not a destination.

       `setSpace`'s own docblock already rules this exact case ("choosing a space
       is not a navigation WITHIN a space, and it must not leave a back-button
       entry that returns you to a space you have already left"). The reset half
       simply had not been brought under it, because until now it could not be
       observed. */
    navStore.setState((s) => ({
      view: { view: 'workspace' },
      history: 'replace',
      revision: s.revision + 1,
    }));
  }, []);
  const projectOnboardingPort = useMemo<ProjectOnboardingPort | null>(() => {
    const setup = data.seam.projectSetup;
    if (!setup) return null;
    const folderUploads = data.seam.projectFolderUploads;
    return {
      ...setup,
      createMemory: (input) => data.seam.commands.createEntity(input),
      // The dialog's Upload radio exists only when the node serves the
      // lifecycle ops; the import itself is the SAME `startFolderImport` the
      // Files explorer uses, so one folder-upload implementation serves both
      // surfaces and they cannot drift.
      ...(folderUploads
        ? {
            importFolder: (input: {
              spaceId: SpaceId;
              projectName: string;
              destinationParent: string;
              rootName: string;
              trust: ProjectTrustLevel;
              files: readonly { file: File; relativePath: string }[];
            }) => {
              const task = startFolderImport(
                {
                  folderUploads,
                  putBytes: (grant, bytes) => data.seam.files.putBytes(grant, bytes),
                  directories: (path?: string) => setup.directories(path),
                  spaceId: input.spaceId,
                  projectName: input.projectName,
                  destinationParent: input.destinationParent,
                  trust: input.trust,
                },
                [...input.files],
                input.rootName,
              );
              return {
                result: task.result.then((outcome) => outcome.project),
                cancel: task.cancel,
              };
            },
          }
        : {}),
    };
  }, [data.seam]);

  // The viewer's node-admin standing, resolved once per seam. Connecting a
  // local folder (projects.create / projects.folderUploads.*) is
  // node-admin-only on this server, so the onboarding dialog and the Files
  // explorer gate those controls up front instead of committing to a refusal.
  // `null` is unknown (read failed or in flight) and never treated as a
  // denial. Promise.resolve() so a seam whose identity read throws
  // synchronously degrades to unknown instead of taking down the shell.
  const [viewerIsNodeAdmin, setViewerIsNodeAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setViewerIsNodeAdmin(null);
    Promise.resolve()
      .then(() => data.seam.identity())
      .then((viewer) => alive && setViewerIsNodeAdmin(viewer.isNodeAdmin))
      .catch(() => alive && setViewerIsNodeAdmin(null));
    return () => {
      alive = false;
    };
  }, [data.seam]);

  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);
  const contentSurface = useNavStore((s) => s.contentSurface);
  // Hydration resolves the active-space display actor through the same
  // identity read that supplies the account face. Reuse its canonical member
  // id here: a second resolver/read would let the two surfaces disagree.
  const viewerMemberId = data.viewerActor?.id ?? null;

  // D44/D51 launch sheet. Transient client state — never the URL (§11), so a
  // shared link cannot open someone else's half-configured spawn surface.
  // Obligation 2 rides here: `hostedIds` is what clears the sheet when its
  // subject stops being hosted, by ANY route out (pop, close, promote, or a
  // hydration nobody dispatched).
  const launch = useLaunchSheet({ hostedIds: [...pinned, ...stack] });
  /* T5-5 annotation 6 (Surface Audit): a spawn refusal renders IN the sheet,
     never as a toast. The sheet therefore stays OPEN through the spawn and
     closes only on success; the refusal state lives here because the sheet
     is stateless about outcomes by design. */
  const [launchRefusal, setLaunchRefusal] = useState<{ cause: string; detail: string } | null>(null);
  // A disabled button only takes effect after React commits the next render.
  // The ref closes the smaller same-tick window too, so a double click cannot
  // open two concurrent spawn transactions for the same launch.
  const launchInFlight = useRef(false);
  const [launching, setLaunching] = useState(false);

  // D44: the sheet's Launch PERFORMS — one submit path for EVERY host of the
  // sheet (workspace centre AND the kind screens), so a refusal renders in
  // the sheet identically wherever it was opened.
  const submitLaunch = (config: LaunchSelection) => {
    if (launchInFlight.current) return;
    launchInFlight.current = true;
    setLaunching(true);
    setLaunchRefusal(null);
    void data
      .spawn(
        buildSpawnInput({
          clientMutationId: newLaunchMutationId(),
          spaceId: data.spaceId,
          config,
          // Any kind: the server derives the task anchor (064).
          taskIds: [config.subjectId],
          title: data.detailOf(config.subjectId)?.title,
        }),
      )
      .then((sessionId) => {
        launch.close();
        /* D11 (task 01a006f8): a launch submitted FROM HOME stays in Home —
           the new session takes region B and the left column flips to
           Sessions. Everywhere else keeps the workspace hand-off. */
        if (activeTarget?.type === 'view' && activeTarget.ref === 'dashboard') {
          /* Route-owned now (task 01a00932 D1): the session ROOTS the centre
             trail and the address flips to the sessions root. */
          rememberHomeRoot(data.spaceId, LIVE_COUNT_KIND);
          navStore
            .getState()
            .navigate({ view: 'home', root: { type: 'kind', slug: slugOfKind(LIVE_COUNT_KIND) ?? '' } });
          navStore.getState().openCenter(sessionId as EntityId);
        } else {
          navigateTo(WORKSPACE_TARGET);
          nav.push(sessionId);
        }
        notices.push({
          id: 'launch-done',
          tone: 'info',
          title: 'Session launched',
          body:
            activeTarget?.type === 'view' && activeTarget.ref === 'dashboard'
              ? 'The live terminal is open here in Home.'
              : 'The live terminal is open in the workspace.',
          ttlMs: 6000,
        });
      })
      .catch((error: unknown) =>
        // A refusal is a FACT about the node and it renders IN THE SHEET
        // beside the config that provoked it — the sheet stays open,
        // nothing toasts (T5-5 annotation 6).
        setLaunchRefusal({
          cause: 'Launch refused',
          detail: String((error as { message?: string })?.message ?? error),
        }),
      )
      .finally(() => {
        launchInFlight.current = false;
        setLaunching(false);
      });
  };

  /* D5: dispatch stores/delivers the subject only. The dispatcher chooses the
     teammate and memories later, so none of the sheet's launch config crosses
     this boundary and success never navigates to a terminal. */
  const submitDispatch = (request: DispatchSelection) => {
    setLaunchRefusal(null);
    void data.seam.commands
      .dispatch({
        clientMutationId: newLaunchMutationId(),
        spaceId: data.spaceId,
        subjectId: request.subjectId,
      })
      .then((result) => {
        launch.close();
        notices.push({
          id: 'dispatch-done',
          tone: result.delivery === 'delivered' ? 'info' : 'warn',
          title: result.delivery === 'delivered'
            ? 'Handed to the dispatcher'
            : 'Dispatch request stored, not delivered',
          body: result.delivery === 'delivered'
            ? `${result.dispatcherSpawned ? 'Spawned the dispatcher and sent' : 'Sent'} the request. It picks the teammate and the memories, then replies on the task.`
            : 'The dispatcher session did not receive it. The request is stored on the task and is not lost, but nothing is running yet.',
          ttlMs: 8000,
        });
      })
      .catch((error: unknown) =>
        setLaunchRefusal({
          cause: 'Dispatch refused',
          detail: String((error as { message?: string })?.message ?? error),
        }),
      );
  };

  /*
   * Read memories only when a launch is actually being configured (D3a).
   *
   * NOT AT BOOT: the sheet is the one surface that offers them, and hydrating a
   * whole kind on every boot for a picker most launches never open is a query
   * bought for nobody. `ensureKind` guards on its own cache, so re-opening the
   * sheet costs nothing.
   *
   * Until it lands `data.launch.memories` is undefined, and the sheet draws
   * that as UNKNOWN rather than as an empty space — the two are different
   * facts and only one of them is a measurement.
   */
  useEffect(() => {
    if (launch.subjectId) data.ensureKind('memory');
  }, [launch.subjectId, data]);

  /* GraphScreen takes its launch sources as a PROP (its data port is
     deliberately narrow), so the shell builds them here — from the same hook
     every other screen uses, so its Run config cannot be the one that shows
     an empty teammate list. */
  const graphLaunchPort = useLaunchPort(data, {
    onSpawn: async (input) => {
      const sessionId = await data.spawn(input);
      navigateTo(WORKSPACE_TARGET);
      nav.push(sessionId);
    },
  });

  // Bind A1a's store to my narrow port. This is the adapter nav-port.ts exists
  // for: shell drives a small, explicit surface rather than the whole store.
  const nav = useMemo<NavPort>(() => {
    const actions = navStore.getState();
    return {
      stack,
      pinned,
      push: (id) => actions.push(id),
      pop: () => actions.pop(),
      close: (id) => actions.close(id),
      pin: (id) => actions.pin(id),
      unpin: (id) => actions.unpin(id),
      /**
       * PROMOTE IS REFUSED WHILE Z4 HAS NO HOST, AND REFUSING IS THE FIX.
       *
       * `navStore.promote` clears the id from stack AND pins and sets
       * `{view:'entity', entityId, origin:null}` — from the workspace there is
       * no `origin` to carry. So the panel was destroyed and the screen was
       * replaced by the unrecognised card, in one click, with no way back to
       * either. It is a real regression on this branch: the write is old, but
       * making `navStore` authoritative (68dc93fd) made it visible, and no test
       * covered it.
       *
       * Doing the state change and drawing an honest card instead would still
       * destroy the panel, so the guard has to be here, before the store. Said
       * out loud rather than swallowed: a control that silently does nothing is
       * the failure mode this codebase keeps removing. It comes back the moment
       * the M1 host exists, and nothing here presumes what that host looks like.
       */
      promote: (_id) => {
        noticeSink.current({
          id: 'z4-unbuilt',
          tone: 'warn',
          title: 'Full view isn’t built yet',
          body: 'The panel stays where it is. Opening an entity on its own screen is coming; nothing was lost.',
          ttlMs: NOTICE_TTL_MS,
        });
      },
      applyNormalization: (next) => actions.applyNormalization(next),
      surfaceOf: (id) => contentSurface[id] ?? null,
      setContentSurface: (id, surface) => actions.setContentSurface(id, surface),
    };
  }, [stack, pinned, contentSurface]);

  /**
   * GAP #0 (Surface Audit final): the palette and the C6 controller were
   * NEVER MOUNTED while the UI's own copy taught "/ opens the palette" —
   * a plain promise in visible copy, silently broken. This mounts the REAL
   * controller (keyboard/controller.ts, chords guaranteed:true) as the one
   * window keydown route; the old hand-rolled ⌘\ listener retired into it.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const keyboardRef = useRef<KeyboardController | null>(null);
  /**
   * THE SINK TAKES THE REF, AND THAT ONE ARGUMENT IS THE WHOLE BUG.
   *
   * `keyboard/contract.ts` declares nine `g` chords `guaranteed: true`
   * (`g.home` … `g.settings`), and `controller.ts` has ALWAYS passed
   * `binding.ref` as `onCommand`'s second argument. This sink was typed
   * `(command) => void` and the controller was constructed with
   * `onCommand: (command) => commandSink.current(command)`, so the ref was
   * dropped at the boundary. Every one of the nine chords fired a `nav.view` or
   * `nav.kind` command carrying a destination that nothing could receive, and
   * none of them has ever worked.
   */
  const commandSink = useRef<(command: string, ref?: string) => void>(() => undefined);
  if (keyboardRef.current === null) {
    keyboardRef.current = createKeyboardController({
      onCommand: (command, ref) => commandSink.current(command, ref),
    });
  }
  commandSink.current = (command: string, ref?: string) => {
    if (command === 'palette.open') setPaletteOpen(true);
    if (command === 'menu.toggle') setMenuCollapsed((collapsed) => !collapsed);
    /* THROUGH THE ROUTE VOCABULARY, NEVER BY HAND-ASSEMBLING A `MenuTarget`.
       A chord's ref is a route view name or a kind SLUG — see `navViewOfName`
       for the two mismatches that make the obvious spelling wrong. */
    if (command === 'nav.view' && ref) navigateToRouteView(navViewOfName(ref), ref);
    if (command === 'nav.kind' && ref) {
      navigateToRouteView({ view: 'kind', slug: ref, mode: null, q: null }, ref);
    }
  };
  useEffect(() => {
    const kb = keyboardRef.current;
    if (!kb) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const textEntry =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      kb.setContext({
        textEntry,
        modalDepth:
          paletteOpen || promptsOpen || (launch.isModalOpen?.() ?? false) ? 1 : 0,
      });
      // Legacy ⌘\ stays honored even if the binding table names it
      // differently — losing a shipped shortcut would be its own regression.
      if (event.key === '\\' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setMenuCollapsed((collapsed) => !collapsed);
        return;
      }
      const result = kb.handle({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (result.handled && result.consumed) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, promptsOpen, launch]);

  /**
   * Kind refs resolve through the DOMAIN REGISTRY (§15.2) — shell never maps a
   * kind itself. `getKind` falls back to the `c:*` row on a miss, so the
   * identity check is what makes an unknown ref unrenderable rather than
   * silently generic (A1a's landing note).
   */
  const presentKind = useCallback<KindPresenter>((ref) => {
    const row = getKind(ref);
    if (row.kind !== ref) return null;
    // `live` stays SESSIONS-ONLY and keeps its meaning: the green dot is the
    // count of PTYs actually running, from the liveness snapshot. It is not a
    // count of rows, and no other kind has an equivalent, so no other kind
    // gets one.
    const live = ref === LIVE_COUNT_KIND ? data.liveIds.length : undefined;
    // The rail's own numbers, from `spaces.counts`. Absent (a node that cannot
    // serve them, or a not-yet-completed first read) means NO number — never a
    // fabricated zero, which would assert the space is empty.
    const counts = data.countsFor(ref);
    return {
      label: row.labelPlural,
      icon: <KindIcon kind={ref} />,
      live,
      ...(counts ? { badge: counts.total, unseen: counts.unseen } : {}),
    };
  }, [data.liveIds.length, data.countsFor]);

  // Channels left the rail entirely (user ruling 2026-08-01): they are
  // entities, so they live in the Entity List Panel with every other
  // collection — `channel` is `strategy: 'collection'` in the registry now and
  // the panel's kind switcher offers it with no wiring here. What remains is
  // the CHANNEL ROUTE: `#/s/{space}/channels` (and the palette row that opens
  // it) still resolve to the space's first channel and its full-screen
  // ChannelView, so a deep link and a bookmark keep working.
  const channelEntities = data.rowsFor('channel')(undefined);

  /**
   * PR188 review F1: the UI half of the chat composition. The server got its
   * composition commit (compose.ts); without this bridge the shipped home
   * rendered a disabled composer blaming the node for operations it serves.
   * Amendment 10 seam calls: `home` (thread list) + `startChatThread`.
   */
  const chatBridge = useMemo(() => ({
    listThreads: async (sid: string) => (await data.seam.home(sid)).chatThreads ?? [],
    configureThread: async (input: {
      rootMessageId: string; teammateId: string; model: string;
      mode: ChatMode; clientMutationId: string;
    }) => {
      const result = await data.seam.commands.startChatThread(input);
      return {
        threadRootId: result.thread.rootMessageId,
        teammateId: result.thread.teammateId,
        model: result.thread.model,
        mode: result.thread.mode,
      };
    },
  }), [data.seam]);

  const homeSlots = useMemo(
    () =>
      data.launch.capacity
        ? {
            used: data.launch.capacity.slotsTotal - data.launch.capacity.slotsFree,
            total: data.launch.capacity.slotsTotal,
          }
        : undefined,
    [data.launch.capacity],
  );

  // The same grammar for VOICE: "Voice" is a label, the space's voice_channel
  // entities are the rows. The glyph comes from the REGISTRY row (as
  // `presentKind` does above) rather than being authored here — a second
  // authored glyph beside the registry's would drift the moment either moves.
  const voiceKind = getKind('voice_channel');
  const voiceEntities = data.rowsFor(voiceKind.kind)(undefined);
  const voiceGroup = useMemo<MenuDynamicGroup>(() => ({
    /* Revision 11: live rooms hang beneath the CHATS group's authored rows
       (Channels · Messages) instead of replacing a dedicated Voice group —
       appended, so the authored conversation rows stay. No emptyLabel: a
       space with no live rooms shows the two rows and nothing else, rather
       than a line promising rooms it does not have. */
    replaceConfiguredItems: false,
    items: voiceEntities.map((entity) => {
      const state = entity.state as unknown as { participantCount?: number };
      return {
        id: entity.id,
        kind: entity.kind,
        parentId: entity.parentId,
        label: entity.title,
        icon: <KindIcon kind={entity.kind} />,
        // `live` renders the green ● n treatment. An EMPTY room gets no badge:
        // "● 0" would present nobody-is-here as a presence signal.
        ...(state.participantCount ? { live: state.participantCount } : {}),
      };
    }),
  }), [voiceEntities]);

  // The settings screen's one seam adapter (settings-space/port.ts). Memoized
  // on the same (seam, space) pair the shell booted with; null until a space
  // exists, which is also when the Settings rail row can first be clicked.
  // The Files explorer's one seam adapter (files-explorer/port.ts) — the same
  // host-wires-the-seam rule as settings below; null until a space exists.
  const filesExplorerPort = useMemo(
    () => (data.spaceId ? filesExplorerPortFromSeam(data.seam, data.spaceId, viewerIsNodeAdmin) : null),
    [data.seam, data.spaceId, viewerIsNodeAdmin],
  );

  const settingsPort = useMemo(
    () => (data.spaceId ? settingsPortFromSeam(data.seam, data.spaceId) : null),
    [data.seam, data.spaceId],
  );

  // The credentials section's own adapter, built the same way and on the same
  // pair. It is a SECOND port rather than four more methods on the settings
  // one because `settings-credentials/` is a separate module meeting the shell
  // at its `sections` slot — the seam that lets two lanes mount into one screen
  // without editing each other's files.
  const credentialsPort = useMemo(
    () => (data.spaceId ? credentialsPortFromSeam(data.seam, data.spaceId) : null),
    [data.seam, data.spaceId],
  );

  // The branch-topology section for the shell's externally-owned `projects`
  // slot (seam Amendment 5). The spaceId is closed over HERE so the section's
  // port stays two reads and nothing else — the same host-wires-the-seam rule
  // the settings port follows.
  const branchesPort = useMemo<ProjectBranchesPort | null>(
    () =>
      data.spaceId
        ? {
            projects: () => data.seam.projects(data.spaceId!),
            branches: (projectId) => data.seam.projectBranches(projectId),
          }
         : null,
    [data.seam, data.spaceId],
  );

  const reasons = useMemo<DetailReasons>(
    () => ({
      presenceHollow: presenceHollowReason,
      versionHistory: 'Version history isn’t available yet.',
      provenanceHollow: authoredFromHollowReason,
      shareUnavailable: 'Sharing into a session isn’t available yet.',
      withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
    }),
    [],
  );
  void homeActivityLoadEarlierReason; // D7.1 — consumed by HomeView at fan-out.

  /* Palette data. Results search WHAT THE APP HAS READ (the hydrated kind
     caches) — honest scope for the fixture path; a seam-side text search is
     the upgrade path and this stays correct when it lands. */
  const paletteResults = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: EntitySummary[] = [];
    for (const row of allKinds()) {
      for (const item of data.rowsFor(row.kind)(undefined)) {
        if (seen.has(item.id)) continue;
        if (item.title.toLowerCase().includes(q)) {
          seen.add(item.id);
          out.push(item);
          if (out.length >= 12) return out;
        }
      }
    }
    return out;
  }, [paletteQuery, data]);

  const paletteViews = useMemo<PaletteView[]>(
    () => [
      /* Revision 11: Home leads — it is the landing screen, and the palette
         should offer the way back to it from anywhere. */
      { id: 'view:dashboard', label: 'Home', glyph: <VectorIcon paths={VIEW_ART.dashboard} /> },
      { id: 'view:workspace', label: 'Workspace', glyph: <VectorIcon paths={VIEW_ART.workspace} /> },
      { id: 'view:graph', label: 'Graph', glyph: <VectorIcon paths={VIEW_ART.graph} /> },
      { id: 'view:channels', label: 'Channels', glyph: <VectorIcon paths={VIEW_ART.channels} /> },
      // Both rows are now MOUNTED views, so the palette offers them as live
      // destinations. A palette row for a ref that falls through to the
      // unbuilt-view card would be discovery pointing at a placeholder.
      { id: 'view:messages', label: 'Messages', glyph: <VectorIcon paths={VIEW_ART.messages} /> },
      { id: 'view:inbox', label: 'Inbox', glyph: <VectorIcon paths={VIEW_ART.inbox} /> },
      ...allKinds()
        .filter((row) => !row.kind.startsWith('c:'))
        .map((row) => ({ id: `kind:${row.kind}`, label: row.labelPlural, glyph: <KindIcon kind={row.kind} /> })),
    ],
    [],
  );
  const openPaletteView = useCallback((id: string) => {
    const [scope, ref] = id.split(':', 2) as [string, string];
    if (scope === 'view' && ref === 'channels' && channelEntities[0]) {
      navigateTo({ type: 'entity', ref: channelEntities[0].id, kind: channelEntities[0].kind });
    } else if (scope === 'view') {
      navigateTo({ type: 'view', ref: ref as never });
    }
    if (scope === 'kind') navigateTo({ type: 'kind', ref });
    setPaletteOpen(false);
  }, [channelEntities, navigateTo]);

  /*
   * THE FIVE-TAB ROW (ruling R2, 2026-08-15): the resolved menu's GROUPS are
   * the top-level tabs — home | work | graph | channels | files | settings in
   * the shipped default — and the rail below renders only the ACTIVE group's
   * contents. Data-driven throughout: a legacy hand-edited menu (the seeder
   * only upgrades byte-matching defaults) simply shows ITS groups as tabs.
   */
  const shellTabs = useMemo<ShellTab[]>(
    () => data.menu.config.groups.map((group) => ({ id: group.id, label: group.label })),
    [data.menu.config],
  );
  /* Voice rooms are DYNAMIC rows with no menu item to match, so the group
     that hosts them (channels; `chats` in pre-125 menus) claims their entity
     targets here. */
  const conversationGroupId = useMemo(
    () => data.menu.config.groups.find((g) => g.id === 'channels' || g.id === 'chats')?.id ?? null,
    [data.menu.config],
  );
  const activeGroupId = useMemo(() => {
    const direct = groupIdOfTarget(data.menu.config, activeTarget ?? null);
    if (direct) return direct;
    if (activeTarget?.type === 'entity' && voiceEntities.some((e) => e.id === activeTarget.ref)) {
      return conversationGroupId;
    }
    /* No group claims the target (e.g. Inbox, whose door is the bell): no
       tab reads current, and no rail pretends to contain it. */
    return null;
  }, [data.menu.config, activeTarget, voiceEntities, conversationGroupId]);
  const activeGroup = data.menu.config.groups.find((g) => g.id === activeGroupId) ?? null;
  /* The rail is the active tab's contents. A group that IS its own one screen
     (Graph, Settings, Files — single childless view item) draws no rail. */
  const railConfig = useMemo(
    () =>
      activeGroup && !isRaillessGroup(activeGroup)
        ? { ...data.menu.config, groups: [activeGroup] }
        : null,
    [data.menu.config, activeGroup],
  );
  const openTab = useCallback(
    (id: string) => {
      const group = data.menu.config.groups.find((g) => g.id === id);
      const target = group ? primaryTargetOfGroup(group) : null;
      if (target) navigateTo(target);
    },
    [data.menu.config, navigateTo],
  );

  /*
   * THE SHELL FORK. Chosen by pointer type and width, never by user agent —
   * `mobile/shell-for.ts` owns that predicate and is unit-tested away from the
   * DOM.
   *
   * It forks HERE, above the chrome and BELOW everything that decides where you
   * are. `navStore`, the codec and the browser history are already settled by
   * this point and are shared by both branches, which is the whole of "the
   * shell forks and the router does not": a link resolves to the same
   * `activeTarget` on a phone as on a desktop, and only the arrangement differs.
   *
   * Placed after the router mount effect deliberately — a fork above it would
   * give the two shells two mounts, and two mounts are two histories.
   */
  if (shell === 'mobile' && data.spaceId) {
    return (
      <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
        <MobileShell
          data={data}
          spaceId={data.spaceId}
          activeTarget={activeTarget}
          navigateTo={navigateTo}
          openEntity={openOnScreen}
          serverBaseUrl={activeServer.routeBaseUrl}
          reasons={reasons}
          onNotice={notices.push}
          nodeKey={nodeKey}
          {...(viewerMemberId ? { viewerMemberId } : {})}
          {...(channelEntities[0]?.id ? { chatAnchorId: channelEntities[0].id } : {})}
          {...(data.spaces.find((sp) => sp.id === data.spaceId)?.name
            ? { spaceLabel: data.spaces.find((sp) => sp.id === data.spaceId)?.name }
            : {})}
          notices={<NoticeHost notices={notices.notices} onDismiss={notices.dismiss} />}
        />
      </div>
    );
  }

  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="shell-root">
        <SpaceTabBar
          /* R1 (2026-08-15): the identity block lives in the TOP ROW now.
             Still ONE control — the single-home rule holds, only the address
             changed; the old read-only server label is not restored. The
             invariant on onSelectServer (privacy-lane agreement, 2026-08-15):
             leaveSpaceContext THEN resetAddress, together, in this order,
             wherever this control lives. */
          switcherSlot={
            <SpaceSwitcher
              servers={props.servers ?? [activeServer]}
              activeServerId={activeServer.id}
              spaces={data.spaces}
              activeSpaceId={(data.spaceId as SpaceId) || null}
              collapsed={false}
              onSelectServer={(id) => {
                leaveSpaceContext();
                resetAddress();
                props.onSelectServer?.(id);
              }}
              onSelectSpace={(id) => {
                leaveSpaceContext();
                data.selectSpace(id);
              }}
              onAddServer={props.onAddServer ? () => setAddServerOpen(true) : undefined}
              onAddSpace={projectOnboardingPort ? () => setNewSpaceOpen(true) : undefined}
            />
          }
          /* R2: the menu's groups, as tabs. */
          tabs={shellTabs}
          activeTabId={activeGroupId}
          onSelectTab={openTab}
          /* Revision 13: no group owns `dashboard`, so no tab leads back to
             the conversation surface — the MARK does. Not an extra door: the
             tab it replaces was retired in the same change. */
          onGoHome={() => navigateTo(HOME_TARGET)}
          onOpenInbox={() => navigateTo({ type: 'view', ref: 'inbox' })}
          accountInitial="A"
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenPrompts={() => setPromptsOpen(true)}
          // D1: theme's one home is the account menu. No tab-bar toggle.
          onOpenAccount={toggleTheme}
          // T3-3, user-ordered 2026-07-29: the real account menu — signed-in
          // name, theme, sign-out — replaces the avatar ONCE THERE IS AN
          // ACCOUNT. Undefined otherwise, so a GateApp rendered without an
          // AuthGate (every existing test) keeps the avatar fallback and its
          // behaviour is unchanged.
          /* COPY LINK — the affordance that makes the routing usable by a
             person. The app has been addressable since the router mounted and
             offered its address to nobody; this is where a viewer gets it.

             It names WHAT IS ON SCREEN: the active target, plus the entity open
             on that screen if there is one, so a link to a task you are reading
             reopens that task rather than the list it came from. `openOnScreen`
             already existed for the reverse direction (drill in, address
             updates) and is the same fact read the other way.

             Rendered only with a Space, because a link with no Space addresses
             nothing — `copyLinkUrl` would return null and the control would be
             a button that cannot perform, which is the shape this codebase
             refuses everywhere else. */
          shareSlot={
            data.spaceId ? (
              <CopyLinkControl
                spaceId={data.spaceId}
                target={activeTarget ?? WORKSPACE_TARGET}
                openEntity={openOnScreen}
              />
            ) : undefined
          }
          accountSlot={
            authAccount && data.viewerActor ? (
              <AccountMenu actor={data.viewerActor} theme={theme} onThemeChange={setTheme} />
            ) : undefined
          }
        />

        <div className="shell-body">
          {/* R2: the rail is the ACTIVE TAB's contents — one group, no
              group-spine listing. Null when the active group is its own one
              screen (Graph / Settings / Files) or nothing claims the target.
              The identity block left the rail head for the top row (R1). */}
          {railConfig ? (
            <MenuRail
              config={railConfig}
              collapsed={menuCollapsed}
              onToggle={() => setMenuCollapsed((c) => !c)}
              activeTarget={activeTarget}
              onNavigate={navigateTo}
              presentKind={presentKind}
              /* Live voice rooms hang beneath the conversation cluster —
                 `channels` since 125, `chats` in pre-125 hand-edited menus. */
              dynamicGroups={{ channels: voiceGroup, chats: voiceGroup }}
            />
          ) : null}

          {/* The REAL error boundary wraps the whole view region: a crashed
              screen renders the designed error state with retry; the rail and
              tab bar above stay live for navigating away. */}
          <CatchBoundary label="view">
          {data.ready &&
            activeTarget?.type === 'entity' &&
            activeTarget.kind === voiceKind.kind ? (
            /* THE MISROUTE FIX. The branch below tested only `type === 'entity'`
               with NO kind check, so EVERY entity target rendered ChannelView —
               a voice rail row would have opened a message feed against a room
               that has none, and the feed would have looked empty rather than
               wrong. Guarded here, above it, because the rail now emits voice
               entity targets.

               The room UI itself is being built separately; until it lands this
               SAYS SO, in the same idiom as `unbuilt-view` below. An honest
               placeholder is the correct state — silently borrowing another
               kind's screen is the failure class this replaces. */
            <div className="ev-root" data-testid="unbuilt-voice-view">
              <p className="evt-empty" style={{ margin: 24 }}>
                {'Voice room — not built yet. This channel exists, but its room UI does not exist in this build; nothing is hidden here.'}
              </p>
            </div>
          ) : data.ready && activeTarget?.type === 'entity' ? (
            <ChannelView
              data={data}
              channelId={activeTarget.ref as EntityId}
              serverBaseUrl={activeServer.routeBaseUrl}
              reasons={reasons}
              onNotice={notices.push}
              /* The same verb every other screen commits, so the panel beside
                 the feed launches for real instead of refusing. */
              onSpawn={async (input) => {
                const sessionId = await data.spawn(input);
                navigateTo(WORKSPACE_TARGET);
                nav.push(sessionId);
              }}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'graph' ? (
            /* ◉ Graph follows the D65 pattern exactly:
               an activated menu view replaces the centre WHOLESALE — full
               width, no side lists; node C1 clicks open the Z3 aside inside
               the screen. Its initial lens comes from graph.query; durable
               entity/edge events keep the projected nodes current. */
            <GraphScreen
              data={data}
              serverBaseUrl={activeServer.routeBaseUrl}
              reasons={reasons}
              nodes={data.graph.nodes}
              edges={data.graph.edges}
              now={data.graph.now}
              loading={data.graph.loading}
              error={data.graph.error}
              onRetry={data.graph.refresh}
              window={data.graph.window}
              onChooseWindow={data.graph.setWindow}
              atCeiling={data.graph.atCeiling}
              nodeLimit={data.graph.limit}
              launch={graphLaunchPort}
              onNotice={notices.push}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'git' ? (
            /* ⎇ Git (Git UI wave) — git elevated out of Settings: branch
               topology per project, live worktree lanes with owning-session
               click-through, and the contention map. Lane click-through
               lands in the workspace with the session panel pushed, the
               same handoff the spawn path performs. */
            <ProjectGitScreen
              seam={data.seam}
              spaceId={data.spaceId as SpaceId}
              onOpenEntity={(id) => {
                navigateTo(WORKSPACE_TARGET);
                nav.push(id as EntityId);
              }}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'messages' ? (
            /* ✉ Messages — one browser over every conversation in the space,
               whatever entity it is anchored on. Follows the D65 posture the
               Graph, Files and Git rows established: an activated menu view
               replaces the centre WHOLESALE, no side lists.

               The cross-entity reading is the SERVER's, not this screen's:
               `entities.feed` resolves the right scope per anchor kind, so
               selecting a task and selecting a session run the same call. */
            <MessagesView
              seam={data.seam}
              spaceId={data.spaceId as SpaceId}
              onOpenEntity={(id) => {
                /* A lens, not a terminus — leaving a conversation for the
                   entity it lives on lands in the workspace with the panel
                   pushed, the same handoff Git's lane click-through performs. */
                navigateTo(WORKSPACE_TARGET);
                nav.push(id as EntityId);
              }}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'board' ? (
            /* ▦ Board (Board tab wave) — the task kanban as its own tab, the
               D65 posture again: full width, no side lists, the columns ARE
               the navigation. A card is a door — opening one performs the
               same workspace handoff Git's lane click-through does. */
            <BoardScreen
              data={data}
              viewerMemberId={viewerMemberId}
              onNotice={notices.push}
              onOpenEntity={(id) => {
                navigateTo(WORKSPACE_TARGET);
                nav.push(id as EntityId);
              }}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'inbox' ? (
            /* ◹ Inbox — the finished screen that was never mounted. Nothing
               was built for this branch; `src/inbox/` has been complete and
               unreferenced, and `GateApp` drew the unbuilt-view card over it.
               See `views/InboxView.tsx` for the full account. */
            <InboxView
              seam={data.seam}
              onOpenEntity={(id) => {
                navigateTo(WORKSPACE_TARGET);
                nav.push(id as EntityId);
              }}
            />
          ) : data.ready && activeTarget?.type === 'kind' ? (
            /* D65: a rail KIND row opens its EntityView — wide list, Z3 aside
               on row click, Z4 full on promote. The workspace stays the one
               three-panel exception below. CHANNELS is a contract VIEW ref
               but IS the channel EntityView (Surface Audit: it fell through
               to the workspace silently — the misroute-honesty class). */
            <EntityView
              data={data}
              viewerMemberId={viewerMemberId}
              serverBaseUrl={activeServer.routeBaseUrl}
              kind={activeTarget.ref}
              reasons={reasons}
              onNotice={notices.push}
              onKindChange={(next) => navigateTo({ type: 'kind', ref: next })}
              /* §1.1 — the shell HOLDS the layout mode, so the switcher's
                 choice survives re-renders of this ternary and a kind switch
                 resets it honestly (a new target has no mode yet). It rides on
                 the target, so remembering the target remembers the layout. */
              {...(activeTarget.mode !== undefined ? { mode: activeTarget.mode } : {})}
              onMode={(m) => {
                if (activeTarget.type !== 'kind') return;
                navigateTo({ ...activeTarget, mode: m });
              }}
              /* W3 — the board's grouping rides the target exactly as `mode`
                 does, so a grouped board survives reload and its URL is the
                 board someone else opens. */
              {...(activeTarget.groupBy !== undefined ? { groupBy: activeTarget.groupBy } : {})}
              onGroupBy={(g) => {
                if (activeTarget.type !== 'kind') return;
                navigateTo({ ...activeTarget, groupBy: g });
              }}
              /* The same verb the workspace's tiles commit. Passing it is what
                 makes the tile's `Launch ▸` a live control here instead of a
                 disabled-with-reason one; the sources behind it come from
                 `useLaunchPort` inside the view. */
              onSpawn={async (input) => {
                const sessionId = await data.spawn(input);
                navigateTo(WORKSPACE_TARGET);
                nav.push(sessionId);
              }}
              /* The full sheet on the kind screen too — Run on a task tile
                 goes straight here (user report 2026-08-09: tasks are
                 launched FROM this screen, and the sheet only existing in
                 the workspace made "full options" permanently disabled
                 exactly where launching happens). */
              onLaunchOpen={(id) => launch.open(id)}
              launchSubjectId={launch.subjectId}
              launchRefusal={launchRefusal}
              launchInFlight={launching}
              onLaunchCancel={() => {
                setLaunchRefusal(null);
                launch.close();
              }}
              onLaunchSubmit={submitLaunch}
              onLaunchDispatch={submitDispatch}
            />
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            activeTarget.ref === 'files' &&
            filesExplorerPort ? (
            /* ▤ File browser (Library group) — the dedicated Files explorer.
               A VIEW ref, deliberately distinct from the `file` KIND row in
               the same group (owner ruling R9: entity files and the file
               browser are both first-class destinations). */
            <FilesExplorerScreen
              port={filesExplorerPort}
              onNotice={(text) =>
                notices.push({
                  id: `fx:${Date.now()}`,
                  tone: 'info',
                  title: 'Files',
                  body: text,
                  ttlMs: 6000,
                })
              }
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'dashboard' ? (
            /* THE MERGED SINGLE HOME (task 01a0027d, 2026-08-14): the chat
               surface stays the hero — solo, thread sidebar hidden — with the
               NEEDS YOU strip, the glance rails and the presence row beneath.
               The existing dashboard route stays stable while its centre is
               replaced wholesale (the same D65 posture as every view swap). */
            <HomeView
              /* GateData satisfies HomeScreenData structurally — the same
                 narrow port src/home was built against. */
              data={data}
              reasons={reasons}
              serverBaseUrl={activeServer.routeBaseUrl}
              viewerMemberId={viewerMemberId}
              onNotice={notices.push}
              onSpawn={async (input) => {
                /* D11: a spawn committed on Home STAYS on Home — the session
                   takes region B and the column flips to the sessions root. */
                const sessionId = await data.spawn(input);
                /* Route-owned now (task 01a00932 D1). */
                rememberHomeRoot(data.spaceId, LIVE_COUNT_KIND);
                navStore
                  .getState()
                  .navigate({ view: 'home', root: { type: 'kind', slug: slugOfKind(LIVE_COUNT_KIND) ?? '' } });
                navStore.getState().openCenter(sessionId as EntityId);
              }}
              onOpenWorkspace={() => navigateTo(WORKSPACE_TARGET)}
              /* D12: the ONE route out of Home — region C's explicit header
                 action. Chips never navigate; this button does. */
              onOpenInWorkspace={(id) => {
                navigateTo(WORKSPACE_TARGET);
                nav.push(id);
              }}
              /* D11/D14: the launch-sheet singleton, mounted over Home while
                 it holds a subject — Run on a task row opens it here. */
              onLaunchOpen={(id) => launch.open(id)}
              launchSubjectId={launch.subjectId}
              launchRefusal={launchRefusal}
              launchInFlight={launching}
              onLaunchCancel={() => {
                setLaunchRefusal(null);
                launch.close();
              }}
              onLaunchSubmit={submitLaunch}
              onLaunchDispatch={submitDispatch}
              chat={(openEntity, regions) => (
                <ChatHomeSurface
                  seam={data.seam}
                  spaceId={data.spaceId}
                  nodeKey={nodeKey}
                  bridge={chatBridge}
                  /* PR188 review F3: the space id is NOT an entity and
                     messages.post 404s on it (measured). Bare-home chats anchor
                     to the seeded default channel; the per-user home thread is
                     the ruled follow-up (R1) and needs a server seam first. */
                  anchorId={channelEntities[0]?.id}
                  /* One read per space, shared with every other rich input in
                     the shell — see `useGateData`. */
                  skillOptions={data.skillOptions}
                  /* The root column (tasks 01a006f8/01a00932): every kind
                     root mounts the workspace's own list through
                     `renderRootList`; there is NO New session button (D2) —
                     a session is created by RUNNING a task, whose Run lives
                     on the hosted tile itself. */
                  renderRootList={regions.renderRootList}
                  root={regions.root}
                  onRoot={regions.onRoot}
                  kindCell={regions.kindCell}
                  rootKindOptions={regions.rootKindOptions}
                  selectedEntityId={regions.selectedEntityId}
                  onSelectEntity={regions.onSelectEntity}
                  onShowChat={regions.onShowChat}
                  onNewEntity={regions.onNewEntity}
                  newEntityUnavailable={regions.newEntityUnavailable}
                  routeThreadId={regions.routeThreadId}
                  onThreadSelected={regions.onThreadSelected}
                  graphFull={regions.graphFull}
                  onGraphFullChange={regions.onGraphFullChange}
                  centerOverride={regions.centerOverride}
                  slots={homeSlots}
                  viewerName={data.viewerActor?.displayName}
                  viewerId={data.viewerActor?.id}
                  /* IN PLACE, not away (user report 2026-08-16): a chip inside
                     a conversation you are still having opens the entity in
                     Home's own column. Leaving for the workspace is the right
                     handoff for a screen you are DONE with — Git's lanes,
                     Messages' "go to the entity this lives on" — and the wrong
                     one for a reference mid-thread. */
                  onOpenEntity={openEntity}
                />
              )}
            />
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            activeTarget.ref === 'settings' &&
            settingsPort ? (
            /* ⛭ Settings — the T2 shell, mounted at last (identity-display
               lane, 2026-08-01): this ref rendered the unbuilt-view card while
               the whole module sat built and unmounted in settings-space/.
               Sections another module owns (projects/kinds) keep their honest
               not-mounted state inside the shell itself. */
            <SettingsShell
              port={settingsPort}
              nodeKey={nodeKeyOf(activeServer.routeBaseUrl)}
              /* W2 -> W1/W3: an axis write must reach the workspace's own
                 pickers and board options; axis rows are not entities, so no
                 event will do it. */
              onAxesChanged={data.refreshTaskAxes}
              sections={
                credentialsPort || branchesPort
                  ? {
                      ...(branchesPort
                        ? { projects: <ProjectBranchesSection port={branchesPort} /> }
                        : {}),
                      ...(credentialsPort
                        ? {
                            credentials: (
                              <CredentialsSection
                                port={credentialsPort}
                                serverBaseUrl={activeServer.routeBaseUrl}
                              />
                            ),
                          }
                        : {}),
                    }
                  : undefined
              }
            />
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            (isUnbuiltViewRef(activeTarget.ref) ||
              /* Mounted screens whose PORT this server did not serve. The
                 screen exists; the capability behind it does not, on this node.
                 They land here rather than on the unrecognised card because the
                 ref is real and recognised — what is missing is the port, and
                 the branches above already declined for exactly that reason. */
              (activeTarget.ref === 'files' && !filesExplorerPort) ||
              (activeTarget.ref === 'settings' && !settingsPort)) ? (
            /* Unbuilt view refs SAY SO — rendering the workspace under a
               highlighted Dashboard row was a silent lie about where you are
               (same audit, same class).

               `inbox` LEFT THIS SET on 2026-08-13: its screen was finished all
               along and is now mounted above, so the card no longer covers it.

               THE TEST USED TO BE `ref !== 'workspace'`, which is a catch-all
               wearing a whitelist's name: it absorbed every ref the chain had
               not matched, including refs that do not exist. The set is now
               ENUMERATED in `VIEW_REF_SCREENS`, so an unrecognised ref falls to
               the loud card below instead of being told it is merely coming
               soon. */
            <div className="ev-root" data-testid="unbuilt-view">
              <p className="evt-empty" style={{ margin: 24 }}>
                {`${activeTarget.ref} isn’t built yet — its designed screen is coming. Nothing is hidden here; it does not exist in this build.`}
              </p>
            </div>
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            activeTarget.ref === 'workspace' ? (
            /* THE WORKSPACE, MATCHED EXPLICITLY. This was `: data.ready ?` — a
               bare else that made the workspace the destination of every
               mistake in this chain. See `VIEW_REF_SCREENS`. */
            <WorkspaceView
              data={data}
              viewerMemberId={viewerMemberId}
              serverBaseUrl={activeServer.routeBaseUrl}
              nav={nav}
              leftKind={kinds.leftKind}
              rightKind={kinds.rightKind}
              leftWidth={kinds.leftWidth}
              rightWidth={kinds.rightWidth}
              onLeftKindChange={kinds.setLeftKind}
              onRightKindChange={kinds.setRightKind}
              onMoveSidePanel={kinds.movePanel}
              onResizeSidePanel={kinds.resizePanel}
              onResetSidePanelWidth={kinds.resetPanelWidth}
              onLaunchOpen={(id) => launch.open(id)}
              launchSubjectId={launch.subjectId}
              launchRefusal={launchRefusal}
              launchInFlight={launching}
              isModalOpen={launch.isModalOpen}
              onLaunchCancel={() => {
                setLaunchRefusal(null);
                launch.close();
              }}
              // D44: the sheet's Launch PERFORMS. A brass primary that cannot
              // do its verb reads as working at a glance and only corrects
              // itself after a click — the same misleading-glance shape as a
              // transient refusal wearing the permanent form. The honest fix
              // is to wire it, not to grey it out.
              onLaunchDispatch={submitDispatch}
              onLaunchSubmit={submitLaunch}
              onSpawn={async (input) => {
                const sessionId = await data.spawn(input);
                navigateTo(WORKSPACE_TARGET);
                nav.push(sessionId);
              }}
              menuCollapsed={menuCollapsed}
              reasons={reasons}
              onNotice={notices.push}
              onPinRefusal={(_id: EntityId, refusal: string) =>
                notices.push({
                  id: 'pin-refused',
                  tone: 'warn',
                  title: 'Panel not pinned',
                  body: refusal,
                  ttlMs: 6000,
                })
              }
            />
          ) : data.ready && navView.view === 'entity' ? (
            /* `e/{id}` IS A SPECIFIED ROUTE WITH NO HOST YET — NOT AN
               UNRECOGNISED ONE, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS
               ARM.

               Ruling M1 (2026-08-14): `e/{id}` means the Z4 entity FULL VIEW.
               That host does not exist anywhere in this tree, and no lane owns
               building it yet. Until it does, the route can be parsed, carried
               and shared but not drawn.

               `landingOfRoute` returns null for the no-`origin` form — resolving
               it needs the entity's KIND, which is a read, so a pure mapping
               cannot do it — and null lands on the unrecognised card below.
               That card says "this build has no screen for that", which about a
               frozen, specified route is simply false: the route is right and
               the screen is missing. This is the unbuilt-view idiom instead,
               which is the honest sentence and the one the reader can act on.

               IT IS ALSO WHAT PROMOTE USED TO DESTROY THE SCREEN WITH.
               `navStore.promote` writes `{view:'entity', origin:null}` and, from
               the workspace, has no `origin` to carry — so one click on Z4
               removed the panel AND replaced the whole screen with the loud
               unrecognised card. Phase 1 did not introduce that write; it made
               an already-latent one visible by making the store authoritative.
               The port refuses the promote now (see `nav.promote`), and this arm
               is the safety net for the same route arriving from a pasted link,
               where there is no port to refuse it. */
            <div className="ev-root" data-testid="entity-full-view-unbuilt">
              <p className="evt-empty" style={{ margin: 24 }}>
                The full view for a single entity isn’t built yet. This link is a real
                address and it has been kept — there is just no screen behind it in this
                build. Open the entity from its collection in the meantime.
              </p>
            </div>
          ) : data.ready ? (
            /* NOTHING MATCHED, AND THAT IS NOW SAYABLE. Everything the chain
               above understands has its own arm; reaching here means the target
               is one this build has no screen for — `null`, or a shape that came
               from storage or an inventing caller. It used to render the
               workspace. See `VIEW_REF_SCREENS`. */
            <UnroutedTargetCard target={activeTarget} />
          ) : data.authRequired ? (
            /* The active server answered the boot read with "authentication
               is required". That is not an unreachable node and not an empty
               workspace — it is a sign-in, so the gate's own login frame
               renders HERE, scoped to this server (the auth verbs resolve the
               active server per call). The real sign-in writes the pass and
               notifies; the parked boot read resumes off that, so no onDone
               wiring is needed. `rootScope="inherit"` because this already
               sits inside the shell's `.cv2-root` — see AuthFlow. */
            <AuthFlow
              frame={undefined}
              initialFrame="1d"
              rootScope="inherit"
              onDone={() => {
                // Unreachable outside the dev bypass: the verbs sign in by
                // writing the session, and boot resumes off the store.
              }}
            />
          ) : data.bootError ? (
            /* GAP-1 (data-wiring handover): with the real seam now the
               default, an unreachable node is a NORMAL state and must be
               STATED — never a spinner that resolves for nobody, never a
               silent fall-back to fixtures. THREE distinct honest states share
               this card: a node that could not be reached (boot keeps retrying
               in the background), a node that answered with zero spaces
               (nothing to retry — there is nothing to open), and a node that
               answered this Space's reads with a REFUSAL. */
            data.bootError.startsWith('this node has no spaces') ? (
              <div className="shell-boot" role="alert">
                <strong>No spaces on this node.</strong>
                <div>Create a Space and connect the local folder where its project work should be saved.</div>
                {projectOnboardingPort ? (
                  <button type="button" className="gov-btn gov-btn--ink" onClick={() => setNewSpaceOpen(true)}>
                    Create Space & add project
                  </button>
                ) : <div>{data.bootError}</div>}
              </div>
            ) : data.bootErrorCode === 'forbidden' ? (
              /* A REFUSAL IS AN ANSWER, AND IT MUST NOT WEAR THE OUTAGE'S
                 HEADLINE. `forbidden` used to render as "can't reach the tm8
                 node … this clears itself the moment the node answers", and the
                 node had already answered: waiting changes nothing. The reader
                 is then told the exact opposite of what to do — wait on a card
                 that will never clear, instead of switching Space or asking for
                 access. Reported verbatim as a node-reachability bug, which is
                 how a Space that refused `spaces.settings` stayed misdiagnosed.

                 `forbidden` ONLY, deliberately. It is the one code that means
                 "the node answered about THIS Space, and said no"; every other
                 non-transport failure is somebody else's sentence to write, and
                 claiming them here would trade one wrong headline for another.

                 The tab bar above this card is live, so "open a different
                 Space" is an instruction the reader can act on right here.
                 Boot keeps retrying underneath, which is why this promises
                 nothing about waiting but still heals the moment access lands. */
              <div className="shell-boot" role="alert">
                <strong>The node refused this Space.</strong>
                <div>{data.bootError}</div>
                <div>The workspace is empty because the read was refused — not because there is nothing in it.</div>
                <div>Waiting will not clear this. Open a different Space above, or ask a Space admin for access to this one.</div>
              </div>
            ) : (
              <div className="shell-boot" role="alert">
                <strong>Can’t reach the tm8 node.</strong>
                <div>{data.bootError}</div>
                <div>The workspace is empty because nothing could be read — not because there is nothing in it.</div>
                <div>Retrying automatically — this clears itself the moment the node answers.</div>
              </div>
            )
          ) : (
            <BootLoader label="loading workspace" />
          )}
          </CatchBoundary>
        </div>

        <CommandPalette
          open={paletteOpen}
          results={paletteResults}
          views={paletteViews}
          ctx={{ spaceId: data.spaceId }}
          onQueryChange={setPaletteQuery}
          onOpenEntity={(id) => {
            nav.push?.(id as EntityId);
            setPaletteOpen(false);
          }}
          onOpenView={openPaletteView}
          onDismiss={() => setPaletteOpen(false)}
        />
        <PromptsOverlay open={promptsOpen} onClose={() => setPromptsOpen(false)} />
        <NoticeHost notices={notices.notices} onDismiss={notices.dismiss} />
        <AddServerDialog
          open={addServerOpen}
          onDismiss={() => setAddServerOpen(false)}
          onAdd={async (input) => {
            if (!props.onAddServer) throw new Error('Adding Servers is unavailable.');
            await props.onAddServer(input);
          }}
        />
        {projectOnboardingPort ? (
          <NewSpaceProjectDialog
            key={activeServer.id}
            open={newSpaceOpen}
            nodeLabel={activeServer.label}
            viewerIsNodeAdmin={viewerIsNodeAdmin}
            port={projectOnboardingPort}
            onDismiss={() => setNewSpaceOpen(false)}
            onCreated={(space) => {
              /* A newly created Space is a context switch like any other — the
                 brief that scoped this work named only the two switch handlers,
                 and this third copy is exactly the drift the one path removes. */
              leaveSpaceContext();
              data.acceptSpace(space);
              setNewSpaceOpen(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

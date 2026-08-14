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
import type { EntityId, EntitySummary, MenuViewRef, ProjectTrustLevel, SpaceId } from '@tm8/contract';
import { startFolderImport } from '../files-explorer/folder-import';
import {
  MenuRail,
  NOTICE_TTL_MS,
  NoticeHost,
  SpaceTabBar,
  useNotices,
  type KindPresenter,
  type MenuDynamicGroup,
  type MenuTarget,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import { registerNoticeSink } from '../terminal/notifications';
import { screenKeyOf, screenStackStore } from '../stores/screenStackStore';
import { attachRouter, navStore, useNavStore } from '../stores/navStore';
import { createBrowserTarget, type RouterTarget } from '../routes';
import { CommandPalette, type PaletteView } from '../shell/CommandPalette';
import { PromptsOverlay } from '../prompts';
import { ProjectGitScreen } from '../git/ProjectGitScreen';
import { createKeyboardController, type KeyboardController } from '../keyboard';
import { allKinds, KindIcon, VIEW_ART, landingOfRoute, navViewOfName, routeViewOf } from '../domain';
import type { NavView } from '../routes';
import { getKind } from '../domain';
import { buildSpawnInput, newLaunchMutationId } from '../domain/launch';
import type { DispatchSelection, LaunchSelection } from './LaunchSheet';
import type { DetailReasons } from '../panels';
import { BootLoader, VectorIcon } from '../kit';
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

/** The screen a viewer with no remembered place lands on. */
const WORKSPACE_TARGET: MenuTarget = { type: 'view', ref: 'workspace' };

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
  workspace: 'workspace',
  /* The last genuinely unbuilt view ref. */
  feed: 'unbuilt',
  /* NOT unbuilt — an ALIAS. `domain/nav-targets.ts` resolves `channels` to the
     `channel`-kind EntityView, which is mounted and always has been. This entry
     records that the alias is not resolved on THIS path: the rail and the
     palette emit the kind target directly, so a bare `{type:'view',
     ref:'channels'}` only arrives when the palette finds no channel to open.
     Classified `unbuilt` because that is what today's chain does with it, and
     Phase 0.5 is a truth-telling change, not a behaviour change. Resolving the
     alias here belongs to the router mount, which owns both directions. */
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
  const [menuCollapsed, setMenuCollapsed] = useState(false);
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
  /* The notice sink, read through a ref so remounting the router is not coupled
     to the identity of a callback that changes on every render. */
  const noticeSink = useRef(notices.push);
  noticeSink.current = notices.push;
  const routerTarget = props.routerTarget;
  useLayoutEffect(() => {
    const target = routerTarget ?? createBrowserTarget();
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
    return detach;
  }, [nodeKey, routerTarget]);

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
    const remembered = readLastTarget(nodeKey, data.spaceId) ?? WORKSPACE_TARGET;
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
  }, [nodeKey, data.spaceId]);

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
   */
  const leaveSpaceContext = useCallback(() => {
    navStore.getState().applyNormalization({ stack: [], pinned: [] });
    navStore.getState().setSession(null);
    screenStackStore.getState().clearAll();
    navStore.getState().navigate({ view: 'workspace' });
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
        navigateTo(WORKSPACE_TARGET);
        nav.push(sessionId);
        notices.push({
          id: 'launch-done',
          tone: 'info',
          title: 'Session launched',
          body: 'The live terminal is open in the workspace.',
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
      promote: (id) => actions.promote(id),
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
      rootMessageId: string; teammateId: string; model: string; clientMutationId: string;
    }) => {
      const result = await data.seam.commands.startChatThread(input);
      return {
        threadRootId: result.thread.rootMessageId,
        teammateId: result.thread.teammateId,
        model: result.thread.model,
      };
    },
  }), [data.seam]);

  // The same grammar for VOICE: "Voice" is a label, the space's voice_channel
  // entities are the rows. The glyph comes from the REGISTRY row (as
  // `presentKind` does above) rather than being authored here — a second
  // authored glyph beside the registry's would drift the moment either moves.
  const voiceKind = getKind('voice_channel');
  const voiceEntities = data.rowsFor(voiceKind.kind)(undefined);
  const voiceGroup = useMemo<MenuDynamicGroup>(() => ({
    replaceConfiguredItems: true,
    emptyLabel: 'No voice channels in this space yet.',
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

  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="shell-root">
        <SpaceTabBar
          activeServer={{
            label: activeServer.label,
            reachability: activeServer.reachability,
          }}
          spaces={data.spaces}
          activeSpaceId={data.spaceId || null}
          onSelectSpace={(id: SpaceId) => {
            leaveSpaceContext();
            data.selectSpace(id);
          }}
          onAddSpace={projectOnboardingPort ? () => setNewSpaceOpen(true) : undefined}
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
          accountSlot={
            authAccount && data.viewerActor ? (
              <AccountMenu actor={data.viewerActor} theme={theme} onThemeChange={setTheme} />
            ) : undefined
          }
        />

        <div className="shell-body">
          <MenuRail
            config={data.menu.config}
            collapsed={menuCollapsed}
            onToggle={() => setMenuCollapsed((c) => !c)}
            activeTarget={activeTarget}
            onNavigate={navigateTo}
            presentKind={presentKind}
            dynamicGroups={{ voice: voiceGroup }}
            servers={props.servers}
            activeServerId={activeServer.id}
            onSelectServer={(id) => {
              leaveSpaceContext();
              props.onSelectServer?.(id);
            }}
            onAddServer={props.onAddServer ? () => setAddServerOpen(true) : undefined}
          />

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
            /* D1-amended: Chat is the home screen. The existing dashboard
               route stays stable while its centre is replaced wholesale. */
            <ChatHomeSurface
              seam={data.seam}
              spaceId={data.spaceId}
              nodeKey={nodeKey}
              spaceLabel={data.spaces.find((sp) => sp.id === data.spaceId)?.name}
              bridge={chatBridge}
              /* PR188 review F3: the space id is NOT an entity and
                 messages.post 404s on it (measured). Bare-home chats anchor
                 to the seeded default channel. */
              anchorId={channelEntities[0]?.id}
              /* Entity chips in the transcript open the detail panel through
                 the SAME handoff every other screen commits (ProjectGitScreen,
                 lane click-through): land in the workspace three-pane layout
                 with the entity pushed onto the right-side panel stack. */
              onOpenEntity={(id) => {
                navigateTo(WORKSPACE_TARGET);
                nav.push(id as EntityId);
              }}
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

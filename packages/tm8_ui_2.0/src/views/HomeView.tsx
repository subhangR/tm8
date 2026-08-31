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
import {
  PanelResizer,
  useElementHeight,
  useElementWidth,
  usePanelChoice,
  usePanelFlag,
  usePanelHeight,
  usePanelWidth,
} from '../kit';
import {
  EntityListPanel,
  type ControlHost,
  type DetailReasons,
} from '../panels';
import type { ActionRef } from '../domain';
import { getKind } from '../domain';
import { attachmentsFor } from '../files/port';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { navStore, useNavStore } from '../stores/navStore';
import { loadHomeRoot, rememberHomeRoot, type HomeRoot } from '../stores/homeRegionStore';
import {
  CHATS_ROOT,
  composeEntityNavigation,
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
import { usePaneScrollMemory } from './paneScrollMemory';
import type { Notice } from '../shell';
import { LaunchSheet, type DispatchSelection, type LaunchSelection } from './LaunchSheet';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import { useSessionStart } from './useSessionStart';
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
   (`home-page.css`'s `.hr-rail` 72 / 208). Duplicating a floor in a
   stylesheet is exactly what geometry.ts's standing rule forbids, so they
   live here now and are handed to CSS as `--hp-rail`. */
export const HOME_RAIL_COLLAPSED = 72;
export const HOME_RAIL_EXPANDED = 208;

/* ---------------------------------------------------------------------------
   THE DASHBOARD SPLIT (owner, 2026-08-31)
   ---------------------------------------------------------------------------
   "ideally we want sessions and chats and task to be occupying max height width
   adjustable up and down" · "Need horizontal split full height is compulsory
   strictly" · and then, correcting which shape leads: "Priority is vertical
   split with full height".

   So: two panes with a real handle between them, VERTICAL (side by side) by
   default and STACKED on demand, with the choice and both extents remembered.
   Every number below is a floor in the 02-LAYOUT §6 sense — the extent below
   which the pane stops being itself — and every CEILING is solved from a
   MEASUREMENT rather than typed, for the reason the rail's own constants moved
   out of the stylesheet: a floor that lives in two places disagrees with
   itself. */

/**
 * THE ACTIVE PANE SIDE BY SIDE — AND THE GRID CHANGES SHAPE RATHER THAN
 * REFUSING TO MOVE (owner, 2026-08-31: "if i adjust width of chat these cards
 * become a list?").
 *
 * A TWO-COLUMN DRAG FLOOR WAS THE FIRST ANSWER AND IT WAS THE WRONG ONE. It
 * would have clamped the divider at 418px so the cards could never stop being
 * two abreast — which makes a genuinely wide conversation unreachable (a real
 * thing to want while reading a long reply) and makes the divider look broken
 * on the way there, because a control that silently stops moving reads as
 * broken whatever the reason. So there is no two-column clamp. The GRID takes
 * three shapes as the pane narrows, and the two thresholds between them live in
 * `home-page.css` as CONTAINER queries on the pane itself — the pane's width is
 * what the divider sets, so the viewport cannot answer this and a JS breakpoint
 * would be answering the wrong question.
 *
 *   1. WIDE   — cards, two or more columns, 96px rows (the approved mock).
 *   2. NARROW — one column of ROWS: kind dot, title, kind word, time. Same
 *               scroller, same click target, same facts; 44px rows.
 *   3. GONE   — the pane collapses to the seam and the conversation takes the
 *               width. Never without a way back: the reveal control is drawn
 *               permanently in the seam (Subhang's ruling 3, 2026-08-16).
 *
 * 240 IS THE FLOOR OF BAND 2 AND THEREFORE THE RESIZER'S FLOOR: the narrowest
 * pane on which a row is still a row — an 8px dot, two 8px gaps, a title with
 * room to say something, the kind word, a 4-character time and 16px of padding.
 * Below it the drag does not clamp, it COLLAPSES (`onBeyondFloor`), which is
 * band 3 and the only honest thing left to do with a request for less.
 *
 * 480 is the resting default: two 200px card columns and their 8px gap, with
 * room to breathe, and a hair under the 618 a third column would need.
 */
export const HOME_SIDE_W_MIN = 240;
export const HOME_SIDE_W_DEFAULT = 480;
/** THE ACTIVE PANE STACKED, and the floor is arithmetic rather than taste:
      a create-verb card row                                  ~60px
      the column gap                                           10px
      the ACTIVE bar (label, lenses, live tally)              ~24px
      its gap                                                   8px
      ONE FULL 96px CARD ROW — the brief's floor                96px
      the pane's seam gutter                                     8px
                                                              ≈ 206
    200 is that, rounded to the nearest ten, which keeps one whole card visible
    at the floor. Half a card is the "broken box" reading the grid's scroll
    snapping exists to avoid. 300 is the resting default because it is what the
    retired `max-height: 200px` produced once the strips above it were paid —
    nothing jumps for a reader who has never dragged the seam. */
export const HOME_SIDE_H_MIN = 200;
export const HOME_SIDE_H_DEFAULT = 300;
/** The OTHER pane's floor when the two share the height. A transcript with its
    composer under it stops being usable below this; it is the same order as the
    380px `min-height` the solo chat hero carried before the split. */
export const HOME_LOWER_MIN = 300;
/** The seam track: the `PanelResizer`'s 8px hit target and nothing else. It has
    no border of its own — that is why this is 8 and `ASIDE_CHROME` is 9. */
export const HOME_SPLIT_CHROME = 8;

/**
 * WHERE SIDE-BY-SIDE STOPS FITTING, and it is measured, not a media query.
 *
 * Both panes have floors, and below their sum plus the rail there is no honest
 * side-by-side arrangement left — one of them would have to go under its floor,
 * which is the zero-floored track this package forbids by the back door. So the
 * layout FALLS BACK to stacked, where the panes share the height instead of the
 * width and both floors are payable again.
 *
 * With the rail collapsed and no aside that threshold is 72 + 240 + 8 + 360 =
 * 680px of `.hp-host`. It moves with the rail and with the aside because it is
 * computed from them; a hard-coded breakpoint would be wrong the moment either
 * changed, which is the standing rule that breakpoints are DERIVED.
 *
 * THE FLOOR IT PAYS IS BAND 2's, not band 1's. Side by side stays available all
 * the way down to a pane holding a ROW LIST beside a usable conversation —
 * which is the whole point of the grid changing shape instead of clamping.
 * Below even that there is no arrangement where both panes clear their floors,
 * so the honest answer is stacked, where the grid gets the full width back.
 *
 * THE FALLBACK NEVER WRITES. It is a paint-time decision, exactly like the
 * aside's overlay demotion and the width clamp beside it. A narrow window that
 * persisted "stacked" would answer the reader's remembered choice with the
 * accident of one session's window size, and widening again would not give it
 * back — the same way clamping on write is how a width preference dies.
 */
export function homeSplitFits(outerWidth: number, railWidth: number, asideReserve: number): boolean {
  /* 0 is jsdom, which cannot measure. An unmeasurable row imposes no fallback
     rather than a fabricated one — the same law the overlay follows. */
  if (outerWidth <= 0) return true;
  return outerWidth >= railWidth + HOME_SIDE_W_MIN + HOME_SPLIT_CHROME + HOME_CENTER_MIN + asideReserve;
}

/** The two arrangements. `vertical` = panes side by side (the divider is a
    vertical rule, dragged left and right); `horizontal` = stacked. */
export type HomeSplitAxis = 'vertical' | 'horizontal';
const isSplitAxis = (candidate: string): candidate is HomeSplitAxis =>
  candidate === 'vertical' || candidate === 'horizontal';

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
  /**
   * The conversation the ADDRESS names (`/home/chat/{id}`), for the screen
   * to adopt — back/forward and shared links land on the right thread.
   *
   * THREE STATES, NOT TWO, and the screen's props say so: `undefined` is "the
   * address answers nothing, keep your own selection", `null` is "the answer
   * is NO THREAD — the new-chat composer", and an id is that thread. Collapsing
   * the first two is what made Home's New chat card inert; see `routeThreadId`
   * below the root resolution for the whole account.
   */
  routeThreadId?: EntityId | null | undefined;
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

  /* One navigation projection feeds BOTH Home altitudes. Counts remain
     absent until the server answered; only registry-declared live kinds see
     the seam's live population. */
  const navigationGroups = useMemo(
    () =>
      composeEntityNavigation(
        homeRailGroups(),
        data.countsFor,
        (config) => (config.list.liveTreatment ? data.liveIds.length : undefined),
      ),
    [data.countsFor, data.liveIds.length],
  );

  /* THE TRAILS — route state, read live (D1). B is the stack; C is `r`. */
  const navView = useNavStore((s) => s.view);
  const stack = useNavStore((s) => s.stack);
  const rightTrail = useNavStore((s) => s.right);
  const centerId = stack.length > 0 ? stack[stack.length - 1]! : null;
  const drillId = rightTrail.length > 0 ? rightTrail[rightTrail.length - 1]! : null;
  /**
   * ONE GESTURE, ONE RESULT (ruling 2026-08-31, delegated by the owner: "You
   * take the call which fits best"). A connection ALWAYS opens in the ENTITY
   * PANE, in place, pushing a trail crumb. This SUPERSEDES R6's mechanism and
   * keeps R6's reason.
   *
   * IT WAS `openRight` — region C, the 440px aside — and the discriminator for
   * which of three berths a click landed in was WHERE THE CLICK CAME FROM: a
   * dashboard card, an in-tree connection, or a chip inside the transcript. A
   * reader cannot see that distinction, so they could not predict where a click
   * would land, which is the definition of arbitrary navigation. Worse,
   * `openFromCenter` branched on `inTreeOf`, so two connections on the SAME
   * panel could land in different places depending on ancestry nothing on
   * screen states.
   *
   * AND THE ASIDE COULD NOT KEEP ITS OWN PROMISE. It holds exactly one entity,
   * so chip → chip → chip evicts the first anyway: the guarantee "you do not
   * lose your place" expired on the second click, while costing 440px of a
   * screen the owner has just split two ways and objected to a third column on
   * three times.
   *
   * THE GUARANTEE IS KEPT BY OTHER MEANS, and it had to be built rather than
   * assumed: the trail survives arbitrary depth AND `usePaneScrollMemory`
   * restores where the reader was in each entity as they walk back. A crumb
   * without the scroll memory would have been a downgrade wearing a ruling.
   */
  const openEntity = useCallback((id: EntityId) => navStore.getState().push(id), []);

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
        : /* HOME MEANS HOME. This used to be `loadHomeRoot(spaceId)` — the last
             kind you browsed, remembered across visits — so opening Home landed
             you on the Tasks LIST and the dashboard was somewhere you could
             only reach by accident. The owner, on the deployed build: "nothing
             is making sense in home tab overall". A remembered root is a good
             idea for a browser and a bad one for a home page: the one address
             everybody types has to mean the same thing every time. The rail
             still remembers within a visit; the address no longer does. */
          CHATS_ROOT;
  /* ── WHICH CONVERSATION IS OPEN IS MIRRORED STATE, NOT AN ADDRESS ─────────
   *
   * It used to be read straight off the address:
   *
   *     const routeThreadId = routeRoot?.type === 'chats' ? routeRoot.threadId : null;
   *
   * and every arm of that expression is a `null` the screen cannot act on.
   * Home declares `soloConversation` now (`GateApp`), and under solo the
   * screen reads the host's `null` as the INSTRUCTION "no thread — the
   * new-chat composer". The screen's own props document a THIRD state for
   * exactly this: `undefined` means "the host is driving nothing, keep your
   * own selection". Home never spelt it.
   *
   * THAT IS WHY NEW CHAT WAS DEAD, and the address cannot fix it:
   *
   *  - The card's verb is "no thread". From an address already reporting
   *    `null` that is not a change — same prop, same deps, the solo effect
   *    never re-runs, the open conversation stays open. Exactly the phone's
   *    `setThreadId(null)`-from-`null` defect (MobileShell, task 01a01c3f).
   *  - And `{ type: 'chats', threadId: null }` is NOT AN ADDRESSABLE STATE.
   *    `routes/codec` collapses it to the bare `/home` form on the way out and
   *    normalizes it away on the way back in — deliberately, since `/home` IS
   *    that address. A signal the codec is entitled to erase cannot be the
   *    signal a button depends on.
   *  - Two other addresses spell `null` while meaning nothing of the sort:
   *    every KIND root (browsing a list must not blank the conversation
   *    behind it, D6) and `setRoot(CHATS_ROOT)`, which writes `threadId: null`
   *    just to name the root.
   *
   * So the selection is mirrored here, the way `MobileShell` mirrors it for
   * the phone — the other solo host, which owns this state locally for the
   * same reason. The ADDRESS still wins whenever it NAMES a thread
   * (`/home/chat/{id}`: back/forward and shared links), which is the whole of
   * what it can say; a bare address says nothing and the mirror keeps its
   * answer. The cold-start auto-open stays viewer-local and writes no history,
   * as its prop's docblock requires.
   *
   * The adoption is a render-phase adjustment rather than an effect, the same
   * pattern (and for the same reason) as the screen's own: an effect would
   * paint one frame of the outgoing conversation first.
   */
  const addressThreadId = routeRoot?.type === 'chats' ? routeRoot.threadId : null;
  const [chatSelection, setChatSelection] = useState<EntityId | null | undefined>(
    addressThreadId ?? undefined,
  );
  const [addressThreadSeen, setAddressThreadSeen] = useState<EntityId | null>(addressThreadId);
  if (addressThreadSeen !== addressThreadId) {
    setAddressThreadSeen(addressThreadId);
    if (addressThreadId !== null) setChatSelection(addressThreadId);
  }
  const routeThreadId = chatSelection;
  /* THE STAGE the address names. A stage and an entity both want region B, and
     the ENTITY WINS when both are addressed: the entity was opened by a click
     the viewer just made, while a stage can persist in a link from yesterday.
     Resolved here, once, so the screen never has to arbitrate. */
  const routeStage: CockpitStage | null =
    routeRoot?.type === 'chats' && !centerId ? (routeRoot.stage ?? null) : null;

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
  /* THE `inTreeOf` BRANCH IS GONE (same ruling). In-tree grew the trail and
     out-of-tree opened the aside — two results for one gesture, chosen by an
     ancestry the reader has no way to see. `push` was already the right
     behaviour for the in-tree case and is now the only behaviour.

     `inTreeOf` and `views/home-tree.ts` are NOT deleted: `EntityView` and the
     workspace still ask the question for their own layouts. What is deleted is
     Home asking it to decide a BERTH. */
  const openFromCenter = useCallback((id: EntityId) => navStore.getState().push(id), []);

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
    onOpen: (id) => navStore.getState().openCenter(id),
    onError: (verb, error) => notifyActionFailed(verb, '', error),
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
        const dispatch = sessionStart.onAction;
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
    [newEntity, sessionStart.onAction],
  );
  const cellBirth = birthFor(cellConfig.kind);

  /* THE C COLUMN IS DRAGGABLE, clamped against B's floor. D13: when the
     window cannot afford all three regions, C keeps its width and OVERLAYS B
     instead of crushing it — a squeezed xterm reflows to nonsense columns and
     reads as "the terminal is broken". */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootWidth = useElementWidth(rootRef);
  const rootHeight = useElementHeight(rootRef);
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

  /* ───────────────────── THE DASHBOARD SPLIT ─────────────────────────────
     The arrangement, the two extents, and the ceilings solved from the row's
     and the column's real measurements. The constants and the reasoning are at
     the top of this file; what happens here is only the arithmetic.

     THE CHOICE IS PERSISTED THROUGH `usePanelChoice` — the third shape beside
     the width and the flag, and it is the right one: this is a selection from a
     CLOSED SET, so a value written by some earlier build that no longer names
     an arrangement must read as "nothing remembered" and fall to the default,
     never come back as a shape no CSS rule can draw. */
  const [splitChoice, setSplitChoice] = usePanelChoice('home.split', 'vertical', isSplitAxis);
  const splitFits = homeSplitFits(outerWidth, railWidth, asideReserve);
  /* THE REMEMBERED CHOICE AND THE DRAWN ONE ARE DIFFERENT VALUES, deliberately.
     `splitChoice` is what the reader asked for and is what persists; `splitAxis`
     is what this window can actually afford. Widening the window restores the
     vertical arrangement without the reader touching anything, because the
     fallback never wrote. */
  const splitAxis: HomeSplitAxis = splitChoice === 'vertical' && splitFits ? 'vertical' : 'horizontal';

  const sideWidthPref = usePanelWidth('home.side', HOME_SIDE_W_DEFAULT, HOME_SIDE_W_MIN);
  const sideHeightPref = usePanelHeight('home.side', HOME_SIDE_H_DEFAULT, HOME_SIDE_H_MIN);
  /* BAND 3. A flag, not a width of zero: a zero width would be a floor of zero
     by the back door, and the remembered extent has to survive the collapse
     unchanged so revealing puts the pane back where the reader left it. */
  const [sideCollapsed, setSideCollapsed] = usePanelFlag('home-side-collapsed', false);

  /* SIDE BY SIDE: the ACTIVE pane may take everything the row can spare once
     the rail, the other pane's floor and — when it is open — the aside's floor
     have been paid. Unmeasurable (jsdom) ⇒ no ceiling rather than a fabricated
     one, the same rule column A's ceiling follows twenty lines up. */
  const sideWidthCeiling = outerWidth > 0
    ? Math.max(
        HOME_SIDE_W_MIN,
        outerWidth - railWidth - HOME_SPLIT_CHROME - HOME_CENTER_MIN - (overlay ? 0 : asideReserve),
      )
    : Number.POSITIVE_INFINITY;
  const sideWidth = Math.min(Math.max(HOME_SIDE_W_MIN, sideWidthPref.width), sideWidthCeiling);

  /* STACKED: the same sentence turned through ninety degrees. The ceiling is
     what the COLUMN can spare once the conversation's floor and the seam are
     paid, and it is measured off the same element for the same reason — a `vh`
     unit would answer for the window, which is not this region. */
  const sideHeightCeiling = rootHeight > 0
    ? Math.max(HOME_SIDE_H_MIN, rootHeight - HOME_LOWER_MIN - HOME_SPLIT_CHROME)
    : Number.POSITIVE_INFINITY;
  const sideHeight = Math.min(Math.max(HOME_SIDE_H_MIN, sideHeightPref.height), sideHeightCeiling);

  /* ONE HANDLE, ONE GESTURE, BOTH AXES — `kit/PanelResizer`, extended rather
     than twinned (its docblock says why). `side` names where the pane it moves
     SITS relative to the seam: to its LEFT when the panes are side by side,
     ABOVE it when they are stacked. `aria-controls` names `#hp-side`, which is
     the element whose width or height this drag actually changes; the render
     gate fails a handle whose target is not on the page. */
  const splitter = (
    <div className="hp-split" data-split={splitAxis} data-testid="hp-split">
      {sideCollapsed ? (
        /* THE WAY BACK, DRAWN PERMANENTLY. Subhang's ruling 3 (2026-08-16): a
           collapse whose only escape is a keyboard shortcut or a hover target
           is a panel most readers never get back. The subject changed — this is
           the ACTIVE pane rather than the rail — and the ruling did not. */
        <button
          type="button"
          className="hp-split__reveal"
          data-testid="hp-side-reveal"
          aria-label="Show active work"
          aria-expanded={false}
          aria-controls="hp-side"
          title="Show active work"
          onClick={() => setSideCollapsed(false)}
        >
          <span aria-hidden>{splitAxis === 'vertical' ? '›' : '⌄'}</span>
        </button>
      ) : (
        <PanelResizer
          side={splitAxis === 'vertical' ? 'left' : 'top'}
          label="Active work"
          controls="hp-side"
          width={splitAxis === 'vertical' ? sideWidth : sideHeight}
          minWidth={splitAxis === 'vertical' ? HOME_SIDE_W_MIN : HOME_SIDE_H_MIN}
          maxWidth={
            splitAxis === 'vertical'
              ? (Number.isFinite(sideWidthCeiling) ? sideWidthCeiling : HOME_SIDE_W_DEFAULT)
              : (Number.isFinite(sideHeightCeiling) ? sideHeightCeiling : HOME_SIDE_H_DEFAULT)
          }
          onResize={splitAxis === 'vertical' ? sideWidthPref.setWidth : sideHeightPref.setHeight}
          onReset={splitAxis === 'vertical' ? sideWidthPref.reset : sideHeightPref.reset}
          /* BAND 3, reached by the drag itself. The floor still CLAMPS
             `onResize`; this fires only for a request well past it, and the
             remembered extent is left untouched so the reveal restores it. */
          onBeyondFloor={() => setSideCollapsed(true)}
        />
      )}
      {/* THE FLIP, ON THE DIVIDER. A reader who wants the other shape is
          already looking at the thing between the two panes, so the control
          lives there rather than in a menu. It is DISABLED WITH ITS REASON
          rather than hidden when the window is too narrow for side by side —
          a vanished control reads as a missing feature, and this one's absence
          would be especially confusing because the layout has just changed
          shape on its own. */}
      <button
        type="button"
        className="hp-split__flip"
        data-testid="hp-split-flip"
        /* THE LABEL READS OFF WHAT IS DRAWN, NOT OFF WHAT IS REMEMBERED, and
           the difference is real: under the narrow fallback the choice still
           says `vertical` while the screen is stacked, and a button offering to
           "stack the panes" beside two already-stacked panes is a control
           describing a state that is not on screen. */
        aria-label={
          splitAxis === 'vertical'
            ? 'Stack the panes — active work above, conversation below'
            : 'Place the panes side by side'
        }
        title={
          splitFits
            ? splitAxis === 'vertical'
              ? 'Stack the panes (active work above, conversation below)'
              : 'Place the panes side by side'
            : 'Side by side needs a wider window — the panes are stacked until it fits'
        }
        aria-disabled={splitFits ? undefined : true}
        onClick={() => {
          if (!splitFits) return;
          setSplitChoice(splitAxis === 'vertical' ? 'horizontal' : 'vertical');
        }}
      >
        <span aria-hidden>{splitAxis === 'vertical' ? '⇕' : '⇔'}</span>
      </button>
    </div>
  );
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

  /* THE PANE REMEMBERS WHERE YOU WERE IN EACH ENTITY. Half of the one-berth
     ruling (2026-08-31) and the half that makes it not a loss: following a
     connection replaces what is in this pane, and walking back — crumb, browser
     Back or Escape — must return the reader to the offset they left, not to the
     top. See `paneScrollMemory` for why it records on capture rather than in a
     cleanup. */
  const centerHostRef = useRef<HTMLDivElement | null>(null);
  usePaneScrollMemory(centerHostRef, centerId);

  /* REGION B's entity occupant, under its trail crumb (R7). Clicks inside it
     split by R6: in-tree grows THIS trail (in place); relations open C —
     sideways lands BESIDE the selection, not over it. Closing returns B to
     the chat. */
  const centerOverride = centerId ? (
    <div className="hp-trail-host" ref={centerHostRef} data-testid="hp-center-trail-host">
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
          compact
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, ctx, centerId, rowLifecycle, primaries, launchPort],
  );

  const regions: HomeChatRegions = {
    root,
    onRoot: setRoot,
    kindCell,
    rootKindOptions,
    selectedEntityId: centerId,
    onSelectEntity: (id) => navStore.getState().openCenter(id as EntityId),
    /* NEW CHAT IS TWO FACTS, NOT ONE. `clearStack()` alone puts region B back
       on the chat — which on the dashboard is already true, so the button did
       NOTHING (measured live: same heading, same placeholder, same fourteen
       turns). The second fact is the ANSWER "no thread", which the screen reads
       as the new-chat composer once it knows it owns no thread column. Home's
       card is the only New chat on this screen now that the surface is solo, so
       it has to carry both.

       THE SECOND FACT IS NOT A NAVIGATION, and trying to make it one is how
       this stayed dead: `navigate({ root: { type: 'chats', threadId: null } })`
       writes a state the codec collapses to the bare `/home` it already was.
       It goes to the mirror instead — see `chatSelection` above. */
    onShowChat: () => {
      navStore.getState().clearStack();
      setChatSelection(null);
    },
    ...(cellBirth.refusal === null ? { onNewEntity: cellBirth.perform } : {}),
    newEntityUnavailable: cellBirth.refusal,
    onCreateKind: (kind) => birthFor(kind).perform(),
    createKindUnavailable: (kind) => birthFor(kind).refusal,
    ...(centerOverride !== undefined ? { centerOverride } : {}),
    routeThreadId,
    /* The open conversation is part of the address (`/home/chat/{id}`), so
       back/forward walk threads and a conversation can be linked to.
       The mirror is written too, and first: a NAMED thread round-trips through
       the address unchanged, but `null` does not (the codec collapses it), so
       the address alone cannot carry both halves of this verb. */
    onThreadSelected: (id) => {
      setChatSelection(id);
      navStore.getState().navigate({
        view: 'home',
        root: { type: 'chats', threadId: id },
      });
    },
    /* The Cockpit's non-entity stages are part of the address too (`?stage=`,
       replacing `?graph=full`/`?gf=`): opening PUSHES history, so Back leaves
       the stage, a reload restores it, and a viewer can send someone the fleet
       of a conversation. */
    /* The stage PANE itself is rendered by the screen, not composed here: the
       fleet and the graph are both folds of the THREAD, and the turns live in
       the screen. This layer owns only the address. */
    stage: routeStage,
    onStageChange: (next) =>
      navStore.getState().navigate({
        view: 'home',
        root: {
          type: 'chats',
          /* THE OPEN CONVERSATION, so a stage opened on it is a stage OF it —
             the address's own thread would be `null` on a cold-started
             conversation the viewer never navigated to, and the shared link
             would then name a stage of nothing. Two states here, not the
             mirror's three: an address either names a thread or it does not. */
          threadId: chatSelection ?? null,
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
  /* THE EDGE CONTROL, RE-ROLED (2026-08-30) — IT NOW MOVES THE RAIL ALONE.
     It used to be column A's separator: a `PanelResizer` when A was open, a
     reveal chevron when it was collapsed, and its words said so — "Collapse
     the list panel and the icon rail". Column A is gone from this screen (a
     kind's list IS the working area now, `.hp-listmain`), so:

       - THE DRAG HANDLE IS RETIRED, not relabelled. A separator that moves
         nothing is the same defect that was measured on the live build at
         9px x 901px, dividing nothing from nothing; the honest repair for a
         control with no subject is removal, not a new caption.
       - THE CHEVRONS SURVIVE, because the thing they collapse survives. The
         gesture (chevron, ⌘\) means COLLAPSE THE RAIL now, and the words say
         only that.

     SUBHANG'S RULING 3 STILL BINDS: a viewer who collapses without knowing
     the shortcut must be able to find the way back on screen, so the reveal
     button is drawn permanently while the rail is off — never a hover-reveal,
     never keyboard-only. It is the whole of the left edge in focus mode. */
  const railReveal = (
    <button
      type="button"
      className="hp-railreveal"
      title="Show the icon rail (⌘\)"
      aria-label="Show the icon rail"
      aria-expanded={false}
      aria-controls="home-rail"
      data-testid="hp-rail-reveal"
      onClick={() => props.onToggleFocus?.()}
    >
      <span aria-hidden>›</span>
    </button>
  );

  /* THE ICON RAIL (R4) — the switcher's twin: same groups, same select, no
     view rows. No row is active while Chats is the root; chats live in the
     list header's own cell, not the rail. */
  /* Focus mode takes the rail off the row entirely rather than collapsing it
     to its 72px icon strip — "collapsing entire left panel AND icon rail" was
     the ask, and a 72px strip left standing is not a collapse. What stands in
     its place is the reveal chevron and nothing else. */
  const rail = focus ? railReveal : (
    <>
      <HomeRail
        groups={navigationGroups}
        activeKind={root === CHATS_ROOT ? null : root}
        onSelect={setRoot}
        /* `onHome` GONE 2026-08-31 — the rail carried a Home row eight inches
           from the top bar's Home tab (owner: "There are two homes make sure
           one home is there"). `HomeRail`'s prop docblock carries the removal
           and the verification behind it. */
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((collapsed) => !collapsed)}
      />
      {/* The chevron rides the rail's OUTER edge — the boundary of the thing
          it moves — exactly where the old one rode column A's. */}
      <div className="hp-railedge" data-testid="hp-rail-separator">
        <button
          type="button"
          className="hp-railedge__collapse"
          title="Collapse the icon rail (⌘\)"
          aria-label="Collapse the icon rail"
          aria-expanded
          aria-controls="home-rail"
          data-testid="hp-rail-collapse"
          onClick={() => props.onToggleFocus?.()}
        >
          <span aria-hidden>‹</span>
        </button>
      </div>
    </>
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
        /* The split's two extents, one per axis. Only the one matching
           `data-split` is read by any rule, but both are published: a custom
           property that changes on a flip would make the flip a paint of two
           different numbers rather than a change of which track is used. */
        '--hp-side-w': sideCollapsed ? '0px' : `${sideWidth}px`,
        '--hp-side-h': sideCollapsed ? '0px' : `${sideHeight}px`,
      } as React.CSSProperties}
    >
      <HomePage
        data={data}
        chat={props.chat(openEntity, regions)}
        navigationGroups={navigationGroups}
        activeKind={root === CHATS_ROOT ? null : root}
        onOpenKind={setRoot}
        rail={rail}
        splitter={splitter}
        splitAxis={splitAxis}
        sideCollapsed={sideCollapsed}
        focus={focus}
        {...(aside ? { aside } : {})}
        /* A CARD ON THE DASHBOARD OPENS IN THE OTHER PANE, NOT IN THE ASIDE
           (owner, 2026-08-31: "session or task when clicking how it shows —
           ideally horizontal split like this?").
         *
         * IT USED TO BE `openEntity`, which is `openRight` — region C, the
         * 440px column bolted onto the right edge. That is the wrong berth for
         * this gesture and the owner's words say why: an ACTIVE card is the
         * thing you came to Home to work on, and it was opening into the
         * narrowest column on the screen while the widest pane went on showing
         * a conversation you had just left.
         *
         * `openCenter` is the EXISTING plumbing for exactly this and it needed
         * no new path: it sets region B's trail, `centerOverride` is built from
         * it thirty lines above, and the chat surface already renders that in
         * its centre berth (`centre = centerOverride ?? stagePane`) — which IS
         * the other pane, at that pane's full height, with the ACTIVE grid
         * still beside or above it. Nothing new is mounted; one call changes.
         *
         * THE ASIDE STAYS, AND IT STAYS FOR ONE CASE ONLY: an entity reached
         * from INSIDE the conversation — a ledger row, a read line, a chip.
         * `props.chat(openEntity, …)` still hands the chat surface `openRight`,
         * because R6's law there is that sideways lands BESIDE the thing you
         * are reading and never over it: evicting the transcript you clicked
         * the reference in would lose your place. Two gestures, two berths,
         * and the difference is whether the click came from the dashboard or
         * from the conversation. */
        onOpenEntity={(id) => navStore.getState().openCenter(id as EntityId)}
        onOpenWorkspace={props.onOpenWorkspace}
        /* THE THREE CREATE VERBS (owner, 2026-08-30): "have one create new
           chat, New SESSIONS AND New Task first". These are the SAME handlers
           the chat surface and the list header already use — `regions` owns
           them — so Home reaches them rather than growing a second set. */
        onNewChat={regions.onShowChat}
        onCreateKind={regions.onCreateKind}
        createKindUnavailable={regions.createKindUnavailable}
        /* THE SAME PR INDEX THE LIST PANEL ALREADY GETS (line 613). Built once
           by `useGateData` from graph nodes and edges; nothing is fetched for
           Home's sake. */
        linkedPullRequestsOf={data.linkedPullRequestsOf}
        /* THE KIND'S OWN LIST, AS THE WORKING AREA. It used to render into
           `.tch-sidebar` — a third column between the rail and the chat, which
           stated the rail's taxonomy again and which the owner had removed
           twice. Handing it to the page instead means selecting a kind
           REPLACES the dashboard with that kind's list at full width, which is
           what selecting a kind has always meant, and there is never a third
           column to remove again. */
        /* AND REGION B TRAVELS WITH IT. `centerOverride` is the entity a list
           click roots (R6a) and it reaches the screen through `regions` — but
           in kind mode the chat screen is not mounted at all, so handing it
           only to `regions` left the click with nowhere to land: the address
           gained `p=`, the row lit up, and the reader saw no change. A
           selection that renders nothing is the defect the rail itself had an
           hour earlier, one level down. So the working area holds BOTH: the
           list keeps its place and the entity opens beside it, which is the
           arrangement this screen has always had — only the container
           changed. */
        list={
          centerOverride ? (
            <div className="hp-listmain__split">
              {renderRootList(root)}
              {centerOverride}
            </div>
          ) : (
            renderRootList(root)
          )
        }
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

/**
 * MobileShell — the phone-shaped shell, and the SECOND renderer of one shared
 * navigation state.
 *
 * THE LAW THIS FILE LIVES UNDER, and the reason it is a shell and not an app:
 *
 *     THE SHELL FORKS AND THE ROUTER DOES NOT.
 *
 * One `navStore`, one codec, one browser history, two renderings. Nothing here
 * reads or writes `location`, touches `history`, or builds a `Route` — it
 * navigates by the SAME `navigateTo` the desktop shell uses, so the address is
 * produced in exactly one place for both shells. `mobile/no-router-fork.test.ts`
 * enforces that mechanically rather than trusting this docblock, because the
 * failure it prevents is invisible by inspection: two history models cannot
 * agree about what BACK means, and a phone whose back button disagrees with its
 * URL is a phone whose shared links do not work.
 *
 * WHY A SEPARATE SWITCH RATHER THAN THE DESKTOP ONE, RESHAPED. The desktop
 * centre is a three-column arrangement with a panel stack and pins. A phone has
 * one surface. That is not the same screen at a different width — it is a
 * different arrangement of the same state, which is exactly what the two-shell
 * ruling says. Reusing the SCREENS (`EntityView`, `ChannelView`, the chat home,
 * the inbox) while replacing the CHROME is the line: the screens are shared, the
 * arrangement is not.
 *
 * WHAT A SHARED LINK LANDS ON HERE. Every route the desktop understands resolves
 * to the same `activeTarget` on a phone, because both shells derive it from the
 * one store through `landingOfRoute`. So `#/s/{space}/k/tasks` opens the Tasks
 * list, `#/s/{space}/e/{id}?origin=tasks` opens that entity, and a route with no
 * phone screen SAYS SO rather than silently drawing something else — the same
 * honesty rule the desktop switch was repaired to follow.
 */
import { useState, type ReactNode } from 'react';
import type { ActorSummary, EntityId, SpaceId } from '@tm8/contract';
import { MobileFrame, MobileSurfaceProvider } from '../mobile';
import { MobileAccountSheet } from '../mobile/MobileAccountSheet';
import '../mobile/mobile-chrome.css';
import '../mobile/mobile-screens.css';
import { CopyLinkControl } from '../share';
import { Avatar, BootLoader, VectorIcon } from '../kit';
import type { Theme } from '../theme/useTheme';
import { isUnbuiltViewRef } from './view-ref-screens';
import { CHANNEL_KIND, getKind, slugOfKind, type KindArt } from '../domain';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import { CatchBoundary } from '../panels/detail/CatchBoundary';
import type { DetailReasons } from '../panels';
import type { Notice } from '../shell';
import { EntityView } from './EntityView';
import type { DispatchSelection, LaunchSelection } from './LaunchSheet';
import { ChannelView } from './ChannelView';
import { InboxView } from './InboxView';
import { openEntityOnPhone } from './openEntityOnPhone';
import { ChatHomeSurface } from '../chat-home';
import { HelpScreen } from '../help';
import type { ChatThreadSummary } from '../chat-home/types';
import type { ChatHomeL2Bridge } from '../chat-home/real-port';
import { MobileDrawer, anyUnseen } from '../mobile/MobileDrawer';
import type { GateData } from './useGateData';

export interface MobileShellProps {
  data: GateData & { pull?: (id: string) => void };
  spaceId: SpaceId;
  activeTarget: MenuTarget | null;
  navigateTo(target: MenuTarget): void;
  openEntity: EntityId | null;
  serverBaseUrl?: string;
  reasons: DetailReasons;
  onNotice(notice: Notice): void;
  viewerMemberId?: string | null;
  notices?: ReactNode;
  nodeKey: string;
  /**
   * The chat surface's L2 wiring — the space-wide thread read and the
   * write-once thread configuration. NOT optional in spirit: without it
   * `createChatHomePortFromSeam` refuses BOTH operations with a message that
   * blames the node, so a host that forgets it ships a screen that lies. It is
   * declared optional only because the fixture harnesses mount this shell with
   * no server behind it, and there the refusal is the truth.
   */
  chatBridge?: ChatHomeL2Bridge;
  chatAnchorId?: EntityId;
  spaceLabel?: string;

  /*
   * THE ACCOUNT AFFORDANCE'S INPUTS — DEF-003.
   *
   * All optional, and the header renders the control only when there is
   * something behind it. A trigger that opened a sheet with no identity, no
   * spaces to move between and no sign-out verb would be the enabled-inert
   * defect this ledger files three separate rows about.
   */
  /** The active space's actor — the face and display name in the sheet. */
  viewerActor?: ActorSummary | null;
  /** Every space this viewer can move to, for the switcher. */
  spaces?: readonly { id: string; name?: string | undefined }[];
  /**
   * Switch space. The HOST supplies the whole verb, because the desktop mount
   * pairs it with `leaveSpaceContext()` first and that pairing is a
   * privacy-lane invariant, not an implementation detail of one shell.
   */
  onSelectSpace?: (id: SpaceId) => void;
  /**
   * Navigate UP, honouring R15's replace-on-cold-arrival concession. Supplied by
   * the host because history belongs to the host — this shell must never build a
   * `Route` or touch `history` (`no-router-fork.test.ts` enforces it). Absent ⇒
   * the entity chevron is not drawn, per the honest-absence rule.
   */
  onStepUp?: (target: MenuTarget) => void;
  /** Theme, controlled by the host so the phone writes the same state the root
      stamp reads — a second `useTheme()` here would be a second truth. */
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;

  /*
   * DEF-004 — THE LAUNCH FLOW'S INPUTS, AND WHY THEIR ABSENCE WAS THE DEFECT.
   *
   * The kind arm below passes `EntityView` everything it needs to LIST and to
   * OPEN, and passed it nothing at all about launching. `EntityView` already
   * mounts the full `LaunchSheet` on `launchSubjectId` and already builds its
   * sources through `useLaunchPort`; with `onLaunchOpen` absent the port omits
   * `onFullOptions`, so a row's `Run ▸` had no sheet to open and the subject
   * was never set. The result is the row as filed: NO phone route reaches the
   * launch flow. Not only `workspace` — every route, because the one screen a
   * phone can launch from was wired for everything except launching.
   *
   * The workspace being refused forever (owner ruling) is what leaves no other
   * door, and is why this is a row rather than a nice-to-have.
   *
   * THESE ARE THE SAME SEVEN GateApp ALREADY PASSES on its desktop branch — to
   * `WorkspaceView`, to `HomeView` and to `EntityView` itself. This arm is
   * being given an existing contract, not a new one, which is the whole reason
   * a shell-owned file can take a lane's change: there is nothing here to
   * design.
   *
   * ALL OPTIONAL, AND THAT IS LOAD-BEARING RATHER THAN CAUTIOUS. Every one is
   * spread at the call site, never defaulted: `RowAction` decides whether Run
   * opens a sheet by asking whether `onOpenLaunch` EXISTS, so a
   * `?? (() => undefined)` would switch its honest refusal off and leave a
   * live-looking control that swallows the press — the identical failure the
   * switch below documents for `onOpenEntity`. A host that wires none of these
   * gets Run rendered refused-with-reason, which is true.
   */
  onLaunchOpen?(id: EntityId): void;
  launchSubjectId?: EntityId | null;
  launchRefusal?: { cause: string; detail: string } | null;
  launchInFlight?: boolean;
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: LaunchSelection): void;
  onLaunchDispatch?(request: DispatchSelection): void;
}

/*
 * ── THE TAB BAR IS GONE, AND THE DRAWER IS WHERE IT WENT ──────────────────
 *
 * `TABS` used to live here: five destinations, drawn in the frame's `tabBar`
 * region. Owner ruling 1 (2026-08-19) removed it, and the reason is a
 * measurement rather than a taste. A tab bar is a PROMISE that the places it
 * names are the places you go; this space registers 19 collection kinds and 12
 * view refs — 31 destinations — and the bar reached five of them, 16%. Docs,
 * Projects, PRs, Worktrees, Commits, Files, Artifacts, Memories, Collections,
 * Spells, Skills, Loops, Teammates, Members, Graphs, Board, Craft, Code and
 * Settings were unreachable on a phone except by pasting a URL, and the bar
 * spent ~49px plus the home-indicator inset on every screen to say so.
 *
 * THE FRAME'S `tabBar` REGION STAYS. It is a frame slot, and removing a region
 * is a different change with a different blast radius; this shell simply stops
 * filling it, and `MobileFrame` already renders every optional region
 * conditionally, so an unfilled slot leaves no dead chrome.
 *
 * WHAT REPLACES IT is `MobileDrawer` — the DESKTOP RAIL, not a phone menu:
 * same `VIEW_PRESENTATION` words, same registry marks, same order. See that
 * file's head for the whole account.
 */

/** The chevron's own geometry, on `VectorIcon`'s 16x16 grid. */
const CHEVRON_UP_ART: KindArt = ['M10.4 3.6 5.6 8l4.8 4.4'];

/** ☰, on the same 16x16 grid. The short third rule is what distinguishes it
 *  from a list icon at a glance, and it is drawn rather than typed so it
 *  inherits `currentColor` and the shell's stroke weight like every other
 *  mark in this header. */
const MENU_ART: KindArt = ['M2.5 4.25h11', 'M2.5 8h11', 'M2.5 11.75h7'];

/**
 * The screen's own name, for the header.
 *
 * ── IT MATTERS MORE NOW, NOT LESS (owner ruling 6) ────────────────────────
 *
 * With the tab bar gone there is no highlighted tab saying where you are, so
 * the header is the ONLY thing that names the screen — on every mobile screen
 * EXCEPT the chat screen, which stays bare because a blank canvas with a
 * composer needs no caption (PR #427 removed the eyebrow and title there for
 * exactly that reason).
 *
 * THE `TABS` LOOKUP THAT USED TO LEAD THIS FUNCTION IS GONE, and nothing was
 * lost with it: it returned "Home" for `dashboard`, "Tasks" for `task`,
 * "Inbox" for `inbox`, and the two lookups below already answer identically —
 * `VIEW_PRESENTATION.dashboard.label` IS "Home" and `getKind('task')
 * .labelPlural` IS "Tasks". The tab list was a third copy of two registries,
 * and deleting it makes the header read from the same tables the drawer and
 * the desktop rail read from, which is ruling 2 applied to the header.
 *
 * `VIEW_PRESENTATION` is the registry the desktop rail names its rows from, so
 * `settings` reads "Settings" and `files` reads "File browser" — the same word
 * the viewer saw on the desktop they copied the link off. Falling through to
 * the bare ref (which is what the header did first, and what the screenshot
 * caught: a lowercase `settings` under the Space name) puts an internal slug in
 * the one place the screen states where you are.
 *
 * The raw ref REMAINS on the refusal card itself, quoted, and that is correct:
 * the card explains which arrangement has no phone layout, and naming the thing
 * exactly is what makes that honest rather than vague.
 */
function titleOf(activeTarget: MenuTarget | null, nameOfEntity?: (target: { ref: string; kind: string }) => string | null): string {
  if (!activeTarget) return 'Not found';

  /*
   * DEF-034 — AN ENTITY SCREEN IS NAMED BY THE ENTITY, NOT BY ITS ID.
   *
   * This function used to fall through to `activeTarget.ref` for every entity
   * target, and on the channel route `ref` IS the uuid. Both phone captures
   * show `019fdc27-6dce-729a-b6c4-0bc5f6740974` as the screen title, with the
   * real channel name in a SECOND header directly beneath it — three stacked
   * chrome rows before any content, and the topmost one saying nothing a person
   * can read. Confirmed at 390 AND 430, which is what rules out the hydration
   * artifact that invalidates other claims on this surface.
   *
   * THE FALLBACK IS THE KIND, NEVER THE ID. If the name is not resolvable yet —
   * a cold arrival from a pasted link, before the read lands — the header says
   * "Channel". That is less information than the name and it is still TRUE,
   * where a uuid is neither. An id is not a title; `EntitySummary.title` even
   * says so in the contract ("kind-specific display title, never an ID").
   */
  if (activeTarget.type === 'entity') {
    const name = nameOfEntity?.(activeTarget);
    if (name) return name;
    const row = getKind(activeTarget.kind);
    if (row.kind === activeTarget.kind) return row.label;
    return 'Entity';
  }

  if (activeTarget.type === 'view') {
    const view = VIEW_PRESENTATION[activeTarget.ref];
    if (view) return view.label;
  }
  if (activeTarget.type === 'kind') {
    /* THE SAME LOOKUP THE RAIL USES, INCLUDING ITS MISS CHECK. `getKind` falls
       back to the `c:*` custom row rather than throwing, so a ref naming no
       registered kind comes back with a row whose `kind` is NOT the ref — and
       taking its label would print a generic word for an address the build does
       not understand. The identity test is what keeps an unknown ref honest,
       and it is copied from `GateApp`'s `presentKind` rather than reinvented. */
    const row = getKind(activeTarget.ref);
    if (row.kind === activeTarget.ref) return row.labelPlural;
  }
  return activeTarget.ref;
}

export function MobileShell(props: MobileShellProps) {
  const { data, activeTarget, navigateTo, spaceId } = props;

  /*
   * THE UP AFFORDANCE, on the store's blessed seam and nothing else.
   *
   * `useScreenStack` is a hook, so it is called UNCONDITIONALLY with a key that
   * is empty when the active target hosts no stack — an absent key selects an
   * empty stack, which is the same answer as "nothing is open" without a
   * conditional hook. Only a KIND screen hosts a stack today, exactly as
   * `backContract.intentOfRoute` decides it.
   *
   * WHY `pop()` AND NOT `history.back()`. The chevron means UP, not BACK. It
   * pops the screen stack — the desktop's Esc — and `GateApp`'s step-up sync
   * turns that into the address write, which for a cold arrival from a pasted
   * link is a REPLACE. So a viewer who followed a shared link taps up, lands on
   * the list with no phantom history entry, and their phone's own back gesture
   * then honestly leaves the app. `history.back()` here would exit the app at
   * that depth instead of showing the list, and it would be a second thing that
   * decides what BACK means. There is one history, and this is not it.
   */
  const stackKey = activeTarget?.type === 'kind' ? screenKeyOf.kind(activeTarget.ref) : '';
  const screenStack = useScreenStack(stackKey);

  /*
   * UP FOR AN ENTITY SCREEN — a SYNTHESIZED parent, not a pop.
   *
   * THE GAP THIS CLOSES. `stackKey` is empty for anything that is not a KIND
   * target, so an `entity` target selects the empty stack, `selected` is null,
   * and THE CHEVRON DID NOT RENDER AT ALL. A cold arrival on a channel link —
   * `#/s/{space}/e/{channelId}`, the single most shared address in this product
   * — had no up affordance whatsoever. The tab bar was the only navigation, and
   * it does not mean "up", it means "go to a destination".
   *
   * The existing mechanism was never wrong; it was UNDEFINED here. Pop needs a
   * stack, and only a kind screen hosts one. An entity's parent is not on a
   * stack — it is a FACT ABOUT THE ENTITY: its kind's collection. So this
   * derives that parent instead of popping to it.
   *
   * IT IS A STEP-UP, NOT A NAVIGATION, and the distinction is R15. `navigateTo`
   * pushes; pushing here would put the entity behind you, so the phone's back
   * gesture would return to it and trap a link-follower in a two-item loop with
   * no exit — the exact failure R15 exists to prevent, re-created on the exact
   * entry path it was written for. `onStepUp` carries the replace concession.
   *
   * NOT DRAWN WHEN THE KIND HAS NO COLLECTION. `slugOfKind` is null for the
   * `special` and `anchored` strategies (`voice_channel`, `message`), which have
   * no `k/` view BY DESIGN — so there is genuinely nowhere up to go, and a
   * chevron there would be a control that cannot perform. Absent, not inert.
   */
  const upTarget: MenuTarget | null =
    activeTarget?.type === 'entity' && slugOfKind(activeTarget.kind)
      ? { type: 'kind', ref: activeTarget.kind }
      : null;
  const showUp = Boolean(screenStack.selected) || Boolean(upTarget && props.onStepUp);
  /*
   * DEF-034's lookup, SUMMARY FIRST and detail as the fallback — the same order
   * `capabilitiesOf` documents and for the same reason. A channel reached from
   * the rail is already a row in the list read; one reached from a pasted link
   * may only ever exist in the detail cache. Asking one source alone answers
   * `undefined` for the other arrival, which is precisely the cold-link case
   * this row is about.
   */
  const title = titleOf(activeTarget, (target) => {
    const row = data.rowsFor(target.kind)(undefined).find((r) => r.id === target.ref);
    return row?.title ?? data.detailOf(target.ref)?.title ?? null;
  });
  const [accountOpen, setAccountOpen] = useState(false);

  /*
   * THE SHEET HOST — always mounted, so a screen has somewhere to portal to.
   *
   * A ref would not do: the host element has to be in STATE, because a screen
   * deciding whether to render its sheet reads this on the render AFTER the
   * host mounts, and a ref mutation notifies nobody. With a ref the first
   * sheet a viewer opened would portal into `null` and simply not appear —
   * once, per mount, which is the hardest possible version of this bug to
   * catch. `useState` as a callback ref re-renders when the node arrives.
   *
   * Kept mounted rather than rendered on demand for the same reason a portal
   * was chosen at all: `createPortal` needs its container to EXIST before the
   * content that targets it renders, and an on-demand host inverts that order.
   * `mobile-screens.css` makes the empty host `pointer-events: none`, so an
   * always-present full-frame overlay costs nothing.
   */
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null);

  /*
   * ── THE CHAT SCREEN IS ONE SURFACE, AND ITS INVENTORY LIVES IN A SHEET ────
   *
   * Home IS the chat (`ChatHomeSurface`, the `dashboard` arm below). The
   * desktop screen puts its thread inventory in a permanent left column; at
   * 390px that column has nowhere to be, so it collapsed ON TOP of the
   * conversation — a `Chats ＋` strip, a full-width search field, a refusal
   * card and a two-column empty state, all above the composer, before a single
   * word of the conversation. A phone has ONE surface; the inventory is not it.
   *
   * SO THE COLUMN IS HOSTED, NOT HIDDEN. `ChatHomeScreen` already has the seam
   * for exactly this — `soloConversation` is what Craft passes when the thread
   * column belongs to the host — and it publishes the list back through
   * `onThreadsChange` and takes the selection back through `routeThreadId`.
   * Nothing is lost and nothing is duplicated: the same rows, in a sheet, one
   * tap away behind the header's ☰. That is the shell's own law (screens are
   * shared, the ARRANGEMENT is not) applied to the one screen that had not had
   * it applied yet.
   *
   * THE SELECTION IS LOCAL STATE AND NOT AN ADDRESS, and that is a known gap
   * rather than a preference: the phone has no `?thread=` route today, so a
   * chosen thread survives neither a reload nor a shared link. Making it
   * addressable is a route change in `nav-targets`/`landingOfRoute` — shared
   * with the desktop, since one codec serves both shells — and it is
   * deliberately not smuggled in here.
   *
   * ── `threadId` MIRRORS THE SCREEN'S SELECTION, IT DOES NOT MERELY PROPOSE ONE
   *
   * It used to be write-only: the shell pushed a selection down through
   * `routeThreadId` and never heard what the screen actually landed on. Two of
   * the screen's own behaviours make a selection the shell did not choose —
   * cold start opens the most recent conversation, and a first send adopts the
   * root it just created — and after either of them the shell believed `null`
   * while a real conversation was on screen.
   *
   * THAT IS WHY "New conversation" DID NOTHING (reported on task 01a01c3f:
   * "New conversation is not creating a new conversation and replacing current
   * chat"). The verb is `setThreadId(null)`, and from a state React already
   * held as `null` that is not a change: no re-render, no new `routeThreadId`,
   * so the screen's adopt effect — which keys on exactly that prop — never ran
   * and the open conversation stayed open. The button was correct and inert.
   *
   * `onSelectionChange` closes the loop, and it fixes the drawer's highlight in
   * the same stroke: with the shell holding the REAL selection, the row for the
   * conversation you are reading is the row that reads as current. Feedback
   * only — the screen adopts `routeThreadId`, publishes the resolved selection
   * back, and a publish that matches what was pushed sets no state, so the two
   * settle in one round rather than ringing.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<EntityId | null>(null);
  const onChatScreen = activeTarget?.type === 'view' && activeTarget.ref === 'dashboard';

  /*
   * ── UNSEEN HAD TO SURVIVE THE TAB BAR (owner ruling 5) ──────────────────
   *
   * Inbox left the always-visible row, so without this the drawer would be a
   * strictly worse Inbox and the whole change would be a regression. The ☰
   * carries the indicator; the drawer's kind rows carry their own numbers.
   *
   * THREE-VALUED, and that is the point: `null` means nothing could be counted
   * — `useGateData` swallows a failed `spaces.counts` so the counters can never
   * cost the boot — and a dot there would claim an all-clear nobody
   * established. ABSENT IS NOT ZERO, and it is not "unread" either.
   */
  const unseen = anyUnseen(data.countsFor);

  /* The link affordance is in the header for the same reason it is in the
     desktop tab bar: the thing being shared is THE PAGE. On a phone it matters
     more, not less — a phone is where links are received and forwarded. */
  const header = (
    <div className="mobile-header" data-chrome={onChatScreen ? 'chat' : undefined}>
      {/* ☰ — ON EVERY SCREEN NOW (owner ruling 4), because it is the only
          navigation this shell has left. It used to appear on the chat screen
          alone and open the conversation inventory; the drawer's FIRST section
          is that same inventory, so nothing was taken away — the control's
          reach was widened and its contents grew by 26 destinations.

          IT CARRIES THE UNREAD FACT. `unseen === true` draws the indicator;
          `false` and `null` both draw nothing, and they are different states
          for a reason the `unseen` block above states in full. */}
      <button
        type="button"
        className="mobile-header__menu"
        data-testid="mobile-drawer-menu"
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        aria-label={unseen === true ? 'Navigation, unread items' : 'Navigation'}
        onClick={() => setDrawerOpen(true)}
      >
        <VectorIcon paths={MENU_ART} size={20} strokeWidth={1.6} />
        {unseen === true ? <span className="mobile-header__dot" aria-hidden /> : null}
      </button>
      {/* Rendered ONLY when something is open. A chevron at a screen root would
          be dead chrome that either does nothing or leaves the app; the ☰
          beside it is the navigation there. The two coexist and mean different
          things — ☰ goes to a destination, the chevron goes UP one screen —
          which is exactly the distinction the tab bar could never draw. */}
      {showUp && !onChatScreen ? (
        <button
          type="button"
          className="mobile-header__back"
          /* The label names WHERE UP GOES, which for an entity is its
             collection and for an open entity on a kind screen is that screen.
             "Up to Tasks" is a promise the press then keeps. */
          aria-label={`Up to ${upTarget ? getKind(upTarget.ref).labelPlural : title}`}
          onClick={() => {
            if (screenStack.selected) {
              screenStack.pop();
              return;
            }
            if (upTarget) props.onStepUp?.(upTarget);
          }}
        >
          <VectorIcon paths={CHEVRON_UP_ART} size={20} strokeWidth={1.6} />
        </button>
      ) : null}
      {/* NOT ON THE CHAT SCREEN. The eyebrow + "Home" pair names a destination
          the tab bar is already showing as current, and the screen below it is
          a blank canvas whose whole job is to invite a first message. Two rows
          of chrome captioning an empty page is the clutter this screen was
          reported for. Every other screen keeps them: there the title names
          something the tab bar cannot (a channel, an entity, a refusal). */}
      {onChatScreen ? null : (
      <span className="mobile-header__titles">
        <span className="mobile-header__space">{props.spaceLabel ?? 'tm8'}</span>
        {/*
          DEF-033 — THE `title=` IS GONE, AND NOT REPLACED WITH ANOTHER TOOLTIP.

          It read `title={title}` and its comment said truncation must hide text
          rather than destroy it. The intent was right; the mechanism is dead on
          the device this shell exists for. `title=` renders on HOVER, and a
          phone has no hover — so the one recourse a truncated header offered
          was unreachable by every user of it. The shell was shipping exactly
          the pattern DEF-032 asks the lanes to remove.

          Nothing is destroyed by removing it: the title is now the entity's
          NAME rather than its uuid (see `titleOf`), the same string is on the
          screen below, and the full address is one tap away in Copy link. A
          truncated name that is legible-as-far-as-it-goes is an honest fold. A
          tooltip nobody can open is decoration that claims to be a recourse.
        */}
        <span className="mobile-header__title">{title}</span>
      </span>
      )}
      {/* COPY LINK IS IN THE DRAWER NOW (owner ruling, 2026-08-19).
          It sat here beside the title, and the reasoning held — the thing being
          shared is a PAGE — but the header is 53px shared by five things and
          this is the one of them nobody reaches for in a session. It is a verb
          about the current screen, which is exactly what the drawer is a list
          of, and it costs the title band nothing there. The `onChatScreen`
          exemption travels with it (see `share` below): the chat screen's page
          is the space's front door, an address every viewer already has. */}
      {/*
        DEF-003 — THE ACCOUNT AFFORDANCE.

        Rendered only when the host handed down something to put behind it. On a
        `GateApp` mounted without an auth gate (every existing test) there is no
        actor and no sign-out verb, so there is no control — the same rule
        `auth/AccountMenu` follows when it returns null outside a gate.
      */}
      {props.viewerActor ? (
        <button
          type="button"
          className="mobile-header__account"
          data-testid="mobile-account-menu"
          aria-haspopup="dialog"
          aria-expanded={accountOpen}
          aria-label="Account, space and appearance"
          onClick={() => setAccountOpen(true)}
        >
          <Avatar
            actorId={props.viewerActor.id}
            provenance={props.viewerActor.isAgent ? 'agent' : 'human'}
            label={props.viewerActor.displayName}
            size={22}
            src={props.viewerActor.avatar ?? null}
          />
        </button>
      ) : null}
    </div>
  );

  return (
    /* NO `tabBar`. The region is still a frame slot and `MobileFrame` renders
       it conditionally, so an unfilled one leaves no dead band — see the block
       where `TABS` used to be for why it is unfilled. */
    <MobileFrame
      header={header}
      notices={props.notices}
      sheet={<div className="msheet-host" ref={setSheetHost} />}
    >
      {/* INSIDE THE BOUNDARY, so a screen that throws while a sheet is open
          still loses only the screen. The host itself is a frame region and
          sits outside — a boundary that took the sheet host down with the
          screen would leave the next screen unable to open one at all. */}
      <CatchBoundary label="mobile-view">
        <MobileSurfaceProvider sheetHost={sheetHost}>
          {screenFor(props, {
            soloConversation: true,
            routeThreadId: threadId,
            onThreadsChange: setThreads,
            onSelectionChange: setThreadId,
          })}
          {/* THE DRAWER. Rendered beside the screen rather than inside it,
              exactly like the account sheet below: it portals through the
              surface context, and a panel that unmounted with its screen could
              not survive the screen changing under it — which for a NAVIGATION
              panel is the whole job, since navigating is what changes the
              screen.

              PICKING A CONVERSATION ALSO NAVIGATES. The thread selection is
              shell state (there is still no `?thread=` route, see above), so a
              thread picked from the Docs screen has to send the viewer to the
              chat screen or the pick would silently do nothing visible. */}
          {drawerOpen ? (
            <MobileDrawer
              spaceLabel={props.spaceLabel ?? 'tm8'}
              activeTarget={activeTarget}
              navigateTo={navigateTo}
              countsFor={data.countsFor}
              /* The header's Copy link, re-hosted. Built HERE because the
                 address is the shell's answer — `activeTarget` and the open
                 entity are shell state — and handed over as an element so the
                 drawer does not acquire a second opinion about routing. */
              share={
                onChatScreen ? null : (
                  <CopyLinkControl
                    spaceId={spaceId}
                    target={activeTarget ?? { type: 'view', ref: 'workspace' }}
                    openEntity={props.openEntity}
                  />
                )
              }
              threads={threads}
              selectedThreadId={threadId}
              onSelectThread={(id) => {
                setThreadId(id);
                if (!onChatScreen) navigateTo({ type: 'view', ref: 'dashboard' });
                setDrawerOpen(false);
              }}
              onNewThread={() => {
                setThreadId(null);
                if (!onChatScreen) navigateTo({ type: 'view', ref: 'dashboard' });
                setDrawerOpen(false);
              }}
              {...(props.viewerActor
                ? {
                    onOpenAccount: () => setAccountOpen(true),
                    accountName: props.viewerActor.displayName,
                  }
                : {})}
              onDismiss={() => setDrawerOpen(false)}
            />
          ) : null}
          {/*
            THE ACCOUNT SHEET IS RENDERED INSIDE THE PROVIDER, because
            `MobileSheet` portals through the surface context and there is no
            host to portal into outside it. It is a sibling of the SCREEN rather
            than a child, so it survives a screen change — and it is inside the
            boundary, so a screen that throws while the sheet is open still
            loses only the screen.

            THE OPTIONAL VERBS ARE SPREAD, NEVER DEFAULTED. A
            `?? (() => undefined)` would hand the sheet a handler that exists
            and does nothing, switching off the very checks that keep its
            controls honest — the exact failure this file's switch docblock
            documents below for `onOpenEntity`. Absent stays absent.
          */}
          {accountOpen && props.viewerActor ? (
            <MobileAccountSheet
              actor={props.viewerActor}
              spaces={props.spaces ?? []}
              activeSpaceId={spaceId}
              {...(props.onSelectSpace ? { onSelectSpace: props.onSelectSpace } : {})}
              {...(props.theme && props.onThemeChange
                ? { theme: props.theme, onThemeChange: props.onThemeChange }
                : {})}
              onDismiss={() => setAccountOpen(false)}
            />
          ) : null}
        </MobileSurfaceProvider>
      </CatchBoundary>
    </MobileFrame>
  );
}

/**
 * Route → phone screen. Total over what the phone can render, and HONEST about
 * what it cannot.
 *
 * The desktop switch used to end in a silent fallthrough to the workspace, and
 * repairing that was the change that made this whole lane safe to build on. This
 * switch does not repeat the mistake: an arrangement with no phone screen says
 * so and offers the tabs, rather than drawing something the address does not
 * name.
 */
/**
 * What the chat screen needs from the shell that the ROUTE does not carry: the
 * hosted-column arrangement, the selected thread, and the way the list gets
 * back out to the sheet that draws it. A second parameter rather than three
 * more `MobileShellProps` — these are the shell's own internal state, not
 * something a host wires, and putting them on the public props would invite one.
 */
interface ChatHosting {
  readonly soloConversation: true;
  readonly routeThreadId: EntityId | null;
  readonly onThreadsChange: (threads: readonly ChatThreadSummary[]) => void;
  /** The screen's RESOLVED selection coming back up — see the block over
   *  `threadId` for why a one-way push left "New conversation" inert. */
  readonly onSelectionChange: (rootId: EntityId | null) => void;
}

function screenFor(props: MobileShellProps, chat: ChatHosting): ReactNode {
  const { data, activeTarget, reasons, onNotice } = props;
  /* Each line is its own ELEMENT, not a bare text node. `.mobile-empty`'s
     styling leads with the first child — the statement in the serif face, the
     explanation under it — and a text node is not a child a selector can
     reach, so an unwrapped string would silently render as the fallback body
     copy while looking exactly like it had been styled. */
  if (!data.ready)
    return (
      /*
       * DEF-038 — "Loading…" IS NOT AN HONEST LOADING STATE ON A PHONE.
       *
       * This shell hydrates by paging the space's whole event log: over 25s on
       * a large space, and on cellular the reader is looking at one word on
       * blank paper for all of it with nothing saying whether it is working.
       * It has already cost this program evidence — one capture in the
       * before-run photographed exactly this and is VOID, and a second came
       * back under-hydrated at 390 against 626 chars at 430 on the same build.
       *
       * WHAT IS FIXED HERE AND WHAT IS NOT, stated plainly rather than implied.
       * The PAGING STRATEGY is not fixed here; it lives in `src/data/` and it
       * is a real piece of work that nobody owns yet — `connection.ts`
       * `prepareSpace()` walks the space's whole event log 500 rows at a time,
       * SERIALLY, before `ready` can flip, and this space's log is ~100k rows,
       * which is ~200 round trips a phone pays over cellular. What is fixed
       * here is the shell's own honesty while it pays them.
       *
       * AND HONEST NO LONGER MEANS STATIC. Two sentences on blank paper for
       * thirty seconds is honest and still reads as a dead app: nothing on the
       * screen MOVES, so there is no evidence the wait is a wait rather than a
       * hang. The desktop gate has answered this since the kit landed —
       * `BootLoader`, the tm8 wordmark with the ribbon 8 turning on its own
       * axis — and the phone, the device that waits LONGEST, was the one
       * surface not using it.
       *
       * `BootLoader`'s own header scopes it to boot and boot only, and this IS
       * boot: `data.ready` is false because `openSpace` + `hydrate` have not
       * returned, so there is no space, no menu and no geometry a skeleton
       * could honestly trace. Same state, same component. It carries its own
       * `role="status"` + live region, so a screen reader is still told rather
       * than left on a silent screen.
       *
       * The wrapper is not decoration. `main.mobile-frame__content` is a
       * BLOCK (see `mobile-screens.css` §1), so `.kit-boot`'s `flex: 1`
       * resolves to nothing there and the mark would sit jammed against the
       * header instead of centred. `.mobile-boot` is the flex column that
       * gives it a height to fill — the same trick `.mobile-empty` uses, kept
       * separate because that class also styles a first-child statement in
       * the serif and would restyle the loader's own parts.
       */
      <div className="mobile-boot" data-testid="mobile-loading">
        <BootLoader
          label="catching up"
          detail="Reading this space's history — on a large space over a slow connection this takes a while."
        />
      </div>
    );
  if (!activeTarget) {
    return (
      <div className="mobile-empty" data-testid="mobile-unrouted">
        <p>This link doesn’t name a screen this build has.</p>
        <p>Nothing was opened in its place.</p>
      </div>
    );
  }

  if (activeTarget.type === 'kind') {
    return (
      <EntityView
        data={data}
        kind={activeTarget.ref}
        reasons={reasons}
        onNotice={onNotice}
        {...(props.serverBaseUrl ? { serverBaseUrl: props.serverBaseUrl } : {})}
        {...(props.viewerMemberId ? { viewerMemberId: props.viewerMemberId } : {})}
        onKindChange={(next) => props.navigateTo({ type: 'kind', ref: next })}
        /*
         * DEF-045 — THE LAYOUT MODE IS ROUTE STATE, AND THIS ARM WAS DROPPING IT.
         *
         * `EntityView` declares `mode` and `groupBy`/`onGroupBy`, the desktop
         * host threads them, and this arm passed none of them: a phone URL
         * carrying `mode=board` rendered the LIST. The address and the screen
         * disagreed, on the one device where the address is how the screen was
         * arrived at.
         *
         * `nav-targets.ts` has carried `mode` on a kind view all along; it was
         * threaded on one shell and dropped on the other. This is the same law
         * this file opens with — one navigation state, two renderings — and the
         * phone rendering was quietly holding a second copy of part of it.
         *
         * THE WRITE HALF IS GONE (2026-08-19): the layout toggle was removed
         * from every entity list, on this shell and the desktop alike, so the
         * address is the only thing that can ask for a mode. That also retires
         * DEF-013, which was that toggle's touch target.
         */
        {...(activeTarget.mode !== undefined ? { mode: activeTarget.mode } : {})}
        {...(activeTarget.groupBy !== undefined ? { groupBy: activeTarget.groupBy } : {})}
        onGroupBy={(g) => props.navigateTo({ ...activeTarget, groupBy: g })}
        /*
         * DEF-004 — THE PHONE'S DOOR INTO LAUNCH, and it is THIS arm because
         * there is nowhere else it could be.
         *
         * The workspace is refused forever by owner ruling, and this is the
         * only phone screen that hosts a list of launchable entities. So the
         * route is: the Tasks tab → a task row's `Run ▸` → the full sheet.
         *
         * ONE TAP, NOT TWO, and that falls out of a rule that already exists
         * rather than a phone special case. `RowAction` reads
         * "the sheet OUTRANKS the inline expand": where a host mounted the
         * full sheet, Run opens it directly and the tile never expands into the
         * anchored quick-config card. That card is a desktop popover — it hangs
         * off a 22px cluster button and does not survive the trip to 390px —
         * so the phone wanting to skip it and the existing rule wanting to skip
         * it are the same want, and no branch here has to say so.
         *
         * NOT THE LIST HEADER. `useSessionStart` omits `launch-session` from
         * its wired actions deliberately and permanently — a list header has no
         * subject to name — so the Sessions header draws no launch control at
         * all, by design and not by omission. The subject comes from a ROW.
         *
         * Every one is spread, so a host that wires none of them leaves Run
         * refused-with-reason instead of live-looking and inert.
         */
        {...(props.onLaunchOpen ? { onLaunchOpen: props.onLaunchOpen } : {})}
        {...(props.launchSubjectId !== undefined ? { launchSubjectId: props.launchSubjectId } : {})}
        {...(props.launchRefusal !== undefined ? { launchRefusal: props.launchRefusal } : {})}
        {...(props.launchInFlight !== undefined ? { launchInFlight: props.launchInFlight } : {})}
        {...(props.onLaunchCancel ? { onLaunchCancel: props.onLaunchCancel } : {})}
        {...(props.onLaunchSubmit ? { onLaunchSubmit: props.onLaunchSubmit } : {})}
        {...(props.onLaunchDispatch ? { onLaunchDispatch: props.onLaunchDispatch } : {})}
      />
    );
  }

  if (activeTarget.type === 'entity') {
    /*
     * DEF-035 — THE KIND CHECK THE DESKTOP ALREADY HAS AND THIS SWITCH DID NOT.
     *
     * This arm tested `type === 'entity'` and nothing else, so EVERY entity
     * target rendered `ChannelView` — a voice room would have opened a message
     * feed against something that has none, and the feed would have looked
     * EMPTY rather than wrong. That is the misroute class this file's own
     * docblock says the desktop switch was repaired for; the repair landed
     * there (`GateApp`'s `voiceKind` guard) and not here.
     *
     * `landingOfRoute` carries the kind on the target explicitly, and its
     * comment says why: "Carrying the kind explicitly is what stops the
     * `type === 'entity'` branch from rendering a message feed for something
     * that has none." The fact was already on the target; this arm just was not
     * reading it.
     *
     * EVIDENCE STATUS, because it belongs beside the code and not only in the
     * ledger: this is the one row in the ledger NOT grounded in a capture. No
     * voice-room route was driven by the before-run. It is filed and fixed on a
     * code seam, honestly labelled as such, and the row does not close until
     * the build service drives a voice-room target and confirms this guard.
     *
     * The copy is the desktop's, verbatim, on purpose — two shells refusing the
     * same thing in two different sentences is how a product starts sounding
     * like two products.
     */
    if (activeTarget.kind !== CHANNEL_KIND) {
      return (
        <div className="mobile-empty" data-testid="mobile-unbuilt-voice-view">
          <p>“{titleOf(activeTarget)}” doesn’t have a phone screen in this build.</p>
          <p>
            This entity exists and the link is a real address — there is just no screen behind it
            here. Nothing is hidden.
          </p>
        </div>
      );
    }
    return (
      <ChannelView
        data={data}
        channelId={activeTarget.ref as EntityId}
        reasons={reasons}
        onNotice={onNotice}
        {...(props.serverBaseUrl ? { serverBaseUrl: props.serverBaseUrl } : {})}
      />
    );
  }

  /*
   * DEF-005 — THE PHONE CAN NOW OPEN AN ARBITRARY ENTITY, AND THE REASON IT
   * COULD NOT IS WORTH KEEPING RATHER THAN DELETING.
   *
   * What stood here before was a correct diagnosis with the wrong conclusion.
   * The diagnosis: `InboxScreen` renders its rows disabled-WITH-REASON, and
   * `EntityChip` renders an inert badge, by asking whether the callback EXISTS
   * — so passing `() => undefined` is not "no handler", it is a handler that
   * does nothing, and it switches the honest states off and turns every inbox
   * row into a live-looking control that swallows the press. That is exactly
   * right and it is why nothing is defaulted below.
   *
   * The conclusion — "wiring them for real is a phone workspace, not a
   * callback" — read the desktop's IMPLEMENTATION as the requirement. The
   * desktop opens an entity by navigating to the workspace and pushing a bare
   * id onto its panel stack, and the workspace is refused forever on a phone,
   * so the move looked impossible. But the phone already has the two halves it
   * needs and has had since the gate landed: a KIND SCREEN THAT HOSTS A STACK,
   * and the header chevron that pops it (CONTRACT.md §5). Navigate to the kind
   * and seed the id onto that screen's stack, which is precisely what the gate's
   * own DEF-002 fix does for a pasted `e/{id}` link (`GateApp.tsx:657`). The
   * shared store is the seam; `mobile/index.ts` says so in terms.
   *
   * WHAT IT COST TO GET WRONG, recorded because the shape is the point: the
   * before-run scored the inbox a PASS. Rows that cannot be opened have nothing
   * under 44px, `entity-detail-bare-link` reported `tapUnder44 = 0 of 6`, and
   * absence measured as health on one of the five destinations the tab bar
   * promises.
   *
   * `openEntityOnPhone` returns FALSE for a kind with no `k/` screen — the
   * `special`/`anchored` strategies have no route by design — and the reader is
   * told so out loud. Silence there would be RULE R13's failure verbatim: a
   * control that renders, presses and does nothing.
   *
   * STILL OPEN, AND NOT SILENTLY: chat's tool-call chips are the other consumer
   * this row names. They are Lane A's surface and Lane A consumes this seam;
   * this arm wires the inbox half only.
   */
  switch (activeTarget.ref) {
    case 'inbox':
      return (
        <InboxView
          seam={data.seam}
          onOpenEntity={(id, kind) => {
            if (openEntityOnPhone(props.navigateTo, id, kind)) return;
            onNotice({
              id: `open-entity:${id}`,
              tone: 'info',
              title: getKind(kind).label,
              body: 'This kind has no phone screen in this build, so there is nowhere to open it. The link still names it.',
              ttlMs: 6000,
            });
          }}
        />
      );
    case 'help':
      /* HELP IS ON THE PHONE, and that is the point of it. The refusal card
         says "this still works on a desktop" — an honest thing to say about a
         three-pane workspace and an absurd one to say about the screen that
         explains what tm8 is. It is also the only screen here whose content is
         a DOCUMENT, which is the one shape a narrow column suits.
         `stacked` makes it one column: the contents, then a page over them
         with a back verb. */
      return <HelpScreen stacked />;
    case 'dashboard':
      return (
        <ChatHomeSurface
          seam={data.seam}
          spaceId={props.spaceId}
          nodeKey={props.nodeKey}
          {...(props.chatBridge ? { bridge: props.chatBridge } : {})}
          {...(props.chatAnchorId ? { anchorId: props.chatAnchorId } : {})}
          /* ONE SURFACE: the thread column is the header's sheet, not a band
             stacked above the conversation. See `ChatHosting` and the state
             that builds it. */
          soloConversation={chat.soloConversation}
          routeThreadId={chat.routeThreadId}
          onThreadsChange={chat.onThreadsChange}
          onSelectionChange={chat.onSelectionChange}
          viewerName={props.viewerActor?.displayName}
          {...(props.viewerActor ? { viewerId: props.viewerActor.id } : {})}
        />
      );
    default:
      /* WORKSPACE, GRAPH, GIT, FILES, MESSAGES, SETTINGS, FEED — real screens
         with no phone arrangement yet. Named individually rather than lumped,
         because "not built for this screen size" is a different statement from
         "does not exist", and a viewer who followed a link here should be told
         which one it is. The link itself is still valid on a desktop. */
      return <RefusalCard target={activeTarget} navigateTo={props.navigateTo} />;
  }
}

/**
 * THE REFUSAL CARD — the shell's honesty mechanism, and it was lying.
 *
 * ── DEF-012: THE SENTENCE THAT WAS FALSE ─────────────────────────────────
 *
 * The card said, for EVERY default-arm route, "This link still works on a
 * desktop — nothing about it is broken." On `feed` that is false:
 * `view-ref-screens.ts` classifies `feed` as `unbuilt`, meaning this build has
 * no screen for it ANYWHERE. So the one card whose entire job is to tell the
 * truth about what is missing was sending readers to a desktop to look for a
 * screen that is not there either.
 *
 * S1 for a two-sentence fix, and deliberately: a dishonest honesty card is
 * worse than no card. A blank screen tells you nothing; this told you something
 * wrong and gave you an errand.
 *
 * THE FIX IS STRUCTURAL, NOT A REWORDED STRING. The copy is now DERIVED from
 * the same classification the desktop switch branches on, so a ref classified
 * `unbuilt` cannot render the "works on a desktop" sentence — not because
 * somebody remembered, but because the sentence is not reachable from that
 * branch. That is the machine floor the row asks for: the next `unbuilt` ref
 * added to the contract gets the honest copy for free, and nobody has to
 * notice.
 *
 * ── DEF-043: A REFUSAL THAT IS NOT A DEAD END ────────────────────────────
 *
 * `files` refuses because the 1084-line explorer has no phone arrangement — and
 * that stays true and stays deferred. But `file` is a registered kind and the
 * phone's kind route demonstrably mounts, so there IS a way to see your files
 * on this device and the card was not offering it.
 *
 * THE CARD STILL REFUSES. This is an affordance BESIDE the refusal, never
 * instead of it: the statement stays, the button is additional, and it names
 * what it actually opens ("as a list") rather than pretending the explorer
 * arrived. Silently aliasing `files` to `k/file` would have made this card a
 * second lie one row after fixing the first — which is precisely the standard
 * DEF-012 sets.
 *
 * ── WHY `board` HAS NO BUTTON HERE, WHICH IS A DECISION AND NOT AN OMISSION ─
 *
 * DEF-042 proposed the same treatment for `board` ("Open Tasks in board
 * layout") and it is APPROVED in principle and NOT BUILT. Triage found that
 * `board`'s worst right edge is 2201px at tablet-768 AND 2201px at
 * desktop-1440 — identical across a 672px difference in viewport, and the only
 * route at either width reaching it. A rightmost element at a FIXED x does not
 * become narrow when handed a 390px phone, so the button as specified would
 * have sent a reader out of an honest refusal into the worst-overflowing
 * surface in the dataset. It waits on a capture of `k/tasks` in board MODE —
 * which DEF-045 above is a precondition for, since until the mode is threaded
 * the phone could not enter board mode to be measured at all.
 */
function RefusalCard(props: { target: MenuTarget; navigateTo(target: MenuTarget): void }): ReactNode {
  const { target, navigateTo } = props;
  const unbuilt = isUnbuiltViewRef(target.ref);

  return (
    <div className="mobile-empty" data-testid="mobile-not-on-phone" data-refusal={unbuilt ? 'unbuilt' : 'no-phone-layout'}>
      {unbuilt ? (
        <>
          <p>“{target.ref}” isn’t built in this app yet.</p>
          {/* NOT "try a desktop". There is nothing to try. Saying the link is a
              real address is the part that is both true and useful: it means
              the reader has not mistyped anything and has nothing to chase. */}
          <p>It doesn’t exist on any screen size. The link is a real address with no screen behind it.</p>
        </>
      ) : (
        <>
          <p>“{target.ref}” doesn’t have a phone layout yet.</p>
          <p>This link still works on a desktop — nothing about it is broken.</p>
        </>
      )}

      {target.ref === 'files' ? (
        <button
          type="button"
          className="mobile-empty__out"
          data-testid="mobile-refusal-out"
          onClick={() => navigateTo({ type: 'kind', ref: 'file' })}
        >
          Browse files as a list
        </button>
      ) : null}
    </div>
  );
}

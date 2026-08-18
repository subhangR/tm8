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
import { Avatar, VectorIcon } from '../kit';
import type { Theme } from '../theme/useTheme';
import { isUnbuiltViewRef } from './view-ref-screens';
import { CHANNEL_KIND, KIND_ART, VIEW_ART, getKind, type KindArt } from '../domain';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import { CatchBoundary } from '../panels/detail/CatchBoundary';
import type { DetailReasons } from '../panels';
import type { Notice } from '../shell';
import { EntityView } from './EntityView';
import { ChannelView } from './ChannelView';
import { InboxView } from './InboxView';
import { openEntityOnPhone } from './openEntityOnPhone';
import { ChatHomeSurface } from '../chat-home';
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
  /** Theme, controlled by the host so the phone writes the same state the root
      stamp reads — a second `useTheme()` here would be a second truth. */
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}

/**
 * The bottom destinations. Deliberately FEW: a tab bar is a promise that these
 * are the places you go, and a phone that promises nine is promising nothing.
 * Each is a real route, so every tab is a shareable address.
 */
/*
 * The marks are the REGISTRY'S artwork (`domain/kind-art.ts`) — the same paths
 * the desktop icon rail draws for these same destinations. Not a phone icon
 * set: a second icon language would be the clearest possible statement that
 * this is a different product, and the tab bar is where a viewer would see it
 * first. `VectorIcon` strokes them in `currentColor` on a 16x16 grid, so the
 * active state below is a colour change and nothing else.
 */
const TABS: readonly { readonly label: string; readonly art: KindArt; readonly target: MenuTarget }[] = [
  { label: 'Home', art: VIEW_ART.dashboard, target: { type: 'view', ref: 'dashboard' } },
  { label: 'Tasks', art: KIND_ART.task, target: { type: 'kind', ref: 'task' } },
  { label: 'Sessions', art: KIND_ART.work_session, target: { type: 'kind', ref: 'work_session' } },
  { label: 'Channels', art: KIND_ART.channel, target: { type: 'kind', ref: 'channel' } },
  { label: 'Inbox', art: VIEW_ART.inbox, target: { type: 'view', ref: 'inbox' } },
];

/** The chevron's own geometry, on `VectorIcon`'s 16x16 grid. */
const CHEVRON_UP_ART: KindArt = ['M10.4 3.6 5.6 8l4.8 4.4'];

function sameTarget(a: MenuTarget | null, b: MenuTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === 'view' && b.type === 'view') return a.ref === b.ref;
  if (a.type === 'kind' && b.type === 'kind') return a.ref === b.ref;
  return false;
}

/**
 * The screen's own name, for the header.
 *
 * Derived from the SAME `activeTarget` the tab bar highlights, so the header
 * and the selected tab cannot disagree — there is one fact and two renderings
 * of it.
 *
 * A destination with NO tab is the interesting case: a refusal screen reached
 * by a shared link. `VIEW_PRESENTATION` is the registry the desktop rail names
 * its rows from, so `settings` reads "Settings" and `files` reads "File
 * browser" — the same word the viewer saw on the desktop they copied the link
 * off. Falling through to the bare ref (which is what the header did first, and
 * what the screenshot caught: a lowercase `settings` under the Space name) puts
 * an internal slug in the one place the screen states where you are.
 *
 * The raw ref REMAINS on the refusal card itself, quoted, and that is correct:
 * the card explains which arrangement has no phone layout, and naming the thing
 * exactly is what makes that honest rather than vague.
 */
function titleOf(activeTarget: MenuTarget | null, nameOfEntity?: (target: { ref: string; kind: string }) => string | null): string {
  if (!activeTarget) return 'Not found';
  const tab = TABS.find((t) => sameTarget(activeTarget, t.target));
  if (tab) return tab.label;

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

  /* The link affordance is in the header for the same reason it is in the
     desktop tab bar: the thing being shared is THE PAGE. On a phone it matters
     more, not less — a phone is where links are received and forwarded. */
  const header = (
    <div className="mobile-header">
      {/* Rendered ONLY when something is open. A chevron at a screen root would
          be dead chrome that either does nothing or leaves the app, and the tab
          bar is already the navigation there. */}
      {screenStack.selected ? (
        <button
          type="button"
          className="mobile-header__back"
          aria-label={`Up to ${title}`}
          onClick={() => screenStack.pop()}
        >
          <VectorIcon paths={CHEVRON_UP_ART} size={20} strokeWidth={1.6} />
        </button>
      ) : null}
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
      <CopyLinkControl
        spaceId={spaceId}
        target={activeTarget ?? { type: 'view', ref: 'workspace' }}
        openEntity={props.openEntity}
      />
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

  const tabBar = (
    <ul className="mobile-tabs">
      {TABS.map((tab) => (
        <li key={tab.label}>
          <button
            type="button"
            className="mobile-tabs__tab"
            aria-current={sameTarget(activeTarget, tab.target) ? 'page' : undefined}
            onClick={() => navigateTo(tab.target)}
          >
            {/* The mark is decorative HERE and only here: the word is drawn
                right beside it, so a title on the icon would make every tab
                announce its own name twice. */}
            <span className="mobile-tabs__icon" aria-hidden="true">
              <VectorIcon paths={tab.art} size={20} />
            </span>
            <span className="mobile-tabs__label">{tab.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <MobileFrame
      header={header}
      tabBar={tabBar}
      notices={props.notices}
      sheet={<div className="msheet-host" ref={setSheetHost} />}
    >
      {/* INSIDE THE BOUNDARY, so a screen that throws while a sheet is open
          still loses only the screen. The host itself is a frame region and
          sits outside — a boundary that took the sheet host down with the
          screen would leave the next screen unable to open one at all. */}
      <CatchBoundary label="mobile-view">
        <MobileSurfaceProvider sheetHost={sheetHost}>
          {screenFor(props)}
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
function screenFor(props: MobileShellProps): ReactNode {
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
       * is a real piece of work that nobody owns yet. What is fixed is the
       * shell's own honesty while it waits: the state now says what is
       * happening and that it is expected to take time, and `role="status"`
       * means a screen reader is told rather than left on a silent screen.
       * That is the difference between a slow app and an app that looks broken.
       */
      <div className="mobile-empty" data-testid="mobile-loading" role="status" aria-live="polite">
        <p>Catching up with this space.</p>
        <p>Reading its history — on a large space over a slow connection this takes a while.</p>
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
         * `EntityView` declares `mode`/`onMode` and `groupBy`/`onGroupBy`, the
         * desktop host threads all four, and this arm passed none of them.
         * `EntityListPanel` falls through to LOCAL STATE when `mode` is
         * null-ish, so the failure was silent in both directions:
         *
         *   - a phone URL carrying `mode=board` rendered the LIST. The address
         *     and the screen disagreed, on the one device where the address is
         *     how the screen was arrived at.
         *   - the phone's own layout toggle wrote to component state and
         *     nothing else, so a phone reader's choice was neither shareable
         *     nor survivable across a reload — while the identical control on
         *     a desktop was both.
         *
         * `nav-targets.ts` has carried `mode` on a kind view all along; it was
         * threaded on one shell and dropped on the other. This is the same law
         * this file opens with — one navigation state, two renderings — and the
         * phone rendering was quietly holding a second copy of part of it.
         *
         * SIBLING ROW, worth naming here: DEF-013 is that toggle's SIZE (17x15,
         * fixed in `mobile-screens.css`). This is where its RESULT goes. Fixing
         * the size alone would have produced a comfortably tappable control
         * whose effect still could not be shared or reloaded.
         */
        {...(activeTarget.mode !== undefined ? { mode: activeTarget.mode } : {})}
        onMode={(m) => props.navigateTo({ ...activeTarget, mode: m })}
        {...(activeTarget.groupBy !== undefined ? { groupBy: activeTarget.groupBy } : {})}
        onGroupBy={(g) => props.navigateTo({ ...activeTarget, groupBy: g })}
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
    case 'dashboard':
      return (
        <ChatHomeSurface
          seam={data.seam}
          spaceId={props.spaceId}
          nodeKey={props.nodeKey}
          {...(props.chatAnchorId ? { anchorId: props.chatAnchorId } : {})}
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

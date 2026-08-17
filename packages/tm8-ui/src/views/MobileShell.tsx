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
import type { EntityId, SpaceId } from '@tm8/contract';
import { MobileFrame, MobileSurfaceProvider } from '../mobile';
import '../mobile/mobile-chrome.css';
import '../mobile/mobile-screens.css';
import { CopyLinkControl } from '../share';
import { VectorIcon } from '../kit';
import { KIND_ART, VIEW_ART, getKind, type KindArt } from '../domain';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import { CatchBoundary } from '../panels/detail/CatchBoundary';
import type { DetailReasons } from '../panels';
import type { Notice } from '../shell';
import { EntityView } from './EntityView';
import { ChannelView } from './ChannelView';
import { InboxView } from './InboxView';
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
function titleOf(activeTarget: MenuTarget | null): string {
  if (!activeTarget) return 'Not found';
  const tab = TABS.find((t) => sameTarget(activeTarget, t.target));
  if (tab) return tab.label;
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
  const title = titleOf(activeTarget);

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
        {/* `title` keeps the full string reachable when the ellipsis folds it —
            truncation hides text, it must not destroy it. */}
        <span className="mobile-header__title" title={title}>
          {title}
        </span>
      </span>
      <CopyLinkControl
        spaceId={spaceId}
        target={activeTarget ?? { type: 'view', ref: 'workspace' }}
        openEntity={props.openEntity}
      />
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
        <MobileSurfaceProvider sheetHost={sheetHost}>{screenFor(props)}</MobileSurfaceProvider>
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
      <div className="mobile-empty">
        <p>Loading…</p>
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
      />
    );
  }

  if (activeTarget.type === 'entity') {
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
   * WHY NEITHER OF THESE IS HANDED AN `onOpenEntity`, and why that is the fix
   * rather than the omission it looks like.
   *
   * Opening an arbitrary entity is a WORKSPACE move — the desktop does it by
   * navigating to the workspace and pushing the id onto the panel stack, and the
   * workspace is precisely what has no phone arrangement (see the default arm).
   * The phone's `entity` route is the CHANNEL screen, so routing a task or a
   * session there would draw a message feed for something that has none: the
   * misroute `GateApp` was repaired for.
   *
   * Both of these screens already have an honest answer for a host that cannot
   * navigate — `InboxScreen` renders its rows disabled-WITH-REASON, and
   * `EntityChip` renders an inert badge instead of a button — and both check it
   * by asking whether the callback EXISTS. So they were each passed
   * `() => undefined`, which is not "no handler": it is a handler that does
   * nothing. The prop was present, the honest states switched themselves off,
   * and every inbox row and every tool-call chip on a phone became a live-looking
   * control that swallowed the press. Passing nothing is what makes them tell
   * the truth. Wiring them for real is a phone workspace, not a callback.
   */
  switch (activeTarget.ref) {
    case 'inbox':
      return <InboxView seam={data.seam} />;
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
      return (
        <div className="mobile-empty" data-testid="mobile-not-on-phone">
          <p>“{activeTarget.ref}” doesn’t have a phone layout yet.</p>
          <p>This link still works on a desktop — nothing about it is broken.</p>
        </div>
      );
  }
}

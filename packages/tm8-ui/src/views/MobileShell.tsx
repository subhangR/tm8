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
import type { ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { MobileFrame } from '../mobile';
import { CopyLinkControl } from '../share';
import type { MenuTarget } from '../shell';
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
const TABS: readonly { readonly label: string; readonly target: MenuTarget }[] = [
  { label: 'Home', target: { type: 'view', ref: 'dashboard' } },
  { label: 'Tasks', target: { type: 'kind', ref: 'task' } },
  { label: 'Sessions', target: { type: 'kind', ref: 'work_session' } },
  { label: 'Channels', target: { type: 'kind', ref: 'channel' } },
  { label: 'Inbox', target: { type: 'view', ref: 'inbox' } },
];

function sameTarget(a: MenuTarget | null, b: MenuTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === 'view' && b.type === 'view') return a.ref === b.ref;
  if (a.type === 'kind' && b.type === 'kind') return a.ref === b.ref;
  return false;
}

export function MobileShell(props: MobileShellProps) {
  const { data, activeTarget, navigateTo, spaceId } = props;

  /* The link affordance is in the header for the same reason it is in the
     desktop tab bar: the thing being shared is THE PAGE. On a phone it matters
     more, not less — a phone is where links are received and forwarded. */
  const header = (
    <div className="mobile-header">
      <span className="mobile-header__title">{props.spaceLabel ?? 'tm8'}</span>
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
            {tab.label}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <MobileFrame header={header} tabBar={tabBar} notices={props.notices}>
      <CatchBoundary label="mobile-view">{screenFor(props)}</CatchBoundary>
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
  if (!data.ready) return <div className="mobile-empty">Loading…</div>;
  if (!activeTarget) {
    return (
      <div className="mobile-empty" data-testid="mobile-unrouted">
        This link doesn’t name a screen this build has. Nothing was opened in its place.
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

  switch (activeTarget.ref) {
    case 'inbox':
      return <InboxView seam={data.seam} onOpenEntity={() => undefined} />;
    case 'dashboard':
      return (
        <ChatHomeSurface
          seam={data.seam}
          spaceId={props.spaceId}
          nodeKey={props.nodeKey}
          {...(props.spaceLabel ? { spaceLabel: props.spaceLabel } : {})}
          {...(props.chatAnchorId ? { anchorId: props.chatAnchorId } : {})}
          onOpenEntity={() => undefined}
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

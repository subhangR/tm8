/**
 * LeftRail — per-space navigation: space name, the section list, and the
 * channel tree.
 *
 * Sections are not bespoke pages: each one is a saved collection view pointed
 * at a kind (§5 of the brief), so its badge is that query's total and clicking
 * it only moves the nav store's `view`. Channels come from `getNavigation`
 * (nested tree, unread per channel).
 */
import { Fragment } from 'react';
import { Eyebrow } from '../kit';
import { useNavStore, type ViewName } from '../stores/nav';
import type { CollabFacade } from '../facade/CollabFacade';
import type { NavChannelNode } from '../types/contract';
import { Icon, type IconName } from './icons';
import type { RailSection } from './types';
import { useSectionCounts, useSpaceNavigation, useSpaces } from './useShellData';

/**
 * The primary sections, in brief order.
 *
 * `sessions` and `settings` were both routable and BOTH missing from this list,
 * so the only way to reach either was to type the URL — which for sessions meant
 * a running agent had no entry point at all. Sessions sits with the work it
 * describes; Settings goes last, where a settings entry belongs.
 *
 * ⚠ tm8 addition (drift ledger): `workspace`. The execution workspace is a NEW
 * entry, not a replacement — `tasks` above still opens the module's own Tasks
 * screen, unchanged. It sits between Tasks and Sessions because that is what it
 * spans: it is where a task becomes a running agent.
 *
 * No `SECTION_QUERIES` entry accompanies it on purpose. The other sections are
 * saved collection views and their badge is that query's total; the workspace is
 * a composed surface with no single count, and a badge invented for it would be
 * a number that means nothing.
 */
export const RAIL_SECTIONS: Array<{ view: ViewName; label: string; icon: IconName }> = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'tasks', label: 'Tasks', icon: 'list-checks' },
  { view: 'workspace', label: 'Workspace', icon: 'columns' },
  { view: 'sessions', label: 'Sessions', icon: 'terminal' },
  { view: 'docs', label: 'Docs', icon: 'file-text' },
  { view: 'team', label: 'Team', icon: 'users' },
  { view: 'tracking', label: 'Tracking', icon: 'git-pull-request' },
  { view: 'graph', label: 'Graph', icon: 'share-2' },
  { view: 'leaderboard', label: 'Leaderboard', icon: 'trophy' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

function ChannelRow({
  node, depth, activeId, onOpen,
}: { node: NavChannelNode; depth: number; activeId: string | null; onOpen: (id: string) => void }) {
  const unread = node.entity.state.kind === 'channel' ? node.entity.state.unreadCount : 0;
  const working = node.entity.state.kind === 'channel' ? node.entity.state.workingAgentCount : 0;
  return (
    <Fragment>
      <button
        type="button"
        className="cv2-railitem"
        style={{ paddingLeft: 10 + depth * 12 }}
        data-active={node.entity.id === activeId || undefined}
        data-unread={unread > 0 || undefined}
        aria-current={node.entity.id === activeId ? 'page' : undefined}
        onClick={() => onOpen(node.entity.id)}
      >
        <Icon name="hash" size={15} />
        <span className="cv2-railitem__label">{node.entity.title}</span>
        {working > 0 && <span className="cv2-railitem__working" title={`${working} agents working`} />}
        {unread > 0 && <span className="cv2-railitem__badge">{unread}</span>}
      </button>
      {node.children.map((child) => (
        <ChannelRow key={child.entity.id} node={child} depth={depth + 1} activeId={activeId} onOpen={onOpen} />
      ))}
    </Fragment>
  );
}

export interface LeftRailProps {
  facade: CollabFacade;
  /** Extra sections (saved views shared into the space) appended below the seven. */
  extraSections?: RailSection[];
}

export function LeftRail({ facade, extraSections = [] }: LeftRailProps) {
  const spaceId = useNavStore((s) => s.spaceId);
  const view = useNavStore((s) => s.view);
  const entityId = useNavStore((s) => s.entityId);
  const setView = useNavStore((s) => s.setView);
  const { value: navigation } = useSpaceNavigation(facade, spaceId);
  const { value: spaces } = useSpaces(facade);
  const counts = useSectionCounts(facade, spaceId);
  const spaceName = spaces?.find((s) => s.id === spaceId)?.name ?? spaceId ?? '—';

  const sections: RailSection[] = [
    ...RAIL_SECTIONS.map((s) => ({ ...s, badge: counts[s.view] ?? null })),
    ...extraSections,
  ];

  return (
    <nav className="cv2-leftrail" aria-label="Space navigation">
      <header className="cv2-leftrail__header">
        <Eyebrow>space</Eyebrow>
        <div className="cv2-leftrail__space">{spaceName}</div>
        {navigation && (
          <div className="cv2-leftrail__viewer">
            {navigation.viewer.displayName}
            {navigation.unreadTotal > 0 && <span className="cv2-railitem__badge">{navigation.unreadTotal}</span>}
          </div>
        )}
      </header>

      <div className="cv2-leftrail__scroll">
        {sections.map((section) => (
          <button
            key={`${section.view}:${section.label}`}
            type="button"
            className="cv2-railitem"
            data-active={(view === section.view && !entityId) || undefined}
            aria-current={view === section.view && !entityId ? 'page' : undefined}
            onClick={() => setView(section.view)}
          >
            <Icon name={section.icon as IconName} size={16} />
            <span className="cv2-railitem__label">{section.label}</span>
            {section.badge ? <span className="cv2-railitem__badge">{section.badge}</span> : null}
          </button>
        ))}

        <div className="cv2-leftrail__group">
          <Eyebrow>channels</Eyebrow>
        </div>
        {(navigation?.channels ?? []).map((node) => (
          <ChannelRow
            key={node.entity.id}
            node={node}
            depth={0}
            activeId={view === 'channel' ? entityId : null}
            onOpen={(id) => setView('channel', id)}
          />
        ))}
        {navigation && navigation.channels.length === 0 && (
          <div className="cv2-leftrail__empty">No channels yet — ⌘K to create one.</div>
        )}
      </div>
    </nav>
  );
}

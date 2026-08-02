import type { CSSProperties } from 'react';
import type { ViewName } from '../../collab-v2/stores/nav';
import './styles/icon-rail.css';

/**
 * The glyph table is copied verbatim from Maestro's redesign kit. Keeping the
 * 16×16 paths local avoids pulling Maestro's Tauri/assets layer across the tm8
 * seam while preserving the exact strokes used by the shipping rail.
 */
export const CHROME_ICONS = {
  search: 'M11 11l3.5 3.5M7.5 13a5.5 5.5 0 100-11 5.5 5.5 0 000 11z',
  plus: 'M8 3.5v9M3.5 8h9',
  settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v1.5M8 13v1.5M3.05 3.05l1.06 1.06M11.9 11.9l1.05 1.05M1.5 8H3M13 8h1.5M3.05 12.95l1.06-1.06M11.9 4.1l1.05-1.05',
  listChecks: 'M3 4l1 1 1.5-1.5M3 9l1 1 1.5-1.5M8 4h5M8 9h5M8 13.5h5',
  users: 'M6 7.5a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5zM2.5 13c0-2 1.6-3.2 3.5-3.2S9.5 11 9.5 13M10.5 7.2a2 2 0 000-4M11 9.9c1.5.2 2.5 1.3 2.5 3.1',
  team: 'M8 6.5a2 2 0 100-4 2 2 0 000 4zM3.5 11a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM12.5 11a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM5 14c0-1.6 1.3-2.6 3-2.6s3 1 3 2.6',
  sparkles: 'M8 2.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1 1-2.6zM12.5 9l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z',
  inbox: 'M2.5 9.5h3l1 1.5h3l1-1.5h3M2.5 9.5l1.8-5.5h7.4l1.8 5.5v3a1 1 0 01-1 1h-10a1 1 0 01-1-1z',
  graph: 'M4 4.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2zM12 4.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2zM8 14.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2zM5.3 4.1l1.7 5M10.7 4.1L9 9.1',
  folder: 'M2.5 4.5A1 1 0 013.5 3.5h2.4l1 1.3H12.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z',
  globe: 'M8 14A6 6 0 108 2a6 6 0 000 12zM2 8h12M8 2c-2.6 1.8-2.6 10.2 0 12M8 2c2.6 1.8 2.6 10.2 0 12',
  layers: 'M8 2l5.5 3L8 8 2.5 5 8 2zM2.5 8L8 11l5.5-3M2.5 11L8 14l5.5-3',
  volume: 'M3 6.5h2l3-2.5v8l-3-2.5H3zM10.5 6a3 3 0 010 4M12.5 4.5a5.5 5.5 0 010 7',
  volumeOff: 'M3 6.5h2l3-2.5v8l-3-2.5H3zM10.5 6l3 3M13.5 6l-3 3',
  sun: 'M8 11a3 3 0 100-6 3 3 0 000 6zM8 1.7v1.6M8 12.7v1.6M2.6 2.6l1.1 1.1M12.3 12.3l1.1 1.1M1.7 8h1.6M12.7 8h1.6M2.6 13.4l1.1-1.1M12.3 3.7l1.1-1.1',
  moon: 'M13.4 9.3A5.5 5.5 0 116.7 2.6 4.6 4.6 0 0013.4 9.3z',
  x: 'M4 4l8 8M12 4l-8 8',
} as const;

export type ChromeIconName = keyof typeof CHROME_ICONS;

export function ChromeIcon({
  name,
  size = 16,
  sw = 1.6,
  style,
}: {
  name: ChromeIconName;
  size?: number;
  sw?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {CHROME_ICONS[name].split('M').filter(Boolean).map((segment, index) => (
        <path key={index} d={`M${segment}`} />
      ))}
    </svg>
  );
}

export function MaestroMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 7l4 5-4 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14.5" cy="12" r="1.1" fill="currentColor" />
      <circle cx="18.2" cy="12" r="1.1" fill="currentColor" />
      <path d="M12.5 12h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

type IconRailItemId = 'tasks' | 'members' | 'teams' | 'skills' | 'lists' | 'graphs' | 'files' | 'collab';

export interface IconRailProps {
  activeSection: ViewName | null;
  onSectionChange?: (section: ViewName) => void;
  taskCount?: number;
  memberCount?: number;
  teamCount?: number;
}

const RAIL_ITEMS: ReadonlyArray<{
  id: IconRailItemId;
  label: string;
  icon: ChromeIconName;
  /** Null means Maestro has the surface but tm8 has no route for it. */
  view: ViewName | null;
}> = [
  { id: 'tasks', label: 'Tasks', icon: 'listChecks', view: 'workspace' },
  { id: 'members', label: 'Members', icon: 'users', view: 'team' },
  { id: 'teams', label: 'Teams', icon: 'team', view: null },
  { id: 'skills', label: 'Skills', icon: 'sparkles', view: null },
  { id: 'lists', label: 'Lists', icon: 'inbox', view: 'tasks' },
  { id: 'graphs', label: 'Graphs', icon: 'graph', view: 'graph' },
  { id: 'files', label: 'Files', icon: 'folder', view: 'docs' },
  { id: 'collab', label: 'Collab Space', icon: 'globe', view: 'home' },
];

function badgeFor(id: IconRailItemId, props: IconRailProps): number | null {
  if (id === 'tasks') return props.taskCount ?? null;
  if (id === 'members') return props.memberCount ?? null;
  if (id === 'teams') return props.teamCount ?? null;
  return null;
}

/** Maestro's 56px far-left application rail, with tm8's unavailable seams stated. */
export function IconRail(props: IconRailProps) {
  return (
    <nav className="pn-rail" aria-label="Workspace sections" data-testid="workspace-icon-rail">
      <span className="pn-rail-mark" title="Maestro"><MaestroMark size={24} /></span>

      {RAIL_ITEMS.map(({ id, label, icon, view }) => {
        const active = props.activeSection === view;
        const badge = badgeFor(id, props);
        const available = view != null && Boolean(props.onSectionChange);
        const reason = available ? label : `${label} panel is not available in this tm8 workspace`;

        return (
          <button
            type="button"
            key={id}
            className={`pn-rail-btn${active ? ' pn-rail-btn--active' : ''}`}
            onClick={() => { if (view) props.onSectionChange?.(view); }}
            title={reason}
            aria-label={available ? label : `${label} — unavailable`}
            aria-current={active ? 'page' : undefined}
            disabled={!available}
          >
            <ChromeIcon name={icon} sw={1.55} />
            {badge != null && badge > 0 && (
              <span className="pn-rail-badge">{badge > 99 ? '99+' : badge}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

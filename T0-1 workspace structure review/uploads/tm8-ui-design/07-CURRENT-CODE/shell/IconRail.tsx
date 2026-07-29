/**
 * IconRail — the far-left 56px rail: the maestro mark, one tile per space
 * (active space marked by a brand bar), Home, and Inbox with its unread dot.
 * Every count comes from the facade (`listSpaces`, `getInbox`).
 */
import { useNavStore } from '../stores/nav';
import type { CollabFacade } from '../facade/CollabFacade';
import { Icon } from './icons';
import { useSpaces, useUnreadInbox } from './useShellData';

function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 -]/g, ' ').split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export interface IconRailProps { facade: CollabFacade }

export function IconRail({ facade }: IconRailProps) {
  const spaceId = useNavStore((s) => s.spaceId);
  const view = useNavStore((s) => s.view);
  const setSpace = useNavStore((s) => s.setSpace);
  const setView = useNavStore((s) => s.setView);
  const { value: spaces } = useSpaces(facade);
  const unread = useUnreadInbox(facade, spaceId);

  return (
    <nav className="cv2-iconrail" aria-label="Spaces">
      <div className="cv2-iconrail__mark" title="Maestro">&gt;···+</div>

      {(spaces ?? []).map((space) => {
        const active = space.id === spaceId;
        return (
          <button
            key={space.id}
            type="button"
            className="cv2-iconrail__tile"
            data-active={active || undefined}
            title={space.name}
            aria-label={space.name}
            aria-current={active ? 'true' : undefined}
            onClick={() => setSpace(space.id)}
          >
            {initials(space.name)}
            {active && <span className="cv2-iconrail__marker" aria-hidden="true" />}
            {!active && space.unreadTotal > 0 && <span className="cv2-iconrail__dot" aria-hidden="true" />}
          </button>
        );
      })}

      <div className="cv2-iconrail__spacer" />

      <button
        type="button"
        className="cv2-iconrail__tile cv2-iconrail__tile--ghost"
        data-active={view === 'home' || undefined}
        title="Home"
        aria-label="Home"
        onClick={() => setView('home')}
      >
        <Icon name="home" size={18} />
      </button>

      <button
        type="button"
        className="cv2-iconrail__tile cv2-iconrail__tile--ghost"
        data-active={view === 'inbox' || undefined}
        title={unread > 0 ? `Inbox — ${unread} unread` : 'Inbox'}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
        onClick={() => setView('inbox')}
      >
        <Icon name="inbox" size={18} />
        {unread > 0 && <span className="cv2-iconrail__dot" data-testid="inbox-unread-dot" aria-hidden="true" />}
      </button>
    </nav>
  );
}

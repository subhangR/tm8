/**
 * Avatar — humans render round, agents render as rounded squares (the shape
 * IS the provenance signal, reinforced by the title text).
 */
import type { ActorSummary } from '../types/contract';

export interface AvatarProps {
  actor: ActorSummary;
  size?: number; // px, default 24
  title?: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** True when the avatar string is a single emoji/glyph rather than a URL. */
function isGlyph(avatar: string): boolean {
  return avatar.length <= 4 && !avatar.includes('/') && !avatar.includes('.');
}

export function Avatar({ actor, size = 24, title }: AvatarProps) {
  const shape = actor.isAgent ? 'agent' : 'human';
  const label = title ?? `${actor.displayName}${actor.isAgent ? ' (agent)' : ''}`;
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) };
  const avatar = actor.avatar ?? undefined;
  return (
    <span
      className={`cv2-avatar cv2-avatar--${shape}`}
      style={style}
      title={label}
      aria-label={label}
      role="img"
      data-actor-kind={actor.kind}
    >
      {avatar
        ? (isGlyph(avatar) ? <span aria-hidden="true">{avatar}</span> : <img src={avatar} alt="" />)
        : <span aria-hidden="true">{initialsOf(actor.displayName)}</span>}
    </span>
  );
}

/**
 * Avatar — shape IS provenance: humans are round, agents are rounded-square
 * (5px at every size — T0-1 Z4 sets avR '50%' for members, '5px' otherwise).
 * Shape is never the only carrier: pass `label` (the actor's display name)
 * and provenance also appears as text/chip wherever it matters.
 *
 * IMAGE IS THE EXCEPTION, INITIALS ARE THE RULE. Every profile row ships NULL
 * (067 landed with no backfill), so a missing `src` is the normal state of
 * every actor, not an edge case — the monogram is the base rendering and an
 * image layers over it only when a URL exists AND actually loads. A broken or
 * 404 URL falls back to the same monogram via onError; nothing renders a
 * broken-image glyph or an empty circle.
 *
 * Canvas sizes: 15 (inline mono initials) · 20/22 (rows, tab bar) · 32 (Z4
 * header). Font sizes measured per size; ≤20px initials are mono.
 *
 * COLOUR IS DISPLAY IDENTITY, derived only from the stable actor id. Display
 * names change and `user_profiles.global_id` is self-asserted display data, so
 * neither is an acceptable key. FNV-1a is deliberately tiny and synchronous:
 * no stored state, random seed, server read, or machine-specific API can make
 * one actor change colour between surfaces or sessions.
 */
import { useEffect, useState } from 'react';

export type AvatarProvenance = 'human' | 'agent';
export type AvatarSize = 15 | 20 | 22 | 32;

const FONT: Record<AvatarSize, number> = { 15: 9, 20: 9, 22: 10, 32: 14 };
const TONE_COUNT = 6;

/** Stable across JS engines because every operation is explicitly 32-bit. */
export function avatarToneForActor(actorId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < actorId.length; i += 1) {
    hash ^= actorId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TONE_COUNT;
}

export function Avatar({
  actorId,
  provenance,
  label,
  size = 22,
  initials,
  src,
  className,
}: {
  /** Stable member/team-member entity id. The sole deterministic-colour key. */
  actorId: string;
  provenance: AvatarProvenance;
  /** Actor display name — becomes the accessible name and title. */
  label: string;
  size?: AvatarSize;
  /** Defaults to the first character of `label`, uppercased. */
  initials?: string;
  /** Profile image URL. Absent/null (today: every row) ⇒ the monogram. */
  src?: string | null;
  /** Surface layout hook; identity/provenance classes always remain present. */
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  // A re-render with a DIFFERENT url gets a fresh attempt; the error state
  // belongs to the url that failed, not to the actor.
  useEffect(() => setBroken(false), [src]);
  const mono = size <= 20;
  const showImage = !!src && !broken;
  const tone = avatarToneForActor(actorId);
  const cls = [
    'kit-avatar',
    provenance === 'agent' ? 'kit-avatar--agent' : 'kit-avatar--human',
    `kit-avatar--tone-${tone}`,
    mono ? 'kit-avatar--mono' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      role="img"
      aria-label={label}
      title={label}
      data-actor-id={actorId}
      data-avatar-tone={tone}
      style={{ width: size, height: size, fontSize: FONT[size] }}
    >
      {(initials ?? label.charAt(0)).toUpperCase()}
      {showImage ? (
        <img
          className="kit-avatar__img"
          src={src}
          alt=""
          /* A user-supplied remote profile image must not receive the current
             workspace/entity URL as a referrer. */
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : null}
    </span>
  );
}

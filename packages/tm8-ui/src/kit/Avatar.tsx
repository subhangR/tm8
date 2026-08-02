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
 */
import { useEffect, useState } from 'react';

export type AvatarProvenance = 'human' | 'agent';
export type AvatarSize = 15 | 20 | 22 | 32;

const FONT: Record<AvatarSize, number> = { 15: 9, 20: 9, 22: 10, 32: 14 };

export function Avatar({
  provenance,
  label,
  size = 22,
  initials,
  src,
}: {
  provenance: AvatarProvenance;
  /** Actor display name — becomes the accessible name and title. */
  label: string;
  size?: AvatarSize;
  /** Defaults to the first character of `label`, uppercased. */
  initials?: string;
  /** Profile image URL. Absent/null (today: every row) ⇒ the monogram. */
  src?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  // A re-render with a DIFFERENT url gets a fresh attempt; the error state
  // belongs to the url that failed, not to the actor.
  useEffect(() => setBroken(false), [src]);
  const mono = size <= 20;
  const showImage = !!src && !broken;
  const cls = [
    'kit-avatar',
    provenance === 'agent' ? 'kit-avatar--agent' : 'kit-avatar--human',
    mono ? 'kit-avatar--mono' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      role="img"
      aria-label={label}
      title={label}
      style={{ width: size, height: size, fontSize: FONT[size] }}
    >
      {(initials ?? label.charAt(0)).toUpperCase()}
      {showImage ? (
        <img
          className="kit-avatar__img"
          src={src}
          alt=""
          onError={() => setBroken(true)}
        />
      ) : null}
    </span>
  );
}

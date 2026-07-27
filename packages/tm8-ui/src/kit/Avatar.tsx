/**
 * Avatar — shape IS provenance: humans are round, agents are rounded-square
 * (5px at every size — T0-1 Z4 sets avR '50%' for members, '5px' otherwise).
 * Shape is never the only carrier: pass `label` (the actor's display name)
 * and provenance also appears as text/chip wherever it matters.
 *
 * Canvas sizes: 15 (inline mono initials) · 20/22 (rows, tab bar) · 32 (Z4
 * header). Font sizes measured per size; ≤20px initials are mono.
 */
export type AvatarProvenance = 'human' | 'agent';
export type AvatarSize = 15 | 20 | 22 | 32;

const FONT: Record<AvatarSize, number> = { 15: 9, 20: 9, 22: 10, 32: 14 };

export function Avatar({
  provenance,
  label,
  size = 22,
  initials,
}: {
  provenance: AvatarProvenance;
  /** Actor display name — becomes the accessible name and title. */
  label: string;
  size?: AvatarSize;
  /** Defaults to the first character of `label`, uppercased. */
  initials?: string;
}) {
  const mono = size <= 20;
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
    </span>
  );
}

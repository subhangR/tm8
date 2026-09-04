/**
 * HomeTrail — a panel's breadcrumb strip (task 01a00932 R7/D2).
 *
 * THE TRAIL IS THE STATE, the crumb only renders it: Home's centre trail is
 * the route's `p` stack and the right panel's is `r`, so what this strip
 * shows is exactly what the address bar carries — clicking a crumb truncates
 * the trail to it (the store verbs `stackTo`/`rightTo`), which is USER
 * navigation and pushes history. No separate history structure exists to
 * drift from the URL.
 *
 * The LAST entry is the open panel itself — rendered as the current place,
 * not a button; a control that navigates to where you already are is noise.
 * Titles resolve through the host's `detailOf` and fall back to the kind's
 * label while the read is in flight — never a raw id (ids leak into shared
 * screenshots and mean nothing to a reader).
 */
import { KindIcon, getKind } from '../domain';
import type { EntityId } from '@tm8/contract';

export interface HomeTrailProps {
  /** Bottom → top; the top is the open panel. Length ≥ 2 to render. */
  trail: readonly EntityId[];
  label: string;
  titleOf(id: EntityId): { title: string; kind: string } | null;
  onCrumb(id: EntityId): void;
}

export function HomeTrail({ trail, label, titleOf, onCrumb }: HomeTrailProps) {
  /* A one-entry trail has no history to walk — the strip earns its row only
     when there is somewhere to go back to. */
  if (trail.length < 2) return null;
  return (
    <nav className="hp-trail" aria-label={label}>
      {trail.map((id, index) => {
        const detail = titleOf(id);
        const kind = detail?.kind ?? '';
        const title = detail?.title ?? (kind ? getKind(kind).label : 'Loading…');
        const last = index === trail.length - 1;
        return (
          <span key={id} className="hp-trail__seg">
            {index > 0 ? (
              <span className="hp-trail__sep" aria-hidden>
                ›
              </span>
            ) : null}
            {last ? (
              <span className="hp-trail__here" aria-current="location">
                {kind ? (
                  <span className="hp-trail__glyph" aria-hidden>
                    <KindIcon kind={kind} />
                  </span>
                ) : null}
                {title}
              </span>
            ) : (
              <button
                type="button"
                className="hp-trail__crumb"
                title={`Back to ${title}`}
                onClick={() => onCrumb(id)}
              >
                {kind ? (
                  <span className="hp-trail__glyph" aria-hidden>
                    <KindIcon kind={kind} />
                  </span>
                ) : null}
                {title}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

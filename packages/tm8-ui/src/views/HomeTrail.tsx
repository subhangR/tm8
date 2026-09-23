/**
 * HomeTrail — the Trail strip (task 01a0c864 U3/U4/U9, supersedes R7/D2).
 *
 * THE TRAIL IS THE STATE, the crumb only renders it: Home's Trail is the
 * route's `p` and the cursor is its `pc`, so what this strip shows is exactly
 * what the address bar carries. Clicking a crumb MOVES THE CURSOR (`cursorTo`)
 * and does not shorten the walk — what is ahead of you stays ahead of you (U5).
 * That is the one behavioural difference from the strip this replaces, which
 * truncated. No separate history structure exists to drift from the URL.
 *
 * THE CURSOR'S entry is rendered as the current place, not a button; a control
 * that navigates to where you already are is noise. Titles resolve through the
 * host's `detailOf` and fall back to the kind's label while the read is in
 * flight — never a raw id (ids leak into shared screenshots and mean nothing
 * to a reader).
 *
 * HOP MARKS ARE DERIVED, NOT STORED (D4): `›` when a crumb's parent is the
 * crumb before it, `→` otherwise. Two consequences, stated here so nobody
 * "fixes" them later:
 *
 *  1. While the parent chain is not yet in the detail cache the separator
 *     renders NEUTRAL (`›`) rather than guessing. It never flips from wrong to
 *     right; it fills in from unknown to known — the same posture as the title
 *     fallback above.
 *  2. The mark describes THE DATA, not the gesture. Reach a child through the
 *     Connections tab and its crumb still reads `›`, because it *is* its
 *     parent. That is more truthful than recording which tab was clicked, and
 *     unlike a stored gesture it survives a reload.
 */
import { useRef, useState } from 'react';
import { KindIcon, getKind } from '../domain';
import { useDismissable } from '../panels/useDismissable';
import type { EntityId } from '@tm8/contract';

export interface HomeTrailProps {
  /** The WHOLE walk, bottom → top — not just what renders. Length ≥ 2. */
  trail: readonly EntityId[];
  /** Where the viewer stands: an index into `trail`. */
  cursor: number;
  label: string;
  titleOf(id: EntityId): { title: string; kind: string } | null;
  /**
   * The parent of `id`, or `null` when it has none — `undefined` when the read
   * has not landed yet, which is what buys the neutral separator in (1) above.
   */
  parentOf(id: EntityId): EntityId | null | undefined;
  onCrumb(id: EntityId): void;
}

type Mark = '›' | '→';

function markFor(
  trail: readonly EntityId[],
  index: number,
  parentOf: HomeTrailProps['parentOf'],
): Mark {
  if (index <= 0) return '›';
  const parent = parentOf(trail[index]!);
  if (parent === undefined) return '›';
  return parent === trail[index - 1] ? '›' : '→';
}

/**
 * The `…` and its jump menu (D6) — a component rather than an inline branch
 * because a long Trail hides hops on BOTH sides of the cursor and each `…`
 * needs its own ref and open state. One shared ref across two ellipses would
 * have made the second one undismissable by an outside click.
 */
function TrailJump({
  trail,
  here,
  titleOf,
  parentOf,
  onCrumb,
}: Pick<HomeTrailProps, 'trail' | 'titleOf' | 'parentOf' | 'onCrumb'> & { here: number }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  useDismissable(open, boxRef, () => setOpen(false));
  return (
    <span className="hp-trail__seg" ref={boxRef}>
      <button
        type="button"
        className="hp-trail__more"
        aria-label="Jump to a hop on the trail"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Jump to a hop on the trail"
        onClick={() => setOpen((v) => !v)}
      >
        …
      </button>
      {open ? (
        <div className="hp-trail__menu" role="menu" data-testid="hp-trail-jump">
          {trail.map((id, index) => {
            const { kind, title } = resolve(titleOf, id);
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="hp-trail__jump"
                /* AHEAD OF THE CURSOR, LISTED AND DIMMED. This is where "keep
                   forward" stops being merely true and becomes visible. */
                data-ahead={index > here ? '' : undefined}
                aria-current={index === here ? 'location' : undefined}
                onClick={() => {
                  setOpen(false);
                  onCrumb(id);
                }}
              >
                <span className="hp-trail__sep" aria-hidden>
                  {index === 0 ? '' : markFor(trail, index, parentOf)}
                </span>
                {glyphFor(kind)}
                <span className="hp-trail__jump-title">{title}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

function resolve(titleOf: HomeTrailProps['titleOf'], id: EntityId) {
  const detail = titleOf(id);
  const kind = detail?.kind ?? '';
  return { kind, title: detail?.title ?? (kind ? getKind(kind).label : 'Loading…') };
}

function glyphFor(kind: string) {
  return kind ? (
    <span className="hp-trail__glyph" aria-hidden>
      <KindIcon kind={kind} />
    </span>
  ) : null;
}

export function HomeTrail({ trail, cursor, label, titleOf, parentOf, onCrumb }: HomeTrailProps) {
  /* A one-entry Trail has no walk to show — the strip earns its row only when
     there is somewhere else to be. */
  if (trail.length < 2) return null;

  const here = Math.min(Math.max(cursor, 0), trail.length - 1);

  /* THE MIDDLE COLLAPSES (U9/D6): `root … parent › current`. An `…` stands
     exactly where hops are hidden, so a Trail walked back to its root shows
     `current …` — that trailing ellipsis is the only thing on this screen
     saying "there is still something ahead of you", and dropping it would
     leave "keep forward" true but invisible. */
  const shown = [0, here - 1, here]
    .filter((i, n, all) => i >= 0 && all.indexOf(i) === n)
    .sort((a, b) => a - b);
  const jump = () => (
    <TrailJump trail={trail} here={here} titleOf={titleOf} parentOf={parentOf} onCrumb={onCrumb} />
  );

  return (
    <nav className="hp-trail" aria-label={label}>
      {shown.map((index, n) => {
        const id = trail[index]!;
        const { kind, title } = resolve(titleOf, id);
        const gapBefore = index > (n === 0 ? -1 : shown[n - 1]!) + 1;
        return (
          <span key={id} className="hp-trail__seg">
            {gapBefore ? jump() : null}
            {n > 0 ? (
              <span className="hp-trail__sep" aria-hidden>
                {markFor(trail, index, parentOf)}
              </span>
            ) : null}
            {index === here ? (
              <span className="hp-trail__here" aria-current="location">
                {glyphFor(kind)}
                {title}
              </span>
            ) : (
              <button
                type="button"
                className="hp-trail__crumb"
                title={`Back to ${title}`}
                onClick={() => onCrumb(id)}
              >
                {glyphFor(kind)}
                {title}
              </button>
            )}
          </span>
        );
      })}
      {shown[shown.length - 1]! < trail.length - 1 ? jump() : null}
    </nav>
  );
}

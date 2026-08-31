/**
 * Building — "how the graph is building itself", on the graph.
 *
 * THE GAP THIS CLOSES. The canvas already had a ticker, and in the running app
 * it was always empty: it is fed by `GraphViewProps.timeline`, which only a
 * scripted fixture preview ever passes. So the one surface whose whole subject
 * is a workspace that never stops moving had no way to say that anything had
 * moved. This panel is fed by data the seam already delivers on every node —
 * `activityAt` and the liveness VERDICT — so it says something true in the real
 * app, and it says it about the nodes that are actually drawn.
 *
 * TWO DIFFERENT FACTS, KEPT APART. They are constantly confused and they have
 * different sources:
 *
 *   · LIVE is `livenessOf(id) === 'live'` — the seam's snapshot verdict, which
 *     outranks any stored status field (R-UI-5). It is never inferred from
 *     recency. This is the same rule `home-model` keeps when it counts a row as
 *     live from that row's dot rather than from its status column, and this
 *     panel deliberately does not define a second one.
 *   · RECENT is `activityAt` bucketed by `heatOf` — the model's own recency
 *     bucket, reused rather than re-cut, so the words here and the ink weight
 *     on the cards can never drift apart.
 *
 * A row that is BOTH says both, in two places, because "running" and "touched
 * a minute ago" are not the same claim about a session.
 *
 * ARRIVALS. `arrivedIds` are ids that were not on the canvas at the previous
 * render — the same set that gives a card its brass materialize ring. Marking
 * them here is what makes the panel a record of building rather than a
 * leaderboard of timestamps.
 *
 * §15.2: no kind is named. The glyph and the word both come from the registry.
 */
import type { EntityId, EntitySummary } from '@tm8/contract';
import { KindIcon, getKind } from '../domain';
import type { SessionLiveness } from '../data/seam';
import { Eyebrow, Timestamp } from '../kit';
import { heatOf } from './heat';

/** How many rows the panel shows. Past this it says how many it is not showing. */
export const BUILDING_ROWS = 7;

export interface BuildingProps {
  /** The entities DRAWN on the canvas — every row here has to be reachable. */
  placed: readonly EntitySummary[];
  now: string;
  /** The seam's snapshot verdict. The only definition of live on this screen. */
  livenessOf(id: string): SessionLiveness;
  /** Ids that were not on the canvas at the previous render. */
  arrivedIds: ReadonlySet<string>;
  /** Moves the canvas to that node and marks it (never a filter). */
  onPick(id: EntityId): void;
  /** The node the canvas is currently marking, so the row can agree with it. */
  markedId?: EntityId | null;
}

export function Building(props: BuildingProps) {
  const { placed, now, livenessOf, arrivedIds, onPick, markedId = null } = props;

  const liveCount = placed.filter((n) => livenessOf(n.id) === 'live').length;
  const warmCount = placed.filter((n) => heatOf(n.activityAt, now) !== 'rest').length;

  /* Newest first. A stable secondary key on id keeps two entities written in
     the same millisecond from swapping places on every unrelated re-render —
     the panel is meant to be watched, and a list that reshuffles under a
     stationary clock reads as activity that did not happen. */
  const rows = [...placed]
    .sort((a, b) => {
      const d = Date.parse(b.activityAt) - Date.parse(a.activityAt);
      if (Number.isFinite(d) && d !== 0) return d;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, BUILDING_ROWS);

  if (rows.length === 0) return null;

  return (
    <section className="gv-building" aria-label="How this graph is building">
      <header className="gv-building__head">
        <Eyebrow faint>Building</Eyebrow>
        <span className="gv-building__spacer" />
        {/* THE VERDICT'S COUNT, and it says the word. A number tinted green is
            colour carrying a status alone, which this house does not do. */}
        {liveCount > 0 ? (
          <span className="gv-building__live" title="Sessions the seam reports running right now">
            <i className="gv-building__pulse" aria-hidden />
            {liveCount} live
          </span>
        ) : (
          <span className="gv-building__quiet">nothing running</span>
        )}
      </header>

      <p className="gv-building__sub">
        {warmCount > 0
          ? `${warmCount} of ${placed.length} touched in the last 45 minutes`
          : `${placed.length} on canvas · none touched in the last 45 minutes`}
      </p>

      <ol className="gv-building__list">
        {rows.map((entity) => {
          const row = getKind(entity.kind);
          const live = livenessOf(entity.id) === 'live';
          const heat = heatOf(entity.activityAt, now);
          const arrived = arrivedIds.has(entity.id);
          return (
            <li key={entity.id}>
              <button
                type="button"
                className={
                  markedId === entity.id
                    ? 'gv-building__row gv-building__row--marked'
                    : 'gv-building__row'
                }
                data-heat={heat}
                data-family={row.graphFamily ?? 'gray'}
                aria-current={markedId === entity.id ? 'true' : undefined}
                title={`${row.label} · ${entity.title} — move the canvas here`}
                onClick={() => onPick(entity.id as EntityId)}
              >
                <span className="gv-building__glyph" aria-hidden>
                  <KindIcon kind={entity.kind} size={13} />
                </span>
                <span className="gv-building__title">{entity.title}</span>
                {arrived ? <span className="gv-building__new">new</span> : null}
                {live ? (
                  <span className="gv-building__rowlive">
                    <i className="gv-building__pulse" aria-hidden />
                    live
                  </span>
                ) : null}
                <Timestamp
                  className="gv-building__when"
                  at={entity.activityAt}
                  now={now}
                  title="last activity"
                />
              </button>
            </li>
          );
        })}
      </ol>

      {placed.length > rows.length ? (
        <p className="gv-building__more">
          {placed.length - rows.length} more on the canvas, older than these.
        </p>
      ) : null}
    </section>
  );
}

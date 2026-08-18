/**
 * THE COCKPIT GRAPH TAB — the induced entity graph's only home.
 *
 * Subhang's ruling: the induced graph is NOT ported to the universal
 * conversation surface; it is a Cockpit concern and it lives here. That ruling
 * also retires the presentation it used to have — an inline strip wedged into
 * the top of the transcript, plus a separate fullscreen dialog with its own
 * pan/zoom, its own facet rail and its own two URL parameters. This stage
 * replaces all of it with one drawing in the stage's own berth, where a graph
 * has room to be a graph and does not have to compete with the conversation
 * for vertical space or invent a second way to be big.
 *
 * WHAT IS PORTED, AND WHY IT IS PORTED RATHER THAN RETYPED. The ruling says
 * concepts, not code — and the CONCEPTS here are the derivation, not the
 * chrome. `foldGraphSeeds`, `useInducedConnections`, `buildInducedGraph` and
 * `layoutInducedGraph` are small, tested, and each encodes a measurement that
 * would be lost by rewriting it from memory:
 *
 *   · edges come ONLY from `entities.connections`, never `graph.query` — the
 *     latter slices 200 candidates before traversing and under-reports a busy
 *     session's edges by about 50:1, measured on a live node;
 *   · one read per seed, ever, and a failed seed records `failed` for itself
 *     without touching any other seed;
 *   · "isolated" (read, related to nothing else we read) and "not read" (we do
 *     not know its edges) are DIFFERENT states and must never be conflated;
 *   · first-seen placement order, because re-sorting on a settle moves every
 *     card the viewer was about to click.
 *
 * Retyping those would be how we quietly lose them. So this file is thin on
 * purpose: it composes the surviving derivation and draws it once.
 *
 * WHAT DIES WITH THE OLD PRESENTATION: the inline strip, the fullscreen
 * dialog, the `?graph=full` and `?gf=` route parameters and the facet rail
 * that edited them. Those deletions land in the files that host them, which
 * belong to another lane — this stage is written so they CAN land, not so they
 * must land first.
 *
 * A LEAF, like the fleet pane: no route, no nav store, no seam.
 */
import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ConnectionsReader } from '../../session-graph/load';
import '../../session-graph/session-graph.css';
import type { ChatEntityRef } from '../entity-refs';
import { foldGraphSeeds } from '../graph-seeds';
import { buildInducedGraph } from '../induced-graph';
import { InducedGraphCanvas } from '../InducedGraphCanvas';
import { layoutInducedGraph } from '../induced-layout';
import type { ChatTurn } from '../types';
import { useInducedConnections } from '../use-induced-connections';
import { chatEntityRefFrom, useFleetEntities, type FleetEntityReader } from './use-fleet-entities';
import './cockpit-graph-stage.css';

/**
 * The stage draws more than the retired inline strip did (64) because it has
 * the room, and fewer than the retired dialog did (256) because the reads are
 * the real cost and a stage is opened deliberately, not passively scrolled
 * past. Constant per mount: a cap derived from the count would move every
 * settled card the moment the count crossed it.
 */
export const MAX_DRAWN_STAGE = 128;

/** Columns. Constant per mount for the same stability reason — the retired
 *  dialog derived this from viewport width and paid for it with cards that
 *  moved on resize. */
const PER_ROW = 6;

export interface CockpitGraphStageProps {
  /** The thread, as the screen already holds it. This stage opens no feed. */
  turns: readonly ChatTurn[];
  /** This thread's own message ids — already the transcript, never nodes. */
  suppressEntityIds?: ReadonlySet<string> | undefined;
  /**
   * The host's `entities.connections` reader. ABSENT IS A REAL STATE: every
   * card then says its edges were not read. It never draws a line it did not
   * receive, and it never presents unread as isolated.
   */
  connections?: ConnectionsReader | undefined;
  /**
   * The host's `entities.get`. Used ONLY to put names on ids that no edge
   * payload happened to carry — and it is the SAME cache the fleet pane reads,
   * so opening both tabs costs one read per entity, not two.
   */
  readEntity?: FleetEntityReader | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}

export function CockpitGraphStage({
  turns,
  suppressEntityIds,
  connections,
  readEntity,
  onOpenEntity,
}: CockpitGraphStageProps) {
  const fold = useMemo(
    () => foldGraphSeeds(turns, suppressEntityIds, { limit: MAX_DRAWN_STAGE }),
    [turns, suppressEntityIds],
  );
  const seedIds = useMemo(() => fold.drawn.map((seed) => seed.id), [fold]);
  const read = useInducedConnections(seedIds, connections);
  const graph = useMemo(() => buildInducedGraph(fold.drawn, read), [fold, read]);
  const placement = useMemo(() => layoutInducedGraph(graph, { perRow: PER_ROW }), [graph]);

  /* Late titles (R7c). Only the ids the edge payloads did not name are worth
     reading, but asking for the whole drawn set is what makes this share the
     fleet's cache — and the cache is what makes the second ask free. */
  const details = useFleetEntities(seedIds, readEntity);
  const late = useMemo(() => {
    const map = new Map<string, ChatEntityRef>();
    for (const [id, entry] of details) {
      if (entry.state === 'loaded') map.set(id, chatEntityRefFrom(entry.detail));
    }
    return map;
  }, [details]);

  const unread = graph.nodes.filter((node) => !node.edgesRead).length;
  const isolated = graph.nodes.filter((node) => node.isolated).length;

  return (
    <section className="cgs" aria-label="Entity graph" data-testid="cockpit-graph">
      <header className="cgs__head">
        <h2>Graph</h2>
        <p className="cgs__sub">
          The entities this conversation read or edited, and the relations they actually hold. The
          conversation selects what is here; it is not itself a node.
        </p>
      </header>

      {graph.nodes.length === 0 ? (
        <p className="cgs__empty">
          This conversation has not named any entities yet. Reads and edits it makes through graph
          tools appear here, with whatever relations the graph really holds between them.
        </p>
      ) : (
        <>
          <div className="cgs__canvas">
            <InducedGraphCanvas
              placement={placement}
              ariaLabel={`${graph.nodes.length} entities this conversation named, with ${graph.edges.length} relations between them`}
              late={late}
              onOpenEntity={onOpenEntity}
            />
          </div>

          {/* THE HONESTY FOOTER. Every count here is a state the drawing cannot
              show on its own, and each one is a DIFFERENT claim: unread means
              we do not know its edges, isolated means we looked and there were
              none, and undrawn means we did not look at all. Collapsing them
              into "some things are missing" is how a picture starts lying. */}
          <ul className="cgs__notes">
            {unread > 0 ? (
              <li>
                {unread} {unread === 1 ? 'entity has' : 'entities have'} unread relations — their
                edges were not read, which is not the same as having none.
              </li>
            ) : null}
            {isolated > 0 ? (
              <li>
                {isolated} read and related to nothing else here — an answer, not a failure.
              </li>
            ) : null}
            {fold.overflow > 0 ? (
              <li data-testid="cgs-overflow">
                {fold.overflow} more named and not drawn
                {fold.overflowByKind.size > 0
                  ? ` (${[...fold.overflowByKind].map(([kind, count]) => `${kind} ${count}`).join(', ')})`
                  : ''}
                . The cap bounds what is READ, so it is reported rather than silently shrinking the
                picture.
              </li>
            ) : null}
          </ul>
        </>
      )}
    </section>
  );
}

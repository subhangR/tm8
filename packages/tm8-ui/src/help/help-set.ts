/**
 * WHERE HELP COMES FROM — a `collection` entity and its ordered `contains`
 * edges, read from the graph at run time.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: no artifact id is ever written
 * down in the client. Help is a curated set in the Space's own graph, so
 * publishing a new Help page is a `tm8 edge create` — a GRAPH WRITE — and never
 * a release. A hardcoded list would have made every future Help page a
 * deploy, which is the exact failure this program is recovering from: five
 * artifacts were published on 2026-08-18 and orphaned because nothing in the
 * product could name them.
 *
 * THE HANDLE IS THE TITLE, and that is a deliberate, stated compromise rather
 * than an oversight. tm8 has no "system entity" marker and no well-known-id
 * concept today (both are named open blockers on the Help v2 design), and
 * `CollectionQuery` carries no text predicate — so the only thing a client can
 * match a curated set on is what a human named it. The consequences are honest
 * and small: rename the collection and Help reports that the Space has no Help
 * set (it says so in words, with the title it looked for), rather than silently
 * rendering an empty shelf.
 *
 * ORDER IS THE EDGE'S, NOT THE ENTITY'S. `contains` carries `props.position`
 * (the edge type's own description says so), and reading order is a property of
 * the CURATION, not of when an artifact happened to be published. `sort` on the
 * collection query cannot express it — `sort: 'position'` orders entities by
 * their position under a PARENT, and artifacts cannot be reparented at all
 * (the artifact lifecycle owns moves; `entity move` refuses). So the edges are
 * read and sorted here. An edge with no position sinks below the ones that have
 * one instead of jumping to the front, so a page wired without a position is
 * appended rather than silently promoted to Start Here.
 */
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';

/**
 * The collection a Space's Help shelf is read from.
 *
 * Exported so the empty state can NAME it: a reader who sees "no Help in this
 * Space" is owed the string that would fix it.
 */
export const HELP_COLLECTION_TITLE = 'tm8 Help';

/** How many collections are scanned for the title before giving up. */
const COLLECTION_SCAN_LIMIT = 200;

export interface HelpSet {
  /** The curating collection, or `null` when this Space has no Help shelf. */
  readonly collectionId: EntityId | null;
  /** The pages, in curated reading order. Empty is a legitimate answer. */
  readonly pages: readonly EntitySummary[];
}

export const EMPTY_HELP_SET: HelpSet = { collectionId: null, pages: [] };

/**
 * Resolve the Space's Help shelf: find the collection, then read its ordered
 * members.
 *
 * Two reads, not one, because there is no query that spans them — the edge
 * filter on `collections.query` needs the collection's id, which is what the
 * first read is for.
 *
 * REJECTION, NOT FILTERING, on kind: a `contains` edge may point at anything
 * (`destinationKinds: ['*']`), and the Help screen renders through the artifact
 * preview path. A non-artifact member is dropped here rather than handed to a
 * viewer that has no way to draw it.
 */
export async function loadHelpSet(seam: Seam, spaceId: SpaceId): Promise<HelpSet> {
  const collections = await seam.query({
    spaceId,
    kinds: ['collection'],
    limit: COLLECTION_SCAN_LIMIT,
  });
  const shelf = collections.page.items.find((row) => row.title === HELP_COLLECTION_TITLE);
  if (!shelf) return EMPTY_HELP_SET;

  const edges = await seam.connections(shelf.id, { types: ['contains'], direction: 'outgoing' });
  const pages = edges.items
    .filter((edge) => edge.type === 'contains' && edge.target.kind === 'artifact')
    .map((edge) => ({ position: positionOf(edge.props), target: edge.target }))
    .sort((a, b) => a.position - b.position)
    .map((row) => row.target);

  return { collectionId: shelf.id, pages };
}

/** `props.position`, or +∞ so an unpositioned edge lands last rather than first. */
function positionOf(props: Record<string, unknown> | undefined): number {
  const raw = props?.['position'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
}

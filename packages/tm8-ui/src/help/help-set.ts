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

export type HelpSectionId = '0' | 'A' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | 'unfiled';

export interface HelpChapterDefinition {
  readonly id: HelpSectionId;
  readonly number: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
}

/**
 * The editorial structure from the binding Help content tree. These are
 * chapter labels, never artifact addresses: membership remains entirely a
 * graph decision expressed by each `contains.props.position` range.
 */
export const HELP_CHAPTERS: readonly HelpChapterDefinition[] = [
  { id: '0', number: '00', eyebrow: 'Orientation', title: 'What tm8 does', summary: 'One conversation, one graph, and the three shapes that hold the work.' },
  { id: 'A', number: 'A', eyebrow: 'Under the hood', title: 'How tm8 is built', summary: 'The catalog, the terminal stream, and the identities allowed to act.' },
  { id: '1', number: '01', eyebrow: 'Arrival', title: 'Getting going', summary: 'Install, claim, diagnose, and invite another person in.' },
  { id: '2', number: '02', eyebrow: 'Foundation', title: 'The graph', summary: 'Entities, connections, collections, and the rules that keep them coherent.' },
  { id: '3', number: '03', eyebrow: 'Agency', title: 'Teammates & sessions', summary: 'Who works, where execution lives, and how identity carries through.' },
  { id: '4', number: '04', eyebrow: 'Practice', title: 'Work', summary: 'Tasks, projects, plans, launches, and delivery from one shared record.' },
  { id: '5', number: '05', eyebrow: 'Orchestration', title: 'Coordination', summary: 'Messages, handoffs, attention, and durable team awareness.' },
  { id: '6', number: '06', eyebrow: 'Depth', title: 'Memory, loops & spells', summary: 'Long-lived context and repeatable operating patterns.' },
  { id: '7', number: '07', eyebrow: 'Making', title: 'Craft', summary: 'Designing and publishing graphs as living entities.' },
  { id: '8', number: '08', eyebrow: 'Together', title: 'Collaboration', summary: 'Working across humans, teammates, sessions, and shared spaces.' },
] as const;

const UNFILED_CHAPTER: HelpChapterDefinition = {
  id: 'unfiled',
  number: '—',
  eyebrow: 'Unfiled',
  title: 'Awaiting a place',
  summary: 'Published pages whose collection edge has no recognized chapter position.',
};

export interface HelpPage {
  readonly entity: EntitySummary;
  readonly id: EntityId;
  readonly title: string;
  readonly excerpt?: string | null;
  readonly position: number;
  readonly sequence: number;
  readonly sectionId: HelpSectionId;
}

export interface HelpChapter extends HelpChapterDefinition {
  readonly pages: readonly HelpPage[];
}

export interface HelpSet {
  /** The curating collection, or `null` when this Space has no Help shelf. */
  readonly collectionId: EntityId | null;
  /** The pages, in curated reading order. Empty is a legitimate answer. */
  readonly pages: readonly HelpPage[];
  /** Every defined chapter, in the binding content-tree order. */
  readonly chapters: readonly HelpChapter[];
}

export const EMPTY_HELP_SET: HelpSet = {
  collectionId: null,
  pages: [],
  chapters: HELP_CHAPTERS.map((chapter) => ({ ...chapter, pages: [] })),
};

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
  const ordered = edges.items
    .filter((edge) => edge.type === 'contains' && edge.target.kind === 'artifact')
    .map((edge) => ({ position: positionOf(edge.props), target: edge.target }))
    .sort((a, b) =>
      a.position - b.position ||
      a.target.title.localeCompare(b.target.title) ||
      String(a.target.id).localeCompare(String(b.target.id)),
    );

  const pages: HelpPage[] = ordered.map((row, index) => ({
    entity: row.target,
    id: row.target.id as EntityId,
    title: row.target.title,
    excerpt: row.target.excerpt,
    position: row.position,
    sequence: index + 1,
    sectionId: sectionOf(row.position),
  }));

  const definitions = pages.some((page) => page.sectionId === 'unfiled')
    ? [...HELP_CHAPTERS, UNFILED_CHAPTER]
    : HELP_CHAPTERS;
  const chapters = definitions.map((chapter) => ({
    ...chapter,
    pages: pages.filter((page) => page.sectionId === chapter.id),
  }));

  return { collectionId: shelf.id, pages, chapters };
}

/** `props.position`, or +∞ so an unpositioned edge lands last rather than first. */
function positionOf(props: Record<string, unknown> | undefined): number {
  const raw = props?.['position'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
}

/**
 * Position bands are the graph's content-tree vocabulary:
 * 1–99 → Section 0, 100–199 → Section A, 200–299 → Section 1 … 900–999 →
 * Section 8. Anything else remains visible in an honest Unfiled chapter.
 */
function sectionOf(position: number): HelpSectionId {
  if (!Number.isFinite(position) || position < 1 || position >= 1000) return 'unfiled';
  if (position < 100) return '0';
  if (position < 200) return 'A';
  return String(Math.floor(position / 100) - 1) as HelpSectionId;
}

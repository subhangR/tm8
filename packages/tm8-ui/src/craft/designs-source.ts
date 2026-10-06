/**
 * WHERE THE DESIGNS HOME READS FROM. One small port so the home renders the
 * same against the node (`designsSourceFromSeam`) and against a fixture
 * (`fixtureDesignsSource`, for tests and until the design kind lands on a
 * node). The card is a view-model: everything a tile shows, already counted.
 */
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DESIGN_KIND, designContentOf, designStateOf } from '../domain';

export interface DesignCard {
  id: EntityId;
  title: string;
  /** The kinds of the design's pages, IN PAGE ORDER (one per page). Empty until read. */
  pageKinds: readonly string[];
  pageCount: number;
  /** Chats `about` the design. */
  chatCount: number;
  /** ISO instant the design last changed (the tile's "edited …"). */
  activityAt: string;
  /** A session is live on the design right now. */
  running: boolean;
}

export interface DesignsSource {
  list(): Promise<DesignCard[]>;
  /** Create an empty design and resolve its id. */
  create(title: string): Promise<EntityId>;
  /** Call back when the list may have changed. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

/** The ceiling on one read; the home is a grid of recent designs, not an archive. */
const LIST_LIMIT = 100;
const CHAT_SCAN_LIMIT = 500;

function cmid(tag: string): string {
  return `designs:${tag}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** A design row → its card, before page kinds and chats are known. */
export function cardOfSummary(summary: EntitySummary, chatCount = 0): DesignCard {
  return {
    id: summary.id,
    title: summary.title,
    pageKinds: [],
    pageCount: designStateOf(summary)?.pageCount ?? 0,
    chatCount,
    activityAt: summary.activityAt,
    running: (summary.badges?.workingActors?.length ?? 0) > 0,
  };
}

/** How many chats are about each subject, from chat rows' projected `about`. */
export function chatCountsBySubject(chats: readonly EntitySummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const chat of chats) {
    const about = (chat.state as { about?: { id?: string } | null }).about?.id;
    if (about) counts.set(about, (counts.get(about) ?? 0) + 1);
  }
  return counts;
}

/**
 * The node-backed source. Three reads: the designs, the chats (counted by
 * subject), then each design's detail for its ordered page kinds — a summary
 * carries the count, only the detail read carries the pages.
 */
export function designsSourceFromSeam(seam: Seam, spaceId: SpaceId): DesignsSource {
  return {
    async list() {
      const [designs, chats] = await Promise.all([
        seam.query({ spaceId, kinds: [DESIGN_KIND], sort: 'activityAt_desc', limit: LIST_LIMIT }),
        seam.query({ spaceId, kinds: ['chat'], sort: 'activityAt_desc', limit: CHAT_SCAN_LIMIT }),
      ]);
      const counts = chatCountsBySubject(chats.page.items);
      return Promise.all(
        designs.page.items.map(async (summary) => {
          const card = cardOfSummary(summary, counts.get(summary.id) ?? 0);
          try {
            const detail = await seam.entity(summary.id);
            const pages = designContentOf(detail.content).pages;
            return { ...card, pageKinds: pages.map((page) => page.kind), pageCount: pages.length };
          } catch {
            /* A tile whose pages could not be read still opens; it just draws no page marks. */
            return card;
          }
        }),
      );
    },
    async create(title) {
      const result = await seam.commands.createEntity({
        clientMutationId: cmid('new'),
        spaceId,
        kind: DESIGN_KIND,
        title,
        content: { description: '' },
      });
      const id = result.entity?.id as EntityId | undefined;
      if (!id) throw new Error('The design was not created.');
      return id;
    },
    subscribe(onChange) {
      return seam.onEvent((event) => {
        if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
        const kind = event.entity.kind as string;
        if (kind === DESIGN_KIND || kind === 'chat' || kind === 'work_session') onChange();
      });
    },
  };
}

/**
 * A client fixture: designs held in memory, `create` appends one. Mirrors the
 * contract shape (pages are summaries, in order) so a test can build one from
 * the same `EntitySummary`s a node would return.
 */
export interface FixtureDesign {
  id: EntityId;
  title: string;
  pages: readonly Pick<EntitySummary, 'kind'>[];
  chatCount?: number;
  activityAt?: string;
  running?: boolean;
}

export function fixtureDesignsSource(seed: readonly FixtureDesign[] = []): DesignsSource & {
  readonly designs: FixtureDesign[];
} {
  const designs = [...seed];
  const listeners = new Set<() => void>();
  let next = 1;
  return {
    designs,
    async list() {
      return designs.map((design) => ({
        id: design.id,
        title: design.title,
        pageKinds: design.pages.map((page) => page.kind),
        pageCount: design.pages.length,
        chatCount: design.chatCount ?? 0,
        activityAt: design.activityAt ?? new Date(0).toISOString(),
        running: design.running ?? false,
      }));
    },
    async create(title) {
      const id = `fixture-design-${next++}` as EntityId;
      designs.unshift({ id, title, pages: [], activityAt: new Date().toISOString() });
      for (const listener of listeners) listener();
      return id;
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

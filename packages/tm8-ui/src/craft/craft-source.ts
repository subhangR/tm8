/**
 * WHERE ONE CRAFT READS AND WRITES (Craft → Crafts, change list item 10).
 * The craft screen's port, beside the home's (`crafts-source.ts`): a node
 * backed source (`craftSourceFromSeam`) and a client fixture
 * (`fixtureCraftSource`) for tests and until the craft kind lands on a node.
 *
 * Zero new catalog ops: a page is a `contains` edge from the craft, so add,
 * reorder and remove are `collections.addItem` / `collections.removeItem`
 * (re-adding a member re-positions it), a new page is `entities.create` then
 * add, and the read is the craft's own detail, which carries its pages in
 * order. "Remove from craft" takes the edge away and never the entity.
 */
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DESIGN_KIND, designContentOf } from '../domain';

/** One page as the row and body need it. */
export interface CraftPageRow {
  id: EntityId;
  kind: string;
  title: string;
  version: number;
  activityAt: string;
  /** The `contains` edge position; null when the read did not carry one. */
  position: number | null;
  /** A session is live on the page right now. */
  running: boolean;
}

export interface CraftRead {
  id: EntityId;
  title: string;
  version: number;
  pages: CraftPageRow[];
}

/** The kinds `[+ page]` can make. Artifacts have no generic create; the menu says so. */
export const NEW_PAGE_KINDS = ['graph', 'doc', 'artifact', 'drawing', 'design'] as const;
export type NewPageKind = (typeof NEW_PAGE_KINDS)[number];

/** A change the screen may need to react to. */
export type CraftChange =
  | { type: 'craft' }
  | { type: 'page'; id: EntityId }
  | { type: 'deleted'; id: EntityId };

export interface CraftSource {
  read(craftId: EntityId): Promise<CraftRead>;
  /** Create a new entity of `kind` and add it as a page at `position`. Resolves the page id. */
  createPage(craftId: EntityId, kind: Exclude<NewPageKind, 'artifact'>, position: number): Promise<EntityId>;
  /** Add an existing entity as a page (or move one already in it) to `position`. */
  placePage(craftId: EntityId, entityId: EntityId, position: number): Promise<void>;
  /** Take the page out of the craft. The entity itself is untouched. */
  removePage(craftId: EntityId, entityId: EntityId): Promise<void>;
  rename(craftId: EntityId, title: string, expectedVersion: number): Promise<void>;
  /** One bounded recent page of candidates for "Add existing entity…". */
  candidates(text: string): Promise<EntitySummary[]>;
  /** Call back on any change to the craft or to one of `pageIds()`. Returns the unsubscribe. */
  subscribe(craftId: EntityId, pageIds: () => ReadonlySet<string>, onChange: (change: CraftChange) => void): () => void;
}

function cmid(tag: string): string {
  return `craft:${tag}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** The title a fresh page of each kind starts with. */
export function newPageTitle(kind: NewPageKind): string {
  return kind === 'graph' ? 'Untitled graph' : kind === 'design' ? 'Untitled craft' : `Untitled ${kind}`;
}

function contentFor(kind: Exclude<NewPageKind, 'artifact'>): Record<string, unknown> | undefined {
  if (kind === 'graph') return { graphType: 'entity' };
  if (kind === 'design') return { description: '' };
  return undefined;
}

export function pageRowOf(page: EntitySummary & { pagePosition?: number | null }): CraftPageRow {
  return {
    id: page.id,
    kind: page.kind,
    title: page.title,
    version: page.version,
    activityAt: page.activityAt,
    position: typeof page.pagePosition === 'number' ? page.pagePosition : null,
    running: (page.badges?.workingActors?.length ?? 0) > 0,
  };
}

/**
 * WHERE A PAGE LANDS. The position for `pages[index]` once the moved page is
 * dropped there: the midpoint of its new neighbours, one past the last, or
 * one before the first. `pages` is the order WITHOUT the moved page. A read
 * that carried no positions falls back to the index, which only happens
 * against a source with no positions at all.
 */
export function positionAt(pages: readonly Pick<CraftPageRow, 'position'>[], index: number): number {
  const before = index > 0 ? pages[index - 1]?.position ?? null : null;
  const after = pages[index]?.position ?? null;
  if (before !== null && after !== null) return (before + after) / 2;
  if (before !== null) return before + 1;
  if (after !== null) return after - 1;
  return index + 1;
}

export function craftSourceFromSeam(seam: Seam, spaceId: SpaceId): CraftSource {
  return {
    async read(craftId) {
      const detail = await seam.entity(craftId);
      return {
        id: detail.id,
        title: detail.title,
        version: detail.version,
        pages: designContentOf(detail.content).pages.map(pageRowOf),
      };
    },
    async createPage(craftId, kind, position) {
      const content = contentFor(kind);
      const result = await seam.commands.createEntity({
        clientMutationId: cmid('page'),
        spaceId,
        kind: kind === 'design' ? DESIGN_KIND : kind,
        title: newPageTitle(kind),
        ...(content ? { content } : {}),
      });
      const id = result.entity?.id as EntityId | undefined;
      if (!id) throw new Error('The page was not created.');
      await seam.commands.addToCollection(craftId, { clientMutationId: cmid('add'), entityId: id, position });
      return id;
    },
    async placePage(craftId, entityId, position) {
      await seam.commands.addToCollection(craftId, { clientMutationId: cmid('place'), entityId, position });
    },
    async removePage(craftId, entityId) {
      await seam.commands.removeFromCollection(craftId, entityId, { clientMutationId: cmid('remove') });
    },
    async rename(craftId, title, expectedVersion) {
      await seam.commands.patchEntity(craftId, { clientMutationId: cmid('rename'), expectedVersion, title });
    },
    async candidates() {
      const result = await seam.query({ spaceId, sort: 'activityAt_desc', limit: 50 });
      return result.page.items;
    },
    subscribe(craftId, pageIds, onChange) {
      return seam.onEvent((event) => {
        if (event.type === 'edge.upsert' || event.type === 'edge.deleted') {
          if (event.edge.type === 'contains' && event.edge.source.id === craftId) onChange({ type: 'craft' });
          return;
        }
        if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
        const id = event.entity.id as EntityId;
        if (id === craftId) onChange(event.type === 'entity.deleted' ? { type: 'deleted', id } : { type: 'craft' });
        else if (pageIds().has(id)) onChange(event.type === 'entity.deleted' ? { type: 'deleted', id } : { type: 'page', id });
      });
    },
  };
}

/**
 * A client fixture over a REAL seam for the pages: the craft and its page
 * list live here in memory, while the pages themselves are created and read
 * through the seam, so a page body renders exactly as it would on a node.
 */
export interface FixtureCraftRecord {
  id: EntityId;
  title: string;
  version: number;
  pages: CraftPageRow[];
}

export function fixtureCraftSource(
  seam: Seam,
  spaceId: SpaceId,
  seed: readonly { id: EntityId; title: string; pages?: readonly CraftPageRow[] }[] = [],
): CraftSource & { readonly crafts: Map<string, FixtureCraftRecord> } {
  const crafts = new Map<string, FixtureCraftRecord>(
    seed.map((craft) => [craft.id, { id: craft.id, title: craft.title, version: 1, pages: [...(craft.pages ?? [])] }]),
  );
  const listeners = new Set<(craftId: EntityId) => void>();
  let next = 1;
  const need = (id: EntityId) => {
    const craft = crafts.get(id);
    if (!craft) throw Object.assign(new Error(`${id} not found`), { code: 'not_found' });
    return craft;
  };
  const changed = (craft: FixtureCraftRecord) => {
    craft.version += 1;
    craft.pages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const listener of listeners) listener(craft.id);
  };
  const rowFor = async (entityId: EntityId, position: number): Promise<CraftPageRow> => {
    const nested = crafts.get(entityId);
    if (nested) {
      return { id: entityId, kind: 'design', title: nested.title, version: nested.version, activityAt: new Date().toISOString(), position, running: false };
    }
    const detail = await seam.entity(entityId);
    return { ...pageRowOf(detail), position };
  };
  const place = async (craftId: EntityId, entityId: EntityId, position: number) => {
    const craft = need(craftId);
    if (entityId === craftId) throw Object.assign(new Error('A craft cannot contain itself.'), { code: 'invalid_input' });
    const existing = craft.pages.find((page) => page.id === entityId);
    if (existing) existing.position = position;
    else craft.pages.push(await rowFor(entityId, position));
    changed(craft);
  };
  return {
    crafts,
    async read(craftId) {
      const craft = need(craftId);
      /* A nested craft's title is read live, as a node's page summary would be. */
      const pages = craft.pages.map((page) => ({ ...page, title: crafts.get(page.id)?.title ?? page.title }));
      return { id: craft.id, title: craft.title, version: craft.version, pages };
    },
    async createPage(craftId, kind, position) {
      let id: EntityId;
      if (kind === 'design') {
        id = `fixture-craft-page-${next++}` as EntityId;
        crafts.set(id, { id, title: newPageTitle(kind), version: 1, pages: [] });
      } else {
        const content = contentFor(kind);
        const result = await seam.commands.createEntity({
          clientMutationId: cmid('page'),
          spaceId,
          kind,
          title: newPageTitle(kind),
          ...(content ? { content } : {}),
        });
        id = result.entity!.id as EntityId;
      }
      await place(craftId, id, position);
      return id;
    },
    placePage: place,
    async removePage(craftId, entityId) {
      const craft = need(craftId);
      craft.pages = craft.pages.filter((page) => page.id !== entityId);
      changed(craft);
    },
    async rename(craftId, title) {
      const craft = need(craftId);
      craft.title = title;
      changed(craft);
    },
    async candidates() {
      const result = await seam.query({ spaceId, sort: 'activityAt_desc', limit: 50 });
      return result.page.items;
    },
    subscribe(craftId, pageIds, onChange) {
      const onCraft = (id: EntityId) => {
        if (id === craftId) onChange({ type: 'craft' });
        else if (pageIds().has(id)) onChange({ type: 'page', id });
      };
      listeners.add(onCraft);
      const off = seam.onEvent((event) => {
        if (event.type !== 'entity.upsert') return;
        const id = event.entity.id as EntityId;
        if (pageIds().has(id)) onChange({ type: 'page', id });
      });
      return () => {
        listeners.delete(onCraft);
        off();
      };
    },
  };
}

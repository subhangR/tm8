/**
 * WHERE ONE DESIGN READS AND WRITES (Craft → Designs, change list item 10).
 * The design screen's port, beside the home's (`designs-source.ts`): a node
 * backed source (`designSourceFromSeam`) and a client fixture
 * (`fixtureDesignSource`) for tests and until the design kind lands on a node.
 *
 * Zero new catalog ops: a page is a `contains` edge from the design, so add,
 * reorder and remove are `collections.addItem` / `collections.removeItem`
 * (re-adding a member re-positions it), a new page is `entities.create` then
 * add, and the read is the design's own detail, which carries its pages in
 * order. "Remove from design" takes the edge away and never the entity.
 */
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DESIGN_KIND, designContentOf } from '../domain';

/** One page as the row and body need it. */
export interface DesignPageRow {
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

export interface DesignRead {
  id: EntityId;
  title: string;
  version: number;
  pages: DesignPageRow[];
}

/** The kinds `[+ page]` can make. Artifacts have no generic create; the menu says so. */
export const NEW_PAGE_KINDS = ['graph', 'doc', 'artifact', 'drawing', 'design'] as const;
export type NewPageKind = (typeof NEW_PAGE_KINDS)[number];

/** A change the screen may need to react to. */
export type DesignChange =
  | { type: 'design' }
  | { type: 'page'; id: EntityId }
  | { type: 'deleted'; id: EntityId };

export interface DesignSource {
  read(designId: EntityId): Promise<DesignRead>;
  /** Create a new entity of `kind` and add it as a page at `position`. Resolves the page id. */
  createPage(designId: EntityId, kind: Exclude<NewPageKind, 'artifact'>, position: number): Promise<EntityId>;
  /** Add an existing entity as a page (or move one already in it) to `position`. */
  placePage(designId: EntityId, entityId: EntityId, position: number): Promise<void>;
  /** Take the page out of the design. The entity itself is untouched. */
  removePage(designId: EntityId, entityId: EntityId): Promise<void>;
  rename(designId: EntityId, title: string, expectedVersion: number): Promise<void>;
  /** One bounded recent page of candidates for "Add existing entity…". */
  candidates(text: string): Promise<EntitySummary[]>;
  /** Call back on any change to the design or to one of `pageIds()`. Returns the unsubscribe. */
  subscribe(designId: EntityId, pageIds: () => ReadonlySet<string>, onChange: (change: DesignChange) => void): () => void;
}

function cmid(tag: string): string {
  return `design:${tag}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** The title a fresh page of each kind starts with. */
export function newPageTitle(kind: NewPageKind): string {
  return kind === 'graph' ? 'Untitled graph' : kind === 'design' ? 'Untitled design' : `Untitled ${kind}`;
}

function contentFor(kind: Exclude<NewPageKind, 'artifact'>): Record<string, unknown> | undefined {
  if (kind === 'graph') return { graphType: 'entity' };
  if (kind === 'design') return { description: '' };
  return undefined;
}

export function pageRowOf(page: EntitySummary & { pagePosition?: number | null }): DesignPageRow {
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
export function positionAt(pages: readonly Pick<DesignPageRow, 'position'>[], index: number): number {
  const before = index > 0 ? pages[index - 1]?.position ?? null : null;
  const after = pages[index]?.position ?? null;
  if (before !== null && after !== null) return (before + after) / 2;
  if (before !== null) return before + 1;
  if (after !== null) return after - 1;
  return index + 1;
}

export function designSourceFromSeam(seam: Seam, spaceId: SpaceId): DesignSource {
  return {
    async read(designId) {
      const detail = await seam.entity(designId);
      return {
        id: detail.id,
        title: detail.title,
        version: detail.version,
        pages: designContentOf(detail.content).pages.map(pageRowOf),
      };
    },
    async createPage(designId, kind, position) {
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
      await seam.commands.addToCollection(designId, { clientMutationId: cmid('add'), entityId: id, position });
      return id;
    },
    async placePage(designId, entityId, position) {
      await seam.commands.addToCollection(designId, { clientMutationId: cmid('place'), entityId, position });
    },
    async removePage(designId, entityId) {
      await seam.commands.removeFromCollection(designId, entityId, { clientMutationId: cmid('remove') });
    },
    async rename(designId, title, expectedVersion) {
      await seam.commands.patchEntity(designId, { clientMutationId: cmid('rename'), expectedVersion, title });
    },
    async candidates() {
      const result = await seam.query({ spaceId, sort: 'activityAt_desc', limit: 50 });
      return result.page.items;
    },
    subscribe(designId, pageIds, onChange) {
      return seam.onEvent((event) => {
        if (event.type === 'edge.upsert' || event.type === 'edge.deleted') {
          if (event.edge.type === 'contains' && event.edge.source.id === designId) onChange({ type: 'design' });
          return;
        }
        if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
        const id = event.entity.id as EntityId;
        if (id === designId) onChange(event.type === 'entity.deleted' ? { type: 'deleted', id } : { type: 'design' });
        else if (pageIds().has(id)) onChange(event.type === 'entity.deleted' ? { type: 'deleted', id } : { type: 'page', id });
      });
    },
  };
}

/**
 * A client fixture over a REAL seam for the pages: the design and its page
 * list live here in memory, while the pages themselves are created and read
 * through the seam, so a page body renders exactly as it would on a node.
 */
export interface FixtureDesignRecord {
  id: EntityId;
  title: string;
  version: number;
  pages: DesignPageRow[];
}

export function fixtureDesignSource(
  seam: Seam,
  spaceId: SpaceId,
  seed: readonly { id: EntityId; title: string; pages?: readonly DesignPageRow[] }[] = [],
): DesignSource & { readonly designs: Map<string, FixtureDesignRecord> } {
  const designs = new Map<string, FixtureDesignRecord>(
    seed.map((design) => [design.id, { id: design.id, title: design.title, version: 1, pages: [...(design.pages ?? [])] }]),
  );
  const listeners = new Set<(designId: EntityId) => void>();
  let next = 1;
  const need = (id: EntityId) => {
    const design = designs.get(id);
    if (!design) throw Object.assign(new Error(`${id} not found`), { code: 'not_found' });
    return design;
  };
  const changed = (design: FixtureDesignRecord) => {
    design.version += 1;
    design.pages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const listener of listeners) listener(design.id);
  };
  const rowFor = async (entityId: EntityId, position: number): Promise<DesignPageRow> => {
    const nested = designs.get(entityId);
    if (nested) {
      return { id: entityId, kind: 'design', title: nested.title, version: nested.version, activityAt: new Date().toISOString(), position, running: false };
    }
    const detail = await seam.entity(entityId);
    return { ...pageRowOf(detail), position };
  };
  const place = async (designId: EntityId, entityId: EntityId, position: number) => {
    const design = need(designId);
    if (entityId === designId) throw Object.assign(new Error('A design cannot contain itself.'), { code: 'invalid_input' });
    const existing = design.pages.find((page) => page.id === entityId);
    if (existing) existing.position = position;
    else design.pages.push(await rowFor(entityId, position));
    changed(design);
  };
  return {
    designs,
    async read(designId) {
      const design = need(designId);
      /* A nested design's title is read live, as a node's page summary would be. */
      const pages = design.pages.map((page) => ({ ...page, title: designs.get(page.id)?.title ?? page.title }));
      return { id: design.id, title: design.title, version: design.version, pages };
    },
    async createPage(designId, kind, position) {
      let id: EntityId;
      if (kind === 'design') {
        id = `fixture-design-page-${next++}` as EntityId;
        designs.set(id, { id, title: newPageTitle(kind), version: 1, pages: [] });
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
      await place(designId, id, position);
      return id;
    },
    placePage: place,
    async removePage(designId, entityId) {
      const design = need(designId);
      design.pages = design.pages.filter((page) => page.id !== entityId);
      changed(design);
    },
    async rename(designId, title) {
      const design = need(designId);
      design.title = title;
      changed(design);
    },
    async candidates() {
      const result = await seam.query({ spaceId, sort: 'activityAt_desc', limit: 50 });
      return result.page.items;
    },
    subscribe(designId, pageIds, onChange) {
      const onDesign = (id: EntityId) => {
        if (id === designId) onChange({ type: 'design' });
        else if (pageIds().has(id)) onChange({ type: 'page', id });
      };
      listeners.add(onDesign);
      const off = seam.onEvent((event) => {
        if (event.type !== 'entity.upsert') return;
        const id = event.entity.id as EntityId;
        if (pageIds().has(id)) onChange({ type: 'page', id });
      });
      return () => {
        listeners.delete(onDesign);
        off();
      };
    },
  };
}

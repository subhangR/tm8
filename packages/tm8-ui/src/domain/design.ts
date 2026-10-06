/**
 * The `design` kind (Craft → Designs, change list items 1–2 and 7): an ORDERED
 * set of pages, each page any entity, held as `contains` edges ordered by
 * `props.position`. No wrapper per page — the page IS the doc or graph.
 *
 * The shapes are the contract's (`@tm8/contract` design.ts, migration 304);
 * this file adds the UI's tolerant readers over them.
 */
import type { CreatableEntityKind, DesignContent, DesignPage, DesignState, EntityKind } from '@tm8/contract';

export type { DesignContent, DesignPage, DesignState } from '@tm8/contract';

export type DesignKind = 'design';
/** The kind, for the registry row, `entities.create` and the query filter. */
export const DESIGN_KIND = 'design' satisfies CreatableEntityKind;

/** A design's content as the UI reads it: pages always an array, in order. */
export type DesignContentRead = Pick<DesignContent, 'description'> & { pages: DesignPage[] };

/** The design state off a row, or null when the row is not a design. */
export function designStateOf(row: { kind: EntityKind | string; state: unknown }): DesignState | null {
  if (row.kind !== DESIGN_KIND) return null;
  const state = row.state as Partial<DesignState> | null | undefined;
  return {
    kind: 'design',
    pageCount: typeof state?.pageCount === 'number' ? state.pageCount : 0,
    pageKinds: Array.isArray(state?.pageKinds) ? state.pageKinds : [],
  };
}

/**
 * The design content off a row, tolerant of a missing body. `pages` is null
 * outside detail reads; that reads as no pages known, never as an error.
 */
export function designContentOf(content: unknown): DesignContentRead {
  const body = (content ?? {}) as Partial<DesignContent>;
  return {
    description: typeof body.description === 'string' ? body.description : '',
    pages: Array.isArray(body.pages)
      ? body.pages.map((page) => ({ ...page, pagePosition: typeof page.pagePosition === 'number' ? page.pagePosition : null }))
      : [],
  };
}

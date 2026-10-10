/**
 * The `craft` kind (born `design` in migration 304, renamed by 322): an ORDERED
 * set of pages, each page any entity, held as `contains` edges ordered by
 * `props.position`. No wrapper per page — the page IS the doc or graph.
 *
 * The shapes are the contract's (`@tm8/contract` craft.ts); this file adds the
 * UI's tolerant readers over them.
 */
import type { CraftContent, CraftPage, CraftState, CreatableEntityKind, EntityKind } from '@tm8/contract';

export type { CraftContent, CraftPage, CraftState } from '@tm8/contract';

export type CraftKind = 'craft';
/** The kind, for the registry row, `entities.create` and the query filter. */
export const CRAFT_KIND = 'craft' satisfies CreatableEntityKind;

/** A craft's content as the UI reads it: pages always an array, in order. */
export type CraftContentRead = Pick<CraftContent, 'description'> & { pages: CraftPage[] };

/** The craft state off a row, or null when the row is not a craft. */
export function craftStateOf(row: { kind: EntityKind | string; state: unknown }): CraftState | null {
  if (row.kind !== CRAFT_KIND) return null;
  const state = row.state as Partial<CraftState> | null | undefined;
  return {
    kind: 'craft',
    pageCount: typeof state?.pageCount === 'number' ? state.pageCount : 0,
    pageKinds: Array.isArray(state?.pageKinds) ? state.pageKinds : [],
  };
}

/**
 * The craft content off a row, tolerant of a missing body. `pages` is null
 * outside detail reads; that reads as no pages known, never as an error.
 */
export function craftContentOf(content: unknown): CraftContentRead {
  const body = (content ?? {}) as Partial<CraftContent>;
  return {
    description: typeof body.description === 'string' ? body.description : '',
    pages: Array.isArray(body.pages)
      ? body.pages.map((page) => ({ ...page, pagePosition: typeof page.pagePosition === 'number' ? page.pagePosition : null }))
      : [],
  };
}

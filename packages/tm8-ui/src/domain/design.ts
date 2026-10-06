/**
 * The `design` kind (Craft → Designs, change list items 1–2 and 7): an ORDERED
 * set of pages, each page any entity, held as `contains` edges ordered by
 * `props.position`. No wrapper per page — the page IS the doc or graph.
 *
 * LOCAL MIRROR of the contract shape until the backend lane lands it. The
 * shapes below are exactly what that lane adds to `@tm8/contract`; when it
 * does, this file's types become one re-export:
 *
 *   export type { DesignState, DesignContent, DesignPage } from '@tm8/contract';
 *
 * and `DESIGN_KIND`'s one cast below becomes `'design' satisfies CreatableEntityKind`.
 */
import type { CoreEntityKind, CreatableEntityKind, EntityKind, EntitySummary } from '@tm8/contract';

export type DesignKind = 'design';
/**
 * The kind, typed as the creatable core kind it is about to be. THE ONE
 * CAST: the registry row, `entities.create` and the query filter all take a
 * `CoreEntityKind` / `CreatableEntityKind`, and widening those types for a few days would touch a
 * dozen call sites that then have to be put back.
 */
export const DESIGN_KIND = 'design' as DesignKind as unknown as Extract<CreatableEntityKind, CoreEntityKind>;

/** `state` on a design row: the page count and page kinds, computed by the server at read time. */
export interface DesignState {
  kind: DesignKind;
  pageCount: number;
  /** The pages' kinds, in page order. */
  pageKinds?: string[];
}

/** One page: the entity's own summary plus its `contains` edge position. */
export type DesignPage = EntitySummary & { pagePosition: number | null };

/** `content` on a design row: its description and its pages, IN ORDER (null on non-detail reads). */
export interface DesignContent {
  description: string;
  pages: DesignPage[];
}

/** The design state off a row, or null when the row is not a design. */
export function designStateOf(row: { kind: EntityKind | string; state: unknown }): DesignState | null {
  if (row.kind !== DESIGN_KIND) return null;
  const state = row.state as Partial<DesignState> | null | undefined;
  return {
    kind: 'design',
    pageCount: typeof state?.pageCount === 'number' ? state.pageCount : 0,
    ...(Array.isArray(state?.pageKinds) ? { pageKinds: state.pageKinds } : {}),
  };
}

/** The design content off a row (detail read), tolerant of a missing body. */
export function designContentOf(content: unknown): DesignContent {
  const body = (content ?? {}) as Partial<DesignContent>;
  return {
    description: typeof body.description === 'string' ? body.description : '',
    pages: Array.isArray(body.pages)
      ? body.pages.map((page) => ({ ...page, pagePosition: typeof page.pagePosition === 'number' ? page.pagePosition : null }))
      : [],
  };
}

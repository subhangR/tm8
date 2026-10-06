// Design as an Entity (migration 304, Craft → Designs, task 01a1118f;
// change list items 1-2, Subhang 2026-10-06).
//
// A design is a title and a description holding an ordered set of PAGES. A
// page is ANY entity — a graph, a doc, an artifact, a drawing, another design
// — held as an ordered `contains` edge from the design (`props.position`).
// There is no per-page wrapper entity: the page IS the doc or the graph and
// opens normally anywhere else.
//
// Where each piece is read from (no new catalog rows):
//   * `DesignState`   — the entity's `state` on BOTH read paths (entities.get /
//                       list rows via the facade, and every `entity.upsert`
//                       event via the projector). Both select the same SQL
//                       function, `internal.design_summary(id)`.
//   * `DesignContent` — the entity's `content`. `pages` is filled on a DETAIL
//                       read (entities.get) in page order; it is `null` on
//                       every surface that does not hydrate detail (command
//                       results, version snapshots), never a misleading `[]`.
//   * pages           — written through the existing membership doors:
//                       `collections.addItem` (`tm8 collection add <design>
//                       <entity> [--position n]`) adds or RE-POSITIONS a page,
//                       `collections.removeItem` takes one out without
//                       deleting the entity. A design never contains itself or
//                       a design above it (the server refuses the loop).
//   * agents          — `tm8 entity context <design>` lists the pages (kind,
//                       title, id, position) as its `pages` field.
import { z } from 'zod';
import type { EntitySummary } from './contract.js';

/**
 * A design's row facts (`internal.design_summary`): how many live pages it
 * holds, and their kinds IN PAGE ORDER — enough for a Designs card to draw its
 * page icons without a detail read.
 */
export interface DesignState {
  kind: 'design';
  pageCount: number;
  pageKinds: string[];
}

/**
 * One page of a design: the page entity's ordinary summary, plus its place in
 * this design. `pagePosition` is the `contains` edge's `props.position`
 * (null only for an edge written without one); `position` stays the entity's
 * own envelope position, as on every summary.
 */
export interface DesignPage extends EntitySummary {
  pagePosition: number | null;
}

/** A design's content. `pages` is ordered by `pagePosition`; null when not hydrated. */
export interface DesignContent {
  kind: 'design';
  description: string;
  pages: DesignPage[] | null;
}

/**
 * The create/patch door's input. A patch carries only what changed; `null`
 * MERGES in the door. Title rides the envelope's `title`. Pages are never
 * written here: they are `contains` edges (`collections.addItem`).
 */
export const DesignContentInputSchema = z.object({
  kind: z.literal('design').optional(),
  description: z.string().max(20000).optional(),
}).strict();
export type DesignContentInput = z.infer<typeof DesignContentInputSchema>;

export const DesignStateSchema = z.object({
  kind: z.literal('design'),
  pageCount: z.number().int().nonnegative(),
  pageKinds: z.array(z.string()),
}).strict();

export const DesignContentSchema = z.object({
  kind: z.literal('design'),
  description: z.string(),
  // EntitySummary & { pagePosition }: the summary schema lives in schemas.ts,
  // which imports this module, so the rows are checked loosely here.
  pages: z.array(z.record(z.unknown())).nullable(),
}).passthrough();

/** One page on `tm8 entity context <design>` (v2 `pages`). Capped at 50; a cut adds `omitted[]`. */
export type EntityContextDesignPage =
  | { id: string; kind: string; title: string; status: string; position: number | null;
      titleTruncated?: true; deleted?: true }
  | { id: string; unreadable: true; position: number | null };

export const EntityContextDesignPageSchema = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string(),
    status: z.string(),
    position: z.number().nullable(),
    titleTruncated: z.literal(true).optional(),
    deleted: z.literal(true).optional(),
  }).strict(),
  z.object({ id: z.string().min(1), unreadable: z.literal(true), position: z.number().nullable() }).strict(),
]);

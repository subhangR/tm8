// Craft as an Entity (migration 304 as `design`, renamed to `craft` by 316;
// task 01a1118f, change list items 1-2, Subhang 2026-10-06; rename 01a1255e).
//
// A craft is a title and a description holding an ordered set of PAGES. A
// page is ANY entity — a graph, a doc, an artifact, a drawing, another craft
// — held as an ordered `contains` edge from the craft (`props.position`).
// There is no per-page wrapper entity: the page IS the doc or the graph and
// opens normally anywhere else.
//
// Where each piece is read from (no new catalog rows):
//   * `CraftState`   — the entity's `state` on BOTH read paths (entities.get /
//                       list rows via the facade, and every `entity.upsert`
//                       event via the projector). Both select the same SQL
//                       function, `internal.craft_summary(id)`.
//   * `CraftContent` — the entity's `content`. `pages` is filled on a DETAIL
//                       read (entities.get) in page order; it is `null` on
//                       every surface that does not hydrate detail (command
//                       results, version snapshots), never a misleading `[]`.
//   * pages           — written through the existing membership doors:
//                       `collections.addItem` (`tm8 collection add <craft>
//                       <entity> [--position n]`) adds or RE-POSITIONS a page,
//                       `collections.removeItem` takes one out without
//                       deleting the entity. A craft never contains itself or
//                       a craft above it (the server refuses the loop).
//   * agents          — `tm8 entity context <craft>` lists the pages (kind,
//                       title, id, position) as its `pages` field.
import { z } from 'zod';
import type { EntitySummary } from './contract.js';

/**
 * A craft's row facts (`internal.craft_summary`): how many live pages it
 * holds, and their kinds IN PAGE ORDER — enough for a Crafts card to draw its
 * page icons without a detail read.
 */
export interface CraftState {
  kind: 'craft';
  pageCount: number;
  pageKinds: string[];
}

/**
 * One page of a craft: the page entity's ordinary summary, plus its place in
 * this craft. `pagePosition` is the `contains` edge's `props.position`
 * (null only for an edge written without one); `position` stays the entity's
 * own envelope position, as on every summary.
 */
export interface CraftPage extends EntitySummary {
  pagePosition: number | null;
}

/** A craft's content. `pages` is ordered by `pagePosition`; null when not hydrated. */
export interface CraftContent {
  kind: 'craft';
  description: string;
  pages: CraftPage[] | null;
}

/**
 * The create/patch door's input. A patch carries only what changed; `null`
 * MERGES in the door. Title rides the envelope's `title`. Pages are never
 * written here: they are `contains` edges (`collections.addItem`).
 */
export const CraftContentInputSchema = z.object({
  kind: z.literal('craft').optional(),
  description: z.string().max(20000).optional(),
}).strict();
export type CraftContentInput = z.infer<typeof CraftContentInputSchema>;

export const CraftStateSchema = z.object({
  kind: z.literal('craft'),
  pageCount: z.number().int().nonnegative(),
  pageKinds: z.array(z.string()),
}).strict();

export const CraftContentSchema = z.object({
  kind: z.literal('craft'),
  description: z.string(),
  // EntitySummary & { pagePosition }: the summary schema lives in schemas.ts,
  // which imports this module, so the rows are checked loosely here.
  pages: z.array(z.record(z.unknown())).nullable(),
}).passthrough();

/** One page on `tm8 entity context <craft>` (v2 `pages`). Capped at 50; a cut adds `omitted[]`. */
export type EntityContextCraftPage =
  | { id: string; kind: string; title: string; status: string; position: number | null;
      titleTruncated?: true; deleted?: true }
  | { id: string; unreadable: true; position: number | null };

export const EntityContextCraftPageSchema = z.union([
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

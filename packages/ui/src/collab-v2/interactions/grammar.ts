/**
 * THE drag/drop grammar table (Layer 6) — single source of truth for
 * `source kind × target surface → meaning` (UX brief §6.2, prototype
 * "Entity Contract Spec" §3). Every drop anywhere in the app resolves
 * through `resolveDrop`; every keyboard equivalent (Move to…, Link…)
 * resolves through the SAME rows, so mouse and keyboard cannot drift.
 *
 * Encoding rules:
 *  - A row is DATA: a target surface, a source predicate, and 1–3
 *    `PlacementOption`s (ghost label + `placements` intent). Adding a row to
 *    the product grammar = adding one entry to GRAMMAR_TABLE, nothing else.
 *  - Source predicates go through registry capability data
 *    (`kindCan`, `capabilities.actor`) wherever a capability exists; the two
 *    literal kind sets below are grammar-table data in the same sense the
 *    registry's own tables are (each is annotated for the purity scanner).
 *  - Table order is precedence: within a surface, the FIRST matching row
 *    wins. `resolveDrop` never returns more than MAX_DROP_OPTIONS options.
 */
import { kindCan, registryFor, truncate } from '../registry';
import type { EntityId, EntityKind, EntitySummary, PlacementIntent } from '../types/contract';

/** The five drop surfaces of the grammar (targets declare which one they are). */
export type DropSurfaceKind = 'channel' | 'task' | 'actor' | 'composer' | 'parent-zone';

/** What a drag carries — same shape as `EntityDragPayload` (entity/). */
export interface DragSourceRef { entityId: EntityId; kind: EntityKind; title: string }

/** A registered drop target: a surface wrapped around a concrete entity. */
export interface DropTargetRef {
  surface: DropSurfaceKind;
  entityId: EntityId;
  kind: EntityKind;
  title: string;
}

/** One explicit meaning a drop can commit to. */
export interface PlacementOption {
  intent: PlacementIntent;
  /** Row label in the ambiguity drop menu ("Attach", "Depend", "Subtask"). */
  label: string;
  /** Ghost preview shown BEFORE the drop commits ("Attach to #v2-build"). */
  ghost: string;
  /** attach-variant that also posts a live Z2 card into the target's feed. */
  withEmbed?: boolean;
}

export interface GrammarRow {
  /** Stable row id (tests + debugging). */
  id: string;
  surface: DropSurfaceKind;
  /** Human sentence for empty states / docs ("doc / file / spell → task"). */
  describes: string;
  accepts: (source: DragSourceRef, target: DropTargetRef) => boolean;
  options: (source: DragSourceRef, target: DropTargetRef) => PlacementOption[];
}

/** Ambiguity resolves via a tiny drop menu — never more than 3 options. */
export const MAX_DROP_OPTIONS = 3;

/** Attachable artifacts of the task row. // registry-purity: allow — grammar table row data (§6.2: doc/file/spell → task) */
const ARTIFACT_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['doc', 'file', 'spell']);

const isActor = (kind: EntityKind): boolean => registryFor(kind).capabilities.actor !== null;
const isTask = (kind: EntityKind): boolean => kindCan(kind, 'workStatusBearing');

const short = (title: string): string => truncate(title, 40);

/**
 * The 7 rows of the prototype's grammar table, in precedence order.
 * Row order within a surface matters; across surfaces it does not.
 */
export const GRAMMAR_TABLE: readonly GrammarRow[] = [
  {
    id: 'chip-to-channel',
    surface: 'channel',
    describes: 'any chip/card → channel = attached_to (+ optional embed message)',
    accepts: () => true,
    options: (source, target) => [
      { intent: 'attach', label: 'Attach', ghost: `Attach to #${short(target.title)}` },
      {
        intent: 'attach', label: 'Attach & post card', withEmbed: true,
        ghost: `Attach to #${short(target.title)} + post card`,
      },
    ],
  },
  {
    id: 'task-to-task',
    surface: 'task',
    describes: 'task → task = attach | depend | subtask (3-zone drop menu)',
    accepts: (source, target) => isTask(source.kind) && isTask(target.kind),
    options: (source, target) => [
      { intent: 'attach', label: 'Attach', ghost: `Attach to ${short(target.title)}` },
      // placements `depend` = TARGET depends_on SOURCE (the dropped task
      // becomes a prerequisite of the task it lands on) — STATE.md gotcha.
      { intent: 'depend', label: 'Depend', ghost: `${short(target.title)} depends on ${short(source.title)}` },
      { intent: 'subtask', label: 'Subtask', ghost: `Subtask of ${short(target.title)}` },
    ],
  },
  {
    id: 'artifact-to-task',
    surface: 'task',
    describes: 'doc / file / spell → task = attached_to',
    accepts: (source, target) => ARTIFACT_KINDS.has(source.kind) && isTask(target.kind),
    options: (source, target) => [
      { intent: 'attach', label: 'Attach', ghost: `Attach to ${short(target.title)}` },
    ],
  },
  {
    id: 'actor-to-task',
    surface: 'task',
    describes: 'member / team_member → task = assigned_to',
    accepts: (source, target) => isActor(source.kind) && isTask(target.kind),
    options: (source) => [
      { intent: 'assign', label: 'Assign', ghost: `Assign to ${short(source.title)}` },
    ],
  },
  {
    id: 'task-to-actor',
    surface: 'actor',
    describes: 'task → member / team_member = assigned_to',
    accepts: (source, target) => isTask(source.kind) && isActor(target.kind),
    options: (source) => [
      { intent: 'assign', label: 'Assign', ghost: `Assign ${short(source.title)}` },
    ],
  },
  {
    id: 'chip-to-composer',
    surface: 'composer',
    describes: 'any chip → message composer = embed (Z2 card in message)',
    accepts: () => true,
    options: (source) => [
      { intent: 'embed', label: 'Embed', ghost: `Embed ${short(source.title)}` },
    ],
  },
  {
    id: 'same-kind-to-parent-zone',
    surface: 'parent-zone',
    describes: 'same-kind entity → parent zone = reparent (hierarchy move)',
    accepts: (source, target) =>
      source.kind === target.kind && kindCan(source.kind, 'treeReparentable'),
    options: (source, target) => [
      { intent: 'reparent', label: 'Move here', ghost: `Move into ${short(target.title)}` },
    ],
  },
];

/**
 * Resolve a drag over a target to its explicit meaning(s).
 * [] = the surface rejects this source (targets render no highlight);
 * exactly 1 = commit on drop; 2–3 = show the drop menu.
 */
export function resolveDrop(source: DragSourceRef, target: DropTargetRef): PlacementOption[] {
  if (source.entityId === target.entityId) return [];
  const row = GRAMMAR_TABLE.find((r) => r.surface === target.surface && r.accepts(source, target));
  if (!row) return [];
  const options = row.options(source, target);
  if (options.length > MAX_DROP_OPTIONS) {
    throw new Error(`grammar row ${row.id} offers ${options.length} options (max ${MAX_DROP_OPTIONS})`);
  }
  return options;
}

/** The row a (source, target) pair falls into — tests and teaching copy. */
export function rowFor(source: DragSourceRef, target: DropTargetRef): GrammarRow | null {
  if (source.entityId === target.entityId) return null;
  return GRAMMAR_TABLE.find((r) => r.surface === target.surface && r.accepts(source, target)) ?? null;
}

/** DragSourceRef / DropTargetRef from a summary (helpers for hosts + tests). */
export function sourceRef(e: EntitySummary): DragSourceRef {
  return { entityId: e.id, kind: e.kind, title: e.title };
}
export function targetRef(e: EntitySummary, surface: DropSurfaceKind): DropTargetRef {
  return { surface, entityId: e.id, kind: e.kind, title: e.title };
}

/**
 * The natural drop surface of an entity, for generic hosts (a Z2 card grid
 * that wants "drop onto the card = drop onto the entity"). Explicit surface
 * declarations (useDropSurface) always win over this inference.
 */
export function surfaceForEntity(e: { kind: EntityKind }): DropSurfaceKind | null {
  if (isTask(e.kind)) return 'task';
  if (isActor(e.kind)) return 'actor';
  if (e.kind === 'channel') return 'channel'; // registry-purity: allow — grammar surface data (§6.2 row 1: the channel feed/shelf IS the 'channel' surface)
  return null;
}

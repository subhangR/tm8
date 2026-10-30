/**
 * Labels (migration 408; BRIDGE-ENTITY-DESIGN v4 §3.8, D27).
 *
 * A label is a flat, space-level entity: a name (unique per space, case-
 * insensitive, across live and archived labels), a colour and a description.
 * Entities carry label IDS on the envelope (`EntitySummary.labels`), so a
 * rename never touches a labelled entity. Deleting a label archives it: the id
 * stays valid where it is already used, and the label leaves `labels.list` and
 * every picker. Every space is seeded with `bug`.
 */
import { z } from 'zod';

const Id = z.string().uuid();

export const LABEL_NAME_MAX = 64;
export const LABEL_DESCRIPTION_MAX = 500;
/** An entity carries at most this many labels (408's guard). */
export const ENTITY_LABELS_MAX = 32;
/** The colour a label gets when none is given. */
export const LABEL_DEFAULT_COLOUR = '#6b7280';
/** Seeded in every space (D29: a bug is a task labelled `bug`). */
export const SEEDED_LABEL_NAMES = ['bug'] as const;

/** `#rrggbb`; the server lower-cases it and accepts it without the `#`. */
export const LabelColourSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'a hex colour like #d73a4a');
export const LabelNameSchema = z.string().trim().min(1).max(LABEL_NAME_MAX);

/** A label as `labels.*` return it. */
export const LabelViewSchema = z.object({
  id: Id,
  spaceId: Id,
  version: z.number().int().positive(),
  name: z.string(),
  colour: z.string(),
  description: z.string(),
  /** Archived labels stay valid where used and are hidden from pickers. */
  archivedAt: z.string().nullable(),
}).strict();
export type LabelView = z.infer<typeof LabelViewSchema>;

/** A label entity's state and content arm (both read paths). */
export const LabelEntitySchema = z.object({
  kind: z.literal('label'),
  name: z.string(),
  colour: z.string(),
  description: z.string(),
  archivedAt: z.string().nullable(),
}).strict();
export type LabelEntity = z.infer<typeof LabelEntitySchema>;

const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };

/** GET query. `includeArchived` lists archived labels too (settings, history). */
export const LabelsListInputSchema = z.object({
  includeArchived: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
}).strict();
export type LabelsListInput = z.infer<typeof LabelsListInputSchema>;

export const LabelCreateInputSchema = z.object({
  ...Command,
  // The route names the space; a repeated body id must agree with it.
  spaceId: Id.optional(),
  name: LabelNameSchema,
  colour: LabelColourSchema.optional(),
  description: z.string().max(LABEL_DESCRIPTION_MAX).optional(),
}).strict();
export type LabelCreateInput = z.infer<typeof LabelCreateInputSchema>;

export const LabelUpdateInputSchema = z.object({
  ...Command,
  labelId: Id.optional(),
  expectedVersion: z.number().int().positive(),
  name: LabelNameSchema.optional(),
  colour: LabelColourSchema.optional(),
  description: z.string().max(LABEL_DESCRIPTION_MAX).optional(),
  /** `true` archives, `false` restores. */
  archived: z.boolean().optional(),
}).strict().refine(
  (input) => input.name !== undefined || input.colour !== undefined
    || input.description !== undefined || input.archived !== undefined,
  'give at least one of name, colour, description or archived',
);
export type LabelUpdateInput = z.infer<typeof LabelUpdateInputSchema>;

export const LabelArchiveInputSchema = z.object({
  ...Command,
  labelId: Id.optional(),
  expectedVersion: z.number().int().positive(),
}).strict();
export type LabelArchiveInput = z.infer<typeof LabelArchiveInputSchema>;

/**
 * `entities.patch`'s `labels` member: label ids to add and to remove, applied
 * under the patch's `expectedVersion`. Adding an archived label is refused;
 * removing one is always allowed.
 */
export const EntityLabelsPatchSchema = z.object({
  add: z.array(Id).max(ENTITY_LABELS_MAX).optional(),
  remove: z.array(Id).max(ENTITY_LABELS_MAX).optional(),
}).strict().refine(
  (patch) => (patch.add?.length ?? 0) + (patch.remove?.length ?? 0) > 0,
  'labels names nothing to add or remove',
);
export type EntityLabelsPatch = z.infer<typeof EntityLabelsPatchSchema>;

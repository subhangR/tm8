import {
  CollabError,
  InteractionProfilePinViewSchema,
  type InteractionProfilePinView,
} from '@tm8/contract';
import { z } from 'zod';

import type { Db, DbClaims } from '../db/types.js';

export interface StaticChatTemplateRegistryEntry {
  readonly key: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly composerSchemaRef: string;
  readonly allowedOperationBindings: readonly string[];
}

const CORE_TEMPLATE: StaticChatTemplateRegistryEntry = Object.freeze({
  key: 'tm8.chat.core',
  version: 1,
  schemaVersion: 1,
  composerSchemaRef: 'tm8.composer.v1',
  allowedOperationBindings: Object.freeze([
    'messages.post',
    'messages.attachments.add',
    'messages.attachments.remove',
    'readMarks.upsert',
  ]),
});

/** Closed shipped assets. There is deliberately no registration or mutation API. */
export const STATIC_CHAT_TEMPLATE_REGISTRY: readonly StaticChatTemplateRegistryEntry[] =
  Object.freeze([CORE_TEMPLATE]);

const ResolutionSchema = z.object({
  profileId: z.string().nullable(),
  profileVersion: z.number().int().positive().nullable(),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive(),
  resolvedHash: z.string().min(1),
  source: z.enum(['spawn_override', 'teammate_default', 'space_default', 'core_default']),
  snapshot: z.record(z.unknown()),
}).strict().superRefine((value, context) => {
  if ((value.profileId === null) !== (value.profileVersion === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'profile id/version must be jointly nullable' });
  }
  if (value.source === 'core_default' && value.profileId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'core pin cannot reference an entity profile' });
  }
  if (value.source !== 'core_default' && value.profileId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-core pin must reference an entity profile' });
  }
});

export interface ResolveInteractionProfileForLaunchInput {
  readonly spaceId: string;
  readonly teamMemberId?: string | null;
  readonly interactionProfileId?: string | null;
}

export type ResolvedInteractionProfile = Readonly<z.infer<typeof ResolutionSchema>>;

export interface RecordInteractionProfilePinInput {
  readonly workSessionId: string;
  readonly profileId: string | null;
  readonly profileVersion: number | null;
  readonly source: InteractionProfilePinView['source'];
  readonly resolvedHash: string;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function ensureShippedTemplate(key: string, version: number): void {
  if (!STATIC_CHAT_TEMPLATE_REGISTRY.some((entry) => entry.key === key && entry.version === version)) {
    throw new CollabError('upstream_unavailable',
      `resolved Interaction Profile references an unshipped static template ${key}@${version}`);
  }
}

/** Resolve once at launch; consumers receive a deeply immutable canonical snapshot. */
export async function resolveInteractionProfileForLaunch(
  db: Db,
  claims: DbClaims,
  input: ResolveInteractionProfileForLaunchInput,
): Promise<ResolvedInteractionProfile> {
  const raw = await db.rpc<unknown>(claims, 'internal.w2_resolve_interaction_profile_for_launch', [
    input.spaceId,
    input.teamMemberId ?? null,
    input.interactionProfileId ?? null,
  ]);
  const parsed = ResolutionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollabError('upstream_unavailable', 'profile resolver returned a malformed immutable selection');
  }
  ensureShippedTemplate(parsed.data.templateKey, parsed.data.templateVersion);
  return freezeDeep(parsed.data);
}

/**
 * Append the launch pin and materialize selected_profile as recorder-owned
 * provenance. This is intentionally not registered as an HTTP operation.
 */
export async function recordInteractionProfilePin(
  db: Db,
  claims: DbClaims,
  input: RecordInteractionProfilePinInput,
): Promise<InteractionProfilePinView> {
  const raw = await db.rpc<unknown>(claims, 'internal.w2_record_interaction_profile_pin', [
    input.workSessionId,
    input.profileId,
    input.profileVersion,
    input.source,
    input.resolvedHash,
  ]);
  const parsed = InteractionProfilePinViewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollabError('upstream_unavailable', 'profile pin recorder returned a malformed pin');
  }
  ensureShippedTemplate(parsed.data.templateKey, parsed.data.templateVersion);
  return freezeDeep(parsed.data);
}

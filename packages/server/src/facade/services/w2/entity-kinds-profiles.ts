import {
  ActivateInteractionProfileInputSchema,
  CollabError,
  EntityKindCreateInputSchema,
  EntityKindDefSchema,
  EntityKindUpdateInputSchema,
  InteractionProfilePreviewSchema,
  InteractionProfileViewSchema,
  PreviewInteractionProfileInputSchema,
  ProfileValidationViewSchema,
  ProposeInteractionProfileInputSchema,
  RetireInteractionProfileInputSchema,
  SetSpaceProfileDefaultInputSchema,
  SetTeammateProfileDefaultInputSchema,
  SpaceProfileDefaultViewSchema,
  TeammateProfileDefaultViewSchema,
  UpdateInteractionProfileDraftInputSchema,
  ValidateInteractionProfileInputSchema,
  isCollabError,
  type CommandErrorCode,
  type EntityKindDef,
  type OperationName,
} from '@tm8/contract';
import type { z } from 'zod';

import type { OperationHandler } from '../../../http/types.js';
import {
  claimsFor,
  commandEnvelope,
  requireParam,
  requireUuidParam,
  type CommandEnvelope,
} from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

interface EntityKindRow {
  id: string;
  kind: string;
  origin: 'core' | 'custom';
  space_id: string | null;
  icon: string | null;
  base_kind: 'task' | null;
  label: string | null;
  label_plural: string | null;
  workflow_id: string | null;
  field_schema: unknown;
  capabilities: unknown;
  created_by: string | null;
  created_at: string | Date;
}

function invalidInput(message: string): CollabError {
  return new CollabError('invalid_input', message);
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues[0]?.message ?? `invalid ${context}`);
  }
  return parsed.data;
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CollabError('upstream_unavailable', `${context} violates the frozen contract`);
  }
  return parsed.data;
}

function requireClientMutationId(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw invalidInput('clientMutationId is required');
  }
  return value;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toEntityKind(row: EntityKindRow): EntityKindDef {
  return parseResult(EntityKindDefSchema, {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    spaceId: row.space_id,
    icon: row.icon,
    baseKind: row.base_kind ?? null,
    label: row.label ?? null,
    labelPlural: row.label_plural ?? null,
    workflowId: row.workflow_id ?? null,
    fieldSchema: row.field_schema,
    capabilities: row.capabilities,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  }, 'entity-kind row');
}

/**
 * The frozen `details.reason` values this group can raise (dossier §4). They
 * arrive from PostgreSQL as bare RAISE ... DETAIL strings — from 027 for the
 * lifecycle guards and from the frozen 015 human-principal helper — which
 * `db/errors.ts` can only surface as `details.detail`, because it JSON-parses
 * DETAIL and falls back to `{detail}` for a plain string. The dossier's
 * `ErrorDetails` is `{reason: string; ...}`, so lifting them is this seam's
 * job, exactly as the frozen projects group already does for its own reasons.
 */
const FROZEN_PROFILE_REASONS: ReadonlySet<string> = new Set([
  'profile_capture_mode_reserved',
  'profile_not_validated',
  'profile_principal_required',
  'profile_referenced_default',
  'profile_retired',
]);

/** The one reason whose frozen code differs from its SQLSTATE mapping. */
const REASON_CODE_OVERRIDE: Readonly<Record<string, CommandErrorCode>> = {
  profile_referenced_default: 'conflict',
};

function normalizeG12Error(error: unknown, opName: OperationName): never {
  if (!isCollabError(error)) throw error;
  const details = error.details as Record<string, unknown> | undefined;
  const detail = details?.detail;
  if (typeof detail === 'string' && FROZEN_PROFILE_REASONS.has(detail)) {
    const { detail: _lifted, ...rest } = details ?? {};
    throw new CollabError(REASON_CODE_OVERRIDE[detail] ?? error.code, error.message, {
      details: { ...rest, reason: detail },
      current: error.current,
    });
  }
  // Dossier §8.2, `set_space_profile_default`: "After locking the Space row,
  // the RPC compares `expectedSettingsRevision` to `settings_revision`. A
  // mismatch returns `conflict` with `details.currentRevision`." SQLSTATE 40001
  // lands in the entity taxonomy's `version_conflict`, so A20 — and only A20,
  // whose dossier text is explicit — moves it across. A19's optimistic entity
  // version check carries `currentVersion` and stays where it is.
  if (opName === 'spaces.interactionProfile.setDefault'
    && error.code === 'version_conflict'
    && details?.currentRevision !== undefined) {
    throw new CollabError('conflict', error.message, {
      details,
      current: error.current,
    });
  }
  throw error;
}

/** Every one of the eleven operations answers in the frozen error vocabulary. */
async function guarded<T>(opName: OperationName, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    normalizeG12Error(error, opName);
  }
}

/** Bearer-authenticated actor selection is Server-derived, never profile DTO data. */
function requestEnvelope(ctx: Parameters<OperationHandler>[0]): CommandEnvelope {
  const bodyEnvelope = commandEnvelope(ctx);
  return {
    ...(ctx.identity.actorId
      ? { actorId: ctx.identity.actorId }
      : bodyEnvelope.actorId
        ? { actorId: bodyEnvelope.actorId }
        : {}),
    ...(bodyEnvelope.clientMutationId ? { clientMutationId: bodyEnvelope.clientMutationId } : {}),
  };
}

export class W2EntityKindsProfileService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly entityKindsList: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const rows = await guarded('entityKinds.list', () => this.deps.db.query<EntityKindRow>(
      claimsFor(owner, ctx),
      `select id, kind, origin, space_id, icon, base_kind, label, label_plural,
              workflow_id, field_schema, capabilities, created_by, created_at
         from public.entity_kinds
        where space_id = $1 or space_id is null
        order by case origin when 'core' then 0 else 1 end, kind, id`,
      [spaceId],
    ));
    return rows.map(toEntityKind);
  };

  readonly entityKindsCreate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = parseInput(EntityKindCreateInputSchema, ctx.body, 'entity-kind create input');
    const cmid = requireClientMutationId(input.clientMutationId);
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('entityKinds.create', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope),
      'w2_create_entity_kind',
      [
        spaceId,
        input.kind,
        input.icon ?? null,
        input.fieldSchema,
        input.capabilities ?? {},
        envelope.actorId ?? null,
        cmid,
        // 155: the three trailing arguments the door grew when `kind` absorbed
        // the `type` axis. `baseKind` is what makes `c:epic extends task` true
        // rather than merely recorded — it selects WHICH IRREDUCIBLE CODE RUNS
        // for entities of this kind — and it is create-only: `w2_update_entity_kind`
        // refuses it on purpose, because re-basing a kind is a data migration
        // wearing an update's clothes.
        input.baseKind ?? null,
        input.label ?? null,
        input.labelPlural ?? null,
      ],
    ));
    return parseResult(EntityKindDefSchema, raw, 'entity-kind create result');
  };

  readonly entityKindsUpdate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const kind = requireParam(ctx, 'kind');
    const input = parseInput(EntityKindUpdateInputSchema, ctx.body, 'entity-kind update input');
    const cmid = requireClientMutationId(input.clientMutationId);
    const patch: Record<string, unknown> = {};
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.fieldSchema !== undefined) patch.fieldSchema = input.fieldSchema;
    if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
    if (input.allowTightening !== undefined) patch.allowTightening = input.allowTightening;
    // 155: the display vocabulary a `type` value used to carry now lives on the
    // kind. Patch keys are camelCase because the RPC's whitelist reads them that
    // way; `baseKind` is deliberately absent from this list (see create).
    if (input.label !== undefined) patch.label = input.label;
    if (input.labelPlural !== undefined) patch.labelPlural = input.labelPlural;
    if (Object.keys(patch).length === 0) throw invalidInput('entity-kind update must change a field');
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('entityKinds.update', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope),
      'w2_update_entity_kind',
      [spaceId, kind, patch, envelope.actorId ?? null, cmid],
    ));
    return parseResult(EntityKindDefSchema, raw, 'entity-kind update result');
  };

  readonly interactionProfilesPropose: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const pathSpaceId = requireUuidParam(ctx, 'spaceId');
    const input = parseInput(ProposeInteractionProfileInputSchema, ctx.body, 'profile proposal input');
    if (input.spaceId !== pathSpaceId) throw invalidInput('body spaceId must match the route spaceId');
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('interactionProfiles.propose', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope),
      'propose_interaction_profile',
      [pathSpaceId, input.draft, envelope.actorId ?? null, input.clientMutationId],
    ));
    return parseResult(InteractionProfileViewSchema, raw, 'profile proposal result');
  };

  readonly interactionProfilesUpdateDraft: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const profileId = requireUuidParam(ctx, 'profileId');
    const input = parseInput(UpdateInteractionProfileDraftInputSchema, ctx.body, 'profile draft update input');
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('interactionProfiles.updateDraft', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope),
      'update_interaction_profile_draft',
      [profileId, input.expectedVersion, input.draft, envelope.actorId ?? null,
        input.clientMutationId],
    ));
    return parseResult(InteractionProfileViewSchema, raw, 'profile draft update result');
  };

  readonly interactionProfilesValidate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const profileId = requireUuidParam(ctx, 'profileId');
    const input = parseInput(ValidateInteractionProfileInputSchema, ctx.body, 'profile validation input');
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('interactionProfiles.validate', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope),
      'validate_interaction_profile',
      [profileId, input.expectedVersion, input.clientMutationId],
    ));
    return parseResult(ProfileValidationViewSchema, raw, 'profile validation result');
  };

  readonly interactionProfilesPreview: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const profileId = requireUuidParam(ctx, 'profileId');
    const input = parseInput(PreviewInteractionProfileInputSchema, ctx.body, 'profile preview input');
    const envelope = requestEnvelope(ctx);
    const raw = await guarded('interactionProfiles.preview', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, envelope.actorId ? { actorId: envelope.actorId } : {}),
      'preview_interaction_profile',
      [profileId, input.profileVersion],
    ));
    return parseResult(InteractionProfilePreviewSchema, raw, 'profile preview result');
  };

  readonly interactionProfilesActivate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const profileId = requireUuidParam(ctx, 'profileId');
    const input = parseInput(ActivateInteractionProfileInputSchema, ctx.body, 'profile activation input');
    const raw = await guarded('interactionProfiles.activate', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, requestEnvelope(ctx)),
      'activate_interaction_profile',
      [profileId, input.validatedVersion, input.validatedHash, input.confirm, input.clientMutationId],
    ));
    return parseResult(InteractionProfileViewSchema, raw, 'profile activation result');
  };

  readonly interactionProfilesRetire: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const profileId = requireUuidParam(ctx, 'profileId');
    const input = parseInput(RetireInteractionProfileInputSchema, ctx.body, 'profile retirement input');
    const raw = await guarded('interactionProfiles.retire', () => this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, requestEnvelope(ctx)),
      'retire_interaction_profile',
      [profileId, input.expectedVersion, input.confirm, input.clientMutationId],
    ));
    return parseResult(InteractionProfileViewSchema, raw, 'profile retirement result');
  };

  readonly teamMembersInteractionProfileSetDefault: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const teamMemberId = requireUuidParam(ctx, 'teamMemberId');
    const input = parseInput(SetTeammateProfileDefaultInputSchema, ctx.body, 'Teammate profile default input');
    const raw = await guarded('teamMembers.interactionProfile.setDefault',
      () => this.deps.db.rpc<unknown>(
        claimsFor(owner, ctx, requestEnvelope(ctx)),
        'set_teammate_profile_default',
        [teamMemberId, input.profileId, input.expectedVersion, input.clientMutationId],
      ));
    return parseResult(TeammateProfileDefaultViewSchema, raw, 'Teammate profile default result');
  };

  readonly spacesInteractionProfileSetDefault: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = parseInput(SetSpaceProfileDefaultInputSchema, ctx.body, 'Space profile default input');
    const raw = await guarded('spaces.interactionProfile.setDefault',
      () => this.deps.db.rpc<unknown>(
        claimsFor(owner, ctx, requestEnvelope(ctx)),
        'set_space_profile_default',
        [spaceId, input.profileId, input.expectedSettingsRevision,
          input.confirmAgentGenerated ?? false, input.clientMutationId],
      ));
    return parseResult(SpaceProfileDefaultViewSchema, raw, 'Space profile default result');
  };
}

import {
  ActionDiscoveryResultSchema,
  AttentionRequestListQuerySchema,
  AttentionRequestMutationResultSchema,
  AttentionRequestSchema,
  ActivateInteractionProfileInputSchema,
  AddMessageAttachmentsInputSchema,
  CommandResultSchema,
  CorrectProjectAssociationInputSchema,
  CreateEntityInputSchema,
  CreateAttentionRequestInputSchema,
  DeleteMessageInputSchema,
  EdgeCorrectionResultSchema,
  EntityConnectionsPageSchema,
  EntityConnectionsQuerySchema,
  EntityContextQuerySchema,
  EntityContextViewSchema,
  EntityFeedPageSchema,
  EntityFeedQuerySchema,
  ExecutionLivenessSchema,
  ExecutionPromptInputSchema,
  ExecutionDispatchInputSchema,
  ExecutionDispatchResultSchema,
  ExecutionSpawnInputSchema,
  FileUploadCompleteInputSchema,
  HandoffListQuerySchema,
  HandoffViewSchema,
  InboxListQuerySchema,
  InboxMarkReadInputSchema,
  InteractionProfilePreviewSchema,
  InteractionProfileViewSchema,
  LinkCommitInputSchema,
  LinkPrInputSchema,
  MenuConfigSchema,
  MessageBatchResultSchema,
  MessageDeliveryQuerySchema,
  MessageDeliveryViewSchema,
  MessageViewSchema,
  NotificationItemSchema,
  PatchMessageInputSchema,
  PostMessageInputSchema,
  PreviewInteractionProfileInputSchema,
  ProfileValidationViewSchema,
  ProposeInteractionProfileInputSchema,
  RemoveMessageAttachmentsInputSchema,
  RetireInteractionProfileInputSchema,
  SendHandoffInputSchema,
  SetDefaultChannelInputSchema,
  ResolveEntityAttentionInputSchema,
  SetSpaceProfileDefaultInputSchema,
  SetTeammateProfileDefaultInputSchema,
  SpaceProfileDefaultViewSchema,
  SpaceSettingsViewSchema,
  TeammateProfileDefaultViewSchema,
  UpdateInteractionProfileDraftInputSchema,
  UpdateMenuInputSchema,
  UpdateAttentionRequestInputSchema,
  ValidateInteractionProfileInputSchema,
  WithdrawHandoffInputSchema,
  WorkspaceEventSchema,
  pageOf,
  type OperationName,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';

const PageOfHandoffViewSchema = pageOf(HandoffViewSchema);
const PageOfNotificationItemSchema = pageOf(NotificationItemSchema);
const PageOfAttentionRequestSchema = pageOf(AttentionRequestSchema);

export const SCHEMA_REGISTRY = {
  ActionDiscoveryResultSchema,
  AttentionRequestListQuerySchema,
  AttentionRequestMutationResultSchema,
  AttentionRequestSchema,
  ActivateInteractionProfileInputSchema,
  AddMessageAttachmentsInputSchema,
  CommandResultSchema,
  CorrectProjectAssociationInputSchema,
  CreateEntityInputSchema,
  CreateAttentionRequestInputSchema,
  DeleteMessageInputSchema,
  EdgeCorrectionResultSchema,
  EntityConnectionsPageSchema,
  EntityConnectionsQuerySchema,
  EntityContextQuerySchema,
  EntityContextViewSchema,
  EntityFeedPageSchema,
  EntityFeedQuerySchema,
  ExecutionLivenessSchema,
  ExecutionPromptInputSchema,
  ExecutionDispatchInputSchema,
  ExecutionDispatchResultSchema,
  ExecutionSpawnInputSchema,
  FileUploadCompleteInputSchema,
  HandoffListQuerySchema,
  HandoffViewSchema,
  InboxListQuerySchema,
  InboxMarkReadInputSchema,
  InteractionProfilePreviewSchema,
  InteractionProfileViewSchema,
  LinkCommitInputSchema,
  LinkPrInputSchema,
  MenuConfigSchema,
  MessageBatchResultSchema,
  MessageDeliveryQuerySchema,
  MessageDeliveryViewSchema,
  MessageViewSchema,
  NotificationItemSchema,
  PageOfHandoffViewSchema,
  PageOfNotificationItemSchema,
  PageOfAttentionRequestSchema,
  PatchMessageInputSchema,
  PostMessageInputSchema,
  PreviewInteractionProfileInputSchema,
  ProfileValidationViewSchema,
  ProposeInteractionProfileInputSchema,
  RemoveMessageAttachmentsInputSchema,
  RetireInteractionProfileInputSchema,
  SendHandoffInputSchema,
  SetDefaultChannelInputSchema,
  ResolveEntityAttentionInputSchema,
  SetSpaceProfileDefaultInputSchema,
  SetTeammateProfileDefaultInputSchema,
  SpaceProfileDefaultViewSchema,
  SpaceSettingsViewSchema,
  TeammateProfileDefaultViewSchema,
  UpdateInteractionProfileDraftInputSchema,
  UpdateMenuInputSchema,
  UpdateAttentionRequestInputSchema,
  ValidateInteractionProfileInputSchema,
  WithdrawHandoffInputSchema,
  WorkspaceEventSchema,
} as const satisfies Readonly<Record<string, ZodTypeAny>>;

export type SchemaRef = keyof typeof SCHEMA_REGISTRY;

export interface OperationSchemaDisposition {
  readonly requestSchema: SchemaRef | null;
  readonly resultSchema: SchemaRef;
}

export const ADDITIVE_SCHEMA_DISPOSITIONS = {
  'spaces.menu.get': { requestSchema: null, resultSchema: 'MenuConfigSchema' },
  'spaces.menu.update': { requestSchema: 'UpdateMenuInputSchema', resultSchema: 'MenuConfigSchema' },
  'spaces.defaultChannel.set': { requestSchema: 'SetDefaultChannelInputSchema', resultSchema: 'SpaceSettingsViewSchema' },
  'projects.associations.correct': { requestSchema: 'CorrectProjectAssociationInputSchema', resultSchema: 'EdgeCorrectionResultSchema' },
  'handoffs.send': { requestSchema: 'SendHandoffInputSchema', resultSchema: 'HandoffViewSchema' },
  'handoffs.list': { requestSchema: 'HandoffListQuerySchema', resultSchema: 'PageOfHandoffViewSchema' },
  'handoffs.withdraw': { requestSchema: 'WithdrawHandoffInputSchema', resultSchema: 'HandoffViewSchema' },
  'messages.attachments.add': { requestSchema: 'AddMessageAttachmentsInputSchema', resultSchema: 'MessageViewSchema' },
  'messages.attachments.remove': { requestSchema: 'RemoveMessageAttachmentsInputSchema', resultSchema: 'MessageViewSchema' },
  'messages.delivery.get': { requestSchema: 'MessageDeliveryQuerySchema', resultSchema: 'MessageDeliveryViewSchema' },
  'entities.feed': { requestSchema: 'EntityFeedQuerySchema', resultSchema: 'EntityFeedPageSchema' },
  'entities.context': { requestSchema: 'EntityContextQuerySchema', resultSchema: 'EntityContextViewSchema' },
  'interactionProfiles.propose': { requestSchema: 'ProposeInteractionProfileInputSchema', resultSchema: 'InteractionProfileViewSchema' },
  'interactionProfiles.updateDraft': { requestSchema: 'UpdateInteractionProfileDraftInputSchema', resultSchema: 'InteractionProfileViewSchema' },
  'interactionProfiles.validate': { requestSchema: 'ValidateInteractionProfileInputSchema', resultSchema: 'ProfileValidationViewSchema' },
  'interactionProfiles.preview': { requestSchema: 'PreviewInteractionProfileInputSchema', resultSchema: 'InteractionProfilePreviewSchema' },
  'interactionProfiles.activate': { requestSchema: 'ActivateInteractionProfileInputSchema', resultSchema: 'InteractionProfileViewSchema' },
  'interactionProfiles.retire': { requestSchema: 'RetireInteractionProfileInputSchema', resultSchema: 'InteractionProfileViewSchema' },
  'teamMembers.interactionProfile.setDefault': { requestSchema: 'SetTeammateProfileDefaultInputSchema', resultSchema: 'TeammateProfileDefaultViewSchema' },
  'spaces.interactionProfile.setDefault': { requestSchema: 'SetSpaceProfileDefaultInputSchema', resultSchema: 'SpaceProfileDefaultViewSchema' },
  'execution.liveness': { requestSchema: null, resultSchema: 'ExecutionLivenessSchema' },
} as const satisfies Readonly<Partial<Record<OperationName, OperationSchemaDisposition>>>;

/**
 * Schema dispositions added AFTER the A01-A21 dossier.
 *
 * A third map rather than a row on either of the other two, because both of
 * those have their key order pinned as historical snapshots: FROZEN is the W1
 * boundary and ADDITIVE is exactly the A01-A21 block, which `generator.ts` also
 * uses to assert those rows are contiguous IN THE CATALOG. Appending here says
 * "this came later" instead of quietly restating what the dossier contained.
 */
export const POST_DOSSIER_SCHEMA_DISPOSITIONS = {
  'execution.dispatch': { requestSchema: 'ExecutionDispatchInputSchema', resultSchema: 'ExecutionDispatchResultSchema' },
} as const satisfies Readonly<Partial<Record<OperationName, OperationSchemaDisposition>>>;

export const FROZEN_SCHEMA_DISPOSITIONS = {
  'attentionRequests.list': { requestSchema: 'AttentionRequestListQuerySchema', resultSchema: 'PageOfAttentionRequestSchema' },
  'attentionRequests.create': { requestSchema: 'CreateAttentionRequestInputSchema', resultSchema: 'AttentionRequestMutationResultSchema' },
  'attentionRequests.update': { requestSchema: 'UpdateAttentionRequestInputSchema', resultSchema: 'AttentionRequestMutationResultSchema' },
  'attentionRequests.resolveEntity': { requestSchema: 'ResolveEntityAttentionInputSchema', resultSchema: 'AttentionRequestMutationResultSchema' },
  'messages.post': { requestSchema: 'PostMessageInputSchema', resultSchema: 'MessageBatchResultSchema' },
  'messages.edit': { requestSchema: 'PatchMessageInputSchema', resultSchema: 'MessageViewSchema' },
  'messages.delete': { requestSchema: 'DeleteMessageInputSchema', resultSchema: 'MessageViewSchema' },
  'entities.create': { requestSchema: 'CreateEntityInputSchema', resultSchema: 'CommandResultSchema' },
  'entities.connections': { requestSchema: 'EntityConnectionsQuerySchema', resultSchema: 'EntityConnectionsPageSchema' },
  'files.uploadComplete': { requestSchema: 'FileUploadCompleteInputSchema', resultSchema: 'CommandResultSchema' },
  'execution.spawn': { requestSchema: 'ExecutionSpawnInputSchema', resultSchema: 'CommandResultSchema' },
  'execution.prompt': { requestSchema: 'ExecutionPromptInputSchema', resultSchema: 'CommandResultSchema' },
  'entities.commands.linkPr': { requestSchema: 'LinkPrInputSchema', resultSchema: 'CommandResultSchema' },
  'entities.commands.linkCommit': { requestSchema: 'LinkCommitInputSchema', resultSchema: 'CommandResultSchema' },
  'inbox.list': { requestSchema: 'InboxListQuerySchema', resultSchema: 'PageOfNotificationItemSchema' },
  'inbox.markRead': { requestSchema: 'InboxMarkReadInputSchema', resultSchema: 'NotificationItemSchema' },
  'actions.list': { requestSchema: null, resultSchema: 'ActionDiscoveryResultSchema' },
  'events.subscribe': { requestSchema: null, resultSchema: 'WorkspaceEventSchema' },
} as const satisfies Readonly<Partial<Record<OperationName, OperationSchemaDisposition>>>;

export function resolveSchema(ref: SchemaRef): ZodTypeAny {
  const schema = SCHEMA_REGISTRY[ref];
  if (!schema) throw new Error(`unknown schema ref: ${ref}`);
  return schema;
}

export function schemaDispositionFor(operation: OperationName): OperationSchemaDisposition | undefined {
  return (ADDITIVE_SCHEMA_DISPOSITIONS as Partial<Record<OperationName, OperationSchemaDisposition>>)[operation]
    ?? (POST_DOSSIER_SCHEMA_DISPOSITIONS as Partial<Record<OperationName, OperationSchemaDisposition>>)[operation]
    ?? (FROZEN_SCHEMA_DISPOSITIONS as Partial<Record<OperationName, OperationSchemaDisposition>>)[operation];
}

import { describe, expect, it } from 'vitest';
import {
  ActivateInteractionProfileInputSchema,
  ActionDiscoveryResultSchema,
  AddMessageAttachmentsInputSchema,
  AmendmentErrorReasonSchema,
  CorrectProjectAssociationInputSchema,
  CreateEntityInputSchema,
  DeleteMessageInputSchema,
  EntityConnectionsQuerySchema,
  EntityContextQuerySchema,
  EntityFeedQuerySchema,
  EntityFeedPageSchema,
  ErrorCodeSchema,
  ErrorDetailsSchema,
  FileUploadCompleteInputSchema,
  HandoffListQuerySchema,
  HandoffViewSchema,
  InboxListQuerySchema,
  InboxMarkReadInputSchema,
  InteractionProfileDraftSchema,
  InteractionProfilePinViewSchema,
  InteractionProfilePreviewSchema,
  InteractionProfileViewSchema,
  LinkCommitInputSchema,
  LinkPrInputSchema,
  MenuConfigPayloadSchema,
  MenuConfigSchema,
  MessageBatchResultSchema,
  MessageDeliveryRecordSchema,
  MessageDeliveryViewSchema,
  MessageDeliveryQuerySchema,
  PatchMessageInputSchema,
  PreviewInteractionProfileInputSchema,
  ProfileValidationViewSchema,
  ProposeInteractionProfileInputSchema,
  RemoveMessageAttachmentsInputSchema,
  RetireInteractionProfileInputSchema,
  SendHandoffInputSchema,
  SetDefaultChannelInputSchema,
  SetSpaceProfileDefaultInputSchema,
  SetTeammateProfileDefaultInputSchema,
  SpaceProfileDefaultViewSchema,
  TeammateProfileDefaultViewSchema,
  UpdateInteractionProfileDraftInputSchema,
  UpdateMenuInputSchema,
  ValidateInteractionProfileInputSchema,
  WithdrawHandoffInputSchema,
  WorkspaceEventSchema,
} from '../src/index.js';

const clientMutationId = 'mutation-1';

const draft = {
  name: 'Core collaboration',
  templateKey: 'tm8.chat.core',
  templateVersion: 1,
  promptPolicy: {
    kernelTemplate: 'tm8.core.v1',
    manifestMaxBytes: 4096,
    kernelMaxBytes: 6144,
    initialContextMaxBytes: 32768,
    rollingControlMaxBytes: 32768,
    allowedInjectionKinds: [],
    untrustedEncoding: 'escaped-xml',
  },
  toolDiscoveryPolicy: {
    rootHelpRef: 'tm8://help',
    preloadNouns: [],
    semanticSearchEnabled: true,
    semanticMaxMatches: 5,
    nounShardMaxBytes: 8192,
    commandShardMaxBytes: 16384,
    entityContextDefaultBytes: 16384,
    providerToolRegistrationAllowlist: ['entities.get', 'messages.post'],
  },
  feedPolicy: { scope: 'session_chat_v1', pageSize: 50, bodyExcerptBytes: 1024 },
  providerCaptureMode: 'explicit-only',
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: true,
    allowedAttachmentKinds: ['file'],
    operationBindings: ['messages.post', 'messages.attachments.add'],
  },
} as const;

const menuPayload = {
  schemaVersion: 1,
  groups: [{
    id: 'main',
    label: 'Main',
    items: [
      { type: 'view', ref: 'workspace', children: [{ type: 'kind', ref: 'task' }] },
      { type: 'view', ref: 'settings' },
    ],
  }],
} as const;

const occurredAt = '2026-07-26T00:00:00.000Z';
const actor = { id: 'member-1', kind: 'member' as const, displayName: 'Member', isAgent: false };
const counters = { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null };
const taskSummary = {
  id: 'task-1', spaceId: 'space-1', kind: 'task' as const, title: 'Task',
  parentId: null, position: 1, visibility: 'space' as const, version: 1,
  activityAt: occurredAt, createdAt: occurredAt, updatedAt: occurredAt, deletedAt: null,
  createdBy: actor, counters,
  state: {
    kind: 'task' as const, workStatus: 'open' as const, priority: 'medium' as const,
    axes: {}, assignees: [], acceptance: { total: 0, completed: 0 },
  },
  badges: {},
};
const messageView = {
  ...taskSummary,
  id: 'message-1', kind: 'message' as const,
  state: {
    kind: 'message' as const, anchorId: 'task-1', rootMessageId: null,
    author: actor, messageBatchId: clientMutationId,
  },
  content: { kind: 'message' as const, body: 'hello', mentions: [], attachments: [] },
  replyCount: 0,
};

const handoffView = {
  handoffId: clientMutationId,
  sourceEntityId: 'task-1',
  targetWorkSessionId: 'session-1',
  deliveryStatus: 'prepared' as const,
  recordStatus: 'pending' as const,
  sourceSnapshot: {
    entityId: 'task-1', kind: 'task' as const, title: 'Task', contentVersion: 1,
    sourceSpaceId: 'space-1', body: 'context', bodyBytes: 7, truncated: false, omittedFields: [],
  },
  envelopeHash: 'sha256:handoff',
  sourceMissing: false,
  recordVersion: 1,
  withdrawnBy: null,
  withdrawnAt: null,
  withdrawReason: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
};

const deliveryRecord = {
  deliveryId: 'delivery-1', messageId: 'message-1', sourceWorkSessionId: null,
  targetWorkSessionId: 'session-1', status: 'pending' as const, attemptNo: 1,
  failureReason: null, reservedAt: occurredAt, claimedAt: null, settledAt: null,
  updatedAt: occurredAt,
};

const profileView = {
  profileId: 'profile-1', spaceId: 'space-1', status: 'draft' as const,
  currentDraftVersion: 1, validatedVersion: null, validatedHash: null,
  activeVersion: null, activeHash: null, generatedByTeamMemberId: null,
  retiredAt: null, version: 1, draft,
};

const validationView = {
  profileId: 'profile-1', profileVersion: 1, status: 'valid' as const,
  validatedHash: 'sha256:profile', issues: [],
};

const pinView = {
  workSessionId: 'session-1', pinRevision: 1, profileId: 'profile-1', profileVersion: 1,
  templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'sha256:pin',
  source: 'space_default' as const, createdAt: occurredAt,
};

const expectUnknownKeyRejected = (
  schema: { safeParse(value: unknown): { success: boolean } },
  value: Record<string, unknown>,
) => expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);

describe('W1 strict additive command and query schemas', () => {
  it('enforces the exact menu/default-channel shapes and bounds', () => {
    expect(MenuConfigPayloadSchema.safeParse(menuPayload).success).toBe(true);
    expectUnknownKeyRejected(MenuConfigPayloadSchema, menuPayload);
    expect(UpdateMenuInputSchema.safeParse({ clientMutationId, expectedRevision: 1, payload: menuPayload }).success).toBe(true);
    expect(SetDefaultChannelInputSchema.safeParse({ clientMutationId, expectedSettingsRevision: 1, channelId: null }).success).toBe(true);
    expectUnknownKeyRejected(SetDefaultChannelInputSchema, { clientMutationId, expectedSettingsRevision: 1, channelId: null });
    expect(MenuConfigPayloadSchema.safeParse({
      ...menuPayload,
      groups: [{ id: 'main', label: 'Main', items: [{ type: 'view', ref: 'workspace', children: [{ type: 'view', ref: 'feed', children: [] }] }] }],
    }).success).toBe(false);
  });

  it('enforces exact project, handoff, attachment, feed, and context inputs', () => {
    const commands = [
      [CorrectProjectAssociationInputSchema, { clientMutationId, projectId: 'project-1', expectedArtifactVersion: 2 }],
      [SendHandoffInputSchema, { clientMutationId, sourceEntityId: 'entity-1' }],
      [WithdrawHandoffInputSchema, { clientMutationId, expectedRecordVersion: 2, reason: 'superseded' }],
      [AddMessageAttachmentsInputSchema, { clientMutationId, expectedVersion: 2, fileEntityIds: ['file-1'] }],
      [RemoveMessageAttachmentsInputSchema, { clientMutationId, expectedVersion: 2, fileEntityIds: ['file-1'] }],
    ] as const;
    for (const [schema, value] of commands) {
      expect(schema.safeParse(value).success).toBe(true);
      expectUnknownKeyRejected(schema, value);
    }
    expect(HandoffListQuerySchema.safeParse({ limit: 50, cursor: 'cursor-1' }).success).toBe(true);
    expect(MessageDeliveryQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(EntityFeedQuerySchema.safeParse({ scope: 'default', order: 'newest', around: 'message:message-1', limit: 50 }).success).toBe(true);
    expect(EntityFeedQuerySchema.safeParse({ clientMutationId }).success).toBe(false);
    expect(EntityContextQuerySchema.safeParse({ sections: ['summary', 'actions'], totalBytes: 16384, sectionBytes: 4096 }).success).toBe(true);
    expect(EntityContextQuerySchema.safeParse({ totalBytes: 1000 }).success).toBe(false);
  });

  it('requires command mutation identities but keeps preview as a mutation-free POST read', () => {
    expect(ProposeInteractionProfileInputSchema.safeParse({ clientMutationId, spaceId: 'space-1', draft }).success).toBe(true);
    expect(UpdateInteractionProfileDraftInputSchema.safeParse({ clientMutationId, expectedVersion: 1, draft }).success).toBe(true);
    expect(ValidateInteractionProfileInputSchema.safeParse({ clientMutationId, expectedVersion: 1 }).success).toBe(true);
    expect(ActivateInteractionProfileInputSchema.safeParse({ clientMutationId, validatedVersion: 1, validatedHash: 'sha256:abc', confirm: true }).success).toBe(true);
    expect(RetireInteractionProfileInputSchema.safeParse({ clientMutationId, expectedVersion: 1, confirm: true }).success).toBe(true);
    expect(SetTeammateProfileDefaultInputSchema.safeParse({ clientMutationId, expectedVersion: 1, profileId: null }).success).toBe(true);

    expect(PreviewInteractionProfileInputSchema.safeParse({ profileVersion: 1 }).success).toBe(true);
    expect(PreviewInteractionProfileInputSchema.safeParse({ profileVersion: 1, clientMutationId }).success).toBe(false);
    expect(ValidateInteractionProfileInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  it('pins only concrete feed scopes and explicit-only provider capture', () => {
    expect(InteractionProfileDraftSchema.safeParse(draft).success).toBe(true);
    expectUnknownKeyRejected(InteractionProfileDraftSchema, draft);
    expect(InteractionProfileDraftSchema.safeParse({ ...draft, feedPolicy: { ...draft.feedPolicy, scope: 'default' } }).success).toBe(false);
    expect(InteractionProfileDraftSchema.safeParse({ ...draft, providerCaptureMode: 'automatic' }).success).toBe(false);
  });

  it('uses the shared Space settings revision for A20 input and result', () => {
    const input = { clientMutationId, expectedSettingsRevision: 7, profileId: 'profile-1', confirmAgentGenerated: true };
    expect(SetSpaceProfileDefaultInputSchema.safeParse(input).success).toBe(true);
    expectUnknownKeyRejected(SetSpaceProfileDefaultInputSchema, input);
    expect(SetSpaceProfileDefaultInputSchema.safeParse({ ...input, expectedRevision: 7 }).success).toBe(false);

    const view = { spaceId: 'space-1', defaultInteractionProfileId: 'profile-1', settingsRevision: 8 };
    expect(SpaceProfileDefaultViewSchema.safeParse(view).success).toBe(true);
    expectUnknownKeyRejected(SpaceProfileDefaultViewSchema, view);
  });
});

describe('W1 strict frozen-row amendments', () => {
  it('adds atomic initial connections and a flat typed connection query', () => {
    const create = {
      clientMutationId,
      spaceId: 'space-1',
      kind: 'doc',
      title: 'Design',
      connections: [{ type: 'relates_to', targetId: 'entity-2', props: { note: 'context' } }],
    };
    expect(CreateEntityInputSchema.safeParse(create).success).toBe(true);
    expect(CreateEntityInputSchema.safeParse({ ...create, kind: 'project' }).success).toBe(false);
    expect(CreateEntityInputSchema.safeParse({ ...create, kind: 'interaction_profile' }).success).toBe(false);

    const query = {
      types: ['in_project'], direction: 'both', peerIds: ['project-1'], peerKinds: ['project'],
      createdByIds: ['member-1'], createdAfter: '2026-07-26T00:00:00.000Z',
      sort: 'updatedAt', order: 'desc', limit: 50,
    };
    expect(EntityConnectionsQuerySchema.safeParse(query).success).toBe(true);
    expectUnknownKeyRejected(EntityConnectionsQuerySchema, query);
  });

  it('requires optimistic versions for edit/delete and exact attachment targets on upload completion', () => {
    expect(PatchMessageInputSchema.safeParse({ clientMutationId, expectedVersion: 2, body: 'edited' }).success).toBe(true);
    expect(PatchMessageInputSchema.safeParse({ clientMutationId, body: 'edited' }).success).toBe(false);
    expect(DeleteMessageInputSchema.safeParse({ clientMutationId, expectedVersion: 2 }).success).toBe(true);
    expect(DeleteMessageInputSchema.safeParse({ clientMutationId }).success).toBe(false);
    expect(FileUploadCompleteInputSchema.safeParse({ clientMutationId, targets: ['task-1', 'message-1'] }).success).toBe(true);
    expectUnknownKeyRejected(FileUploadCompleteInputSchema, { clientMutationId, targets: ['task-1'] });
  });

  it('adds optional explicit project IDs to PR/commit linking', () => {
    expect(LinkPrInputSchema.safeParse({ clientMutationId, url: 'https://example.test/pr/1', projectId: 'project-1' }).success).toBe(true);
    expect(LinkCommitInputSchema.safeParse({ clientMutationId, url: 'https://example.test/commit/1', projectId: 'project-1' }).success).toBe(true);
  });

  it('uses discriminated inbox recipients without allowing reads to mutate', () => {
    expect(InboxListQuerySchema.safeParse({ recipient: { type: 'member', memberId: 'member-1' }, unread: true }).success).toBe(true);
    expect(InboxListQuerySchema.safeParse({ recipient: { type: 'team_member', teamMemberId: 'teammate-1' } }).success).toBe(true);
    expect(InboxListQuerySchema.safeParse({ recipient: { type: 'agent', id: 'teammate-1' } }).success).toBe(false);
    expect(InboxListQuerySchema.safeParse({ recipient: { type: 'member', memberId: 'member-1' }, clientMutationId }).success).toBe(false);
    expect(InboxMarkReadInputSchema.safeParse({ clientMutationId, recipient: { type: 'team_member', teamMemberId: 'teammate-1' } }).success).toBe(true);
  });

  it('keeps all new result envelopes strict', () => {
    const results = [
      [MenuConfigSchema, { ...menuPayload, revision: 1 }],
      [MessageBatchResultSchema, { messageBatchId: clientMutationId, messages: [messageView] }],
      [MessageDeliveryRecordSchema, deliveryRecord],
      [MessageDeliveryViewSchema, { message: messageView, deliveries: [deliveryRecord] }],
      [HandoffViewSchema, handoffView],
      [EntityFeedPageSchema, { resolvedScope: 'direct_v1', predicates: ['subject', 'anchored'], items: [], nextCursor: null }],
      [InteractionProfileViewSchema, profileView],
      [ProfileValidationViewSchema, validationView],
      [InteractionProfilePreviewSchema, {
        profileId: 'profile-1', profileVersion: 1, name: draft.name,
        templateKey: draft.templateKey, templateVersion: draft.templateVersion,
        feedPolicy: draft.feedPolicy, composerPolicy: draft.composerPolicy,
        validatedHash: null, generatedByTeamMemberId: null,
      }],
      [TeammateProfileDefaultViewSchema, { teamMemberId: 'teammate-1', defaultInteractionProfileId: 'profile-1', version: 2 }],
      [InteractionProfilePinViewSchema, pinView],
      [ActionDiscoveryResultSchema, {
        actorId: 'member-1', targetEntityId: 'task-1', targetVersion: 1,
        capabilityEpoch: 'epoch-1',
        actions: [{
          id: 'edit', label: 'Edit', kind: 'status', operation: 'entities.patch',
          targetEntityId: 'task-1', targetVersion: 1, capabilityEpoch: 'epoch-1',
          authzTarget: 'entity', exposure: 'public', helpRef: 'tm8://help/entity/update',
        }],
      }],
    ] as const;

    for (const [schema, value] of results) {
      expect(schema.safeParse(value).success).toBe(true);
      expectUnknownKeyRejected(schema, value);
    }
  });

  it('rejects unknown keys in nested menu/profile/inbox object arms', () => {
    expect(MenuConfigPayloadSchema.safeParse({
      ...menuPayload,
      groups: [{ ...menuPayload.groups[0], items: [{ type: 'view', ref: 'settings', surprise: true }] }],
    }).success).toBe(false);
    expect(InteractionProfileDraftSchema.safeParse({
      ...draft,
      promptPolicy: { ...draft.promptPolicy, surprise: true },
    }).success).toBe(false);
    expect(InteractionProfileDraftSchema.safeParse({
      ...draft,
      composerPolicy: { ...draft.composerPolicy, surprise: true },
    }).success).toBe(false);
    expect(InboxListQuerySchema.safeParse({
      recipient: { type: 'team_member', teamMemberId: 'teammate-1', surprise: true },
    }).success).toBe(false);
  });
});

describe('W1 closed errors and durable events', () => {
  it('admits the dossier conflict code and strict typed details', () => {
    expect(ErrorCodeSchema.safeParse('conflict').success).toBe(true);
    const details = { reason: 'menu_revision_conflict', currentRevision: 2 };
    expect(ErrorDetailsSchema.safeParse(details).success).toBe(true);
    expectUnknownKeyRejected(ErrorDetailsSchema, details);
  });

  it('keeps ErrorDetails.reason open while closing the approved new reason registry', () => {
    const reasons = [
      'use_message_send', 'automated_wake_limit', 'session_contact_forbidden',
      'handoff_forbidden', 'message_batch_identity_mismatch',
      'feed_scope_not_applicable', 'feed_item_not_in_scope',
      'project_not_linked', 'project_association_cap', 'project_over_cap',
      'menu_revision_conflict', 'menu_upgrade_required',
      'profile_not_validated', 'profile_referenced_default', 'profile_retired',
      'profile_principal_required', 'profile_capture_mode_reserved',
      'attachment_edge_owned',
    ];
    for (const reason of reasons) expect(AmendmentErrorReasonSchema.safeParse(reason).success).toBe(true);
    expect(AmendmentErrorReasonSchema.safeParse('companion_only_reason').success).toBe(false);
    expect(ErrorDetailsSchema.safeParse({ reason: 'existing_non_w1_reason' }).success).toBe(true);
    expect(ErrorCodeSchema.safeParse('upstream_unavailable').success).toBe(false);
  });

  it('validates strict A20 default-update events with the durable Space envelope', () => {
    const event = {
      spaceId: 'space-1', seq: 9, occurredAt: '2026-07-26T00:00:00.000Z', schemaVersion: 1,
      type: 'interaction_profile.default_updated',
      target: { type: 'space', value: { spaceId: 'space-1', defaultInteractionProfileId: 'profile-1', settingsRevision: 2 } },
      clientMutationId,
    };
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse({ ...event, durable: true }).success).toBe(false);
  });

  it('accepts every adopted durable event variant and rejects envelope drift', () => {
    const envelope = { spaceId: 'space-1', seq: 9, occurredAt, schemaVersion: 1, clientMutationId };
    const events = [
      { ...envelope, type: 'menu.updated', menu: { ...menuPayload, revision: 1 } },
      { ...envelope, type: 'space.default_channel.updated', channelId: null, settingsRevision: 2 },
      { ...envelope, type: 'project.association.corrected', result: { artifactId: 'task-1', projectId: 'project-1', outcome: 'unchanged', edge: null } },
      { ...envelope, type: 'handoff.prepared', handoff: handoffView },
      { ...envelope, type: 'handoff.delivery_settled', handoff: { ...handoffView, deliveryStatus: 'unknown' } },
      { ...envelope, type: 'handoff.recorded', handoff: { ...handoffView, deliveryStatus: 'delivered', recordStatus: 'recorded' } },
      { ...envelope, type: 'handoff.withdrawn', handoff: {
        ...handoffView, deliveryStatus: 'delivered', recordStatus: 'withdrawn',
        withdrawnBy: actor, withdrawnAt: occurredAt,
      } },
      { ...envelope, type: 'message.delivery_reserved', delivery: deliveryRecord },
      { ...envelope, type: 'message.delivery_settled', delivery: { ...deliveryRecord, status: 'delivered', settledAt: occurredAt } },
      { ...envelope, type: 'message.attachments.updated', message: messageView },
      { ...envelope, type: 'interaction_profile.proposed', profile: profileView },
      { ...envelope, type: 'interaction_profile.updated', profile: profileView },
      { ...envelope, type: 'interaction_profile.validated', validation: validationView },
      { ...envelope, type: 'interaction_profile.activated', profile: { ...profileView, status: 'active' } },
      { ...envelope, type: 'interaction_profile.retired', profile: { ...profileView, status: 'retired', retiredAt: occurredAt } },
      { ...envelope, type: 'interaction_profile.default_updated', target: { type: 'team_member', value: { teamMemberId: 'teammate-1', defaultInteractionProfileId: 'profile-1', version: 2 } } },
      { ...envelope, type: 'work_session.profile_pinned', pin: pinView },
      { ...envelope, type: 'work_session.profile_repinned', pin: { ...pinView, pinRevision: 2 } },
    ];

    for (const event of events) {
      expect(WorkspaceEventSchema.safeParse(event).success, event.type).toBe(true);
      expect(WorkspaceEventSchema.safeParse({ ...event, unexpected: true }).success, event.type).toBe(false);
    }
  });
});

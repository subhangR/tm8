/**
 * Operation → zod input schema bindings.
 *
 * The contract already owns every shape (`packages/contract/src/schemas.ts`,
 * compile-bound `z.ZodType<T>` with `.strict()` DTOs). This file only says
 * WHICH schema guards WHICH operation's request body, so validation is one
 * table rather than a hand-written check per handler.
 *
 * Where validation sits in the pipeline, and why: it runs AFTER the handler
 * registry lookup, not before. An operation nobody has implemented must
 * answer `501 not_implemented` (DEV-13) — validating its input first would
 * make an unbuilt op answer `400 invalid_input`, which is a lie about why the
 * request failed, and would break the reserved-op honesty rule outright
 * (`GET /v2/search` with no `q` must be 501, never 400).
 *
 * Only 1:1 bindings are listed — an operation whose input schema is not
 * unambiguously named in the contract is left OUT rather than guessed at, and
 * is enumerated in `UNBOUND_COMMAND_OPERATIONS` below. W2 must either bind it
 * or declare it body-less; an omission here is a to-do, not a decision.
 */
import {
  ContainersAttachInputSchema,
  ContainersAttentionInputSchema,
  ContainersBrowserEndpointInputSchema,
  ContainersComputerInputSchema,
  ContainersCreateInputSchema,
  ContainersDestroyInputSchema,
  ContainersExposeInputSchema,
  ContainersForkInputSchema,
  ContainersLifecycleInputSchema,
  ContainersPolicySetInputSchema,
  ContainersPoolsSetInputSchema,
  ContainersRunInputSchema,
  ContainersSnapshotInputSchema,
  ContainersTerminalStartInputSchema,
  ContainersUnexposeInputSchema,
  ContainersUpdateInputSchema,
  AddMessageAttachmentsInputSchema,
  ArtifactsCreateInputSchema,
  ArtifactsPreviewStartInputSchema,
  ArtifactsPublishInputSchema,
  ArtifactsRestoreInputSchema,
  AuthClaimInputSchema,
  AuthInviteSignupInputSchema,
  AuthLoginInputSchema,
  AuthLogoutInputSchema,
  AuthPasswordChangeInputSchema,
  AuthSignupInputSchema,
  CollectionAddItemInputSchema,
  CollectionQuerySchema,
  CredentialsDeleteInputSchema,
  CredentialsLoginSessionFinishInputSchema,
  CredentialsLoginSessionStartInputSchema,
  CreateAttentionRequestInputSchema,
  CorrectProjectAssociationInputSchema,
  CompleteTaskInputSchema,
  DeleteMessageInputSchema,
  CreateEdgeInputSchema,
  CreateEntityInputSchema,
  CreateVoiceTokenInputSchema,
  CreateSpaceInputSchema,
  EntityIdSchema,
  EntityKindCreateInputSchema,
  EntityKindUpdateInputSchema,
  ExecutionPromptInputSchema,
  ExecutionResumeInputSchema,
  ExecutionDispatchInputSchema,
  ExecutionSpawnInputSchema,
  ExecutionGitCheckpointInputSchema,
  ExecutionGitRollbackInputSchema,
  ExecutionGitCommitInputSchema,
  ExecutionGitMergeInputSchema,
  ExecutionGitCherryPickInputSchema,
  ExecutionGitBranchInputSchema,
  ExecutionGitStashInputSchema,
  ExecutionTerminalStartInputSchema,
  ExecutionStreamsAttachInputSchema,
  ExecutionTerminateInputSchema,
  FileUploadAbortInputSchema,
  FileUploadCompleteInputSchema,
  FileUploadInitInputSchema,
  GateTaskInputSchema,
  GrantPointsInputSchema,
  GraphQuerySchema,
  IdentityProfileUpdateInputSchema,
  InboxMarkReadInputSchema,
  LinkCommitInputSchema,
  LinkPrInputSchema,
  MoveEntityInputSchema,
  PatchEdgeInputSchema,
  PatchEntityInputSchema,
  PatchMessageInputSchema,
  PlacementInputSchema,
  PostMessageInputSchema,
  ProjectCreateInputSchema,
  ProjectFileAttachInputSchema,
  ProjectFolderUploadAbortInputSchema,
  ProjectFolderUploadCompleteInputSchema,
  ProjectFolderUploadInitInputSchema,
  ProjectLinkInputSchema,
  ProjectUpdateInputSchema,
  PullInputSchema,
  ReactionInputSchema,
  RemoveMessageAttachmentsInputSchema,
  SavedViewInputSchema,
  SendHandoffInputSchema,
  StartChatInputSchema,
  ResolveEntityAttentionInputSchema,
  ServerConnectionCreateInputSchema,
  ServerConnectionDeleteInputSchema,
  TaskAxisInputSchema,
  TaskWorkflowInputSchema,
  WorkflowInputSchema,
  TrackingPrMergeInputSchema,
  TrackingRefreshInputSchema,
  InviteRoleSchema,
  ResolveInviteInputSchema,
  UpdateMemberRoleInputSchema,
  UpdateSpaceInputSchema,
  UpdateAttentionRequestInputSchema,
  WithdrawHandoffInputSchema,
  WorkInputSchema,
  type OperationName,
} from '@tm8/contract';
import { z, type ZodTypeAny } from 'zod';

const RequiredCommandContextSchema = z.object({
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().min(1),
}).strict();

const InviteCreateInputSchema = z.object({
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().min(1),
  // 114 R4: an invite may confer admin or member, never owner. Bound here so a
  // wrong word is a 400 naming the vocabulary rather than a SQL 22023.
  role: InviteRoleSchema.optional(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'expiresAt must be an ISO timestamp',
  }).nullable().optional(),
}).strict();

const InviteRedeemInputSchema = z.object({
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().min(1),
  code: z.string().min(1),
}).strict();

const UndoCommandInputSchema = z.object({
  token: z.string().min(8).max(200),
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().min(1).optional(),
}).strict();

export const INPUT_SCHEMAS: Partial<Record<OperationName, ZodTypeAny>> = {
  // identity (v2 Stage 0). The DTO deliberately has no actorId — strictness
  // refuses an actor on the wire rather than ignoring it.
  'identity.profile.update': IdentityProfileUpdateInputSchema,

  // auth (v2 Stage 1). No actorId and no clientMutationId on any of these —
  // authentication has no authoring persona and no idempotency ledger entry.
  'auth.signup': AuthSignupInputSchema,
  'auth.login': AuthLoginInputSchema,
  'auth.logout': AuthLogoutInputSchema,
  // auth.claim.status takes no input; the catalog marks it a read.
  'auth.claim': AuthClaimInputSchema,
  // auth.claim.reissue takes no request payload; the handler admits only the
  // loopback auto-owner and reads nothing from the body.
  'auth.password.change': AuthPasswordChangeInputSchema,
  // Claim-free, so strictness is the only control on this body: the schema has
  // exactly one member and `.strict()`, which turns a stray actorId into a 400
  // instead of a field nobody is in a position to check.
  'auth.invite.resolve': ResolveInviteInputSchema,
  // Claim-free like resolve; `.strict()` is again the only control, refusing a
  // stray actorId/clientMutationId this handler has no identity to check.
  'auth.invite.signup': AuthInviteSignupInputSchema,

  // credentials (Tier B). All three command bodies are BOUND rather than
  // enumerated as unbound gaps, because strictness here is a security control
  // and not only a validation nicety: none of these DTOs declares `actorId`, so
  // an acting-as claim on the wire is a 400 instead of a field the server has
  // to remember to ignore (finding D2). `credentials.status` is a read and
  // carries no body.
  'credentials.delete': CredentialsDeleteInputSchema,
  'credentials.loginSessions.start': CredentialsLoginSessionStartInputSchema,
  'credentials.loginSessions.finish': CredentialsLoginSessionFinishInputSchema,

  // node-local named Server routes
  'serverConnections.create': ServerConnectionCreateInputSchema,
  'serverConnections.delete': ServerConnectionDeleteInputSchema,

  // spaces
  'spaces.create': CreateSpaceInputSchema,
  'spaces.update': UpdateSpaceInputSchema,
  'spaces.taskAxes.create': TaskAxisInputSchema,
  'spaces.taskAxes.update': TaskAxisInputSchema,
  'spaces.taskAxes.delete': RequiredCommandContextSchema,
  'spaces.taskWorkflows.upsert': TaskWorkflowInputSchema,
  'spaces.taskWorkflows.delete': RequiredCommandContextSchema,
  'spaces.workflows.upsert': WorkflowInputSchema,
  'spaces.workflows.delete': RequiredCommandContextSchema,
  'spaces.members.updateRole': UpdateMemberRoleInputSchema,
  'spaces.invites.create': InviteCreateInputSchema,
  'spaces.invites.revoke': RequiredCommandContextSchema,
  'spaces.invites.redeem': InviteRedeemInputSchema,

  // entities — uniform operations
  'entities.create': CreateEntityInputSchema,
  // Body is the bare command envelope — the voice channel is named by the path
  // param, so there is nothing else to send. Bound anyway rather than left
  // unbound, so an unexpected field is refused instead of ignored.
  'voice.token.create': CreateVoiceTokenInputSchema,
  'entities.patch': PatchEntityInputSchema,
  'attentionRequests.create': CreateAttentionRequestInputSchema,
  'attentionRequests.update': UpdateAttentionRequestInputSchema,
  'attentionRequests.resolveEntity': ResolveEntityAttentionInputSchema,
  'entities.move': MoveEntityInputSchema,
  // The catalog names no 1:1 DTO for delete/restore (matrices §3 rows 24–25):
  // they are path-addressed commands carrying only a command context, bound the
  // same way as every other such row (`edges.delete`, `savedViews.delete`, …)
  // rather than given an invented lifecycle DTO.
  'entities.delete': RequiredCommandContextSchema,
  'entities.restore': RequiredCommandContextSchema,
  'entities.react': ReactionInputSchema,
  'entities.points.add': GrantPointsInputSchema,

  // entities — closed kind-command namespace
  'entities.commands.complete': CompleteTaskInputSchema,
  'entities.commands.work': WorkInputSchema,
  'entities.commands.pull': PullInputSchema,
  'entities.commands.linkPr': LinkPrInputSchema,
  'entities.commands.linkCommit': LinkCommitInputSchema,
  'entities.commands.gate': GateTaskInputSchema,
  'tracking.refresh': TrackingRefreshInputSchema,
  'tracking.pr.merge': TrackingPrMergeInputSchema,

  // edges + messages
  'edges.create': CreateEdgeInputSchema,
  'edges.patch': PatchEdgeInputSchema,
  'edges.delete': RequiredCommandContextSchema,
  'messages.post': PostMessageInputSchema,
  'messages.edit': PatchMessageInputSchema,
  // G04's service reads `ctx.body as <DTO>` rather than parsing it, so these
  // bindings are the ONLY thing standing between an arbitrary JSON body and a
  // handler that assumes the contract shape. Each names the contract schema
  // 1:1; none is invented.
  'messages.delete': DeleteMessageInputSchema,
  'messages.attachments.add': AddMessageAttachmentsInputSchema,
  'messages.attachments.remove': RemoveMessageAttachmentsInputSchema,
  'handoffs.send': SendHandoffInputSchema,
  'handoffs.withdraw': WithdrawHandoffInputSchema,
  'chat.start': StartChatInputSchema,

  // collections / graph / placements
  'collections.query': CollectionQuerySchema,
  'collections.addItem': CollectionAddItemInputSchema,
  // The removed member travels in the path (:id/:entityId); the body carries
  // only the command envelope.
  'collections.removeItem': RequiredCommandContextSchema,
  'graph.query': GraphQuerySchema,
  'placements.apply': PlacementInputSchema,
  'commands.undo': UndoCommandInputSchema,

  // projects (AM-2 §1)
  'projects.create': ProjectCreateInputSchema,
  'projects.update': ProjectUpdateInputSchema,
  'projects.link': ProjectLinkInputSchema,
  'projects.unlink': RequiredCommandContextSchema,
  'projects.associations.correct': CorrectProjectAssociationInputSchema,
  'projects.files.attach': ProjectFileAttachInputSchema,
  'projects.folderUploads.init': ProjectFolderUploadInitInputSchema,
  'projects.folderUploads.complete': ProjectFolderUploadCompleteInputSchema,
  'projects.folderUploads.abort': ProjectFolderUploadAbortInputSchema,

  // artifacts (TM8-ARTIFACTS-DESIGN §8.1). Reads (revisions.list, export) are
  // path-addressed GETs and carry no body to bind.
  'artifacts.create': ArtifactsCreateInputSchema,
  'artifacts.publish': ArtifactsPublishInputSchema,
  'artifacts.preview.start': ArtifactsPreviewStartInputSchema,
  'artifacts.restore': ArtifactsRestoreInputSchema,

  // files (AM-2 §2)
  'files.uploadInit': FileUploadInitInputSchema,
  'files.uploadComplete': FileUploadCompleteInputSchema,
  'files.uploadAbort': FileUploadAbortInputSchema,

  // inbox / read marks
  'inbox.markRead': InboxMarkReadInputSchema,
  'readMarks.upsert': RequiredCommandContextSchema,

  // saved views
  'savedViews.create': SavedViewInputSchema,
  'savedViews.update': SavedViewInputSchema,
  'savedViews.delete': RequiredCommandContextSchema,

  // execution (R16)
  'execution.spawn': ExecutionSpawnInputSchema,
  'execution.terminal.start': ExecutionTerminalStartInputSchema,
  'execution.dispatch': ExecutionDispatchInputSchema,
  'execution.prompt': ExecutionPromptInputSchema,
  'execution.terminate': ExecutionTerminateInputSchema,
  'execution.streams.attach': ExecutionStreamsAttachInputSchema,
  'execution.resume': ExecutionResumeInputSchema,

  // session git rail (Git UI wave)
  'execution.gitCheckpoint': ExecutionGitCheckpointInputSchema,
  'execution.gitRollback': ExecutionGitRollbackInputSchema,
  'execution.gitCommit': ExecutionGitCommitInputSchema,
  'execution.gitMerge': ExecutionGitMergeInputSchema,
  'execution.gitCherryPick': ExecutionGitCherryPickInputSchema,
  'execution.gitBranch': ExecutionGitBranchInputSchema,
  'execution.gitStash': ExecutionGitStashInputSchema,

  // custom entity kinds (T-L4)
  'entityKinds.create': EntityKindCreateInputSchema,
  'entityKinds.update': EntityKindUpdateInputSchema,

  // containers (TM8-CONTAINERS-DESIGN §4.2)
  //
  // BOUND EVEN WHERE THE OPERATION IS NOT BUILT YET, and that ordering is the
  // point. Validation runs AFTER the registry lookup (see the header), so an
  // unbuilt op still answers 501 rather than 400 — but the moment its runtime
  // lands, the shape is already enforced. Binding late is how `execution.resume`
  // shipped with no server-side validation at all.
  'containers.create': ContainersCreateInputSchema,
  // The four share one shape; `destroy` adds force/keepSnapshot.
  'containers.start': ContainersLifecycleInputSchema,
  'containers.stop': ContainersLifecycleInputSchema,
  'containers.pause': ContainersLifecycleInputSchema,
  'containers.resume': ContainersLifecycleInputSchema,
  'containers.destroy': ContainersDestroyInputSchema,
  'containers.update': ContainersUpdateInputSchema,
  'containers.policy.set': ContainersPolicySetInputSchema,
  'containers.run': ContainersRunInputSchema,
  'containers.terminal.start': ContainersTerminalStartInputSchema,
  'containers.attach': ContainersAttachInputSchema,
  'containers.computer': ContainersComputerInputSchema,
  'containers.browser.endpoint': ContainersBrowserEndpointInputSchema,
  'containers.expose': ContainersExposeInputSchema,
  'containers.unexpose': ContainersUnexposeInputSchema,
  'containers.snapshot': ContainersSnapshotInputSchema,
  'containers.fork': ContainersForkInputSchema,
  'containers.attention': ContainersAttentionInputSchema,
  'containers.pools.set': ContainersPoolsSetInputSchema,
};

/**
 * Command operations with NO binding above. Each is either genuinely
 * body-less (a path-addressed command carrying at most a `CommandContext`) or
 * needs a shape the contract does not name 1:1. W2 must resolve every entry:
 * bind a schema, or bind `CommandContextSchema` and delete the line.
 *
 * Listed explicitly rather than derived, so the gap is visible in review
 * instead of hiding as an absence.
 *
 * NOT empty, and the emptiness was a LIE. This read `[]` — asserting "nothing is
 * unbound" — while nine command operations had no binding at all, because the
 * only test over it pinned a hardcoded COUNT of INPUT_SCHEMAS rather than
 * deriving the unbound set from the catalog. `execution.resume` then shipped
 * with no server-side validation and nothing went red: the contract declared
 * `clientMutationId` required, the server never enforced it, and every resume
 * skipped ledger idempotency silently.
 *
 * The nine below are PRE-EXISTING gaps, enumerated here rather than fixed —
 * each needs its own DTO decision. What changed is that they are now visible,
 * and the guard test derives this set from `OPERATIONS` instead of trusting a
 * count, so the next command operation that forgets a schema fails loudly.
 */
export const UNBOUND_COMMAND_OPERATIONS: readonly OperationName[] = [
  'spaces.menu.update',
  'spaces.defaultChannel.set',
  'interactionProfiles.propose',
  'interactionProfiles.updateDraft',
  'interactionProfiles.validate',
  'interactionProfiles.activate',
  'interactionProfiles.retire',
  'teamMembers.interactionProfile.setDefault',
  'spaces.interactionProfile.setDefault',
  // 141: GENUINELY body-less (the first clause above), not a gap. reissue takes
  // no input — the loopback auto-owner gate and the node's unclaimed state are
  // the whole of its authorization — and it is auth.*, which refuses
  // actorId/clientMutationId, so there is no CommandContext to bind either. A
  // strict empty schema would only break the no-body POST the CLI sends.
  'auth.claim.reissue',
  // containers (177): the ONE container command with no zod body, and it is
  // the first clause above rather than a gap. `containers.files.put` carries a
  // TAR STREAM, not JSON — its request body is bytes, and a strict object
  // schema would refuse every legitimate upload. Its parameters travel in the
  // path and the query.
  'containers.files.put',
];

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
  AddMessageAttachmentsInputSchema,
  ArtifactsCreateInputSchema,
  ArtifactsPreviewStartInputSchema,
  ArtifactsPublishInputSchema,
  ArtifactsRestoreInputSchema,
  AuthLoginInputSchema,
  AuthLogoutInputSchema,
  AuthSignupInputSchema,
  CollectionQuerySchema,
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
  ExecutionSpawnInputSchema,
  ExecutionStreamsAttachInputSchema,
  ExecutionTerminateInputSchema,
  FileUploadAbortInputSchema,
  FileUploadCompleteInputSchema,
  FileUploadInitInputSchema,
  GitCredentialSetInputSchema,
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
  ProjectLinkInputSchema,
  ProjectUpdateInputSchema,
  PullInputSchema,
  ReactionInputSchema,
  RemoveMessageAttachmentsInputSchema,
  SavedViewInputSchema,
  SendHandoffInputSchema,
  ResolveEntityAttentionInputSchema,
  ServerConnectionCreateInputSchema,
  ServerConnectionDeleteInputSchema,
  TaskAxisInputSchema,
  TrackingRefreshInputSchema,
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

  // gitCredentials (081). `set` is the only one with a body, and its binding
  // is a security control, not hygiene: the token it carries becomes an
  // environment variable in a spawned PTY, so the character class in
  // `GitCredentialSetInputSchema` is what keeps a newline out of a child's
  // environment. `delete` takes no body at all — the provider is fixed and the
  // subject is always the caller.
  'gitCredentials.set': GitCredentialSetInputSchema,
  // RequiredCommandContextSchema, not a fully-optional body: this is a durable
  // command, and a durable command carries a mutation id so a retry replays
  // instead of acting twice. A schema that accepts `undefined` would also make
  // the binding pointless — the no-body probe would already reach the handler —
  // which is exactly what W5.C's generator proof refuses. Same shape as
  // `projects.unlink` and `spaces.invites.revoke`.
  'gitCredentials.delete': RequiredCommandContextSchema,

  // node-local named Server routes
  'serverConnections.create': ServerConnectionCreateInputSchema,
  'serverConnections.delete': ServerConnectionDeleteInputSchema,

  // spaces
  'spaces.create': CreateSpaceInputSchema,
  'spaces.update': UpdateSpaceInputSchema,
  'spaces.taskAxes.create': TaskAxisInputSchema,
  'spaces.taskAxes.update': TaskAxisInputSchema,
  'spaces.taskAxes.delete': RequiredCommandContextSchema,
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
  'tracking.refresh': TrackingRefreshInputSchema,

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

  // collections / graph / placements
  'collections.query': CollectionQuerySchema,
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
  'execution.prompt': ExecutionPromptInputSchema,
  'execution.terminate': ExecutionTerminateInputSchema,
  'execution.streams.attach': ExecutionStreamsAttachInputSchema,
  'execution.resume': ExecutionResumeInputSchema,

  // custom entity kinds (T-L4)
  'entityKinds.create': EntityKindCreateInputSchema,
  'entityKinds.update': EntityKindUpdateInputSchema,
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
];

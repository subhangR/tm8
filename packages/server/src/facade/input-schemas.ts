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
  CollectionQuerySchema,
  CorrectProjectAssociationInputSchema,
  CompleteTaskInputSchema,
  DeleteMessageInputSchema,
  CreateEdgeInputSchema,
  CreateEntityInputSchema,
  CreateSpaceInputSchema,
  EntityIdSchema,
  EntityKindCreateInputSchema,
  EntityKindUpdateInputSchema,
  ExecutionPromptInputSchema,
  ExecutionSpawnInputSchema,
  ExecutionStreamsAttachInputSchema,
  ExecutionTerminateInputSchema,
  FileUploadAbortInputSchema,
  FileUploadCompleteInputSchema,
  FileUploadInitInputSchema,
  GrantPointsInputSchema,
  GraphQuerySchema,
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
  ProjectLinkInputSchema,
  ProjectUpdateInputSchema,
  PullInputSchema,
  ReactionInputSchema,
  RemoveMessageAttachmentsInputSchema,
  SavedViewInputSchema,
  SendHandoffInputSchema,
  ServerConnectionCreateInputSchema,
  ServerConnectionDeleteInputSchema,
  TaskAxisInputSchema,
  TrackingRefreshInputSchema,
  UpdateSpaceInputSchema,
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
  'entities.patch': PatchEntityInputSchema,
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
 * EMPTY as of tranche-v3: composing G04 resolved the last entry. The list stays
 * because it is the place a future group declares an unresolved binding, and an
 * empty array asserts "nothing is unbound" far more loudly than a deleted
 * export would.
 */
export const UNBOUND_COMMAND_OPERATIONS: readonly OperationName[] = [];

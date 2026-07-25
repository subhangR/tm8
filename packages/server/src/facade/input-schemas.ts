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
  CollectionQuerySchema,
  CompleteTaskInputSchema,
  CreateEdgeInputSchema,
  CreateEntityInputSchema,
  CreateSpaceInputSchema,
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
  SavedViewInputSchema,
  TaskAxisInputSchema,
  TrackingRefreshInputSchema,
  UpdateSpaceInputSchema,
  WorkInputSchema,
  type OperationName,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';

export const INPUT_SCHEMAS: Partial<Record<OperationName, ZodTypeAny>> = {
  // spaces
  'spaces.create': CreateSpaceInputSchema,
  'spaces.update': UpdateSpaceInputSchema,
  'spaces.taskAxes.create': TaskAxisInputSchema,
  'spaces.taskAxes.update': TaskAxisInputSchema,

  // entities — uniform operations
  'entities.create': CreateEntityInputSchema,
  'entities.patch': PatchEntityInputSchema,
  'entities.move': MoveEntityInputSchema,
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
  'messages.post': PostMessageInputSchema,
  'messages.edit': PatchMessageInputSchema,

  // collections / graph / placements
  'collections.query': CollectionQuerySchema,
  'graph.query': GraphQuerySchema,
  'placements.apply': PlacementInputSchema,

  // projects (AM-2 §1)
  'projects.create': ProjectCreateInputSchema,
  'projects.update': ProjectUpdateInputSchema,
  'projects.link': ProjectLinkInputSchema,

  // files (AM-2 §2)
  'files.uploadInit': FileUploadInitInputSchema,
  'files.uploadComplete': FileUploadCompleteInputSchema,
  'files.uploadAbort': FileUploadAbortInputSchema,

  // saved views
  'savedViews.create': SavedViewInputSchema,
  'savedViews.update': SavedViewInputSchema,

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
 */
export const UNBOUND_COMMAND_OPERATIONS: readonly OperationName[] = [
  'entities.delete',
  'entities.restore',
  'edges.delete',
  'messages.delete',
  'commands.undo',
  'inbox.markRead',
  'readMarks.upsert',
  'savedViews.delete',
  'spaces.invites.create',
  'spaces.invites.revoke',
  'spaces.invites.redeem',
  'spaces.taskAxes.delete',
  'projects.unlink',
];

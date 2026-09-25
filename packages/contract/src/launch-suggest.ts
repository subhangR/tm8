/**
 * launch.suggest — Jev's launch-sheet advice (design 01a0cb80 §5.1).
 *
 * Jev is an ADVISOR the launch UI calls when a person presses "Ask Jev". It
 * never runs at spawn, in the CLI, in dispatch or in loops, and nothing it
 * says takes effect until a person accepts it: an accepted suggestion reaches
 * spawn as an ordinary `execution.spawn` field (`selection`, `model`,
 * `agentTool`, `reasoningEffort`), never as a Jev verdict.
 *
 * Five groups — model, teammates, memories, skills, references — are five
 * independent Jev calls. Each comes back self-contained, with its own status and its own cost,
 * so one group failing never affects another and a later move to streaming
 * needs no contract change.
 *
 * FROZEN by lane F of the Jev Launch Advisor program. The server handler, the
 * `@tm8/jev` client and the UI all code against this file; a change here is a
 * change for three lanes, so it goes through the coordinator.
 */
import { z } from 'zod';

import { SPAWN_SELECTION_REFERENCE_KINDS, type LaunchReasoningEffort, type SpawnSelectionReferenceKind } from './contract.js';
import type { SelectionHeaderSource } from './selection-header.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One independent Jev question. */
export type LaunchSuggestGroup = 'model' | 'teammates' | 'memories' | 'skills' | 'references';

export const LAUNCH_SUGGEST_GROUPS = [
  'model',
  'teammates',
  'memories',
  'skills',
  'references',
] as const satisfies readonly LaunchSuggestGroup[];

/** Every way a Jev HTTP call can fail. The client never throws; it reports one of these. */
export type JevFailure =
  | 'no_key'
  | 'timeout'
  | 'budget'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'http_error'
  | 'network'
  | 'unparsed';

export const JEV_FAILURES = [
  'no_key',
  'timeout',
  'budget',
  'rate_limited',
  'overloaded',
  'server_error',
  'http_error',
  'network',
  'unparsed',
] as const satisfies readonly JevFailure[];

/** Why a group asked Jev nothing at all. A skipped group costs zero calls. */
export type JevSkipReason = 'no_candidates' | 'no_subject_text' | 'no_teammate';

/**
 * What asking cost. Per group, and summed for the whole Ask Jev run.
 * `usd` prices input tokens only — output is free (`JEV_INPUT_USD_PER_TOKEN`).
 */
export interface JevCost {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  latencyMs: number;
}

/** One group's answer: it worked, it failed, or there was nothing to ask. */
export type JevGroupResult<T> =
  | { status: 'ok'; value: T; cost: JevCost }
  | { status: 'failed'; reason: JevFailure; cost: JevCost }
  | { status: 'skipped'; reason: JevSkipReason; cost: JevCost };

export type ModelTier = 'economy' | 'standard' | 'premium' | 'frontier';
export type JevAgentTool = 'claude-code' | 'codex';

/** The model group's verdict. It changes nothing until a person clicks Apply. */
export interface ModelSuggestion {
  tier: ModelTier;
  model: string;
  agentTool: JevAgentTool;
  effort: LaunchReasoningEffort;
  /** How much capability the work needs, as Jev read it. */
  need: number;
  workKind: string;
  reasons: string[];
}

/** A reference is a doc, artifact, drawing, file or task — the kinds `selection.referenceIds` may name. */
export type RankedEntityKind = 'memory' | 'skill' | 'team_member' | SpawnSelectionReferenceKind;
export const RANKED_ENTITY_KINDS = ['memory', 'skill', 'team_member', ...SPAWN_SELECTION_REFERENCE_KINDS] as const satisfies readonly RankedEntityKind[];
/**
 * Where a candidate came from. An entity found by several sources appears
 * once, with all of them. `parent`: a doc under the subject task's parent.
 */
export type RankedEntitySource = 'teammate' | 'inherited' | 'task' | 'parent' | 'space';
export type RelevanceLevel = 'irrelevant' | 'background' | 'useful' | 'critical';

/**
 * The selection header in effect for a ranked entity (headers design
 * 01a0d31e §2), whatever wrote it: `source` says whether a person authored
 * it, the kind carries it natively, or tm8 derived it. `version` is the
 * authored header's own version, 0 when there is none. Graph content: render
 * it as plain text.
 */
export interface RankedEntityHeader {
  whenToUse: string | null;
  summary: string | null;
  keywords: string[];
  source: SelectionHeaderSource;
  version: number;
}

/**
 * Why a row Jev ranked is NOT pre-ticked (design 01a0d348 §10 Q5):
 * `below-floor` — scored under the group's floor; `over-budget` — above the
 * floor, but the group's byte budget was full when its turn came.
 */
export type RankedEntityReason = 'below-floor' | 'over-budget';

/** One candidate, ranked. Entities are de-duplicated by id before Jev sees them. */
export interface RankedEntity {
  entityId: string;
  kind: RankedEntityKind;
  title: string;
  sources: RankedEntitySource[];
  /** 0..3 */
  score: number;
  level: RelevanceLevel;
  /** Pre-ticked in the UI: filled by rank into the group's budget (design 01a0d348 §10 Q5). */
  suggested: boolean;
  /**
   * A default of this launch: what spawn loads for the group when nothing is
   * selected (the same loaders `launch.defaults` reads).
   */
  default: boolean;
  /**
   * Bytes this entity adds to the launch prompt when ticked, measured with
   * the serializers spawn uses: a memory's whole `<entry>`, anything else's
   * `<context_index>` entry. The group's budget counts these.
   */
  promptBytes: number;
  header: RankedEntityHeader;
  /** Set on an unticked row only: why the fill left it out. */
  reason?: RankedEntityReason;
}

export interface TeammateSuggestion {
  items: RankedEntity[];
  /** True when no teammate is a good fit for this work. */
  noFit: boolean;
  /** The score a teammate needs to fit (`contextFloors.teammates`). */
  floor: number;
}

/**
 * Memories, skills or references. `considered` of `total` candidates were
 * sent to Jev. The ticks fill `budget` bytes in rank order, skipping rows
 * scored under `floor`.
 */
export interface EntitySuggestion {
  items: RankedEntity[];
  considered: number;
  total: number;
  /**
   * Bytes the group may take in the prompt: the profile's `contextBudgets`,
   * else the node default. For an index group (skills, references) it covers
   * the group's frame as well as its entries. Null: no budget of its own
   * (skills, unless the profile caps them, take what the prompt has left).
   */
  budget: number | null;
  /** The profile's `contextFloors` for the group, else the node default. */
  floor: number;
}

export interface LaunchSuggestDraft {
  title: string;
  description: string;
}

/**
 * The request body. `runId` is minted by the UI when a sheet or popup opens
 * and stays stable while it is open; `requestId` is one per press or re-ask
 * and is the idempotency key — a retried `requestId` never double-counts a
 * Jev call.
 */
export interface LaunchSuggestInput {
  runId: string;
  requestId: string;
  /** The entity being launched from. */
  subjectId: string;
  /** The Run popup's live text, when it differs from the subject's. */
  draft?: LaunchSuggestDraft;
  /** Required by the memories and skills groups; without it they are skipped with `no_teammate`. */
  teamMemberId?: string;
  /**
   * The harness the launch will run, which decides whether a skill is native
   * and so how its index entry reads. Absent: the teammate's own, else
   * claude-code.
   */
  agentTool?: JevAgentTool;
  /** The Interaction Profile the launch will pin, whose budgets and floors the fill uses. Absent: the one spawn would resolve. */
  interactionProfileId?: string;
  groups: LaunchSuggestGroup[];
  /**
   * TRANSPORT FIELD, NOT JEV'S. The HTTP facade injects a fresh
   * `clientMutationId` into every non-`auth.*` command body when the command
   * ledger is off (the default; see `commandAcceptsClientMutationId`), and a
   * strict schema that refused it would fail every request on such a server.
   * The handler ignores it: `requestId` is this operation's idempotency key.
   */
  clientMutationId?: string;
}

export interface LaunchSuggestResult {
  runId: string;
  groups: {
    model?: JevGroupResult<ModelSuggestion>;
    teammates?: JevGroupResult<TeammateSuggestion>;
    memories?: JevGroupResult<EntitySuggestion>;
    skills?: JevGroupResult<EntitySuggestion>;
    references?: JevGroupResult<EntitySuggestion>;
  };
  /**
   * Whether the launch would render `<context_index>` (the node's
   * `TM8_CONTEXT_INDEX`, else the profile's `contextIndex`). `off`: references
   * reach the prompt only as linked names, so their `promptBytes` are 0 and
   * their group has no budget, and a skill's `promptBytes` is its `<skills>`
   * line. `promptBytes` never counts bytes that do not reach the prompt.
   */
  contextIndex: 'on' | 'off';
  /** Running total for the whole run, including earlier requests. */
  run: JevCost;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const Uuid = z.string().uuid();

export const LaunchSuggestGroupSchema = z.enum(LAUNCH_SUGGEST_GROUPS);

export const LaunchSuggestDraftSchema = z.object({
  title: z.string().max(500),
  description: z.string().max(50_000),
}).strict();

/**
 * Strict: an unknown key is refused, not ignored. `groups` is non-empty — a
 * request that asks nothing is a client bug — and unique, because each group
 * is one costed Jev call and a duplicate would ask (and bill) twice.
 */
const launchSuggestInputObject = z.object({
  runId: Uuid,
  requestId: Uuid,
  subjectId: Uuid,
  draft: LaunchSuggestDraftSchema.optional(),
  teamMemberId: Uuid.optional(),
  agentTool: z.enum(['claude-code', 'codex']).optional(),
  interactionProfileId: Uuid.optional(),
  groups: z.array(LaunchSuggestGroupSchema)
    .min(1)
    .refine((groups) => new Set(groups).size === groups.length, {
      message: 'groups must not repeat a group: each one is a separate, costed Jev call',
    }),
  clientMutationId: z.string().optional(),
}).strict();

// Annotated so the server's INPUT_SCHEMAS parity guard can name the contract
// type it binds; the unannotated object above is what `SameShape` checks.
export const LaunchSuggestInputSchema: z.ZodType<LaunchSuggestInput> = launchSuggestInputObject;

export const JevFailureSchema = z.enum(JEV_FAILURES);

export const JevCostSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
}).strict();

export const ModelSuggestionSchema = z.object({
  tier: z.enum(['economy', 'standard', 'premium', 'frontier']),
  model: z.string().min(1),
  agentTool: z.enum(['claude-code', 'codex']),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  need: z.number(),
  workKind: z.string(),
  reasons: z.array(z.string()),
}).strict();

export const RankedEntityHeaderSchema = z.object({
  whenToUse: z.string().nullable(),
  summary: z.string().nullable(),
  keywords: z.array(z.string()),
  source: z.enum(['authored', 'native', 'derived']),
  version: z.number().int().nonnegative(),
}).strict();

export const RankedEntitySchema = z.object({
  entityId: Uuid,
  kind: z.enum(RANKED_ENTITY_KINDS),
  title: z.string(),
  sources: z.array(z.enum(['teammate', 'inherited', 'task', 'parent', 'space'])).min(1),
  score: z.number().min(0).max(3),
  level: z.enum(['irrelevant', 'background', 'useful', 'critical']),
  suggested: z.boolean(),
  default: z.boolean(),
  promptBytes: z.number().int().nonnegative(),
  header: RankedEntityHeaderSchema,
  reason: z.enum(['below-floor', 'over-budget']).optional(),
}).strict();

export const TeammateSuggestionSchema = z.object({
  items: z.array(RankedEntitySchema),
  noFit: z.boolean(),
  floor: z.number().min(0).max(3),
}).strict();

export const EntitySuggestionSchema = z.object({
  items: z.array(RankedEntitySchema),
  considered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  budget: z.number().int().nonnegative().nullable(),
  floor: z.number().min(0).max(3),
}).strict();

export function jevGroupResultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), value, cost: JevCostSchema }).strict(),
    z.object({ status: z.literal('failed'), reason: JevFailureSchema, cost: JevCostSchema }).strict(),
    z.object({
      status: z.literal('skipped'),
      reason: z.enum(['no_candidates', 'no_subject_text', 'no_teammate']),
      cost: JevCostSchema,
    }).strict(),
  ]);
}

export const LaunchSuggestResultSchema = z.object({
  runId: Uuid,
  groups: z.object({
    model: jevGroupResultSchema(ModelSuggestionSchema).optional(),
    teammates: jevGroupResultSchema(TeammateSuggestionSchema).optional(),
    memories: jevGroupResultSchema(EntitySuggestionSchema).optional(),
    skills: jevGroupResultSchema(EntitySuggestionSchema).optional(),
    references: jevGroupResultSchema(EntitySuggestionSchema).optional(),
  }).strict(),
  contextIndex: z.enum(['on', 'off']),
  run: JevCostSchema,
}).strict();

// ---------------------------------------------------------------------------
// Type = schema, proven at compile time
// ---------------------------------------------------------------------------
//
// A `z.ZodType<T>` annotation does not prove the schema and the type agree:
// ZodType is covariant, so a schema that silently drops an OPTIONAL key still
// satisfies it (see the server's input-schema-seam test for the incident).
// These aliases fail `tsc` unless both directions are assignable AND the key
// sets match exactly — which is the half that catches a missing optional key.

/** True only when A and B are mutually assignable and have identical keys. */
export type SameShape<A, B> =
  [A] extends [B]
    ? [B] extends [A]
      ? [keyof A] extends [keyof B]
        ? [keyof B] extends [keyof A]
          ? true
          : false
        : false
      : false
    : false;
type Assert<T extends true> = T;

export type LaunchSuggestShapeProof = [
  Assert<SameShape<z.infer<typeof launchSuggestInputObject>, LaunchSuggestInput>>,
  Assert<SameShape<z.infer<typeof LaunchSuggestDraftSchema>, LaunchSuggestDraft>>,
  Assert<SameShape<z.infer<typeof LaunchSuggestResultSchema>, LaunchSuggestResult>>,
  Assert<SameShape<z.infer<typeof LaunchSuggestResultSchema>['groups'], LaunchSuggestResult['groups']>>,
  Assert<SameShape<z.infer<typeof JevCostSchema>, JevCost>>,
  Assert<SameShape<z.infer<typeof ModelSuggestionSchema>, ModelSuggestion>>,
  Assert<SameShape<z.infer<typeof RankedEntitySchema>, RankedEntity>>,
  Assert<SameShape<z.infer<typeof RankedEntityHeaderSchema>, RankedEntityHeader>>,
  Assert<SameShape<z.infer<typeof TeammateSuggestionSchema>, TeammateSuggestion>>,
  Assert<SameShape<z.infer<typeof EntitySuggestionSchema>, EntitySuggestion>>,
];

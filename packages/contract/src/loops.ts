import { z } from 'zod';
import type { ActorSummary, EntityId, LaunchAccessMode, LaunchCredentialSource, LaunchReasoningEffort, ProjectId, SpaceId, WorkSessionWorkdirMode } from './contract.js';
import type { SameShape } from './launch-suggest.js';
import { ActorSummarySchema, WorkSessionWorkdirModeSchema } from './schemas.js';
import { ToolJsonValueSchema, type ToolJsonValue } from './tools.js';

// Loops design of record §4.2. Scheduling is server-owned: no client computes nextRunAt.
export const LOOP_TITLE_MAX = 200;
export const LOOP_PROMPT_MAX = 20000;
export const LOOP_SCHEDULE_MAX = 200;
export const LOOP_MEMORY_IDS_MAX = 32;
export const LOOP_MAX_RUNTIME_MIN_SECONDS = 60;
export const LOOP_MAX_RUNTIME_MAX_SECONDS = 86400;
export const LOOP_RETRY_ATTEMPTS_MAX = 5;
export const LOOP_RETRY_DELAY_MIN_SECONDS = 30;
export const LOOP_RETRY_DELAY_MAX_SECONDS = 3600;
export const LOOP_RETRY_DELAY_DEFAULT_SECONDS = 300;
export const LOOP_PREVIEW_DEFAULT_COUNT = 5;
export const LOOP_PREVIEW_MAX_COUNT = 10;
export const LOOP_PAUSE_MAX_DAYS = 365;
/** Bridges L (D26): the groups a loop posts to, each with its own text. */
export const LOOP_TARGETS_MAX = 32;
export const LOOP_TARGET_TEXT_MAX = 4000;
/** An interactive loop session closes after this long with nothing addressed to it. */
export const LOOP_INTERACTIVE_IDLE_MINUTES = 30;

/** `post` (Bridges L, D26) posts each target's text and starts no session. */
export type LoopAction = 'spawn' | 'dispatch' | 'tool' | 'post';
/** `replace` (D26): a new run ends the previous live one. */
export type LoopConcurrency = 'skip' | 'queue' | 'replace';
/** D26: `one-shot` posts and closes; `interactive` stays for the conversation and closes after 30 idle minutes. */
export type LoopMode = 'one-shot' | 'interactive';
/** One group a loop posts to. For `post`, `text` is the message (null: the prompt); for an agent loop, that group's own instruction. */
export interface LoopTarget { bridgeId: EntityId; text: string | null }
/** What one run did in one group (v2 §2.2's Loops tab). */
export type LoopRunTargetResult = 'pending' | 'posted' | 'paused' | 'held' | 'superseded' | 'refused';
export interface LoopRunTarget { bridgeId: EntityId; result: LoopRunTargetResult; reason: string | null; messageId: EntityId | null }
export type LoopRunTrigger = 'schedule' | 'manual';
export type LoopRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'timed_out';
export type LoopRunSkipReason = 'overlap' | 'paused' | 'schedule_invalid';
export type LoopSpawnMode = 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator';

/** Passed through to execution.spawn; anything the executor branches on is a column instead. */
export interface LoopSpawnConfig {
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: LaunchReasoningEffort | null;
  accessMode?: LaunchAccessMode | null;
  mode?: LoopSpawnMode | null;
  projectId?: ProjectId | null;
  workdir?: { mode: WorkSessionWorkdirMode; baseRef?: string | null } | null;
  memoryIds?: EntityId[];
  credentialSource?: LaunchCredentialSource | null;
  interactionProfileId?: EntityId | null;
}

export interface LoopRetryPolicy { attempts: number; delaySeconds: number }

/** What a human writes; every field is present on read. */
export interface LoopDefinition {
  title: string;
  /** `every <n>{m|h|d}` or a 5-field cron. */
  schedule: string;
  /** IANA zone the cron half is evaluated in; intervals are zone-free. */
  timezone: string;
  action: LoopAction;
  /** Required for spawn; for tool, the runs-as persona. */
  teamMemberId: EntityId | null;
  subjectId: EntityId | null;
  /** Required for tool. */
  toolId: EntityId | null;
  toolInputs: Record<string, ToolJsonValue>;
  prompt: string;
  config: LoopSpawnConfig;
  concurrency: LoopConcurrency;
  maxRuntimeSeconds: number | null;
  retry: LoopRetryPolicy;
  /** Bridges L (D26): the default posting targets; not a permission (D23). */
  targets: LoopTarget[];
  mode: LoopMode;
  /** Set by a space admin only: the loop's posts are never held by quiet hours. */
  quietHoursExempt: boolean;
}

export interface LoopSchedulePreview {
  valid: boolean;
  problem: string | null;
  summary: string;
  /** ISO instants, up to the requested count. */
  next: string[];
}

export interface LoopRunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** As reported by the harness; null is unknown, never zero. */
  costUsd: number | null;
  source: 'harness' | null;
}

export interface LoopRun {
  id: string;
  loopId: EntityId;
  spaceId: SpaceId;
  firedAt: string;
  trigger: LoopRunTrigger;
  requestedBy: ActorSummary | null;
  action: LoopAction;
  attempt: number;
  /** Derived at read time from launch, outcome and session liveness. */
  status: LoopRunStatus;
  skipReason: LoopRunSkipReason | null;
  error: string | null;
  taskId: EntityId | null;
  sessionId: EntityId | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Tool runs only; outputTail only on loops.runs.get. */
  exitCode: number | null;
  outputTail: string | null;
  actedAs: ActorSummary | null;
  endedKind: string | null;
  usage: LoopRunUsage | null;
  /** Per target (Bridges L): posted · paused · held (quiet hours) · superseded · refused. */
  targets: LoopRunTarget[];
}

export type LoopActingVia = 'armer' | 'fallback' | 'none';

export interface LoopViewState {
  enabled: boolean;
  pausedUntil: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  armedBy: ActorSummary | null;
  armedAt: string | null;
  /** Who the NEXT firing will run as, and by which rule. */
  actingAs: { identity: ActorSummary | null; via: LoopActingVia };
  /** concurrency='queue' and a previous run is still live. */
  waitingOnRunId: string | null;
}

export interface LoopRunsSummary {
  total: number;
  last: LoopRun | null;
  last24h: { fired: number; failed: number; skipped: number };
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

export interface LoopCapabilities { canEdit: boolean; canControl: boolean; canRun: boolean; canDelete: boolean }

export interface LoopView {
  id: EntityId;
  spaceId: SpaceId;
  version: number;
  definition: LoopDefinition;
  /** loops.get: summary and the next five; list rows carry next: []. */
  schedule: LoopSchedulePreview;
  state: LoopViewState;
  runs: LoopRunsSummary;
  createdBy: ActorSummary | null;
  createdAt: string;
  updatedAt: string;
  capabilities: LoopCapabilities;
}

interface LoopCommand { clientMutationId: string; actorId?: EntityId }
/** Fields a create may omit; the server fills the defaults. */
export type LoopDefinitionDraft =
  Pick<LoopDefinition, 'title' | 'schedule' | 'action'>
  & Partial<Omit<LoopDefinition, 'title' | 'schedule' | 'action' | 'retry'>>
  & { retry?: Partial<LoopRetryPolicy> };
/** Absent keys are unchanged; null clears a nullable id. */
export type LoopDefinitionPatch = Partial<Omit<LoopDefinition, 'retry'>> & { retry?: Partial<LoopRetryPolicy> };
export interface LoopCreateInput extends LoopCommand { spaceId?: SpaceId; definition: LoopDefinitionDraft; enabled?: boolean }
export interface LoopUpdateInput extends LoopCommand { loopId?: EntityId; expectedVersion: number; definition: LoopDefinitionPatch }
/** Also loops.disable and loops.resume. */
export interface LoopEnableInput extends LoopCommand { loopId?: EntityId; expectedVersion: number }
export interface LoopPauseInput extends LoopCommand { loopId?: EntityId; expectedVersion: number; until: string }
export interface LoopRunNowInput extends LoopCommand { loopId?: EntityId; force?: boolean }
export interface LoopRunStopInput extends LoopCommand { runId?: string }
export interface LoopSchedulePreviewInput { spaceId?: SpaceId; schedule: string; timezone?: string; count?: number }
export interface LoopListResult { items: LoopView[]; nextCursor: string | null }
export interface LoopRunListResult { items: LoopRun[]; nextCursor: string | null }
export interface LoopRunResult { run: LoopRun }

const Id = z.string().uuid();
const Instant = z.string().datetime({ offset: true });
// Lazy: schemas.ts and this module import each other through index.ts.
const Actor = z.lazy(() => ActorSummarySchema);

export const LoopActionSchema = z.enum(['spawn', 'dispatch', 'tool', 'post']);
export const LoopConcurrencySchema = z.enum(['skip', 'queue', 'replace']);
export const LoopModeSchema = z.enum(['one-shot', 'interactive']);
export const LoopRunTargetResultSchema = z.enum(['pending', 'posted', 'paused', 'held', 'superseded', 'refused']);
export const LoopRunTriggerSchema = z.enum(['schedule', 'manual']);
export const LoopRunStatusSchema = z.enum(['running', 'completed', 'failed', 'skipped', 'stopped', 'timed_out']);
export const LoopRunSkipReasonSchema = z.enum(['overlap', 'paused', 'schedule_invalid']);

const LoopTitle = z.string().trim().min(1).max(LOOP_TITLE_MAX);
const LoopScheduleText = z.string().trim().min(1).max(LOOP_SCHEDULE_MAX);
// Membership in the IANA set is checked by the server; the contract bounds the shape.
const LoopTimezone = z.string().min(1).max(64);
const LoopPrompt = z.string().max(LOOP_PROMPT_MAX);
const LoopMaxRuntime = z.number().int().min(LOOP_MAX_RUNTIME_MIN_SECONDS).max(LOOP_MAX_RUNTIME_MAX_SECONDS);
const RetryAttempts = z.number().int().min(0).max(LOOP_RETRY_ATTEMPTS_MAX);
const RetryDelay = z.number().int().min(LOOP_RETRY_DELAY_MIN_SECONDS).max(LOOP_RETRY_DELAY_MAX_SECONDS);
const ToolInputs = z.record(z.lazy(() => ToolJsonValueSchema));

export const LoopSpawnConfigSchema = z.object({
  model: z.string().min(1).max(200).nullable().optional(),
  agentTool: z.string().min(1).max(100).nullable().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable().optional(),
  accessMode: z.enum(['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess']).nullable().optional(),
  mode: z.enum(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator']).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  workdir: z.object({
    mode: z.lazy(() => WorkSessionWorkdirModeSchema),
    baseRef: z.string().min(1).max(255).nullable().optional(),
  }).strict().nullable().optional(),
  memoryIds: z.array(Id).max(LOOP_MEMORY_IDS_MAX).optional(),
  credentialSource: z.enum(['member', 'space', 'node']).nullable().optional(),
  interactionProfileId: Id.nullable().optional(),
}).strict();

export const LoopRetryPolicySchema = z.object({ attempts: RetryAttempts, delaySeconds: RetryDelay }).strict();

export const LoopTargetSchema = z.object({
  bridgeId: Id, text: z.string().trim().min(1).max(LOOP_TARGET_TEXT_MAX).nullable(),
}).strict();
const LoopTargets = z.array(LoopTargetSchema).max(LOOP_TARGETS_MAX);
export const LoopRunTargetSchema = z.object({
  bridgeId: Id, result: LoopRunTargetResultSchema, reason: z.string().nullable(), messageId: Id.nullable(),
}).strict();

export const LoopDefinitionSchema = z.object({
  title: LoopTitle,
  schedule: LoopScheduleText,
  timezone: LoopTimezone,
  action: LoopActionSchema,
  teamMemberId: Id.nullable(),
  subjectId: Id.nullable(),
  toolId: Id.nullable(),
  toolInputs: ToolInputs,
  prompt: LoopPrompt,
  config: LoopSpawnConfigSchema,
  concurrency: LoopConcurrencySchema,
  maxRuntimeSeconds: LoopMaxRuntime.nullable(),
  retry: LoopRetryPolicySchema,
  targets: LoopTargets,
  mode: LoopModeSchema,
  quietHoursExempt: z.boolean(),
}).strict();

const PartialRetry = z.object({ attempts: RetryAttempts.optional(), delaySeconds: RetryDelay.optional() }).strict();

export const LoopDefinitionDraftSchema = z.object({
  title: LoopTitle,
  schedule: LoopScheduleText,
  timezone: LoopTimezone.optional(),
  action: LoopActionSchema,
  teamMemberId: Id.nullable().optional(),
  subjectId: Id.nullable().optional(),
  toolId: Id.nullable().optional(),
  toolInputs: ToolInputs.optional(),
  prompt: LoopPrompt.optional(),
  config: LoopSpawnConfigSchema.optional(),
  concurrency: LoopConcurrencySchema.optional(),
  maxRuntimeSeconds: LoopMaxRuntime.nullable().optional(),
  retry: PartialRetry.optional(),
  targets: LoopTargets.optional(),
  mode: LoopModeSchema.optional(),
  quietHoursExempt: z.boolean().optional(),
}).strict();

export const LoopDefinitionPatchSchema = z.object({
  title: LoopTitle.optional(),
  schedule: LoopScheduleText.optional(),
  timezone: LoopTimezone.optional(),
  action: LoopActionSchema.optional(),
  teamMemberId: Id.nullable().optional(),
  subjectId: Id.nullable().optional(),
  toolId: Id.nullable().optional(),
  toolInputs: ToolInputs.optional(),
  prompt: LoopPrompt.optional(),
  config: LoopSpawnConfigSchema.optional(),
  concurrency: LoopConcurrencySchema.optional(),
  maxRuntimeSeconds: LoopMaxRuntime.nullable().optional(),
  retry: PartialRetry.optional(),
  targets: LoopTargets.optional(),
  mode: LoopModeSchema.optional(),
  quietHoursExempt: z.boolean().optional(),
}).strict();

export const LoopSchedulePreviewSchema = z.object({
  valid: z.boolean(), problem: z.string().nullable(), summary: z.string(), next: z.array(Instant).max(LOOP_PREVIEW_MAX_COUNT),
}).strict();

const Count = z.number().int().nonnegative().nullable();
export const LoopRunUsageSchema = z.object({
  inputTokens: Count, outputTokens: Count, costUsd: z.number().nonnegative().nullable(), source: z.literal('harness').nullable(),
}).strict();

export const LoopRunSchema = z.object({
  id: Id, loopId: Id, spaceId: Id,
  firedAt: Instant, trigger: LoopRunTriggerSchema, requestedBy: Actor.nullable(),
  action: LoopActionSchema, attempt: z.number().int().positive(),
  status: LoopRunStatusSchema, skipReason: LoopRunSkipReasonSchema.nullable(), error: z.string().nullable(),
  taskId: Id.nullable(), sessionId: Id.nullable(),
  startedAt: Instant.nullable(), endedAt: Instant.nullable(), durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(), outputTail: z.string().nullable(),
  actedAs: Actor.nullable(), endedKind: z.string().nullable(),
  usage: LoopRunUsageSchema.nullable(),
  targets: z.array(LoopRunTargetSchema),
}).strict();

export const LoopViewStateSchema = z.object({
  enabled: z.boolean(), pausedUntil: Instant.nullable(),
  nextRunAt: Instant.nullable(), lastRunAt: Instant.nullable(), lastError: z.string().nullable(),
  armedBy: Actor.nullable(), armedAt: Instant.nullable(),
  actingAs: z.object({ identity: Actor.nullable(), via: z.enum(['armer', 'fallback', 'none']) }).strict(),
  waitingOnRunId: Id.nullable(),
}).strict();

export const LoopRunsSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  last: LoopRunSchema.nullable(),
  last24h: z.object({ fired: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict(),
  usage: z.object({ inputTokens: Count, outputTokens: Count, costUsd: z.number().nonnegative().nullable() }).strict(),
}).strict();

export const LoopCapabilitiesSchema = z.object({
  canEdit: z.boolean(), canControl: z.boolean(), canRun: z.boolean(), canDelete: z.boolean(),
}).strict();

export const LoopViewSchema = z.object({
  id: Id, spaceId: Id, version: z.number().int().positive(),
  definition: LoopDefinitionSchema, schedule: LoopSchedulePreviewSchema,
  state: LoopViewStateSchema, runs: LoopRunsSummarySchema,
  createdBy: Actor.nullable(), createdAt: Instant, updatedAt: Instant,
  capabilities: LoopCapabilitiesSchema,
}).strict();

const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };
// IDs ride the route; clients may repeat them in the body for compatibility.
const Versioned = { ...Command, loopId: Id.optional(), expectedVersion: z.number().int().positive() };
export const LoopCreateInputSchema = z.object({ ...Command, spaceId: Id.optional(), definition: LoopDefinitionDraftSchema, enabled: z.boolean().optional() }).strict();
export const LoopUpdateInputSchema = z.object({ ...Versioned, definition: LoopDefinitionPatchSchema }).strict();
export const LoopEnableInputSchema = z.object(Versioned).strict();
export const LoopDisableInputSchema = LoopEnableInputSchema;
export const LoopResumeInputSchema = LoopEnableInputSchema;
// "> now" and the 365-day bound are checked by the server against its own clock.
export const LoopPauseInputSchema = z.object({ ...Versioned, until: Instant }).strict();
export const LoopRunNowInputSchema = z.object({ ...Command, loopId: Id.optional(), force: z.boolean().optional() }).strict();
export const LoopRunStopInputSchema = z.object({ ...Command, runId: Id.optional() }).strict();
export const LoopSchedulePreviewInputSchema = z.object({
  spaceId: Id.optional(), schedule: z.string().max(LOOP_SCHEDULE_MAX), timezone: LoopTimezone.optional(),
  count: z.number().int().min(1).max(LOOP_PREVIEW_MAX_COUNT).optional(),
}).strict();
export const LoopListResultSchema = z.object({ items: z.array(LoopViewSchema), nextCursor: z.string().nullable() }).strict();
export const LoopRunListResultSchema = z.object({ items: z.array(LoopRunSchema), nextCursor: z.string().nullable() }).strict();
export const LoopRunResultSchema = z.object({ run: LoopRunSchema }).strict();

type Assert<T extends true> = T;
export type LoopShapeProof = [
  Assert<SameShape<z.infer<typeof LoopTargetSchema>, LoopTarget>>,
  Assert<SameShape<z.infer<typeof LoopRunTargetSchema>, LoopRunTarget>>,
  Assert<SameShape<z.infer<typeof LoopSpawnConfigSchema>, LoopSpawnConfig>>,
  Assert<SameShape<z.infer<typeof LoopDefinitionSchema>, LoopDefinition>>,
  Assert<SameShape<z.infer<typeof LoopDefinitionDraftSchema>, LoopDefinitionDraft>>,
  Assert<SameShape<z.infer<typeof LoopDefinitionPatchSchema>, LoopDefinitionPatch>>,
  Assert<SameShape<z.infer<typeof LoopSchedulePreviewSchema>, LoopSchedulePreview>>,
  Assert<SameShape<z.infer<typeof LoopRunSchema>, LoopRun>>,
  Assert<SameShape<z.infer<typeof LoopViewStateSchema>, LoopViewState>>,
  Assert<SameShape<z.infer<typeof LoopRunsSummarySchema>, LoopRunsSummary>>,
  Assert<SameShape<z.infer<typeof LoopViewSchema>, LoopView>>,
  Assert<SameShape<z.infer<typeof LoopCreateInputSchema>, LoopCreateInput>>,
  Assert<SameShape<z.infer<typeof LoopUpdateInputSchema>, LoopUpdateInput>>,
  Assert<SameShape<z.infer<typeof LoopEnableInputSchema>, LoopEnableInput>>,
  Assert<SameShape<z.infer<typeof LoopPauseInputSchema>, LoopPauseInput>>,
  Assert<SameShape<z.infer<typeof LoopRunNowInputSchema>, LoopRunNowInput>>,
  Assert<SameShape<z.infer<typeof LoopRunStopInputSchema>, LoopRunStopInput>>,
  Assert<SameShape<z.infer<typeof LoopSchedulePreviewInputSchema>, LoopSchedulePreviewInput>>,
  Assert<SameShape<z.infer<typeof LoopListResultSchema>, LoopListResult>>,
  Assert<SameShape<z.infer<typeof LoopRunListResultSchema>, LoopRunListResult>>,
];

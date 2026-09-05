/**
 * THE COMPOSER'S RULES, WITH NO DOM IN THEM.
 *
 * The chat composer is split along one line, and everything in this module
 * exists to keep that line legible:
 *
 *   INSIDE the composer  = THIS MESSAGE   (mode · teammate · model+effort · ＋)
 *   UNDER the composer   = THIS THREAD    (project · permissions)
 *
 * Mode says HOW a turn works; permissions is the CEILING on what it may do
 * without asking. They are different axes, so the composer never folds one
 * into the other — it detects when they disagree (BUILD under Read-only) and
 * says so at compose time, between the two controls that disagree.
 *
 * Nothing here reads the server. The facts it needs — a teammate's role, a
 * model's tool and effort stops — arrive on the option shapes, and the
 * functions are total over missing data: an older node that projects no
 * `mode` yields an unfiltered roster, never an empty one.
 */
import type { ChatMode, ChatWorkdirMode, EntityId, LaunchModelEffort, TeamMemberMode } from '@tm8/contract';
import type { ChatModelOption, ChatTeammateOption } from '../types';

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type ModeGroupId = 'read' | 'shape' | 'act';

export interface ModeSpec {
  id: ChatMode;
  label: string;
  group: ModeGroupId;
  /** One line of CONSEQUENCE, not a synonym: what choosing this row does. */
  consequence: string;
  /** The lowest permission rung this mode can work under. */
  minPermission: PermissionRung;
  /** Default reasoning effort for this mode; the model popover remembers per mode. */
  defaultEffort: LaunchModelEffort;
}

export const MODE_GROUPS: readonly { id: ModeGroupId; label: string }[] = [
  { id: 'read', label: 'Read' },
  { id: 'shape', label: 'Shape' },
  { id: 'act', label: 'Act' },
];

export const MODE_SPECS: readonly ModeSpec[] = [
  { id: 'ask', label: 'ask', group: 'read', consequence: 'answers and proposes; changes nothing', minPermission: 'read-only', defaultEffort: 'low' },
  { id: 'explain', label: 'explain', group: 'read', consequence: 'turns context into diagrams, excerpts and docs', minPermission: 'read-only', defaultEffort: 'medium' },
  { id: 'plan', label: 'plan', group: 'shape', consequence: 'shapes steps into a plan you approve before anything runs', minPermission: 'read-only', defaultEffort: 'high' },
  { id: 'craft', label: 'craft', group: 'shape', consequence: 'sketches a blueprint row; edits only that row', minPermission: 'read-only', defaultEffort: 'high' },
  { id: 'build', label: 'build', group: 'act', consequence: 'edits files and the graph for real', minPermission: 'ask-first', defaultEffort: 'high' },
  { id: 'orchestrate', label: 'orchestrate', group: 'act', consequence: 'dispatches, steers and stops worker sessions', minPermission: 'ask-first', defaultEffort: 'high' },
];

export function modeSpec(mode: ChatMode): ModeSpec {
  const spec = MODE_SPECS.find((entry) => entry.id === mode);
  if (!spec) throw new Error(`unknown chat mode: ${mode}`);
  return spec;
}

/** `/build` on an empty input selects a mode. Returns null for anything else. */
export function modeFromSlash(input: string): ChatMode | null {
  const match = /^\/([a-z]+)\s*$/.exec(input.trim());
  if (!match) return null;
  const spec = MODE_SPECS.find((entry) => entry.id === match[1]);
  return spec ? spec.id : null;
}

// ---------------------------------------------------------------------------
// Permissions — the thread's ceiling
// ---------------------------------------------------------------------------

export type PermissionRung = 'read-only' | 'ask-first' | 'auto';

/** Spawn `accessMode`, as the contract spells it. */
export type WorkerAccessMode = 'plan' | 'safe' | 'acceptEdits' | 'auto' | 'fullAccess';

export interface PermissionSpec {
  id: PermissionRung;
  label: string;
  /** Labelled by consequence: what this rung ALLOWS. */
  allows: string;
  /** The spawn access mode it maps to for a worker. */
  accessMode: WorkerAccessMode;
  rank: number;
}

export const PERMISSION_RUNGS: readonly PermissionSpec[] = [
  { id: 'read-only', label: 'Read-only', allows: 'reads repo, graph and web; writes nothing', accessMode: 'plan', rank: 0 },
  { id: 'ask-first', label: 'Ask first', allows: 'proposes each write; you approve inline', accessMode: 'safe', rank: 1 },
  { id: 'auto', label: 'Auto', allows: 'edits files, mutates the graph, dispatches workers', accessMode: 'acceptEdits', rank: 2 },
];

export function permissionSpec(rung: PermissionRung): PermissionSpec {
  const spec = PERMISSION_RUNGS.find((entry) => entry.id === rung);
  if (!spec) throw new Error(`unknown permission rung: ${rung}`);
  return spec;
}

/** Rank of a spawn access mode on the same ladder; `fullAccess` sits above every rung. */
export function accessModeRank(mode: WorkerAccessMode): number {
  switch (mode) {
    case 'plan': return 0;
    case 'safe': return 1;
    case 'acceptEdits': return 2;
    case 'auto': return 2;
    case 'fullAccess': return 3;
  }
}

export const WORKER_ACCESS_MODES: readonly { id: WorkerAccessMode; label: string }[] = [
  { id: 'plan', label: 'Read-only' },
  { id: 'safe', label: 'Ask first' },
  { id: 'acceptEdits', label: 'Auto (accept edits)' },
  { id: 'auto', label: 'Auto' },
];

/**
 * A teammate's standing `permission_mode` (free text in the DB) folded onto
 * the ladder. Unknown or empty ⇒ the surface's default, Ask first. This is
 * where "tm8-web defaults to Ask first" comes from: teammate × project, said
 * out loud rather than assumed.
 */
export function rungFromPermissionMode(value: string | null | undefined): PermissionRung {
  switch (value) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions':
    case 'fullAccess':
      return 'auto';
    default:
      return 'ask-first';
  }
}

export interface ModeConflict {
  mode: ChatMode;
  current: PermissionRung;
  required: PermissionRung;
  /** The sentence between the composer and the rail. */
  message: string;
  /** The one-click raise's label. */
  raiseLabel: string;
}

/** BUILD under Read-only is a conflict; ASK under Auto is not (mode operates under the cap). */
export function modeConflict(mode: ChatMode, permission: PermissionRung): ModeConflict | null {
  const spec = modeSpec(mode);
  const required = permissionSpec(spec.minPermission);
  const current = permissionSpec(permission);
  if (current.rank >= required.rank) return null;
  return {
    mode,
    current: permission,
    required: required.id,
    message: `${spec.label.toUpperCase()} ${spec.consequence}, but this thread is ${current.label}.`,
    raiseLabel: `Raise to ${required.label}`,
  };
}

/**
 * A worker may go LOWER than the thread, never higher. Returns the capped
 * access mode and whether the requested one was cut.
 */
export function capWorkerAccess(
  thread: PermissionRung,
  requested: WorkerAccessMode | null,
): { accessMode: WorkerAccessMode; capped: boolean } {
  const ceiling = permissionSpec(thread);
  const wanted = requested ?? ceiling.accessMode;
  if (accessModeRank(wanted) <= ceiling.rank) return { accessMode: wanted, capped: false };
  return { accessMode: ceiling.accessMode, capped: true };
}

export function workerAccessOptions(thread: PermissionRung): readonly { id: WorkerAccessMode; label: string; disabledReason?: string }[] {
  const ceiling = permissionSpec(thread);
  return WORKER_ACCESS_MODES.map((option) =>
    accessModeRank(option.id) <= ceiling.rank
      ? option
      : { ...option, disabledReason: `above the thread's ${ceiling.label} ceiling` },
  );
}

// ---------------------------------------------------------------------------
// Teammates — who runs the turn
// ---------------------------------------------------------------------------

const COORDINATOR_MODES: ReadonlySet<TeamMemberMode> = new Set(['coordinator', 'coordinated-coordinator']);

export function isCoordinator(teammate: Pick<ChatTeammateOption, 'mode'>): boolean {
  return teammate.mode != null && COORDINATOR_MODES.has(teammate.mode);
}

export interface TeammateRoster {
  options: readonly ChatTeammateOption[];
  /** The id to preselect when the current selection is not in `options`. */
  preselect: EntityId | null;
  /** Why the roster is what it is, when the honest answer is a degraded one. */
  note: string | null;
}

/**
 * Under orchestrate the list is COORDINATORS ONLY, preselected. With no
 * coordinator in the space it degrades to "all teammates, coordinators first"
 * and says so — never an empty dropdown. Every other mode gets the roster as
 * it came, in the caller's order.
 */
export function teammateRoster(
  teammates: readonly ChatTeammateOption[],
  mode: ChatMode,
  current: EntityId | '',
): TeammateRoster {
  if (mode !== 'orchestrate') {
    return { options: teammates, preselect: null, note: null };
  }
  const coordinators = teammates.filter(isCoordinator);
  if (coordinators.length > 0) {
    const keep = coordinators.some((teammate) => teammate.id === current);
    return {
      options: coordinators,
      preselect: keep ? null : coordinators[0]!.id,
      note: null,
    };
  }
  const anyKnown = teammates.some((teammate) => teammate.mode !== undefined);
  return {
    options: teammates,
    preselect: null,
    note: anyKnown
      ? 'No coordinator teammate exists in this space yet — showing every teammate.'
      : 'This node does not project teammate roles — showing every teammate.',
  };
}

// ---------------------------------------------------------------------------
// Models and effort
// ---------------------------------------------------------------------------

export interface ModelChoice {
  id: string;
  label: string;
  hint?: string;
  /** Present ⇒ the row is drawn, but cannot be picked, and this is why. */
  disabledReason?: string;
}

/**
 * The chat COORDINATOR runs claude-code only (`startChatThread` refuses any
 * other tool). A codex model is still LISTED, disabled with that reason: a
 * silent omission is how a human concludes GPT 5.6 was never an option.
 */
export function coordinatorModelChoices(models: readonly ChatModelOption[]): ModelChoice[] {
  return models.map((model) => ({
    id: model.model,
    label: model.label,
    hint: model.provider,
    ...(model.agentTool === 'claude-code'
      ? {}
      : { disabledReason: `chat runs Claude Code only — ${model.agentTool} models can be workers, not the coordinator` }),
  }));
}

/** Every catalog model, for a WORKER slot — codex included. */
export function workerModelChoices(models: readonly ChatModelOption[]): ModelChoice[] {
  return models.map((model) => ({ id: model.model, label: model.label, hint: `${model.provider} · ${model.agentTool}` }));
}

export const EFFORT_LABELS: Record<LaunchModelEffort, { short: string; band: string }> = {
  low: { short: 'fast', band: 'quickest · cheapest' },
  medium: { short: 'balanced', band: 'moderate latency' },
  high: { short: 'deep', band: 'slower · more thorough' },
  xhigh: { short: 'deeper', band: 'long-running · costly' },
  max: { short: 'max', band: 'longest · most costly' },
  ultra: { short: 'ultra', band: 'longest · most costly' },
};

export interface EffortAvailability {
  stops: readonly LaunchModelEffort[];
  /** Set when the control must render disabled. */
  disabledReason: string | null;
}

export function effortAvailability(model: Pick<ChatModelOption, 'label' | 'efforts'> | undefined): EffortAvailability {
  if (!model) return { stops: [], disabledReason: 'pick a model first' };
  if (model.efforts === undefined) {
    return { stops: [], disabledReason: `${model.label} does not declare effort stops on this node` };
  }
  if (model.efforts.length === 0) {
    return { stops: [], disabledReason: `${model.label} has one fixed effort level` };
  }
  return { stops: model.efforts, disabledReason: null };
}

/** The remembered effort for a model, or the nearest stop it actually offers. */
export function nearestEffort(
  wanted: LaunchModelEffort,
  stops: readonly LaunchModelEffort[],
): LaunchModelEffort | null {
  if (stops.length === 0) return null;
  if (stops.includes(wanted)) return wanted;
  const ladder: LaunchModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const wantedRank = ladder.indexOf(wanted);
  let best: LaunchModelEffort = stops[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const distance = Math.abs(ladder.indexOf(stop) - wantedRank);
    if (distance < bestDistance) { best = stop; bestDistance = distance; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The fixed ⚙ slot — mode-specific options, one per mode, counted when non-default
// ---------------------------------------------------------------------------

export type ModeOptionField =
  | { key: string; label: string; kind: 'toggle'; default: boolean }
  | { key: string; label: string; kind: 'choice'; default: string; choices: readonly string[] }
  | { key: string; label: string; kind: 'text'; default: string; placeholder?: string };

export const MODE_OPTION_FIELDS: Record<ChatMode, readonly ModeOptionField[]> = {
  ask: [{ key: 'webSearch', label: 'Web search', kind: 'toggle', default: false }],
  explain: [{ key: 'target', label: 'Output target', kind: 'choice', default: 'inline', choices: ['inline', 'doc', 'artifact'] }],
  plan: [
    { key: 'destination', label: 'Destination', kind: 'choice', default: 'artifact', choices: ['artifact', 'doc', 'task tree'] },
    { key: 'depth', label: 'Depth', kind: 'choice', default: 'standard', choices: ['outline', 'standard', 'exhaustive'] },
  ],
  craft: [{ key: 'scope', label: 'Blueprint', kind: 'choice', default: 'new', choices: ['new', 'extend'] }],
  build: [
    { key: 'checkout', label: 'Checkout', kind: 'choice', default: 'branch', choices: ['branch', 'worktree'] },
    { key: 'autoCommit', label: 'Auto-commit', kind: 'toggle', default: false },
    { key: 'testCommand', label: 'Test command', kind: 'text', default: '', placeholder: 'e.g. bun test' },
  ],
  orchestrate: [
    { key: 'parallelism', label: 'Parallelism', kind: 'choice', default: '3', choices: ['1', '2', '3', '4', '6', '8'] },
    { key: 'autonomy', label: 'Autonomy', kind: 'choice', default: 'propose', choices: ['propose', 'auto-dispatch'] },
    { key: 'onFailure', label: 'On failure', kind: 'choice', default: 'pause', choices: ['pause', 'retry once', 'continue'] },
  ],
};

export type ModeOptionValues = Record<string, string | boolean>;
export type ModeOptionsByMode = Partial<Record<ChatMode, ModeOptionValues>>;

export function modeOptionValue(field: ModeOptionField, values: ModeOptionValues | undefined): string | boolean {
  const stored = values?.[field.key];
  return stored === undefined ? field.default : stored;
}

/** The badge count: how many of this mode's options differ from their default. */
export function nonDefaultOptionCount(mode: ChatMode, values: ModeOptionValues | undefined): number {
  return MODE_OPTION_FIELDS[mode].reduce(
    (count, field) => count + (modeOptionValue(field, values) !== field.default ? 1 : 0),
    0,
  );
}

/** Lines the turn carries about its options — only the non-default ones. */
export function modeOptionLines(mode: ChatMode, values: ModeOptionValues | undefined): string[] {
  return MODE_OPTION_FIELDS[mode]
    .filter((field) => modeOptionValue(field, values) !== field.default)
    .map((field) => `${field.label}: ${String(modeOptionValue(field, values))}`);
}

// ---------------------------------------------------------------------------
// Project — write-once, so the rail says so
// ---------------------------------------------------------------------------

export interface ProjectBinding {
  workdirMode: ChatWorkdirMode;
  projectId: EntityId | null;
}

export const SCRATCH_PROJECT_ID = '__scratch__';

export function projectBindingFromChoice(choice: string): ProjectBinding {
  return choice === SCRATCH_PROJECT_ID || choice === ''
    ? { workdirMode: 'scratch', projectId: null }
    : { workdirMode: 'project', projectId: choice as EntityId };
}

// ---------------------------------------------------------------------------
// Crew — the orchestrate pool, configured at creation
// ---------------------------------------------------------------------------

export interface CrewWorker {
  key: string;
  teammateId: EntityId | '';
  model: string;
  effort: LaunchModelEffort | null;
  /** Per-worker override, capped by the thread's rung at send time. */
  accessMode: WorkerAccessMode | null;
  skills: string[];
  mcps: string[];
  memories: string[];
  promptExtra: string;
}

export interface CrewSpec {
  workers: CrewWorker[];
}

let crewSeq = 0;
export function newCrewWorker(defaults: Partial<CrewWorker> = {}): CrewWorker {
  crewSeq += 1;
  return {
    key: `w${crewSeq}-${Date.now().toString(36)}`,
    teammateId: '',
    model: '',
    effort: null,
    accessMode: null,
    skills: [],
    mcps: [],
    memories: [],
    promptExtra: '',
    ...defaults,
  };
}

/** How many of a worker's ⚙ fields are set — the badge on its gear. */
export function workerExtraCount(worker: CrewWorker): number {
  return (
    worker.skills.length +
    worker.mcps.length +
    worker.memories.length +
    (worker.accessMode ? 1 : 0) +
    (worker.promptExtra.trim() ? 1 : 0)
  );
}

export interface CrewBriefContext {
  teammates: readonly ChatTeammateOption[];
  models: readonly ChatModelOption[];
  permission: PermissionRung;
  options: ModeOptionValues | undefined;
}

/**
 * THE CREW BRIEF — what the coordinator is told about its pool.
 *
 * There is no server field for a chat's crew yet (decisions 17–22 are open),
 * so the pool travels the one channel that already reaches the coordinator:
 * the opening turn. It is rendered VISIBLY under the crew panel before send
 * and lands in the transcript verbatim, so the audit record is the message
 * itself. Every line names ids a coordinator can hand straight to
 * `tm8 execution spawn`; the access line is already capped by the thread.
 */
export function crewBrief(crew: CrewSpec, ctx: CrewBriefContext): string {
  const workers = crew.workers.filter((worker) => worker.teammateId && worker.model);
  if (workers.length === 0) return '';
  const lines: string[] = ['', '---', 'Crew for this thread (spawn defaults; mode coordinated-worker):'];
  workers.forEach((worker, index) => {
    const teammate = ctx.teammates.find((entry) => entry.id === worker.teammateId);
    const model = ctx.models.find((entry) => entry.model === worker.model);
    const { accessMode } = capWorkerAccess(ctx.permission, worker.accessMode);
    const parts = [
      `${index + 1}. ${teammate?.label ?? 'teammate'} (teamMemberId ${worker.teammateId})`,
      `model ${worker.model}${model ? ` via ${model.agentTool}` : ''}`,
      worker.effort ? `effort ${worker.effort}` : null,
      `accessMode ${accessMode}`,
      worker.skills.length ? `skills ${worker.skills.join(', ')}` : null,
      worker.mcps.length ? `mcps ${worker.mcps.join(', ')}` : null,
      worker.memories.length ? `memories ${worker.memories.join(', ')}` : null,
      worker.promptExtra.trim() ? `note: ${worker.promptExtra.trim()}` : null,
    ].filter((part): part is string => part !== null);
    lines.push(parts.join(' · '));
  });
  const policy = MODE_OPTION_FIELDS.orchestrate.map(
    (field) => `${field.label.toLowerCase()} ${String(modeOptionValue(field, ctx.options))}`,
  );
  lines.push(`Policy: ${policy.join(' · ')} · thread ceiling ${permissionSpec(ctx.permission).label}.`);
  return lines.join('\n');
}

// `tm8 loop` (design 01a182d4 §5): every verb is one loops.* operation. The
// CLI never computes schedule state and never writes loop fields through
// entities.*: the server owns nextRunAt, the preview and who a firing acts as.
import {
  LOOP_MAX_RUNTIME_MAX_SECONDS, LOOP_MAX_RUNTIME_MIN_SECONDS, LOOP_PAUSE_MAX_DAYS, LOOP_PREVIEW_MAX_COUNT,
  LOOP_RETRY_ATTEMPTS_MAX, LOOP_RETRY_DELAY_MAX_SECONDS, LOOP_RETRY_DELAY_MIN_SECONDS,
  LoopActionSchema, LoopConcurrencySchema, LoopRunStatusSchema, LoopSpawnConfigSchema,
  type ActorSummary, type LoopAction, type LoopListResult, type LoopRun, type LoopRunListResult, type LoopRunResult,
  type LoopSchedulePreview, type LoopView, type ToolJsonValue, type ToolView, type WorkSessionWorkdirMode,
} from '@tm8/contract';
import { readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { UUID_PATTERN } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, enumOption, HEADER_TEXT_OPTIONS, headerTextOptions, requireArg } from './entity.js';
import { parseCredentialSourceFlags } from './session.js';
import { client, mutation } from './tool.js';
import { parseToolValue } from './tool-args.js';

interface Page<T> { items: T[]; nextCursor: string | null }
type Actor = ActorSummary | null;

const usage = (message: string, hint?: string): CliError => new CliError(message, EXIT_USAGE, hint ? { hint } : {});

// The closed sets are the contract's, so a value the server would refuse is a local usage error.
const SPAWN_CONFIG = LoopSpawnConfigSchema.shape;
const EFFORTS = SPAWN_CONFIG.reasoningEffort.unwrap().unwrap().options;
const ACCESS_MODES = SPAWN_CONFIG.accessMode.unwrap().unwrap().options;
const SESSION_MODES = SPAWN_CONFIG.mode.unwrap().unwrap().options;
const WORKDIR_MODES = ['project', 'worktree', 'scratch'] as const satisfies readonly WorkSessionWorkdirMode[];

// Every flag `create` takes; `edit` takes all of them plus the clears.
const DEFINITION_OPTIONS = ['schedule', 'timezone', 'teammate', 'dispatch', 'tool', 'input', 'subject', 'prompt',
  'model', 'agent-tool', 'reasoning-effort', 'access-mode', 'mode', 'launch-project', 'workdir', 'base-ref',
  'memory', 'credential-source', 'interaction-profile', 'concurrency', 'max-runtime', 'retry', 'retry-delay'];
const EDIT_OPTIONS = [...DEFINITION_OPTIONS, 'title', 'clear-tool', 'clear-inputs'];

function argumentsCount(cmd: CommandContext, count: number): void {
  if (cmd.args.length !== count || cmd.passthrough.length) {
    throw usage(`tm8 ${cmd.path.join(' ')} expects ${count} argument${count === 1 ? '' : 's'}; see its help`);
  }
}
function expectedVersion(cmd: CommandContext): number {
  const version = cmd.options.integer('expect-version');
  if (version === undefined) throw usage('--expect-version is required', 'read it with `tm8 loop show <id>`');
  if (version < 1) throw usage('--expect-version must be a positive integer');
  return version;
}
/** A bare flag: the parser would otherwise read `--enabled=false` as `--enabled`. */
function flag(cmd: CommandContext, name: string): boolean {
  if (cmd.options.values(name).length) throw usage(`--${name} takes no value`);
  return cmd.options.bool(name);
}
function bounded(cmd: CommandContext, option: string, min: number, max: number): number | undefined {
  const value = cmd.options.integer(option);
  if (value !== undefined && (value < min || value > max)) throw usage(`--${option} must be between ${min} and ${max}`);
  return value;
}
const choice = <T extends string>(cmd: CommandContext, option: string, allowed: readonly T[]) =>
  enumOption(cmd, option, allowed) as T | undefined;
/** The `<value|none>` idiom over a closed set: `none` is an explicit null (unset). */
function nullableChoice<T extends string>(cmd: CommandContext, option: string, allowed: readonly T[]): T | null | undefined {
  return cmd.options.value(option) === 'none' ? null : choice(cmd, option, allowed);
}
function pageQuery(cmd: CommandContext, options: readonly string[]): Record<string, string> {
  const query: Record<string, string> = {};
  const limit = bounded(cmd, 'limit', 1, Number.MAX_SAFE_INTEGER);
  if (limit !== undefined) query.limit = String(limit);
  for (const option of options) {
    const value = cmd.options.value(option); if (value !== undefined) query[option] = value;
  }
  return query;
}

/**
 * The loop a reference names: an id as given, a title through loops.list
 * (exact, against the title the server stored trimmed). A title lookup
 * returns the listed view too, so a caller that only needs the definition
 * does not read the loop twice.
 */
async function findLoop(cmd: CommandContext): Promise<{ id: string; view: LoopView | null }> {
  const ref = requireArg(cmd, 0, '<id|title>');
  if (UUID_PATTERN.test(ref)) return { id: ref, view: null };
  const title = ref.trim();
  let cursor: string | null = null;
  const found: LoopView[] = [];
  do {
    const page: LoopListResult = await observedInvoke(client(cmd), 'loops.list', {
      params: { spaceId: requireSpace(cmd.ctx) }, query: { words: title, limit: '100', ...(cursor ? { cursor } : {}) },
    });
    found.push(...page.items.filter(item => item.definition.title === title));
    cursor = page.nextCursor;
  } while (cursor);
  if (found.length === 0) throw new CliError(`Loop ${JSON.stringify(title)} was not found in this Space`, EXIT_NOT_FOUND);
  if (found.length > 1) throw usage(`${found.length} loops are titled ${JSON.stringify(title)}; use an id: ${found.map(l => l.id).join(', ')}`);
  return { id: found[0]!.id, view: found[0]! };
}
async function loadLoop(cmd: CommandContext): Promise<LoopView> {
  const { id } = await findLoop(cmd);
  return observedInvoke(client(cmd), 'loops.get', { params: { loopId: id } });
}
/** A loop's version also moves each time it fires, so a conflict on a busy loop usually means it just fired. */
async function versioned<T>(loopId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'version_conflict') {
      error.hint ??= `a loop's version also moves each time it fires: read it again with \`tm8 loop show ${loopId}\` and retry`;
    }
    throw error;
  }
}

/** An id passes through; a name resolves against the team_member entities of the loop's Space. */
async function resolveTeammate(cmd: CommandContext, spaceId: string, ref: string): Promise<string> {
  if (UUID_PATTERN.test(ref)) return ref;
  const name = ref.trim();
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const data = await observedInvoke<{ page?: { items?: Array<{ id: string; title?: string | null }>; nextCursor?: string | null } }>(
      clientFor(cmd.ctx), 'collections.query', { body: {
        spaceId, kinds: ['team_member'], filters: { titleContains: name }, limit: 100, ...(cursor ? { cursor } : {}),
      } });
    for (const item of data.page?.items ?? []) if (item.title?.trim().toLowerCase() === name.toLowerCase()) matches.push(item.id);
    cursor = data.page?.nextCursor ?? undefined;
  } while (cursor);
  if (matches.length === 0) throw new CliError(`Teammate ${JSON.stringify(name)} was not found in this Space`, EXIT_NOT_FOUND, { hint: 'list them with `tm8 teammate list`' });
  if (matches.length > 1) throw usage(`${matches.length} teammates are named ${JSON.stringify(name)}; use an id: ${matches.join(', ')}`);
  return matches[0]!;
}
/** A tool by id or by its definition name in the loop's Space, read whole: its inputs type `--input`. */
async function loadTool(cmd: CommandContext, spaceId: string, ref: string): Promise<ToolView> {
  let toolId = ref;
  if (!UUID_PATTERN.test(ref)) {
    let cursor: string | null = null;
    let found: { id: string } | undefined;
    do {
      const page: Page<{ id: string; definition: { name: string } }> = await observedInvoke(client(cmd), 'tools.list', {
        params: { spaceId }, query: { words: ref, limit: '100', ...(cursor ? { cursor } : {}) },
      });
      found = page.items.find(item => item.definition.name === ref);
      cursor = page.nextCursor;
    } while (!found && cursor);
    if (!found) throw new CliError(`Tool ${ref} was not found in this Space`, EXIT_NOT_FOUND, { hint: 'list them with `tm8 tool list`' });
    toolId = found.id;
  }
  return observedInvoke(client(cmd), 'tools.get', { params: { toolId } });
}

/**
 * `--input <name>=<value>`, typed by the tool's declared input with the same
 * parse `tm8 tool run` uses. A secret is refused: a loop stores its inputs in
 * its definition, which every member of the Space can read, so a secret only
 * reaches a loop's run through the tool's own binding.
 */
function parseInputs(tool: ToolView, raws: readonly string[]): Record<string, ToolJsonValue> {
  const inputs: Record<string, ToolJsonValue> = {};
  const name = tool.definition.name;
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    // The value is never echoed: it may be the secret this refusal exists for.
    if (eq < 1) throw usage('--input expects <name>=<value>');
    const key = raw.slice(0, eq);
    const input = tool.definition.inputs.find(candidate => candidate.name === key);
    if (!input) {
      const names = tool.definition.inputs.map(candidate => candidate.name).join(', ') || 'none';
      throw usage(`Tool ${name} has no input ${key}; its inputs: ${names}`);
    }
    if (input.type === 'secret') {
      throw usage(`${key} is a secret input, and a loop never stores a secret`, `bind it on the tool with \`tm8 tool secret set ${name} ${key}\`; the loop's runs use the binding`);
    }
    if (Object.hasOwn(inputs, key)) throw usage(`--input ${key} is given more than once`);
    inputs[key] = parseToolValue(input, raw.slice(eq + 1));
  }
  return inputs;
}
/** The inputs a run of this tool needs and nothing supplies: no value, no tool config, no default. */
function missingInputs(tool: ToolView, inputs: Readonly<Record<string, ToolJsonValue>>): string[] {
  return tool.definition.inputs.filter(input => input.type !== 'secret' && input.required
    && !Object.hasOwn(inputs, input.name) && !Object.hasOwn(tool.config, input.name)
    && !('default' in input && input.default !== undefined)).map(input => input.name);
}
const reachesTm8 = (tool: ToolView) => tool.definition.tm8Access === 'read' || tool.definition.tm8Access === 'write';

/**
 * The launch flags as a config patch: a value sets a key, `none` unsets it
 * (null), an absent flag leaves it alone. `--memory none` empties the list.
 */
function configFlags(cmd: CommandContext, stored: LoopView['definition']['config'] | null): Record<string, unknown> {
  const o = cmd.options;
  const config: Record<string, unknown> = {};
  const strings: Array<[string, string]> = [['model', 'model'], ['agent-tool', 'agentTool'], ['launch-project', 'projectId'], ['interaction-profile', 'interactionProfileId']];
  for (const [option, field] of strings) {
    const value = o.value(option);
    if (value !== undefined) config[field] = value === 'none' ? null : value;
  }
  const enums: Array<[string, string, readonly string[]]> = [['reasoning-effort', 'reasoningEffort', EFFORTS], ['access-mode', 'accessMode', ACCESS_MODES], ['mode', 'mode', SESSION_MODES]];
  for (const [option, field, allowed] of enums) {
    const value = nullableChoice(cmd, option, allowed);
    if (value !== undefined) config[field] = value;
  }
  // `--base-ref` belongs to the worktree variant only, as in `tm8 session spawn`.
  const workdir = nullableChoice(cmd, 'workdir', WORKDIR_MODES), baseRef = o.value('base-ref');
  if (workdir !== undefined || baseRef !== undefined) {
    const mode = workdir === undefined ? stored?.workdir?.mode : workdir;
    if (baseRef !== undefined && mode !== 'worktree') {
      throw usage('--base-ref applies only to a worktree workdir', 'add --workdir worktree');
    }
    // Retiming the mode keeps a stored base ref only while the loop stays on a worktree.
    const ref = baseRef ?? (mode === 'worktree' && stored?.workdir?.mode === 'worktree' ? stored.workdir.baseRef ?? undefined : undefined);
    config.workdir = mode === null || mode === undefined ? null : ref ? { mode, baseRef: ref } : { mode };
  }
  if (o.has('memory')) {
    const ids = o.values('memory');
    if (ids.length === 1 && ids[0] === 'none') config.memoryIds = [];
    else {
      for (const id of ids) if (!UUID_PATTERN.test(id)) throw usage('--memory takes a memory id (or none to clear the list)');
      config.memoryIds = ids;
    }
  }
  if (o.has('credential-source')) {
    if (o.value('credential-source') === 'none') config.credentialSource = null;
    else {
      const parsed = parseCredentialSourceFlags(o.values('credential-source'));
      if (parsed.credentialSources || parsed.spaceCredentialIds) {
        throw usage('a loop takes one credential source for every provider: --credential-source member|space|node');
      }
      config.credentialSource = parsed.credentialSource;
    }
  }
  return config;
}

/**
 * The definition fields the flags name — only those, so `edit` sends a true
 * partial and the server keeps everything else. `create` (no `current`) fills
 * the required ones and lets the server default the rest.
 *
 * Two stored fields are whole objects the server REPLACES on update (`config`
 * and `toolInputs`), so `edit` overlays the flags on the stored object and
 * sends the result; sending the flags alone would erase every key not named.
 *
 * With `--tool`, `--teammate` names the persona the tool runs as (§2.1; the
 * server requires one when the tool reaches tm8). On `edit` of a tool loop,
 * `--teammate` alone changes that persona; with `--clear-tool` it makes the
 * loop a spawn loop. Changing what runs clears what belonged to the old
 * runner: a loop that stops being a tool loop loses its inputs, a loop that
 * becomes one loses its launch config, and its persona is the one `--teammate`
 * names, never the spawn teammate it happened to have.
 */
async function definitionFlags(cmd: CommandContext, current: LoopView | null): Promise<Record<string, unknown>> {
  const def: Record<string, unknown> = {};
  const o = cmd.options;
  const spaceId = current?.spaceId ?? requireSpace(cmd.ctx);
  const dispatch = flag(cmd, 'dispatch'), clearTool = flag(cmd, 'clear-tool'), clearInputs = flag(cmd, 'clear-inputs');
  const teammateRef = o.value('teammate'), toolRef = o.value('tool');
  const before: LoopAction | undefined = current?.definition.action;
  if (dispatch && (teammateRef !== undefined || toolRef !== undefined)) throw usage('--dispatch takes neither --teammate nor --tool');
  if (!current && teammateRef === undefined && !dispatch && toolRef === undefined) {
    throw usage('Supply one of --teammate <id|name>, --dispatch or --tool <name|id>');
  }
  if (clearTool && toolRef !== undefined) throw usage('--clear-tool and --tool cannot be combined');
  if (clearTool && before !== 'tool') throw usage('--clear-tool applies to a tool loop');
  if (clearTool && teammateRef === undefined) {
    throw usage('--clear-tool makes the loop a spawn loop: name its teammate', 'add --teammate <id|name>, or use --dispatch instead of --clear-tool');
  }
  const action: LoopAction = toolRef !== undefined ? 'tool' : dispatch ? 'dispatch'
    : teammateRef !== undefined && !(before === 'tool' && !clearTool) ? 'spawn' : before!;
  if (action !== before) def.action = action;

  let tool: ToolView | null = null;
  if (toolRef !== undefined) {
    tool = await loadTool(cmd, spaceId, toolRef);
    def.toolId = tool.id;
  }
  if (teammateRef !== undefined) def.teamMemberId = await resolveTeammate(cmd, spaceId, teammateRef);
  // The Dispatcher picks the runner: a dispatch loop names no teammate and no tool (the door refuses one).
  if (dispatch) Object.assign(def, { teamMemberId: null, toolId: null });
  if (action === 'spawn' && before === 'tool') def.toolId = null;
  if (action === 'tool' && before !== undefined && before !== 'tool') {
    // A spawn teammate does not silently become the tool's persona, and launch config does not apply to a tool.
    if (teammateRef === undefined) def.teamMemberId = null;
    def.config = {};
  }
  if (before === 'tool' && action !== 'tool') def.toolInputs = {};

  // Tool inputs: typed against the tool; on edit, overlaid on the stored inputs unless the tool changes.
  if ((o.has('input') || clearInputs) && action !== 'tool') throw usage(`--${o.has('input') ? 'input' : 'clear-inputs'} applies to --tool loops only`);
  const toolChanged = tool !== null && tool.id !== current?.definition.toolId;
  if (action === 'tool' && (tool !== null || o.has('input') || clearInputs)) {
    tool ??= await loadTool(cmd, spaceId, current!.definition.toolId!);
    const declared = new Set(tool.definition.inputs.filter(input => input.type !== 'secret').map(input => input.name));
    const kept = toolChanged || clearInputs || !current ? {}
      : Object.fromEntries(Object.entries(current.definition.toolInputs).filter(([key]) => declared.has(key)));
    const inputs = { ...kept, ...parseInputs(tool, o.values('input')) };
    const missing = missingInputs(tool, inputs);
    if (missing.length) {
      throw usage(`Tool ${tool.definition.name} needs a value for ${missing.join(', ')}`, `add ${missing.map(key => `--input ${key}=<value>`).join(' ')}`);
    }
    def.toolInputs = inputs;
    const persona = def.teamMemberId !== undefined ? def.teamMemberId : current?.definition.teamMemberId ?? null;
    if (reachesTm8(tool) && !persona) {
      throw usage(`Tool ${tool.definition.name} reaches tm8 (tm8Access ${tool.definition.tm8Access}): name the persona it runs as`, 'add --teammate <id|name>');
    }
    for (const input of tool.definition.inputs) {
      if (input.type === 'secret' && input.required && !tool.secretBindings.some(binding => binding.inputName === input.name)) {
        cmd.out.warn(`warning: tool ${tool.definition.name} needs the secret ${input.name} and none is bound; the loop's runs fail until \`tm8 tool secret set ${tool.definition.name} ${input.name}\` binds one`);
      }
    }
  }

  // `--subject <id|none>`: none clears it (the CLI-wide `<value|none>` idiom).
  const subject = o.value('subject');
  if (subject === 'none') def.subjectId = null;
  else if (subject !== undefined) {
    if (!UUID_PATTERN.test(subject)) throw usage('--subject takes an entity id (or none to clear it)');
    def.subjectId = subject;
  }
  for (const [option, field] of [['schedule', 'schedule'], ['timezone', 'timezone']] as const) {
    const value = o.value(option); if (value !== undefined) def[field] = value;
  }
  if (o.value('prompt') !== undefined) def.prompt = await readTextSource(o.value('prompt')!);
  const concurrency = choice(cmd, 'concurrency', LoopConcurrencySchema.options);
  if (concurrency) def.concurrency = concurrency;
  // `--max-runtime <seconds|none>`: none is "no limit", the only way to clear one once set.
  if (o.value('max-runtime') === 'none') def.maxRuntimeSeconds = null;
  else {
    const maxRuntime = bounded(cmd, 'max-runtime', LOOP_MAX_RUNTIME_MIN_SECONDS, LOOP_MAX_RUNTIME_MAX_SECONDS);
    if (maxRuntime !== undefined) def.maxRuntimeSeconds = maxRuntime;
  }
  const attempts = bounded(cmd, 'retry', 0, LOOP_RETRY_ATTEMPTS_MAX);
  const delay = bounded(cmd, 'retry-delay', LOOP_RETRY_DELAY_MIN_SECONDS, LOOP_RETRY_DELAY_MAX_SECONDS);
  // A partial retry policy: the server keeps (or defaults) the half not given.
  if (attempts !== undefined || delay !== undefined) {
    def.retry = { ...(attempts !== undefined ? { attempts } : {}), ...(delay !== undefined ? { delaySeconds: delay } : {}) };
  }

  const stored = current && current.definition.action !== 'tool' ? current.definition.config : null;
  const config = configFlags(cmd, stored);
  if (Object.keys(config).length) {
    if (action === 'tool') throw usage('Launch flags (--model, --workdir, …) apply to spawn and dispatch loops');
    // The server replaces the whole object, so the flags overlay the stored one; a null unsets its key.
    const merged: Record<string, unknown> = { ...(stored ?? {}), ...config };
    for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
    def.config = merged;
  }
  return def;
}

// ── human rendering ───────────────────────────────────────────────────────
const actor = (a: Actor): string => a?.displayName ?? 'nobody';
const runner = (loop: LoopView): string => loop.definition.action === 'spawn' ? `spawn ${loop.definition.teamMemberId ?? '?'}`
  : loop.definition.action === 'tool'
    ? `tool ${loop.definition.toolId ?? '?'}${loop.definition.teamMemberId ? ` as ${loop.definition.teamMemberId}` : ''}` : 'dispatch';
/** A pause that has run out still sits in `pausedUntil` (only resume clears it); the due read ignores it, and so does this. */
export function loopState(loop: LoopView, now: number = Date.now()): string {
  if (!loop.state.enabled) return 'disabled';
  const until = loop.state.pausedUntil;
  const paused = until !== null && Date.parse(until) > now ? `paused until ${until}` : null;
  const schedule = loop.schedule.valid ? null : `invalid: ${loop.schedule.problem ?? 'schedule'}`;
  return [paused, schedule].filter(part => part !== null).join(' · ') || 'enabled';
}
export function renderLoop(loop: LoopView): string {
  const d = loop.definition, s = loop.state;
  const lines = [
    `loop ${loop.id} v${loop.version} · ${loopState(loop)}`,
    `title: ${d.title}`,
    `schedule: ${d.schedule} (${d.timezone}) — ${loop.schedule.summary}`,
    `action: ${runner(loop)}${d.subjectId ? ` · subject ${d.subjectId}` : ''} · concurrency ${d.concurrency}` +
      `${d.maxRuntimeSeconds ? ` · max runtime ${d.maxRuntimeSeconds}s` : ''} · retry ${d.retry.attempts}×${d.retry.delaySeconds}s`,
    `next run: ${s.nextRunAt ?? 'none'} · last run: ${s.lastRunAt ?? 'never'}${s.waitingOnRunId ? ` · waiting on run ${s.waitingOnRunId}` : ''}`,
    `acts as: ${actor(s.actingAs.identity)} (${s.actingAs.via})`,
  ];
  if (s.lastError) lines.push(`last error: ${s.lastError}`);
  // The server counts these from the moment of the read, not from the stored next run: an interval
  // loop's real cadence runs from its last firing, so they are the schedule's shape, not its timetable.
  if (loop.schedule.next.length) lines.push(`schedule from now: ${loop.schedule.next.join(', ')}`);
  const r = loop.runs;
  lines.push(`runs: ${r.total} total · last 24h ${r.last24h.fired} fired, ${r.last24h.failed} failed, ${r.last24h.skipped} skipped` +
    `${r.last ? ` · last ${r.last.id} ${r.last.status}` : ''}`);
  if (Object.keys(d.toolInputs).length) lines.push(`tool inputs: ${JSON.stringify(d.toolInputs)}`);
  if (Object.keys(d.config).length) lines.push(`launch: ${JSON.stringify(d.config)}`);
  if (d.prompt) lines.push('prompt:', ...d.prompt.split('\n').map(line => `  ${line}`));
  return lines.join('\n');
}
function renderLoopPage(page: LoopListResult): string {
  if (page.items.length === 0) return 'no loops';
  const lines = page.items.map(loop => [loop.id, `v${loop.version}`, loopState(loop), loop.definition.schedule,
    runner(loop), `next ${loop.state.nextRunAt ?? 'none'}`, loop.definition.title].join('  '));
  if (page.nextCursor) lines.push(`next: --cursor ${page.nextCursor}`);
  return lines.join('\n');
}
function runLine(run: LoopRun): string {
  return [run.id, run.status + (run.skipReason ? `(${run.skipReason})` : ''), run.trigger, `attempt ${run.attempt}`, run.firedAt,
    run.durationMs !== null ? `${Math.round(run.durationMs / 1000)}s` : '', run.sessionId ? `session ${run.sessionId}` : '']
    .filter(part => part !== '').join('  ');
}
export function renderRun(run: LoopRun): string {
  const lines = [
    `run ${run.id} · ${run.status}${run.skipReason ? ` (${run.skipReason})` : ''}`,
    `loop: ${run.loopId} · ${run.action} · ${run.trigger} · attempt ${run.attempt} · acted as ${actor(run.actedAs)}`,
    `fired: ${run.firedAt} · started: ${run.startedAt ?? '—'} · ended: ${run.endedAt ?? '—'}${run.endedKind ? ` (${run.endedKind})` : ''}`,
  ];
  if (run.taskId) lines.push(`task: ${run.taskId}`);
  if (run.sessionId) lines.push(`session: ${run.sessionId}`, `transcript: tm8 session transcript ${run.sessionId}`);
  if (run.exitCode !== null) lines.push(`exit code: ${run.exitCode}`);
  if (run.error) lines.push(`error: ${run.error}`);
  if (run.usage) lines.push(`usage: ${run.usage.inputTokens ?? '?'} in / ${run.usage.outputTokens ?? '?'} out` +
    ` · cost ${run.usage.costUsd === null ? 'unknown' : `$${run.usage.costUsd} (as reported by the harness)`}`);
  if (run.outputTail) lines.push('output:', run.outputTail.replace(/\n$/, ''));
  return lines.join('\n');
}

// ── verbs ─────────────────────────────────────────────────────────────────
async function loopCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [...DEFINITION_OPTIONS, 'disabled', ...HEADER_TEXT_OPTIONS, 'mutation-id']);
  argumentsCount(cmd, 1);
  if (!cmd.options.has('schedule')) throw usage('--schedule is required', 'every <n>{m|h|d} or a 5-field cron; try `tm8 loop preview --schedule <expr>`');
  // Every local check runs before the write: a usage error after loops.create would leave an armed loop behind.
  const header = headerTextOptions(cmd);
  const enabled = !flag(cmd, 'disabled');
  const definition = { title: requireArg(cmd, 0, '<title>'), prompt: '', ...await definitionFlags(cmd, null) };
  const body = mutation(cmd);
  let loop: LoopView = await observedInvoke(client(cmd), 'loops.create', {
    params: { spaceId: requireSpace(cmd.ctx) }, body: { ...body, definition, enabled },
  });
  if (header) {
    try {
      await observedInvoke(client(cmd), 'entities.header.set', { params: { id: loop.id }, body: {
        ...body, clientMutationId: `${body.clientMutationId}:header`, ...header,
      } });
    } catch (error) {
      cmd.out.warn(`loop ${loop.id} was created (${enabled ? 'enabled' : 'disabled'}) but its header was not set: ` +
        `set it with \`tm8 entity header set ${loop.id}\`, or re-run this create with --mutation-id ${body.clientMutationId}; a fresh create makes a second loop`);
      throw error;
    }
    loop = await observedInvoke(client(cmd), 'loops.get', { params: { loopId: loop.id } });
  }
  cmd.out.data(loop, renderLoop); return EXIT_OK;
}
async function loopEdit(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [...EDIT_OPTIONS, 'expect-version', 'mutation-id']);
  argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  if (!EDIT_OPTIONS.some(option => cmd.options.has(option))) throw usage('Nothing to change: pass at least one create flag');
  // The flags are read against the stored action: --teammate on a tool loop is its persona.
  const found = await findLoop(cmd);
  const loop = found.view ?? await observedInvoke<LoopView>(client(cmd), 'loops.get', { params: { loopId: found.id } });
  const definition = await definitionFlags(cmd, loop);
  if (cmd.options.value('title') !== undefined) definition.title = cmd.options.value('title');
  cmd.out.data(await versioned(loop.id, () => observedInvoke<LoopView>(client(cmd), 'loops.update', { params: { loopId: loop.id }, body: {
    ...mutation(cmd), expectedVersion: version, definition,
  } })), renderLoop);
  return EXIT_OK;
}
async function loopShow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  cmd.out.data(await loadLoop(cmd), renderLoop); return EXIT_OK;
}
async function loopList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['enabled', 'disabled', 'action', 'words', 'limit', 'cursor']); argumentsCount(cmd, 0);
  const enabled = flag(cmd, 'enabled'), disabled = flag(cmd, 'disabled');
  if (enabled && disabled) throw usage('--enabled and --disabled cannot be combined');
  choice(cmd, 'action', LoopActionSchema.options);
  const query = pageQuery(cmd, ['action', 'words', 'cursor']);
  if (enabled) query.enabled = 'true';
  if (disabled) query.enabled = 'false';
  cmd.out.data(await observedInvoke<LoopListResult>(client(cmd), 'loops.list', { params: { spaceId: requireSpace(cmd.ctx) }, query }), renderLoopPage);
  return EXIT_OK;
}
async function loopControl(cmd: CommandContext, operation: 'loops.enable' | 'loops.disable' | 'loops.resume' | 'loops.pause'): Promise<ExitCode> {
  const pausing = operation === 'loops.pause';
  assertKnownOptions(cmd, pausing ? ['until', 'expect-version', 'mutation-id'] : ['expect-version', 'mutation-id']);
  argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  const until = pausing ? pauseUntil(cmd.options.value('until')) : undefined;
  const { id } = await findLoop(cmd);
  cmd.out.data(await versioned(id, () => observedInvoke<LoopView>(client(cmd), operation, { params: { loopId: id }, body: {
    ...mutation(cmd), expectedVersion: version, ...(until ? { until } : {}),
  } })), renderLoop);
  return EXIT_OK;
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/**
 * `--until` takes an ISO instant WITH its offset (`Z` or `+01:00`) or a
 * relative `+<n>{m|h|d}`. An instant without one would be read in this host's
 * zone, which is neither the loop's nor necessarily the caller's; an impossible
 * date (Feb 30) is refused rather than rolled into the next month. The server
 * bounds the result (after now, within 365 days); a relative span past that
 * bound is refused here, where its arithmetic would otherwise overflow.
 */
export function pauseUntil(raw: string | undefined, now: Date = new Date()): string {
  const hint = 'an ISO instant with its offset or +<n>{m|h|d}, e.g. --until +2h or --until 2026-11-02T09:00:00Z';
  if (raw === undefined) throw usage('--until is required', hint);
  const relative = /^\+(\d+)([mhd])$/.exec(raw);
  if (relative) {
    const ms = Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
    if (!(ms > 0) || ms > LOOP_PAUSE_MAX_DAYS * UNIT_MS.d) throw usage(`--until ${raw} must be after now and within ${LOOP_PAUSE_MAX_DAYS} days`);
    return new Date(now.getTime() + ms).toISOString();
  }
  const match = ISO_INSTANT.exec(raw);
  if (!match) throw usage(`--until must be ${hint.split(', e.g.')[0]}, got ${JSON.stringify(raw)}`, hint);
  const [year, month, day, hour, minute, second = 0, offsetHour = 0, offsetMinute = 0] =
    match.slice(1).map(part => (part === undefined ? undefined : Number(part))) as number[];
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth || hour! > 23 || minute! > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    throw usage(`--until ${raw} is not a real date and time`);
  }
  return new Date(Date.parse(raw)).toISOString();
}
async function loopRunNow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['force', 'mutation-id']); argumentsCount(cmd, 1);
  const force = flag(cmd, 'force');
  const { id } = await findLoop(cmd);
  const result = await observedInvoke<LoopRunResult>(client(cmd), 'loops.runNow', { params: { loopId: id }, body: {
    ...mutation(cmd), ...(force ? { force: true } : {}),
  } });
  cmd.out.data(result, value => renderRun(value.run)); return EXIT_OK;
}
async function loopRuns(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['status', 'limit', 'cursor']); argumentsCount(cmd, 1);
  choice(cmd, 'status', LoopRunStatusSchema.options);
  const query = pageQuery(cmd, ['status', 'cursor']);
  const { id } = await findLoop(cmd);
  cmd.out.data(await observedInvoke<LoopRunListResult>(client(cmd), 'loops.runs.list', { params: { loopId: id }, query }), page => {
    if (page.items.length === 0) return 'no runs';
    const lines = page.items.map(runLine);
    if (page.nextCursor) lines.push(`next: --cursor ${page.nextCursor}`);
    return lines.join('\n');
  });
  return EXIT_OK;
}
async function loopRunShow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  cmd.out.data(await observedInvoke<LoopRun>(client(cmd), 'loops.runs.get', { params: { runId: requireArg(cmd, 0, '<run-id>') } }), renderRun);
  return EXIT_OK;
}
async function loopStop(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']); argumentsCount(cmd, 1);
  const result = await observedInvoke<LoopRunResult>(client(cmd), 'loops.runs.stop', { params: { runId: requireArg(cmd, 0, '<run-id>') }, body: mutation(cmd) });
  cmd.out.data(result, value => renderRun(value.run)); return EXIT_OK;
}
async function loopPreview(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['schedule', 'timezone', 'count']); argumentsCount(cmd, 0);
  const schedule = cmd.options.value('schedule');
  if (schedule === undefined) throw usage('--schedule is required');
  const count = bounded(cmd, 'count', 1, LOOP_PREVIEW_MAX_COUNT);
  const preview = await observedInvoke<LoopSchedulePreview>(client(cmd), 'loops.schedule.preview', { params: { spaceId: requireSpace(cmd.ctx) }, body: {
    schedule, ...(cmd.options.value('timezone') !== undefined ? { timezone: cmd.options.value('timezone') } : {}), ...(count !== undefined ? { count } : {}),
  } });
  cmd.out.data(preview, value => value.valid ? [value.summary, ...value.next].join('\n') : `invalid: ${value.problem ?? 'schedule'}`);
  // An invalid expression is the answer, not a transport failure — but a script must see it.
  return preview.valid ? EXIT_OK : EXIT_USAGE;
}

export const LOOP_COMMANDS: CommandModule[] = [
  { path: ['loop', 'create'], run: loopCreate }, { path: ['loop', 'list'], run: loopList },
  { path: ['loop', 'show'], run: loopShow }, { path: ['loop', 'edit'], run: loopEdit },
  { path: ['loop', 'enable'], run: cmd => loopControl(cmd, 'loops.enable') },
  { path: ['loop', 'disable'], run: cmd => loopControl(cmd, 'loops.disable') },
  { path: ['loop', 'pause'], run: cmd => loopControl(cmd, 'loops.pause') },
  { path: ['loop', 'resume'], run: cmd => loopControl(cmd, 'loops.resume') },
  { path: ['loop', 'run-now'], run: loopRunNow }, { path: ['loop', 'runs'], run: loopRuns },
  { path: ['loop', 'run-show'], run: loopRunShow }, { path: ['loop', 'stop'], run: loopStop },
  { path: ['loop', 'preview'], run: loopPreview },
];

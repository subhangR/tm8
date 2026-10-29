// `tm8 loop` (design 01a182d4 §5): every verb is one loops.* operation. The
// CLI never computes schedule state and never writes loop fields through
// entities.*: the server owns nextRunAt, the preview and who a firing acts as.
import type { ActorSummary, LoopListResult, LoopRun, LoopRunListResult, LoopRunResult, LoopSchedulePreview, LoopView } from '@tm8/contract';
import { readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, HEADER_TEXT_OPTIONS, headerTextOptions, requireArg } from './entity.js';
import { parseCredentialSourceFlags } from './session.js';

interface Page<T> { items: T[]; nextCursor: string | null }
type Actor = ActorSummary | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXIT_NOT_FOUND = 5;
const client = (cmd: CommandContext) => clientFor({ ...cmd.ctx, fresh: true });
const mutation = (cmd: CommandContext) => ({ clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}) });

// Every flag `create` takes; `edit` takes all of them plus the clears.
const DEFINITION_OPTIONS = ['schedule', 'timezone', 'teammate', 'dispatch', 'tool', 'input', 'subject', 'prompt',
  'model', 'agent-tool', 'reasoning-effort', 'access-mode', 'mode', 'launch-project', 'workdir', 'base-ref',
  'memory', 'credential-source', 'interaction-profile', 'concurrency', 'max-runtime', 'retry', 'retry-delay'];

function argumentsCount(cmd: CommandContext, count: number): void {
  if (cmd.args.length !== count || cmd.passthrough.length) {
    throw new CliError(`tm8 ${cmd.path.join(' ')} expects ${count} argument${count === 1 ? '' : 's'}; see its help`, EXIT_USAGE);
  }
}
function expectedVersion(cmd: CommandContext): number {
  const version = cmd.options.integer('expect-version');
  if (version === undefined) throw new CliError('--expect-version is required', EXIT_USAGE, { hint: 'read it with `tm8 loop show <id>`' });
  if (!Number.isSafeInteger(version) || version < 1) throw new CliError('--expect-version must be a positive integer', EXIT_USAGE);
  return version;
}
function positive(cmd: CommandContext, option: string): number | undefined {
  const value = cmd.options.integer(option);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new CliError(`--${option} must be a non-negative integer`, EXIT_USAGE);
  return value;
}
function pageQuery(cmd: CommandContext, options: readonly string[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const option of options) {
    const value = cmd.options.value(option); if (value !== undefined) query[option] = value;
  }
  return query;
}
function oneOf<T extends string>(cmd: CommandContext, option: string, allowed: readonly T[]): T | undefined {
  const value = cmd.options.value(option);
  if (value !== undefined && !allowed.includes(value as T)) throw new CliError(`--${option} must be one of ${allowed.join('|')}`, EXIT_USAGE);
  return value as T | undefined;
}

/** A loop by id, or by exact title through loops.list (like `tm8 tool` resolves names). */
async function loadLoop(cmd: CommandContext): Promise<LoopView> {
  const ref = requireArg(cmd, 0, '<id|title>');
  let loopId = ref;
  if (!UUID.test(ref)) {
    let cursor: string | null = null;
    const found: LoopView[] = [];
    do {
      const page: LoopListResult = await observedInvoke(client(cmd), 'loops.list', {
        params: { spaceId: requireSpace(cmd.ctx) }, query: { words: ref, limit: '100', ...(cursor ? { cursor } : {}) },
      });
      found.push(...page.items.filter(item => item.definition.title === ref));
      cursor = page.nextCursor;
    } while (cursor);
    if (found.length === 0) throw new CliError(`Loop ${JSON.stringify(ref)} was not found in this Space`, EXIT_NOT_FOUND);
    if (found.length > 1) throw new CliError(`${found.length} loops are titled ${JSON.stringify(ref)}; use an id: ${found.map(l => l.id).join(', ')}`, EXIT_USAGE);
    loopId = found[0]!.id;
  }
  return observedInvoke(client(cmd), 'loops.get', { params: { loopId } });
}

/** An id passes through; a name resolves against the Space's team_member entities. */
async function resolveTeammate(cmd: CommandContext, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const data = await observedInvoke<{ page?: { items?: Array<{ id: string; title?: string | null }>; nextCursor?: string | null } }>(
      clientFor(cmd.ctx), 'collections.query', { body: { spaceId: requireSpace(cmd.ctx), kinds: ['team_member'], limit: 100, ...(cursor ? { cursor } : {}) } });
    for (const item of data.page?.items ?? []) if (item.title?.toLowerCase() === ref.toLowerCase()) matches.push(item.id);
    cursor = data.page?.nextCursor ?? undefined;
  } while (cursor);
  if (matches.length === 0) throw new CliError(`Teammate ${JSON.stringify(ref)} was not found in this Space`, EXIT_NOT_FOUND, { hint: 'list them with `tm8 teammate list`' });
  if (matches.length > 1) throw new CliError(`${matches.length} teammates are named ${JSON.stringify(ref)}; use an id: ${matches.join(', ')}`, EXIT_USAGE);
  return matches[0]!;
}
async function resolveTool(cmd: CommandContext, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  let cursor: string | null = null;
  do {
    const page: Page<{ id: string; definition: { name: string } }> = await observedInvoke(client(cmd), 'tools.list', {
      params: { spaceId: requireSpace(cmd.ctx) }, query: { words: ref, limit: '100', ...(cursor ? { cursor } : {}) },
    });
    const found = page.items.find(item => item.definition.name === ref);
    if (found) return found.id;
    cursor = page.nextCursor;
  } while (cursor);
  throw new CliError(`Tool ${ref} was not found in this Space`, EXIT_NOT_FOUND, { hint: 'list them with `tm8 tool list`' });
}

function toolInputs(raws: readonly string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    if (eq < 1) throw new CliError(`--input expects <name>=<value>, got ${JSON.stringify(raw)}`, EXIT_USAGE);
    // The server validates against the tool's declared inputs (§4.3); JSON
    // literals keep numbers and booleans typed, anything else stays a string.
    const value = raw.slice(eq + 1);
    let parsed: unknown = value;
    try { parsed = JSON.parse(value); } catch { /* a plain string */ }
    inputs[raw.slice(0, eq)] = parsed;
  }
  return inputs;
}

/**
 * The definition fields the flags name — only those, so `edit` sends a true
 * partial and the server keeps everything else. `create` (no `current`) fills
 * the required ones and lets the server default the rest.
 *
 * With `--tool`, `--teammate` names the persona the tool runs as (§2.1; the
 * server requires one when the tool reaches tm8). On `edit` of a tool loop,
 * `--teammate` alone changes that persona; with `--clear-tool` it makes the
 * loop a spawn loop.
 */
async function definitionFlags(cmd: CommandContext, current: LoopView | null): Promise<Record<string, unknown>> {
  const def: Record<string, unknown> = {};
  const o = cmd.options;
  if (o.bool('dispatch') && (o.has('teammate') || o.has('tool'))) throw new CliError('--dispatch takes neither --teammate nor --tool', EXIT_USAGE);
  if (!current && !o.has('teammate') && !o.bool('dispatch') && !o.has('tool')) {
    throw new CliError('Supply one of --teammate <id|name>, --dispatch or --tool <name|id>', EXIT_USAGE);
  }
  if (o.bool('clear-tool') && o.has('tool')) throw new CliError('--clear-tool and --tool cannot be combined', EXIT_USAGE);
  const keepsTool = current?.definition.action === 'tool' && !o.bool('clear-tool');
  if (o.has('tool')) { def.action = 'tool'; def.toolId = await resolveTool(cmd, o.value('tool')!); }
  else if (o.has('teammate') && !keepsTool) def.action = 'spawn';
  if (o.has('teammate')) def.teamMemberId = await resolveTeammate(cmd, o.value('teammate')!);
  // The Dispatcher picks the runner: a dispatch loop names no teammate and no tool (the door refuses one).
  if (o.bool('dispatch')) Object.assign(def, { action: 'dispatch', teamMemberId: null, toolId: null });
  const action = def.action ?? current?.definition.action;
  if (o.has('input')) {
    if (action !== undefined && action !== 'tool') throw new CliError('--input applies to --tool loops only', EXIT_USAGE);
    def.toolInputs = toolInputs(o.values('input'));
  }
  if (o.bool('clear-tool')) def.toolId = null;
  if (o.bool('clear-subject')) {
    if (o.has('subject')) throw new CliError('--clear-subject and --subject cannot be combined', EXIT_USAGE);
    def.subjectId = null;
  }
  const strings: Array<[string, string]> = [['schedule', 'schedule'], ['timezone', 'timezone'], ['subject', 'subjectId']];
  for (const [option, field] of strings) if (o.value(option) !== undefined) def[field] = o.value(option);
  if (o.value('prompt') !== undefined) def.prompt = await readTextSource(o.value('prompt')!);
  const concurrency = oneOf(cmd, 'concurrency', ['skip', 'queue'] as const);
  if (concurrency) def.concurrency = concurrency;
  const maxRuntime = positive(cmd, 'max-runtime');
  if (maxRuntime !== undefined) def.maxRuntimeSeconds = maxRuntime;
  const attempts = positive(cmd, 'retry'), delay = positive(cmd, 'retry-delay');
  // A partial retry policy: the server keeps (or defaults) the half not given.
  if (attempts !== undefined || delay !== undefined) {
    def.retry = { ...(attempts !== undefined ? { attempts } : {}), ...(delay !== undefined ? { delaySeconds: delay } : {}) };
  }
  const config: Record<string, unknown> = {};
  const configStrings: Array<[string, string]> = [['model', 'model'], ['agent-tool', 'agentTool'], ['launch-project', 'projectId'], ['interaction-profile', 'interactionProfileId']];
  for (const [option, field] of configStrings) if (o.value(option) !== undefined) config[field] = o.value(option);
  const effort = oneOf(cmd, 'reasoning-effort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const);
  if (effort) config.reasoningEffort = effort;
  const access = oneOf(cmd, 'access-mode', ['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess'] as const);
  if (access) config.accessMode = access;
  const mode = oneOf(cmd, 'mode', ['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator'] as const);
  if (mode) config.mode = mode;
  const workdir = oneOf(cmd, 'workdir', ['project', 'worktree', 'scratch'] as const);
  if (o.value('base-ref') !== undefined && !workdir) throw new CliError('--base-ref needs --workdir', EXIT_USAGE);
  if (workdir) config.workdir = { mode: workdir, baseRef: o.value('base-ref') ?? null };
  if (o.has('memory')) config.memoryIds = o.values('memory');
  if (o.has('credential-source')) {
    const parsed = parseCredentialSourceFlags(o.values('credential-source'));
    if (parsed.credentialSources || parsed.spaceCredentialIds) {
      throw new CliError('a loop takes one credential source for every provider: --credential-source member|space|node', EXIT_USAGE);
    }
    config.credentialSource = parsed.credentialSource;
  }
  if (Object.keys(config).length) {
    if (action === 'tool') throw new CliError('Launch flags (--model, --workdir, …) apply to spawn and dispatch loops', EXIT_USAGE);
    def.config = config;
  }
  return def;
}

// ── human rendering ───────────────────────────────────────────────────────
const actor = (a: Actor): string => a?.displayName ?? 'nobody';
const runner = (loop: LoopView): string => loop.definition.action === 'spawn' ? `spawn ${loop.definition.teamMemberId ?? '?'}`
  : loop.definition.action === 'tool'
    ? `tool ${loop.definition.toolId ?? '?'}${loop.definition.teamMemberId ? ` as ${loop.definition.teamMemberId}` : ''}` : 'dispatch';
function loopState(loop: LoopView): string {
  if (!loop.state.enabled) return 'disabled';
  if (loop.state.pausedUntil) return `paused until ${loop.state.pausedUntil}`;
  return loop.schedule.valid ? 'enabled' : `invalid: ${loop.schedule.problem ?? 'schedule'}`;
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
  if (loop.schedule.next.length) lines.push(`upcoming: ${loop.schedule.next.join(', ')}`);
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
  if (!cmd.options.has('schedule')) throw new CliError('--schedule is required', EXIT_USAGE, { hint: 'every <n>{m|h|d} or a 5-field cron; try `tm8 loop preview --schedule <expr>`' });
  const definition = { title: requireArg(cmd, 0, '<title>'), prompt: '', ...await definitionFlags(cmd, null) };
  const body = mutation(cmd);
  let loop: LoopView = await observedInvoke(client(cmd), 'loops.create', {
    params: { spaceId: requireSpace(cmd.ctx) }, body: { ...body, definition, enabled: !cmd.options.bool('disabled') },
  });
  const header = headerTextOptions(cmd);
  if (header) {
    await observedInvoke(client(cmd), 'entities.header.set', { params: { id: loop.id }, body: {
      ...body, clientMutationId: `${body.clientMutationId}:header`, ...header,
    } });
    loop = await observedInvoke(client(cmd), 'loops.get', { params: { loopId: loop.id } });
  }
  cmd.out.data(loop, renderLoop); return EXIT_OK;
}
async function loopEdit(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [...DEFINITION_OPTIONS, 'title', 'clear-subject', 'clear-tool', 'expect-version', 'mutation-id']);
  argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  if (![...DEFINITION_OPTIONS, 'title', 'clear-subject', 'clear-tool'].some(option => cmd.options.has(option))) {
    throw new CliError('Nothing to change: pass at least one create flag', EXIT_USAGE);
  }
  // The flags are read against the stored action: --teammate on a tool loop is its persona.
  const loop = await loadLoop(cmd);
  const definition = await definitionFlags(cmd, loop);
  if (cmd.options.value('title') !== undefined) definition.title = cmd.options.value('title');
  cmd.out.data(await observedInvoke<LoopView>(client(cmd), 'loops.update', { params: { loopId: loop.id }, body: {
    ...mutation(cmd), expectedVersion: version, definition,
  } }), renderLoop);
  return EXIT_OK;
}
async function loopShow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  cmd.out.data(await loadLoop(cmd), renderLoop); return EXIT_OK;
}
async function loopList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['enabled', 'disabled', 'action', 'words', 'limit', 'cursor']); argumentsCount(cmd, 0);
  if (cmd.options.bool('enabled') && cmd.options.bool('disabled')) throw new CliError('--enabled and --disabled cannot be combined', EXIT_USAGE);
  oneOf(cmd, 'action', ['spawn', 'dispatch', 'tool'] as const);
  const query = pageQuery(cmd, ['action', 'words', 'limit', 'cursor']);
  if (cmd.options.bool('enabled')) query.enabled = 'true';
  if (cmd.options.bool('disabled')) query.enabled = 'false';
  cmd.out.data(await observedInvoke<LoopListResult>(client(cmd), 'loops.list', { params: { spaceId: requireSpace(cmd.ctx) }, query }), renderLoopPage);
  return EXIT_OK;
}
async function loopControl(cmd: CommandContext, operation: 'loops.enable' | 'loops.disable' | 'loops.resume' | 'loops.pause'): Promise<ExitCode> {
  const pausing = operation === 'loops.pause';
  assertKnownOptions(cmd, pausing ? ['until', 'expect-version', 'mutation-id'] : ['expect-version', 'mutation-id']);
  argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  const until = pausing ? pauseUntil(cmd.options.value('until')) : undefined;
  const loop = await loadLoop(cmd);
  cmd.out.data(await observedInvoke<LoopView>(client(cmd), operation, { params: { loopId: loop.id }, body: {
    ...mutation(cmd), expectedVersion: version, ...(until ? { until } : {}),
  } }), renderLoop);
  return EXIT_OK;
}
/** `--until` takes an ISO instant or a relative `+<n>{m|h|d}`; the server bounds it (> now, <= 365d). */
export function pauseUntil(raw: string | undefined, now: Date = new Date()): string {
  if (raw === undefined) throw new CliError('--until is required', EXIT_USAGE, { hint: 'an ISO instant or +<n>{m|h|d}, e.g. --until +2h' });
  const relative = /^\+(\d+)([mhd])$/.exec(raw);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd'];
    return new Date(now.getTime() + Number(relative[1]) * unit).toISOString();
  }
  const at = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(at)) throw new CliError(`--until must be an ISO instant or +<n>{m|h|d}, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  return new Date(at).toISOString();
}
async function loopRunNow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['force', 'mutation-id']); argumentsCount(cmd, 1);
  const loop = await loadLoop(cmd);
  const result = await observedInvoke<LoopRunResult>(client(cmd), 'loops.runNow', { params: { loopId: loop.id }, body: {
    ...mutation(cmd), ...(cmd.options.bool('force') ? { force: true } : {}),
  } });
  cmd.out.data(result, value => renderRun(value.run)); return EXIT_OK;
}
async function loopRuns(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['status', 'limit', 'cursor']); argumentsCount(cmd, 1);
  oneOf(cmd, 'status', ['running', 'completed', 'failed', 'skipped', 'stopped', 'timed_out'] as const);
  const loop = await loadLoop(cmd);
  cmd.out.data(await observedInvoke<LoopRunListResult>(client(cmd), 'loops.runs.list', { params: { loopId: loop.id }, query: pageQuery(cmd, ['status', 'limit', 'cursor']) }), page => {
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
  if (schedule === undefined) throw new CliError('--schedule is required', EXIT_USAGE);
  const count = positive(cmd, 'count');
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

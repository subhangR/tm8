import { TOOL_DEFAULT_TIMEOUT_SECONDS, ToolDefinitionSchema, type ToolDefinition, type ToolRun, type ToolView } from '@tm8/contract';
import { readJsonSource, readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { isAgentContext } from '../credentials.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, headerTextOptions, requireArg } from './entity.js';
import { inputFlag, parseToolArgs, parseToolValue, refuseLiteralToolSecrets, renderToolHelp, type ToolHelp } from './tool-args.js';
import { readToolSecret } from './tool-secret.js';
import { attachToolRun } from './tool-terminal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const client = (cmd: CommandContext) => clientFor({ ...cmd.ctx, fresh: true });
const mutation = (cmd: CommandContext) => ({ clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}) });
const emit = (cmd: CommandContext, data: unknown): ExitCode => {
  cmd.out.data(data, value => JSON.stringify(value, null, 2)); return EXIT_OK;
};
function argumentsCount(cmd: CommandContext, min: number, max = min): void {
  if (cmd.args.length < min || cmd.args.length > max || (cmd.path[1] !== 'run' && cmd.passthrough.length)) {
    throw new CliError(`tm8 ${cmd.path.join(' ')} expects ${min === max ? min : `${min}–${max}`} arguments; see its help`, EXIT_USAGE);
  }
}
function expectedVersion(cmd: CommandContext, tool: ToolView, required = false): number {
  const version = cmd.options.integer('expect-version');
  if (required && version === undefined) throw new CliError('--expect-version is required', EXIT_USAGE);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new CliError('--expect-version must be a positive integer', EXIT_USAGE);
  return version ?? tool.version;
}
function pageQuery(cmd: CommandContext): Record<string, string> {
  const query: Record<string, string> = {};
  for (const option of ['limit', 'cursor', 'words']) {
    const value = cmd.options.value(option); if (value !== undefined) query[option] = value;
  }
  return query;
}
async function loadTool(cmd: CommandContext): Promise<ToolView> {
  const name = requireArg(cmd, 0, '<name|id>');
  let toolId = name;
  if (!UUID.test(name)) {
    let cursor: string | null = null;
    let found: ToolView | undefined;
    do {
      const page: { items: ToolView[]; nextCursor: string | null } = await observedInvoke(client(cmd), 'tools.list', {
        params: { spaceId: requireSpace(cmd.ctx) }, query: { words: name, limit: '100', ...(cursor ? { cursor } : {}) },
      });
      found = page.items.find(item => item.definition.name === name);
      cursor = page.nextCursor;
    } while (!found && cursor);
    if (!found) throw new CliError(`Tool ${name} was not found in this Space`, 5);
    toolId = found.id;
  }
  return observedInvoke(client(cmd), 'tools.get', { params: { toolId } });
}
async function fileSource(raw: string, option: string): Promise<string> {
  if (!raw.startsWith('@') || raw.length === 1) throw new CliError(`--${option} must use @file`, EXIT_USAGE);
  return readTextSource(raw);
}
async function definition(cmd: CommandContext, previous?: ToolDefinition): Promise<ToolDefinition> {
  let spec: Record<string, unknown> = {};
  const path = cmd.options.value('spec');
  if (path !== undefined) {
    if (!path.startsWith('@') || path.length === 1) throw new CliError('--spec must use @file', EXIT_USAGE);
    const value = await readJsonSource(path);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('--spec must contain a JSON object', EXIT_USAGE);
    spec = value as Record<string, unknown>;
    if (Object.keys(spec).some(key => !['inputs', 'help', 'tm8Access', 'timeoutSeconds'].includes(key))) {
      throw new CliError('--spec accepts inputs, help, tm8Access, and timeoutSeconds', EXIT_USAGE);
    }
  }
  const sourcePath = cmd.options.value('source');
  const parsed = ToolDefinitionSchema.safeParse({
    description: '', help: '', inputs: [], tm8Access: 'none', timeoutSeconds: TOOL_DEFAULT_TIMEOUT_SECONDS,
    ...previous, ...spec,
    name: previous?.name ?? requireArg(cmd, 0, '<name>'),
    runtime: cmd.options.value('runtime') ?? previous?.runtime,
    source: sourcePath !== undefined ? await fileSource(sourcePath, 'source') : previous?.source,
    ...(cmd.options.value('description') !== undefined ? { description: cmd.options.value('description') } : {}),
  });
  if (!parsed.success) throw new CliError(`Invalid tool definition: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, EXIT_USAGE);
  return parsed.data;
}
async function toolCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['runtime', 'source', 'spec', 'description', 'when-to-use', 'summary', 'keyword', 'mutation-id']);
  argumentsCount(cmd, 1);
  const body = mutation(cmd);
  let tool: ToolView = await observedInvoke(client(cmd), 'tools.create', {
    params: { spaceId: requireSpace(cmd.ctx) }, body: { ...body, definition: await definition(cmd) },
  });
  // Selection headers are the universal entity surface, separate from the
  // strict tool-definition DTO. A stable mutation id makes retries safe.
  const header = headerTextOptions(cmd);
  if (header) {
    await observedInvoke(client(cmd), 'entities.header.set', { params: { id: tool.id }, body: {
      ...body, clientMutationId: `${body.clientMutationId}:header`, ...header,
    } });
    tool = await observedInvoke(client(cmd), 'tools.get', { params: { toolId: tool.id } });
  }
  return emit(cmd, tool);
}
async function toolEdit(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['runtime', 'source', 'spec', 'description', 'expect-version', 'mutation-id']);
  argumentsCount(cmd, 1);
  const tool = await loadTool(cmd);
  return emit(cmd, await observedInvoke(client(cmd), 'tools.update', { params: { toolId: tool.id }, body: {
    ...mutation(cmd), expectedVersion: expectedVersion(cmd, tool, true), definition: await definition(cmd, tool.definition),
  } }));
}
async function toolShow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['source']); argumentsCount(cmd, 1);
  const tool = await loadTool(cmd);
  if (cmd.options.bool('source')) cmd.out.data(tool.definition.source, source => source);
  else emit(cmd, tool);
  return EXIT_OK;
}
async function toolList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['words', 'limit', 'cursor']); argumentsCount(cmd, 0);
  return emit(cmd, await observedInvoke(client(cmd), 'tools.list', { params: { spaceId: requireSpace(cmd.ctx) }, query: pageQuery(cmd) }));
}
async function helpFor(cmd: CommandContext, tool: ToolView): Promise<ToolHelp> {
  const help = await observedInvoke<ToolHelp>(client(cmd), 'tools.help', { params: { toolId: tool.id } });
  if (help.version !== tool.version) throw new CliError('Tool changed while loading its help; retry to load the current definition', 6);
  return help;
}
async function toolHelp(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  const help = await helpFor(cmd, await loadTool(cmd));
  cmd.out.data(help, renderToolHelp); return EXIT_OK;
}
async function toolConfig(cmd: CommandContext, unset: boolean): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']); argumentsCount(cmd, unset ? 2 : 3);
  const tool = await loadTool(cmd), inputName = requireArg(cmd, 1, '<input>');
  const input = tool.definition.inputs.find(value => value.name === inputName);
  if (!input) throw new CliError('Unknown configured input', EXIT_USAGE);
  if (input.type === 'secret') throw new CliError('Use `tm8 tool secret set|unset` for secret inputs', EXIT_USAGE);
  return emit(cmd, await observedInvoke(client(cmd), unset ? 'tools.config.unset' : 'tools.config.set', { params: { toolId: tool.id }, body: {
    ...mutation(cmd), expectedVersion: expectedVersion(cmd, tool), inputName,
    ...(!unset ? { value: parseToolValue(input, requireArg(cmd, 2, '<value>')) } : {}),
  } }));
}
async function toolSecret(cmd: CommandContext, unset: boolean): Promise<ExitCode> {
  assertKnownOptions(cmd, unset ? ['expect-version', 'mutation-id'] : ['value-stdin', 'credential-id', 'label', 'expect-version', 'mutation-id']);
  argumentsCount(cmd, 2);
  if (isAgentContext()) throw new CliError('Tool secret bindings require a human session', 4);
  if (cmd.options.has('value-stdin') && cmd.options.has('credential-id')) throw new CliError('Supply exactly one of --value-stdin or --credential-id', EXIT_USAGE);
  const tool = await loadTool(cmd), inputName = requireArg(cmd, 1, '<input>');
  if (!tool.definition.inputs.some(input => input.name === inputName && input.type === 'secret')) throw new CliError('Input is not a declared secret', EXIT_USAGE);
  const credentialId = cmd.options.value('credential-id');
  return emit(cmd, await observedInvoke(client(cmd), unset ? 'tools.secrets.unbind' : 'tools.secrets.bind', { params: { toolId: tool.id }, body: {
    ...mutation(cmd), expectedVersion: expectedVersion(cmd, tool), inputName,
    ...(!unset ? credentialId !== undefined ? { credentialId } : { value: await readToolSecret(cmd.out, inputName) } : {}),
    ...(cmd.options.value('label') !== undefined ? { label: cmd.options.value('label') } : {}),
  } }));
}
async function toolRun(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['detach', 'keep-open', 'close', 'cwd', 'mutation-id']); argumentsCount(cmd, 1);
  if (cmd.options.has('close') && cmd.options.has('keep-open')) throw new CliError('--close and --keep-open cannot be combined', EXIT_USAGE);
  const tool = await loadTool(cmd), help = await helpFor(cmd, tool);
  refuseLiteralToolSecrets(help.inputs, cmd.passthrough);
  if (cmd.passthrough.includes('--help') || cmd.passthrough.includes('-h')) {
    cmd.out.data(help, renderToolHelp); return EXIT_OK;
  }
  if (!cmd.options.bool('detach') && cmd.out.format !== 'human') throw new CliError('Attached tool output uses --format human; use --detach for JSON or JSONL', EXIT_USAGE);
  const args = parseToolArgs(help.inputs, cmd.passthrough);
  for (const input of help.inputs) {
    if (input.type !== 'secret' || !input.required || input.configured || Object.hasOwn(args.secrets, input.name)) continue;
    if (!process.stdin.isTTY) throw new CliError(`Missing required secret ${input.name}; use --${inputFlag(input)}-from-env <VAR>`, EXIT_USAGE);
    args.secrets[input.name] = await readToolSecret(cmd.out, input.name);
  }
  const changed = tool.sourceChangedSinceViewerLastRun;
  if (changed) cmd.out.warn(`source changed since your last run by ${changed.byActor?.displayName ?? 'unknown'} at ${changed.at}`);
  const keepOpen = cmd.options.bool('keep-open');
  const result = await observedInvoke<{ sessionId: string }>(client(cmd), 'tools.run', { params: { toolId: tool.id }, body: {
    ...mutation(cmd), expectedVersion: tool.version, ...args, keepOpen,
    ...(cmd.options.value('cwd') !== undefined ? { cwd: cmd.options.value('cwd') } : {}),
  } });
  if (cmd.options.bool('detach')) { cmd.out.data(result, value => value.sessionId); return EXIT_OK; }
  // Emit the id before attaching: a timed-out caller can inspect this run later.
  cmd.out.bytes(Buffer.from(`${result.sessionId}\n`));
  const code = await attachToolRun(cmd, result.sessionId, keepOpen);
  if (keepOpen) cmd.out.warn(`shell left open; close with: tm8 session terminate ${result.sessionId}`);
  return code;
}
async function toolRuns(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['limit', 'cursor']); argumentsCount(cmd, 1);
  const tool = await loadTool(cmd);
  return emit(cmd, await observedInvoke(client(cmd), 'tools.runs.list', { params: { toolId: tool.id }, query: pageQuery(cmd) }));
}
async function toolRunShow(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['output']); argumentsCount(cmd, 1);
  const result = await observedInvoke<ToolRun>(client(cmd), 'tools.runs.get', { params: { sessionId: requireArg(cmd, 0, '<session-id>') } });
  cmd.out.data(result, value => cmd.options.bool('output') ? value.outputTail : JSON.stringify(value, null, 2)); return EXIT_OK;
}
export const TOOL_COMMANDS: CommandModule[] = [
  { path: ['tool', 'create'], run: toolCreate }, { path: ['tool', 'edit'], run: toolEdit },
  { path: ['tool', 'show'], run: toolShow }, { path: ['tool', 'list'], run: toolList }, { path: ['tool', 'help'], run: toolHelp },
  { path: ['tool', 'config', 'set'], run: cmd => toolConfig(cmd, false) }, { path: ['tool', 'config', 'unset'], run: cmd => toolConfig(cmd, true) },
  { path: ['tool', 'secret', 'set'], run: cmd => toolSecret(cmd, false) }, { path: ['tool', 'secret', 'unset'], run: cmd => toolSecret(cmd, true) },
  { path: ['tool', 'run'], run: toolRun }, { path: ['tool', 'runs'], run: toolRuns }, { path: ['tool', 'run-show'], run: toolRunShow },
];

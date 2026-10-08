import { createHash } from 'node:crypto';
import { MapsOpenInputSchema, MapsPlaceInputSchema, MapsMoveInputSchema, MapsRemoveInputSchema,
  MapsPaintInputSchema, MapsUndoInputSchema, MapsRevertInputSchema, MapsActivityInputSchema,
  MapsNavigationSaveInputSchema, type OperationName } from '@tm8/contract';
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId, refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

const schemas = { open: MapsOpenInputSchema, place: MapsPlaceInputSchema, move: MapsMoveInputSchema,
  remove: MapsRemoveInputSchema, paint: MapsPaintInputSchema, undo: MapsUndoInputSchema,
  revert: MapsRevertInputSchema, 'activity.append': MapsActivityInputSchema, 'navigation.save': MapsNavigationSaveInputSchema };
function arg(cmd: CommandContext, index: number, name: string): string {
  const value = cmd.args[index];
  if (!value) throw new CliError(`${name} is required`, EXIT_USAGE);
  return value;
}
function point(cmd: CommandContext): { x: number; z: number } {
  const parts = cmd.options.value('at')?.split(',').map(Number);
  if (!parts || parts.length !== 2 || !parts.every(Number.isFinite)) throw new CliError('--at x,z is required', EXIT_USAGE);
  return { x: parts[0]!, z: parts[1]! };
}
async function invoke(cmd: CommandContext, op: OperationName, params: Record<string, string>, body?: unknown, query?: Record<string, string>): Promise<ExitCode> {
  const data = await observedInvoke(clientFor(cmd.ctx), op, { params, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) });
  cmd.out.data(data, dto => JSON.stringify(dto, null, 2)); return EXIT_OK;
}
function command(op: keyof typeof schemas): CommandModule['run'] {
  return async cmd => {
    const spaceOp = op === 'open' || op === 'navigation.save';
    const params: Record<string, string> = spaceOp ? { spaceId: requireSpace(cmd.ctx) } : { mapId: arg(cmd, 0, 'map id') };
    const cmid = resolveMutationId(cmd.options.value('mutation-id'));
    const raw = cmd.options.value('input');
    let body: Record<string, unknown>;
    if (raw !== undefined) {
      const input = await readJsonSource(raw);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('--input must be a JSON object', EXIT_USAGE);
      body = input as Record<string, unknown>;
    } else if (op === 'open') {
      const story = cmd.options.value('story');
      body = { type: cmd.options.value('type'), scope: { kind: story ? 'story' : 'space', id: story ?? params.spaceId } };
    } else if (op === 'place') {
      // Deterministic item id keeps CLI retries of the same mutation identical.
      const digest = createHash('sha256').update(`${params.mapId}:${cmid}`).digest('hex');
      const itemId = cmd.options.value('item') ?? `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
      body = { itemId, entityId: arg(cmd, 1, 'real entity id'), kind: 'ref', ...point(cmd), expectedVersion: Number(cmd.options.value('expect-version') ?? 0) };
    } else if (op === 'move' || op === 'remove') {
      params.itemId = arg(cmd, 1, 'item id');
      body = { ...(op === 'move' ? point(cmd) : {}), expectedVersion: Number(cmd.options.value('expect-version')) };
    } else throw new CliError('--input <json|@file|-> is required', EXIT_USAGE);
    if (op === 'move' || op === 'remove') params.itemId = arg(cmd, 1, 'item id');
    const version = cmd.options.value('expect-version'), revision = cmd.options.value('expect-revision');
    if (version !== undefined && ['place','move','remove','paint'].includes(op)) body.expectedVersion = Number(version);
    if (revision !== undefined && op === 'navigation.save') body.expectedRevision = Number(revision);
    body = { ...body, clientMutationId: cmid, ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}) };
    const parsed = schemas[op].safeParse(body);
    if (!parsed.success) throw new CliError(parsed.error.issues[0]?.message ?? 'invalid map input', EXIT_USAGE);
    return invoke(cmd, `maps.${op}` as OperationName, params, parsed.data);
  };
}
function read(op: 'context' | 'activity.list' | 'navigation.get'): CommandModule['run'] {
  return async cmd => {
    refuseMutationId(`map ${op}`, cmd.options.value('mutation-id'));
    const params: Record<string,string> = op === 'navigation.get' ? { spaceId: requireSpace(cmd.ctx) } : { mapId: arg(cmd, 0, 'map id') };
    const query: Record<string, string> = {};
    for (const flag of op === 'context' ? ['limit','cursor'] : op === 'activity.list' ? ['limit','since'] : []) {
      const value = cmd.options.value(flag); if (value !== undefined) query[flag] = value;
    }
    return invoke(cmd, `maps.${op}`, params, undefined, query);
  };
}
export const MAP_COMMANDS: CommandModule[] = [
  { path: ['map','open'], run: command('open') }, { path: ['map','context'], run: read('context') },
  { path: ['map','place'], run: command('place') }, { path: ['map','move'], run: command('move') },
  { path: ['map','remove'], run: command('remove') }, { path: ['map','paint'], run: command('paint') },
  { path: ['map','undo'], run: command('undo') }, { path: ['map','revert'], run: command('revert') },
  { path: ['map','activity','append'], run: command('activity.append') }, { path: ['map','activity','list'], run: read('activity.list') },
  { path: ['map','navigation','get'], run: read('navigation.get') }, { path: ['map','navigation','save'], run: command('navigation.save') },
];

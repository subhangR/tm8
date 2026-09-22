import { readTextSource } from '../args.js';
import { assertKnownOptions } from './entity.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

const render = (data: unknown) => JSON.stringify(data, null, 2);
async function scan(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['root', 'all', 'mutation-id']);
  const root = cmd.options.value('root');
  if (root && cmd.options.has('all')) throw new CliError('--root and --all are mutually exclusive', EXIT_USAGE);
  const body = { ...(root ? { root } : {}), all: cmd.options.has('all'), clientMutationId: resolveMutationId(cmd.options.value('mutation-id')), ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}) };
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx), 'skills.scan', { params: { spaceId: requireSpace(cmd.ctx) }, body }), render);
  return EXIT_OK;
}
async function list(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['root', 'limit', 'cursor']);
  const query: Record<string, string> = {};
  for (const flag of ['root', 'limit', 'cursor']) { const value = cmd.options.value(flag); if (value !== undefined) query[flag] = value; }
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx), 'skills.list', { params: { spaceId: requireSpace(cmd.ctx) }, query }), render);
  return EXIT_OK;
}
async function show(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  const id = cmd.args[0];
  if (!id) throw new CliError('tm8 skill show requires <skill-id>', EXIT_USAGE);
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx), 'skills.show', { params: { id } }), render);
  return EXIT_OK;
}
async function mutate(cmd: CommandContext): Promise<ExitCode> {
  const verb = cmd.path[1];
  const equipment = verb === 'equip' || verb === 'unequip';
  assertKnownOptions(cmd, equipment ? ['teammate', 'mutation-id'] : ['provider', 'level', 'root', 'name', 'description', 'body', 'expected-version', 'content-hash', 'mutation-id']);
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')), ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}) };
  const id = cmd.args[0];
  if (verb !== 'create' && !id) throw new CliError(`tm8 skill ${verb} requires <skill-id>`, EXIT_USAGE);
  if (equipment) {
    body.teamMemberId = cmd.options.value('teammate');
    if (!body.teamMemberId) throw new CliError('--teammate is required', EXIT_USAGE);
  } else {
    for (const field of ['provider', 'level', 'root', 'name', 'description', 'body']) {
      const value = cmd.options.value(field);
      if (value !== undefined) body[field] = field === 'body' || field === 'description' ? await readTextSource(value) : value;
    }
    if (verb === 'create' && (!body.root || !body.name)) throw new CliError('--root and --name are required', EXIT_USAGE);
    if (verb === 'edit') {
      const version = Number(cmd.options.value('expected-version'));
      if (!Number.isInteger(version) || version < 1) throw new CliError('--expected-version must be a positive integer', EXIT_USAGE);
      body.expectedVersion = version;
      const hash = cmd.options.value('content-hash');
      if (hash) body.contentHash = hash;
    }
  }
  const operation = `skills.${verb}` as 'skills.equip' | 'skills.unequip' | 'skills.create' | 'skills.edit';
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx), operation, { params: verb === 'create' ? { spaceId: requireSpace(cmd.ctx) } : { id: id! }, body }), render);
  return EXIT_OK;
}
export const SKILL_COMMANDS: CommandModule[] = [
  ...['equip', 'unequip', 'create', 'edit'].map(verb => ({ path: ['skill', verb], run: mutate })),
  { path: ['skill', 'scan'], run: scan },
  { path: ['skill', 'list'], run: list },
  { path: ['skill', 'show'], run: show },
];

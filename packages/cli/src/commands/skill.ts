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
export const SKILL_COMMANDS: CommandModule[] = [
  { path: ['skill', 'scan'], run: scan },
  { path: ['skill', 'list'], run: list },
  { path: ['skill', 'show'], run: show },
];

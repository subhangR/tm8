import type { OperationName } from '@tm8/contract';
import type { InvokeOptions } from '../client.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { readTextSource } from '../args.js';
import type { CommandContext, CommandModule } from '../run.js';

function argument(cmd: CommandContext, index: number): string {
  const value = cmd.args[index]; if (!value) throw new CliError('Missing workspace command argument', EXIT_USAGE); return value;
}
async function body(cmd: CommandContext): Promise<Record<string, unknown>> {
  try { const value: unknown = JSON.parse(await readTextSource(cmd.options.value('body') ?? '{}')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new CliError('--body must be JSON, @file, or - for stdin', EXIT_USAGE); }
}
function command(path: string[], operation: OperationName, options: (cmd: CommandContext) => InvokeOptions | Promise<InvokeOptions> = () => ({})): CommandModule {
  return { path: ['workspace', ...path], async run(cmd): Promise<ExitCode> {
    const data = await observedInvoke(clientFor(cmd.ctx), operation, await options(cmd));
    cmd.out.data(data, value => JSON.stringify(value, null, 2)); return EXIT_OK;
  } };
}
export const WORKSPACE_COMMANDS: CommandModule[] = [
  command(['invite', 'create'], 'workspaces.invites.create', async cmd => ({ body: await body(cmd) })),
  command(['invite', 'list'], 'workspaces.invites.list'),
  command(['invite', 'revoke'], 'workspaces.invites.revoke', cmd => ({ params: { invitationId: argument(cmd, 0) }, body: {} })),
  command(['capabilities'], 'deployment.capabilities'),
  command(['status'], 'workspaces.me'),
  command(['ensure'], 'workspaces.ensure', () => ({ body: {} })),
  command(['project', 'create'], 'workspaces.projects.create', async cmd => ({ body: await body(cmd) })),
  command(['checkout'], 'workspaces.projects.checkout', cmd => ({ params: { projectId: argument(cmd, 0) }, body: {} })),
  command(['files'], 'workspaces.files.list', cmd => ({ params: { projectId: argument(cmd, 0) }, query: { path: cmd.args[1] ?? '' } })),
  command(['read'], 'workspaces.files.read', cmd => ({ params: { projectId: argument(cmd, 0) }, query: { path: argument(cmd, 1) } })),
  command(['write'], 'workspaces.files.write', async cmd => ({ params: { projectId: argument(cmd, 0) }, body: await body(cmd) })),
  command(['git'], 'workspaces.git', cmd => ({ body: { projectId: argument(cmd, 0), action: argument(cmd, 1), remote: cmd.options.value('remote') ?? 'tm8', ...(cmd.options.value('branch') ? { branch: cmd.options.value('branch') } : {}) } })),
  command(['commit'], 'workspaces.git.commit', cmd => ({ params: { projectId: argument(cmd, 0) }, body: { message: cmd.options.value('message') } })),
  command(['connect'], 'workspaces.git.connect', cmd => ({ params: { projectId: argument(cmd, 0) }, body: { url: argument(cmd, 1) } })),
  command(['github', 'credential'], 'workspaces.github.credential', async cmd => ({ body: await body(cmd) })),
  command(['github', 'create'], 'workspaces.github.create', async cmd => ({ params: { projectId: argument(cmd, 0) }, body: await body(cmd) })),
  command(['terminal'], 'workspaces.terminal.start', cmd => ({ body: { ...(cmd.options.value('project') ? { projectId: cmd.options.value('project') } : {}), ...(cmd.options.value('command') ? { command: cmd.options.value('command') } : {}) } })),
];

import {
  CONTRACT_VERSION,
  ServerConnectionBaseUrlSchema,
  type ServerConnection,
} from '@tm8/contract';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { ProtocolError, TransportError } from '../errors.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

function oneName(cmd: CommandContext, command: string): string {
  const [name, ...extra] = cmd.args;
  if (!name || extra.length > 0) {
    throw new CliError(`tm8 ${command} requires exactly one <name>`, EXIT_USAGE);
  }
  return name;
}

function render(connection: ServerConnection): string {
  return [
    `${connection.name}: ${connection.baseUrl}`,
    ...(connection.username ? [`username: ${connection.username}`] : []),
  ].join('\n');
}

async function requireHealthyTm8Server(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL('/health', baseUrl), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new TransportError(
      `GET /health failed for ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) as unknown : undefined;
  } catch {
    body = undefined;
  }
  const health = body as Record<string, unknown> | undefined;
  if (!response.ok || health?.ok !== true || health.server !== 'tm8-server') {
    throw new ProtocolError(
      `${baseUrl} did not answer as a healthy tm8 Server`,
      response.status,
      body ?? text,
    );
  }
  if (health.contractVersion !== CONTRACT_VERSION) {
    throw new ProtocolError(
      `${baseUrl} uses contract ${String(health.contractVersion)}; this CLI requires ${CONTRACT_VERSION}`,
      response.status,
      body,
    );
  }
}

async function serverList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('server list', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) throw new CliError('tm8 server list takes no arguments', EXIT_USAGE);
  const data = await observedInvoke<ServerConnection[]>(clientFor(cmd.ctx), 'serverConnections.list');
  cmd.out.data(data, (connections) => connections.length === 0
    ? 'No named Servers.'
    : connections.map((connection) => render(connection)).join('\n\n'));
  return EXIT_OK;
}

async function serverGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('server get', cmd.options.value('mutation-id'));
  const name = oneName(cmd, 'server get');
  const data = await observedInvoke<ServerConnection>(clientFor(cmd.ctx), 'serverConnections.get', {
    params: { name },
  });
  cmd.out.data(data, render);
  return EXIT_OK;
}

async function serverAdd(cmd: CommandContext): Promise<ExitCode> {
  const name = oneName(cmd, 'server add');
  const rawUrl = cmd.options.require('url');
  const parsed = ServerConnectionBaseUrlSchema.safeParse(rawUrl);
  if (!parsed.success) {
    throw new CliError(`--url is not a valid tm8 Server base URL: ${parsed.error.issues[0]?.message ?? 'invalid URL'}`, EXIT_USAGE);
  }
  const baseUrl = new URL(parsed.data).origin;
  await requireHealthyTm8Server(baseUrl, cmd.ctx.timeoutMs);

  const body: Record<string, unknown> = {
    name,
    baseUrl,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const username = cmd.options.value('username');
  if (username !== undefined) body.username = username;
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<ServerConnection>(clientFor(cmd.ctx), 'serverConnections.create', { body });
  cmd.out.data(data, render);
  return EXIT_OK;
}

async function serverRemove(cmd: CommandContext): Promise<ExitCode> {
  const name = oneName(cmd, 'server remove');
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 server remove deletes local routing configuration; pass --yes to confirm', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  const data = await observedInvoke<ServerConnection>(clientFor(cmd.ctx), 'serverConnections.delete', {
    params: { name },
    body,
  });
  cmd.out.data(data, (connection) => `Removed ${connection.name} (${connection.baseUrl})`);
  return EXIT_OK;
}

export const SERVER_COMMANDS: CommandModule[] = [
  { path: ['server', 'list'], run: serverList },
  { path: ['server', 'add'], run: serverAdd },
  { path: ['server', 'get'], run: serverGet },
  { path: ['server', 'remove'], run: serverRemove },
];

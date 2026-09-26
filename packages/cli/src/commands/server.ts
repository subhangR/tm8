import {
  CONTRACT_VERSION,
  ServerConnectionBaseUrlSchema,
  type ServerConnection,
  type ServerView,
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

function render(connection: Pick<ServerConnection, 'name' | 'baseUrl' | 'username'>): string {
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

  // W8 (991): a server is an entity in a Space; 044's table is read-only.
  // `servers.add` takes no actor: it is human-only.
  const body: Record<string, unknown> = {
    name,
    baseUrl,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  // --space is a global option; only an explicit flag picks the home Space
  // (a configured default does not), else the server takes the caller's first.
  if (cmd.ctx.space?.source === 'flag') body.spaceId = cmd.ctx.space.value;
  const username = cmd.options.value('username');
  if (username !== undefined) body.username = username;

  const data = await observedInvoke<ServerView>(clientFor(cmd.ctx), 'servers.add', { body });
  cmd.out.data(data, render);
  return EXIT_OK;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function serverRemove(cmd: CommandContext): Promise<ExitCode> {
  const target = oneName(cmd, 'server remove');
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 server remove removes the server for every Member of its Space; pass --yes to confirm', EXIT_USAGE);
  }
  const client = clientFor(cmd.ctx);
  // A name resolves through the directory (ambiguous names refuse there).
  const serverId = UUID.test(target)
    ? target
    : (await observedInvoke<ServerConnection>(client, 'serverConnections.get', { params: { name: target } })).id;
  const data = await observedInvoke<ServerView>(client, 'servers.remove', {
    params: { serverId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (server) => `Removed ${server.name} (${server.baseUrl})`);
  return EXIT_OK;
}

export const SERVER_COMMANDS: CommandModule[] = [
  { path: ['server', 'list'], run: serverList },
  { path: ['server', 'add'], run: serverAdd },
  { path: ['server', 'get'], run: serverGet },
  { path: ['server', 'remove'], run: serverRemove },
];

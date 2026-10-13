import {
  ServerConnectionBaseUrlSchema,
  type ServerConnection,
  type ServerProbeView,
  type ServerView,
} from '@tm8/contract';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
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

/** Words for a probe result: what the NODE saw when it tried to reach the server. */
function renderReach(probe: ServerProbeView): string {
  if (probe.outcome === 'response') {
    return probe.reason === 'not_tm8'
      ? 'reachable from this node, but it did not answer as a tm8 Server (/health)'
      : 'reachable from this node';
  }
  const why = probe.reason ? ` (${probe.reason})` : '';
  return `${probe.outcome} from this node${why}`;
}

/** A next step for a probe that did not get through, or undefined. */
function reachHint(probe: ServerProbeView): string | undefined {
  if (probe.reason === 'non_public_address') {
    return 'the node only reaches public HTTPS addresses by default; for a LAN or Tailscale peer its operator sets TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1 (docs/ops/REMOTE-SPACE-LINKS.md)';
  }
  if (probe.reason === 'invalid_url') return 'space links need an https:// base URL';
  if (probe.reason === 'tls') return 'the server\'s TLS certificate was refused: it needs a certificate the node trusts';
  if (probe.outcome === 'offline') return 'check the server is up and that this node can route to it, then run `tm8 server probe <name>`';
  return undefined;
}

async function probeServer(cmd: CommandContext, serverId: string): Promise<ServerProbeView> {
  return observedInvoke<ServerProbeView>(clientFor(cmd.ctx), 'servers.probe', {
    params: { serverId },
    body: { clientMutationId: resolveMutationId(undefined) },
  });
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

  // W8 (261): a server is an entity in a Space; 044's table is read-only.
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
  // Reachability is checked BY THE NODE (servers.probe): a check from this
  // machine said nothing about whether the node, which makes every link call,
  // can reach it. A failed check leaves the server added and says why.
  const probe = await probeServer(cmd, data.id);
  const hint = reachHint(probe);
  cmd.out.data({ ...probe.server, probe: { outcome: probe.outcome, ...(probe.reason ? { reason: probe.reason } : {}) } },
    (server) => [render(server), `check: ${renderReach(probe)}`, ...(hint ? [`hint: ${hint}`] : [])].join('\n'));
  return EXIT_OK;
}

async function serverIdFor(cmd: CommandContext, target: string): Promise<string> {
  // A name resolves through the directory (ambiguous names refuse there).
  return UUID.test(target)
    ? target
    : (await observedInvoke<ServerConnection>(clientFor(cmd.ctx), 'serverConnections.get', { params: { name: target } })).id;
}

async function serverProbe(cmd: CommandContext): Promise<ExitCode> {
  const target = oneName(cmd, 'server probe');
  const probe = await probeServer(cmd, await serverIdFor(cmd, target));
  const hint = reachHint(probe);
  cmd.out.data(probe, (p) => [`${p.server.name}: ${p.server.baseUrl}`, `check: ${renderReach(p)}`,
    ...(hint ? [`hint: ${hint}`] : [])].join('\n'));
  return EXIT_OK;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function serverRemove(cmd: CommandContext): Promise<ExitCode> {
  const target = oneName(cmd, 'server remove');
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 server remove removes the server for every Member of its Space; pass --yes to confirm', EXIT_USAGE);
  }
  const serverId = await serverIdFor(cmd, target);
  const data = await observedInvoke<ServerView>(clientFor(cmd.ctx), 'servers.remove', {
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
  { path: ['server', 'probe'], run: serverProbe },
];

/**
 * `tm8 user …` — the control plane's operator surface.
 *
 * WHY THIS IS NOT `tm8 auth signup`. Signup creates an ACCOUNT. It does not
 * create the person's Space, so the account it makes logs in and is told the
 * node has no spaces — which is the state `ramu` has been in on the production
 * node since that account was made. `user create` provisions the whole user:
 * account, their own Space, and the record of the home their agents run in.
 * `auth signup` still works and now runs through the same door, so the two
 * cannot drift into two different notions of what a user is.
 *
 * `user grant` / `user revoke` replace the single `--node-admin` flag, which
 * gated eighteen RPCs at once — everything from "register a working directory"
 * to "reset any account's password". That bundling is why seven of the eight
 * accounts on this node hold it.
 */
import type { UserCapabilityResult, UsersCreateResult, UsersListResult } from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

function requireOnePositional(cmd: CommandContext, usage: string): string {
  const value = cmd.args[0];
  if (cmd.args.length !== 1 || !value) throw new CliError(usage, EXIT_USAGE);
  return value;
}

/** The capabilities the server will accept; named here so a typo fails locally. */
const CAPABILITIES = [
  'users.provision', 'users.credentials', 'users.suspend', 'users.delete',
  'projects.register', 'projects.register.any', 'connections.manage',
  'node.maintain', 'capabilities.grant',
] as const;

function requirePassword(cmd: CommandContext, usage: string): string {
  const password = cmd.options.value('password');
  if (!password) throw new CliError(usage, EXIT_USAGE);
  return password;
}

async function userCreate(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('user create', cmd.options.value('mutation-id'));
  const usage =
    'usage: tm8 user create <username> --password <password> [--display-name <name>] '
    + '[--email <email>] [--request-key <key>]';
  const username = requireOnePositional(cmd, usage);
  const body: Record<string, unknown> = {
    username,
    password: requirePassword(cmd, usage),
  };
  const displayName = cmd.options.value('display-name');
  if (displayName !== undefined) body.displayName = displayName;
  const email = cmd.options.value('email');
  if (email !== undefined) body.email = email;
  const requestKey = cmd.options.value('request-key');
  if (requestKey !== undefined) body.requestKey = requestKey;

  const data = await observedInvoke<UsersCreateResult>(clientFor(cmd.ctx), 'users.create', { body });
  cmd.out.data(data, (result) => {
    // Say plainly when nothing was created: a replayed request that reported
    // "provisioned" would invite the operator to run it again.
    const verb = result.replayed ? 'already provisioned' : 'provisioned';
    return [
      `${verb} ${result.account.username}  ${result.account.identityId}`,
      `  space  ${result.spaceId}`,
      `  home   ${result.home.homePath}  (${result.home.state}, ${result.home.isolation})`,
    ].join('\n');
  });
  return EXIT_OK;
}

async function userList(cmd: CommandContext): Promise<ExitCode> {
  const data = await observedInvoke<UsersListResult>(clientFor(cmd.ctx), 'users.list', {});
  cmd.out.data(data, (result) => {
    if (result.users.length === 0) return 'no accounts on this Server';
    return result.users.map((u) => {
      const flags = [
        u.isOwner ? 'owner' : undefined,
        u.isNodeAdmin ? 'node-admin' : undefined,
        u.status === 'disabled' ? 'disabled' : undefined,
      ].filter((f): f is string => f !== undefined);
      // A user with no personal space is the defect the control plane exists to
      // fix, so it is called out rather than rendered as an empty column.
      const space = u.personalSpaceName ?? 'NO PERSONAL SPACE';
      const home = u.home ? `${u.home.osUsername} (${u.home.state}/${u.home.isolation})` : 'no home record';
      return [
        `${u.username}${flags.length ? `  [${flags.join(' ')}]` : ''}`,
        `  account  ${u.accountId}`,
        `  space    ${space}`,
        `  home     ${home}`,
        `  caps     ${u.capabilities.length ? u.capabilities.join(', ') : '(none)'}`,
      ].join('\n');
    }).join('\n\n');
  });
  return EXIT_OK;
}

function capabilityArgs(cmd: CommandContext, verb: string): { accountId: string; capability: string } {
  const usage = `usage: tm8 user ${verb} <account-id> <capability>\n  capabilities: ${CAPABILITIES.join(', ')}`;
  if (cmd.args.length !== 2) throw new CliError(usage, EXIT_USAGE);
  const [accountId, capability] = cmd.args as [string, string];
  if (!(CAPABILITIES as readonly string[]).includes(capability)) {
    throw new CliError(`unknown capability ${JSON.stringify(capability)}\n${usage}`, EXIT_USAGE);
  }
  return { accountId, capability };
}

async function userGrant(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('user grant', cmd.options.value('mutation-id'));
  const { accountId, capability } = capabilityArgs(cmd, 'grant');
  const data = await observedInvoke<UserCapabilityResult>(
    clientFor(cmd.ctx), 'users.capabilities.grant',
    { params: { accountId }, body: { capability } },
  );
  cmd.out.data(data, (r) => `granted ${r.capability} to ${r.accountId}`);
  return EXIT_OK;
}

async function userRevoke(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('user revoke', cmd.options.value('mutation-id'));
  const { accountId, capability } = capabilityArgs(cmd, 'revoke');
  const data = await observedInvoke<UserCapabilityResult>(
    clientFor(cmd.ctx), 'users.capabilities.revoke',
    { params: { accountId }, body: { capability } },
  );
  cmd.out.data(data, (r) => `revoked ${r.capability} from ${r.accountId}`);
  return EXIT_OK;
}

export const USER_COMMANDS: CommandModule[] = [
  { path: ['user', 'create'], run: userCreate },
  { path: ['user', 'list'], run: userList },
  { path: ['user', 'grant'], run: userGrant },
  { path: ['user', 'revoke'], run: userRevoke },
];

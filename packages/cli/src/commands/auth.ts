/**
 * `tm8 auth …` — local accounts (Identity v2 Stage 1).
 *
 * Four commands over the four `auth.*` operations. Three properties are
 * load-bearing:
 *
 *  - NO SPACE, NO ACTOR. Authentication is authorized against the SERVER;
 *    `--space` and `--as` have no meaning here and the strict DTOs refuse
 *    them on the wire.
 *  - THE TOKEN PRINTS EXACTLY ONCE. `auth login` is the only place a
 *    `tm8s_…` secret ever appears; it is never stored by the CLI. The caller
 *    exports it as `TM8_AGENT_TOKEN`, which `client.ts` already sends as
 *    `Authorization: Bearer`.
 *  - NO MUTATION IDS. Auth commands sit outside the idempotency ledger — a
 *    session row is not a graph mutation — so `--mutation-id` is refused
 *    rather than ignored.
 */
import type {
  AuthLoginResult,
  AuthLogoutResult,
  AuthSessionGetResult,
  AuthSignupResult,
} from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

function requireOnePositional(cmd: CommandContext, usage: string): string {
  const value = cmd.args[0];
  if (cmd.args.length !== 1 || !value) throw new CliError(usage, EXIT_USAGE);
  return value;
}

function requirePassword(cmd: CommandContext, usage: string): string {
  const password = cmd.options.value('password');
  if (!password) throw new CliError(usage, EXIT_USAGE);
  return password;
}

function renderAccount(account: AuthSignupResult['account']): string {
  const flags = [
    account.isOwner ? 'owner' : undefined,
    account.isNodeAdmin ? 'node-admin' : undefined,
  ].filter((f): f is string => f !== undefined);
  const name = account.displayName
    ? `${account.username} (${account.displayName})`
    : account.username;
  return `${name}  ${account.identityId}${flags.length ? `  [${flags.join(' ')}]` : ''}`;
}

async function authSignup(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth signup', cmd.options.value('mutation-id'));
  const usage =
    'usage: tm8 auth signup <username> --password <password> [--display-name <name>] [--email <email>] [--node-admin]';
  const username = requireOnePositional(cmd, usage);
  const body: Record<string, unknown> = {
    username,
    password: requirePassword(cmd, usage),
  };
  const displayName = cmd.options.value('display-name');
  if (displayName !== undefined) body.displayName = displayName;
  const email = cmd.options.value('email');
  if (email !== undefined) body.email = email;
  if (cmd.options.bool('node-admin')) body.isNodeAdmin = true;

  const data = await observedInvoke<AuthSignupResult>(clientFor(cmd.ctx), 'auth.signup', { body });
  cmd.out.data(data, (result) => `created account ${renderAccount(result.account)}`);
  return EXIT_OK;
}

async function authLogin(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth login', cmd.options.value('mutation-id'));
  const usage =
    'usage: tm8 auth login <username> --password <password> [--kind browser|cli] [--label <label>]';
  const username = requireOnePositional(cmd, usage);
  const body: Record<string, unknown> = {
    username,
    password: requirePassword(cmd, usage),
    // A CLI login is a cli session unless the caller says otherwise.
    kind: cmd.options.value('kind') ?? 'cli',
  };
  const label = cmd.options.value('label');
  if (label !== undefined) body.label = label;

  const data = await observedInvoke<AuthLoginResult>(clientFor(cmd.ctx), 'auth.login', { body });
  cmd.out.data(data, (result) =>
    [
      `logged in as ${renderAccount(result.account)}`,
      `session ${result.session.sessionId} (${result.session.kind}) expires ${result.session.expiresAt}`,
      '',
      '# The token below is shown exactly once. To authenticate this shell:',
      `export TM8_AGENT_TOKEN=${result.token}`,
    ].join('\n'),
  );
  return EXIT_OK;
}

async function authLogout(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth logout', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) {
    throw new CliError('usage: tm8 auth logout [--session-id <id>]', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {};
  const sessionId = cmd.options.value('session-id');
  if (sessionId !== undefined) body.sessionId = sessionId;

  const data = await observedInvoke<AuthLogoutResult>(clientFor(cmd.ctx), 'auth.logout', { body });
  cmd.out.data(data, (result) => `revoked session ${result.sessionId}`);
  return EXIT_OK;
}

async function authSession(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth session', cmd.options.value('mutation-id'));
  const data = await observedInvoke<AuthSessionGetResult>(clientFor(cmd.ctx), 'auth.session.get');
  cmd.out.data(data, (result) => {
    const lines = [`${result.authKind}: ${renderAccount(result.account)}`];
    if (result.session) {
      lines.push(
        `session ${result.session.sessionId} (${result.session.kind}) expires ${result.session.expiresAt}`,
      );
    } else {
      lines.push('no session row: loopback auto-owner authentication');
    }
    return lines.join('\n');
  });
  return EXIT_OK;
}

export const AUTH_COMMANDS: CommandModule[] = [
  { path: ['auth', 'signup'], run: authSignup },
  { path: ['auth', 'login'], run: authLogin },
  { path: ['auth', 'logout'], run: authLogout },
  { path: ['auth', 'session'], run: authSession },
];

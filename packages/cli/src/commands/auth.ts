/**
 * `tm8 auth …` — local accounts (Identity v2 Stage 1).
 *
 * Four commands over the four `auth.*` operations. Three properties are
 * load-bearing:
 *
 *  - NO SPACE, NO ACTOR. Authentication is authorized against the SERVER;
 *    `--space` and `--as` have no meaning here and the strict DTOs refuse
 *    them on the wire.
 *  - THE TOKEN IS STORED, OR PRINTED EXACTLY ONCE — NEVER BOTH. By default
 *    `auth login` writes the `tm8s_…` pass into the per-server credential
 *    store (doc 13 §4.1: macOS keychain, else a 0600 file, keyed by Server
 *    origin) and prints only a confirmation; the human render never shows a
 *    stored secret. With `--print-token`, in an agent context, or when the
 *    store is unavailable, nothing is stored and the token prints once for
 *    the caller to export as `TM8_AGENT_TOKEN`. (`--format json` always
 *    carries the wire DTO, token included — scripts depend on the contract
 *    shape, and redacting it would make json lie about the wire.)
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

import {
  credentialOrigin,
  credentialStoreFor,
  tokenSessionId,
  type CredentialStore,
} from '../credentials.js';
import { ApiError } from '../errors.js';
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
    'usage: tm8 auth login <username> --password <password> [--kind browser|cli] [--label <label>] [--print-token]';
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

  // Store the pass per Server origin (doc 13 §4.1). `credentialStoreFor`
  // already refuses agent contexts, so a spawned session falls through to the
  // print path rather than writing the human's store. A store FAILURE must not
  // discard a session the Server just minted — fall back to printing, and say
  // why.
  let storedTo: string | undefined;
  let storeFailure: string | undefined;
  if (!cmd.options.bool('print-token')) {
    const store = credentialStoreFor();
    if (store) {
      const origin = credentialOrigin(cmd.ctx.baseUrl.value);
      try {
        store.set(origin, data.token, {
          username: data.account.username,
          expiresAt: data.session.expiresAt,
        });
        storedTo = `${origin} (${store.kind})`;
      } catch (err) {
        storeFailure = err instanceof Error ? err.message : String(err);
      }
    }
  }

  cmd.out.data(data, (result) => {
    const lines = [
      `logged in as ${renderAccount(result.account)}`,
      `session ${result.session.sessionId} (${result.session.kind}) expires ${result.session.expiresAt}`,
    ];
    if (storedTo) {
      lines.push(
        `credential stored for ${storedTo} — tm8 commands against this Server now authenticate as this account`,
      );
    } else {
      if (storeFailure) lines.push(`warning: could not store the credential (${storeFailure})`);
      lines.push(
        '',
        '# The token below is shown exactly once. To authenticate this shell:',
        `export TM8_AGENT_TOKEN=${result.token}`,
      );
    }
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * Remove the stored credential for this origin IF the revoked session is the
 * stored one. `tm8 auth logout --session-id <other>` revokes a sibling session
 * and must leave this shell's credential alone.
 */
function dropStoredCredential(
  store: CredentialStore | undefined,
  origin: string,
  revokedSessionId: string | undefined,
): boolean {
  if (!store) return false;
  const stored = store.get(origin);
  if (!stored) return false;
  if (revokedSessionId !== undefined && tokenSessionId(stored) !== revokedSessionId) return false;
  return store.delete(origin);
}

async function authLogout(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth logout', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) {
    throw new CliError('usage: tm8 auth logout [--session-id <id>]', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {};
  const sessionId = cmd.options.value('session-id');
  if (sessionId !== undefined) body.sessionId = sessionId;

  const store = credentialStoreFor();
  const origin = credentialOrigin(cmd.ctx.baseUrl.value);

  let data: AuthLogoutResult;
  try {
    data = await observedInvoke<AuthLogoutResult>(clientFor(cmd.ctx), 'auth.logout', { body });
  } catch (err) {
    // The Server refusing the bearer means the session is ALREADY dead —
    // logout's goal is reached, and keeping the corpse in the store would
    // make every later command fail the same way. Local removal + exit 0,
    // not a rethrow: "log me out" succeeded, just not via revocation.
    if (err instanceof ApiError && err.code === 'unauthenticated') {
      const removed = dropStoredCredential(store, origin, undefined);
      if (removed) {
        cmd.out.data(
          { sessionId: null, revoked: false, removedStoredCredential: origin },
          () =>
            `the Server refused the stored credential (already expired or revoked); removed the stored credential for ${origin}`,
        );
        return EXIT_OK;
      }
    }
    throw err;
  }

  const removed = dropStoredCredential(store, origin, data.sessionId);
  cmd.out.data(data, (result) =>
    removed
      ? `revoked session ${result.sessionId}\nremoved the stored credential for ${origin}`
      : `revoked session ${result.sessionId}`,
  );
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

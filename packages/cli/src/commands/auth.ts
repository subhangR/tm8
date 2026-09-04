/**
 * `tm8 auth …` — local accounts (Identity v2 Stage 1).
 *
 * Six commands over the six `auth.*` operations. Three properties are
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
  AuthClaimReissueResult,
  AuthClaimResult,
  AuthClaimStatusResult,
  AuthInviteSignupResult,
  AuthLoginResult,
  AuthLogoutResult,
  AuthPasswordChangeResult,
  AuthSessionGetResult,
  AuthSignupResult,
} from '@tm8/contract';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  credentialOrigin,
  credentialStoreFor,
  tokenSessionId,
  type CredentialStore,
} from '../credentials.js';
import { dataDir } from './doctor.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
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

/**
 * `tm8 auth claim` — the first-run ceremony from a shell.
 *
 * The browser path is the one most people take, but this exists because a
 * headless install has no browser and because an operator scripting a
 * provision should not have to drive a web form. It stores the resulting pass
 * exactly like `auth login` does: claiming signs you in, and a ceremony that
 * left the shell unauthenticated would just make the next command fail.
 */
async function authClaim(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth claim', cmd.options.value('mutation-id'));
  // `--show` is a pure ON-BOX read: it recovers the claim token from
  // `<dataDir>/setup-token` so an operator who scrolled past the boot log can
  // still claim, without a round trip to a Server they cannot yet authenticate
  // to. It reaches no network and requires filesystem access to the data dir —
  // on-box by construction, not by a check that could be bypassed.
  if (cmd.options.bool('show')) return authClaimShow(cmd);
  const usage =
    'usage: tm8 auth claim --token <tm8c_…> --username <username> --password <password> [--display-name <name>] [--email <email>]';
  if (cmd.args.length > 0) throw new CliError(usage, EXIT_USAGE);

  const token = cmd.options.value('token');
  const username = cmd.options.value('username');
  if (!token || !username) throw new CliError(usage, EXIT_USAGE);

  const body: Record<string, unknown> = {
    token,
    username,
    password: requirePassword(cmd, usage),
    kind: cmd.options.value('kind') ?? 'cli',
  };
  const displayName = cmd.options.value('display-name');
  if (displayName !== undefined) body.displayName = displayName;
  const email = cmd.options.value('email');
  if (email !== undefined) body.email = email;

  const data = await observedInvoke<AuthClaimResult>(clientFor(cmd.ctx), 'auth.claim', { body });

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
      `claimed this Server as ${renderAccount(result.account)}`,
      'the claim token is now burned — this node cannot be claimed again',
    ];
    if (storedTo) {
      lines.push(`credential stored for ${storedTo}`);
    } else {
      if (storeFailure) lines.push(`warning: could not store the credential (${storeFailure})`);
      lines.push('', '# Shown exactly once:', `export TM8_AGENT_TOKEN=${result.token}`);
    }
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * `tm8 auth claim status` — is this Server claimed, and how does anyone get an
 * account on it. Answers without a credential, which is the whole point: it is
 * the question you ask BEFORE you can authenticate.
 */
async function authClaimStatus(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth claim status', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) throw new CliError('usage: tm8 auth claim status', EXIT_USAGE);

  const data = await observedInvoke<AuthClaimStatusResult>(
    clientFor(cmd.ctx),
    'auth.claim.status',
  );
  cmd.out.data(data, (result) => {
    const lines = [
      `node: ${result.claimed ? 'claimed' : 'UNCLAIMED'} · mode ${result.mode}`,
    ];
    if (!result.claimed) {
      lines.push(
        'no account here has a password yet, so nobody can sign in',
        'claim it with the tm8c_… token from the Server\'s boot log or <dataDir>/setup-token:',
        '  tm8 auth claim --token <tm8c_…> --username <you> --password <password>',
      );
    } else if (result.signupPath === 'admin') {
      lines.push('new accounts are provisioned by a node admin: tm8 auth signup <username> --password <password>');
    } else if (result.signupPath === 'invite') {
      lines.push('new accounts are created by redeeming a space invite');
    }
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * `tm8 auth claim --show` — recover the claim token from this box's data dir.
 *
 * The consequence this closes, measured on a live node: with no token in the
 * URL, the first-run card's "Create account" control is not merely disabled, it
 * is absent from the DOM. An operator who scrolled past the boot log and cannot
 * remember `<dataDir>/setup-token` then has an inert card and no command to run.
 * This is that command: it reads the durable 0600 copy and reprints it.
 */
async function authClaimShow(cmd: CommandContext): Promise<ExitCode> {
  if (cmd.args.length > 0) throw new CliError('usage: tm8 auth claim --show', EXIT_USAGE);
  const dir = dataDir(process.env);
  const tokenPath = join(dir, 'setup-token');
  let token: string;
  try {
    token = (await readFile(tokenPath, 'utf8')).trim();
  } catch {
    throw new CliError(
      `no claim token to show: ${tokenPath} could not be read.\n` +
        'the node may already be claimed (the token is then burned), the token may never have been written, ' +
        'or TM8_DATA_DIR may point elsewhere than the running Server. Check `tm8 auth claim status`.',
      EXIT_NOT_FOUND,
    );
  }
  if (!token) {
    throw new CliError(`no claim token to show: ${tokenPath} is empty`, EXIT_NOT_FOUND);
  }
  const origin = cmd.ctx.baseUrl.value.replace(/\/$/, '');
  const claimUrl = `${origin}/#claim=${encodeURIComponent(token)}`;
  cmd.out.data({ token, tokenPath, claimUrl }, (r) =>
    [
      'this node\'s live claim token (from the local data dir):',
      `  ${r.claimUrl}`,
      `  read from ${r.tokenPath}`,
      '',
      '# or claim from this shell:',
      `tm8 auth claim --token ${r.token} --username <you> --password <password>`,
    ].join('\n'),
  );
  return EXIT_OK;
}

/**
 * `tm8 auth claim reissue` — rotate the claim token and reprint it.
 *
 * ON-BOX ONLY: the Server admits only the loopback auto-owner, so this must run
 * on the host. An ordinary restart REPRINTS the live token rather than rotating
 * it; this is the deliberate act that rotates, invalidating any token printed
 * before it.
 */
async function authClaimReissue(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth claim reissue', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) throw new CliError('usage: tm8 auth claim reissue', EXIT_USAGE);
  const data = await observedInvoke<AuthClaimReissueResult>(
    clientFor(cmd.ctx),
    'auth.claim.reissue',
  );
  cmd.out.data(data, (r) => {
    const lines = [
      'reissued this Server\'s claim token — any token printed before now is dead:',
      `  ${r.claimUrl}`,
    ];
    if (r.tokenPath) lines.push(`  also written to ${r.tokenPath} (0600)`);
    lines.push(
      '',
      '# or claim from this shell:',
      `tm8 auth claim --token ${r.token} --username <you> --password <password>`,
    );
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * `tm8 auth password` — change your own password. CHANGE, not reset: the current
 * password is required, so an open session cannot silently re-credential the
 * account. Every OTHER live session is revoked; this one stays signed in.
 */
async function authPasswordChange(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth password', cmd.options.value('mutation-id'));
  const usage = 'usage: tm8 auth password --current <current-password> --new <new-password>';
  if (cmd.args.length > 0) throw new CliError(usage, EXIT_USAGE);
  const currentPassword = cmd.options.value('current');
  const newPassword = cmd.options.value('new');
  if (!currentPassword || !newPassword) throw new CliError(usage, EXIT_USAGE);

  const data = await observedInvoke<AuthPasswordChangeResult>(
    clientFor(cmd.ctx),
    'auth.password.change',
    { body: { currentPassword, newPassword } },
  );
  cmd.out.data(data, (r) =>
    [
      `password changed for account ${r.accountId}`,
      r.revokedOtherSessions > 0
        ? `revoked ${r.revokedOtherSessions} other live session(s); this session stays signed in`
        : 'no other live sessions to revoke; this session stays signed in',
    ].join('\n'),
  );
  return EXIT_OK;
}

/**
 * `tm8 auth invite signup` — redeem an invite that creates your account and
 * signs you in. Claim-free: the invite code is the authorization. The operator
 * never sets or learns your password.
 */
async function authInviteSignup(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('auth invite signup', cmd.options.value('mutation-id'));
  const usage =
    'usage: tm8 auth invite signup --code <inv_…> --username <username> --password <password> [--display-name <name>] [--email <email>]';
  if (cmd.args.length > 0) throw new CliError(usage, EXIT_USAGE);
  const code = cmd.options.value('code');
  const username = cmd.options.value('username');
  if (!code || !username) throw new CliError(usage, EXIT_USAGE);

  const body: Record<string, unknown> = {
    code,
    username,
    password: requirePassword(cmd, usage),
    kind: cmd.options.value('kind') ?? 'cli',
  };
  const displayName = cmd.options.value('display-name');
  if (displayName !== undefined) body.displayName = displayName;
  const email = cmd.options.value('email');
  if (email !== undefined) body.email = email;

  const data = await observedInvoke<AuthInviteSignupResult>(
    clientFor(cmd.ctx),
    'auth.invite.signup',
    { body },
  );

  // Signing up signs you in, so store the pass exactly like login/claim do.
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
      `joined space ${result.spaceId} as ${renderAccount(result.account)}`,
    ];
    if (storedTo) {
      lines.push(`credential stored for ${storedTo}`);
    } else {
      if (storeFailure) lines.push(`warning: could not store the credential (${storeFailure})`);
      lines.push('', '# Shown exactly once:', `export TM8_AGENT_TOKEN=${result.token}`);
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
  { path: ['auth', 'password'], run: authPasswordChange },
  { path: ['auth', 'invite', 'signup'], run: authInviteSignup },
  // Order here is irrelevant — `findCommand` is an exact Map lookup on the
  // joined path. What keeps `tm8 auth claim status` from parsing as `auth
  // claim` with a stray positional is `splitCommandPath` (args.ts:412), which
  // longest-matches against the closed registry before dispatch ever happens.
  //
  // `auth claim status` is THREE segments, which is exactly
  // `MAX_COMMAND_PATH_DEPTH` (args.ts:402). It fits; a four-segment sibling
  // would not, and would fail as an unknown command rather than warn.
  { path: ['auth', 'claim'], run: authClaim },
  { path: ['auth', 'claim', 'status'], run: authClaimStatus },
  { path: ['auth', 'claim', 'reissue'], run: authClaimReissue },
];

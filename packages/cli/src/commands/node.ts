/**
 * `tm8 node …` — facts about the Server as a node, and its node-admin writes
 * (`node account …`, `node path-grant …`).
 *
 * Today that is one verb, `node mode`, which is SUGAR over `auth.claim.status`:
 * that operation already reports the mode, and this is a second, purpose-named
 * spelling of the same read (the same relationship `worktree status` has to
 * `entities.get`). It adds no catalog operation.
 *
 * READ-ONLY BY DESIGN, and the design is the point (FIRST-RUN-CLAIM-DESIGN.md
 * D4). The mode lives in server config (`TM8_NODE_MODE`), never in a graph row,
 * because it gates a security arm and before a node is claimed "node admin"
 * means anyone who reaches loopback — precisely the population the mode exists
 * to constrain. Converting is an env edit and a restart. A command that let you
 * flip it over the wire would be lying about where the switch is, so this one
 * reports the mode and names where the switch lives, and offers no way to move
 * it.
 */
import type {
  AccountDisableResult,
  AccountEnableResult,
  NodeAccountCreateResult,
  NodeAccountMembershipAddResult,
  NodeAccountNodeAdminSetResult,
  NodeAccountResetResult,
  AuthClaimStatusResult,
  NodeAccountListView,
  PathGrantListView,
  PathGrantView,
} from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions } from './entity.js';

async function nodeMode(cmd: CommandContext): Promise<ExitCode> {
  if (cmd.args.length > 0) throw new CliError('usage: tm8 node mode', EXIT_USAGE);
  const data = await observedInvoke<AuthClaimStatusResult>(
    clientFor(cmd.ctx),
    'auth.claim.status',
  );
  cmd.out.data(data, (r) => {
    const lines = [`node mode: ${r.mode}`];
    lines.push(
      r.mode === 'single'
        ? 'single-player: a loopback caller with no credential is resolved as the owner, so there is no gate on the Server\'s own machine.'
        : 'multiplayer: the loopback auto-owner arm is off; everyone signs in, everywhere.',
    );
    // Absent on a Server that predates 282: say nothing rather than guess.
    if (r.projectIsolation === 'shared') {
      lines.push('projects: shared — folders are used in place and one folder may serve several spaces (loopback-only node).');
    } else if (r.projectIsolation === 'isolated') {
      lines.push('projects: isolated — a folder belongs to one space; members browse node paths only through a path grant (tm8 node path-grant).');
    }
    lines.push(
      '',
      'read-only: the mode is server config (TM8_NODE_MODE), not something this command can flip.',
      'to convert, edit TM8_NODE_MODE in the Server\'s env and restart it (design D4).',
    );
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * `node account disable <account-id|username> --yes` — `accounts.disable` (G6, T15).
 *
 * The one WRITE under `node`: disabling an account is a node-admin act, not a
 * Space one. Every session of the account is revoked in the same transaction
 * and its running agent sessions are stopped; the account row is kept.
 * Refused for yourself and for the node owner.
 */
async function nodeAccountDisable(cmd: CommandContext): Promise<ExitCode> {
  const who = cmd.args[0];
  if (cmd.args.length !== 1 || !who) {
    throw new CliError('usage: tm8 node account disable <account-id|username> --yes', EXIT_USAGE);
  }
  if (!cmd.options.bool('yes')) {
    throw new CliError('`tm8 node account disable` is destructive and requires --yes', EXIT_USAGE, {
      hint: 'non-interactive execution never prompts, and --format json is not consent',
    });
  }
  const accountId = await resolveAccountId(cmd, who);
  const data = await observedInvoke<AccountDisableResult>(clientFor(cmd.ctx), 'accounts.disable', {
    params: { accountId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(
    data,
    (r) =>
      `disabled  account ${r.accountId}  sessions revoked ${r.revokedSessionCount}  agent sessions stopped ${r.stoppedSessionIds.length}`,
  );
  return EXIT_OK;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function grantLine(g: PathGrantView): string {
  const who = g.grantee ? g.grantee.username : g.accountId;
  const state = g.revokedAt ? `revoked ${g.revokedAt}` : `granted ${g.grantedAt}`;
  return `${g.id}  ${who}  ${g.rootPath}  ${state}${g.note ? `  — ${g.note}` : ''}`;
}

function renderGrants(view: PathGrantListView, empty: string): string {
  return view.grants.length === 0 ? empty : view.grants.map(grantLine).join('\n');
}

/** `node account list` — `node.accounts.list`: who a path grant can be addressed to. */
async function nodeAccountList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  if (cmd.args.length > 0) throw new CliError('usage: tm8 node account list', EXIT_USAGE);
  const data = await observedInvoke<NodeAccountListView>(clientFor(cmd.ctx), 'node.accounts.list');
  cmd.out.data(data, (r) => r.accounts
    .map((a) => `${a.accountId}  ${a.username}${a.displayName ? ` (${a.displayName})` : ''}  ${a.status}`
      + `${a.isOwner ? '  owner' : a.isNodeAdmin ? '  node admin' : ''}`
      + `${a.hasPassword === false ? `  setup pending${a.setupExpiresAt ? ` (link expires ${a.setupExpiresAt})` : ' (no live link)'}` : ''}`)
    .join('\n'));
  return EXIT_OK;
}

/**
 * `node path-grant list [--include-revoked]` — `node.pathGrants.list`.
 *
 * Path grants (migration 282): a node admin lets one account browse one
 * filesystem root and select a folder under it. Node admins hold every
 * TM8_PROJECT_ROOTS entry implicitly, so they never appear here.
 */
async function pathGrantList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['include-revoked']);
  if (cmd.args.length > 0) throw new CliError('usage: tm8 node path-grant list [--include-revoked]', EXIT_USAGE);
  const data = await observedInvoke<PathGrantListView>(clientFor(cmd.ctx), 'node.pathGrants.list', {
    query: cmd.options.bool('include-revoked') ? { includeRevoked: 'true' } : {},
  });
  cmd.out.data(data, (r) => renderGrants(r, 'no path grants on this node'));
  return EXIT_OK;
}

/**
 * `node path-grant add <account-id|username> <path> [--note <text>]` —
 * `node.pathGrants.create`. The server realpaths the path and refuses one
 * outside TM8_PROJECT_ROOTS; granting the same root again re-opens it.
 */
async function pathGrantAdd(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['note', 'mutation-id']);
  const [who, rootPath] = cmd.args;
  if (cmd.args.length !== 2 || !who || !rootPath) {
    throw new CliError('usage: tm8 node path-grant add <account-id|username> <path> [--note <text>]', EXIT_USAGE);
  }
  const client = clientFor(cmd.ctx);
  const accountId = await resolveAccountId(cmd, who);
  const note = cmd.options.value('note');
  const data = await observedInvoke<PathGrantView>(client, 'node.pathGrants.create', {
    body: {
      accountId,
      rootPath,
      ...(note ? { note } : {}),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, (g) => `granted  ${grantLine(g)}`);
  return EXIT_OK;
}

/** An account id, or a username looked up through `node.accounts.list`. */
async function resolveAccountId(cmd: CommandContext, who: string): Promise<string> {
  if (UUID_RE.test(who)) return who;
  const { accounts } = await observedInvoke<NodeAccountListView>(clientFor(cmd.ctx), 'node.accounts.list');
  const match = accounts.find((a) => a.username.toLowerCase() === who.toLowerCase());
  if (!match) {
    throw new CliError(`no account named ${who} on this node`, EXIT_USAGE, { hint: 'tm8 node account list' });
  }
  return match.accountId;
}

function expiresInHours(cmd: CommandContext, usage: string): { expiresInHours?: number } {
  const raw = cmd.options.value('expires-hours');
  if (raw === undefined) return {};
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new CliError(`--expires-hours must be a whole number from 1 to 720\n${usage}`, EXIT_USAGE);
  }
  return { expiresInHours: hours };
}

function setupLinkLines(link: { setupUrl: string; expiresAt: string }): string[] {
  return [
    '',
    '# One-time setup link — shown exactly once. Send it to the person; it expires',
    `# ${link.expiresAt} and is used up when they choose their password.`,
    link.setupUrl,
  ];
}

const CREATE_USAGE =
  'usage: tm8 node account create <username> [--display-name <name>] [--email <email>] [--node-admin] [--join-space <space-id> --role admin|member] [--expires-hours <1-720>]';

/**
 * `node account create <username>` — `node.accounts.create` (324). The account
 * gets NO password: the result carries a one-time setup link the person opens
 * to choose their own.
 */
async function nodeAccountCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['display-name', 'email', 'node-admin', 'join-space', 'role', 'expires-hours', 'mutation-id']);
  const username = cmd.args[0];
  if (cmd.args.length !== 1 || !username) throw new CliError(CREATE_USAGE, EXIT_USAGE);
  // `--space` is the global space selector, so the space to join has its own flag.
  const space = cmd.options.value('join-space');
  const role = cmd.options.value('role');
  if ((space === undefined) !== (role === undefined)) {
    throw new CliError(`--join-space and --role go together\n${CREATE_USAGE}`, EXIT_USAGE);
  }
  if (role !== undefined && role !== 'admin' && role !== 'member') {
    throw new CliError(`--role must be admin or member\n${CREATE_USAGE}`, EXIT_USAGE);
  }
  const displayName = cmd.options.value('display-name');
  const email = cmd.options.value('email');
  const data = await observedInvoke<NodeAccountCreateResult>(clientFor(cmd.ctx), 'node.accounts.create', {
    body: {
      username,
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
      ...(cmd.options.bool('node-admin') ? { isNodeAdmin: true } : {}),
      ...(space && role ? { spaceId: space, role } : {}),
      ...expiresInHours(cmd, CREATE_USAGE),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, (r) => [
    `created  account ${r.account.accountId}  ${r.account.username}${r.account.isNodeAdmin ? '  node admin' : ''}`,
    ...(r.membership ? [`added to space ${r.membership.spaceId} as ${r.membership.role}`] : []),
    ...setupLinkLines(r),
  ].join('\n'));
  return EXIT_OK;
}

const RESET_USAGE = 'usage: tm8 node account reset <account-id|username> --yes [--expires-hours <1-720>]';

/**
 * `node account reset <account> --yes` — `node.accounts.reset` (324): clear the
 * password, revoke every session, and issue a new one-time setup link. Never
 * the node owner, never yourself (use `tm8 auth password`).
 */
async function nodeAccountReset(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['yes', 'expires-hours', 'mutation-id']);
  const who = cmd.args[0];
  if (cmd.args.length !== 1 || !who) throw new CliError(RESET_USAGE, EXIT_USAGE);
  if (!cmd.options.bool('yes')) {
    throw new CliError('`tm8 node account reset` signs the account out everywhere and requires --yes', EXIT_USAGE, {
      hint: 'non-interactive execution never prompts, and --format json is not consent',
    });
  }
  const accountId = await resolveAccountId(cmd, who);
  const data = await observedInvoke<NodeAccountResetResult>(clientFor(cmd.ctx), 'node.accounts.reset', {
    params: { accountId },
    body: { ...expiresInHours(cmd, RESET_USAGE), clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (r) => [
    `reset  account ${r.accountId}  ${r.username}  sessions revoked ${r.revokedSessionCount}`,
    ...setupLinkLines(r),
  ].join('\n'));
  return EXIT_OK;
}

/** `node account enable <account>` — `accounts.enable` (324), the inverse of disable. */
async function nodeAccountEnable(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const who = cmd.args[0];
  if (cmd.args.length !== 1 || !who) throw new CliError('usage: tm8 node account enable <account-id|username>', EXIT_USAGE);
  const accountId = await resolveAccountId(cmd, who);
  const data = await observedInvoke<AccountEnableResult>(clientFor(cmd.ctx), 'accounts.enable', {
    params: { accountId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (r) => `enabled  account ${r.accountId}`);
  return EXIT_OK;
}

const ADMIN_USAGE = 'usage: tm8 node account admin <account-id|username> grant|revoke';

/**
 * `node account admin <account> grant|revoke` — `node.accounts.nodeAdmin.set`
 * (324). The owner is never changed; the last node admin is never revoked.
 */
async function nodeAccountAdmin(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const [who, verb] = cmd.args;
  if (cmd.args.length !== 2 || !who || (verb !== 'grant' && verb !== 'revoke')) {
    throw new CliError(ADMIN_USAGE, EXIT_USAGE);
  }
  const accountId = await resolveAccountId(cmd, who);
  const data = await observedInvoke<NodeAccountNodeAdminSetResult>(clientFor(cmd.ctx), 'node.accounts.nodeAdmin.set', {
    params: { accountId },
    body: { isNodeAdmin: verb === 'grant', clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (r) => `${r.isNodeAdmin ? 'granted' : 'revoked'}  node admin  account ${r.accountId}`);
  return EXIT_OK;
}

const ADD_TO_SPACE_USAGE = 'usage: tm8 node account add-to-space <account-id|username> <space-id> --role admin|member';

/** `node account add-to-space <account> <space-id>` — `node.accounts.memberships.add` (324). */
async function nodeAccountAddToSpace(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['role', 'mutation-id']);
  const [who, spaceId] = cmd.args;
  const role = cmd.options.value('role');
  if (cmd.args.length !== 2 || !who || !spaceId || (role !== 'admin' && role !== 'member')) {
    throw new CliError(ADD_TO_SPACE_USAGE, EXIT_USAGE);
  }
  const accountId = await resolveAccountId(cmd, who);
  const data = await observedInvoke<NodeAccountMembershipAddResult>(clientFor(cmd.ctx), 'node.accounts.memberships.add', {
    params: { accountId },
    body: { spaceId, role, clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (r) => r.created
    ? `added  account ${r.accountId}  to space ${r.spaceId} as ${r.role}  member ${r.memberId}`
    : `already a member  account ${r.accountId}  of space ${r.spaceId} as ${r.role} (unchanged)`);
  return EXIT_OK;
}

/** `node path-grant revoke <grant-id>` — `node.pathGrants.revoke`. Re-granting re-opens it. */
async function pathGrantRevoke(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const grantId = cmd.args[0];
  if (cmd.args.length !== 1 || !grantId) {
    throw new CliError('usage: tm8 node path-grant revoke <grant-id>', EXIT_USAGE);
  }
  const data = await observedInvoke<PathGrantView>(clientFor(cmd.ctx), 'node.pathGrants.revoke', {
    params: { grantId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, (g) => `revoked  ${grantLine(g)}`);
  return EXIT_OK;
}

/** `node path-grant mine` — `identity.pathGrants.list`: the roots you may browse. */
async function pathGrantMine(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  if (cmd.args.length > 0) throw new CliError('usage: tm8 node path-grant mine', EXIT_USAGE);
  const data = await observedInvoke<PathGrantListView>(clientFor(cmd.ctx), 'identity.pathGrants.list');
  cmd.out.data(data, (r) => renderGrants(r, 'no folder on this node is granted to you; a node admin grants one with tm8 node path-grant add'));
  return EXIT_OK;
}

export const NODE_COMMANDS: CommandModule[] = [
  { path: ['node', 'mode'], run: nodeMode },
  { path: ['node', 'account', 'disable'], run: nodeAccountDisable },
  { path: ['node', 'account', 'list'], run: nodeAccountList },
  { path: ['node', 'account', 'create'], run: nodeAccountCreate },
  { path: ['node', 'account', 'reset'], run: nodeAccountReset },
  { path: ['node', 'account', 'enable'], run: nodeAccountEnable },
  { path: ['node', 'account', 'admin'], run: nodeAccountAdmin },
  { path: ['node', 'account', 'add-to-space'], run: nodeAccountAddToSpace },
  { path: ['node', 'path-grant', 'list'], run: pathGrantList },
  { path: ['node', 'path-grant', 'add'], run: pathGrantAdd },
  { path: ['node', 'path-grant', 'revoke'], run: pathGrantRevoke },
  { path: ['node', 'path-grant', 'mine'], run: pathGrantMine },
];

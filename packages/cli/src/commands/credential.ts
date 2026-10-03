/**
 * `tm8 credential share|unshare|shares` — sharing a PRIVATE space credential
 * with one member of its space (992, task 01a10201).
 *
 * Human sessions only, like every `credentials.*` row: the Server refuses an
 * agent token (`credentials_human_only`) and admits a `cli`-kind human session
 * exactly as it admits the settings screen. No `--as` is ever sent — the strict
 * bodies refuse `actorId`, and a credential is never shared on someone else's
 * behalf. The grantee is named by account id (or, where the Server resolves
 * it, their member id in the credential's space).
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, requireArg } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

function requireMember(cmd: CommandContext): string {
  const member = cmd.options.value('member');
  if (member === undefined || member === '') {
    throw new CliError(`\`tm8 ${cmd.path.join(' ')}\` requires --member <account-or-member-id>`, EXIT_USAGE);
  }
  return member;
}

function noExtraArgs(cmd: CommandContext): void {
  if (cmd.args.length > 1) {
    throw new CliError(`\`tm8 ${cmd.path.join(' ')}\` takes one <space-credential-id>`, EXIT_USAGE);
  }
}

function field(dto: unknown, key: string): unknown {
  return typeof dto === 'object' && dto !== null ? (dto as Record<string, unknown>)[key] : undefined;
}

function renderShare(dto: unknown): string {
  const who = String(field(dto, 'granteeAccountId') ?? '?');
  return field(dto, 'shared') === false ? `already shared with ${who}` : `shared with ${who}`;
}

function renderUnshare(dto: unknown): string {
  const who = String(field(dto, 'granteeAccountId') ?? '?');
  // A retry after a failed kill finds no share row but still contains the
  // grantee's sessions, so the kill report is shown either way.
  const killed = field(dto, 'terminatedAgentSessionIds');
  const failures = field(dto, 'failures');
  const lines = [field(dto, 'unshared') === false ? `was not shared with ${who}` : `no longer shared with ${who}`];
  if (Array.isArray(killed) && killed.length > 0) lines.push(`stopped ${String(killed.length)} of their session(s)`);
  if (Array.isArray(failures) && failures.length > 0) lines.push(`${String(failures.length)} session(s) could not be stopped`);
  return lines.join('\n');
}

function renderShares(dto: unknown): string {
  const shares = field(dto, 'shares');
  if (!Array.isArray(shares) || shares.length === 0) return 'not shared with anyone';
  return shares
    .map((row) => {
      const name = field(row, 'granteeDisplayName');
      const id = String(field(row, 'granteeAccountId') ?? '?');
      return `${typeof name === 'string' && name ? `${name} (${id})` : id}  since ${String(field(row, 'createdAt') ?? '?')}`;
    })
    .join('\n');
}

async function credentialShare(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['member', 'mutation-id']);
  const credentialId = requireArg(cmd, 0, '<space-credential-id>');
  noExtraArgs(cmd);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'credentials.space.share', {
    params: { credentialId },
    body: {
      granteeAccountId: requireMember(cmd),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, renderShare);
  return EXIT_OK;
}

async function credentialUnshare(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['member', 'yes', 'mutation-id']);
  const credentialId = requireArg(cmd, 0, '<space-credential-id>');
  noExtraArgs(cmd);
  const granteeAccountId = requireMember(cmd);
  // §7.5: it stops the grantee's live sessions on the credential.
  if (!cmd.options.bool('yes')) {
    throw new CliError('`tm8 credential unshare` is destructive and requires --yes', EXIT_USAGE, {
      hint: "it stops the member's live sessions on this credential; --format json is not consent",
    });
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'credentials.space.unshare', {
    params: { credentialId, granteeAccountId },
    body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
  });
  cmd.out.data(data, renderUnshare);
  return EXIT_OK;
}

async function credentialShares(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  const credentialId = requireArg(cmd, 0, '<space-credential-id>');
  noExtraArgs(cmd);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'credentials.space.shares', {
    params: { credentialId },
  });
  cmd.out.data(data, renderShares);
  return EXIT_OK;
}

export const CREDENTIAL_COMMANDS: CommandModule[] = [
  { path: ['credential', 'share'], run: credentialShare },
  { path: ['credential', 'unshare'], run: credentialUnshare },
  { path: ['credential', 'shares'], run: credentialShares },
];

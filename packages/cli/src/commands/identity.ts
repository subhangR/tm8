/**
 * `tm8 identity get` (§4.1) — the single row of the identity noun, projecting
 * `identity.get`.
 *
 * This is the command an agent runs when it does not know where it is, so two
 * properties are load-bearing:
 *
 *  - IT REQUIRES NO SPACE. `identity.get` is authorized against the SERVER, not
 *    a Space. Demanding `--space` here would make the command unusable in
 *    exactly the situation that produces it — "I have no context, who am I?" —
 *    and would be inventing an authorization input the Server does not ask for.
 *  - IT IS A READ. `--mutation-id` is refused rather than ignored: a caller who
 *    passes one believes their read is idempotently retryable in a way it is
 *    not, or typed the wrong command.
 *
 * The human view keeps the ids a follow-up needs — `--as` takes a Member or
 * Teammate id, and this response is where those ids come from, so eliding them
 * would leave the caller with a display name they cannot act as.
 *
 * Phase-1 identity is a database-resolved loopback auto-owner: there is NO
 * bearer authentication here, and nothing in this file may describe the
 * response as a credential.
 */
import type { IdentityProfileView } from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

interface Membership {
  spaceId?: unknown;
  memberId?: unknown;
  role?: unknown;
}

interface IdentityDto {
  identityId?: unknown;
  username?: unknown;
  displayName?: unknown;
  globalId?: unknown;
  status?: unknown;
  isOwner?: unknown;
  isNodeAdmin?: unknown;
  actingAs?: unknown;
  memberships?: unknown;
}

/**
 * The human rendering of the SAME DTO `--format json` emits. Every identifier
 * survives; only the presentation differs.
 */
function renderIdentity(dto: unknown): string {
  const id = (dto ?? {}) as IdentityDto;
  if (id.identityId === undefined && id.username === undefined) return JSON.stringify(dto);

  const name = id.displayName ? `${String(id.username)} (${String(id.displayName)})` : String(id.username);
  const flags = [
    id.isOwner === true ? 'owner' : undefined,
    id.isNodeAdmin === true ? 'node-admin' : undefined,
    id.status === undefined ? undefined : String(id.status),
  ].filter((f): f is string => f !== undefined);

  const lines = [`${name}  ${String(id.identityId)}${flags.length ? `  [${flags.join(' ')}]` : ''}`];
  if (id.globalId !== undefined && id.globalId !== null) {
    lines.push(`global id ${String(id.globalId)}`);
  }
  if (id.actingAs !== undefined && id.actingAs !== null) {
    lines.push(`acting as ${String(id.actingAs)}`);
  }
  const memberships = Array.isArray(id.memberships) ? (id.memberships as Membership[]) : [];
  if (memberships.length === 0) {
    lines.push('no Space memberships');
  } else {
    for (const m of memberships) {
      // spaceId first: it is what `--space` takes, memberId is what `--as` takes.
      lines.push(`  space ${String(m.spaceId)}  member ${String(m.memberId)}  ${String(m.role ?? '')}`.trimEnd());
    }
  }
  return lines.join('\n');
}

async function identityGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('identity get', cmd.options.value('mutation-id'));
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'identity.get');
  cmd.out.data(data, renderIdentity);
  return EXIT_OK;
}

function renderProfile(profile: IdentityProfileView): string {
  return [
    `profile ${profile.identityId}`,
    `  display name ${profile.displayName ?? '(unset)'}`,
    `  avatar       ${profile.avatar ?? '(unset)'}`,
    `  email        ${profile.email ?? '(unset)'}`,
    `  global id    ${profile.globalId ?? '(unset)'}`,
  ].join('\n');
}

/**
 * `tm8 identity profile set` — write the CALLER'S display profile
 * (`identity.profile.update`). Same server-level authorization as
 * `identity get`: no `--space`, and no `--as` — a profile belongs to the
 * identity, so acting as a persona cannot redirect the write. There is no
 * flag naming whose profile to write, by design.
 */
async function identityProfileSet(cmd: CommandContext): Promise<ExitCode> {
  if (cmd.args.length > 0) {
    throw new CliError('tm8 identity profile set takes no positional arguments', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const fields: ReadonlyArray<readonly [flag: string, field: string]> = [
    ['display-name', 'displayName'],
    ['avatar', 'avatar'],
    ['email', 'email'],
    ['global-id', 'globalId'],
  ];
  for (const [flag, field] of fields) {
    const value = cmd.options.value(flag);
    if (value !== undefined) body[field] = value;
  }
  if (Object.keys(body).length === 1) {
    throw new CliError(
      'tm8 identity profile set requires at least one of --display-name, --avatar, --email, --global-id',
      EXIT_USAGE,
    );
  }
  const data = await observedInvoke<IdentityProfileView>(
    clientFor(cmd.ctx), 'identity.profile.update', { body });
  cmd.out.data(data, renderProfile);
  return EXIT_OK;
}

export const IDENTITY_COMMANDS: CommandModule[] = [
  { path: ['identity', 'get'], run: identityGet },
  { path: ['identity', 'profile', 'set'], run: identityProfileSet },
];

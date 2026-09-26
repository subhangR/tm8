/**
 * `tm8 node …` — the Server as a node: its mode, Personal / Peer / Server
 * (doc 14; plan doc 15 §4).
 *
 * `node mode` is SUGAR over `auth.claim.status`: that operation already reports
 * the mode and where it came from, and this is a purpose-named spelling of the
 * same read (the relationship `worktree status` has to `entities.get`).
 *
 * `node mode set <mode>` calls `node.mode.set`, and the Server holds every rule
 * (FIRST-RUN-CLAIM-DESIGN.md D4 as revised by doc 14 §5.2) — this command
 * enforces none of them and only reports the refusal:
 *
 * - `TM8_NODE_MODE` in the Server's environment PINS the mode, and every
 *   switch is refused (`conflict`, `mode_pinned`);
 * - every mode needs the node claimed first (`conflict`, `node_unclaimed`).
 *   It never takes a password: `tm8 auth claim` does that;
 * - tightening is open to the owner on the Server's own machine; LOOSENING
 *   (`server → peer|personal`, `peer → personal`) needs the owner signed in
 *   with their password (`forbidden`, `owner_session_required`).
 *
 * The mode is read at boot, so a switch that moves the loopback auto-owner arm
 * says to restart. Like `auth`, no `--space`, no `--as` and no mutation id: the
 * mode belongs to the node, not to a space or a persona.
 *
 * `node account disable` (G6) is the node-admin write described on its own
 * function below; it does carry a mutation id.
 */
import type { AccountDisableResult, AuthClaimStatusResult, NodeModeSetResult, NodeModeView } from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

const MODES: readonly NodeModeView[] = ['personal', 'peer', 'server'];

const MEANING: Record<NodeModeView, string> = {
  personal: 'personal: one person — a loopback browser holding the launch cookie (tm8 open) is the owner; nobody else signs in.',
  peer: 'peer: a loopback browser holding the launch cookie (tm8 open) is the owner; other people sign in with a password.',
  server: 'server: the loopback auto-owner arm is off; everyone signs in, everywhere.',
};

function sourceText(result: AuthClaimStatusResult): string {
  if (result.modeSource === 'env') return 'from env';
  if (result.modeSource === 'file') return 'from file';
  return 'default, no mode chosen yet';
}

async function nodeMode(cmd: CommandContext): Promise<ExitCode> {
  if (cmd.args.length > 0) throw new CliError('usage: tm8 node mode', EXIT_USAGE);
  const data = await observedInvoke<AuthClaimStatusResult>(
    clientFor(cmd.ctx),
    'auth.claim.status',
  );
  cmd.out.data(data, (r) => {
    const lines = [`node mode: ${r.mode} (${sourceText(r)})`, MEANING[r.mode], ''];
    lines.push(
      r.modeSource === 'env'
        ? 'pinned by TM8_NODE_MODE in the Server\'s environment; change it there and restart the Server'
        : 'switch with: tm8 node mode set <personal|peer|server>',
    );
    return lines.join('\n');
  });
  return EXIT_OK;
}

/**
 * `node account disable <account-id> --yes` — `accounts.disable` (G6, T15).
 *
 * The one WRITE under `node`: disabling an account is a node-admin act, not a
 * Space one. Every session of the account is revoked in the same transaction
 * and its running agent sessions are stopped; the account row is kept.
 * Refused for yourself and for the node owner.
 */
async function nodeAccountDisable(cmd: CommandContext): Promise<ExitCode> {
  const accountId = cmd.args[0];
  if (cmd.args.length !== 1 || !accountId) {
    throw new CliError('usage: tm8 node account disable <account-id> --yes', EXIT_USAGE);
  }
  if (!cmd.options.bool('yes')) {
    throw new CliError('`tm8 node account disable` is destructive and requires --yes', EXIT_USAGE, {
      hint: 'non-interactive execution never prompts, and --format json is not consent',
    });
  }
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

async function nodeModeSet(cmd: CommandContext): Promise<ExitCode> {
  const usage = 'usage: tm8 node mode set <personal|peer|server>';
  if (cmd.args.length !== 1) throw new CliError(usage, EXIT_USAGE);
  const mode = cmd.args[0]!.trim().toLowerCase();
  if (!(MODES as readonly string[]).includes(mode)) throw new CliError(usage, EXIT_USAGE);

  const data = await observedInvoke<NodeModeSetResult>(clientFor(cmd.ctx), 'node.mode.set', {
    body: { mode },
  });
  cmd.out.data(data, (r) => {
    const lines = [`mode: ${r.previous} → ${r.mode}`];
    if (r.restartRequired) lines.push('restart the Server to apply');
    return lines.join('\n');
  });
  return EXIT_OK;
}

export const NODE_COMMANDS: CommandModule[] = [
  { path: ['node', 'mode'], run: nodeMode },
  { path: ['node', 'mode', 'set'], run: nodeModeSet },
  { path: ['node', 'account', 'disable'], run: nodeAccountDisable },
];

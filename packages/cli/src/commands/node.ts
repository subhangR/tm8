/**
 * `tm8 node …` — read-only facts about the Server as a node.
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
import type { AuthClaimStatusResult } from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

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
    lines.push(
      '',
      'read-only: the mode is server config (TM8_NODE_MODE), not something this command can flip.',
      'to convert, edit TM8_NODE_MODE in the Server\'s env and restart it (design D4).',
    );
    return lines.join('\n');
  });
  return EXIT_OK;
}

export const NODE_COMMANDS: CommandModule[] = [{ path: ['node', 'mode'], run: nodeMode }];

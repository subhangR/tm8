/**
 * `tm8 action list` — G09 capability discovery (§4.12), projecting `actions.list`.
 *
 * THIS IS THE PERMISSION AXIS, AND IT MUST NEVER ANSWER A DIFFERENT QUESTION.
 * Three axes are kept apart across this CLI, and conflating them is a recorded
 * defect class in this program:
 *
 *   exposure     `public|composite|internal|reserved`. Static, contract-level.
 *   availability per NODE — is this implemented HERE? An honest 501 is its
 *                signal; `/health` is a cache-invalidation epoch and never a
 *                per-operation claim.
 *   permission   per ACTOR — what this command answers, bound to an actor, a
 *                Space, a target version, and a `capabilityEpoch`.
 *
 * So this module does ONE thing that looks like an omission and is not: it does
 * not teach the availability ledger anything about the operations it lists.
 * `observedInvoke` records that `actions.list` ITSELF was handled — that call
 * really happened — and nothing else. Recording the listed operations as
 * "available" would read an authorization answer as an implementation claim,
 * and the two have different lifetimes: static help stays valid when only
 * `capabilityEpoch` changes. An operation can be implemented-but-forbidden or
 * unimplemented-but-permitted, and neither is expressible if the axes merge.
 *
 * WHAT IS NOT RENDERED, AND WHY IT IS NOT A GAP THIS FILE MAY FILL. The harness
 * design (§7.5) proposes a `DiscoveredAction` carrying `allowed: boolean` and
 * `reasonCode: ROLE|STATE|TRUST|ASSOCIATION|POLICY`. The FROZEN contract has
 * neither: `PaletteAction` and `ActionDiscoveryResult` define no `allowed` and
 * no `reasonCode`. This command renders the DTO the contract defines and
 * synthesises neither field — a CLI-invented `allowed: true` would be this
 * package making an authorization decision the Server owns. The absence is
 * reported upward, not patched here.
 *
 * `reasonCode`'s enum deliberately has NO not-implemented member, which is the
 * mechanism that stops permission being pressed into service as availability.
 * The renderer honours that by never describing a listed action in availability
 * vocabulary.
 */
import { EXIT_OK, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

async function actionList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('action list', cmd.options.value('mutation-id'));

  // `--for <entity-id>` is the operation's `contextEntityId`. Omitted entirely
  // when absent: a global palette and a palette on a target are different
  // questions, and an empty context id is neither.
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'actions.list', {
    query: { contextEntityId: cmd.options.value('for') },
  });

  cmd.out.data(data, renderActions);
  return EXIT_OK;
}

interface ActionRow {
  operation?: unknown;
  label?: unknown;
  kind?: unknown;
  authzTarget?: unknown;
  exposure?: unknown;
  targetVersion?: unknown;
  helpRef?: unknown;
}

interface DiscoveryResult {
  actorId?: unknown;
  targetEntityId?: unknown;
  targetVersion?: unknown;
  capabilityEpoch?: unknown;
  actions?: unknown;
}

/**
 * The human view renders the SAME DTO `--format json` emits.
 *
 * `capabilityEpoch` is on the header line because this answer is epoch-bound
 * and short-lived — a palette printed without the epoch it was computed under
 * looks like a durable fact about the actor, and it is not. The operation name
 * is kept on every row because it is the id a follow-up `tm8 help --operation`
 * takes.
 */
function renderActions(dto: unknown): string {
  const view = (dto ?? {}) as DiscoveryResult;
  const rows: ActionRow[] = Array.isArray(view.actions) ? (view.actions as ActionRow[]) : [];

  const header = [
    view.actorId === undefined ? '' : `actor ${String(view.actorId)}`,
    view.targetEntityId === undefined
      ? ''
      : `target ${String(view.targetEntityId)}${
        view.targetVersion === undefined ? '' : `@v${String(view.targetVersion)}`
      }`,
    view.capabilityEpoch === undefined ? '' : `epoch ${String(view.capabilityEpoch)}`,
  ]
    .filter((part) => part.length > 0)
    .join('  ');

  if (rows.length === 0) {
    // Deliberately NOT "nothing is implemented" or "nothing is available":
    // an empty palette is an answer about this actor on this target.
    return [header, 'no actions for this actor on this target'].filter(Boolean).join('\n');
  }

  const lines = rows.map((row) =>
    [
      String(row.operation ?? ''),
      String(row.kind ?? ''),
      String(row.authzTarget ?? ''),
      String(row.exposure ?? ''),
    ]
      .filter((part) => part.length > 0)
      .join('  '),
  );
  return [header, ...lines].filter(Boolean).join('\n');
}

/** Wired into `src/commands/registry.ts` by the coordinator: one import, one spread. */
export const ACTION_COMMANDS: CommandModule[] = [
  { path: ['action', 'list'], run: actionList },
];

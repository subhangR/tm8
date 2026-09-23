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
import { expandActionRows, isActionRows, type ActionDiscoveryPage } from '@tm8/contract';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { isAgentCaller, resolveWireSchema } from '../wire-schema.js';

/** Mirrors the Server's `actions.list` page bounds (v2 only). */
const PAGE_MAX = 100;

async function actionList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('action list', cmd.options.value('mutation-id'));

  const target = cmd.options.value('for');
  const all = cmd.options.bool('all');
  const limit = cmd.options.integer('limit');
  if (limit !== undefined && (limit < 1 || limit > PAGE_MAX)) {
    throw new CliError(`--limit expects 1..${PAGE_MAX}, got ${limit}`, EXIT_USAGE);
  }
  const cursor = cmd.options.value('cursor');
  // Paging is a v2 capability, so asking to page asks for v2 — unless the
  // caller pinned v1 explicitly, in which case the Server says why it refuses.
  const schema = resolveWireSchema(cmd, {
    flag: 'schema',
    subject: '`tm8 action list`',
    v2Name: 'the factored tm8.actions.v2 page (target and epoch once, one row per action, --limit/--cursor)',
    forceV2: limit !== undefined || cursor !== undefined,
  });

  // `--for <entity-id>` is the operation's `contextEntityId`. Omitted entirely
  // when absent: a global palette and a palette on a target are different
  // questions, and an empty context id is neither.
  //
  // On a target the Server answers with that entity's own operations, most
  // relevant first. `--all` asks for the complete authorized inventory: the
  // same rows followed by the Space-level and global ones (`auth.*`,
  // `spaces.create`, …) that answer identically on every entity.
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'actions.list', {
    query: {
      contextEntityId: target,
      scope: all ? 'all' : undefined,
      schema: schema === 'v2' ? 'v2' : undefined,
      limit: limit === undefined ? undefined : String(limit),
      cursor,
    },
  });

  cmd.out.data(data, (dto) => renderActions(dto, { target, all }), { minify: isAgentCaller() });
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
function renderActions(dto: unknown, request: { target?: string; all: boolean }): string {
  // v2 is rendered through its own expansion, so both shapes print identically.
  const page = isActionRows(dto) ? (dto as ActionDiscoveryPage) : undefined;
  const view = (page ? expandActionRows(page) : dto ?? {}) as DiscoveryResult;
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
  const more = page?.nextCursor
    ? `${rows.length} of ${page.total} shown; next: tm8 action list${
      request.target ? ` --for ${request.target}` : ''}${request.all ? ' --all' : ''} --cursor ${page.nextCursor}`
    : '';
  return [header, ...lines, more].filter(Boolean).join('\n');
}

/** Wired into `src/commands/registry.ts` by the coordinator: one import, one spread. */
export const ACTION_COMMANDS: CommandModule[] = [
  { path: ['action', 'list'], run: actionList },
];

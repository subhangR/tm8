/**
 * `tm8 task …` — the closed kind-command namespace for tasks (§4.5).
 *
 * FOUR commands: `transition`, `complete`, `link-pr`, `link-commit`. There is
 * deliberately no `task create`, `task get` or `task list`: a task is an
 * entity, so it is created, read and queried through the universal entity
 * commands. A parallel task noun would be a second way to say the same thing,
 * drifting from the first.
 *
 * WHY `complete` IS NOT A TRANSITION. `entities.commands.complete` is the only
 * operation that may write `done`: it alone checks acceptance criteria, writes
 * completer relationships, activity and awards, and makes the final transition
 * atomically. `entities.commands.work` covers the rest of the lifecycle.
 *
 * AND WHY `task transition <id> done` IS NOT REFUSED HERE. The Server owns
 * that refusal — `set_work_state` raises on `done`, which reaches the caller as
 * `invariant_violation` with `details.reason = 'use_complete_command'`. This
 * package invents no error codes and no reasons, so refusing locally would
 * mean either fabricating that reason or answering with a weaker one, and it
 * would make the frozen row's own note false for CLI callers. `done` is
 * forwarded and the Server's answer is rendered. A status that is not a
 * WorkStatus at all IS refused locally: that is a typo, not an intent.
 *
 * THIS MODULE CLOSES A LIVE COHERENCE GAP. `src/run.ts` retires the `report`
 * vocabulary and points callers at `tm8 task transition <task-id> working`.
 * Until this module is registered, that pointer names a command that answers
 * exit 8 — the CLI telling an agent to run something it does not have.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import {
  assertKnownOptions,
  renderCommandResult,
  requireArg,
  withActor,
} from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * The six statuses `task transition` documents, in the frozen contract
 * spelling — `in_review`, not `in-review` and not `inReview`.
 */
const TRANSITIONABLE = ['open', 'pulled', 'working', 'in_review', 'blocked', 'cancelled'] as const;

/** The full `WorkStatus` set. `done` is a status; it is just not this command's. */
const WORK_STATUSES = [...TRANSITIONABLE, 'done'] as const;

async function taskTransition(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const id = requireArg(cmd, 0, '<task-id>');
  const status = requireArg(cmd, 1, `<status> (${TRANSITIONABLE.join('|')})`);
  if (!(WORK_STATUSES as readonly string[]).includes(status)) {
    throw new CliError(`${JSON.stringify(status)} is not a work status`, EXIT_USAGE, {
      hint: `one of: ${TRANSITIONABLE.join('|')} — completion goes through \`tm8 task complete\``,
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.commands.work', {
    params: { id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      status,
    }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

/**
 * `--by <actor-id>...` names the COMPLETERS and is repeatable; `--as` names
 * the actor making the call. They are different questions — an admin may
 * complete a task on behalf of the two people who did the work — so they are
 * different fields and neither defaults to the other.
 */
async function taskComplete(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'by', 'mutation-id']);
  const id = requireArg(cmd, 0, '<task-id>');
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError('`tm8 task complete` requires --expect-version <n>', EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <task-id>`',
    });
  }
  const completerIds = cmd.options.values('by');
  if (completerIds.length === 0) {
    throw new CliError('`tm8 task complete` requires at least one --by <actor-id>', EXIT_USAGE, {
      hint: 'completion records who completed the task; --by is repeatable',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.commands.complete', {
    params: { id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion,
      completerIds,
    }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

/** `link-pr` and `link-commit` differ only in the operation they bind. */
function linker(
  operation: 'entities.commands.linkPr' | 'entities.commands.linkCommit',
): (cmd: CommandContext) => Promise<ExitCode> {
  return async (cmd) => {
    assertKnownOptions(cmd, ['project', 'mutation-id']);
    const id = requireArg(cmd, 0, '<task-id>');
    const url = requireArg(cmd, 1, '<url>');
    const body: Record<string, unknown> = {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      url,
    };
    const projectId = cmd.options.value('project');
    if (projectId !== undefined) body.projectId = projectId;

    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), operation, {
      params: { id },
      body: withActor(cmd, body),
    });
    cmd.out.data(data, renderCommandResult);
    return EXIT_OK;
  };
}

export const TASK_COMMANDS: CommandModule[] = [
  { path: ['task', 'transition'], run: taskTransition },
  { path: ['task', 'complete'], run: taskComplete },
  { path: ['task', 'link-pr'], run: linker('entities.commands.linkPr') },
  { path: ['task', 'link-commit'], run: linker('entities.commands.linkCommit') },
];

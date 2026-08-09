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
import {
  CliError,
  EXIT_FORBIDDEN,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_RETRYABLE,
  EXIT_USAGE,
  type ExitCode,
} from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { requireSpace } from '../context.js';
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

/** The closed gate vocabulary — 082's `tasks.completion_gate` check constraint. */
const GATES = ['none', 'pr_merged'] as const;

/**
 * `tm8 task gate <task-id> <none|pr_merged>` — the opt-in completion gate.
 * `pr_merged` makes `task complete` refuse while any `tracks`-linked pull
 * request is unmerged or CI-red; `none` (the default every task starts with)
 * restores the plain completion path. The refusal itself lives in
 * `complete_task`; this command only stores the flag.
 */
async function taskGate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']);
  const id = requireArg(cmd, 0, '<task-id>');
  const gate = requireArg(cmd, 1, `<gate> (${GATES.join('|')})`);
  if (!(GATES as readonly string[]).includes(gate)) {
    throw new CliError(`${JSON.stringify(gate)} is not a completion gate`, EXIT_USAGE, {
      hint: `one of: ${GATES.join('|')}`,
    });
  }
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError('`tm8 task gate` requires --expect-version <n>', EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <task-id>`',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.commands.gate', {
    params: { id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion,
      gate,
    }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

/**
 * `tm8 task import-issue <issue-url>` — one-way import of a GitHub issue as a
 * task (§Tier 3.5).
 *
 * ONE-WAY, AND SUGAR OVER `entities.create`. The issue is read once from the
 * GitHub API and a task entity is created; nothing is ever written back to
 * GitHub, and no new catalog operation exists for this — the durable write is
 * an ordinary create, so the command is an alias the same way `worktree list`
 * is sugar over `collections.query`.
 *
 * THE ORIGIN LINK IS STORED IN THE DESCRIPTION FOOTER. The task content shape
 * is closed (`{description, acceptanceCriteria, pointsEstimate}`, schemas.ts
 * strict), so a structured `origin` field would be refused by the contract.
 * The footer line carries the canonical URL and the `owner/repo#number`
 * spelling, both parseable, without opening the content schema for one
 * command's convenience.
 *
 * A PULL REQUEST URL IS REFUSED, TWICE. Once by the URL shape (`/issues/`
 * only), and again by the response body: GitHub's issues API answers for PRs
 * too (every PR is an issue), so a `pull_request` key in the payload means the
 * caller pasted a PR number under an /issues/ path — and PRs have a real home,
 * `tm8 task link-pr`, which tracks state rather than copying it once.
 */
const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/([0-9]+)$/;

/** Same env names, same precedence, as the server-side observer (S15: env only). */
function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.TM8_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined
  );
}

interface FetchedIssue {
  title: string;
  body: string | null;
  state: string;
  isPullRequest: boolean;
}

/**
 * `TM8_GITHUB_API_BASE` exists for tests to point at a local mock; the value
 * never comes from stored data, so it cannot be steered by another Space
 * member the way a stored repo string could.
 */
async function fetchGithubIssue(repo: string, issueNumber: string): Promise<FetchedIssue> {
  const base = process.env.TM8_GITHUB_API_BASE?.trim() || 'https://api.github.com';
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub refuses requests with no User-Agent, as a 403 that reads like a
    // permissions problem.
    'user-agent': 'tm8-cli-issue-import',
  };
  const token = githubToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${base}/repos/${repo}/issues/${issueNumber}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CliError(
      `could not reach the GitHub API: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_RETRYABLE,
    );
  }

  if (response.status === 404) {
    throw new CliError(`issue ${repo}#${issueNumber} was not found`, EXIT_NOT_FOUND, {
      hint: 'private repositories need a token in TM8_GITHUB_TOKEN, GITHUB_TOKEN or GH_TOKEN',
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError(`GitHub refused the read (http ${String(response.status)})`, EXIT_FORBIDDEN, {
      hint: 'check the token in TM8_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, or the rate limit',
    });
  }
  if (!response.ok) {
    throw new CliError(`GitHub answered http ${String(response.status)}`, EXIT_RETRYABLE);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new CliError(
      `unreadable GitHub response: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_RETRYABLE,
    );
  }
  const issue = (raw ?? {}) as Record<string, unknown>;
  return {
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : null,
    state: typeof issue.state === 'string' ? issue.state : 'open',
    isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
  };
}

async function taskImportIssue(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['parent', 'mutation-id']);
  const url = requireArg(cmd, 0, '<issue-url>');
  const match = ISSUE_URL_RE.exec(url);
  if (!match) {
    throw new CliError(`${JSON.stringify(url)} is not a GitHub issue URL`, EXIT_USAGE, {
      hint: 'expected https://github.com/<owner>/<repo>/issues/<number> — pull requests go through `tm8 task link-pr`',
    });
  }
  const [, repo, issueNumber] = match as unknown as [string, string, string];

  const issue = await fetchGithubIssue(repo, issueNumber);
  if (issue.isPullRequest) {
    throw new CliError(`${repo}#${issueNumber} is a pull request, not an issue`, EXIT_USAGE, {
      hint: `link it instead: tm8 task link-pr <task-id> ${url.replace('/issues/', '/pull/')}`,
    });
  }

  // The footer is the origin store. `state` rides along so a closed issue
  // imported on purpose is visibly a closed issue, not a fresh idea.
  const description = `${issue.body ?? ''}\n\n---\nImported from ${url} (github ${repo}#${issueNumber}, ${issue.state} at import)`.trimStart();

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    spaceId: requireSpace(cmd.ctx),
    kind: 'task',
    // An issue with no title still needs an entity title; the origin spelling
    // is the honest fallback because it is what the importer actually knows.
    title: issue.title.trim() || `${repo}#${issueNumber}`,
    content: { description, acceptanceCriteria: [] },
  };
  const parentId = cmd.options.value('parent');
  if (parentId !== undefined) body.parentId = parentId;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.create', {
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

export const TASK_COMMANDS: CommandModule[] = [
  { path: ['task', 'transition'], run: taskTransition },
  { path: ['task', 'complete'], run: taskComplete },
  { path: ['task', 'gate'], run: taskGate },
  { path: ['task', 'link-pr'], run: linker('entities.commands.linkPr') },
  { path: ['task', 'link-commit'], run: linker('entities.commands.linkCommit') },
  { path: ['task', 'import-issue'], run: taskImportIssue },
];

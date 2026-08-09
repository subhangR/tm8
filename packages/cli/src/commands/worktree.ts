/**
 * `tm8 worktree list|status` — the read surface for isolated checkouts
 * (worktree design §7.2).
 *
 * SUGAR OVER THE EXISTING CATALOG, ADDING ZERO OPERATIONS. `list` is
 * `collections.query` with `kinds: ['worktree']`; `status` is
 * `entities.context`. The design is explicit that the catalog does not grow for
 * this, and a `worktree.list` operation would have been a second way to ask a
 * question the collection query already answers — which is how catalogs stop
 * being closed.
 *
 * WHY THERE IS NO `tm8 worktree add <path>`, AND NEVER WILL BE. Every checkout
 * path is server-computed from a uuid; the intent a client may express is
 * `--workdir worktree [--base-ref <ref>]` on `session spawn`, and nothing else.
 * A flag here that accepted a path would be arguing with the one security
 * property (S11) the whole feature is built around.
 *
 * WHY THE DESTRUCTIVE VERBS ARE NOT HERE YET. `worktree merged|abandon|delete`
 * are sugar over `entities.patch`, and the design attaches conditions to them
 * that this surface cannot yet honour: the delete path needs a fresh preflight
 * token minted from a live Git read (§5.4), and `--force` must be a separate
 * deliberate affordance that no generic confirmation implies (§5.3). Shipping
 * the read half without them is not a gap being hidden — `tm8 entity update`
 * reaches the same door today, with the server's refusals intact. Offering a
 * friendlier spelling that quietly loses the `force` distinction would be worse
 * than offering none.
 */
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

/** The four semantic states `public.worktrees.status` allows. */
const STATUSES = ['active', 'merged', 'abandoned', 'deleted'] as const;

/**
 * `collections.query` projects a worktree as `state`, and `entities.context`
 * hydrates it as `content` — camelCase in one, the detail row's snake_case in
 * the other. Both shapes are read rather than one being assumed, because a
 * renderer that guessed would print "unknown" for every field and look like a
 * data problem.
 */
interface WorktreeFacts {
  status?: unknown;
  branch?: unknown;
  baseRef?: unknown;
  base_ref?: unknown;
  baseCommitOid?: unknown;
  base_commit_oid?: unknown;
  path?: unknown;
}

function factsOf(row: Record<string, unknown>): WorktreeFacts {
  return { ...((row.state ?? {}) as WorktreeFacts), ...((row.content ?? {}) as WorktreeFacts) };
}

function baseLine(f: WorktreeFacts): string {
  const ref = String(f.baseRef ?? f.base_ref ?? '?');
  const oid = String(f.baseCommitOid ?? f.base_commit_oid ?? '');
  // The resolved COMMIT beside the ref, for §7.3's reason: refs move, and the
  // ref alone is not what the session actually got.
  return oid ? `${ref} @ ${oid.slice(0, 12)}` : ref;
}

/**
 * Branch, status, base commit.
 *
 * The PATH is deliberately absent: the collection projection does not carry it,
 * and printing "(unknown)" on every row would read as a bug rather than as a
 * shape. `tm8 worktree status <id>` goes through `entities.context`, which
 * hydrates the detail row, and that is where the path lives.
 */
function renderWorktrees(dto: unknown): string {
  const page = (dto as { page?: { items?: unknown } } | undefined)?.page;
  const items = Array.isArray(page?.items) ? (page.items as Array<Record<string, unknown>>) : [];
  if (items.length === 0) return 'no worktrees';

  const lines = items.map((row) => {
    const f = factsOf(row);
    return `${String(row.id ?? '')}  ${String(f.status ?? 'unknown')}  ${String(f.branch ?? row.title ?? '')}  base ${baseLine(f)}`;
  });
  lines.push('', 'paths and health: tm8 worktree status <worktree-id>');
  return lines.join('\n');
}

async function worktreeList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('worktree list', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['status', 'limit', 'cursor']);

  const status = cmd.options.value('status');
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw new CliError(`--status must be one of ${STATUSES.join('|')}`, EXIT_USAGE);
  }

  const body: Record<string, unknown> = {
    spaceId: requireSpace(cmd.ctx),
    kinds: ['worktree'],
  };
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) body.limit = limit;
  const cursor = cmd.options.value('cursor');
  if (cursor !== undefined) body.cursor = cursor;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.query', { body });

  // `CollectionQuery.filters` is `.strict()` and names no worktree status, so
  // the narrowing happens HERE rather than by inventing a filter key the
  // Server would refuse. Said plainly because it has a cost: `--status` is
  // applied after paging, so a page can come back emptier than `--limit`.
  if (status !== undefined) {
    const result = data as { page?: { items?: Array<Record<string, unknown>> } };
    const items = result.page?.items ?? [];
    const filtered = items.filter((row) => factsOf(row).status === status);
    cmd.out.data({ ...result, page: { ...result.page, items: filtered } }, renderWorktrees);
    return EXIT_OK;
  }

  cmd.out.data(data, renderWorktrees);
  return EXIT_OK;
}

async function worktreeStatus(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('worktree status', cmd.options.value('mutation-id'));
  const worktreeId = cmd.args[0];
  if (worktreeId === undefined) {
    throw new CliError('tm8 worktree status requires <worktree-id>', EXIT_USAGE, {
      hint: 'list them with `tm8 worktree list`',
    });
  }
  assertKnownOptions(cmd, []);

  // `entities.get`, not `entities.context`: context returns an EXCERPT, and the
  // one field this command exists to answer — where on disk the checkout is —
  // lives in the hydrated detail row that only the full read carries.
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.get', {
    params: { id: worktreeId },
  });
  cmd.out.data(data, (dto) => {
    const row = (dto ?? {}) as Record<string, unknown>;
    const f = factsOf(row);
    return [
      `status: ${String(f.status ?? 'unknown')}`,
      `branch: ${String(f.branch ?? row.title ?? '(none)')}`,
      `base:   ${baseLine(f)}`,
      `path:   ${String(f.path ?? '(unknown)')}`,
    ].join('\n');
  });
  return EXIT_OK;
}

export const WORKTREE_COMMANDS: CommandModule[] = [
  { path: ['worktree', 'list'], run: worktreeList },
  { path: ['worktree', 'status'], run: worktreeStatus },
];

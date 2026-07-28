/**
 * `tm8 saved-view list|create|update|delete` — G09 saved views (§4.11),
 * projecting `savedViews.list`, `.create`, `.update`, `.delete`.
 *
 * `saved-view update` CARRIES NO VERSION GUARD, AND THAT IS NOW THE SETTLED
 * ANSWER RATHER THAN A GAP. An earlier grammar made `--expect-version <n>`
 * required and described the operation as "redefine under a version guard", but
 * `SavedViewInput` is `.strict()` with no `expectedVersion`, `SavedView`
 * publishes no version to guard against, and `update_saved_view(...)` takes no
 * such parameter. The guard was fictional at every layer; the projection has
 * been corrected and the operation is a plain replacement.
 *
 * `--expect-version` is still refused BY NAME rather than ignored. An agent that
 * learned the earlier grammar would otherwise pass a guard, have it silently
 * dropped, and believe it held — which is the failure mode that made the
 * fictional flag dangerous in the first place.
 *
 * `CollectionQuery.spaceId` IS REQUIRED BY THE CONTRACT but the CLI's Space
 * arrives through the four-step context chain, so `--query` and `--space` can
 * each answer "which Space". They are reconciled rather than ranked: agreeing
 * is fine, one supplying the other is fine, and DISAGREEING is a usage error —
 * silently preferring either one would write a view into a Space the caller did
 * not choose.
 */
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

const SHARE_MODES = ['private', 'space'] as const;
type ShareMode = (typeof SHARE_MODES)[number];

function requireShareMode(raw: string | undefined): ShareMode {
  if (raw === undefined) {
    throw new CliError(`--share is required (${SHARE_MODES.join('|')})`, EXIT_USAGE);
  }
  const found = SHARE_MODES.find((m) => m === raw);
  if (!found) {
    throw new CliError(
      `--share expects ${SHARE_MODES.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

function requireArg(cmd: CommandContext, command: string, placeholder: string): string {
  const value = cmd.args[0];
  if (value === undefined || value.length === 0) {
    throw new CliError(`tm8 ${command} requires ${placeholder}`, EXIT_USAGE);
  }
  return value;
}

async function readObject(raw: string, flag: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonSource(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${flag} expects a JSON object`, EXIT_USAGE);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the one Space a saved view is written into, from the two places that
 * can name it. See the file header for why disagreement is refused rather than
 * ranked.
 */
async function readQuery(cmd: CommandContext): Promise<Record<string, unknown>> {
  const source = cmd.options.value('query');
  if (source === undefined) {
    throw new CliError('--query <json-source> is required', EXIT_USAGE, {
      hint: 'a saved view IS a query; pass it inline, as @file, or as `-` for stdin',
    });
  }
  const query = await readObject(source, '--query');

  const declared = query.spaceId;
  const contextSpace = cmd.ctx.space?.value;
  if (typeof declared === 'string' && contextSpace !== undefined && declared !== contextSpace) {
    throw new CliError(
      `--query names spaceId ${declared} but the Space in context is ${contextSpace} ` +
        `(from ${cmd.ctx.space?.source})`,
      EXIT_USAGE,
      { hint: 'drop spaceId from --query, or point --space at the same Space' },
    );
  }
  if (typeof declared === 'string') return query;
  return { ...query, spaceId: requireSpace(cmd.ctx) };
}

/**
 * `savedViews.list` IS UNPAGINATED, AND `--limit`/`--cursor` ARE REFUSED.
 *
 * The frozen contract gives this operation no `limit` and no `cursor`: it
 * answers a bare `SavedView[]`, not a `Page<SavedView>`, and there is no
 * `nextCursor` for a caller to follow. Measured against a real Server, three
 * stored views with `--limit 1` returned all THREE — the parameters are not
 * rejected, they are silently ignored.
 *
 * Passing them through would therefore be the same disease as the fictional
 * version guard that `saved-view update` refuses: a flag with no wire
 * destination is a promise the CLI cannot keep. An agent that sees `--limit`
 * reasonably concludes the operation pages, and would page forever without ever
 * receiving an error. Refusing by name costs one round trip nobody wanted and
 * tells the truth immediately.
 *
 * The projection still advertises both flags. That disagreement is REPORTED,
 * not silently reconciled here — `discovery/operations.ts` has one owner and it
 * is not this slot.
 */
async function savedViewList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('saved-view list', cmd.options.value('mutation-id'));

  for (const flag of ['limit', 'cursor'] as const) {
    if (cmd.options.has(flag)) {
      throw new CliError(
        `--${flag} does not exist on \`saved-view list\`: the frozen contract gives ` +
          '`savedViews.list` no pagination — it answers a complete array, with no cursor to follow',
        EXIT_USAGE,
        {
          hint:
            'the full set is already returned; filter downstream rather than paging. ' +
            'This flag is advertised in the command projection and that is a defect being reported.',
        },
      );
    }
  }

  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'savedViews.list', {
    params: { spaceId },
  });
  cmd.out.data(data, renderSavedViews);
  return EXIT_OK;
}

async function savedViewCreate(cmd: CommandContext): Promise<ExitCode> {
  const name = requireArg(cmd, 'saved-view create', '<name>');
  const shareMode = requireShareMode(cmd.options.value('share'));
  const query = await readQuery(cmd);

  const body: Record<string, unknown> = {
    name,
    shareMode,
    query,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const layout = cmd.options.value('graph-layout');
  if (layout !== undefined) body.graphLayout = await readObject(layout, '--graph-layout');
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'savedViews.create', { body });
  cmd.out.data(data, renderSavedView);
  return EXIT_OK;
}

/**
 * `savedViews.update` REPLACES the name, sharing and query of a saved view.
 * All three are required because the operation is a replacement, not a patch:
 * `SavedViewInput` demands them and omitting one would blank it.
 *
 * There is NO version guard, at any layer — `SavedViewInput` is `.strict()`
 * with no `expectedVersion`, and the `SavedView` read DTO publishes no version
 * a caller could guard against even if it had one. `--expect-version` was a
 * fictional flag and is refused by name, because an agent that learned the
 * earlier grammar would otherwise have its guard silently ignored and believe
 * it held.
 */
async function savedViewUpdate(cmd: CommandContext): Promise<ExitCode> {
  const viewId = requireArg(cmd, 'saved-view update', '<saved-view-id>');

  if (cmd.options.has('expect-version')) {
    throw new CliError(
      '--expect-version does not exist on `saved-view update`: this operation carries no version ' +
        'guard, and `SavedView` publishes no version to guard against',
      EXIT_USAGE,
      {
        hint:
          'this update REPLACES name, sharing and query unconditionally — re-read with ' +
          '`tm8 saved-view list` first if you need to see the current state',
      },
    );
  }

  const name = cmd.options.value('name');
  if (name === undefined) {
    throw new CliError('tm8 saved-view update requires --name <name>', EXIT_USAGE, {
      hint: 'this operation REPLACES the view; pass its name even when unchanged',
    });
  }
  const shareMode = requireShareMode(cmd.options.value('share'));
  const query = await readQuery(cmd);

  const body: Record<string, unknown> = {
    name,
    shareMode,
    query,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  /**
   * `--graph-layout` closes an EXPRESSIVENESS gap and does NOT close the data
   * loss. `SavedViewInput.graphLayout` is optional and the syn now names it, so
   * the CLI can finally send a layout on update — but the Server performs a
   * wholesale replacement, so ANY caller that omits the field still nulls a
   * stored layout. That half is a server-side merge fix and is not ours.
   * Claiming this flag repairs the data loss would be the exact overclaim the
   * program is sweeping for.
   */
  const layout = cmd.options.value('graph-layout');
  if (layout !== undefined) body.graphLayout = await readObject(layout, '--graph-layout');
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'savedViews.update', {
    params: { viewId },
    body,
  });
  cmd.out.data(data, renderSavedView);
  return EXIT_OK;
}

async function savedViewDelete(cmd: CommandContext): Promise<ExitCode> {
  const viewId = requireArg(cmd, 'saved-view delete', '<saved-view-id>');
  if (!cmd.options.bool('yes')) {
    throw new CliError(
      'tm8 saved-view delete is destructive and requires --yes (§7.5)',
      EXIT_USAGE,
    );
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'savedViews.delete', {
    params: { viewId },
    body,
  });
  cmd.out.data(data, renderSavedView);
  return EXIT_OK;
}

interface SavedViewRow {
  id?: unknown;
  name?: unknown;
  shareMode?: unknown;
  createdBy?: { name?: unknown } | null;
}

/** Always keeps the view id: `update` and `delete` both take it as an argument. */
function savedViewLine(row: SavedViewRow): string {
  return [
    String(row.id ?? ''),
    String(row.name ?? ''),
    String(row.shareMode ?? ''),
    String(row.createdBy?.name ?? ''),
  ]
    .filter((part) => part.length > 0)
    .join('  ');
}

function renderSavedViews(dto: unknown): string {
  const rows: SavedViewRow[] = Array.isArray(dto)
    ? (dto as SavedViewRow[])
    : Array.isArray((dto as { items?: unknown })?.items)
      ? ((dto as { items: SavedViewRow[] }).items)
      : [];
  if (rows.length === 0) return 'no saved views';
  const lines = rows.map(savedViewLine);
  const cursor = (dto as { nextCursor?: unknown })?.nextCursor;
  if (typeof cursor === 'string' && cursor.length > 0) lines.push(`next: --cursor ${cursor}`);
  return lines.join('\n');
}

function renderSavedView(dto: unknown): string {
  return savedViewLine((dto ?? {}) as SavedViewRow);
}

/** Wired into `src/commands/registry.ts` by the coordinator: one import, one spread. */
export const SAVED_VIEW_COMMANDS: CommandModule[] = [
  { path: ['saved-view', 'list'], run: savedViewList },
  { path: ['saved-view', 'create'], run: savedViewCreate },
  { path: ['saved-view', 'update'], run: savedViewUpdate },
  { path: ['saved-view', 'delete'], run: savedViewDelete },
];

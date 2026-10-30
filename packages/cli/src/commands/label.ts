/**
 * `tm8 label list|create|update|archive` (migration 408; BRIDGE-ENTITY-DESIGN §3.8).
 *
 * A label is a space-level name and colour that any entity can carry; `bug`
 * is seeded in every space. Labels are archived, never deleted. To put one on
 * an entity: `tm8 task create … --label bug`, or `tm8 entity update <id>
 * --add-label bug --expect-version <n>`. Both take a name or an id; names
 * resolve through `labels.list` (case-insensitive, unarchived labels only).
 */
import type { LabelView } from '@tm8/contract';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg, withActor } from './entity.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LabelPage { items: LabelView[]; nextCursor: string | null }

async function listLabels(cmd: CommandContext, includeArchived: boolean): Promise<LabelView[]> {
  const page = await observedInvoke<LabelPage>(clientFor(cmd.ctx), 'labels.list', {
    params: { spaceId: requireSpace(cmd.ctx) },
    query: includeArchived ? { includeArchived: 'true' } : {},
  });
  return page.items;
}

/**
 * Label names or ids → ids. Ids pass through untouched (the Server checks
 * them); names match a label of this space case-insensitively — unarchived
 * ones only, unless `includeArchived` (removing a label, filtering by one).
 * A live label wins over an archived one of the same name (names are unique
 * per space anyway, archived included).
 */
export async function resolveLabelIds(
  cmd: CommandContext, refs: readonly string[], options: { includeArchived?: boolean } = {},
): Promise<string[]> {
  if (refs.every((ref) => UUID_RE.test(ref))) return [...refs];
  const labels = await listLabels(cmd, options.includeArchived === true);
  return refs.map((ref) => {
    if (UUID_RE.test(ref)) return ref;
    const hit = labels.find((label) => label.name.toLowerCase() === ref.trim().toLowerCase());
    if (!hit) {
      throw new CliError(`no label named \`${ref}\` in this space`, EXIT_USAGE, {
        hint: `list them with \`tm8 label list${options.includeArchived ? ' --archived' : ''}\`; create one with \`tm8 label create ${ref}\``,
      });
    }
    return hit.id;
  });
}

function renderLabel(label: LabelView): string {
  const archived = label.archivedAt ? '  (archived)' : '';
  const description = label.description ? `  ${label.description}` : '';
  return `${label.id}  v${label.version}  ${label.colour}  ${label.name}${archived}${description}`;
}

async function labelList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['archived']);
  const items = await listLabels(cmd, cmd.options.has('archived'));
  cmd.out.data({ items, nextCursor: null }, () =>
    items.length === 0 ? 'no labels' : items.map(renderLabel).join('\n'));
  return EXIT_OK;
}

async function labelCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['colour', 'color', 'description', 'mutation-id']);
  const name = requireArg(cmd, 0, '<name>');
  const colour = cmd.options.value('colour') ?? cmd.options.value('color');
  const description = cmd.options.value('description');
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    name,
    ...(colour !== undefined ? { colour } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  const label = await observedInvoke<LabelView>(clientFor(cmd.ctx), 'labels.create', {
    params: { spaceId: requireSpace(cmd.ctx) },
    body: withActor(cmd, body),
  });
  cmd.out.data(label, renderLabel);
  return EXIT_OK;
}

/** The label a ref names, and the version the caller read (`tm8 label list` prints v<n>). */
async function target(cmd: CommandContext): Promise<{ labelId: string; expectedVersion: number }> {
  const ref = requireArg(cmd, 0, '<name|label-id>');
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError(`\`tm8 label ${cmd.path[1]}\` requires --expect-version <n>`, EXIT_USAGE, {
      hint: 'read it with `tm8 label list` (v<n> on each row)',
    });
  }
  const [labelId] = await resolveLabelIds(cmd, [ref]);
  return { labelId: labelId!, expectedVersion };
}

async function labelUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['name', 'colour', 'color', 'description', 'restore', 'expect-version', 'mutation-id']);
  const name = cmd.options.value('name');
  const colour = cmd.options.value('colour') ?? cmd.options.value('color');
  const description = cmd.options.value('description');
  const restore = cmd.options.has('restore');
  if (name === undefined && colour === undefined && description === undefined && !restore) {
    throw new CliError('`tm8 label update` needs something to change', EXIT_USAGE, {
      hint: 'pass --name, --colour, --description or --restore',
    });
  }
  const { labelId, expectedVersion } = await target(cmd);
  const label = await observedInvoke<LabelView>(clientFor(cmd.ctx), 'labels.update', {
    params: { labelId },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion,
      ...(name !== undefined ? { name } : {}),
      ...(colour !== undefined ? { colour } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(restore ? { archived: false } : {}),
    }),
  });
  cmd.out.data(label, renderLabel);
  return EXIT_OK;
}

async function labelArchive(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']);
  const { labelId, expectedVersion } = await target(cmd);
  const label = await observedInvoke<LabelView>(clientFor(cmd.ctx), 'labels.archive', {
    params: { labelId },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      expectedVersion,
    }),
  });
  cmd.out.data(label, renderLabel);
  return EXIT_OK;
}

export const LABEL_COMMANDS: CommandModule[] = [
  { path: ['label', 'list'], run: labelList },
  { path: ['label', 'create'], run: labelCreate },
  { path: ['label', 'update'], run: labelUpdate },
  { path: ['label', 'archive'], run: labelArchive },
];
